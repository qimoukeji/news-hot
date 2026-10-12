import { monitor as currentMonitor, monitorId, purpose as requestPurpose, auditAction, auditSubject } from "./context.ts";
// Recognition of the monitored author's posts: the model translates and states what the post claims; code checks
// the boundaries (kinds, actions, times, relations) independent of wording.
import { z } from "zod";
import { SITE } from "@aihot/site";
import { modelFor } from "@aihot/backend/editorial/models";
import { chatJson, MODELS } from "@aihot/backend/providers/llm";
import { pacificParts } from "./time.ts";
import type { ResetMonitorEventKind, ResetMonitorBonusCredit } from "../contracts.ts";



export interface ContextInput {
  id: string;
  author: string;
  relation: "reply" | "quote";
  text: string;
  publishedAt: string | null;
}

export interface OpenEventInput {
  id: string;
  kind: ResetMonitorEventKind;
  status: "announced" | "confirmed";
  firstPostAt: string;
  excerpt: string;
  schedule: string | null;
  scope?: string | null;
  productsZh?: string | null;
  bonusCredit?: ResetMonitorBonusCredit | null;
}

export const StatedTimeSchema = z.object({
  timezone: z.string().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  precision: z.enum(["exact", "approximate", "deadline", "date", "window"]),
  relativeHours: z.number().min(0).max(240).nullable().catch(null),
  period: z.enum(["afternoon", "evening", "tonight", "end_of_day"]).nullable().catch(null),
  clock: z.string().regex(/^\d{2}:\d{2}$/).nullable().catch(null),
  clockThrough: z.string().regex(/^\d{2}:\d{2}$/).nullable().catch(null),
  dayOffset: z.number().int().min(-1).max(14).nullable().catch(null),
});
const BonusTimeSchema = z.object({
  source: z.string().min(1),
  at: z.string().nullable().default(null),
  statedTime: StatedTimeSchema.nullable().optional(),
  timeSourceId: z.string().nullable().optional(),
});
const BonusCreditSchema = z.object({
  amount: z.string().nullable().default(null),
  eligibility: z.string().nullable().default(null),
  claimMethod: z.string().nullable().default(null),
  usageTerms: z.string().nullable().optional(),
  claimDeadline: BonusTimeSchema.nullable().default(null),
  expiresAt: BonusTimeSchema.nullable().default(null),
});

const PropositionSchema = z.object({
  kind: z.enum(["direct_reset", "reset_credit", "bonus_credit"]),
  kindExplicit: z.boolean().catch(false),
  action: z.enum(["announce", "progress", "confirm", "amend", "withdraw"]),
  real: z.boolean(),
  count: z.number().int().min(1).max(5).default(1),
  role: z.enum(["action", "answer", "explanation", "policy", "uncertain"]).optional(),
  timeSourceId: z.string().nullable().optional(),
  duplicateOf: z.number().int().min(0).nullable().optional(),
  relatesTo: z.string().nullable().catch(null),
  excerpt: z.string(),
  excerptZh: z.string().catch(""),
  statedTime: StatedTimeSchema.nullable().catch(null),
  timeInferred: z.boolean().catch(false),
  expectedLanding: z.object({ earliestPacific: z.string(), latestPacific: z.string(), note: z.string() }).nullable().catch(null),
  scope: z
    .object({
      audienceSource: z.string().nullable().catch(null),
      plans: z.array(z.string()).nullable().catch(null),
      audienceZh: z.string().nullable().catch(null),
      productsZh: z.string().nullable().catch(null),
    })
    .catch({ audienceSource: null, plans: null, audienceZh: null, productsZh: null }),
  bonusCredit: BonusCreditSchema.nullable().optional(),
});

export const RecognitionSchema = z.object({
  relevant: z.boolean(),
  translationZh: z.string().nullable().catch(null),
  contextZh: z.array(z.object({ id: z.string(), textZh: z.string() })).catch([]),
  outage: z.enum(["outage", "recovery"]).nullable().catch(null),
  needsReview: z.boolean(),
  propositions: z.array(PropositionSchema),
});

export type Recognition = z.infer<typeof RecognitionSchema> & { model: string; promptVersion: string; receiptId: number };
export type Proposition = z.infer<typeof PropositionSchema>;

function describeTime(iso: string): string {
  if (currentMonitor().timePolicy === "explicit") return iso;
  const p = pacificParts(new Date(iso));
  return `${iso}（太平洋时间 ${p.date} ${p.hm}）`;
}

export async function recognizePost(input: { id: string; author?: string; text: string; publishedAt: string; context: ContextInput[]; openEvents: OpenEventInput[]; roundId?: string; resume?: boolean }): Promise<Recognition> {
  const lines = [
    `帖子 ${input.id}，作者 @${input.author ?? currentMonitor().authors[0]!.handle}，发布于 ${describeTime(input.publishedAt)}：`,
    input.text,
    "",
    input.context.length ? "上下文（按关系列出）：" : "上下文：无",
    ...input.context.map((c) => `- [${c.relation === "quote" ? "被引用" : "被回复"}] ${c.id} @${c.author}${c.publishedAt ? `，${describeTime(c.publishedAt)}` : ""}：${c.text}`),
    "",
    input.openEvents.length ? "待关联事件（最近的已宣布或刚确认的事件）：" : "待关联事件：无",
    ...input.openEvents.map((e) => `- ${e.id}｜${e.kind}｜${e.status}｜首帖 ${describeTime(e.firstPostAt)}｜${e.schedule ?? "未给时间"}｜对象 ${e.scope ?? "未说明"}｜产品 ${e.productsZh ?? "未说明"}｜“${e.excerpt}”${e.bonusCredit ? `｜奖励详情 ${JSON.stringify(e.bonusCredit)}` : ""}`),
  ];
  const model = await modelFor("monitor");
  const spec = MODELS[model]!;
  const res = await chatJson({
    model,
    purpose: requestPurpose("recognize"),
    subject: `x:${input.id}`,
    attemptTag: input.roundId,
    retryFailed: input.resume,
    promptVersion: currentMonitor().promptVersion,
    system: currentMonitor().prompt,
    user: lines.join("\n"),
    schema: RecognitionSchema,
    temperature: 0.1,
    maxTokens: 6000,
    // Only a fallback: chatJson preserves the selected model's explicit thinking configuration.
    ...(spec.model === "deepseek-flash" && !spec.reasoningTokens ? { extra: { thinking: { type: "disabled" } } } : {}),
  });
  return { ...res.data, model: res.model, promptVersion: currentMonitor().promptVersion, receiptId: res.receiptId };
}
