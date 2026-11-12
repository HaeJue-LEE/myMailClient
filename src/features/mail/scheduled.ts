import type { MailErrorCode } from "@/features/mail/bridge";

/**
 * Scheduled sending. The app keeps a scheduled message on this computer and
 * sends it when its time comes, for every kind of account (none of their
 * servers offers it through the protocols the app uses, Zoho aside). The app
 * must be running then; a message whose time passed while it was not is sent
 * as soon as it starts.
 */
export type ScheduledMail = {
  id: string;
  /** The account it is sent from, whichever account is in use then. */
  accountId: string;
  accountEmail: string;
  /** Epoch milliseconds. */
  sendAt: number;
  subject: string;
  to: string[];
  attachmentCount: number;
  createdAt: number;
  /** `failed`: the last attempt did not go through; it waits for the user. */
  status: "pending" | "sending" | "failed";
  error?: MailErrorCode;
  /**
   * The app ended while sending it: it may or may not have gone out, so it
   * is not sent again until the user says so (after looking in Sent).
   */
  interrupted?: boolean;
};

/** A time must be at least this far ahead when it is set. */
export const MIN_SCHEDULE_LEAD_MS = 60 * 1000;
/** And at most this far. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

export function isSchedulable(sendAt: number, now = Date.now()) {
  return (
    Number.isFinite(sendAt) &&
    sendAt >= now + MIN_SCHEDULE_LEAD_MS &&
    sendAt <= now + MAX_SCHEDULE_AHEAD_MS
  );
}

/** The most hours the "N시간 후" choice takes: as far as a time may be set. */
export const MAX_SCHEDULE_HOURS = Math.floor(MAX_SCHEDULE_AHEAD_MS / (60 * 60 * 1000));

/** The hours typed in "N시간 후": a whole number from 1; null for anything else. */
export function parseHours(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const hours = Number(trimmed);
  return hours >= 1 && hours <= MAX_SCHEDULE_HOURS ? hours : null;
}

export const hoursFrom = (now: number, hours: number) => now + hours * 60 * 60 * 1000;

/** `hours` from this moment, read when chosen (not when the menu opened). */
export const hoursFromNow = (hours: number) => hoursFrom(Date.now(), hours);

const at = (base: Date, dayOffset: number, hour: number) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);

/** Quick choices in the schedule menu, in the computer's time zone. */
export function schedulePresets(now = new Date()): { label: string; at: Date }[] {
  const presets: { label: string; at: Date }[] = [];
  if (now.getHours() < 17) presets.push({ label: "오늘 오후 6시", at: at(now, 0, 18) });
  presets.push({ label: "내일 오전 8시", at: at(now, 1, 8) });
  presets.push({ label: "내일 오후 1시", at: at(now, 1, 13) });
  // The coming Monday; a week ahead when today is Monday.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  presets.push({ label: "다음 주 월요일 오전 8시", at: at(now, toMonday, 8) });
  return presets;
}

/** A Date as an `<input type="datetime-local">` value, in local time. */
export function toDatetimeLocal(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** An `<input type="datetime-local">` value as epoch milliseconds; NaN when empty or invalid. */
export function fromDatetimeLocal(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  // Rejects rolled-over values such as 2026-02-31.
  return date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : Number.NaN;
}

export const scheduleTimeFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
