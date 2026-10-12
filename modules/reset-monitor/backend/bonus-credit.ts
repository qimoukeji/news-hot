import type { ResetMonitorBonusCredit, ResetMonitorBonusTime } from "../contracts.ts";
import type { ContextInput, Proposition } from "./recognize.ts";
import { quotedInPost } from "./assemble.ts";
import { resolve } from "./explicit-time.ts";
import { scheduleFrom } from "./time.ts";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { isAuthor } from "./context.ts";

/** Dates supplied directly by the model are ignored; each time needs its own literal source. */
export function bonusCreditOf(p: Proposition, input: { id: string; text: string; publishedAt: Date; context: ContextInput[] }): ResetMonitorBonusCredit | null {
  if (p.kind !== "bonus_credit" || !p.bonusCredit) return null;
  const literal = (value: string | null) => value && quotedInPost(value, input.text) ? value : null;
  const time = (value: NonNullable<Proposition["bonusCredit"]>["claimDeadline"]): ResetMonitorBonusTime | null => {
    if (!value) return null;
    const source = !value.timeSourceId || value.timeSourceId === input.id ? input : input.context.find((c) => c.id === value.timeSourceId
      && ["reply", "quote"].includes(c.relation) && isAuthor(c.author));
    if (!source || !quotedInPost(value.source, source.text)) return null;
    const at = source.publishedAt ? new Date(source.publishedAt) : null;
    if (!at || !Number.isFinite(at.getTime()) || at > input.publishedAt) return { source: value.source, at: null };
    const words = value.statedTime;
    const resolved = words && resolve(words, at, value.source);
    const instant = resolved && resolved.from ? scheduleFrom(resolved).from : null;
    return { source: value.source, at: instant ? `${beijingDate(instant)}T${beijingTime(instant)}:00.000+08:00` : null };
  };
  return { amount: literal(p.bonusCredit.amount), eligibility: literal(p.bonusCredit.eligibility), claimMethod: literal(p.bonusCredit.claimMethod),
    usageTerms: literal(p.bonusCredit.usageTerms ?? null),
    claimDeadline: time(p.bonusCredit.claimDeadline), expiresAt: time(p.bonusCredit.expiresAt) };
}

/** A reward's general schedule is its opening time, never its claiming or consumption deadline. */
export function bonusOpeningTime(p: Proposition): boolean {
  return /\b(?:available|opens?|starts?|begins?|roll(?:ing)? out|grant(?:ed|ing)?)\b|开放|開始|开始|发放/i.test(p.excerpt)
    && !/\b(?:claim|redeem|expires?|expiration|runs? out)\b|领取|到期|失效/i.test(p.excerpt);
}
