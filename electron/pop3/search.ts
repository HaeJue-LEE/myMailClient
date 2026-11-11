import type { SearchObject } from "imapflow";

/** What a list search can be checked against without downloading bodies. */
export type HeaderFacts = {
  subject: string;
  /** Address headers as text, e.g. `"홍길동" <hong@example.com>`. */
  from: string;
  to: string;
  cc: string;
  bcc: string;
  date: number | null;
  seen: boolean;
  flagged: boolean;
};

const contains = (haystack: string, needle: string) =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/** Midnight UTC of the local day `time` falls on, as IMAP's day compare uses. */
function day(time: number) {
  const local = new Date(time);
  return Date.UTC(local.getFullYear(), local.getMonth(), local.getDate());
}

/**
 * Whether a message matches a search from `toImapSearch`. POP3 has no server
 * search, so this runs here on the headers alone: free text matches the
 * subject and addresses, never the body.
 */
export function matchesSearch(search: SearchObject, facts: HeaderFacts): boolean {
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    const ok = (() => {
      switch (key) {
        case "all":
          return true;
        case "seen":
          return facts.seen === value;
        case "flagged":
          return facts.flagged === value;
        case "from":
        case "to":
        case "cc":
        case "bcc":
        case "subject":
          return contains(facts[key], String(value));
        case "text":
          return [facts.subject, facts.from, facts.to, facts.cc].some((field) =>
            contains(field, String(value)),
          );
        case "since":
          return facts.date !== null && day(facts.date) >= (value as Date).getTime();
        case "before":
          return facts.date !== null && day(facts.date) < (value as Date).getTime();
        case "or":
          return (value as SearchObject[]).some((part) => matchesSearch(part, facts));
        case "not":
          return !matchesSearch(value as SearchObject, facts);
        default:
          // Nothing else is produced for list searches; do not hide mail over it.
          return true;
      }
    })();
    if (!ok) return false;
  }
  return true;
}
