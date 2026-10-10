import timers from "node:timers/promises";

let previousRequest: Promise<void> = Promise.resolve();
let lastFinishedAt = 0;

/** The account returned HTTP 429 requiring five seconds between requests; allow a small margin. */
export async function pacedTwitterApiRequest<T>(request: () => Promise<T>): Promise<T> {
  const previous = previousRequest;
  let release!: () => void;
  previousRequest = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, lastFinishedAt + 5500 - Date.now());
    if (wait) await timers.setTimeout(wait);
    return await request();
  } finally {
    lastFinishedAt = Date.now();
    release();
  }
}
