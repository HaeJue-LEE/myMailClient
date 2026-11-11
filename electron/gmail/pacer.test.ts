import { describe, expect, it } from "vitest";
import { createPacer } from "./pacer";

/** A frozen clock that records every wait instead of waiting. */
function fakeClock() {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => 1_000,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

const throttled = { status: 429 };

describe("createPacer", () => {
  it("spaces simultaneous requests one interval apart", async () => {
    const clock = fakeClock();
    const paced = createPacer({ perSecond: 10, retryDelaysMs: [], ...clock });

    await Promise.all([1, 2, 3].map(() => paced(async () => null)));

    // The first goes now; the others wait 100ms and 200ms for their slots.
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it("retries throttled requests with backoff, then succeeds", async () => {
    const clock = fakeClock();
    const paced = createPacer({
      perSecond: 1_000,
      retryDelaysMs: [2_000, 4_000],
      ...clock,
    });
    let calls = 0;

    const result = await paced(async () => {
      calls++;
      if (calls < 3) throw throttled;
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(clock.sleeps).toContain(2_000);
    expect(clock.sleeps).toContain(4_000);
  });

  it("gives up after the last retry", async () => {
    const clock = fakeClock();
    const paced = createPacer({ perSecond: 1_000, retryDelaysMs: [10], ...clock });
    let calls = 0;

    await expect(
      paced(async () => {
        calls++;
        throw throttled;
      }),
    ).rejects.toBe(throttled);
    expect(calls).toBe(2);
  });

  it("does not retry other errors", async () => {
    const clock = fakeClock();
    const paced = createPacer({ perSecond: 1_000, retryDelaysMs: [10], ...clock });
    const notFound = { status: 404 };
    let calls = 0;

    await expect(
      paced(async () => {
        calls++;
        throw notFound;
      }),
    ).rejects.toBe(notFound);
    expect(calls).toBe(1);
  });
});
