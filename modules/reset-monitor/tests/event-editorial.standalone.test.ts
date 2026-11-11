import { bt } from "./business-time-fixture.ts";
import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../../claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../../grok-reset/backend-definition.ts";
import { fixture, addAction, at } from "./action-fixture.ts";
import { projectPublicV2, projectRawV2, properName } from "../backend/public-v2.ts";
import { publicTimeSchema, normalizePublicTime } from "../public-v2.ts";
import { editorialVersion, editorialRecordVersion, officialEditorialInput } from "../backend/event-editorial.ts";
import { inferenceBoundary } from "../backend/confirmation.ts";
import { hasOperationalText } from "../public-text.ts";
import { openEvents } from "../backend/open-events.ts";
import { inMonitor } from "../backend/context.ts";

test("business times preserve intervals, years, fractional seconds and source-date zones", () => {
  for (const [raw, expected] of [
    ["2026-10-31T05:42:26Z/2026-11-02T05:42:26Z", "2026-10-31T05:42:26Z/2026-11-02T05:42:26Z"],
    ["2026-12-31T23:59:07.123456789Z", "2026-12-31T23:59:07.123456789Z"],
    ["2026-11-02T13:42:26+08:00", "2026-11-02T05:42:26Z"], ["2026-11-02", "2026-11-02"],
  ]) {
    assert.deepEqual(normalizePublicTime(bt(raw!)), bt(expected!));
    assert.equal(publicTimeSchema.safeParse(bt(expected!)).success, true);
    assert.equal(publicTimeSchema.safeParse(raw).success, false);
  }
  assert.deepEqual(normalizePublicTime({ kind: "date", date: "2026-11-02", timeZone: "America/Los_Angeles" }), { kind: "date", date: "2026-11-02", timeZone: "America/Los_Angeles" });
  assert.deepEqual(normalizePublicTime({ kind: "deadline", at: "2026-11-02T13:42:26+08:00" }), { kind: "deadline", at: "2026-11-02T05:42:26Z" });
  assert.equal(inferenceBoundary(bt("2026-11-02")), Date.parse("2026-11-02T18:00:00+08:00"));
});

for (const definition of [codex, claude, grok]) test(`${definition.monitorId}: overview is independent, becomes stale with facts and never feeds unsourced results to a model`, () => {
  const input = fixture(), row = input.events[0]!;
  row.title = properName("Whole event overview"); row.summary = properName("Scope and developments of this activity");
  const ready = () => { input.editorials = { [row.id]: { status: "ready", version: editorialVersion(row, input), recordVersion: editorialRecordVersion(row) } }; };
  ready();
  let event = projectPublicV2(input, definition).events[0]!;
  assert.equal(event.title.en, row.title.en); assert.notEqual(event.title.en, event.updates[0]!.title.en);
  const version = editorialVersion(row, input);
  row.summary = properName("Edited independent overview");
  assert.equal(editorialVersion(row, input), version, "overview cannot invalidate its own input");
  assert.equal(projectPublicV2(input, definition).events[0]!.summary, null, "record version also guards stale text");
  ready();
  addAction(input, "change", "progress", "2026-10-11T00:00:00Z");
  event = projectPublicV2(input, definition).events[0]!;
  assert.equal(event.status, "completed"); assert.equal(event.summary, null); assert.notEqual(event.title.en, row.title.en);
  input.actions.push({ ...input.actions[0]!, id: "unsourced", sources: [], sequence: 3, created_at: "2026-10-12T00:00:00Z" });
  assert.equal(officialEditorialInput(row, input)!.actions.length, 2);
  assert.equal(JSON.stringify(officialEditorialInput(row, input)).includes("unsourced"), false);
  assert.deepEqual(projectRawV2(input, definition).events[0]!.updates.find(update => update.id === "action-1")!.time, bt(at));
});

test("confirmation replaces a prior announcement overview; deleting it restores the announcement state", () => {
  const input = fixture(), row = input.events[0]!;
  input.actions[0]!.action = "announce"; row.title = properName("Initial announcement");
  input.editorials = { [row.id]: { status: "ready", version: editorialVersion(row, input), recordVersion: editorialRecordVersion(row) } };
  assert.equal(projectPublicV2(input, codex).events[0]!.title.en, "Initial announcement");
  addAction(input, "complete", "confirm", "2026-10-11T00:00:00Z");
  const complete = projectPublicV2(input, codex).events[0]!;
  assert.equal(complete.status, "completed"); assert.equal(complete.summary, null); assert.notEqual(complete.title.en, "Initial announcement");
  input.actions.pop();
  assert.equal(projectPublicV2(input, codex).events[0]!.status, "announced");
});

