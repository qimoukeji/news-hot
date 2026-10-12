import { monitor as currentMonitor, monitorId, purpose as requestPurpose, auditAction, auditSubject } from "./context.ts";
// Review is a read-only plan followed by one version-checked transaction. No model or provider calls.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { audit, Conflict } from "@aihot/backend/audit";
import type {
  AdminMonitorReviewDraft as Draft,
  AdminMonitorReviewProposition as Claim,
} from "../contracts.ts";
import { eventRows, postRows } from "./admin.ts";
import { quotedInPost } from "./assemble.ts";
import { eventDisplayLabel, eventLabel } from "../event-kind.ts";
import { BonusCreditInput } from "./bonus-input.ts";
import {
  estimateFor,
  manualSchedule,
  resolveStatedTime,
  scheduleFrom,
  type Schedule,
} from "./time.ts";

const ScheduleInput = z
  .object({
    precision: z.enum(["exact", "approximate", "deadline", "date", "window"]),
    from: z.string().datetime({ offset: true }),
    through: z.string().datetime({ offset: true }),
  })
  .strict();
const ClaimInput = z
  .object({
    kind: z.enum(["direct_reset", "reset_credit", "bonus_credit"]),
    kindExplicit: z.boolean(),
    action: z.enum(["announce", "progress", "confirm", "amend", "withdraw"]),
    count: z.number().int().min(1).max(5),
    excerpt: z.string().trim().min(1).max(20000),
    excerptZh: z.string().max(20000),
    targetEventId: z.string().min(1).nullable(),
    overrideEventFields: z.boolean().optional().default(false),
    scope: z
      .object({
        audienceSource: z.string().max(1000).nullable(),
        plans: z.array(z.string().min(1).max(100)).max(20).nullable(),
        audienceZh: z.string().max(1000).nullable(),
        productsZh: z.string().max(1000).nullable(),
      })
      .strict(),
    schedule: ScheduleInput.nullable(),
    occurredOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    bonusCredit: BonusCreditInput.nullable().optional(),
  })
  .strict();
const DraftInput = z
  .object({
    decision: z.enum(["unrelated", "related", "events"]),
    translationZh: z.string().max(50000).nullable(),
    contextZh: z
      .array(
        z.object({ id: z.string(), textZh: z.string().max(50000) }).strict(),
      )
      .max(50),
    outage: z.enum(["outage", "recovery"]).nullable(),
    propositions: z.array(ClaimInput).max(100),
  })
  .strict();
