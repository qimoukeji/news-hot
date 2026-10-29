import "../../../tests/standalone.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { backendDefinition as codex } from "../../codex-reset/backend-definition.ts";
import { projectPublicV2, properName, type PublicV2Input } from "../backend/public-v2.ts";
import { parsePublicV2Query, paginatePublicV2, PublicV2QueryError } from "../backend/public-v2-list.ts";
import { eventListSchema, overviewSchema, type ResetSnapshot, type ResetEvent } from "../public-v2.ts";

const now = Date.parse("2026-10-15T09:00:00Z");
function snapshot(): ResetSnapshot {
  const input: PublicV2Input = { events: [], posts: [], actions: [] };
  return projectPublicV2(input, codex, now);
}
function event(id: string, time: string): ResetEvent {
  return { id, type: "direct_reset", status: "completed", time, publishedAt: "2026-10-01T00:00:00Z",
    title: properName(id), summary: null, scope: { type: "all_users", note: properName("All users"), productCodes: [], planCodes: [], quotaWindowCodes: [] },
    updates: [{ id: `${id}-update`, action: "confirm", invalidatesEvent: false, publishedAt: "2026-10-01T00:00:00Z", time, title: properName("Reset completed"), summary: properName("Reset completed"),
      sources: [{ postId: "post-"+id, sourceId: "x-account:thsottiaux", url: `https://example.test/${id}` }] }] };
}
function query(params: Record<string, unknown> = {}, at = now) { return parsePublicV2Query(params, at); }

test("date and limit defaults treat missing, empty and whitespace inputs alike", () => {
  for (const params of [{}, { from: "", to: "", limit: "", timeZone: "" }, { from: " \t", to: "\n", limit: " ", timeZone: " " }]) {
    assert.deepEqual(query(params), { from: "2026-10-01", to: "2026-10-31", timeZone: "UTC", limit: null, cursor: null });
  }
  assert.deepEqual(query({ from: " 2026-02-15 " }), { from: "2026-02-15", to: "2026-02-28", timeZone: "UTC", limit: null, cursor: null });
  assert.deepEqual(query({ to: "2028-02-29", limit: " 100 " }), { from: "2028-02-01", to: "2028-02-29", timeZone: "UTC", limit: 100, cursor: null });
  assert.equal(query({}, Date.parse("2026-10-31T15:59:59Z")).from, "2026-10-01");
  assert.equal(query({}, Date.parse("2026-10-31T16:00:00Z")).from, "2026-10-01");
  assert.equal(query({}, Date.parse("2026-11-01T00:00:00Z")).from, "2026-11-01");
  assert.equal(query({}, Date.parse("2027-01-01T00:00:00Z")).to, "2027-01-31");
});

test("named time zones determine the default month and are normalized before cursor binding", () => {
  const at = Date.parse("2026-11-01T00:30:00Z");
  assert.equal(query({ timeZone: "America/Los_Angeles" }, at).from, "2026-10-01");
  assert.equal(query({ timeZone: "Asia/Shanghai" }, at).from, "2026-11-01");
  assert.equal(query({ timeZone: "Asia/Shanghai" }, Date.parse("2026-12-31T16:00:00Z")).to, "2027-01-31");
  assert.equal(query({ timeZone: " US/Pacific " }).timeZone, query({ timeZone: "America/Los_Angeles" }).timeZone);
  for (const timeZone of ["invalid/zone", "+08:00", "-07:00", ["UTC", "Asia/Shanghai"]]) {
    assert.throws(() => query({ timeZone }), PublicV2QueryError);
  }
});

test("date ranges allow six calendar months and reject invalid or reversed inputs", () => {
  assert.equal(query({ from: "2026-05-01", to: "2026-10-31" }).from, "2026-05-01");
  assert.equal(query({ from: "2026-11-30", to: "2027-04-01" }).to, "2027-04-01");
  for (const params of [
    { from: "2026-05-31", to: "2026-11-01" }, { from: "2026-10-15", to: "2026-10-14" },
    { from: "2026-02-29" }, { to: "2026-04-31" }, { from: "2026-2-01" }, { to: "2026-10-01T00:00:00Z" },
    { from: "2026-00-01" }, { from: "2026-13-01" }, { from: ["2026-10-01", "2026-10-02"] },
  ]) assert.throws(() => query(params), PublicV2QueryError, JSON.stringify(params));
});

