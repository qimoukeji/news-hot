import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { inMonitor, type ResetMonitorBackendDefinition } from "../backend/context.ts";
import { applyRecognition } from "../backend/assemble.ts";
import { resetPage } from "../backend/read.ts";
import { openEvents } from "../backend/scan.ts";
import { updateMonitorEvent, listMonitorEvents } from "../backend/admin.ts";
import { monitorAnswer } from "../backend/agent.ts";
import { monitorPostDetail, previewMonitorReview, submitMonitorReview } from "../backend/manual-review.ts";
import type { Recognition } from "../backend/recognize.ts";

const definition: ResetMonitorBackendDefinition = { ...codex, authors: [...codex.authors, { handle: "CodexTeam", name: "Codex Team" }] };
const at = new Date("2026-10-10T00:00:00Z");
async function addPost(id: string, author: string, text: string, context: unknown[] = []) {
  await sql`INSERT INTO monitor_posts (monitor_id,id,author,published_at,text,url,raw)
    VALUES ('codex',${id},${author},${at},${text},${`https://x.com/${author}/status/${id}`},${sql.json({ context } as never)})`;
}
function recognition(text: string, kind: "direct_reset" | "bonus_credit" = "direct_reset"): Recognition {
  return { relevant: true, translationZh: text, contextZh: [], outage: null, needsReview: false,
    model: "test", promptVersion: "test", receiptId: 0, propositions: [{
      kind, kindExplicit: true, action: "announce", real: true, role: "action", count: 1,
      relatesTo: null, excerpt: text, excerptZh: text, statedTime: null, timeInferred: false,
      expectedLanding: { earliestPacific: "2026-10-10 16:30", latestPacific: "2026-10-10 21:30", note: "model window" },
      scope: { audienceSource: "Pro", plans: ["Pro"], audienceZh: "Pro", productsZh: "Codex" },
      ...(kind === "bonus_credit" ? { bonusCredit: { amount: null, eligibility: null, claimMethod: null, claimDeadline: null, expiresAt: null } } : {}),
    }] };
}
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`; await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`; await sql`DELETE FROM monitor_state`;
});
after(closeDb);

test("only the configured author receives predictions and explicit authors stay unconfirmed after source time", async () => {
  const text = "We will reset Codex usage for Pro.";
  await addPost("101", "thsottiaux", text); await addPost("102", "CodexTeam", text);
  await inMonitor(definition, () => applyRecognition("101", recognition(text)));
  await inMonitor(definition, () => applyRecognition("102", recognition(text)));
  const snapshot = await inMonitor(definition, () => resetPage());
  const tibo = snapshot.events.find(e => e.posts.some(p => p.id === "101"))!;
  const team = snapshot.events.find(e => e.posts.some(p => p.id === "102"))!;
  assert.equal(tibo.presentation!.timePolicy, "predicted"); assert.ok(tibo.estimate);
  assert.equal(team.presentation!.timePolicy, "explicit"); assert.equal(team.estimate, null);
  assert.equal(team.title, "Codex Team 预告将重置额度");
  const candidates = await inMonitor(definition, () => openEvents(new Date(at.getTime() + 1000), []));
  assert.equal(candidates.find(candidate => candidate.id === team.id)!.firstPostAuthor, "CodexTeam");
  const answer = await inMonitor(definition, () => monitorAnswer({ ...snapshot, events: [team] }));
  assert.ok(!answer.includes("model window")); assert.ok(answer.includes("Codex Team"));
  await sql`UPDATE monitor_events SET schedule=${sql.json({ precision: "exact", from: at.toISOString(), through: at.toISOString(), label: "明确时间" })}
    WHERE monitor_id='codex' AND id=${team.id}`;
  const after = await inMonitor(definition, () => resetPage());
  assert.equal(after.events.find(e => e.id === team.id)!.presentation!.status, "expired_unconfirmed");
});

test("Codex product rewards are recorded without reset counts or predictions", async () => {
  const text = "We will offer one-time bonus usage credits for Codex Pro.";
  await addPost("201", "thsottiaux", text);
  await inMonitor(definition, () => applyRecognition("201", recognition(text, "bonus_credit")));
  const snapshot = await inMonitor(definition, () => resetPage());
  assert.equal(snapshot.events.length, 1); assert.equal(snapshot.events[0]!.type, "bonus_credit");
  assert.equal(snapshot.events[0]!.estimate, null); assert.equal(snapshot.events[0]!.presentation!.timePolicy, "explicit");
  assert.equal(snapshot.stats.resets90, 0);
});

test("a Tibo reward opening without a timezone keeps its words without inheriting Pacific time", async () => {
  const text = "One-time bonus usage credits for Codex Pro are available tomorrow at 6pm.";
  await addPost("202", "thsottiaux", text);
  const rec = recognition(text, "bonus_credit");
  rec.propositions[0]!.statedTime = { precision: "exact", dayOffset: 1, clock: "18:00", clockThrough: null, relativeHours: null, period: null };
  await inMonitor(definition, () => applyRecognition("202", rec));
  const snapshot = await inMonitor(definition, () => resetPage());
  assert.equal(snapshot.events[0]!.schedule, null);
  assert.equal(snapshot.events[0]!.estimate, null);
  assert.equal(snapshot.events[0]!.presentation!.timePolicy, "explicit");
});

test("an explicit model event ID does not itself prove a cross-author association", async () => {
  const text = "We will reset Codex usage for Pro.";
  await addPost("301", "thsottiaux", text);
  const announced = await inMonitor(definition, () => applyRecognition("301", recognition(text)));
  const confirmation = "We have reset Codex usage for Pro.";
  await addPost("302", "CodexTeam", confirmation);
  const rec = recognition(confirmation); rec.propositions[0]!.action = "confirm"; rec.propositions[0]!.relatesTo = announced.eventIds[0]!;
  const result = await inMonitor(definition, () => applyRecognition("302", rec));
  assert.deepEqual(result.eventIds, []);
  const [stored] = await sql`SELECT recognition FROM monitor_posts WHERE monitor_id='codex' AND id='302'`;
  assert.equal(stored!.recognition.needsReview, true);
});