function invalid(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
type Row = Record<string, any>;
type State = {
  post: Row;
  events: Row[];
  links: Row[];
  sources: Row[];
  version: string;
};
type Planned = {
  draft: Draft;
  propositions: Row[];
  changes: Array<{ eventId: string; before: Row | null; after: Row }>;
  links: Row[];
  removedLinks: string[];
  addedLinks: string[];
  outageChanges: Array<{ postId: string; before: unknown; after: unknown }>;
  previewToken: string;
};
function stable(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const iso = (v: any) => (v instanceof Date ? v.toISOString() : String(v));
export async function bumpPublication(tx: Tx) {
  await tx`INSERT INTO monitor_state (monitor_id, key,value) VALUES (${monitorId()}, 'publication_revision',${tx.json({ revision: randomUUID() })}) ON CONFLICT (monitor_id, key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
}

async function load(db: Db, id: string): Promise<State | null> {
  const [post] = await db`SELECT * FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE id=${id}`;
  if (!post) return null;
  const events = await eventRows(db);
  const receiptAudits =
    await db`SELECT subject,action,after,created_at,actor,reason FROM audit_log
    WHERE subject LIKE ${auditSubject("event", "%")} AND action IN (${auditAction("receipt_review")},${auditAction("update")}) ORDER BY created_at,id`;
  const receipts = new Map<string, Row | null>();
  for (const entry of receiptAudits) {
    const eventId = String(entry.subject).slice(auditSubject("event", "").length);
    if (entry.after?.status === "announced") receipts.set(eventId, null);
    else if (
      entry.after?.confirmation_basis === "receipt_review" ||
      entry.after?.confirmationBasis === "receipt_review"
    )
      receipts.set(eventId, {
        by: entry.actor,
        at: iso(entry.created_at),
        reason: entry.reason,
        occurredOn: entry.after.occurred_on ?? entry.after.occurredOn ?? null,
      });
  }
  for (const event of events)
    if (!event.presentation?.receiptReview && receipts.get(event.id))
      event.presentation = {
        ...event.presentation,
        receiptReview: receipts.get(event.id),
      };
  const links =
    await db`SELECT * FROM (SELECT * FROM monitor_event_posts WHERE monitor_id = ${monitorId()}) AS monitor_event_posts ORDER BY event_id,post_id`;
  const sources =
    await db`SELECT id,published_at,text,url,recognition,outage,activity,raw,context FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE id IN (SELECT post_id FROM (SELECT * FROM monitor_event_posts WHERE monitor_id = ${monitorId()}) AS monitor_event_posts) OR outage IS NOT NULL OR recognition->>'outage' IS NOT NULL ORDER BY id`;
  return {
    post,
    events,
    links,
    sources,
    version: hash({ post, events, links, sources }),
  };
}
function contextOf(post: Row) {
  const raw = post.raw?.context ?? [];
  const stored = post.context ?? [];
  const ids = [
    ...new Set([
      ...stored.map((c: Row) => String(c.id)),
      ...raw.map((c: Row) => String(c.id)),
    ]),
  ];
  return ids.map((id) => {
    const c = stored.find((c: Row) => String(c.id) === id) ?? {},
      r = raw.find((c: Row) => String(c.id) === id) ?? {};
    return {
      id,
      author: String(r.author ?? c.author ?? ""),
      relation: (r.relation ?? c.relation ?? "reply") as "reply" | "quote",
      textZh: c.text ?? null,
      originalText: String(r.text ?? c.originalText ?? ""),
      publishedAt: r.publishedAt ?? c.publishedAt ?? null,
      url: c.url ?? `https://x.com/i/status/${id}`,
    };
  });
}
function defaultDraft(state: State): Draft {
  const { post } = state;
  const rec = post.recognition ?? {};
  const propositions: Claim[] = (rec.propositions ?? [])
    .filter((p: Row) => p.real !== false && p.duplicateOf == null)
    .flatMap((p: Row) => {
      const links = state.links.filter(
        (l) => l.post_id === post.id && matchingClaim(post, l) === p,
      );
      return (links.length ? links : [null]).map((link) => {
        const target = p.targetEventId ?? link?.event_id ?? p.relatesTo ?? null;
        const event = state.events.find((e) => e.id === target);
        let schedule = p.schedule ?? event?.schedule ?? null;
        if (!schedule && p.statedTime) {
          const source = contextOf(post).find((c) => c.id === p.timeSourceId);
          const sourceAt =
            p.timeSourceId && p.timeSourceId !== post.id
              ? source?.publishedAt
              : post.published_at;
          const t = sourceAt
            ? resolveStatedTime(p.statedTime, new Date(sourceAt), source?.originalText ?? post.text, !!p.timeInferred)
            : null;
          if (t) schedule = scheduleFrom(t);
        }
        return {
          kind: p.kind,
          kindExplicit: !!p.kindExplicit,
          action: p.action,
          count: target ? 1 : (p.count ?? 1),
          excerpt: p.excerpt ?? "",
          excerptZh: p.excerptZh ?? "",
          targetEventId: target,
          overrideEventFields: false,
          scope: p.scope ?? {
            audienceSource: null,
            plans: null,
            audienceZh: null,
            productsZh: null,
          },
          schedule: schedule
            ? {
                precision: schedule.precision,
                from: iso(schedule.from),
                through: iso(schedule.through),
              }
            : null,
          occurredOn:
            p.kind === "bonus_credit" ? null : p.occurredOn ??
            (event?.occurred_on ? iso(event.occurred_on).slice(0, 10) : null),
          ...(p.kind === "bonus_credit" ? { bonusCredit: event?.presentation?.manualPatch && "bonusCredit" in event.presentation.manualPatch ? event.presentation.manualPatch.bonusCredit : p.bonusCredit ?? event?.presentation?.bonusCredit ?? null } : {}),
        };
      });
    });
  return {
    decision: propositions.length
      ? "events"
      : rec.relevant !== false
        ? "related"
        : "unrelated",
    translationZh: post.translation ?? rec.translationZh ?? null,
    contextZh: contextOf(post)
      .filter((c) => c.textZh !== null)
      .map((c) => ({ id: c.id, textZh: c.textZh! })),
    outage: rec.outage ?? null,
    propositions,
  };
}
function originalRecognition(post: Row) {
  const recognition = post.recognition;
  return recognition && Object.hasOwn(recognition, "originalRecognition")
    ? recognition.originalRecognition
    : (recognition ?? null);
}
export async function monitorPostDetail(id: string) {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const state = await load(tx, id);
    if (!state) return null;
    const history =
      await tx`SELECT created_at AS at,actor,reason,before,after FROM audit_log WHERE subject=${auditSubject("post", id)} ORDER BY created_at DESC,id DESC LIMIT 100`;
    return {
      post: (await postRows(tx, id))[0],
      context: contextOf(state.post),
      originalRecognition: originalRecognition(state.post),
      history,
      version: state.version,
      draft: defaultDraft(state),
    };
  });
}
function validate(state: State, input: unknown): Draft {
  const draft = DraftInput.parse(input);
  if (draft.decision === "events" && !draft.propositions.length)
    throw invalid("事件判断至少填写一条动作");
  if (draft.decision !== "events" && draft.propositions.length)
    throw invalid("相关或无关判断不能包含事件动作");
  if (draft.propositions.reduce((total, p) => total + p.count, 0) > 100)
    throw invalid("一次复核最多处理100轮事件");
  if (draft.decision === "unrelated" && draft.outage)
    throw invalid("故障或恢复属于相关内容");
  const context = contextOf(state.post);
  const used = new Set<string>();
  for (const c of draft.contextZh) {
    if (used.has(c.id) || !context.some((x) => x.id === c.id))
      throw invalid("上下文ID不存在或重复");
    used.add(c.id);
  }
  const targets = new Set<string>();
  for (const p of draft.propositions) {
    if (!currentMonitor().eventKinds.includes(p.kind)) throw invalid("当前监控不支持这个事件类型");
    if (p.kind === "bonus_credit" && (p.count !== 1 || p.occurredOn)) throw invalid("奖励活动不能填写重置次数或到账日期");
    if (p.kind !== "bonus_credit" && p.bonusCredit != null) throw invalid("只有奖励额度事件可以填写奖励详情");
    if (p.overrideEventFields && !p.targetEventId)
      throw invalid("替换已有人工字段必须选择目标事件");
    if (!quotedInPost(p.excerpt, state.post.text))
      throw invalid("事件依据必须来自本条原帖");
    if (
      p.schedule &&
      (Date.parse(p.schedule.through) < Date.parse(p.schedule.from) ||
        (["exact", "approximate", "deadline"].includes(p.schedule.precision) &&
          Date.parse(p.schedule.from) !== Date.parse(p.schedule.through)))
    )
      throw invalid("时间范围或单点时间无效");
    if (
      p.occurredOn &&
      (!Number.isFinite(Date.parse(p.occurredOn)) ||
        new Date(p.occurredOn).toISOString().slice(0, 10) !== p.occurredOn)
    )
      throw invalid("实际发生日期无效");
    if (p.targetEventId) {
      const e = state.events.find((e) => e.id === p.targetEventId);
      const retained = state.links.some(
        (l) => l.post_id === state.post.id && l.event_id === p.targetEventId,
      );
      if (!e || (e.withdrawn && !retained))
        throw invalid("关联事件不存在或已撤回，不能新增关联");
      if (!currentMonitor().eventKinds.includes(e.type)) throw invalid("当前监控不支持目标事件类型");
      if (p.kind === "bonus_credit" && e.confirmation_basis === "receipt_review") throw invalid("奖励活动不能使用个人账户回执作为确认依据");
      if (p.count !== 1) throw invalid("关联已有事件时次数必须为1");
      if (
        e.type !== p.kind &&
        e.presentation?.kindExplicit &&
        p.action !== "amend" &&
        !p.overrideEventFields &&
        !e.presentation?.manualPatch?.type
      )
        throw invalid("不能混合明确不同类型的事件");
      if (targets.has(e.id))
        throw invalid("同一帖子对同一事件只能提交一条合并后的动作");
      targets.add(e.id);
    } else if (p.action === "amend" || p.action === "withdraw")
      throw invalid("补充或撤回必须选择已有事件");
  }
  return draft;
}
const stage = (p: Claim) =>
  p.kind === "bonus_credit" && p.action === "announce" ? "奖励预告" :
  p.kind === "bonus_credit" && p.action === "confirm" ? "活动可领取" :
  p.action === "announce"
    ? p.kind === "reset_credit"
      ? "发卡预告"
      : "预告"
    : p.action === "progress"
      ? "进展"
      : p.action === "confirm"
        ? p.kind === "reset_credit"
          ? "确认发卡"
          : "确认完成"
        : p.action === "amend"
          ? "补充说明"
          : "撤回";