test("limits, cursors and unknown parameters are strictly validated", () => {
  assert.equal(query({ limit: "1" }).limit, 1);
  for (const params of [
    { limit: "0" }, { limit: "101" }, { limit: "-1" }, { limit: "1.5" }, { limit: "1e1" }, { limit: "20px" },
    { cursor: "" }, { cursor: " " }, { cursor: "bad", limit: "1" }, { cursor: "bad" },
    { page: "1" }, { monitor_id: "claude" }, { limit: ["1", "2"] },
  ]) assert.throws(() => paginatePublicV2(snapshot(), query(params)), PublicV2QueryError, JSON.stringify(params));
});

test("filtering uses the requested local dates, literal dates and interval starts", () => {
  const data = snapshot();
  data.events = [
    event("late", "2026-10-15T16:00:00Z"), event("end", "2026-10-15T15:59:59Z"),
    event("date", "2026-10-15"), event("range", "2026-10-14T16:00:00Z/2026-10-20T16:00:00Z"),
    event("start", "2026-10-14T16:00:00+00:00"), event("early", "2026-10-14T15:59:59Z"),
  ];
  const before = structuredClone(data);
  const result = paginatePublicV2(data, query({ from: "2026-10-15", to: "2026-10-15", timeZone: "Asia/Shanghai" }));
  assert.deepEqual(result.list.map(item => item.id), ["end", "date", "range", "start"]);
  assert.deepEqual(result.pagination, { limit: null, total: 4, hasMore: false, nextCursor: null });
  assert.deepEqual(data, before);
  assert.equal(eventListSchema.safeParse(result).success, true);
  const empty = paginatePublicV2(data, query({ from: "2026-09-01", to: "2026-09-30" }));
  assert.deepEqual(empty, { list: [], pagination: { limit: null, total: 0, hasMore: false, nextCursor: null } });
  assert.deepEqual(paginatePublicV2(data, query({ from: "2026-10-15", to: "2026-10-15" })).list.map(item => item.id), ["late", "end", "date"]);
});

test("local days include their start and exclude the next midnight across both DST transitions", () => {
  for (const [day, start, end, repeated] of [
    ["2026-03-08", "2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z", ["2026-03-08T09:30:00Z", "2026-03-08T10:30:00Z"]],
    ["2026-11-01", "2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z", ["2026-11-01T01:30:00-07:00", "2026-11-01T01:30:00-08:00"]],
  ] as const) {
    const data = snapshot();
    data.events = [event("next", end), event("end", new Date(Date.parse(end) - 1).toISOString()),
      ...repeated.map((at, i) => event(`inside-${i}`, at)), event("start", start),
      event("before", new Date(Date.parse(start) - 1).toISOString()), event("date", day),
      event("range", `${start}/${end}`)];
    data.events.sort((a, b) => Date.parse(b.time.split("/")[0]!) - Date.parse(a.time.split("/")[0]!) || a.id.localeCompare(b.id));
    const result = paginatePublicV2(data, query({ from: day, to: day, timeZone: "America/Los_Angeles" }));
    assert.equal(result.pagination.total, 6);
    assert.deepEqual(new Set(result.list.map(item => item.id)), new Set(["end", "inside-0", "inside-1", "start", "date", "range"]));
  }
});

test("changing query zones changes date membership without moving literal dates or reordering events", () => {
  const data = snapshot();
  data.events = [event("later", "2026-10-16T00:00:00Z"), event("cross-day", "2026-10-15T23:30:00Z"), event("date", "2026-10-15")];
  const params = { from: "2026-10-15", to: "2026-10-15" };
  assert.deepEqual(paginatePublicV2(data, query(params)).list.map(item => item.id), ["cross-day", "date"]);
  assert.deepEqual(paginatePublicV2(data, query({ ...params, timeZone: "Asia/Shanghai" })).list.map(item => item.id), ["date"]);
  assert.deepEqual(paginatePublicV2(data, query({ ...params, timeZone: "America/Los_Angeles" })).list.map(item => item.id), ["later", "cross-day", "date"]);
});

