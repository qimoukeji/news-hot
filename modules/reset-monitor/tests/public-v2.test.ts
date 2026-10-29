import { listEvents } from "./admin-fixture.ts";
import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { config } from "@aihot/backend/config";
import { buildApp } from "../../../apps/api/src/app.ts";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { createMonitorServer } from "../server.ts";
import { createOverviewServer } from "../overview-server.ts";
import { inMonitor } from "../backend/context.ts";
import {
  writePostActions,
  sourcePost,
  loadActionInput,
  rowVersion,
} from "../backend/action-store.ts";
import {
  monitorPostDetail,
  previewMonitorReview,
  submitMonitorReview,
} from "../backend/manual-review.ts";
import {
  listMonitorPosts,
  monitorEventDetail,
  previewMonitorEvent,
  updateMonitorEvent,
  setWithdrawn,
} from "../backend/admin.ts";
import {
  exportPublicV2,
  previewPublicV2,
  applyPublicV2,
} from "../backend/public-v2-review.ts";
import { properName, publicV2Snapshot } from "../backend/public-v2.ts";
import { eventListSchema, overviewSchema } from "../public-v2.ts";
const definitions = [codex, claude, grok],
  sourceAt = "2026-10-01T12:00:00Z";
after(async () => {
  installModules([]);
  await closeDb();
});
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`;
  await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`;
  await sql`DELETE FROM monitor_state`;
  await sql`DELETE FROM audit_log`;
  installModules([
    ...definitions.map(createMonitorServer),
    createOverviewServer(definitions),
  ]);
  for (const definition of definitions)
    await inMonitor(definition, async () => {
      await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,processing_status) VALUES(${definition.monitorId},'post',${definition.authors[0]!.handle},${sourceAt},${`https://x.com/${definition.authors[0]!.handle}/status/post`},${sql.json(properName("Source title"))},'processed')`;
      await sql.begin(async (tx) => {
        const post = await sourcePost("post", tx);
        await writePostActions(tx, post!, [
          {
            eventId: "event",
            action: "announce",
            title: properName("Planned reset"),
            summary: null,
            time: "2026-10-02T00:00:00Z",
          },
        ], { events: [{ id: "event", type: "direct_reset" }] });
      });
    });
});
test("all platforms expose action updates through v2 only and support ETag", async () => {
  const app = await buildApp();
  try {
    for (const definition of definitions) {
      const response = await app.inject(
        definition.publicApiPath +
          "?from=2026-10-01&to=2026-10-31&timeZone=Asia%2FShanghai",
      );
      assert.equal(response.statusCode, 200, response.body);
      const body = eventListSchema.parse(response.json());
      assert.equal(body.list[0]!.updates[0]!.action, "announce");
      assert.equal(body.list[0]!.updates[0]!.time, "2026-10-02T00:00:00Z");
      assert.equal(Date.parse(body.list[0]!.updates[0]!.publishedAt), Date.parse(sourceAt));
      assert.equal(body.list[0]!.updates[0]!.sources[0]!.postId, "post");
      assert.notEqual(body.list[0]!.updates[0]!.id, "post");
      assert.equal("source" in body.list[0]!.updates[0]!, false);
      const again = await app.inject({
        url:
          definition.publicApiPath +
          "?from=2026-10-01&to=2026-10-31&timeZone=Asia%2FShanghai",
        headers: { "if-none-match": response.headers.etag! },
      });
      assert.equal(again.statusCode, 304);
      for (const old of [
        definition.publicApiPath.replace("/v2/", "/v1/"),
        `/api/v1/agent${definition.agentPath}`,
        definition.publicApiPath + "/recent",
        "/api/site/" + definition.moduleName,
      ])
        assert.equal((await app.inject(old)).statusCode, 404);
    }
    const overview = overviewSchema.parse(
      (await app.inject("/api/v2/overview")).json(),
    );
    assert.equal(overview.platforms.length, 3);
    assert.ok(
      overview.platforms.every(
        (platform) =>
          platform.announcedResetTime !== null && platform.resetTime === null,
      ),
    );
  } finally {
    await app.close();
  }
});
test("same post can append a confirmation with explicit source commands", async () => inMonitor(codex, async () => {
  const detail = (await monitorPostDetail("post"))!;
  const draft = { version: detail.version, versions: detail.versions, reason: "核对原帖动作",
    actions: { create: [{ localKey: "confirmation", eventId: "event", action: "confirm", title: { zh: "已完成" }, summary: null, time: null }] },
    sources: { add: [{ actionKey: "confirmation", postId: "post" }] } };
  const preview = (await previewMonitorReview("post", draft))!;
  await submitMonitorReview("post", { ...draft, previewToken: preview.previewToken }, "reviewer");
  const snapshot = await publicV2Snapshot();
  assert.equal(snapshot.events[0]!.status, "completed"); assert.equal(Date.parse(snapshot.resetTime!), Date.parse(sourceAt));
  assert.equal(snapshot.announcedResetTime, null); assert.equal(snapshot.events[0]!.updates.length, 2);
  const input = await loadActionInput(); assert.equal(input.posts[0]!.processing_status, "processed");
  const serialized = JSON.stringify(snapshot);
  for (const field of ['"text":', '"quoted_post":', '"originalText":', '"recognition":', '"context":', '"raw":']) assert.equal(serialized.includes(field), false);
}));

test("HTTP overview retains confirmations beside a new plan and recomputes cancelled all-kind samples", async () => {
  await sql`DELETE FROM monitor_event_actions WHERE monitor_id='codex'`;
  await sql`DELETE FROM monitor_event_records WHERE monitor_id='codex'`;
  const now = Date.now(), time = (days: number) => new Date(now + days * 86_400_000).toISOString();
  const add = async (id: string, type: "direct_reset" | "reset_credit" | "bonus_credit", days: number, action: "announce" | "confirm" = "confirm") => inMonitor(codex, async () => {
    await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,processing_status) VALUES('codex',${id},${codex.authors[0]!.handle},${time(Math.min(days, 0))},${`https://example.test/${id}`},'processed')`;
    await sql.begin(async db => writePostActions(db, (await sourcePost(id, db))!, [{ eventId: id, action, time: time(days), title: properName(id), summary: null }], { events: [{ id, type }] }));
  });
  await add("reset-history", "direct_reset", -9);
  await add("card-history", "reset_credit", -6);
  await add("bonus-history", "bonus_credit", -3);
  await add("future-plan", "direct_reset", 1, "announce");
  const app = await buildApp();
  try {
    const before = await app.inject("/api/v2/overview"), platform = overviewSchema.parse(before.json()).platforms.find(row => row.platform === "codex")!;
    assert.equal(platform.announcedResetTime, time(1));
    assert.equal(platform.resetTime, time(-3));
    assert.deepEqual(platform.statistics.typicalInterval, { value: 3, unit: "day", sampleCount: 2 });
    assert.equal(platform.predictedResetTime, time(0));
    await inMonitor(codex, async () => sql.begin(async db => writePostActions(db, (await sourcePost("bonus-history", db))!, [{ eventId: "bonus-history", action: "amend", invalidatesEvent: true, time: time(0), title: properName("Campaign cancelled"), summary: null }])));
    const after = await app.inject({ url: "/api/v2/overview", headers: { "if-none-match": before.headers.etag! } });
    assert.equal(after.statusCode, 200);
    assert.notEqual(after.headers.etag, before.headers.etag);
    const changed = overviewSchema.parse(after.json()).platforms.find(row => row.platform === "codex")!;
    assert.equal(changed.resetTime, time(-6));
    assert.equal(changed.announcedResetTime, time(1));
    assert.equal(changed.statistics.bonusesLast30Days, 0);
    assert.deepEqual(changed.statistics.typicalInterval, { value: 3, unit: "day", sampleCount: 1 });
    const snapshot = await inMonitor(codex, () => publicV2Snapshot());
    assert.equal(snapshot.events.find(event => event.id === "bonus-history")!.status, "cancelled");
  } finally { await app.close(); }
});
test("removing the final source deletes its action and invalidates publication", async () => inMonitor(codex, async () => {
  const detail = (await monitorPostDetail("post"))!;
  const draft = { version: detail.version, versions: detail.versions, reason: "没有有效动作", sources: { remove: [{ actionId: detail.actions[0]!.id, postId: "post" }] } };
  const preview = (await previewMonitorReview("post", draft))!;
  assert.equal(preview.lastSourceRemovals.length, 1);
  await submitMonitorReview("post", { ...draft, previewToken: preview.previewToken }, "reviewer");
  assert.deepEqual((await publicV2Snapshot()).events, []);
  const event = (await listEvents()).events[0]!;
  assert.equal(event.status, null); assert.equal(event.time, null);
  await assert.rejects(setWithdrawn("event", { version: event.version, reason: "恢复", withdrawn: false }, "reviewer"), /有效/);
}));
test("review requires preview, reason and current related versions", async () => inMonitor(codex, async () => {
  const detail = (await monitorPostDetail("post"))!;
  const draft = { version: detail.version, versions: detail.versions, reason: "更正", post: { title: { zh: "修正文案" } } };
  await assert.rejects(submitMonitorReview("post", draft, "reviewer"), /预览/);
  const preview = (await previewMonitorReview("post", draft))!;
  await sql`UPDATE monitor_event_records SET updated_at=clock_timestamp() WHERE monitor_id='codex'`;
  await assert.rejects(submitMonitorReview("post", { ...draft, previewToken: preview.previewToken }, "reviewer"), /变化/);
  await assert.rejects(previewMonitorReview("post", { ...draft, reason: "" }));
}));
test("display edits cannot write status or time and partial translations stay private", async () =>
  inMonitor(codex, async () => {
    const event = (await listEvents()).events[0]!;
    for (const patch of [
      { status: "completed" },
      { time: sourceAt },
      { confirmedAt: sourceAt },
      { schedule: null },
    ])
      await assert.rejects(
        updateMonitorEvent(
          "event",
          { version: event.version, reason: "修改", patch },
          "reviewer",
        ),
      );
    await updateMonitorEvent(
      "event",
      {
        version: event.version,
        reason: "编辑文案",
        patch: { title: { zh: "人工标题" }, summary: { zh: "人工摘要" } },
      },
      "reviewer",
    );
    const snapshot = await publicV2Snapshot();
    assert.equal(snapshot.events[0]!.status, "announced");
    assert.equal(snapshot.events[0]!.time, "2026-10-02T00:00:00Z");
    assert.equal(snapshot.events[0]!.summary, null);
    assert.notEqual(snapshot.events[0]!.title.zh, "人工标题");
  }));

