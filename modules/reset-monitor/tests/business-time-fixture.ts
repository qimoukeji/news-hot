import type { BusinessTime } from "../public-v2.ts";

/** Synthetic fixture shorthand only; application readers reject scalar business times. */
export function bt(value: string | BusinessTime): BusinessTime;
export function bt(value: null): null;
export function bt(value: string | BusinessTime | null): BusinessTime | null;
export function bt(value: string | BusinessTime | null): BusinessTime | null {
  if (value === null || typeof value !== "string") return value;
  if (value.includes("/")) {
    const [from, through] = value.split("/");
    return { kind: "range", from: from!, through: through! };
  }
  return value.length === 10
    ? { kind: "instant", at: `${value}T18:00:00Z` }
    : { kind: "instant", at: value };
}
