import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionFilter } from "../initial-filter.ts";

// Simulated X query matching only; these fixtures do not validate the live provider.
function searchMatches(query: string, text: string, isReply = true) {
  if (query === "-filter:replies") return !isReply;
  if (!isReply) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const tokenMatches = (token: string) => token.startsWith('"')
    ? normalized.includes(token.slice(1, -1).toLowerCase())
    : /^[a-z]+$/i.test(token) ? new RegExp(`\\b${token}\\b`, "i").test(text) : text.includes(token);
  let matched = true;
  const remainder = query.replace(/(-?)\(([^()]+)\)/g, (_group, excluded: string, terms: string) => {
    const groupMatches = terms.split(" OR ").some(tokenMatches);
    matched &&= excluded ? !groupMatches : groupMatches;
    return "";
  }).replace("filter:replies", "").trim();
  if (remainder) matched &&= tokenMatches(remainder);
  return matched;
}

const oldReplyQuery = 'filter:replies ("grok quota" OR "grok limits" OR "grok credits" OR "grok bot" OR "my quota" OR "my rate limit" OR "quota reset" OR "limits reset" OR "limits have been reset" OR "credits have been reset" OR supergrok OR grokbot) (quota OR quotas OR reset OR resets OR resetting OR limit OR limits OR credit OR credits OR bonus OR reward OR rewards OR allowance OR unlimited OR compensation OR 额度 OR 重置 OR 奖励 OR 补偿 OR 限额)';
const queries = [...collectionFilter.query, ...collectionFilter.supplementalQueries];

test("existing v3 paid query cursors remain compatible and every query fits the provider limit", () => {
  assert.equal(collectionFilter.version, "grok-first-90-days-announcements-quota-replies-v3");
  assert.deepEqual(collectionFilter.query, ["-filter:replies", oldReplyQuery]);
  for (const author of ["bot", "grok"]) for (const query of queries) {
    assert.ok(`from:${author} ${query} since_time:1783850721 until_time:1791648321`.length <= 512);
  }
});

test("supplements find accepted replies omitted by the original phrase restriction", () => {
  const missed = [
    "Limits are reset for Grok", "Credits are reset for Grok", "Grok rewards are available",
    "Grok bonus is ready", "Grok compensation announced", "Grok daily allowance refreshed",
    "Grok unlimited access", "Grok 额度已经重置", "Grok 奖励可以领取", "Grok 限额恢复了",
    "My usage limit changed", "My message limit reset", "Quotas reset tonight",
    "Credits are reset", "Grok usage cap has changed", "@reader GROK   USAGE CAP changed",
    "Grok bot usage cap changed", "SuperGrok usage cap changed",
  ];
  for (const text of missed) {
    assert.ok(collectionFilter.accepts({ text, isReply: true }), text);
    assert.equal(searchMatches(oldReplyQuery, text), false, text);
    assert.equal(collectionFilter.supplementalQueries.filter(query => searchMatches(query, text)).length, 1, text);
  }
});

test("all accepted vocabulary examples are covered once without changing local relevance", () => {
  const benefits = ["quota", "quotas", "reset", "resets", "resetting", "limit", "limits", "credit", "credits", "bonus", "reward", "rewards", "allowance", "unlimited", "compensation", "额度", "重置", "奖励", "补偿", "限额", "usage cap"];
  for (const product of ["Grok", "supergrok", "GROKBOT"]) for (const benefit of benefits) {
    const text = `@reader ${product}: ${benefit} update`;
    assert.ok(collectionFilter.accepts({ text, isReply: true }), text);
    assert.equal(queries.filter(query => searchMatches(query, text)).length, 1, text);
  }
  for (const text of ["my rate limit", "my usage limit", "my message limit", "my quota", "quota reset", "quotas reset", "limits reset", "limits have been reset", "limits are reset", "credits have been reset", "credits are reset", "Grok bot limits reset plus usage cap"]) {
    assert.ok(collectionFilter.accepts({ text, isReply: true }), text);
    assert.equal(queries.filter(query => searchMatches(query, text)).length, 1, text);
  }
  for (const text of ["Grok is funny", "Another service rewards its users", "@grok unlimited cats", "My credit score improved"]) {
    assert.equal(collectionFilter.accepts({ text, isReply: true }), false, text);
  }
  assert.equal(collectionFilter.accepts({ text: "A product announcement without quota words", isReply: false }), true);
  assert.equal(queries.filter(query => searchMatches(query, "A product announcement", false)).length, 1);
});
