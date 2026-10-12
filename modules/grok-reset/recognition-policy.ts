import type { Proposition } from "@aihot/reset-monitor/backend/recognize";

export function excludeProposition(p: Proposition): string | null {
  if (/\bapi\s+(?:credits?|tokens?|bonus|reward)|\b(?:credits?|bonus|reward)\s+(?:for\s+the\s+)?api\b/i.test(p.excerpt)) return "API 赠金不属于 Grok 产品额度事件";
  if (/\b(?:automatically|every\s+(?:day|week|month|\d+\s+hours?))\b/i.test(p.excerpt)
    && !/\b(?:one[ -]time|compensation|compensate|this time)\b/i.test(p.excerpt)) return "日常自动重置规则不生成事件";
  if (/\b(?:increas(?:e[ds]?|ing)|doubl(?:e[ds]?|ing)|rais(?:e[ds]?|ing))\b[^.]*\b(?:limits?|caps?)\b/i.test(p.excerpt)
    && !/\breset|\b(?:one[ -]time|bonus|reward|promotional)\s+(?:usage\s+)?credits?\b/i.test(p.excerpt)) return "普通额度提升不生成事件";
  return null;
}
