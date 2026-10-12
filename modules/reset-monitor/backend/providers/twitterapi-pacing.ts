import timers from "node:timers/promises";
import { shutdownSignal } from "@aihot/backend/lib/shutdown";
import { ProviderNotSentError } from "@aihot/backend/providers/receipts";

let previousRequest: Promise<void> = Promise.resolve();
let lastFinishedAt = 0;

/** The account returned HTTP 429 requiring five seconds between requests; allow a small margin. */
export async function pacedTwitterApiRequest<T>(request: () => Promise<T>, signal = shutdownSignal.signal): Promise<T> {
  const stopped = () => new ProviderNotSentError("TwitterAPI.io request cancelled before sending", { cause: signal.reason });
  if (signal.aborted) throw stopped();
  const previous = previousRequest;
  let release!: () => void;
  const slot = new Promise<void>((resolve) => { release = resolve; });
  // A cancelled waiter releases its own slot immediately, but following requests still wait for
  // the earlier in-flight request. Releasing the queue tail directly would allow them to overtake it.
  previousRequest = previous.then(() => slot);
  let started = false;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(stopped());
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    await Promise.race([previous, cancelled]);
    if (signal.aborted) throw stopped();
    const wait = Math.max(0, lastFinishedAt + 5500 - Date.now());
    if (wait) {
      try { await timers.setTimeout(wait, undefined, { signal }); }
      catch (error) { if (signal.aborted) throw stopped(); throw error; }
    }
    if (signal.aborted) throw stopped();
    started = true;
    return await request();
  } finally {
    signal.removeEventListener("abort", cancel);
    if (started) lastFinishedAt = Date.now();
    release();
  }
}
