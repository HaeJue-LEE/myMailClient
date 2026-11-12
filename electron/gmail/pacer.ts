import { isRateLimit } from "../errors";

/**
 * Gmail limits each user to a number of quota units per minute, and each
 * method costs a different number of units (see GMAIL_COST). Calls are
 * charged their cost against a one-minute sliding window: they go at once
 * while there is room, so a page loads in a burst, and wait for room once the
 * budget is spent instead of being refused. Throttled calls (another app on
 * the same account, or a miscount) are retried with backoff.
 */

/**
 * Quota units per call, from Google's Gmail API usage limits page
 * (developers.google.com/workspace/gmail/api/reference/quota).
 */
export const GMAIL_COST = {
  labelsList: 1,
  threadsList: 10,
  threadsGetMetadata: 40,
  threadsGetFull: 120,
  threadsModify: 10,
  threadsTrash: 20,
  threadsUntrash: 10,
  messagesGetFull: 60,
  messagesSend: 100,
  attachmentsGet: 20,
  draftsCreate: 10,
  draftsUpdate: 15,
  draftsDelete: 10,
  draftsList: 5,
  // Not in Google's table; charged like the other sends.
  draftsSend: 100,
  sendAsList: 1,
} as const;

/** Google's per-user limit is 6,000 units a minute; the margin covers clock drift. */
export const GMAIL_UNITS_PER_MINUTE = 5_400;

const WINDOW_MS = 60_000;

export function createPacer({
  unitsPerMinute,
  retryDelaysMs,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  unitsPerMinute: number;
  /** One entry per retry; the sum should outlast Gmail's one-minute window. */
  retryDelaysMs: number[];
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}) {
  /** Units charged in the last minute, oldest first. */
  const spent: { at: number; units: number }[] = [];

  /** Reserves `units` in the window, waiting until they fit. */
  async function reserve(units: number) {
    // A single call larger than the whole budget still has to go some time.
    const cost = Math.min(units, unitsPerMinute);
    for (;;) {
      const current = now();
      while (spent.length && spent[0].at <= current - WINDOW_MS) spent.shift();
      const used = spent.reduce((sum, entry) => sum + entry.units, 0);
      if (used + cost <= unitsPerMinute) {
        spent.push({ at: current, units: cost });
        return;
      }
      // Wait until enough of the oldest charges have left the window.
      let freed = 0;
      let until = current;
      for (const entry of spent) {
        freed += entry.units;
        until = entry.at + WINDOW_MS;
        if (used - freed + cost <= unitsPerMinute) break;
      }
      await sleep(Math.max(until - current, 1));
    }
  }

  /** Runs `request`, charged `units` quota units. */
  return async function paced<T>(units: number, request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await reserve(units);
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

/** Retries span ~62s, longer than the window a throttled call waits out. */
export const paced = createPacer({
  unitsPerMinute: GMAIL_UNITS_PER_MINUTE,
  retryDelaysMs: [2_000, 4_000, 8_000, 16_000, 32_000],
});