test("compatible event types can be previewed and changed without rewriting their actions", async () =>
  inMonitor(codex, async () => {
    await sql`UPDATE monitor_event_actions SET action='confirm',time=NULL WHERE monitor_id='codex' AND event_id='event'`;
    const event = (await listEvents()).events[0]!, before = await loadActionInput();
    const edit = { version: event.version, reason: "更正事件类型", patch: { type: "bonus_credit" } };
    await assert.rejects(updateMonitorEvent("event", edit, "reviewer"), /预览/);
    const preview = (await previewMonitorEvent("event", edit))!;
    assert.equal(preview.before.status, "completed");
    assert.equal(preview.after.type, "bonus_credit");
    assert.equal(preview.after.status, "completed");
    assert.equal(preview.after.time, preview.before.time);
    assert.equal((await loadActionInput()).events[0]!.type, "direct_reset");
    await updateMonitorEvent("event", { ...edit, previewToken: preview.previewToken }, "reviewer");
    const after = await loadActionInput();
    assert.equal(after.events[0]!.type, "bonus_credit");
    assert.deepEqual(after.actions, before.actions);
    assert.equal((await publicV2Snapshot()).events[0]!.status, "completed");
    const next = (await listEvents()).events[0]!, cardEdit = { version: next.version, reason: "更正为重置卡", patch: { type: "reset_credit" } };
    const cardPreview = (await previewMonitorEvent("event", cardEdit))!;
    assert.equal(cardPreview.after.status, "completed");
    await updateMonitorEvent("event", { ...cardEdit, previewToken: cardPreview.previewToken }, "reviewer");
    assert.equal((await publicV2Snapshot()).events[0]!.type, "reset_credit");
  }));

