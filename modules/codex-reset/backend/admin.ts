// Administrative reads and corrections. Manual post decisions use the same atomic review planner.
import type { BeforeJson } from "@aihot/contracts/admin";
import type { AdminMonitorEvents, AdminMonitorPosts } from "../contracts.ts";
import { z } from "zod";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import { awaitingReviewCondition } from "./read.ts";
import { estimateFor, manualSchedule, type Schedule } from "./time.ts";
import { bumpPublication, moveReviewedLink } from "./manual-review.ts";
export {
  monitorPostDetail,
  previewMonitorReview,
  submitMonitorReview,
} from "./manual-review.ts";

function invalid(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
const PAGE_SIZE = 10;
function paging(total: number, requested?: number) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const page = Math.min(
    Math.max(1, Number.isFinite(requested) ? Math.trunc(requested!) : 1),
    Math.max(1, totalPages),
  );
  return { page, pageSize: PAGE_SIZE, total, totalPages };
}

function receiptReviewCondition(db: Db) {
  return db`NOT e.withdrawn AND e.status <> 'confirmed' AND NOT EXISTS
    (SELECT 1 FROM monitor_event_posts l WHERE l.event_id=e.id AND l.action='confirm')`;
}

export async function eventRows(db: Db, ids?: string[]) {
  return db`SELECT e.*,
    (${receiptReviewCondition(db)}) AS "canReceiptReview",
    coalesce((SELECT jsonb_agg(jsonb_build_object('postId',l.post_id,'stage',l.stage,'action',l.action,
      'text',l.text,'originalText',l.original_text,'publishedAt',p.published_at,'url',p.url) ORDER BY p.published_at,p.id)
      FROM monitor_event_posts l JOIN monitor_posts p ON p.id=l.post_id WHERE l.event_id=e.id),'[]'::jsonb) AS posts
    FROM monitor_events e WHERE ${ids ? db`e.id IN ${db(ids)}` : db`true`} ORDER BY e.created_at DESC,e.id DESC`;
}

export async function listMonitorEvents(
  opts: {
    withdrawn?: boolean;
    filter?: "all" | "receipt_review";
    page?: number;
    q?: string;
    options?: boolean;
  } = {},
): Promise<BeforeJson<AdminMonitorEvents>> {
  const filter = z.enum(["all", "receipt_review"]).parse(opts.filter ?? "all");
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const where = tx`${opts.withdrawn ? tx`true` : tx`NOT e.withdrawn`} AND (${filter === "receipt_review" ? receiptReviewCondition(tx) : tx`true`}) AND ${opts.q ? tx`(e.id ILIKE ${`%${opts.q}%`} OR e.scope ILIKE ${`%${opts.q}%`} OR e.display_label ILIKE ${`%${opts.q}%`} OR e.presentation->>'audienceZh' ILIKE ${`%${opts.q}%`} OR e.presentation->>'scopeLabel' ILIKE ${`%${opts.q}%`} OR e.schedule->>'label' ILIKE ${`%${opts.q}%`})` : tx`true`}`;
    const [count] =
      await tx`SELECT count(*)::int AS n FROM monitor_events e WHERE ${where}`;
    const meta = paging(count!.n as number, opts.page);
    const ids =
      await tx`SELECT e.id FROM monitor_events e WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(meta.page - 1) * PAGE_SIZE}`;
    const events = ids.length
      ? await eventRows(
          tx,
          ids.map((e) => e.id as string),
        )
      : [];
    return { ...meta, events } as BeforeJson<AdminMonitorEvents>;
  }) as Promise<BeforeJson<AdminMonitorEvents>>;
}

export async function postRows(db: Db, id?: string) {
  return db`SELECT p.id,p.published_at,p.text,p.url,p.translation,p.processed_at,p.receipt_id,p.origin,
    p.recognition->'propositions' AS propositions,(p.recognition->>'needsReview')::boolean AS needs_review,
    p.recognition->'held' AS held,
    (p.recognition->>'skipped')::boolean AS skipped,
    p.raw->'collectionFailure' AS collection_failure,
    (p.recognition->>'relevant')::boolean AS relevant,p.outage,p.recognition->'manualReview' AS manual_review,
    coalesce((SELECT jsonb_agg(jsonb_build_object('eventId',l.event_id,'stage',l.stage) ORDER BY l.event_id)
      FROM monitor_event_posts l WHERE l.post_id=p.id),'[]'::jsonb) AS links
    FROM monitor_posts p WHERE ${id ? db`p.id=${id}` : db`true`} ORDER BY p.published_at DESC,p.id DESC`;
}

