import type { ResetEvent, PublicV2Config } from "../public-v2.ts";
import type { PublicV2EventRow } from "./public-v2.ts";
import { plansFromScopeLabel } from "./scope-policy.ts";

type Catalog = PublicV2Config["catalog"]["products"];
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/_/g, "-");

/** Match longer catalog names first so Pro 5x and Grok Bot do not also select Pro and Grok. */
function catalogCodes(value: string, catalog: Catalog): string[] {
  let remaining = normalized(value);
  const codes = new Set<string>();
  const names = catalog.flatMap(entry => [...new Set([entry.code, ...Object.values(entry.name)].filter((name): name is string => !!name))]
    .map(name => ({ code: entry.code, name: normalized(name) }))).sort((a, b) => b.name.length - a.name.length);
  for (const { code, name } of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "gu");
    remaining = remaining.replace(expression, (_match, prefix: string) => { codes.add(code); return `${prefix} `; });
  }
  return [...codes].sort();
}

/** Accepted event restrictions constrain supplements; a model cannot widen them. */
export function validateAcceptedScope(scope: ResetEvent["scope"], row: PublicV2EventRow, catalog: PublicV2Config["catalog"]) {
  const presentation = row.presentation;
  const audience = text(presentation?.audienceZh);
  const labels = [text(row.scope), text(presentation?.scopeLabel), audience].filter(Boolean).join("; ");
  const selected = /\b(?:selected|some|eligible|qualifying|affected)\b|部分|特定|符合|受影响|受影響/i.test(labels);
  const paid = /\bpaid\b|付费|付費/i.test(labels);
  const all = /\b(?:all|every|everyone|any)\b|所有|全部|全体|全體/i.test(labels);
  const unspecified = /^(?:unknown|未说明|未說明)$/i.test(audience);
  const type = selected ? "selected_users" : paid ? "paid_users" : all ? "all_users"
    : audience && !unspecified ? "selected_users" : null;
  if (type && scope.type !== type) throw new Error("Supplement contradicts the accepted user scope");
  if (type === "selected_users" && audience && !text(scope.note?.zh).includes(audience)) {
    throw new Error("Supplement omits the accepted user conditions");
  }
  const restrictions = [
    { field: "planCodes", value: [text(row.scope), text(presentation?.scopeLabel)].join("; "), catalog: catalog.plans, required: false },
    { field: "productCodes", value: text(presentation?.productsZh), catalog: catalog.products, required: true },
    { field: "quotaWindowCodes", value: text(presentation?.quotaScope), catalog: catalog.quotaWindows, required: true },
  ] as const;
  for (const label of [text(row.scope), text(presentation?.scopeLabel)]) {
    const plans = plansFromScopeLabel(label.replace(/[、，；;]/g, ", "), catalog.plans.map(plan => plan.name.en));
    if (plans?.some(plan => !catalogCodes(plan, catalog.plans).length)) {
      throw new Error("Accepted plan restriction cannot be mapped to the public catalog");
    }
  }
  for (const restriction of restrictions) {
    if (!restriction.value.trim()) continue;
    const expected = catalogCodes(restriction.value, restriction.catalog);
    if (restriction.required && !expected.length) throw new Error(`Accepted ${restriction.field} cannot be mapped to the public catalog`);
    if (expected.length && JSON.stringify([...scope[restriction.field]].sort()) !== JSON.stringify(expected)) {
      throw new Error(`Supplement contradicts the accepted ${restriction.field}`);
    }
  }
}
