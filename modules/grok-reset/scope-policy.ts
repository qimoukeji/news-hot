import type { Proposition } from "@aihot/reset-monitor/backend/recognize";

export function defaultProductForAuthor(author: string): string | null {
  const handle = author.replace(/^@/, "").toLowerCase();
  return handle === "bot" ? "Grok Bot" : handle === "grok" ? "Grok 普通额度" : null;
}

function products(source: string): Set<string> {
  const value = source.toLowerCase();
  const found = new Set<string>();
  if (/\bgrok\s*bot\b/.test(value)) found.add("bot");
  if (/\b(?:grok\s*)?imagine\b/.test(value)) found.add("imagine");
  const rest = value.replace(/\bgrok\s*bot\b|\bgrok\s*imagine\b/g, "");
  if (/\bgrok\b/.test(rest)) found.add("grok");
  return found;
}

export function scopeConflicts(a: Proposition["scope"], b: Proposition["scope"]): boolean {
  const x = products(a.productsZh ?? ""), y = products(b.productsZh ?? "");
  if (x.size && y.size && ![...x].some((p) => y.has(p))) return true;
  const plans = (scope: Proposition["scope"]) => scope.plans?.map((p) => p.trim().toLowerCase()).filter(Boolean) ?? [];
  const first = plans(a), second = plans(b);
  return first.length > 0 && second.length > 0 && !first.some((p) => second.includes(p));
}
