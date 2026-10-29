import { monitor } from "./context.ts";
import { quotedInPost } from "./evidence.ts";
import type { ActionRecognitionBody, Proposition } from "./recognize.ts";
import { languages, translated, type EditorialScope } from "../actions.ts";

type Claim = ActionRecognitionBody["actions"][number];
const unknownAudience = { en: "unknown All users", zh: "unknown 所有用户", "zh-Hant": "unknown 所有用戶", ja: "unknown すべてのユーザー", ko: "unknown 모든 사용자", ru: "unknown Все пользователи", es: "unknown Todos los usuarios" };
const unknownProducts = { en: "unknown All products", zh: "unknown 所有产品", "zh-Hant": "unknown 所有產品", ja: "unknown すべての製品", ko: "unknown 모든 제품", ru: "unknown Все продукты", es: "unknown Todos los productos" };

function catalogMatch(value: string, entries: Array<{ code: string; name: Record<string, string | undefined> }>) {
  let remaining = value.normalize("NFKC").toLowerCase();
  const result = new Set<string>();
  const names = entries.flatMap(entry => [...new Set([entry.code, ...Object.values(entry.name)].filter((name): name is string => !!name))]
    .map(name => ({ code: entry.code, name: name.normalize("NFKC").toLowerCase() }))).sort((a, b) => b.name.length - a.name.length);
  for (const entry of names) {
    const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    remaining = remaining.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "gu"), (_match, prefix: string) => {
      result.add(entry.code); return `${prefix} `;
    });
  }
  return { codes: [...result].sort(), complete: !remaining.replace(/\b(?:and|or|users?|products?|all|the)\b|以及|用户|用戶|产品|產品|所有|和|及|与|與|或|[\s\p{P}\p{S}]/gu, "") };
}

