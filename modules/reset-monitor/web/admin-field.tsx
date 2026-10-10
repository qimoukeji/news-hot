import { cloneElement, type ReactElement } from "react";
import { Field as BaseField } from "@aihot/web/features/admin/ui";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactElement<{ "aria-label"?: string }> }) {
  return <BaseField label={label} hint={hint}>{cloneElement(children, { "aria-label": label })}</BaseField>;
}