test("type changes share action semantics and reject stale source previews", async () =>
  inMonitor(codex, async () => {
    let event = (await listEvents()).events[0]!;
    const change = { version: event.version, reason: "更正类型", patch: { type: "bonus_credit" } };
    const preview = (await previewMonitorEvent("event", change))!;
    await sql`UPDATE monitor_source_posts SET published_at=published_at+interval '1 minute' WHERE monitor_id='codex' AND id='post'`;
    await assert.rejects(updateMonitorEvent("event", { ...change, previewToken: preview.previewToken }, "reviewer"), /重新预览/);
    const fresh = (await previewMonitorEvent("event", change))!;
    await updateMonitorEvent("event", { ...change, previewToken: fresh.previewToken }, "reviewer");
    await sql.begin(async tx => {
      const post = await sourcePost("post", tx);
      await writePostActions(tx, post!, [{ eventId: "event", action: "progress", title: properName("Claim closed"), summary: null, time: null }]);
    });
    event = (await listEvents()).events[0]!;
    const shared = { version: event.version, patch: { type: "direct_reset" } };
    const sharedPreview = (await previewMonitorEvent("event", shared))!;
    await updateMonitorEvent("event", { ...shared, previewToken: sharedPreview.previewToken }, "reviewer");
    assert.equal((await loadActionInput()).events[0]!.type, "direct_reset");
  }));

