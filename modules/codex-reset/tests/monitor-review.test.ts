import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import {
  monitorPostDetail,
  previewMonitorReview,
  submitMonitorReview,
  listMonitorPosts,
  listMonitorEvents,
  reviewReceipt,
  updateMonitorEvent,
  relinkPost,
  setWithdrawn,
} from "../backend/admin.ts";
import { applyRecognition } from "../backend/assemble.ts";
import type { AdminMonitorReviewDraft } from "../contracts.ts";

after(closeDb);
let serial = 0;
async function post(text = "We reset Codex limits for everyone.") {
  const id = `review-${Date.now()}-${++serial}`;
  await sql`INSERT INTO monitor_posts (id,author,published_at,text,url) VALUES (${id},'thsottiaux',now(),${text},${`https://x.com/i/status/${id}`})`;
  return id;
}
function draft(
  text = "We reset Codex limits for everyone.",
): AdminMonitorReviewDraft {
  return {
    decision: "events",
    translationZh: "已重置",
    contextZh: [],
    outage: null,
    propositions: [
      {
        kind: "direct_reset",
        kindExplicit: true,
        action: "confirm",
        count: 1,
        excerpt: text,
        excerptZh: "已重置",
        targetEventId: null,
        scope: {
          audienceSource: "everyone",
          plans: null,
          audienceZh: "所有人",
          productsZh: "Codex",
        },
        schedule: null,
        occurredOn: null,
      },
    ],
  };
}
async function review(id: string, d: AdminMonitorReviewDraft) {
  const detail = (await monitorPostDetail(id))!;
  const preview = (await previewMonitorReview(id, {
    draft: d,
    version: detail.version,
  }))!;
  const result = await submitMonitorReview(
    id,
    {
      draft: d,
      version: detail.version,
      previewToken: preview.previewToken,
      reason: "人工查看原帖",
    },
    "review-test",
  );
  return { preview, result };
}

test("preview is read-only, manual completion replaces pending and worker cannot overwrite it", async () => {
  const id = await post();
  const detail = (await monitorPostDetail(id))!;
  const d = draft();
  const [receiptsBefore] = await sql`SELECT count(*) AS n FROM receipts`;
  const preview = (await previewMonitorReview(id, {
    draft: d,
    version: detail.version,
  }))!;
  assert.equal(preview.addedLinks.length, 1);
  const [untouched] =
    await sql`SELECT processed_at,recognition FROM monitor_posts WHERE id=${id}`;
  assert.equal(untouched!.processed_at, null);
  assert.equal(untouched!.recognition, null);
  assert.equal(
    (
      await sql`SELECT id FROM monitor_events WHERE id=${preview.addedLinks[0]!}`
    ).length,
    0,
  );
  await submitMonitorReview(
    id,
    {
      draft: d,
      version: detail.version,
      previewToken: preview.previewToken,
      reason: "核验原文",
    },
    "review-test",
  );
  const [saved] =
    await sql`SELECT processed_at,recognition FROM monitor_posts WHERE id=${id}`;
  assert.ok(saved!.processed_at);
  assert.equal(saved!.recognition.manualReview.completed, true);
  const applied = await applyRecognition(id, {
    relevant: false,
    translationZh: null,
    contextZh: [],
    outage: null,
    needsReview: false,
    propositions: [],
    model: "test",
    promptVersion: "test",
    receiptId: 0,
  });
  assert.deepEqual(applied, { eventIds: [], notify: [] });
  const [receiptsAfter] = await sql`SELECT count(*) AS n FROM receipts`;
  assert.equal(receiptsAfter!.n, receiptsBefore!.n);
  const [confirmed] =
    await sql`SELECT status,confirmation_basis,occurred_on FROM monitor_events WHERE id=${preview.addedLinks[0]!}`;
  assert.equal(confirmed!.status, "confirmed");
  assert.equal(confirmed!.confirmation_basis, "source_post");
  assert.equal(confirmed!.occurred_on, null);
});

