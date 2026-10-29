import { languages, translated, type EditorialText, type EditorialScope } from "../actions.ts";

type Label = Record<(typeof languages)[number], string>;
const label = (values: string[]): Label => Object.fromEntries(languages.map((language, index) => [language, values[index]!])) as Label;

/** Fixed display labels never infer scope.type, catalog codes or eligibility conditions. */
const allUsers = label(["All users", "所有用户", "所有使用者", "すべてのユーザー", "모든 사용자", "Все пользователи", "Todos los usuarios"]);
const paidUsers = label(["Paid users", "付费用户", "付費使用者", "有料ユーザー", "유료 사용자", "Платные пользователи", "Usuarios de pago"]);
const unspecified = label(["Eligibility unspecified", "适用范围未明确", "適用範圍未明確", "対象範囲は未指定", "적용 대상 미지정", "Условия участия не указаны", "Elegibilidad no especificada"]);
const unknownUsers = label(["unknown All users", "unknown 所有用户", "unknown 所有用戶", "unknown すべてのユーザー", "unknown 모든 사용자", "unknown Все пользователи", "unknown Todos los usuarios"]);
const unknownProducts = label(["unknown All products", "unknown 所有产品", "unknown 所有產品", "unknown すべての製品", "unknown 모든 제품", "unknown Все продукты", "unknown Todos los productos"]);
const combined = (audience: Label): Label => Object.fromEntries(languages.map(language => [language, `${audience[language]} · ${unknownProducts[language]}`])) as Label;
const standardLabels = [allUsers, paidUsers, unspecified, unknownUsers, unknownProducts, ...[allUsers, paidUsers, unknownUsers].map(combined)];

export function defaultScopeLabel(type: EditorialScope["type"]): Label {
  return { ...(type === "unknown" ? unspecified : type === "paid_users" ? paidUsers : allUsers) };
}

/** Fill only missing languages when every supplied nonblank value matches one fixed label. */
export function completeStandardScopeLabel(value: EditorialText | null | undefined): Label | null {
  if (translated(value)) return { ...value };
  if (!value || !languages.some(language => value[language]?.trim())) return null;
  const standard = standardLabels.find(candidate => languages.every(language => !value[language]?.trim() || value[language]!.trim() === candidate[language]));
  return standard ? Object.fromEntries(languages.map(language => [language, value[language]?.trim() ? value[language]! : standard[language]])) as Label : null;
}

export function scopeReadyForPublication(scope: EditorialScope | null | undefined): boolean {
  if (!scope || scope.type !== "selected_users" && scope.note === null) return true;
  return translated(scope.note)
    || scope.type !== "selected_users" && completeStandardScopeLabel(scope.note) !== null;
}