test("event summaries use their saved values and explicit clearing survives later edits", async () =>
  inMonitor(codex, async () => {
    const actionSummary = properName("Accepted action summary");
    await sql`UPDATE monitor_event_actions SET summary=${sql.json(actionSummary)} WHERE monitor_id='codex' AND event_id='event'`;
    assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
    let event = (await listEvents()).events[0]!;
    await updateMonitorEvent("event", { version: event.version, patch: { summary: null } }, "reviewer");
    const input = await loadActionInput();
    assert.equal(input.actions[0]!.summary?.en, actionSummary.en);
    assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
    event = (await listEvents()).events[0]!;
    assert.equal(event.summary, null);
    await updateMonitorEvent("event", { version: event.version, patch: { title: properName("New event title") } }, "reviewer");
    assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  }));

test("editorial exports preserve null event summaries without action fallback", async () => {
  await inMonitor(codex, async () => {
    await sql`UPDATE monitor_event_actions SET summary=${sql.json(properName("Automatic action summary"))} WHERE monitor_id='codex' AND event_id='event'`;
    const unchanged = await exportPublicV2([codex]);
    await applyPublicV2(unchanged, [codex], "原样核验包");
    assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
    const filled = await exportPublicV2([codex]);
    filled.monitors[0]!.reviews.find(review => review.kind === "event")!.editorial.summary = properName("Human event summary");
    await applyPublicV2(filled, [codex], "核验事件摘要");
    const cleared = await exportPublicV2([codex]);
    cleared.monitors[0]!.reviews.find(review => review.kind === "event")!.editorial.summary = null;
    const preview = await previewPublicV2(cleared, [codex]);
    assert.equal(preview.snapshots[0]!.events[0]!.summary, null);
    await applyPublicV2(cleared, [codex], "核验清空摘要");
    assert.equal((await publicV2Snapshot()).events[0]!.summary, null);
  });
});
test("withdrawal does not alter actions and restoration recomputes them", async () =>
  inMonitor(codex, async () => {
    let event = (await listEvents()).events[0]!;
    await setWithdrawn(
      event.id,
      { version: event.version, reason: "隐藏", withdrawn: true },
      "reviewer",
    );
    assert.deepEqual((await publicV2Snapshot()).events, []);
    event = (await listEvents({ visibility: "withdrawn" })).events[0]!;
    await setWithdrawn(
      event.id,
      { version: event.version, reason: "恢复", withdrawn: false },
      "reviewer",
    );
    assert.equal((await publicV2Snapshot()).events[0]!.status, "announced");
  }));