function candidateClaims(source: Row, link: Row): Row[] {
  const claims: Row[] = (source.recognition?.propositions ?? []).filter(
    (p: Row) => p.real !== false && p.duplicateOf == null,
  );
  // Explicit event IDs are authoritative even when several claims quote the same sentence.
  const explicit = claims.filter((p) =>
    Array.isArray(p.eventIds)
      ? p.eventIds.includes(link.event_id)
      : (p.targetEventId ?? p.relatesTo) === link.event_id,
  );
  if (explicit.length) return explicit;
  const legacy = claims.filter(
    (p) =>
      !Array.isArray(p.eventIds) &&
      !p.targetEventId &&
      !p.relatesTo &&
      p.excerpt === link.original_text &&
      p.action === link.action,
  );
  if (legacy.length < 2) return legacy;
  const byStage = legacy.filter((p) => stage(p as Claim) === link.stage);
  return byStage.length ? byStage : legacy;
}
function matchingClaim(source: Row, link: Row): Row | null {
  const candidates = candidateClaims(source, link);
  return candidates.length === 1 ? candidates[0]! : null;
}
function claimFor(source: Row, link: Row): Row | null {
  const candidates = candidateClaims(source, link);
  if (candidates.length > 1)
    throw invalid(`帖子 ${source.id} 的历史命题关联不明确，请先人工复核该帖`);
  return candidates[0] ?? null;
}
function recompute(
  before: Row | null,
  eventId: string,
  links: Row[],
  sources: Row[],
  seed: Claim | undefined,
  postAt: any,
): Row {
  const evidence = links
    .map((l) => ({ link: l, source: sources.find((s) => s.id === l.post_id) }))
    .filter((x) => x.source)
    .sort(
      (a, b) =>
        Date.parse(iso(a.source!.published_at)) -
          Date.parse(iso(b.source!.published_at)) ||
        a.link.post_id.localeCompare(b.link.post_id),
    );
  const claims = evidence.map((x) => ({
    ...x,
    claim: claimFor(x.source!, x.link),
  }));
  const base = before
    ? structuredClone(before)
    : {
        id: eventId,
        type: seed!.kind,
        status: "announced",
        title: "",
        scope: "",
        schedule: null,
        estimate: null,
        presentation: {},
        confirmed_at: null,
        occurred_on: null,
        confirmation_basis: null,
        withdrawn: false,
        created_at: postAt,
        updated_at: postAt,
        posts: [],
      };
  const manual = { ...base.presentation?.manualPatch };
  if (seed?.overrideEventFields) {
    const scopeLabel = seed.scope.plans?.length
      ? seed.scope.plans.join(", ")
      : seed.scope.audienceSource;
    if (seed.kindExplicit) manual.type = seed.kind;
    else delete manual.type;
    Object.assign(manual, {
      scope: seed.scope.plans?.length
        ? seed.scope.plans.join("、")
        : scopeLabel && /paid/i.test(scopeLabel)
          ? "所有付费订阅"
          : "",
      scopeLabel: scopeLabel ?? null,
      audienceZh: seed.scope.audienceZh,
      productsZh: seed.scope.productsZh,
      schedule: seed.schedule,
      occurredOn: seed.occurredOn,
      ...(seed.kind === "bonus_credit" ? { bonusCredit: seed.bonusCredit ?? null } : {}),
    });
    if (seed.kind !== "bonus_credit") delete manual.bonusCredit;
  }
  let kind = seed?.kind ?? base.type;
  let explicit = false;
  let scope = "";
  let scopeLabel: null | string = null;
  let audienceZh: null | string = null;
  let productsZh: null | string = null;
  let quotaScope: null | string = null;
  let bonusCredit = base.presentation?.bonusCredit ?? null;
  let schedule: Schedule | null = null;
  let progress = false;
  let timeInferred = false;
  let reportedAt: null | string = null;
  let occurredOn: null | string = null;
  for (const { link, source, claim: p } of claims) {
    if (!p) continue;
    if (p.kindExplicit) {
      kind = p.kind;
      explicit = true;
    }
    const newScope = p.scope?.plans?.length
      ? p.scope.plans.join(", ")
      : p.scope?.audienceSource;
    if (
      newScope &&
      (!(link.action === "confirm" || link.action === "progress") ||
        !scopeLabel)
    ) {
      scopeLabel = newScope;
      scope = p.scope.plans?.length
        ? p.scope.plans.join("、")
        : /paid/i.test(newScope)
          ? "所有付费订阅"
          : "";
      audienceZh = p.scope.audienceZh ?? audienceZh;
    }
    if (p.scope?.productsZh) productsZh = p.scope.productsZh;
    if (p.kind === "bonus_credit" && p.bonusCredit != null) bonusCredit = {
      amount: null, eligibility: null, claimMethod: null, claimDeadline: null, expiresAt: null,
      ...bonusCredit,
      ...Object.fromEntries(Object.entries(p.bonusCredit).filter(([, value]) => value !== null)),
    };
    const quota = p.scope && currentMonitor().quotaScope?.(p.scope, { excerpt: p.excerpt, kind: p.kind });
    if (quota) quotaScope = quota;
    if (p.schedule) {
      timeInferred = false;
      schedule = manualSchedule(
        p.schedule.precision,
        new Date(p.schedule.from),
        new Date(p.schedule.through),
      );
    } else if (p.statedTime) {
      const timeSource = contextOf(source!).find(
        (c) => c.id === p.timeSourceId,
      );
      const sourceAt =
        p.timeSourceId && p.timeSourceId !== source!.id
          ? timeSource?.publishedAt
          : source!.published_at;
      const t = sourceAt
        ? resolveStatedTime(p.statedTime, new Date(sourceAt), timeSource?.originalText ?? source!.text, !!p.timeInferred)
        : null;
      if (t) {
        schedule = scheduleFrom(t);
        timeInferred = currentMonitor().timePolicy === "explicit" ? false : !!p.timeInferred;
      }
    }
    if (link.action === "progress") {
      progress = true;
      reportedAt = iso(source!.published_at);
    }
    if (link.action === "confirm" && p.occurredOn) occurredOn = p.occurredOn;
  }
  if ("type" in manual) kind = manual.type;
  const confirms = claims.filter(
    (x) => x.link.action === "confirm" && x.claim?.action === "confirm" && (x.claim.kind === "bonus_credit") === (kind === "bonus_credit"),
  );
  const receipt = kind !== "bonus_credit" && (
    base.confirmation_basis === "receipt_review" ||
    !!base.presentation?.receiptReview);
  const status = confirms.length || receipt ? "confirmed" : "announced";
  const presentation = {
    ...base.presentation,
    manualPatch: manual,
    scopeKnown: !!scopeLabel,
    scopeLabel,
    kindExplicit: explicit,
    audienceZh,
    productsZh,
    ...(currentMonitor().quotaScope ? { quotaScope } : {}),
    inProgress: status === "announced" && progress,
    timeInferred,
    reportedAt,
  };
  for (const k of ["scopeLabel", "audienceZh", "productsZh"])
    if (k in manual) presentation[k] = manual[k];
  if ("scopeLabel" in manual) presentation.scopeKnown = !!manual.scopeLabel;
  if ("type" in manual) {
    kind = manual.type;
    presentation.kindExplicit = true;
  }
  if (!currentMonitor().eventKinds.includes(kind)) throw invalid("当前监控不支持这个事件类型");
  if (kind === "bonus_credit") {
    presentation.bonusCredit = "bonusCredit" in manual ? manual.bonusCredit : bonusCredit;
    presentation.timeInferred = false;
    delete presentation.receiptReview;
    occurredOn = null;
  } else {
    delete presentation.bonusCredit;
    delete manual.bonusCredit;
  }
  if ("scope" in manual) scope = manual.scope;
  if ("schedule" in manual)
    schedule = manual.schedule
      ? manualSchedule(
          manual.schedule.precision,
          new Date(manual.schedule.from),
          new Date(manual.schedule.through),
        )
      : null;
  const withdrawn =
    !!before?.withdrawn ||
    (!links.length && !receipt) ||
    claims.at(-1)?.link.action === "withdraw";
  const confirmedAt = confirms.length
    ? confirms[0]!.source!.published_at
    : null;
  Object.assign(base, {
    type: kind,
    status,
    label: eventLabel(kind),
    display_label: kind === "bonus_credit" || presentation.kindExplicit
      ? eventDisplayLabel(kind)
      : "重置（形式未明确）",
    scope,
    schedule,
    estimate:
      kind === "bonus_credit" || status === "confirmed"
        ? null
        : estimateFor({ schedule, announcedAt: new Date(base.created_at) }),
    presentation,
    confirmed_at: confirmedAt,
    occurred_on:
      kind !== "bonus_credit" && status === "confirmed"
        ? "occurredOn" in manual
          ? manual.occurredOn
          : (occurredOn ??
            (receipt
              ? (base.presentation?.receiptReview?.occurredOn ??
                base.occurred_on)
              : null))
        : null,
    confirmation_basis: confirms.length
      ? "source_post"
      : receipt
        ? "receipt_review"
        : null,
    withdrawn,
    posts: evidence.map(({ link, source }) => ({
      postId: source!.id,
      stage: link.stage,
      action: link.action,
      text: link.text,
      originalText: link.original_text,
      publishedAt: source!.published_at,
      url: source!.url,
    })),
    canReceiptReview: kind !== "bonus_credit" && !withdrawn && status !== "confirmed" && !confirms.length,
  });
  return base;
}
function plan(state: State, input: unknown): Planned {
  const draft = validate(state, input);
  const old = state.links.filter((l) => l.post_id === state.post.id);
  const links: Row[] = [];
  const propositions: Row[] = [];
  const seeds = new Map<string, Claim>();
  draft.propositions.forEach((p, index) => {
    const eventIds: string[] = [];
    for (let nth = 1; nth <= p.count; nth++) {
      const id =
        p.targetEventId ??
        `manual-${state.post.id}-${index + 1}-${nth}-${hash({ version: state.version, kind: p.kind, excerpt: p.excerpt }).slice(0, 16)}`;
      seeds.set(id, p);
      eventIds.push(id);
      links.push({
        event_id: id,
        post_id: state.post.id,
        action: p.action,
        stage: stage(p),
        text: p.excerptZh || p.excerpt,
        original_text: p.excerpt,
      });
    }
    propositions.push({ ...p, real: true, role: "action", relatesTo: p.targetEventId, eventIds });
  });
  const affected = [
    ...new Set([
      ...old.map((l) => l.event_id),
      ...links.map((l) => l.event_id),
    ]),
  ].sort();
  const sources = state.sources
    .filter((s) => s.id !== state.post.id)
    .concat({
      ...state.post,
      recognition: {
        propositions,
      },
    });
  const changes = affected.map((eventId) => {
    const before = state.events.find((e) => e.id === eventId) ?? null;
    const remaining = state.links
      .filter((l) => l.event_id === eventId && l.post_id !== state.post.id)
      .concat(links.filter((l) => l.event_id === eventId));
    return {
      eventId,
      before,
      after: recompute(
        before,
        eventId,
        remaining,
        sources,
        seeds.get(eventId),
        state.post.published_at,
      ),
    };
  });
  const removedLinks = old
    .filter((l) => !links.some((n) => n.event_id === l.event_id))
    .map((l) => l.event_id);
  const addedLinks = links
    .filter((l) => !old.some((n) => n.event_id === l.event_id))
    .map((l) => l.event_id);
  const outageChanges = planOutages(state, draft, changes, links);
  return {
    draft,
    propositions,
    links,
    changes,
    removedLinks,
    addedLinks,
    outageChanges,
    previewToken: hash({
      version: state.version,
      draft,
      changes,
      removedLinks,
      addedLinks,
      outageChanges,
    }),
  };
}
function result(state: State, planned: Planned) {
  return {
    postId: state.post.id,
    version: state.version,
    previewToken: planned.previewToken,
    decision: planned.draft.decision,
    changes: planned.changes,
    removedLinks: planned.removedLinks,
    addedLinks: planned.addedLinks,
    outageChanges: planned.outageChanges,
  };
}
export async function previewMonitorReview(
  id: string,
  input: { draft: unknown; version: string },
) {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const state = await load(tx, id);
    if (!state) return null;
    if (state.version !== input.version)
      throw new Conflict("帖子或关联事件已变化，请刷新");
    return result(state, plan(state, input.draft));
  });
}
async function writeEvents(
  tx: Tx,
  planned: Planned,
  actor: string,
  reason: string,
) {
  for (const change of planned.changes) {
    const e = change.after;
    await tx`INSERT INTO monitor_events (monitor_id, id,type,status,title,label,display_label,scope,schedule,estimate,presentation,confirmed_at,occurred_on,confirmation_basis,withdrawn,created_at,updated_at)
      VALUES (${monitorId()}, ${e.id},${e.type},${e.status},${e.title ?? ""},${e.label},${e.display_label},${e.scope},${e.schedule ? tx.json(e.schedule) : null},${e.estimate ? tx.json(e.estimate) : null},${tx.json(e.presentation)},${e.confirmed_at},${e.occurred_on},${e.confirmation_basis},${e.withdrawn},${e.created_at},now())
      ON CONFLICT (monitor_id, id) DO UPDATE SET type=EXCLUDED.type,status=EXCLUDED.status,label=EXCLUDED.label,display_label=EXCLUDED.display_label,scope=EXCLUDED.scope,schedule=EXCLUDED.schedule,estimate=EXCLUDED.estimate,presentation=EXCLUDED.presentation,confirmed_at=EXCLUDED.confirmed_at,occurred_on=EXCLUDED.occurred_on,confirmation_basis=EXCLUDED.confirmation_basis,withdrawn=EXCLUDED.withdrawn,updated_at=now()`;
    await audit(
      actor,
      auditAction("review.event"),
      auditSubject("event", e.id),
      reason,
      change.before,
      e,
      { db: tx },
    );
  }
}
function planOutages(
  state: State,
  draft: Draft,
  changes: Planned["changes"],
  links: Row[],
) {
  const posts = state.sources
    .filter((p) => p.id !== state.post.id)
    .concat({
      ...state.post,
      recognition: { ...state.post.recognition, outage: draft.outage },
    })
    .sort(
      (a, b) =>
        Date.parse(iso(a.published_at)) - Date.parse(iso(b.published_at)) ||
        a.id.localeCompare(b.id),
    );
  const events = state.events
    .filter((e) => !changes.some((c) => c.eventId === e.id))
    .concat(changes.map((c) => c.after));
  const allLinks = state.links
    .filter((l) => l.post_id !== state.post.id)
    .concat(links)
    .filter(
      (l) =>
        l.action === "announce" &&
        events.some((e) => e.id === l.event_id && e.type !== "bonus_credit" && !e.withdrawn),
    )
    .sort((a, b) => a.event_id.localeCompare(b.event_id));
  const announced = posts.filter((p) =>
    allLinks.some((l) => l.post_id === p.id),
  );
  const outageChanges: Array<{
    postId: string;
    before: unknown;
    after: unknown;
  }> = [];
  for (const p of posts) {
    let outage: Row | null = null;
    if (p.recognition?.outage === "outage") {
      const end = Date.parse(iso(p.published_at)) + 18 * 3600000;
      const recovered = posts.find(
        (r) =>
          r.recognition?.outage === "recovery" &&
          Date.parse(iso(r.published_at)) >= Date.parse(iso(p.published_at)) &&
          Date.parse(iso(r.published_at)) <= end,
      );
      const next = announced.find(
        (r) =>
          Date.parse(iso(r.published_at)) >= Date.parse(iso(p.published_at)) &&
          Date.parse(iso(r.published_at)) <= end,
      );
      outage = {
        kind: "outage",
        recoveredAt: recovered ? iso(recovered.published_at) : null,
        resetEventId: next
          ? (allLinks.find((l) => l.post_id === next.id)?.event_id ?? null)
          : null,
      };
    }
    if (hash(outage) !== hash(p.outage ?? null))
      outageChanges.push({
        postId: p.id,
        before: p.outage ?? null,
        after: outage,
      });
  }
  return outageChanges;
}
export async function submitMonitorReview(
  id: string,
  input: {
    draft: unknown;
    version: string;
    previewToken: string;
    reason: string;
  },
  actor: string,
) {
  if (typeof input.reason !== "string" || !input.reason.trim())
    throw invalid("reason is required");
  try {
    return await sql.begin("isolation level serializable", async (tx) => {
      const [post] =
        await tx`SELECT id FROM (SELECT * FROM monitor_posts WHERE monitor_id = ${monitorId()}) AS monitor_posts WHERE id=${id} FOR UPDATE`;
      if (!post) return null;
      await tx`SELECT id FROM (SELECT * FROM monitor_events WHERE monitor_id = ${monitorId()}) AS monitor_events ORDER BY id FOR UPDATE`;
      const state = await load(tx, id);
      if (state!.version !== input.version)
        throw new Conflict("帖子或关联事件已变化，请重新预览");
      const planned = plan(state!, input.draft);
      if (planned.previewToken !== input.previewToken)
        throw new Conflict("复核内容与预览不一致，请重新预览");
      await writeEvents(tx, planned, actor, input.reason);
      await tx`DELETE FROM monitor_event_posts WHERE monitor_id = ${monitorId()} AND (post_id=${id}) `;
      for (const l of planned.links)
        await tx`INSERT INTO monitor_event_posts (monitor_id, event_id,post_id,stage,action,text,original_text) VALUES (${monitorId()}, ${l.event_id},${id},${l.stage},${l.action},${l.text},${l.original_text})`;
      const d = planned.draft;
      const context = contextOf(state!.post).map((c) => ({
        id: c.id,
        author: c.author,
        relation: c.relation,
        text: d.contextZh.find((x) => x.id === c.id)?.textZh ?? c.textZh,
        originalText: c.originalText,
        publishedAt: c.publishedAt,
        url: c.url,
      }));
      const rec = {
        ...state!.post.recognition,
        originalRecognition: originalRecognition(state!.post),
        relevant: d.decision !== "unrelated",
        translationZh: d.translationZh,
        contextZh: d.contextZh,
        outage: d.outage,
        propositions: planned.propositions,
        needsReview: false,
        held: [],
        notify: [],
        manualReview: {
          by: actor,
          at: new Date().toISOString(),
          reason: input.reason,
          decision: d.decision,
          completed: true,
        },
      };
      const activity =
        d.decision === "events"
          ? {
              kind: "event_update",
              action: d.propositions[0]?.action ?? null,
              statusChanged: true,
              eventIds: planned.links.map((l) => l.event_id),
            }
          : d.decision === "related"
            ? {
                kind: "related",
                action: null,
                statusChanged: false,
                eventIds: [],
              }
            : null;
      await tx`UPDATE monitor_posts SET recognition=${tx.json(rec)},translation=${d.translationZh},context=${tx.json(context)},activity=${activity ? tx.json(activity) : null},
        raw=(coalesce(raw,'{}'::jsonb)-'collectionFailure')||'{"contextPending":false}'::jsonb,processed_at=now() WHERE monitor_id = ${monitorId()} AND (id=${id}) `;
      await tx`DELETE FROM monitor_state WHERE monitor_id = ${monitorId()} AND (key IN ${tx([`failures:${id}`, `context:${id}`])}) `;
      for (const c of planned.outageChanges)
        await tx`UPDATE monitor_posts SET outage=${c.after ? tx.json(c.after as never) : null} WHERE monitor_id = ${monitorId()} AND (id=${c.postId}) `;
      await audit(
        actor,
        auditAction("post.review"),
        auditSubject("post", id),
        input.reason,
        state!.post,
        {
          recognition: rec,
          changes: planned.changes,
          removedLinks: planned.removedLinks,
          addedLinks: planned.addedLinks,
          outageChanges: planned.outageChanges,
        },
        { db: tx },
      );
      await bumpPublication(tx);
      return result(state!, planned);
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "40001" || error.code === "40P01")
    )
      throw new Conflict("数据同时发生变化，请刷新并重新预览");
    throw error;
  }
}

// Old link moves must pass through the same preview, version and event recalculation as full reviews.
export async function moveReviewedLink(
  input: {
    postId: string;
    fromEventId: string;
    toEventId: string | null;
    reason: string;
    version: string;
    previewToken: string;
  },
  actor: string,
) {
  if (!input.version || !input.previewToken)
    throw new Conflict("移动关联需要先在人工复核中预览");
  const detail = await monitorPostDetail(input.postId);
  if (!detail) return null;
  if (
    !detail.post?.links.some(
      (l: { eventId: string }) => l.eventId === input.fromEventId,
    )
  )
    throw new Conflict("这条帖子不在原事件里");
  const draft = detail.draft;
  draft.propositions = draft.propositions.flatMap((p) =>
    p.targetEventId !== input.fromEventId
      ? [p]
      : input.toEventId
        ? [{ ...p, targetEventId: input.toEventId }]
        : [],
  );
  if (!draft.propositions.length) draft.decision = "related";
  return submitMonitorReview(
    input.postId,
    {
      draft,
      reason: input.reason,
      version: input.version,
      previewToken: input.previewToken,
    },
    actor,
  );
}