test("cursor pages preserve every event and full updates, with deterministic time ties", () => {
  const data = snapshot();
  data.events = [event("a", "2026-10-15T00:00:00Z"), event("b", "2026-10-15T08:00:00+08:00"), event("c", "2026-10-14"), event("d", "2026-10-01")];
  data.events[0]!.updates.push({ ...data.events[0]!.updates[0]!, id: "second-update", action: "progress", invalidatesEvent: false, publishedAt: "2026-09-30T00:00:00Z" });
  const params = { from: "2026-10-01", to: "2026-10-31", limit: "1" };
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const page = paginatePublicV2(data, query(cursor ? { ...params, cursor } : params));
    assert.equal(page.pagination.total, 4); assert.equal(page.pagination.limit, 1);
    assert.equal(page.pagination.hasMore, page.pagination.nextCursor !== null);
    assert.equal(page.list.length, 1);
    if (page.list[0]!.id === "a") assert.equal(page.list[0]!.updates.length, 2);
    assert.equal(eventListSchema.safeParse(page).success, true);
    ids.push(page.list[0]!.id); cursor = page.pagination.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, ["a", "b", "c", "d"]);
  const all = paginatePublicV2(data, query(params));
  const firstCursor = all.pagination.nextCursor!;
  for (const changed of [{ ...params, limit: "2" }, { ...params, from: "2026-10-02" }, { ...params, to: "2026-10-30" }, { ...params, timeZone: "Asia/Shanghai" }]) {
    assert.throws(() => paginatePublicV2(data, query({ ...changed, cursor: firstCursor })), PublicV2QueryError);
  }
  assert.throws(() => paginatePublicV2({ ...data, platform: "grok" }, query({ ...params, cursor: firstCursor })), PublicV2QueryError);
  assert.throws(() => query({ from: params.from, to: params.to, cursor: firstCursor }), PublicV2QueryError);
  const pacific = paginatePublicV2(data, query({ ...params, timeZone: "US/Pacific" }));
  assert.doesNotThrow(() => paginatePublicV2(data, query({ ...params, timeZone: "America/Los_Angeles", cursor: pacific.pagination.nextCursor! })));
});

test("all projections use the same event shape without retired bonus details", () => {
  const data = snapshot();
  const bonus = {...event("bonus","2026-10-15"),type:"bonus_credit" as const};
  data.events = [bonus, { ...event("card", "2026-10-14"), type: "reset_credit" }, event("reset", "2026-10-13")];
  const before = structuredClone(data);
  for (const limit of [undefined, "1"]) {
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const result = paginatePublicV2(data, query({ from: "2026-10-01", to: "2026-10-31", ...(limit ? { limit } : {}), ...(cursor ? { cursor } : {}) }));
      for (const item of result.list) {
        assert.equal("bonusCredit" in item, false);
        const original = data.events.find(event => event.id === item.id)!;
        assert.deepEqual(item, original);
      }
      assert.equal(eventListSchema.safeParse({ ...result, list: result.list.map(item => ({ ...item, bonusCredit: null })) }).success, false);
      ids.push(...result.list.map(item => item.id));
      cursor = result.pagination.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, ["bonus", "card", "reset"]);
  }
  assert.deepEqual(data, before);
  const result = paginatePublicV2(data, query());
  assert.equal(eventListSchema.safeParse({ ...result, list: [{ ...result.list[0]!, status: "available" }] }).success, false);
});

test("response contracts reject old top-level metadata and invalid pagination", () => {
  const empty = { list: [], pagination: { limit: null, total: 0, hasMore: false, nextCursor: null } };
  assert.equal(eventListSchema.safeParse(empty).success, true);
  for (const invalid of [
    { ...empty, sources: [] }, { ...empty, events: [] }, { ...empty, platform: "codex" },
    { ...empty, pagination: { ...empty.pagination, total: -1 } },
    { ...empty, pagination: { ...empty.pagination, limit: 0 } },
    { ...empty, pagination: { ...empty.pagination, hasMore: true } },
  ]) assert.equal(eventListSchema.safeParse(invalid).success, false);
  const data = snapshot();
  const { events: _events, schemaVersion: _schema, generatedAt: _at, ...platform } = data;
  const overview = { schemaVersion: 2, generatedAt: data.generatedAt, platforms: [platform] };
  assert.equal(overviewSchema.safeParse(overview).success, true);
  assert.equal(overviewSchema.safeParse({ ...overview, platforms: [{ ...platform, events: [] }] }).success, false);
});