test("editorial bundle cannot set state, time or action facts and detects stale versions", async () => {
  const bundle = await exportPublicV2(definitions);
  const review = bundle.monitors[0]!.reviews.find(
    (row) => row.kind === "event",
  )!;
  review.editorial.title = properName("Reviewed title");
  assert.ok((await previewPublicV2(bundle, definitions)).changes.length);
  await applyPublicV2(bundle, definitions, "核验文案");
  await assert.rejects(applyPublicV2(bundle, definitions, "旧版本"), /changed/);
  const next = await exportPublicV2(definitions);
  Object.assign(next.monitors[0]!.reviews[0]!.editorial, {
    status: "completed",
  });
  await assert.rejects(previewPublicV2(next, definitions));
});
test("API rejects invalid ranges and backend guard protects admin actions", async () => {
  const app = await buildApp();
  try {
    for (const suffix of [
      "?from=bad",
      "?from=2026-01-01&to=2026-12-31",
      "?timeZone=bad",
      "?limit=0",
      "?unknown=1",
    ])
      assert.equal(
        (await app.inject(codex.publicApiPath + suffix)).statusCode,
        400,
      );
    assert.equal(
      (await app.inject(codex.adminApiPath + "/entries")).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: codex.adminApiPath + "/events/event/receipt-review",
          payload: {},
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("post editorial changes do not create formal event relationships", async () => inMonitor(codex, async () => {
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,text) VALUES('codex','related',${codex.authors[0]!.handle},${sourceAt},'https://example.test/related',${sql.json(properName("Related explanation"))},'Private source body')`;
  const detail = (await monitorPostDetail("related"))!;
  assert.equal(detail.post!.text, "Private source body");
  const draft = { version: detail.version, versions: detail.versions, reason: "编辑说明", post: { title: { zh: "相关说明" }, summary: { zh: "更新了说明" } } };
  const preview = (await previewMonitorReview("related", draft))!;
  await submitMonitorReview("related", { ...draft, previewToken: preview.previewToken }, "reviewer");
  const input = await loadActionInput();
  assert.equal(input.actions.length, 1); assert.equal(input.actions.some(action => action.sources.some(source => source.postId === "related")), false);
  assert.equal(input.posts.find(post => post.id === "related")!.summary!.zh, "更新了说明");
  assert.equal(JSON.stringify(await sql`SELECT before,after FROM audit_log`).includes("Private source body"), false);
}));
test("scope editorial text can await translation while invalid catalog codes are rejected", async () =>
  inMonitor(codex, async () => {
    const event = (await listEvents()).events[0]!;
    const scope = {
      type: "selected_users" as const,
      productCodes: [],
      planCodes: [],
      quotaWindowCodes: [],
      note: { zh: "仅受影响用户" },
    };
    await assert.rejects(
      updateMonitorEvent(
        event.id,
        {
          version: event.version,
          reason: "修正范围",
          patch: { scope: { ...scope, planCodes: ["nonexistent"] } },
        },
        "reviewer",
      ),
      /目录/,
    );
    await updateMonitorEvent(
      event.id,
      { version: event.version, reason: "修正范围", patch: { scope } },
      "reviewer",
    );
    const input = await loadActionInput();
    assert.equal(input.events[0]!.scope!.note!.zh, "仅受影响用户");
    assert.deepEqual(
      (await publicV2Snapshot()).events,
      [],
      "an untranslated narrow audience must never be widened publicly",
    );
  }));

test("OpenAPI v2 describes action sources and v1 no longer advertises monitor snapshots", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject("/openapi-v2.json");
    assert.equal(response.statusCode, 200);
    const spec = response.json();
    assert.ok(spec.paths["/api/v2/codex-resets"]);
    const event = spec.components.schemas.EventList.properties.list.items;
    const variants = event.properties.updates.items.oneOf;
    assert.equal(variants.length, 3);
    const confirmation = variants.find((variant: any) => variant.properties.action.const === "confirm");
    assert.equal(confirmation.properties.sources.minItems, undefined);
    assert.ok(variants.filter((variant: any) => variant !== confirmation).every((variant: any) => variant.properties.sources.minItems === 1));
    assert.ok(variants.every((variant: any) => variant.properties.source === undefined));
    assert.equal(event.properties.confirmation, undefined);
    assert.equal(JSON.stringify(variants).includes('"restore"'), false);
    const v1 = (await app.inject("/openapi-v1.json")).json();
    assert.equal(v1.paths["/api/v1/codex-resets"], undefined);
    assert.ok(v1.paths["/api/v1/items"]);
  } finally {
    await app.close();
  }
});

test("monitor Agent addresses use v2 and stay discoverable without legacy aliases", async () => {
  const app = await buildApp();
  try {
    for (const definition of definitions) {
      const response = await app.inject(`/api/v2/agent${definition.agentPath}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.body.includes("https://x.com/"));
      assert.equal(
        (await app.inject(`/api/v1/agent${definition.agentPath}`)).statusCode,
        404,
      );
    }
    const guide = await app.inject("/api/v1/agent");
    assert.ok(guide.body.includes("/api/v2/agent/codex-resets"));
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v2/codex-resets",
          payload: "{bad",
          headers: { "content-type": "application/json" },
        })
      ).statusCode,
      405,
    );
  } finally {
    await app.close();
  }
});

