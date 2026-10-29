import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { shutdownSignal } from "@aihot/backend/lib/shutdown";
import { BudgetExceededError, ReceiptBusyError, completeReceipt, rejectReceivedResponse } from "@aihot/backend/providers/receipts";
import { ModelOutputError } from "@aihot/backend/providers/llm";
import { modelFor } from "@aihot/backend/editorial/models";
import { loadActionInput, markPostFailure, markPostReview, rowVersion, StalePostWork } from "./action-store.ts";
import { applyRecognitionGroup } from "./assemble.ts";
import { monitorId, authorHandles } from "./context.ts";
import { buildThreadGroups, type ThreadGroup } from "./thread-groups.ts";
import { openEvents } from "./open-events.ts";
import { postContext } from "./post-context.ts";
import { recognizeThread, threadRecognitionVersion, threadModelRevision, type ThreadRecognitionInput, type ThreadRecognition } from "./recognize.ts";
import { sourceContentIssue } from "./source-completeness.ts";
import type { ActionInput, SourcePostRow } from "../actions.ts";

interface Revision { id: string; version: string }
// Bound paid group inputs before sending; keep oversized source chains intact for manual review.
export const MAX_THREAD_INPUT_BYTES = 128 * 1024;
interface Work {
  targets: Revision[]; context: Revision[]; events: Revision[]; actions: Revision[];
  model: string; promptVersion: string; modelRevision: string;
}
const revision = (row: { id: string }): Revision => ({ id: row.id, version: rowVersion(row) });
const material = (post: SourcePostRow) => ({ id: post.id, author: post.author, text: post.text ?? "", publishedAt: new Date(post.published_at).toISOString(),
  replyTo: post.reply_to, quotedPostId: post.quoted_post?.id ?? null, version: rowVersion(post) });

