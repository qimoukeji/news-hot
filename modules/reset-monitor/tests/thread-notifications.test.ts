import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor } from "../backend/context.ts";
import { storeCollectedPost, sourcePost, writePostActions, saveAcceptedPost, loadActionInput } from "../backend/action-store.ts";
import { initializeWebhookBaselines, captureWebhookEvent } from "../backend/webhook-events.ts";
import { properName } from "../backend/public-v2.ts";

beforeEach(async () => {
  await sql`DELETE FROM monitor_event_actions`; await sql`DELETE FROM monitor_event_records`;
  await sql`DELETE FROM monitor_source_posts`; await sql`DELETE FROM monitor_state`;
});
after(closeDb);

for (const incomplete of [false, true]) test(`historical group establishes a notification baseline${incomplete ? " before delayed translation" : " with complete text"} and future updates remain visible`, async () => inMonitor(codex, async () => {
  const author = codex.authors[0]!.handle;
  async function post(id: string, publishedAt: string) {
    await storeCollectedPost({ id, author, publishedAt, url: `https://x.com/${author}/status/${id}`, text: "Synthetic official quota fact", receiptId: null });
    return (await sourcePost(id))!;
  }
  const first = await post("101", "2026-10-28T01:00:00Z");
  await sql.begin(db => writePostActions(db, first, [{ eventId: "event", action: "announce", title: properName("Reset planned"), summary: null, time: "2026-10-28" }],
    { events: [{ id: "event", type: "direct_reset", title: properName("Quota event"), summary: null, scope: { type: "all_users", productCodes: [], planCodes: [], quotaWindowCodes: [], note: null } }] }));
  await initializeWebhookBaselines([codex]);
  if (incomplete) await sql`UPDATE monitor_event_records SET title='{"zh":"未完成翻译"}'::jsonb WHERE monitor_id='codex' AND id='event'`;
  const historical = await post("102", "2026-10-28T02:00:00Z");
  await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES('codex','recognition:historical:102','{"suppressNotifications":true}'::jsonb)`;
  await saveAcceptedPost(historical.id, { expectedVersion: historical.version, title: properName("Reset completed"), summary: null, receiptId: null,
    actions: [{ eventId: "event", action: "confirm", title: properName("Reset completed"), summary: null, time: null }] });
  let [baseline] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='webhook:event:event'`;
  assert.equal(baseline.value.revision, 0);
  assert.equal(baseline.value.historicalPending, incomplete);
  if (incomplete) {
    await sql`UPDATE monitor_event_records SET title=${sql.json(properName("Translated quota event"))} WHERE monitor_id='codex' AND id='event'`;
    await sql.begin(db => captureWebhookEvent(db, "event"));
    [baseline] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='webhook:event:event'`;
    assert.equal(baseline.value.revision, 0);
    assert.equal(baseline.value.historicalPending, false);
  }
  const next = await post("103", "2026-10-28T03:00:00Z");
  await saveAcceptedPost(next.id, { expectedVersion: next.version, title: properName("Delivery update"), summary: null, receiptId: null,
    actions: [{ eventId: "event", action: "progress", title: properName("Delivery update"), summary: null, time: null }] });
  [baseline] = await sql`SELECT value FROM monitor_state WHERE monitor_id='codex' AND key='webhook:event:event'`;
  assert.equal(baseline.value.revision, 1, "a historical source must not permanently mute later official updates");
  assert.equal((await loadActionInput()).actions.length, 3);
}));