export async function listMonitorPosts(opts: {
  filter?: "relevant" | "unrelated" | "review" | "pending" | "all";
  page?: number;
}): Promise<BeforeJson<AdminMonitorPosts>> {
  const filter = z
    .enum(["relevant", "unrelated", "review", "pending", "all"])
    .parse(opts.filter ?? "relevant");
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const where =
      filter === "pending"
        ? tx`p.processed_at IS NULL`
        : filter === "review"
          ? awaitingReviewCondition()
          : filter === "relevant"
            ? tx`(p.recognition->>'relevant')::boolean IS TRUE`
            : filter === "unrelated"
              ? tx`p.processed_at IS NOT NULL AND (p.recognition->>'relevant')::boolean IS FALSE`
              : tx`true`;
    const [count] =
      await tx`SELECT count(*)::int AS n FROM monitor_posts p WHERE ${where}`;
    const meta = paging(count!.n as number, opts.page);
    const ids =
      await tx`SELECT p.id FROM monitor_posts p WHERE ${where} ORDER BY p.published_at DESC,p.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(meta.page - 1) * PAGE_SIZE}`;
    const rows = await Promise.all(
      ids.map(async (p) => (await postRows(tx, p.id as string))[0]!),
    );
    return { ...meta, filter, rows } as BeforeJson<AdminMonitorPosts>;
  }) as Promise<BeforeJson<AdminMonitorPosts>>;
}

const Patch = z
  .object({
    type: z.enum(["direct_reset", "reset_credit"]),
    status: z.enum(["announced", "confirmed"]),
    confirmedAt: z.string().datetime({ offset: true }).nullable(),
    occurredOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    confirmationBasis: z.enum(["source_post", "receipt_review"]).nullable(),
    schedule: z
      .object({
        precision: z.enum([
          "exact",
          "approximate",
          "deadline",
          "date",
          "window",
        ]),
        from: z.string().datetime({ offset: true }),
        through: z.string().datetime({ offset: true }),
      })
      .nullable(),
    scope: z.string().max(200),
    scopeLabel: z.string().max(200).nullable(),
    audienceZh: z.string().max(300).nullable(),
    productsZh: z.string().max(200).nullable(),
  })
  .partial()
  .strict();