export async function relevantFacts(group: ThreadGroup, saved: ActionInput): Promise<{ baseline: ActionInput; events: ThreadRecognitionInput["events"] }> {
  const candidates = await Promise.all(group.targets.map(post => openEvents(new Date(post.published_at), postContext(post, saved.posts), saved, post)));
  const events = [...new Map(candidates.flat().map(event => [event.id, event])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(events.map(event => event.id));
  return { events, baseline: { posts: saved.posts, events: saved.events.filter(event => ids.has(event.id)), actions: saved.actions.filter(action => ids.has(action.event_id)) } };
}

/** Pending work stores revisions only. Originals remain exclusively in the source-post records. */
export async function processPending(limit = Infinity): Promise<{ processed: number; failed: number; groups: number; modelCalls: number; reviewed: number; schemaFailures: number }> {
  const result = { processed: 0, failed: 0, groups: 0, modelCalls: 0, reviewed: 0, schemaFailures: 0 };
  if (!config.modelCallsEnabled || process.env.COLLECT_ENABLED !== "true") return result;
  const works = await sql<{ key: string; value: Work }[]>`SELECT key,value FROM monitor_state WHERE monitor_id=${monitorId()} AND key LIKE 'recognition:pending:%' ORDER BY key`;
  for (const stored of works) {
    const saved = await loadActionInput();
    const byId = new Map(saved.posts.map(post => [post.id, post]));
    if (stored.value.targets.every(ref => byId.get(ref.id)?.processing_status !== "pending")) { await removeWork(stored.key); continue; }
    const matching = (refs: Revision[], rows: { id: string }[]) => refs.every(ref => rows.some(row => row.id === ref.id && rowVersion(row) === ref.version));
    const stale = stored.value.promptVersion !== threadRecognitionVersion || stored.value.model !== await modelFor("monitor") || stored.value.modelRevision !== await threadModelRevision()
      || !matching(stored.value.targets, saved.posts) || !matching(stored.value.context, saved.posts)
      || !matching(stored.value.events, saved.events) || !matching(stored.value.actions, saved.actions)
      || saved.actions.some(action => stored.value.events.some(ref => ref.id === action.event_id) && !stored.value.actions.some(ref => ref.id === action.id));
    if (stale) {
      await review(stored.value.targets.flatMap(ref => { const post = byId.get(ref.id); return post?.processing_status === "pending" && rowVersion(post) === ref.version ? [post] : []; }), "识别输入已变化，需人工复核");
      await removeWork(stored.key); continue;
    }
    const group: ThreadGroup = { targets: stored.value.targets.map(ref => byId.get(ref.id)!), context: stored.value.context.map(ref => byId.get(ref.id)!), issues: [] };
    const ids = new Set(stored.value.events.map(ref => ref.id));
    await run(group, { ...saved, events: saved.events.filter(event => ids.has(event.id)), actions: saved.actions.filter(action => ids.has(action.event_id)) }, stored.key);
  }
  const saved = await loadActionInput();
  const allowed = new Set(authorHandles());
  for (const group of buildThreadGroups(saved.posts, authorHandles())) {
    if (result.processed >= limit) break; // Never split one connected group to satisfy a per-call cap.
    if (group.targets.some(post => !allowed.has(post.author.toLowerCase()))) continue;
    const issues = [...group.issues, ...group.targets.flatMap(post => sourceContentIssue(post.text ?? "") ? ["资料不完整：原帖只有文章链接或缺少正文"] : [])];
    if (issues.length) { await review(group.targets, [...new Set(issues)].join("；")); continue; }
    const latest = await loadActionInput();
    const { baseline } = await relevantFacts(group, latest);
    const work: Work = { targets: group.targets.map(revision), context: group.context.map(revision), events: baseline.events.map(revision), actions: baseline.actions.map(revision),
      model: await modelFor("monitor"), promptVersion: threadRecognitionVersion, modelRevision: await threadModelRevision() };
    const key = `recognition:pending:${sha256(stableJson(work))}`;
    await sql`INSERT INTO monitor_state(monitor_id,key,value) VALUES(${monitorId()},${key},${sql.json(work as never)}) ON CONFLICT(monitor_id,key) DO NOTHING`;
    await run(group, baseline, key);
  }
  return result;

  async function removeWork(key: string) { await sql`DELETE FROM monitor_state WHERE monitor_id=${monitorId()} AND key=${key}`; }
  async function review(posts: SourcePostRow[], reason: string, receiptId?: number) {
    await sql.begin(async db => {
      for (const post of posts) if (await markPostReview(post.id, reason, rowVersion(post), receiptId, db)) { result.processed++; result.reviewed++; }
    });
  }
  async function run(group: ThreadGroup, baseline: ActionInput, key: string) {
    shutdownSignal.signal.throwIfAborted();
    const { events } = await relevantFacts(group, baseline);
    const input: ThreadRecognitionInput = { targets: group.targets.map(material), context: group.context.map(material), events };
    if (Buffer.byteLength(stableJson(input), "utf8") > MAX_THREAD_INPUT_BYTES) {
      await review(group.targets, "识别组超过输入容量，需人工处理；未截断原帖或调用模型");
      await removeWork(key); return;
    }
    let recognition: ThreadRecognition | undefined;
    const [attempt] = await sql<{ id: number }[]>`SELECT coalesce(max(id),0)::bigint AS id FROM receipt_attempts`;
    try {
      recognition = await recognizeThread(input, key.slice("recognition:pending:".length));
      if (!recognition.reused) result.modelCalls++;
      await applyRecognitionGroup(group.targets, group.context, baseline, recognition);
      result.groups++; result.processed += group.targets.length;
      const latest = await loadActionInput();
      result.reviewed += latest.posts.filter(post => group.targets.some(target => target.id === post.id) && post.processing_status === "needs_attention").length;
      await removeWork(key);
    } catch (error) {
      if (error instanceof BudgetExceededError || error instanceof ReceiptBusyError) throw error;
      if (error instanceof StalePostWork) {
        const latest = await loadActionInput();
        await review(latest.posts.filter(post => group.targets.some(target => target.id === post.id && rowVersion(target) === rowVersion(post)) && post.processing_status === "pending"), "识别期间来源或事件已变化，需人工复核", recognition?.receiptId);
        if (recognition) await completeReceipt(sql, recognition.receiptId);
        await removeWork(key); return;
      }
      if (error instanceof ModelOutputError) {
        result.schemaFailures++;
        if (error.receiptId !== null) {
          const [calls] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${error.receiptId} AND id>${attempt!.id}`;
          result.modelCalls += calls!.n;
        }
        await sql.begin(async db => {
          const detail = error.validationIssues.map(issue => `${issue.path} (${issue.code})`).join("；");
          const reason = `模型响应未通过识别组结构校验${detail ? `：${detail}` : ""}`;
          for (const post of group.targets) await markPostReview(post.id, reason, rowVersion(post), error.receiptId ?? undefined, db);
          if (error.receiptId !== null) await rejectReceivedResponse(error.receiptId, `Monitor thread recognition validation failed${detail ? `: ${detail}` : ""}`, db);
        });
        result.processed += group.targets.length; result.reviewed += group.targets.length;
        await removeWork(key); return;
      }
      if (recognition && error && typeof error === "object" && "statusCode" in error && error.statusCode === 400) {
        await sql.begin(async db => {
          for (const post of group.targets) {
            const content = recognition!.posts.find(result => result.postId === post.id);
            await markPostReview(post.id, "识别组动作未通过事实或关联校验", rowVersion(post), recognition!.receiptId, db, content);
          }
          await rejectReceivedResponse(recognition!.receiptId, "Monitor thread action validation failed", db);
        });
        result.processed += group.targets.length; result.reviewed += group.targets.length;
        await removeWork(key); return;
      }
      if (recognition) throw error; // Database failure: reuse the received answer and exact work revisions.
      let marked = 0;
      await sql.begin(async db => {
        for (const post of group.targets) if (await markPostFailure(post.id, rowVersion(post), undefined, db)) marked++;
      });
      if (!marked) { await removeWork(key); return; }
      throw error;
    }
  }
}
