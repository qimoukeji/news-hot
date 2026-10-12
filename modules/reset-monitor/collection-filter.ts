import type { ResetMonitorCollection } from "./definition.ts";

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordPattern = (words: readonly string[]) => new RegExp(`\\b(?:${words.map(escape).join("|") || "(?!)"})\\b`, "i");

/** Search is deliberately broader than local acceptance; every page still needs filtering. */
export function buildCollectionFilter(config?: ResetMonitorCollection) {
  if (!config || config.mode === "all") return undefined;
  const words = config.words ?? [], phrases = config.phrases ?? [], products = config.productWords ?? [];
  const benefits = config.benefitWords ?? [], chinese = config.chinese ?? [], self = config.selfPhrases ?? [];
  const productPattern = wordPattern(products), benefitPattern = wordPattern([...words, ...benefits]);
  const terms = [...words, ...benefits, ...chinese, ...phrases.map(phrase => `"${phrase}"`), ...self.map(phrase => `"${phrase}"`)];
  if (!terms.length) throw new Error("Reply collection filter requires relevance terms");
  const query = config.queryGroups?.query ?? ["-filter:replies", `filter:replies (${terms.join(" OR ")})`];
  if (!query.length || [...query, ...(config.queryGroups?.supplementalQueries ?? [])].some(value => !value.trim())) throw new Error("Invalid collection queries");
  return {
    configuration: config,
    signature: JSON.stringify({ mode: config.mode, words, phrases, productWords: products, benefitWords: benefits,
      chinese, selfPhrases: self, queryGroups: config.queryGroups ? { query: config.queryGroups.query,
        supplementalQueries: config.queryGroups.supplementalQueries ?? [], version: config.queryGroups.version } : null }),
    query,
    supplementalQueries: config.queryGroups?.supplementalQueries,
    version: config.queryGroups?.version ?? "relevant-replies-v1",
    reason: config.queryGroups?.reason ?? "All non-reply posts and configured quota/reset/reward-related replies",
    accepts({ text, isReply }: { text: string; isReply: boolean }) {
      const body = text.replace(/^(?:@\w+\s+)+/, "");
      const normalized = body.toLowerCase().replace(/\s+/g, " ");
      return !isReply || self.some(phrase => normalized.includes(phrase.toLowerCase()))
        || (!products.length || productPattern.test(body)) && (benefitPattern.test(body)
          || phrases.some(phrase => normalized.includes(phrase.toLowerCase())) || chinese.some(word => body.includes(word)));
    },
  };
}
