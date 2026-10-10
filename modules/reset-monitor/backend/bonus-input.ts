import { z } from "zod";

const BonusTimeInput = z.object({
  source: z.string().min(1).max(2000),
  at: z.string().datetime({ offset: true }).nullable(),
}).strict();

/** Explicit administrative corrections; automatic recognition separately checks original evidence. */
export const BonusCreditInput = z.object({
  amount: z.string().max(1000).nullable(),
  eligibility: z.string().max(2000).nullable(),
  claimMethod: z.string().max(2000).nullable(),
  usageTerms: z.string().max(4000).nullable().optional(),
  claimDeadline: BonusTimeInput.nullable(),
  expiresAt: BonusTimeInput.nullable(),
}).strict();