test("admin event filters combine search, type, derived status and publication visibility", async () => inMonitor(codex, async () => {
  const add = async (eventId: string, type: "direct_reset" | "bonus_credit", action: "confirm" | "announce", title: string) => {
    await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,processing_status) VALUES('codex',${eventId},'FilterAuthor',${sourceAt},${`https://example.test/${eventId}`},${sql.json(properName(title))},'processed')`;
    await sql.begin(async db => writePostActions(db, (await sourcePost(eventId, db))!, [{ eventId, action, title: properName(title), summary: null, time: null }], { events: [{ id: eventId, type, title: properName(title) }] }));
  };
  await add("bonus", "bonus_credit", "confirm", "奖励活动 Alpha");
  await add("hidden", "direct_reset", "confirm", "Withdrawn reset");
  await sql`UPDATE monitor_event_records SET withdrawn=true WHERE monitor_id='codex' AND id='hidden'`;
  await sql`INSERT INTO monitor_event_records(monitor_id,id,type,title,created_at) VALUES('codex','unpublished','direct_reset',${sql.json(properName("No initial fact"))},${sourceAt})`;
  assert.deepEqual((await listEvents({ q: "  alpha  ", type: "bonus_credit", status: "completed", visibility: "public" })).events.map(event => event.id), ["bonus"]);
  assert.deepEqual((await listEvents({ visibility: "withdrawn" })).events.map(event => event.id), ["hidden"]);
  assert.deepEqual((await listEvents({ visibility: "unpublished" })).events.map(event => event.id), ["unpublished"]);
  assert.equal((await listEvents({ visibility: "public" })).total, 2);
  assert.equal((await listEvents({ visibility: "all" })).total, 4);
  assert.equal((await listEvents({ q: "FilterAuthor" })).total, 2);
  assert.equal((await listEvents({ q: "example.test/bonus" })).events[0]!.id, "bonus");
  assert.equal((await listEvents({ status: "completed", visibility: "public" })).total, 1);
  for (const filters of [{ type: "bad" }, { status: "bad" }, { visibility: "bad" }]) await assert.rejects(listEvents(filters));
}));

test("admin counts use valid relationships while translations withhold public updates", async () => inMonitor(codex, async () => {
  const before = await loadActionInput(), original = before.actions[0]!;
  await sql`INSERT INTO monitor_source_posts(monitor_id,id,author,published_at,url,title,processing_status,review_reason) VALUES('codex','second','CountAuthor',${sourceAt},'https://example.test/count-second',${sql.json(properName("Second source"))},'failed','Keep visible review reason')`;
  await sql.begin(async db => {
    await writePostActions(db, (await sourcePost("second", db))!, [{ id: original.id, eventId: "event", action: original.action, title: original.title, summary: original.summary, time: original.time }]);
    await writePostActions(db, (await sourcePost("post", db))!, [{ eventId: "event", action: "amend", title: { zh: "未译修订" }, summary: null, time: null }]);
  });
  await sql`UPDATE monitor_event_records SET title='{"zh":"配额调整事件"}'::jsonb,scope=${sql.json({ type: "selected_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: { zh: "仅特定用户" } })} WHERE monitor_id='codex' AND id='event'`;
  const event = (await listEvents()).events[0]!;
  assert.equal(event.updates.length, 0); assert.equal(event.actionCount, 2); assert.equal(event.sourcePostCount, 2);
  const posts = await listMonitorPosts({ q: "配额调整事件" });
  assert.equal(posts.total, 2);
  const first = posts.rows.find(post => post.id === "post")!;
  assert.equal(first.actionCount, 2); assert.deepEqual(first.events, [{ id: "event", type: "direct_reset", title: { zh: "配额调整事件" } }]);
  const second = (await listMonitorPosts({ q: "keep visible", filter: "failed" })).rows[0]!;
  assert.equal(second.id, "second"); assert.equal(second.actionCount, 1); assert.equal(second.reviewReason, "Keep visible review reason");
  const detail = (await monitorEventDetail("event"))!, raw = (await loadActionInput()).events[0]!;
  assert.equal(detail.event!.status, "announced"); assert.equal(detail.event!.time, event.time);
  assert.equal(detail.event!.withdrawn, false); assert.equal(detail.event!.version, rowVersion(raw));
  assert.equal(detail.event!.actionCount, 2); assert.equal(detail.event!.sourcePostCount, 2);
  assert.equal(detail.options.posts.find(post => post.id === "second")!.reviewReason, "Keep visible review reason");
  assert.equal(detail.post, undefined);
}));

test("admin HTTP lists forward supported filters and reject retired visibility parameters", async () => {
  const previous = config.devAdmin; config.devAdmin = { displayName: "Synthetic list reviewer" };
  const app = await buildApp();
  try {
    const response = await app.inject(codex.adminApiPath + "/entries?kind=events&q=planned&type=direct_reset&status=announced&visibility=public");
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().total, 1); assert.equal(response.json().rows[0].event.sourcePostCount, 1);
    assert.equal((await app.inject(codex.adminApiPath + "/entries?kind=events&visibility=withdrawn")).json().total, 0);
    assert.equal((await app.inject(codex.adminApiPath + "/entries?kind=events&status=completed")).json().total, 0);
    for (const query of ["withdrawn=1", "type=bad", "visibility=bad", "status=bad"]) assert.equal((await app.inject(codex.adminApiPath + "/entries?kind=events&" + query)).statusCode, 400, query);
    for (const definition of definitions) for (const suffix of ["/events", "/events/options"]) assert.equal((await app.inject(definition.adminApiPath + suffix)).statusCode, 404);
    const posts = await app.inject(codex.adminApiPath + "/posts?q=source&filter=processed");
    assert.equal(posts.statusCode, 200, posts.body); assert.equal(posts.json().total, 1); assert.equal(posts.json().rows[0].events[0].id, "event");
    assert.equal(posts.json().rows[0].actionCount, 1); assert.equal("eventIds" in posts.json().rows[0], false);
    assert.equal((await app.inject(codex.adminApiPath + "/posts?filter=review")).statusCode, 400);
    const combined = await app.inject(codex.adminApiPath + "/entries?q=source&filter=processed&kind=events");
    assert.equal(combined.statusCode, 200, combined.body); assert.equal(combined.json().total, 1);
    assert.equal(combined.json().rows[0].kind, "event"); assert.equal(combined.json().rows[0].event.timeline[0].sources[0].id, "post");
    for (const query of ["kind=bad", "filter=review", "unknown=1"]) assert.equal((await app.inject(codex.adminApiPath + "/entries?" + query)).statusCode, 400);
    const detail = await app.inject(codex.adminApiPath + "/events/event/review");
    assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().event.status, "announced"); assert.equal(detail.json().event.withdrawn, false);
    assert.equal(detail.json().event.actionCount, 1); assert.equal(detail.json().event.sourcePostCount, 1);
    assert.equal("reviewReason" in detail.json().options.posts[0], true);
  } finally { config.devAdmin = previous; await app.close(); }
});
