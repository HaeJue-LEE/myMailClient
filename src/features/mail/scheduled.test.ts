import { describe, expect, it } from "vitest";
import {
  fromDatetimeLocal,
  hoursFrom,
  isSchedulable,
  MAX_SCHEDULE_AHEAD_MS,
  MAX_SCHEDULE_HOURS,
  parseHours,
  schedulePresets,
  toDatetimeLocal,
} from "@/features/mail/scheduled";

describe("N시간 후", () => {
  it("takes whole hours from 1 up to the furthest time allowed", () => {
    expect(parseHours("1")).toBe(1);
    expect(parseHours(" 24 ")).toBe(24);
    expect(parseHours(String(MAX_SCHEDULE_HOURS))).toBe(MAX_SCHEDULE_HOURS);
    expect(parseHours(String(MAX_SCHEDULE_HOURS + 1))).toBeNull();
    for (const bad of ["", "0", "-1", "1.5", "2e3", "abc"]) expect(parseHours(bad)).toBeNull();
  });

  it("is always a time that can be set", () => {
    const now = new Date(2026, 10, 12, 10).getTime();
    expect(hoursFrom(now, 1)).toBe(now + 3_600_000);
    expect(isSchedulable(hoursFrom(now, 1), now)).toBe(true);
    expect(isSchedulable(hoursFrom(now, MAX_SCHEDULE_HOURS), now)).toBe(true);
  });
});

const local = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  new Date(year, month - 1, day, hour, minute);

describe("schedulePresets", () => {
  it("offers this evening only before 5 p.m.", () => {
    // Thursday 2026-11-12, 10:30.
    const morning = schedulePresets(local(2026, 11, 12, 10, 30));
    expect(morning.map((preset) => preset.label)).toEqual([
      "오늘 오후 6시",
      "내일 오전 8시",
      "내일 오후 1시",
      "다음 주 월요일 오전 8시",
    ]);
    expect(morning[0].at).toEqual(local(2026, 11, 12, 18));
    expect(morning[1].at).toEqual(local(2026, 11, 13, 8));
    expect(morning[3].at).toEqual(local(2026, 11, 16, 8));

    const evening = schedulePresets(local(2026, 11, 12, 17, 5));
    expect(evening[0].label).toBe("내일 오전 8시");
  });

  it("goes a week ahead on Mondays, and across month ends", () => {
    const monday = schedulePresets(local(2026, 11, 16, 9));
    expect(monday.at(-1)?.at).toEqual(local(2026, 11, 23, 8));
    const monthEnd = schedulePresets(local(2026, 11, 30, 20));
    expect(monthEnd[0].at).toEqual(local(2026, 12, 1, 8));
  });
});

describe("isSchedulable", () => {
  const now = local(2026, 11, 12, 10).getTime();
  it("takes times from a minute ahead to about a year ahead", () => {
    expect(isSchedulable(now + 60 * 1000, now)).toBe(true);
    expect(isSchedulable(now + 59 * 1000, now)).toBe(false);
    expect(isSchedulable(now - 1, now)).toBe(false);
    expect(isSchedulable(now + MAX_SCHEDULE_AHEAD_MS, now)).toBe(true);
    expect(isSchedulable(now + MAX_SCHEDULE_AHEAD_MS + 1, now)).toBe(false);
    expect(isSchedulable(Number.NaN, now)).toBe(false);
  });
});

describe("datetime-local values", () => {
  it("round-trips local time", () => {
    const date = local(2026, 3, 5, 9, 7);
    expect(toDatetimeLocal(date)).toBe("2026-03-05T09:07");
    expect(fromDatetimeLocal("2026-03-05T09:07")).toBe(date.getTime());
  });

  it("refuses empty and impossible dates", () => {
    expect(fromDatetimeLocal("")).toBeNaN();
    expect(fromDatetimeLocal("2026-02-31T10:00")).toBeNaN();
    expect(fromDatetimeLocal("2026-2-3T10:00")).toBeNaN();
  });
});
