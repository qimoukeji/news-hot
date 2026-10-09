import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import module from "../server.ts";
import { applyRecognition } from "../backend/assemble.ts";
import { recognizePost, type Proposition, type Recognition } from "../backend/recognize.ts";
import { estimateFor, manualSchedule, scheduleFrom } from "../backend/time.ts";
import { chatJson } from "@aihot/backend/providers/llm";
import { z } from "zod";
import { stub } from "../../../tests/setup.ts";

installModules([module]);
after(closeDb);
beforeEach(async () => {
  await sql`DELETE FROM monitor_event_posts`;
  await sql`DELETE FROM monitor_events`;
  await sql`DELETE FROM monitor_posts`;
});
let sequence = 0;
async function post(text: string, at = "2026-07-12T21:00:00Z") {
  const id = `identification-${++sequence}`;
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url) VALUES (${id}, 'thsottiaux', ${new Date(at)}, ${text}, ${`https://x.com/i/status/${id}`})`;
  return id;
}
function proposition(p: Partial<Proposition> = {}): Proposition {
  return { kind: "reset_credit", kindExplicit: true, action: "confirm", real: true, count: 1, relatesTo: null,
    excerpt: "Added a banked reset to 500k users.", excerptZh: "给 50 万用户补发重置卡。", statedTime: null,
    timeInferred: false, expectedLanding: null, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null }, ...p };
}
function recognition(...propositions: Proposition[]): Recognition {
  return { relevant: true, translationZh: null, contextZh: [], outage: null, needsReview: false, propositions, model: "offline", promptVersion: "test", receiptId: 0 };
}
const compensation = "Added a banked reset to 500k users. Instead granted a banked reset to everyone who pressed the reset button in that 2 hour window.";
const explanation = () => proposition({ excerpt: "Instead granted a banked reset to everyone who pressed the reset button in that 2 hour window." });

test("an explicitly repeated compensation fact creates one card, while an independent promise remains", async () => {
  const text = compensation + " Tomorrow we will grant a banked reset to all users.";
  const id = await post(text);
  const applied = await applyRecognition(id, recognition(proposition({ scope: { audienceSource: "500k users", audienceZh: null, productsZh: null, plans: null } }),
    { ...explanation(), duplicateOf: 0, scope: { audienceSource: "everyone who pressed the reset button in that 2 hour window", audienceZh: null, productsZh: null, plans: null } },
    proposition({ action: "announce", excerpt: "Tomorrow we will grant a banked reset to all users." })));
  assert.equal(applied.eventIds.length, 2);
  assert.deepEqual((await sql`SELECT status FROM monitor_events ORDER BY status`).map((r) => r.status), ["announced", "confirmed"]);
  const [event] = await sql`SELECT presentation FROM monitor_events WHERE status='confirmed'`;
  assert.match(event!.presentation.scopeLabel, /500k.*2 hour/);
});

test("an explicit compensation explanation is merged with its quantity and condition", async () => {
  const id = await post(compensation);
  const applied = await applyRecognition(id, recognition(proposition({ scope: { audienceSource: "500k users", audienceZh: "50 万用户", plans: null, productsZh: null } }),
    { ...explanation(), scope: { audienceSource: "everyone who pressed the reset button in that 2 hour window", audienceZh: "那两小时按过按钮的用户", plans: null, productsZh: null } }));
  assert.equal(applied.eventIds.length, 1);
  const [saved] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
  assert.equal(saved!.recognition.needsReview, false);
  assert.equal(saved!.recognition.propositions[1].duplicateOf, 0);
  const [event] = await sql`SELECT presentation FROM monitor_events`;
  assert.match(event!.presentation.scopeLabel, /500k.*2 hour/);
});

test("a second confirmation without explicit repetition evidence is held", async () => {
  const other = { ...explanation(), excerpt: "Granted a banked reset to everyone who pressed the button." };
  const id = await post("Added a banked reset to 500k users. " + other.excerpt);
  assert.equal((await applyRecognition(id, recognition(proposition(), other))).eventIds.length, 1);
  const [saved] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
  assert.equal(saved!.recognition.needsReview, true);
});

test("another one inherits a reset earlier in the same post but not an invented quote", async () => {
  const first = proposition({ kind: "direct_reset", excerpt: "We have reset usage limits." });
  const next = proposition({ kind: "direct_reset", action: "announce", excerpt: "And another one will come later in the day." });
  const id = await post(first.excerpt + " " + next.excerpt);
  assert.equal((await applyRecognition(id, recognition(first, next))).eventIds.length, 2);
  const invalid = await post(next.excerpt);
  assert.equal((await applyRecognition(invalid, recognition(first, next))).eventIds.length, 0);
});

test("an unmet condition cannot become an event even when the model marks it as action", async () => {
  for (const text of ["If this gets blocked, I owe you a reset.", "Each day we'll either ship an improvement or ship a full reset."]) {
    const id = await post(text);
    assert.equal((await applyRecognition(id, recognition(proposition({ action: "announce", role: "action", excerpt: text })))).eventIds.length, 0);
  }
});

test("invalid duplicate references are held and an explicit two-round statement still creates two events", async () => {
  const invalid = await post(compensation);
  assert.equal((await applyRecognition(invalid, recognition(proposition(), { ...explanation(), duplicateOf: 1 }))).eventIds.length, 1);
  const twice = await post("We reset Codex usage twice.");
  assert.equal((await applyRecognition(twice, recognition(proposition({ kind: "direct_reset", count: 2, excerpt: "We reset Codex usage twice." })))).eventIds.length, 2);
});

test("a progress post fills the reset form and products; a later missing scope cannot erase them", async () => {
  const first = await post("Reset coming.");
  const { eventIds: [eventId] } = await applyRecognition(first, recognition(proposition({ kind: "direct_reset", kindExplicit: false, action: "announce", excerpt: "Reset coming." })));
  const progress = await post("Full usage reset for Codex and ChatGPT Work is propagating.", "2026-07-12T22:00:00Z");
  const scope = { audienceSource: "all paid users", plans: null, audienceZh: "所有付费用户", productsZh: "Codex、ChatGPT Work" };
  await applyRecognition(progress, recognition(proposition({ kind: "direct_reset", action: "progress", relatesTo: eventId!, excerpt: "Full usage reset for Codex and ChatGPT Work is propagating.", scope })));
  const done = await post("All done.", "2026-07-12T23:00:00Z");
  await applyRecognition(done, recognition(proposition({ kind: "direct_reset", kindExplicit: false, relatesTo: eventId!, excerpt: "All done." })));
  const [event] = await sql`SELECT display_label,presentation,status FROM monitor_events WHERE id=${eventId!}`;
  assert.equal(event!.display_label, "额度重置");
  assert.equal(event!.presentation.kindExplicit, true);
  assert.equal(event!.presentation.productsZh, scope.productsZh);
  assert.equal(event!.presentation.scopeLabel, scope.audienceSource);
  assert.equal(event!.status, "confirmed");
});

test("a business-only propagation update does not narrow a global reset's scope", async () => {
  const first = await post("Reset for all paid users.");
  const broad = { audienceSource: "all paid users", plans: null, audienceZh: "所有付费用户", productsZh: "Codex" };
  const { eventIds: [eventId] } = await applyRecognition(first, recognition(proposition({ action: "announce", excerpt: "Reset for all paid users.", scope: broad })));
  const next = await post("Business accounts are still propagating.", "2026-07-12T22:00:00Z");
  await applyRecognition(next, recognition(proposition({ action: "progress", relatesTo: eventId!, excerpt: "Business accounts are still propagating.", scope: { ...broad, plans: ["Business"], audienceZh: "Business 用户" } })));
  const [e] = await sql`SELECT presentation,scope FROM monitor_events WHERE id=${eventId!}`;
  assert.equal(e!.presentation.scopeLabel, broad.audienceSource);
  assert.equal(e!.presentation.audienceZh, broad.audienceZh);
  assert.equal(e!.scope, "所有付费订阅");
});

test("a Business label containing all paid users cannot overwrite the promised global scope", async () => {
  const first = await post("Reset for all paid subscriptions.");
  const broad = { audienceSource: "all paid subscriptions", plans: null, audienceZh: "所有付费订阅", productsZh: "Codex" };
  const { eventIds: [eventId] } = await applyRecognition(first, recognition(proposition({ kind: "direct_reset", action: "announce", excerpt: "Reset for all paid subscriptions.", scope: broad })));
  const update = await post("It includes business accounts and is still propagating.", "2026-07-12T22:00:00Z");
  await applyRecognition(update, recognition(proposition({ kind: "direct_reset", action: "progress", relatesTo: eventId!, excerpt: "It includes business accounts and is still propagating.", scope: { ...broad, audienceSource: "business accounts (all paid users)", audienceZh: "商业账户（所有付费用户）" } })));
  const [e] = await sql`SELECT presentation,scope FROM monitor_events WHERE id=${eventId!}`;
  assert.equal(e!.presentation.scopeLabel, broad.audienceSource);
  assert.equal(e!.presentation.audienceZh, broad.audienceZh);
  assert.equal(e!.scope, "所有付费订阅");
  const correction = await post("This reset is for Plus and Pro only.", "2026-07-12T23:00:00Z");
  await applyRecognition(correction, recognition(proposition({ kind: "direct_reset", action: "amend", relatesTo: eventId!, excerpt: "This reset is for Plus and Pro only.", scope: { ...broad, plans: ["Plus", "Pro"], audienceZh: "Plus 与 Pro 用户" } })));
  const [amended] = await sql`SELECT presentation FROM monitor_events WHERE id=${eventId!}`;
  assert.equal(amended!.presentation.scopeLabel, "Plus, Pro");
});

test("definitions, hints and Maybe stay related without meaningless review", async () => {
  const id = await post("Just like any other reset, but picture me doing a little dance with it");
  await sql`UPDATE monitor_posts SET raw=${sql.json({context:[{id:"definition",author:"reader",relation:"reply",text:'What is a performative reset?',publishedAt:"2026-07-12T20:00:00Z"}]})} WHERE id=${id}`;
  const result = await applyRecognition(id, recognition(proposition({ kind: "direct_reset", action: "announce", excerpt: "Just like any other reset, but picture me doing a little dance with it" })));
  assert.equal(result.eventIds.length, 0);
  const [related] = await sql`SELECT activity,recognition FROM monitor_posts WHERE id=${id}`;
  assert.equal(related!.activity.kind, "related");
  assert.equal(related!.recognition.needsReview, false);
  const surprise = await post("I previously promised a reset. Little surprise for you tomorrow.");
  assert.equal((await applyRecognition(surprise, recognition(proposition({ kind: "direct_reset", action: "announce", excerpt: "Little surprise for you tomorrow." })))).eventIds.length, 0);
  const [held] = await sql`SELECT recognition FROM monitor_posts WHERE id=${surprise}`;
  assert.equal(held!.recognition.needsReview, false);
  const maybe = await post("Maybe");
  const uncertain = recognition(proposition({ action: "announce", role: "uncertain", excerpt: "Maybe" }));
  uncertain.needsReview = true;
  assert.equal((await applyRecognition(maybe, uncertain)).eventIds.length, 0);
  assert.equal((await sql`SELECT recognition FROM monitor_posts WHERE id=${maybe}`)[0]!.recognition.needsReview, false);
});

test("a global model review flag cannot block an independent valid proposition", async () => {
  const id = await post("Banked reset landed. We reset usage last week.");
  const rec = recognition(proposition({ excerpt: "Banked reset landed." }), proposition({ kind: "direct_reset", excerpt: "We reset usage last week." }));
  rec.needsReview = true;
  const applied = await applyRecognition(id, rec);
  assert.equal(applied.eventIds.length, 1);
  const [row] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
  assert.equal(row!.recognition.held.length, 1);
  assert.match(row!.recognition.held[0].reason, /关键上下文|确认对象/);
  assert.deepEqual(row!.recognition.modelResult, rec);
});

test("a named same-round confirmation after seven hours links without a duplicate notification", async () => {
  const first = await post("Banked reset landed.");
  const { eventIds: [eventId] } = await applyRecognition(first, recognition(proposition({ excerpt: "Banked reset landed." })));
  const next = await post("The banked reset has landed for everyone.", "2026-07-13T04:00:00Z");
  const applied = await applyRecognition(next, recognition(proposition({ excerpt: "The banked reset has landed for everyone.", relatesTo: eventId! })));
  assert.deepEqual(applied.eventIds, [eventId]);
  assert.deepEqual(applied.notify, []);
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 1);
  const another = await post("Another banked reset has landed.", "2026-07-13T05:00:00Z");
  assert.notDeepEqual((await applyRecognition(another, recognition(proposition({ excerpt: "Another banked reset has landed.", relatesTo: eventId! })))).eventIds, [eventId]);
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 2);
});

test("ordinal and reiterated confirmations keep their explicitly named round", async () => {
  const { eventIds: [first] } = await applyRecognition(await post("First banked reset tonight."), recognition(proposition({ action: "announce", excerpt: "First banked reset tonight." })));
  const { eventIds: [second] } = await applyRecognition(await post("Another banked reset tonight."), recognition(proposition({ action: "announce", excerpt: "Another banked reset tonight." })));
  const completion = "The second banked reset has landed.";
  const done = await post(completion, "2026-07-12T22:00:00Z");
  assert.deepEqual((await applyRecognition(done, recognition(proposition({ relatesTo: second!, excerpt: completion })))).eventIds, [second]);
  const repeat = "Again, the second banked reset has landed.";
  const reiterated = await post(repeat, "2026-07-12T23:00:00Z");
  assert.deepEqual(await applyRecognition(reiterated, recognition(proposition({ relatesTo: second!, excerpt: repeat }))), { eventIds: [second], notify: [] });
  const clarification = "Another one: the second banked reset has landed.";
  assert.deepEqual(await applyRecognition(await post(clarification, "2026-07-12T23:30:00Z"), recognition(proposition({ relatesTo: second!, excerpt: clarification }))), { eventIds: [second], notify: [] });
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 2);
  const [original] = await sql`SELECT status FROM monitor_events WHERE id=${first!}`;
  const [completed] = await sql`SELECT status FROM monitor_events WHERE id=${second!}`;
  assert.equal(original!.status, "announced");
  assert.equal(completed!.status, "confirmed");
  assert.equal((await sql`SELECT recognition FROM monitor_posts WHERE id=${reiterated}`)[0]!.recognition.needsReview, false);
});

test("an additional reset can complete its named open announcement while a new execution remains distinct", async () => {
  const excerpt = "Another banked reset tonight.";
  const { eventIds: [eventId] } = await applyRecognition(await post(excerpt), recognition(proposition({ action: "announce", excerpt })));
  const completion = "Another banked reset has landed.";
  assert.deepEqual((await applyRecognition(await post(completion, "2026-07-12T22:00:00Z"), recognition(proposition({ relatesTo: eventId!, excerpt: completion })))).eventIds, [eventId]);
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 1);
  const direct = "We reset Codex usage.";
  const { eventIds: [first] } = await applyRecognition(await post(direct, "2026-07-12T22:00:00Z"), recognition(proposition({ kind: "direct_reset", excerpt: direct })));
  const again = "We reset Codex usage again.";
  const next = await applyRecognition(await post(again, "2026-07-12T23:00:00Z"), recognition(proposition({ kind: "direct_reset", relatesTo: first!, excerpt: again })));
  assert.notDeepEqual(next.eventIds, [first]);
  assert.equal((await sql`SELECT id FROM monitor_events WHERE type='direct_reset'`).length, 2);
});

test("multiple confirmed rounds cannot silently collapse into one inferred open target", async () => {
  const { eventIds: [eventId] } = await applyRecognition(await post("A banked reset tonight."), recognition(proposition({ action: "announce", excerpt: "A banked reset tonight." })));
  const excerpt = "We granted two banked resets today.";
  const id = await post(excerpt, "2026-07-12T22:00:00Z");
  assert.deepEqual(await applyRecognition(id, recognition(proposition({ count: 2, excerpt }))), { eventIds: [], notify: [] });
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 1);
  assert.equal((await sql`SELECT status FROM monitor_events WHERE id=${eventId!}`)[0]!.status, "announced");
  const [saved] = await sql`SELECT recognition,processed_at FROM monitor_posts WHERE id=${id}`;
  assert.equal(saved!.recognition.needsReview, true);
  assert.equal(saved!.recognition.propositions[0].count, 2);
  assert.match(saved!.recognition.held[0].reason, /多轮.*其余轮次/);
  assert.ok(saved!.processed_at, "business review does not keep the paid recognition pending");
});

test("an explicit single target cannot consume multiple rounds beside other known rounds", async () => {
  const firstExcerpt = "First banked reset tonight.";
  const secondExcerpt = "Another banked reset tonight.";
  const { eventIds: [first] } = await applyRecognition(await post(firstExcerpt), recognition(proposition({ action: "announce", excerpt: firstExcerpt })));
  await applyRecognition(await post(secondExcerpt), recognition(proposition({ action: "announce", excerpt: secondExcerpt })));
  const excerpt = "We granted banked resets twice today.";
  const id = await post(excerpt, "2026-07-12T22:00:00Z");
  assert.deepEqual(await applyRecognition(id, recognition(proposition({ count: 2, relatesTo: first!, excerpt }))), { eventIds: [], notify: [] });
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 2);
  assert.equal((await sql`SELECT id FROM monitor_events WHERE status='confirmed'`).length, 0);
  const [saved] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
  assert.equal(saved!.recognition.needsReview, true);
  assert.match(saved!.recognition.held[0].reason, /多轮.*其余轮次/);
});

test("multiple completed rounds naming an already confirmed target remain available for review", async () => {
  const original = "The banked reset has landed.";
  const { eventIds: [eventId] } = await applyRecognition(await post(original), recognition(proposition({ excerpt: original })));
  const excerpt = "We granted banked resets twice today.";
  const id = await post(excerpt, "2026-07-12T22:00:00Z");
  assert.deepEqual(await applyRecognition(id, recognition(proposition({ count: 2, relatesTo: eventId!, excerpt }))), { eventIds: [], notify: [] });
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 1);
  assert.equal((await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`)[0]!.recognition.needsReview, true);
});

