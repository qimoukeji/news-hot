import { languages, translated, type EditorialText, type EditorialScope } from "../actions.ts";

type Label = Record<(typeof languages)[number], string>;
const label = (values: string[]): Label => Object.fromEntries(languages.map((language, index) => [language, values[index]!])) as Label;

/** Fixed display labels never infer scope.type or eligibility conditions. */
const allUsers = label(["All users", "所有用户", "所有使用者", "すべてのユーザー", "모든 사용자", "Все пользователи", "Todos los usuarios"]);
const paidUsers = label(["Paid users", "付费用户", "付費使用者", "有料ユーザー", "유료 사용자", "Платные пользователи", "Usuarios de pago"]);
const unspecified = label(["Eligibility unspecified", "适用范围未明确", "適用範圍未明確", "対象範囲は未指定", "적용 대상 미지정", "Условия участия не указаны", "Elegibilidad no especificada"]);
const standardLabels = [allUsers, paidUsers, unspecified];
const matchesLabel = (value: EditorialText, candidate: Label) => languages.some(language => value[language]?.trim())
  && languages.every(language => !value[language]?.trim() || value[language]!.trim() === candidate[language]);

export function hasCustomScopeNote(note: EditorialText | null | undefined): boolean {
  return !!note && languages.some(language => note[language]?.trim()) && !standardLabels.some(candidate => languages.every(language => {
    const value = note[language]?.trim();
    // Historical rows sometimes repeated the same fixed label in all languages.
    return !value || value === candidate[language] || value === candidate.en || value === candidate.zh;
  }));
}

export function fixedScopeNote(type: Exclude<EditorialScope["type"], "selected_users">): Label {
  return { ...(type === "paid_users" ? paidUsers : allUsers) };
}

/** Persist fixed labels immediately; the existing translation job completes custom editorial labels. */
export function scopeForWrite(scope?: EditorialScope | null): EditorialScope {
  const type = scope?.type ?? "unknown";
  if (type === "selected_users") {
    const note = scope!.note;
    const paid = note && matchesLabel(note, paidUsers);
    return { type, note: paid ? { ...paidUsers } : note };
  }
  return { type, note: fixedScopeNote(type) };
}

export function publicScopeLabel(type: EditorialScope["type"], note: Label | null): Label {
  return note ?? defaultScopeLabel(type);
}

export function defaultScopeLabel(type: EditorialScope["type"]): Label {
  return { ...(type === "all_users" ? allUsers : type === "paid_users" ? paidUsers : unspecified) };
}

/** Fill only missing languages when every supplied nonblank value matches one fixed label. */
export function completeStandardScopeLabel(value: EditorialText | null | undefined): Label | null {
  if (translated(value)) return { ...value };
  if (!value) return null;
  const standard = standardLabels.find(candidate => matchesLabel(value, candidate));
  return standard ? Object.fromEntries(languages.map(language => [language, value[language]?.trim() ? value[language]! : standard[language]])) as Label : null;
}

export function scopeReadyForPublication(scope: EditorialScope | null | undefined): boolean {
  if (!scope || scope.type !== "selected_users" && scope.note === null) return true;
  return translated(scope.note)
    || scope.type !== "selected_users" && completeStandardScopeLabel(scope.note) !== null;
}