async function lockEvent(tx: Tx, id: string, version: string) {
  const [e] = await tx`SELECT * FROM monitor_events WHERE id=${id} FOR UPDATE`;
  if (!e) return null;
  if (new Date(e.updated_at as Date).toISOString() !== version)
    throw new Conflict("这个事件已被修改，请刷新后再改");
  return e;
}
function validDay(day: string | null | undefined) {
  if (
    day &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day)
  )
    throw invalid("occurredOn must be a real YYYY-MM-DD date");
}
export async function updateMonitorEvent(
  id: string,
  input: { patch: unknown; reason: string; version: string },
  actor: string,
) {
  if (typeof input.reason !== "string" || !input.reason.trim())
    throw invalid("reason is required");
  const supplied = Patch.parse(input.patch);
  validDay(supplied.occurredOn);
  return sql.begin(async (tx) => {
    const before = await lockEvent(tx, id, input.version);
    if (!before) return null;
    if (
      (supplied.status === "confirmed" && before.status !== "confirmed") ||
      (supplied.confirmationBasis !== undefined &&
        supplied.confirmationBasis !== before.confirmation_basis) ||
      (supplied.confirmedAt !== undefined &&
        supplied.confirmedAt !==
          (before.confirmed_at
            ? new Date(before.confirmed_at as Date).toISOString()
            : null))
    )
      throw invalid("确认状态和依据请通过帖子复核或回执核对填写");
    const patch: Record<string, any> = {};
    const map: Record<string, string> = {
      type: "type",
      status: "status",
      scope: "scope",
      occurredOn: "occurred_on",
      schedule: "schedule",
    };
    for (const [k, v] of Object.entries(supplied)) {
      const old = map[k]
        ? before[map[k]!]
        : (before.presentation as Record<string, unknown> | null)?.[k];
      const normalized =
        old instanceof Date
          ? old.toISOString().slice(0, k === "occurredOn" ? 10 : undefined)
          : old;
      if (JSON.stringify(v) !== JSON.stringify(normalized)) patch[k] = v;
    }
    if (!Object.keys(patch).length) return before;
    if (patch.status === "announced" && before.status === "confirmed") {
      const [confirmation] =
        await tx`SELECT 1 FROM monitor_event_posts WHERE event_id=${id} AND action='confirm' LIMIT 1`;
      if (confirmation) throw invalid("存在官方确认，请在帖子复核中修正依据");
      Object.assign(patch, {
        confirmedAt: null,
        occurredOn: null,
        confirmationBasis: null,
      });
    }
    const schedule =
      patch.schedule === undefined
        ? before.schedule
        : patch.schedule
          ? manualSchedule(
              patch.schedule.precision,
              new Date(patch.schedule.from),
              new Date(patch.schedule.through),
            )
          : null;
    if (schedule && Date.parse(schedule.through) < Date.parse(schedule.from))
      throw invalid("时间范围结束早于开始");
    const presentation = {
      ...((before.presentation as Record<string, any>) ?? {}),
    };
    if (patch.status === "announced") delete presentation.receiptReview;
    for (const k of ["scopeLabel", "audienceZh", "productsZh"])
      if (k in patch) presentation[k] = patch[k];
    if ("scopeLabel" in patch) presentation.scopeKnown = !!patch.scopeLabel;
    if ("type" in patch) presentation.kindExplicit = true;
    if ("status" in patch) presentation.inProgress = false;
    presentation.manualPatch = { ...presentation.manualPatch, ...patch };
    const status = patch.status ?? before.status;
    const estimate =
      status === "confirmed"
        ? null
        : estimateFor({
            schedule: schedule as Schedule | null,
            announcedAt: before.created_at as Date,
          });
    const type = patch.type ?? before.type;
    const [after] =
      await tx`UPDATE monitor_events SET type=${type},status=${status},
      label=${type === "reset_credit" ? "发重置卡" : "全员重置"},display_label=${presentation.kindExplicit ? (type === "reset_credit" ? "重置卡发放" : "额度重置") : "重置（形式未明确）"},
      scope=${patch.scope ?? before.scope},schedule=${schedule ? tx.json(schedule) : null},estimate=${estimate ? tx.json(estimate as never) : null},presentation=${tx.json(presentation)},
      confirmed_at=${"confirmedAt" in patch ? patch.confirmedAt : before.confirmed_at},occurred_on=${"occurredOn" in patch ? patch.occurredOn : before.occurred_on},
      confirmation_basis=${"confirmationBasis" in patch ? patch.confirmationBasis : before.confirmation_basis},updated_at=now() WHERE id=${id} RETURNING *`;
    await audit(
      actor,
      "monitor.update",
      `monitor-event:${id}`,
      input.reason,
      before,
      after,
      { db: tx },
    );
    await bumpPublication(tx);
    return after;
  });
}
export async function reviewReceipt(
  id: string,
  input: { occurredOn?: string | null; reason: string; version: string },
  actor: string,
) {
  if (typeof input.reason !== "string" || !input.reason.trim())
    throw invalid("reason is required");
  validDay(input.occurredOn);
  return sql.begin(async (tx) => {
    const before = await lockEvent(tx, id, input.version);
    if (!before) return null;
    const [linked] =
      await tx`SELECT 1 FROM monitor_event_posts WHERE event_id=${id} AND action='confirm' LIMIT 1`;
    if (before.withdrawn || before.status === "confirmed" || linked)
      throw new Conflict("事件已有确认或已撤回，无需回执核对");
    const receiptReview = {
      by: actor,
      at: new Date().toISOString(),
      reason: input.reason,
      occurredOn: input.occurredOn ?? null,
    };
    const [after] =
      await tx`UPDATE monitor_events SET status='confirmed',confirmation_basis='receipt_review',confirmed_at=NULL,
      occurred_on=${input.occurredOn ?? null},estimate=NULL,presentation=coalesce(presentation,'{}'::jsonb)||${tx.json({ inProgress: false, receiptReview })},updated_at=now() WHERE id=${id} RETURNING *`;
    await audit(
      actor,
      "monitor.receipt_review",
      `monitor-event:${id}`,
      input.reason,
      before,
      after,
      { db: tx },
    );
    await bumpPublication(tx);
    return after;
  });
}
export async function setWithdrawn(
  id: string,
  input: { withdrawn: boolean; reason: string; version: string },
  actor: string,
) {
  if (typeof input.reason !== "string" || !input.reason.trim())
    throw invalid("reason is required");
  if (typeof input.withdrawn !== "boolean")
    throw invalid("withdrawn must be boolean");
  return sql.begin(async (tx) => {
    const before = await lockEvent(tx, id, input.version);
    if (!before) return null;
    const [after] =
      await tx`UPDATE monitor_events SET withdrawn=${input.withdrawn},presentation=coalesce(presentation,'{}'::jsonb)||${tx.json({ manualWithdrawn: input.withdrawn })},updated_at=now() WHERE id=${id} RETURNING *`;
    await audit(
      actor,
      input.withdrawn ? "monitor.withdraw" : "monitor.restore",
      `monitor-event:${id}`,
      input.reason,
      before,
      after,
      { db: tx },
    );
    await bumpPublication(tx);
    return after;
  });
}
export const relinkPost = moveReviewedLink;