test("multiple-round progress, amendment and withdrawal without known targets wait for review", async () => {
  for (const [action, excerpt] of [
    ["progress", "Two banked resets are propagating."],
    ["amend", "Both of the two banked resets are for Business."],
    ["withdraw", "We cancelled both of the two banked resets."],
  ] as const) {
    const id = await post(excerpt);
    assert.deepEqual(await applyRecognition(id, recognition(proposition({ action, count: 2, excerpt }))), { eventIds: [], notify: [] });
    const [saved] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
    assert.equal(saved!.recognition.needsReview, true);
    assert.equal(saved!.recognition.propositions[0].count, 2);
    assert.match(saved!.recognition.held[0].reason, /多轮.*其余轮次/);
  }
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 0);
});

test("two individually identified rounds can both be confirmed by one post", async () => {
  const { eventIds: [first] } = await applyRecognition(await post("First banked reset tonight."), recognition(proposition({ action: "announce", excerpt: "First banked reset tonight." })));
  const { eventIds: [second] } = await applyRecognition(await post("Another banked reset tonight."), recognition(proposition({ action: "announce", excerpt: "Another banked reset tonight." })));
  const firstCompletion = "The first banked reset has landed.";
  const secondCompletion = "The second banked reset has landed.";
  const id = await post(`${firstCompletion} ${secondCompletion}`, "2026-07-12T22:00:00Z");
  const result = await applyRecognition(id, recognition(proposition({ relatesTo: first!, excerpt: firstCompletion }), proposition({ relatesTo: second!, excerpt: secondCompletion })));
  assert.deepEqual(result.eventIds, [first, second]);
  assert.equal(result.notify.filter((n) => n.action === "confirm").length, 2);
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 2);
  assert.equal((await sql`SELECT id FROM monitor_events WHERE status='confirmed'`).length, 2);
  assert.equal((await sql`SELECT event_id FROM monitor_event_posts WHERE post_id=${id}`).length, 2);
  assert.equal((await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`)[0]!.recognition.needsReview, false);
});

test("an explicit scope amendment corrects disjoint plans but a confirmation cannot", async () => {
  const first = await post("Banked reset for Plus.");
  const scope = { audienceSource: null, plans: ["Plus"], audienceZh: "Plus 用户", productsZh: null };
  const { eventIds: [eventId] } = await applyRecognition(first, recognition(proposition({ action: "announce", excerpt: "Banked reset for Plus.", scope })));
  const correction = await post("Correction: banked reset for Business only.", "2026-07-12T22:00:00Z");
  assert.deepEqual((await applyRecognition(correction, recognition(proposition({ action: "amend", excerpt: "Correction: banked reset for Business only.", relatesTo: eventId!, scope: { ...scope, plans: ["Business"], audienceZh: "Business 用户" } })))).eventIds, [eventId]);
  assert.equal((await sql`SELECT presentation FROM monitor_events WHERE id=${eventId!}`)[0]!.presentation.scopeLabel, "Business");
});

test("explicit card facts correct a provisional direct reset's durable type", async () => {
  const first = await post("Reset coming.");
  const { eventIds: [eventId] } = await applyRecognition(first, recognition(proposition({ kind: "direct_reset", kindExplicit: false, action: "announce", excerpt: "Reset coming." })));
  const card = await post("The banked reset has landed.", "2026-07-12T22:00:00Z");
  assert.deepEqual((await applyRecognition(card, recognition(proposition({ excerpt: "The banked reset has landed.", relatesTo: eventId! })))).eventIds, [eventId]);
  const [row] = await sql`SELECT type,label,display_label,presentation FROM monitor_events WHERE id=${eventId!}`;
  assert.equal(row!.type, "reset_credit");
  assert.equal(row!.label, "发重置卡");
  assert.equal(row!.display_label, "重置卡发放");
  assert.equal(row!.presentation.kindExplicit, true);
});

test("policy and explanation roles cannot publish events, even if real was incorrectly set", async () => {
  for (const role of ["policy", "explanation"] as const) {
    const text = role === "policy" ? "Each day we will either ship or reset." : "We reset from time to time.";
    const id = await post(text);
    assert.equal((await applyRecognition(id, recognition(proposition({ role, action: "announce", excerpt: text })))).eventIds.length, 0);
    const [row] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
    assert.equal(row!.recognition.needsReview, false);
  }
});

test("applied resets in an explanation can close only the known round quoted in that thread", async () => {
  const original = await post("Another reset will land tonight.");
  const { eventIds: [eventId] } = await applyRecognition(original, recognition(proposition({ kind: "direct_reset", action: "announce", excerpt: "Another reset will land tonight." })));
  const text = "We applied the resets automatically because of two reasons.";
  const context = [
    { id: "delivery", author: "reader", relation: "reply", text: "The second reset automatically applied.", publishedAt: "2026-07-12T21:30:00Z" },
    { id: original, author: "thsottiaux", relation: "quote", text: "Another reset will land tonight.", publishedAt: "2026-07-12T21:00:00Z" },
  ];
  const unrelated = await post(text, "2026-07-12T22:00:00Z");
  await sql`UPDATE monitor_posts SET raw=${sql.json({context:[context[0]]})} WHERE id=${unrelated}`;
  const p = proposition({ kind: "direct_reset", role: "explanation", excerpt: text });
  assert.equal((await applyRecognition(unrelated, recognition(p))).eventIds.length, 0);
  const confirmation = await post(text, "2026-07-12T22:01:00Z");
  await sql`UPDATE monitor_posts SET raw=${sql.json({context})} WHERE id=${confirmation}`;
  assert.deepEqual((await applyRecognition(confirmation, recognition(p))).eventIds, [eventId]);
  const [event] = await sql`SELECT status FROM monitor_events WHERE id=${eventId!}`;
  assert.equal(event!.status, "confirmed");
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 1);
});

test("a reply inherits tomorrow from its question's date and the same-day clock updates that event", async () => {
  const id = await post("Yes", "2026-08-30T19:19:46Z");
  const parent = { id: "reset-question", author: "reader", relation: "reply", text: "ANOTHER RESET TOMORROW?", publishedAt: "2026-08-30T06:30:00Z" };
  await sql`UPDATE monitor_posts SET raw=${sql.json({context:[parent]})} WHERE id=${id}`;
  const statedTime = { precision: "date" as const, dayOffset: 1, clock: null, clockThrough: null, period: null, relativeHours: null };
  const { eventIds: [eventId] } = await applyRecognition(id, recognition(proposition({ kind: "direct_reset", action: "announce", excerpt: "Yes", statedTime })));
  const [announced] = await sql`SELECT schedule FROM monitor_events WHERE id=${eventId!}`;
  assert.equal(announced!.schedule.from, "2026-08-30T07:00:00.000Z");
  const [stored] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
  assert.equal(stored!.recognition.propositions[0].timeSourceId, parent.id);
  const clock = await post("Your reset will land at 6pm PST.", "2026-08-30T19:24:37Z");
  await applyRecognition(clock, recognition(proposition({ kind: "direct_reset", action: "announce", relatesTo: eventId!, excerpt: "Your reset will land at 6pm PST.", statedTime: { ...statedTime, precision: "exact", dayOffset: null, clock: "18:00" } })));
  const [updated] = await sql`SELECT schedule,estimate FROM monitor_events WHERE id=${eventId!}`;
  assert.equal(updated!.schedule.precision, "exact");
  assert.equal(updated!.schedule.from, "2026-08-31T01:00:00.000Z");
  assert.equal(updated!.schedule.through, updated!.schedule.from);
  assert.equal(updated!.estimate.through, updated!.schedule.through);
  assert.equal((await sql`SELECT id FROM monitor_events`).length, 1);
});

test("unknown or undated time provenance waits for review instead of using the reply date", async () => {
  for (const sourceId of ["missing", "parent"]) {
    const id = await post("Yes");
    await sql`UPDATE monitor_posts SET raw=${sql.json({context:[{id:"parent",author:"reader",relation:"reply",text:"Reset tomorrow?",publishedAt:null}]})} WHERE id=${id}`;
    const result = await applyRecognition(id, recognition(proposition({ action: "announce", excerpt: "Yes", timeSourceId: sourceId, statedTime: { precision: "date", dayOffset: 1, clock: null, clockThrough: null, period: null, relativeHours: null } })));
    assert.equal(result.eventIds.length, 0);
    const [row] = await sql`SELECT recognition FROM monitor_posts WHERE id=${id}`;
    assert.equal(row!.recognition.needsReview, true);
  }
});

test("explicit clock schedules and manual corrections never become one-hour windows", () => {
  const schedule = scheduleFrom({ precision: "exact", date: "2026-08-30", from: "18:00", through: null });
  assert.equal(schedule.precision, "exact");
  assert.equal(schedule.through, schedule.from);
  const manual = manualSchedule("exact", new Date(schedule.from), new Date(Date.parse(schedule.from)+3600_000));
  assert.equal(manual.through, manual.from);
  assert.equal(manual.precision, "exact");
});

test("a confirmation with two compatible announcements waits for review without choosing the newest", async () => {
  for (const text of ["First reset tonight.", "Another reset tonight."]) {
    await applyRecognition(await post(text), recognition(proposition({ action: "announce", excerpt: text })));
  }
  const done = await post("Banked reset landed.", "2026-07-12T22:00:00Z");
  assert.equal((await applyRecognition(done, recognition(proposition({ excerpt: "Banked reset landed." })))).eventIds.length, 0);
  assert.deepEqual((await sql`SELECT status FROM monitor_events`).map((e) => e.status), ["announced", "announced"]);
  const [p] = await sql`SELECT recognition FROM monitor_posts WHERE id=${done}`;
  assert.equal(p!.recognition.needsReview, true);
});

test("an explicitly named target cannot join conflicting free and paid scopes", async () => {
  const first = await post("Banked reset for free users.");
  const { eventIds: [eventId] } = await applyRecognition(first, recognition(proposition({ action: "announce", excerpt: "Banked reset for free users.", scope: { audienceSource: "free users", plans: null, audienceZh: null, productsZh: null } })));
  const done = await post("Banked reset for paid users landed.", "2026-07-12T22:00:00Z");
  assert.equal((await applyRecognition(done, recognition(proposition({ relatesTo: eventId!, excerpt: "Banked reset for paid users landed.", scope: { audienceSource: "paid users", plans: null, audienceZh: null, productsZh: null } })))).eventIds.length, 0);
});

test("a model estimate beyond the deadline is rejected and source windows retain their endpoints", () => {
  const announcedAt = new Date("2026-07-12T18:00:00Z");
  const schedule = scheduleFrom({ precision: "deadline", date: "2026-07-12", from: "12:00", through: null });
  const estimate = estimateFor({ schedule, announcedAt, model: { earliestPacific: "2026-07-12 11:00", latestPacific: "2026-07-12 13:00", note: "within an hour" } });
  assert.equal(estimate.basis, "source");
  assert.equal(estimate.through, schedule.through);
  const window = scheduleFrom({ precision: "window", date: "2026-07-12", from: "12:00", through: "18:00" });
  assert.equal(estimateFor({ schedule: window, announcedAt }).through, window.through);
});

test("the monitor respects configured thinking and uses disabled thinking only as a fallback", async () => {
  let body: Record<string, unknown> = {};
  const model = await stub((_hit, req) => {
    body = JSON.parse(req.body);
    return { choices: [{ message: { content: JSON.stringify({ relevant: false, translationZh: null, contextZh: [], outage: null, needsReview: false, propositions: [] }) } }] };
  });
  try {
    Object.assign(process.env, { MONITOR_MODEL: "default", LLM_BASE_URL: model.url, LLM_API_KEY: "test-key", LLM_MODEL: "deepseek-flash", LLM_EXTRA_JSON: '{"thinking":{"type":"enabled"},"top_p":0.8}' });
    delete process.env.LLM_REASONING_TOKENS;
    await recognizePost({ id: "configuration", text: "Hello", publishedAt: "2026-07-12T21:00:00Z", context: [], openEvents: [] });
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.top_p, 0.8);
    assert.equal(body.max_tokens, 6000);
    process.env.LLM_REASONING_TOKENS = "4000";
    await recognizePost({ id: "configuration-thinking", text: "Hello", publishedAt: "2026-07-12T21:00:00Z", context: [], openEvents: [] });
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.max_tokens, 10000);
    delete process.env.LLM_REASONING_TOKENS;
    delete process.env.LLM_EXTRA_JSON;
    await recognizePost({ id: "configuration-default", text: "Hello", publishedAt: "2026-07-12T21:00:00Z", context: [], openEvents: [] });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.temperature, 0.1);
    assert.equal(body.max_tokens, 6000);
  } finally { await model.close(); }
});

test("per-call extra fields participate in receipt reuse", async () => {
  const model = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
  try {
    Object.assign(process.env, { LLM_BASE_URL: model.url, LLM_API_KEY: "test-key", LLM_MODEL: "stub", LLM_EXTRA_JSON: "{}", LLM_REASONING_TOKENS: "0" });
    const opts = { model: "default", purpose: "monitor.extra.test", subject: "extra-identity", promptVersion: "test", system: "", user: "hello", schema: z.object({ ok: z.boolean() }) };
    await chatJson({ ...opts, extra: { thinking: { type: "disabled" } } });
    await chatJson({ ...opts, extra: { thinking: { type: "disabled" } } });
    await chatJson({ ...opts, extra: { thinking: { type: "enabled" } } });
    assert.equal(model.hits(), 2);
  } finally { await model.close(); }
});