test("removing sole confirmation downgrades to announcement and preserves remaining source fields", async () => {
  const announce = await post("We will reset Codex for Plus tomorrow.");
  const a = draft("We will reset Codex for Plus tomorrow.");
  Object.assign(a.propositions[0]!, {
    action: "announce",
    scope: {
      audienceSource: "Plus",
      plans: ["Plus"],
      audienceZh: "Plus 用户",
      productsZh: "Codex",
    },
  });
  const { preview: first } = await review(announce, a);
  const eventId = first.addedLinks[0]!;
  const confirm = await post();
  const c = draft();
  c.propositions[0]!.targetEventId = eventId;
  await review(confirm, c);
  await review(confirm, {
    decision: "related",
    translationZh: "相关",
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [event] = await sql`SELECT * FROM monitor_events WHERE id=${eventId}`;
  assert.equal(event!.status, "announced");
  assert.equal(event!.confirmation_basis, null);
  assert.equal(event!.confirmed_at, null);
  assert.equal(event!.withdrawn, false);
  assert.equal(event!.presentation.scopeLabel, "Plus");
  assert.equal(event!.scope, "Plus");
  const detail = (await monitorPostDetail(confirm))!;
  assert.equal(detail.history.length, 2);
  assert.equal(detail.post!.links.length, 0);
});

test("sole source removal withdraws, other confirmations and receipt checks remain effective", async () => {
  const one = await post();
  const { preview } = await review(one, draft());
  const eventId = preview.addedLinks[0]!;
  const two = await post();
  const d = draft();
  d.propositions[0]!.targetEventId = eventId;
  await review(two, d);
  await review(one, {
    decision: "unrelated",
    translationZh: null,
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [still] =
    await sql`SELECT status,withdrawn FROM monitor_events WHERE id=${eventId}`;
  assert.equal(still!.status, "confirmed");
  assert.equal(still!.withdrawn, false);
  await review(two, {
    decision: "unrelated",
    translationZh: null,
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [gone] =
    await sql`SELECT withdrawn FROM monitor_events WHERE id=${eventId}`;
  assert.equal(gone!.withdrawn, true);
  const announced = await post("We will reset tomorrow.");
  const a = draft("We will reset tomorrow.");
  a.propositions[0]!.action = "announce";
  const { preview: announcement } = await review(announced, a);
  const receiptEvent = announcement.addedLinks[0]!;
  const [before] =
    await sql`SELECT updated_at FROM monitor_events WHERE id=${receiptEvent}`;
  await reviewReceipt(
    receiptEvent,
    { reason: "账户已到账", version: before!.updated_at.toISOString() },
    "review-test",
  );
  await review(announced, {
    decision: "unrelated",
    translationZh: null,
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [receipt] =
    await sql`SELECT status,confirmation_basis,withdrawn FROM monitor_events WHERE id=${receiptEvent}`;
  assert.equal(receipt!.status, "confirmed");
  assert.equal(receipt!.confirmation_basis, "receipt_review");
  assert.equal(receipt!.withdrawn, false);
});

test("changed preview, stale versions, fabricated excerpts, invalid dates leave no partial changes", async () => {
  const id = await post();
  const detail = (await monitorPostDetail(id))!;
  const d = draft();
  const preview = (await previewMonitorReview(id, {
    draft: d,
    version: detail.version,
  }))!;
  await assert.rejects(
    () =>
      submitMonitorReview(
        id,
        {
          draft: { ...d, translationZh: "不同" },
          version: detail.version,
          previewToken: preview.previewToken,
          reason: "修改",
        },
        "test",
      ),
    /重新预览/,
  );
  const invalid = draft("invented statement");
  await assert.rejects(
    () => previewMonitorReview(id, { draft: invalid, version: detail.version }),
    /原帖/,
  );
  const date = draft();
  date.propositions[0]!.occurredOn = "2026-02-30";
  await assert.rejects(
    () => previewMonitorReview(id, { draft: date, version: detail.version }),
    /日期/,
  );
  await sql`UPDATE monitor_posts SET text=text||' updated' WHERE id=${id}`;
  await assert.rejects(
    () =>
      submitMonitorReview(
        id,
        {
          draft: d,
          version: detail.version,
          previewToken: preview.previewToken,
          reason: "核验",
        },
        "test",
      ),
    /重新预览/,
  );
  assert.equal(
    (await sql`SELECT event_id FROM monitor_event_posts WHERE post_id=${id}`)
      .length,
    0,
  );
  const [saved] =
    await sql`SELECT processed_at FROM monitor_posts WHERE id=${id}`;
  assert.equal(saved!.processed_at, null);
});

test("generic edits keep explicit/progress flags when unchanged and cannot invent confirmations", async () => {
  const id = await post("Reset coming soon.");
  const d = draft("Reset coming soon.");
  Object.assign(d.propositions[0]!, {
    action: "progress",
    kindExplicit: false,
  });
  const { preview } = await review(id, d);
  const eventId = preview.addedLinks[0]!;
  let [e] = await sql`SELECT * FROM monitor_events WHERE id=${eventId}`;
  await updateMonitorEvent(
    eventId,
    {
      patch: { type: e!.type, status: e!.status, audienceZh: "修改文案" },
      reason: "只改文案",
      version: e!.updated_at.toISOString(),
    },
    "test",
  );
  [e] = await sql`SELECT * FROM monitor_events WHERE id=${eventId}`;
  assert.equal(e!.presentation.kindExplicit, false);
  assert.equal(e!.presentation.inProgress, true);
  await assert.rejects(
    () =>
      updateMonitorEvent(
        eventId,
        {
          patch: { status: "confirmed" },
          reason: "无依据",
          version: e!.updated_at.toISOString(),
        },
        "test",
      ),
    /确认/,
  );
  const c = await post();
  const cd = draft();
  cd.propositions[0]!.targetEventId = eventId;
  await review(c, cd);
  const [confirmed] =
    await sql`SELECT * FROM monitor_events WHERE id=${eventId}`;
  await assert.rejects(
    () =>
      reviewReceipt(
        eventId,
        { reason: "重复", version: confirmed!.updated_at.toISOString() },
        "test",
      ),
    /无需回执核对/,
  );
});

test("review detail preserves multiple existing rounds and the original model response", async () => {
  const id = await post("We reset Codex twice.");
  const model = {
    relevant: true,
    translationZh: "重置两次",
    needsReview: false,
    propositions: [
      {
        ...draft("We reset Codex twice.").propositions[0]!,
        count: 2,
        real: true,
      },
    ],
    model: "original-model",
  };
  await sql`UPDATE monitor_posts SET recognition=${sql.json(model)} WHERE id=${id}`;
  const d = draft("We reset Codex twice.");
  d.propositions[0]!.count = 2;
  const { preview } = await review(id, d);
  assert.equal(preview.addedLinks.length, 2);
  const detail = (await monitorPostDetail(id))!;
  assert.equal(detail.draft.propositions.length, 2);
  assert.ok(
    detail.draft.propositions.every((p) => p.count === 1 && p.targetEventId),
  );
  assert.deepEqual(detail.originalRecognition, model);
  const second = (await previewMonitorReview(id, {
    draft: detail.draft,
    version: detail.version,
  }))!;
  assert.equal(second.removedLinks.length, 0);
  assert.equal(second.addedLinks.length, 0);
  await submitMonitorReview(
    id,
    {
      draft: detail.draft,
      version: detail.version,
      previewToken: second.previewToken,
      reason: "保留两轮",
    },
    "review-test",
  );
  assert.deepEqual((await monitorPostDetail(id))!.originalRecognition, model);
  const pending = await post("No model response.");
  await review(pending, {
    decision: "related",
    translationZh: "相关",
    contextZh: [],
    outage: null,
    propositions: [],
  });
  await review(pending, {
    decision: "unrelated",
    translationZh: null,
    contextZh: [],
    outage: null,
    propositions: [],
  });
  assert.equal((await monitorPostDetail(pending))!.originalRecognition, null);
});

test("same-excerpt manual actions keep distinct facts and stable associations when reopened", async () => {
  const text = "We reset Plus limits and will send reset credits to Business tomorrow.";
  const id = await post(text);
  const d = draft(text);
  const credit = structuredClone(d.propositions[0]!);
  Object.assign(d.propositions[0]!.scope, {
    plans: ["Plus"], audienceSource: "Plus", audienceZh: "Plus 用户",
  });
  Object.assign(credit, { kind: "reset_credit", action: "announce", count: 2 });
  Object.assign(credit.scope, {
    plans: ["Business"], audienceSource: "Business", audienceZh: "Business 用户",
  });
  d.propositions.push(credit);
  const first = await review(id, d);
  const direct = first.preview.changes.find(c => c.after.type === "direct_reset")!;
  const credits = first.preview.changes.filter(c => c.after.type === "reset_credit");
  assert.equal(direct.after.status, "confirmed");
  assert.equal(direct.after.scope, "Plus");
  assert.equal(credits.length, 2);
  assert.ok(credits.every(c => c.after.status === "announced" && c.after.scope === "Business"));
  const [stored] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
  assert.deepEqual(stored!.recognition.propositions[0].eventIds, [direct.eventId]);
  assert.deepEqual(new Set(stored!.recognition.propositions[1].eventIds), new Set(credits.map(c => c.eventId)));
  const detail = (await monitorPostDetail(id))!;
  assert.equal(detail.draft.propositions.length, 3);
  assert.equal(new Set(detail.draft.propositions.map(p => p.targetEventId)).size, 3);
  const second = await review(id, detail.draft);
  assert.deepEqual(second.preview.removedLinks, []);
  assert.deepEqual(second.preview.addedLinks, []);
  const reopened = (await monitorPostDetail(id))!;
  assert.equal(reopened.draft.propositions.length, 3);
  assert.equal(reopened.history.length, 2);
  const saved = await sql`SELECT type,status,scope FROM monitor_events WHERE id IN ${sql(first.preview.addedLinks)} ORDER BY type,scope`;
  assert.deepEqual(saved.map(e => [e.type,e.status,e.scope]), [
    ["direct_reset","confirmed","Plus"],
    ["reset_credit","announced","Business"],
    ["reset_credit","announced","Business"],
  ]);
});

test("legacy ambiguous same-excerpt claims require an explicit association before recalculation", async () => {
  const text = "We will reset Plus and Business.";
  const id = await post(text);
  const d = draft(text);
  d.propositions[0]!.action = "announce";
  Object.assign(d.propositions[0]!.scope, { plans: ["Plus"], audienceSource: "Plus" });
  const business = structuredClone(d.propositions[0]!);
  Object.assign(business.scope, { plans: ["Business"], audienceSource: "Business" });
  d.propositions.push(business);
  const first = await review(id, d);
  const plusId = first.preview.changes.find(c => c.after.scope === "Plus")!.eventId;
  const businessId = first.preview.changes.find(c => c.after.scope === "Business")!.eventId;
  await sql`UPDATE monitor_posts SET recognition=jsonb_set(recognition,'{propositions}',${sql.json(d.propositions.map(p => ({...p,real:true,relatesTo:null})))}) WHERE id=${id}`;
  const confirm = await post();
  const c = draft();
  c.propositions[0]!.targetEventId = plusId;
  const untouched = (await monitorPostDetail(confirm))!;
  await assert.rejects(
    () => previewMonitorReview(confirm, { draft: c, version: untouched.version }),
    /历史命题关联不明确/,
  );
  const legacy = (await monitorPostDetail(id))!;
  assert.equal(legacy.draft.propositions.length, 2);
  assert.ok(legacy.draft.propositions.every(p => p.targetEventId === null));
  legacy.draft.propositions[0]!.targetEventId = plusId;
  legacy.draft.propositions[1]!.targetEventId = businessId;
  await review(id, legacy.draft);
  await review(confirm, c);
  const [plus] = await sql`SELECT status,scope FROM monitor_events WHERE id=${plusId}`;
  const [other] = await sql`SELECT status,scope FROM monitor_events WHERE id=${businessId}`;
  assert.deepEqual([plus!.status,plus!.scope,other!.status,other!.scope], ["confirmed","Plus","announced","Business"]);
});

test("more than twenty explicit rounds reopen within the existing hundred-round limit", async () => {
  const text = "We will reset the five plans five times each.";
  const id = await post(text);
  const d = draft(text);
  d.propositions = Array.from({length: 5}, (_, i) => ({
    ...structuredClone(d.propositions[0]!),
    action: "announce" as const,
    count: 5,
    scope: { audienceSource: `plan-${i}`, plans: [`plan-${i}`], audienceZh: null, productsZh: "Codex" },
  }));
  const first = await review(id, d);
  assert.equal(first.preview.addedLinks.length, 25);
  const detail = (await monitorPostDetail(id))!;
  assert.equal(detail.draft.propositions.length, 25);
  assert.equal(new Set(detail.draft.propositions.map(p => p.targetEventId)).size, 25);
  const reopened = (await previewMonitorReview(id, { draft: detail.draft, version: detail.version }))!;
  assert.deepEqual(reopened.addedLinks, []);
  assert.deepEqual(reopened.removedLinks, []);
  assert.equal(reopened.changes.length, 25);
  const tooMany = {...d, propositions: Array.from({length: 21}, () => structuredClone(d.propositions[0]!))};
  await assert.rejects(
    () => previewMonitorReview(id, {draft: tooMany, version: detail.version}),
    /最多处理100轮/,
  );
  assert.equal((await sql`SELECT event_id FROM monitor_event_posts WHERE post_id=${id}`).length, 25);
});

test("withdrawn source links can be retained and edited without accepting new links or restoring events", async () => {
  const id = await post();
  const first = await review(id, draft());
  const eventId = first.preview.addedLinks[0]!;
  const [before] = await sql`SELECT updated_at FROM monitor_events WHERE id=${eventId}`;
  await setWithdrawn(eventId, { withdrawn: true, reason: "人工撤回", version: before!.updated_at.toISOString() }, "test");
  const detail = (await monitorPostDetail(id))!;
  detail.draft.translationZh = "修正译文，保留历史依据";
  const corrected = await review(id, detail.draft);
  assert.deepEqual(corrected.preview.addedLinks, []);
  assert.deepEqual(corrected.preview.removedLinks, []);
  assert.equal(corrected.preview.changes[0]!.after.withdrawn, true);
  const [saved] = await sql`SELECT withdrawn,presentation FROM monitor_events WHERE id=${eventId}`;
  const [source] = await sql`SELECT translation FROM monitor_posts WHERE id=${id}`;
  assert.equal(saved!.withdrawn, true);
  assert.equal(saved!.presentation.manualWithdrawn, true);
  assert.equal(source!.translation, detail.draft.translationZh);
  assert.equal((await monitorPostDetail(id))!.post.links[0]!.eventId, eventId);
  const newPost = await post();
  const incoming = draft();
  incoming.propositions[0]!.targetEventId = eventId;
  const newDetail = (await monitorPostDetail(newPost))!;
  await assert.rejects(
    () => previewMonitorReview(newPost, { draft: incoming, version: newDetail.version }),
    /不能新增关联/,
  );
  await review(id, { decision: "related", translationZh: "仅相关", contextZh: [], outage: null, propositions: [] });
  assert.equal((await sql`SELECT withdrawn FROM monitor_events WHERE id=${eventId}`)[0]!.withdrawn, true);
  const replacement = await review(id, draft());
  const replacementId = replacement.preview.addedLinks[0]!;
  assert.notEqual(replacementId, eventId);
  assert.equal((await sql`SELECT withdrawn FROM monitor_events WHERE id=${replacementId}`)[0]!.withdrawn, false);
  assert.equal((await sql`SELECT withdrawn FROM monitor_events WHERE id=${eventId}`)[0]!.withdrawn, true);
  assert.equal((await monitorPostDetail(id))!.post.links[0]!.eventId, replacementId);
});

test("recalculating source facts retains deliberate event edits and context translations", async () => {
  const id = await post("We will reset Plus tomorrow.");
  const d = draft("We will reset Plus tomorrow.");
  Object.assign(d.propositions[0]!, {
    action: "announce",
    scope: {
      audienceSource: "Plus",
      plans: ["Plus"],
      audienceZh: "Plus用户",
      productsZh: "Codex",
    },
  });
  await sql`UPDATE monitor_posts SET raw=${sql.json({ context: [{ id: "parent", author: "someone", relation: "reply", text: "When?", publishedAt: "2026-10-08T00:00:00Z" }] })} WHERE id=${id}`;
  d.contextZh = [{ id: "parent", textZh: "什么时候？" }];
  const { preview } = await review(id, d);
  const eventId = preview.addedLinks[0]!;
  const [e] =
    await sql`SELECT updated_at FROM monitor_events WHERE id=${eventId}`;
  await updateMonitorEvent(
    eventId,
    {
      patch: { audienceZh: "人工校正对象" },
      reason: "精确翻译",
      version: e!.updated_at.toISOString(),
    },
    "test",
  );
  const confirm = await post();
  const cd = draft();
  cd.propositions[0]!.targetEventId = eventId;
  await review(confirm, cd);
  await review(confirm, {
    decision: "related",
    translationZh: "相关",
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [corrected] =
    await sql`SELECT presentation FROM monitor_events WHERE id=${eventId}`;
  assert.equal(corrected!.presentation.audienceZh, "人工校正对象");
  const detail = (await monitorPostDetail(id))!;
  assert.equal(detail.context[0]!.originalText, "When?");
  assert.equal(detail.context[0]!.textZh, "什么时候？");
});

test("link moves require matching preview and repair both event states", async () => {
  const first = await post();
  const { preview: one } = await review(first, draft());
  const second = await post("We will reset tomorrow.");
  const a = draft("We will reset tomorrow.");
  a.propositions[0]!.action = "announce";
  const { preview: two } = await review(second, a);
  const from = one.addedLinks[0]!,
    to = two.addedLinks[0]!;
  await assert.rejects(
    () =>
      relinkPost(
        {
          postId: first,
          fromEventId: from,
          toEventId: to,
          reason: "move",
          version: "",
          previewToken: "",
        },
        "test",
      ),
    /预览/,
  );
  const detail = (await monitorPostDetail(first))!;
  detail.draft.propositions[0]!.targetEventId = to;
  const preview = (await previewMonitorReview(first, {
    draft: detail.draft,
    version: detail.version,
  }))!;
  await relinkPost(
    {
      postId: first,
      fromEventId: from,
      toEventId: to,
      reason: "正确事件",
      version: detail.version,
      previewToken: preview.previewToken,
    },
    "test",
  );
  const [old] =
    await sql`SELECT withdrawn FROM monitor_events WHERE id=${from}`;
  const [target] = await sql`SELECT status FROM monitor_events WHERE id=${to}`;
  assert.equal(old!.withdrawn, true);
  assert.equal(target!.status, "confirmed");
});

test("a transaction rolls back created events when audit persistence fails", async () => {
  const id = await post();
  const d = draft();
  const detail = (await monitorPostDetail(id))!;
  const preview = (await previewMonitorReview(id, {
    draft: d,
    version: detail.version,
  }))!;
  await assert.rejects(() =>
    submitMonitorReview(
      id,
      {
        draft: d,
        version: detail.version,
        previewToken: preview.previewToken,
        reason: "bad\u0000reason",
      },
      "test",
    ),
  );
  assert.equal(
    (
      await sql`SELECT id FROM monitor_events WHERE id=${preview.addedLinks[0]!}`
    ).length,
    0,
  );
  assert.equal(
    (await sql`SELECT event_id FROM monitor_event_posts WHERE post_id=${id}`)
      .length,
    0,
  );
  const [p] = await sql`SELECT processed_at FROM monitor_posts WHERE id=${id}`;
  assert.equal(p!.processed_at, null);
});

test("official confirmation removal preserves an independently checked account receipt", async () => {
  const id = await post("We will reset tomorrow.");
  const a = draft("We will reset tomorrow.");
  a.propositions[0]!.action = "announce";
  const { preview } = await review(id, a);
  const eventId = preview.addedLinks[0]!;
  const [before] =
    await sql`SELECT updated_at FROM monitor_events WHERE id=${eventId}`;
  await reviewReceipt(
    eventId,
    {
      version: before!.updated_at.toISOString(),
      reason: "账户核实",
      occurredOn: "2026-10-09",
    },
    "test",
  );
  const source = await post();
  const c = draft();
  c.propositions[0]!.targetEventId = eventId;
  await review(source, c);
  const [official] =
    await sql`SELECT confirmation_basis FROM monitor_events WHERE id=${eventId}`;
  assert.equal(official!.confirmation_basis, "source_post");
  // Simulate a receipt written by the historical handler, whose proof survives only in audit.
  await sql`UPDATE monitor_events SET presentation=presentation-'receiptReview' WHERE id=${eventId}`;
  await review(source, {
    decision: "unrelated",
    translationZh: null,
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [restored] =
    await sql`SELECT * FROM monitor_events WHERE id=${eventId}`;
  assert.equal(restored!.status, "confirmed");
  assert.equal(restored!.confirmation_basis, "receipt_review");
  assert.equal(restored!.confirmed_at, null);
  assert.equal(
    new Date(restored!.occurred_on).toISOString().slice(0, 10),
    "2026-10-09",
  );
  assert.equal(restored!.presentation.receiptReview.reason, "账户核实");
});

test("remaining reply time uses the parent date when another source is removed", async () => {
  const id = await post("Yes.");
  const eventId = `context-time-${id}`;
  const p = {
    ...draft("Yes.").propositions[0]!,
    action: "announce",
    real: true,
    role: "answer",
    timeSourceId: "parent-time",
    statedTime: {
      precision: "deadline",
      relativeHours: 24,
      period: null,
      clock: null,
      clockThrough: null,
      dayOffset: null,
    },
    timeInferred: false,
  };
  await sql`UPDATE monitor_posts SET published_at='2026-10-08T10:00:00Z',recognition=${sql.json({ relevant: true, propositions: [p] })},
    raw=${sql.json({ context: [{ id: "parent-time", author: "someone", relation: "reply", text: "Will you reset in the next 24 hours?", publishedAt: "2026-10-07T10:00:00Z" }] })},processed_at=now() WHERE id=${id}`;
  await sql`INSERT INTO monitor_events(id,type,status,title,scope,created_at,updated_at) VALUES (${eventId},'direct_reset','announced','','','2026-10-08T10:00:00Z',now())`;
  await sql`INSERT INTO monitor_event_posts(event_id,post_id,stage,action,text,original_text) VALUES (${eventId},${id},'预告','announce','是','Yes.')`;
  const confirm = await post();
  const c = draft();
  c.propositions[0]!.targetEventId = eventId;
  await review(confirm, c);
  await review(confirm, {
    decision: "related",
    translationZh: "相关",
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [event] =
    await sql`SELECT schedule FROM monitor_events WHERE id=${eventId}`;
  assert.equal(event!.schedule.from, "2026-10-08T10:00:00.000Z");
});

test("missing inherited time stays unknown and source correction does not restore a withdrawn event", async () => {
  const id = await post("Yes.");
  const p = {
    ...draft("Yes.").propositions[0]!,
    action: "announce",
    real: true,
    timeSourceId: "missing-time",
    statedTime: {
      precision: "date",
      relativeHours: null,
      period: null,
      clock: null,
      clockThrough: null,
      dayOffset: 1,
    },
  };
  await sql`UPDATE monitor_posts SET recognition=${sql.json({ relevant: true, needsReview: true, propositions: [p] })} WHERE id=${id}`;
  const detail = (await monitorPostDetail(id))!;
  assert.equal(detail.draft.propositions[0]!.schedule, null);
  const announcement = await post("We will reset tomorrow.");
  const d = draft("We will reset tomorrow.");
  d.propositions[0]!.action = "announce";
  const { preview } = await review(announcement, d);
  const eventId = preview.addedLinks[0]!;
  const source = await post();
  const c = draft();
  c.propositions[0]!.targetEventId = eventId;
  await review(source, c);
  const [before] =
    await sql`SELECT updated_at FROM monitor_events WHERE id=${eventId}`;
  await setWithdrawn(
    eventId,
    {
      withdrawn: true,
      reason: "人为撤回",
      version: before!.updated_at.toISOString(),
    },
    "test",
  );
  await review(source, {
    decision: "related",
    translationZh: "相关",
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [after] =
    await sql`SELECT withdrawn,presentation FROM monitor_events WHERE id=${eventId}`;
  assert.equal(after!.withdrawn, true);
  assert.equal(after!.presentation.manualWithdrawn, true);
});

test("review explicitly replaces prior manual fields only when the target override is selected", async () => {
  const id = await post("We will reset tomorrow.");
  const a = draft("We will reset tomorrow.");
  a.propositions[0]!.action = "announce";
  const { preview } = await review(id, a);
  const eventId = preview.addedLinks[0]!;
  const [before] =
    await sql`SELECT updated_at FROM monitor_events WHERE id=${eventId}`;
  const schedule = {
    precision: "exact" as const,
    from: "2026-10-10T10:00:00Z",
    through: "2026-10-10T10:00:00Z",
  };
  await updateMonitorEvent(
    eventId,
    {
      patch: {
        type: "reset_credit",
        scope: "Business",
        scopeLabel: "Business",
        audienceZh: "Business 用户",
        schedule,
      },
      reason: "先前人工修正",
      version: before!.updated_at.toISOString(),
    },
    "test",
  );
  const existing = (await monitorPostDetail(id))!;
  const retained = (await previewMonitorReview(id, {
    draft: existing.draft,
    version: existing.version,
  }))!;
  assert.equal(
    retained.changes.find((c) => c.eventId === eventId)!.after.type,
    "reset_credit",
  );
  const correction = await post("We changed the reset to Plus.");
  const d = draft("We changed the reset to Plus.");
  Object.assign(d.propositions[0]!, {
    action: "amend",
    targetEventId: eventId,
    scope: {
      audienceSource: "Plus",
      plans: ["Plus"],
      audienceZh: "Plus用户",
      productsZh: "Codex",
    },
    overrideEventFields: false,
  });
  const held = (await review(correction, d)).preview.changes.find(
    (c) => c.eventId === eventId,
  )!.after;
  assert.equal(held.type, "reset_credit");
  assert.equal(held.scope, "Business");
  assert.equal(held.schedule!.precision, "exact");
  d.propositions[0]!.overrideEventFields = true;
  const detail = (await monitorPostDetail(correction))!;
  const checked = (await previewMonitorReview(correction, {
    draft: d,
    version: detail.version,
  }))!;
  const replacement = checked.changes.find((c) => c.eventId === eventId)!.after;
  assert.equal(replacement.type, "direct_reset");
  assert.equal(replacement.scope, "Plus");
  assert.equal(replacement.presentation!.scopeLabel, "Plus");
  assert.equal(replacement.schedule, null);
  await submitMonitorReview(
    correction,
    {
      draft: d,
      version: detail.version,
      previewToken: checked.previewToken,
      reason: "确认替换人工字段",
    },
    "test",
  );
  const [saved] =
    await sql`SELECT type,scope,schedule,presentation FROM monitor_events WHERE id=${eventId}`;
  assert.equal(saved!.type, "direct_reset");
  assert.equal(saved!.scope, "Plus");
  assert.equal(saved!.schedule, null);
  assert.equal(saved!.presentation.manualPatch.type, "direct_reset");
  assert.equal(
    (await monitorPostDetail(correction))!.draft.propositions[0]!
      .overrideEventFields,
    false,
  );
  const invalid = draft();
  invalid.propositions[0]!.overrideEventFields = true;
  const fresh = await post();
  const freshDetail = (await monitorPostDetail(fresh))!;
  await assert.rejects(
    () =>
      previewMonitorReview(fresh, {
        draft: invalid,
        version: freshDetail.version,
      }),
    /选择目标事件/,
  );
});

test("outage corrections preview and submit the same dependent recovery changes", async () => {
  const outage = await post("Codex is down.");
  await review(outage, {
    decision: "related",
    translationZh: "故障",
    contextZh: [],
    outage: "outage",
    propositions: [],
  });
  const recovery = await post("Codex recovered.");
  await sql`UPDATE monitor_posts SET published_at=published_at+interval '1 hour' WHERE id=${recovery}`;
  const d: AdminMonitorReviewDraft = {
    decision: "related",
    translationZh: "恢复",
    contextZh: [],
    outage: "recovery",
    propositions: [],
  };
  const detail = (await monitorPostDetail(recovery))!;
  const preview = (await previewMonitorReview(recovery, {
    draft: d,
    version: detail.version,
  }))!;
  assert.ok(
    preview.outageChanges.some(
      (c) =>
        c.postId === outage && (c.after as Record<string, unknown>).recoveredAt,
    ),
  );
  const [unchanged] =
    await sql`SELECT outage FROM monitor_posts WHERE id=${outage}`;
  assert.equal(unchanged!.outage.recoveredAt, null);
  await submitMonitorReview(
    recovery,
    {
      draft: d,
      version: detail.version,
      previewToken: preview.previewToken,
      reason: "已恢复",
    },
    "test",
  );
  const [saved] =
    await sql`SELECT outage FROM monitor_posts WHERE id=${outage}`;
  assert.deepEqual(
    saved!.outage,
    preview.outageChanges.find((c) => c.postId === outage)!.after,
  );
  await review(recovery, {
    decision: "unrelated",
    translationZh: null,
    contextZh: [],
    outage: null,
    propositions: [],
  });
  const [corrected] =
    await sql`SELECT outage FROM monitor_posts WHERE id=${outage}`;
  assert.equal(corrected!.outage.recoveredAt, null);
});

test("concurrent submissions produce one complete decision and a refresh conflict", async () => {
  const id = await post();
  const d = draft();
  const detail = (await monitorPostDetail(id))!;
  const preview = (await previewMonitorReview(id, {
    draft: d,
    version: detail.version,
  }))!;
  const input = {
    draft: d,
    version: detail.version,
    previewToken: preview.previewToken,
    reason: "核验",
  };
  const outcomes = await Promise.allSettled([
    submitMonitorReview(id, input, "one"),
    submitMonitorReview(id, input, "two"),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const failed = outcomes.find(
    (o) => o.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(failed.reason.code, "conflict");
  const links =
    await sql`SELECT event_id FROM monitor_event_posts WHERE post_id=${id}`;
  assert.equal(links.length, 1);
  const audit =
    await sql`SELECT id FROM audit_log WHERE subject=${`monitor-post:${id}`} AND action='monitor.post.review'`;
  assert.equal(audit.length, 1);
});

test("pagination counts agree with filters, clamp pages, and unrelated excludes pending", async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
  const empty = await listMonitorPosts({ filter: "all" });
  assert.deepEqual(
    [empty.total, empty.totalPages, empty.rows.length],
    [0, 0, 0],
  );
  for (let i = 0; i < 11; i++) {
    const id = await post(`unrelated ${i}`);
    await review(id, {
      decision: "unrelated",
      translationZh: null,
      contextZh: [],
      outage: null,
      propositions: [],
    });
  }
  await post("pending");
  const first = await listMonitorPosts({ filter: "unrelated" });
  const second = await listMonitorPosts({ filter: "unrelated", page: 999 });
  assert.deepEqual(
    [first.total, first.totalPages, first.pageSize, first.rows.length],
    [11, 2, 10, 10],
  );
  assert.deepEqual([second.page, second.rows.length], [2, 1]);
  assert.equal((await listMonitorPosts({ filter: "pending" })).total, 1);
  assert.equal((await listMonitorEvents()).totalPages, 0);
  for (let i = 0; i < 11; i++) {
    const id = await post();
    await review(id, draft());
  }
  const events = await listMonitorEvents();
  const next = await listMonitorEvents({ page: 2 });
  assert.deepEqual(
    [events.total, events.totalPages, events.events.length, next.events.length],
    [11, 2, 10, 1],
  );
  const candidate = next.events[0]!;
  const matched = await listMonitorEvents({ q: candidate.id, options: true });
  assert.equal(matched.total, 1);
  assert.equal(matched.events[0]!.id, candidate.id);
});

test("receipt review filter shares button eligibility and counts before pagination", async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  const eligible: string[] = [];
  for (let i = 0; i < 11; i++) {
    const id = `receipt-filter-${i}`;
    eligible.push(id);
    await sql`INSERT INTO monitor_events(id,type,status,title,created_at,updated_at) VALUES (${id},'direct_reset','announced','',now(),now())`;
  }
  await sql`INSERT INTO monitor_events(id,type,status,title,withdrawn,created_at,updated_at) VALUES
    ('receipt-filter-confirmed','direct_reset','confirmed','',false,now(),now()),
    ('receipt-filter-withdrawn','direct_reset','announced','',true,now(),now()),
    ('receipt-filter-linked','direct_reset','announced','',false,now(),now())`;
  const postId = await post();
  await sql`INSERT INTO monitor_event_posts(event_id,post_id,stage,action,text,original_text)
    VALUES ('receipt-filter-linked',${postId},'确认','confirm','','')`;
  const first = await listMonitorEvents({ filter:"receipt_review", withdrawn:true });
  const last = await listMonitorEvents({ filter:"receipt_review", page:999 });
  assert.deepEqual([first.total,first.totalPages,first.pageSize,first.events.length,last.page,last.events.length], [11,2,10,10,2,1]);
  const all = [...first.events,...last.events];
  assert.ok(all.every(e => e.canReceiptReview));
  assert.deepEqual(new Set(all.map(e => e.id)), new Set(eligible));
  const target = first.events[0]!;
  await reviewReceipt(target.id, {reason:"人工核对账户",version:new Date(target.updated_at).toISOString()}, "test");
  const remaining = await listMonitorEvents({ filter:"receipt_review" });
  assert.deepEqual([remaining.total,remaining.totalPages,remaining.events.length],[10,1,10]);
  assert.ok(!remaining.events.some(e => e.id === target.id));
  await sql`UPDATE monitor_events SET withdrawn=true WHERE id IN ${sql(eligible)}`;
  const empty = await listMonitorEvents({ filter:"receipt_review",withdrawn:true });
  assert.deepEqual([empty.total,empty.totalPages,empty.events.length],[0,0,0]);
});
