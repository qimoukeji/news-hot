import type { ResetMonitorBackendDefinition } from "@aihot/reset-monitor/backend/context";

const words = ["quota", "quotas", "reset", "resets", "resetting"];
const phrases = ["rate limit", "usage limit", "message limit", "daily limit", "weekly limit", "usage cap", "reset card", "reset credits", "bonus credits", "extra credits", "free credits", "claim credits", "grok credits"];
const productWords = ["grok", "supergrok", "grokbot"];
const benefitWords = ["limit", "limits", "credit", "credits", "bonus", "reward", "rewards", "allowance", "unlimited", "compensation"];
const chinese = ["额度", "重置", "奖励", "补偿", "限额"];
const selfPhrases = ["my rate limit", "my usage limit", "my message limit", "my quota", "quota reset", "quotas reset", "limits reset", "limits have been reset", "limits are reset", "credits have been reset", "credits are reset"];
const anyWord = (values: string[]) => new RegExp(`\\b(?:${values.join("|")})\\b`, "i");
const products = anyWord(productWords);
const benefits = anyWord([...words, ...benefitWords]);

// Keep the paid v3 queries byte-for-byte: their saved cursors remain usable.
const legacyTerms = ["grok quota", "grok limits", "grok credits", "grok bot", "my quota", "my rate limit", "quota reset", "limits reset", "limits have been reset", "credits have been reset"]
  .map(value => `"${value}"`).concat(["supergrok", "grokbot"]);
const legacyGroup = `(${legacyTerms.join(" OR ")})`;
const benefitGroup = `(${[...words, ...benefitWords, ...chinese].join(" OR ")})`;

export const collectionFilter = {
  version: "grok-first-90-days-announcements-quota-replies-v3",
  reason: "User selected all non-reply posts and quota/reset/reward-related official replies for the first 90-day initialization",
  query: ["-filter:replies", `filter:replies ${legacyGroup} ${benefitGroup}`],
  // Search more broadly than the local rule. The two additions are disjoint
  // from the old reply query and each other; only local accepts decides relevance.
  supplementalQueries: [
    `filter:replies ${benefitGroup} -${legacyGroup}`,
    `filter:replies "usage cap" -${benefitGroup}`,
  ],
  accepts({ text, isReply }: { text: string; isReply: boolean }) {
    const body = text.replace(/^(?:@\w+\s+)+/, "");
    const normalized = body.toLowerCase().replace(/\s+/g, " ");
    return !isReply || selfPhrases.some(phrase => normalized.includes(phrase))
      || products.test(body) && (benefits.test(body)
        || phrases.some(phrase => normalized.includes(phrase)) || chinese.some(word => body.includes(word)));
  },
} satisfies NonNullable<ResetMonitorBackendDefinition["collectionFilter"]>;
