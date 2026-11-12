import type { SearchObject } from "imapflow";
import { toImapSearch } from "../imap/query";

/**
 * The Gmail search syntax the renderer produces, for Zoho Mail. It is parsed
 * once (as for IMAP) and then written in Zoho's search syntax: `key:value`
 * terms joined by `::` (and) or `:or:` (or). What Zoho's search cannot say is
 * handled here instead: read state is filtered after the fact, and the date
 * a list starts from is where paging stops.
 */
export type ZohoSearch = {
  /** Zoho's searchKey; null when only the filters below are asked for. */
  searchKey: string | null;
  /** Only unread (false) or read (true) mail. */
  seen?: boolean;
  flagged?: boolean;
  /** Mail received from this time on (local midnight). */
  since?: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `toImapSearch` gives days as UTC midnight of the calendar day; Zoho's
 * `DD-MMM-YYYY` is that day.
 */
function zohoDate(day: Date) {
  return `${String(day.getUTCDate()).padStart(2, "0")}-${MONTHS[day.getUTCMonth()]}-${day.getUTCFullYear()}`;
}

/** Local midnight of the calendar day `day` (UTC midnight) stands for. */
function localStart(day: Date) {
  return new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()).getTime();
}

function term(key: string, value: string) {
  const clean = value.replace(/["\\]/g, " ").trim();
  if (!clean) return null;
  return `${key}:${/[\s:]/.test(clean) ? `"${clean}"` : clean}`;
}

const SEARCH_KEYS: Record<string, string> = {
  text: "entire",
  from: "sender",
  to: "to",
  cc: "cc",
  subject: "subject",
};

/** Zoho terms for one search object; `filters` collects what Zoho cannot search. */
function terms(search: SearchObject, filters: ZohoSearch): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    if (key in SEARCH_KEYS) {
      const written = term(SEARCH_KEYS[key], String(value));
      if (written) out.push(written);
    } else if (key === "seen") {
      filters.seen = Boolean(value);
    } else if (key === "flagged") {
      if (value) {
        filters.flagged = true;
        out.push("has:flags");
      }
    } else if (key === "since") {
      filters.since = localStart(value as Date);
      out.push(`fromDate:${zohoDate(value as Date)}`);
    } else if (key === "before") {
      // `before` excludes its day; Zoho's toDate includes it.
      const last = new Date((value as Date).getTime() - 24 * 60 * 60 * 1000);
      out.push(`toDate:${zohoDate(last)}`);
    } else if (key === "or") {
      // Zoho has no brackets: an OR of single terms is all it can say.
      const parts = (value as SearchObject[])
        .map((part) => terms(part, { searchKey: null }))
        .filter((part) => part.length === 1)
        .map((part) => part[0]);
      if (parts.length > 0) out.push(parts.join(":or:"));
    }
    // `not` (and bcc) have no Zoho form: dropped, so more mail shows, not less.
  }
  return out;
}

export function toZohoSearch(query: string | undefined): ZohoSearch {
  const search = toImapSearch(query);
  const filters: ZohoSearch = { searchKey: null };
  const parts = terms(search, filters);
  // Read state, a star, or a start date alone is a filtered list, not a search.
  const searching = parts.some((part) => !/^(fromDate|toDate|has):/.test(part));
  filters.searchKey = searching ? parts.join("::") : null;
  return filters;
}
