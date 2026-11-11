import { contactMailQuery } from "@/features/mail/search";

/**
 * The app ships as a static export, which cannot have runtime dynamic
 * segments, so the list (label or search) and thread live in the query string.
 */
export const DEFAULT_LABEL = "INBOX";

/**
 * What the mail list shows: one label, or Gmail search results, optionally
 * narrowed by filters that Gmail applies (so they cover all mail, not just
 * the pages loaded so far).
 */
export type MailList = (
  | { label: string }
  | {
      search: string;
      /** Shown instead of the raw query, e.g. "김영희님과 주고받은 메일". */
      caption?: string;
    }
) &
  ListFilters;

export type ListFilters = {
  /** Only mail received on or after this local `YYYY-MM-DD` date. */
  since?: string;
  /** Only threads with unread messages. */
  unread?: boolean;
};

/**
 * Search terms are capped so a URL cannot carry an unbounded query to Gmail.
 * Large enough for a contact search over several long addresses.
 */
export const MAX_SEARCH_LENGTH = 2000;
const MAX_CAPTION_LENGTH = 200;

/** True for a real calendar date written as `YYYY-MM-DD` (rejects 2026-02-30). */
export function isIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  return (
    year >= 1970 &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

/** A local calendar date as `YYYY-MM-DD`. */
export function toIsoDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseMailList(params: URLSearchParams): MailList {
  const search = params.get("q")?.trim();
  const since = params.get("since") ?? "";
  const caption = params.get("caption")?.trim().slice(0, MAX_CAPTION_LENGTH);
  return {
    ...(search
      ? { search, ...(caption ? { caption } : {}) }
      : { label: params.get("label") ?? DEFAULT_LABEL }),
    ...(isIsoDate(since) ? { since } : {}),
    ...(params.get("unread") === "1" ? { unread: true } : {}),
  };
}

/** The same list without filters; identifies a list while its filters change. */
export function baseList(list: MailList): MailList {
  if ("label" in list) return { label: list.label };
  return list.caption
    ? { search: list.search, caption: list.caption }
    : { search: list.search };
}

/** The label a list is scoped to, or null for search results. */
export function listLabel(list: MailList) {
  return "label" in list ? list.label : null;
}

function listParams(list: MailList): Record<string, string> {
  return {
    ...("label" in list
      ? { label: list.label }
      : { q: list.search, ...(list.caption ? { caption: list.caption } : {}) }),
    ...(list.since ? { since: list.since } : {}),
    ...(list.unread ? { unread: "1" } : {}),
  };
}

export function listHref(list: MailList) {
  return `/mail?${new URLSearchParams(listParams(list))}`;
}

export function labelHref(labelId: string) {
  return listHref({ label: labelId });
}

export const CONTACTS_HREF = "/mail/contacts";

export const SERVER_SETTINGS_HREF = "/mail/settings";

/** Search results for mail exchanged with a contact (any of `emails`). */
export function contactMailHref(name: string, emails: readonly string[]) {
  return listHref({
    search: contactMailQuery(emails),
    caption: `${name}님과 주고받은 메일`,
  });
}

/** Compose a reply, reply-all, or forward of one message in a thread. */
export function replyHref(
  mode: "reply" | "replyAll" | "forward",
  threadId: string,
  messageId: string,
) {
  return `/mail/compose?${new URLSearchParams({ mode, thread: threadId, message: messageId })}`;
}

/** Continue writing the draft whose message is `messageId`. */
export function draftHref(messageId: string) {
  return `/mail/compose?${new URLSearchParams({ draft: messageId })}`;
}

/** The compose page, optionally with the recipient field filled in. */
export function composeHref(to?: string) {
  return to ? `/mail/compose?${new URLSearchParams({ to })}` : "/mail/compose";
}

/**
 * A thread in a pop-up window, tied to the account it was opened for (the
 * window says so instead of showing another account's mail).
 */
export function popupThreadHref(threadId: string, accountId: string, label?: string) {
  return `/popup?${new URLSearchParams({
    thread: threadId,
    account: accountId,
    // The folder it was opened from decides its actions (e.g. restore in Trash).
    ...(label ? { label } : {}),
  })}`;
}

/**
 * A compose page in a pop-up window: the same `?mode=…`, `?draft=…`, or
 * `?to=…` query as `/mail/compose`, plus the account it was opened for.
 */
export function popupComposeHref(composeQuery: string, accountId: string) {
  const params = new URLSearchParams(composeQuery);
  params.set("account", accountId);
  return `/popup/compose?${params}`;
}

export function threadHref(list: MailList, threadId: string) {
  return `/mail?${new URLSearchParams({ ...listParams(list), thread: threadId })}`;
}
