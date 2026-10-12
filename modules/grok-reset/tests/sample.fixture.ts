// Synthetic samples for behavior tests; these are not verified X announcements.
import type { Proposition, Recognition } from "@aihot/reset-monitor/backend/recognize";

export function recognition(source: string, patch: Partial<Proposition> = {}): Recognition {
  return { relevant: true, translationZh: "模拟额度公告", contextZh: [], outage: null, needsReview: false,
    model: "test", promptVersion: "synthetic", receiptId: 0, propositions: [{
      kind: "direct_reset", kindExplicit: true, action: "announce", real: true, role: "action", count: 1,
      relatesTo: null, excerpt: source, excerptZh: "模拟额度公告", statedTime: null, timeInferred: false, expectedLanding: null,
      scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null }, ...patch,
    }] };
}
