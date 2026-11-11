import type { MailList } from "@/features/mail/routes";
import type { ThreadSummary } from "@/features/mail/types";

/**
 * `after:` for local midnight of `since`. Gmail reads `after:YYYY/MM/DD` in
 * Pacific time, so the boundary is sent as epoch seconds instead.
 */
export function afterQuery(since: string) {
  const [year, month, day] = since.split("-").map(Number);
  const midnight = new Date(year, month - 1, day).getTime();
  return `after:${Math.floor(midnight / 1000)}`;
}

/** At most this many addresses of one person go into a single search. */
export const MAX_CONTACT_SEARCH_ADDRESSES = 10;

/**
 * A Gmail search for mail exchanged with someone: sent by any of their
 * addresses, or sent to them (to, cc, or bcc). `{a b}` is Gmail's OR group.
 * Addresses are quoted, so characters like `+` or `=` are taken literally.
 */
export function contactMailQuery(emails: readonly string[]) {
  const addresses = [...new Set(emails.map((email) => email.trim().toLowerCase()))]
    .filter(Boolean)
    .slice(0, MAX_CONTACT_SEARCH_ADDRESSES)
    // A quote would end the quoted value early; valid addresses have none.
    .map((email) => `"${email.replaceAll('"', "")}"`);
  const terms = addresses.flatMap((address) =>
    ["from", "to", "cc", "bcc"].map((field) => `${field}:${address}`),
  );
  return `{${terms.join(" ")}}`;
}

/** The Gmail list request for a list: a label and/or a search query. */
export function threadListRequest(list: MailList): {
  labelId?: string;
  query?: string;
} {
  const filters = [
    list.unread && "is:unread",
    list.since && afterQuery(list.since),
  ].filter((part): part is string => Boolean(part));
  if ("label" in list) {
    return { labelId: list.label, query: filters.join(" ") || undefined };
  }
  if (filters.length === 0) return { query: list.search };
  // Grouped so an OR inside the search cannot escape the filters.
  return { query: [`(${list.search})`, ...filters].join(" ") };
}

/**
 * Helpers for the search field. Gmail search matches whole words only
 * ("insta" does not find "instagram"), so while typing the app also filters
 * the already-loaded list by substring and suggests matching senders.
 */

/** Text using Gmail operators (from:, is:, …) is left to Gmail alone. */
export function isGmailQuery(text: string) {
  return /(^|\s)-?[a-z_]+:/i.test(text);
}

const normalize = (value: string) => value.trim().toLowerCase();

/** Case-insensitive substring match on the fields the list shows. */
export function matchesFilter(thread: ThreadSummary, filter: string) {
  const needle = normalize(filter);
  if (!needle) return true;
  return [thread.from, thread.fromAddress, thread.subject, thread.snippet].some(
    (field) => field.toLowerCase().includes(needle),
  );
}

export type SenderSuggestion = { name: string; address: string };

/** Distinct senders whose name or address contains `text`, most recent first. */
export function suggestSenders(
  threads: Iterable<ThreadSummary>,
  text: string,
  limit = 6,
): SenderSuggestion[] {
  const needle = normalize(text);
  if (!needle || isGmailQuery(needle)) return [];

  const latest = new Map<string, SenderSuggestion & { date: number }>();
  for (const thread of threads) {
    const { from, fromAddress } = thread;
    if (!fromAddress) continue;
    if (!from.toLowerCase().includes(needle) && !fromAddress.includes(needle)) {
      continue;
    }
    const date = thread.date ?? 0;
    const seen = latest.get(fromAddress);
    if (!seen || date > seen.date) {
      latest.set(fromAddress, { name: from, address: fromAddress, date });
    }
  }
  return [...latest.values()]
    .sort((a, b) => b.date - a.date)
    .slice(0, limit)
    .map(({ name, address }) => ({ name, address }));
}

export function senderQuery(address: string) {
  return `from:${address}`;
}
