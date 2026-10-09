import { credential } from "@aihot/backend/config";

export const AUTHOR = "thsottiaux";

export function scanMinutes(): number {
  const minutes = Number(credential("collectors", "CODEX_RESET_SCAN_MINUTES") ?? 15);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60 || 60 % minutes !== 0) {
    throw new Error("CODEX_RESET_SCAN_MINUTES must be a positive divisor of 60");
  }
  return minutes;
}

export function scanCron(): string {
  const minutes = scanMinutes();
  return `${minutes === 60 ? "0" : `*/${minutes}`} * * * *`;
}

export function collectorName(): string {
  return credential("collectors", "CODEX_RESET_PROVIDER") ?? "socialdata";
}

/** Opaque cursors and coverage belong to the provider that returned them. */
export const cursorKey = () => `cursor:${collectorName()}`;
export const watermarksKey = () => `watermarks:${collectorName()}`;
