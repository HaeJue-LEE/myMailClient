import { isRateLimit } from "../errors";

/**
 * Gmail limits each user to a number of quota units per minute (a thread
 * fetch costs 10). Loading hundreds of threads back to back exceeds it, so
 * requests are spaced out, and throttled ones are retried with backoff.
 */
export function createPacer({
  perSecond,
  retryDelaysMs,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  perSecond: number;
  /** One entry per retry; the sum should outlast Gmail's one-minute window. */
  retryDelaysMs: number[];
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}) {
  const interval = 1000 / perSecond;
  let nextSlot = 0;

  async function waitForSlot() {
    const current = now();
    const slot = Math.max(current, nextSlot);
    nextSlot = slot + interval;
    if (slot > current) await sleep(slot - current);
  }

  return async function paced<T>(request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await waitForSlot();
      try {
        return await request();
      } catch (error) {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined || !isRateLimit(error)) throw error;
        // Throttled requests are rejected unprocessed, so a retry is safe even for sends.
        await sleep(delay);
      }
    }
  };
}

/** ~100 units/s at 10 units per call, well under the per-minute budget; retries span ~62s. */
export const paced = createPacer({
  perSecond: 10,
  retryDelaysMs: [2_000, 4_000, 8_000, 16_000, 32_000],
});