/** Missing catalog coverage widens matching only, never claims that every account is eligible. */
export function recognizedScope(claim: Claim, source: string, author: string, inherited?: EditorialScope | null): { scope: Claim["scope"]; issue: string | null } {
  const scope = structuredClone(claim.scope), raw = claim.rawScope, catalog = monitor().publicV2?.catalog;
  const issue = (reason: string) => ({ scope, issue: reason });
  if (!catalog) return { scope, issue: null };
  if ([scope.productCodes, scope.planCodes, scope.quotaWindowCodes].some(codes => new Set(codes).size !== codes.length)) return issue("影响范围含重复的目录代码");
  if (raw.audienceSource && !quotedInPost(raw.audienceSource, source)) return issue("范围不在本帖中");
  const audience = [raw.audienceSource, raw.audienceZh].filter(Boolean).join(" ");
  const selected = /\b(?:selected|some|eligible|qualifying|affected)\b|部分|特定|符合|受影响|受影響/i.test(audience);
  const paid = /\bpaid\b|付费|付費/i.test(audience);
  const all = /\b(?:all|every|everyone|any)\b|所有|全部|全体|全體/i.test(audience);
  if (selected && raw.audienceZh && ![scope.note?.zh, claim.summary?.zh].some(value => value?.includes(raw.audienceZh!))) return issue("特定用户条件未保留在摘要中");
  const expected = selected ? "selected_users" : paid ? "paid_users" : all ? "all_users" : audience ? "selected_users" : "unknown";
  if (audience && scope.type !== "unknown" && scope.type !== expected) return issue("公开范围与原帖明确限制不一致");
  if (audience && inherited && inherited.type !== "unknown" && expected !== inherited.type && claim.action !== "amend") return issue("影响范围变化须有明确修订动作");
  scope.type = audience ? expected : inherited?.type ?? "unknown";
  if (scope.type === "selected_users" && !translated(scope.note)) return issue("特定用户缺少完整范围说明");
  const plans = (raw.plans ?? []).map(plan => ({ plan, entry: catalog.plans.find(entry => [entry.code, ...Object.values(entry.name)].some(name => name?.toLowerCase() === plan.toLowerCase())) }));
  if (plans.some(({ plan }) => !quotedInPost(plan, source))) return issue("套餐不在本帖中");
  scope.planCodes = plans.length ? [...new Set(plans.flatMap(({ entry }) => entry ? [entry.code] : []))] : inherited?.planCodes ?? [];
  if (plans.length && plans.some(({ entry }) => !entry)) scope.type = "unknown";
  const products = raw.productsZh ?? (inherited ? null : monitor().defaultProductForAuthor?.(author)) ?? "";
  const matched = catalogMatch(products, catalog.products);
  let unknownProduct = products ? !matched.complete || !matched.codes.length : !inherited?.productCodes.length;
  // A partial product list cannot express its unmapped remainder; do not imply it is exhaustive.
  scope.productCodes = products ? unknownProduct ? [] : matched.codes : inherited?.productCodes ?? [];
  if (inherited && claim.action !== "amend") {
    if (unknownProduct && inherited.productCodes.length) { scope.productCodes = [...inherited.productCodes]; unknownProduct = false; }
    if (scope.productCodes.length && inherited.productCodes.length && JSON.stringify([...scope.productCodes].sort()) !== JSON.stringify([...inherited.productCodes].sort())) return issue("产品范围变化须有明确修订动作");
    if (scope.planCodes.length && inherited.planCodes.length && JSON.stringify([...scope.planCodes].sort()) !== JSON.stringify([...inherited.planCodes].sort())) return issue("套餐范围变化须有明确修订动作");
  }
  const evidence = claim.scopeExcerpt ?? claim.excerpt;
  const proposition: Proposition = { kind: claim.kind, kindExplicit: claim.kindExplicit, action: claim.action, real: claim.real, role: claim.role,
    eventId: claim.eventId, excerpt: evidence, timeExcerpt: claim.timeExcerpt, scope: raw };
  const declared = monitor().quotaScope?.(raw, proposition) ?? monitor().quotaScope?.(raw, { ...proposition, excerpt: claim.excerpt });
  const codes = declared ? declared.split("+").map(value => value.replaceAll("_", "-")) : [];
  const cycleEvidence = `${evidence}\n${claim.excerpt}`;
  if (/\bmonthly\b|月(?:额度|額度|限额|限額|用量)/i.test(cycleEvidence)) codes.push("monthly");
  const supported = new Set(catalog.quotaWindows.map(entry => entry.code));
  const unknownCycle = /\bhourly\b/i.test(cycleEvidence) && !supported.has("hourly");
  if (scope.quotaWindowCodes.some(code => supported.has(code) && !codes.includes(code)) && !unknownCycle && !(inherited && !claim.scopeExcerpt)) return issue("公开范围与原帖明确限制不一致");
  scope.quotaWindowCodes = claim.scopeExcerpt || !inherited ? [...new Set(codes)].filter(code => supported.has(code)) : [...inherited.quotaWindowCodes];
  let note = !audience && translated(inherited?.note) ? inherited.note : scope.note;
  if (scope.type === "unknown") note = unknownAudience;
  if (unknownProduct) note = Object.fromEntries(languages.map(language => [language, note?.[language]?.includes(unknownProducts[language]) ? note[language] : note?.[language] ? `${note[language]} · ${unknownProducts[language]}` : unknownProducts[language]])) as NonNullable<Claim["scope"]["note"]>;
  scope.note = note;
  return { scope, issue: null };
}

/** Catalog gaps must not erase the original product/plan/eligibility restrictions. */
export function scopeSummary(claim: Claim): Claim["summary"] {
  const raw = claim.rawScope;
  const evidence = `${claim.scopeExcerpt ?? ""}\n${claim.excerpt}`;
  const quota = /\bhourly\b/i.test(evidence) ? "hourly" : null;
  const details = [raw.audienceZh, raw.productsZh, ...(raw.plans ?? []), quota].filter((value): value is string => !!value?.trim());
  if (!details.length) return claim.summary;
  const labels = { en: "Scope", zh: "影响范围", "zh-Hant": "影響範圍", ja: "対象範囲", ko: "적용 범위", ru: "Область действия", es: "Ámbito" };
  return Object.fromEntries(languages.map(language => {
    const summary = claim.summary?.[language] ?? "";
    const missing = details.filter(value => !summary.toLowerCase().includes(value.toLowerCase()));
    return [language, missing.length ? `${summary}${summary ? " " : ""}${labels[language]}: ${missing.join(" · ")}` : summary];
  })) as NonNullable<Claim["summary"]>;
}