test("operational phrases are excluded in every language without banning legitimate AI terms", () => {
  assert.equal(hasOperationalText(properName("人工智能产品发布")), false);
  for (const phrase of ["人工核实已生效", "人工補錄", "验证逻辑", "Manually verified", "手動確認", "수동 확인", "verificación manual"]) {
    const input = fixture(); input.actions[0]!.title = properName(phrase);
    const event = projectPublicV2(input, codex).events[0]!;
    assert.equal(hasOperationalText(event.updates[0]!.title), false); assert.deepEqual(event.updates[0]!.summary, input.actions[0]!.summary);
  }
});

test("recognition context never reads a generated public overview as source evidence", async () => {
  const input = fixture(); input.events[0]!.title = properName("Public result without source evidence");
  input.events[0]!.summary = properName("Public presentation must not become official evidence");
  const events = await inMonitor(codex, () => openEvents(new Date("2026-10-10T11:00:00Z"), [], input));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.title, input.actions[0]!.title.en);
  assert.equal(events[0]!.summary, input.actions[0]!.summary!.en);
  assert.doesNotMatch(JSON.stringify(events), /Public result|Public presentation/);
});

test("each public field rejects operational wording even when every other field and language is safe", () => {
  const phrases = [
    ["zh", "管理员已核实生效，无官方帖子"], ["zh", "人工验证已生效"], ["zh", "经人工校验，额度已重置"],
    ["zh-Hant", "管理員已核實生效"], ["en", "Manually checked; quota restored"], ["en", "Manually validated"],
    ["ja", "管理者が確認済み"], ["ko", "관리자가 확인 완료"], ["ru", "Проверено вручную"], ["es", "Revisado manualmente"],
  ] as const;
  for (const [language, phrase] of phrases) for (const field of ["actionTitle", "actionSummary", "eventTitle", "eventSummary", "scope"] as const) {
    const input = fixture(), row = input.events[0]!, action = input.actions[0]!;
    row.title = properName("Whole quota activity"); row.summary = properName("Quota activity details");
    action.title = properName("Quota restored"); action.summary = properName("Quota is available");
    const text = { ...properName("Quota activity details"), [language]: phrase };
    if (field === "actionTitle") action.title = text;
    if (field === "actionSummary") action.summary = text;
    if (field === "eventTitle") row.title = text;
    if (field === "eventSummary") row.summary = text;
    if (field === "scope") row.scope = { type: "all_users", note: text };
    input.editorials = { [row.id]: { status: "ready", version: editorialVersion(row, input), recordVersion: editorialRecordVersion(row) } };
    const event = projectPublicV2(input, codex).events[0]!;
    assert.equal(JSON.stringify(event).includes(phrase), false, `${language}/${field}: ${phrase}`);
    if (field === "actionTitle") assert.deepEqual(event.updates[0]!.summary, action.summary);
    if (field === "actionSummary") { assert.equal(event.updates[0]!.summary, null); assert.deepEqual(event.updates[0]!.title, action.title); }
    if (field === "eventTitle") assert.deepEqual(event.summary, row.summary);
    if (field === "eventSummary") { assert.equal(event.summary, null); assert.deepEqual(event.title, row.title); }
    if (field === "scope") assert.equal(event.scope.note, null);
  }
  for (const phrase of [
    "人工智能模型验证功能发布", "人工智慧產品更新", "企业管理员可查看额度", "Manual reset instructions",
    "仅限企业管理员确认资格后的用户领取奖励额度", "僅限企業管理員確認資格後的用戶領取獎勵額度",
    "团队管理员已确认资格的成员可领取奖励", "管理员确认身份后才能领取奖励", "管理员已核实领取资格的用户可领取",
    "Only users whose eligibility is confirmed by their enterprise administrator can claim bonus credits",
    "企業管理者が資格を確認したユーザーのみ受け取れます", "조직 관리자가 자격을 확인한 사용자만 받을 수 있습니다",
  ]) {
    const input = fixture(); input.actions[0]!.summary = properName(phrase);
    input.events[0]!.scope = { type: "selected_users", note: properName(phrase) };
    assert.equal(hasOperationalText(input.actions[0]!.summary), false);
    const event = projectPublicV2(input, codex).events[0]!;
    assert.deepEqual(event.updates[0]!.summary, input.actions[0]!.summary);
    assert.deepEqual(event.scope.note, input.events[0]!.scope!.note);
  }
});
