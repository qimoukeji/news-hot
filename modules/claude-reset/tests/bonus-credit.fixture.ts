import type { Recognition } from "@aihot/reset-monitor/backend/recognize";
import { cloudBonus } from "./cloud-bonus.fixture.ts";

// Expected classification for the actual source; this is an offline sample, not a live model result.
export function bonusRecognition(): Recognition {
  const rec = structuredClone(cloudBonus.recognition) as Recognition;
  const p = rec.propositions[0]!;
  rec.propositions[0] = { ...p, kind: "bonus_credit", action: "confirm", statedTime: null, expectedLanding: null,
    bonusCredit: { amount: null, eligibility: "if you were on a Pro or Max plan on Sept 23", claimMethod: "Run /claim-credit in Claude Code",
      claimDeadline: { source: "Run /claim-credit in Claude Code by Oct 7 at 11:59pm PT.", at: null,
        timeSourceId: cloudBonus.id, statedTime: { precision: "deadline", date: "2026-10-07", timezone: "PT", clock: "23:59",
          relativeHours: null, period: null, clockThrough: null, dayOffset: null } },
      expiresAt: { source: "expires Nov 4", at: null, statedTime: null } } };
  return rec;
}