test("a verified official reply can confirm another configured author's event", async () => {
  const text = "We will reset Codex usage for Pro.";
  await addPost("401", "thsottiaux", text);
  const announced = await inMonitor(definition, () => applyRecognition("401", recognition(text)));
  const confirmation = "We have reset Codex usage for Pro.";
  await addPost("402", "CodexTeam", confirmation, [{ id: "401", author: "thsottiaux", relation: "reply", text, publishedAt: at.toISOString() }]);
  const rec = recognition(confirmation); rec.propositions[0]!.action = "confirm";
  const result = await inMonitor(definition, () => applyRecognition("402", rec));
  assert.deepEqual(result.eventIds, announced.eventIds);
});

test("manual review of a new author's event does not introduce a Tibo prediction", async () => {
  const text = "We will reset Codex usage for Pro.";
  await addPost("501", "CodexTeam", text);
  await inMonitor(definition, () => applyRecognition("501", recognition(text)));
  const detail = (await inMonitor(definition, () => monitorPostDetail("501")))!;
  const preview = (await inMonitor(definition, () => previewMonitorReview("501", { draft: detail.draft, version: detail.version })))!;
  await inMonitor(definition, () => submitMonitorReview("501", { draft: detail.draft, version: detail.version, previewToken: preview.previewToken, reason: "核对新账号时间依据" }, "test-admin"));
  const snapshot = await inMonitor(definition, () => resetPage());
  assert.equal(snapshot.events[0]!.estimate, null); assert.equal(snapshot.events[0]!.presentation!.timePolicy, "explicit");
  const event = (await inMonitor(definition, () => listMonitorEvents())).events[0]!;
  await inMonitor(definition, () => updateMonitorEvent(event.id, { patch: { scopeLabel: "核实后的 Pro 范围" },
    version: new Date(event.updated_at).toISOString(), reason: "核对事件对象" }, "test-admin"));
  const edited = await inMonitor(definition, () => resetPage());
  assert.equal(edited.events[0]!.estimate, null, "event edits also use the actual source author");
});

test("event edits preserve a later author's prediction and use that author when changing time", async () => {
  const text = "We will reset Codex usage for Pro.";
  await addPost("601", "CodexTeam", text);
  const announced = await inMonitor(definition, () => applyRecognition("601", recognition(text)));
  const amendment = "We will reset Codex usage for Pro today.";
  await addPost("602", "thsottiaux", amendment, [{ id: "601", author: "CodexTeam", relation: "reply", text, publishedAt: at.toISOString() }]);
  await sql`UPDATE monitor_posts SET published_at=${new Date(at.getTime() + 3600_000)} WHERE monitor_id='codex' AND id='602'`;
  const rec = recognition(amendment);
  Object.assign(rec.propositions[0]!, { action: "amend", relatesTo: announced.eventIds[0], expectedLanding: null,
    statedTime: { precision: "date", dayOffset: 0, clock: null, clockThrough: null, relativeHours: null, period: null } });
  const applied = await inMonitor(definition, () => applyRecognition("602", rec));
  assert.deepEqual(applied.eventIds, announced.eventIds);
  const event = (await inMonitor(definition, () => listMonitorEvents())).events[0]!;
  assert.ok(event.estimate);
  assert.equal(event.presentation!.timePolicy, "predicted");
  assert.equal(event.presentation!.timeAuthor, "thsottiaux");
  const edited = await inMonitor(definition, () => updateMonitorEvent(event.id, { patch: { scopeLabel: "核实后的 Pro 范围" },
    version: new Date(event.updated_at).toISOString(), reason: "只核对适用范围" }, "test-admin"));
  assert.deepEqual(edited!.estimate, event.estimate, "editing scope must retain the complete prediction");
  const nextDay = (value: string) => new Date(Date.parse(value) + 24 * 3600_000).toISOString();
  const retimed = await inMonitor(definition, () => updateMonitorEvent(event.id, { patch: { schedule: {
    precision: "date", from: nextDay(edited!.schedule!.from), through: nextDay(edited!.schedule!.through),
  } }, version: new Date(edited!.updated_at).toISOString(), reason: "核对新的时间范围" }, "test-admin"));
  assert.ok(retimed!.estimate, "time edits must use the time-providing author, not the first post's author");
  assert.equal(retimed!.estimate.basis, "source_day");
  assert.equal(retimed!.presentation.timeAuthor, "thsottiaux");
});

test("post review retains a configured author's time strategy when rebuilding linked evidence", async () => {
  const text = "We will reset Codex usage for Pro.";
  await addPost("701", "thsottiaux", text);
  await inMonitor(definition, () => applyRecognition("701", recognition(text)));
  const detail = (await inMonitor(definition, () => monitorPostDetail("701")))!;
  const preview = (await inMonitor(definition, () => previewMonitorReview("701", { draft: detail.draft, version: detail.version })))!;
  await inMonitor(definition, () => submitMonitorReview("701", { draft: detail.draft, version: detail.version,
    previewToken: preview.previewToken, reason: "核对原帖时间依据" }, "test-admin"));
  const event = (await inMonitor(definition, () => listMonitorEvents())).events[0]!;
  assert.ok(event.estimate);
  assert.equal(event.presentation!.timePolicy, "predicted");
  assert.equal(event.presentation!.timeAuthor, "thsottiaux");
});
