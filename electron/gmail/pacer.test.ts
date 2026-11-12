import { describe, expect, it } from "vitest";
import { createPacer } from "./pacer";

/** A clock that moves forward by whatever is slept, recording each wait. */
function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const throttled = { status: 429 };

describe("createPacer", () => {
  it("lets calls through at once while they fit the minute's budget", async () => {
    const clock = fakeClock();
    const paced = createPacer({ unitsPerMinute: 1_000, retryDelaysMs: [], ...clock });
    // A page: one list call and twenty header fetches, 810 units.
    await paced(10, async () => null);
    await Promise.all(Array.from({ length: 20 }, () => paced(40, async () => null)));
    expect(clock.sleeps).toEqual([]);
  });

  it("waits for room once the budget is spent, instead of failing", async () => {
    const clock = fakeClock();
    const paced = createPacer({ unitsPerMinute: 100, retryDelaysMs: [], ...clock });
    await paced(60, async () => null);
    clock.advance(10_000);
    await paced(30, async () => null);
    // 90 used; 40 more must wait until the first 60 leave the window (50s on).
    await paced(40, async () => null);
    expect(clock.sleeps).toEqual([50_000]);
  });

  it("never charges more than the budget in any minute", async () => {
    const clock = fakeClock();
    const paced = createPacer({ unitsPerMinute: 500, retryDelaysMs: [], ...clock });
    const charged: { at: number; units: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const units = [10, 40, 120][i % 3];
      await paced(units, async () => charged.push({ at: clock.now(), units }));
    }
    for (const { at } of charged) {
      const inWindow = charged
        .filter((entry) => entry.at > at - 60_000 && entry.at <= at)
        .reduce((sum, entry) => sum + entry.units, 0);
      expect(inWindow).toBeLessThanOrEqual(500);
    }
  });

  it("retries throttled requests with backoff, then succeeds", async () => {
    const clock = fakeClock();
    const paced = createPacer({ unitsPerMinute: 10_000, retryDelaysMs: [2_000, 4_000], ...clock });
    let calls = 0;
    const result = await paced(10, async () => {
      calls++;
      if (calls < 3) throw throttled;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([2_000, 4_000]);
  });

  it("gives up after the last retry", async () => {
    const clock = fakeClock();
    const paced = createPacer({ unitsPerMinute: 10_000, retryDelaysMs: [10], ...clock });
    let calls = 0;
    await expect(
      paced(10, async () => {
        calls++;
        throw throttled;
      }),
    ).rejects.toBe(throttled);
    expect(calls).toBe(2);
  });

  it("does not retry other errors", async () => {
    const clock = fakeClock();
    const paced = createPacer({ unitsPerMinute: 10_000, retryDelaysMs: [10], ...clock });
    const notFound = { status: 404 };
    let calls = 0;
    await expect(
      paced(10, async () => {
        calls++;
        throw notFound;
      }),
    ).rejects.toBe(notFound);
    expect(calls).toBe(1);
  });
});
