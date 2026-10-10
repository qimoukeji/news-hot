import { credential } from "@aihot/backend/config";
import { monitor } from "./backend/context.ts";

export function scanMinutes(): number {
  const name = monitor().scanMinutesEnv;
  const minutes = Number(credential("collectors", name) ?? 15);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60 || 60 % minutes !== 0) {
    throw new Error(`${name} must be a positive divisor of 60`);
  }
  return minutes;
}
export function scanCron(): string {
  const minutes = scanMinutes();
  return `${minutes === 60 ? "0" : `*/${minutes}`} * * * *`;
}
export const collectorName = () => credential("collectors", monitor().providerEnv) ?? "socialdata";
export const cursorKey = () => `cursor:${collectorName()}`;
export const watermarksKey = () => `watermarks:${collectorName()}`;
