import type { ResetMonitorAuthor, ResetMonitorProductAlias } from "../definition.ts";
import type { Proposition } from "./recognize.ts";

export function productForAuthor(authors: readonly ResetMonitorAuthor[], author: string): string | null {
  return authors.find(item => item.handle.toLowerCase() === author.replace(/^@/, "").toLowerCase())?.defaultProduct ?? null;
}

export function productsConflict(a: Proposition["scope"], b: Proposition["scope"], aliases: readonly ResetMonitorProductAlias[] = []): boolean {
  const products = (source: string | null) => {
    let remaining = source ?? "";
    const found = new Set<string>();
    for (const alias of aliases) for (const pattern of alias.patterns) {
      const expression = new RegExp(pattern, "gi");
      if (expression.test(remaining)) {
        found.add(alias.key);
        remaining = remaining.replace(expression, " ");
      }
    }
    return found;
  };
  const x = products(a.productsZh), y = products(b.productsZh);
  return x.size > 0 && y.size > 0 && ![...x].some(product => y.has(product));
}

/** Scope labels may describe an audience; they are not automatically subscription plan names. */
export function plansFromScopeLabel(label: string | null, knownPlans: readonly string[] = []): string[] | null {
  if (!label?.trim()) return null;
  const values = label.split(/,\s*/).map(value => value.trim()).filter(Boolean);
  if (values.every(value => knownPlans.some(plan => plan.toLowerCase() === value.toLowerCase()))) return values;
  if (/\b(?:all|every|any|users?|accounts?|subscriptions?|subscribers?|affected|paid)\b|用户|用戶|使用者|订阅|訂閱|付费|付費/i.test(label)) return null;
  return values;
}

export function scopeConflicts(a: Proposition["scope"], b: Proposition["scope"], aliases: readonly ResetMonitorProductAlias[] = []): boolean {
  if (productsConflict(a, b, aliases)) return true;
  const plans = (scope: Proposition["scope"]) => scope.plans?.map(plan => plan.trim().toLowerCase()).filter(Boolean) ?? [];
  const first = plans(a), second = plans(b);
  return first.length > 0 && second.length > 0 && !first.some(plan => second.includes(plan));
}

/** Only the action clause identifies the resource; adjacent limit increases cannot supply a cycle. */
export function quotaScope(input: { audienceSource: string | null; productsZh: string | null }, evidence?: { excerpt: string; kind: string }): string | null {
  if (evidence?.kind === "bonus_credit") return null;
  const actionWords = evidence?.excerpt.split(/[\n.!?;]|\band\b(?=\s+(?:we|your)\b)/i)
    .filter(part => /\breset(?:s|ting)?\b|重置/i.test(part)).join(" ") ?? "";
  const text = evidence ? actionWords : `${input.audienceSource ?? ""} ${input.productsZh ?? ""}`;
  const fiveHour = /\b(?:5\s*[- ]?\s*h(?:ours?|rs?)?|five\s*[- ]?\s*hours?)\b|(?:5|五)\s*(?:小时|小時)/i.test(text);
  const weekly = /\b(?:weekly|week(?:ly)?[- ](?:usage|limits?|quota)|7[- ]days?)\b|周(?:额度|額度|限额|限額|用量)|每周|每週|(?:一|1|七|7)\s*(?:周|週|天)/i.test(text);
  return fiveHour && weekly ? "five_hour+weekly" : fiveHour ? "five_hour" : weekly ? "weekly" : null;
}
