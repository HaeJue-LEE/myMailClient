import type { SearchObject } from "imapflow";

/**
 * Translates the Gmail search syntax the renderer produces into an IMAP
 * search. Covered: `from:` `to:` `cc:` `bcc:` `subject:`, `is:unread|read|starred`,
 * `after:`/`before:` (epoch seconds or a date), `( … )` groups, `{ … }` OR
 * groups, a leading `-` to negate, and quoted values. Operators IMAP has no
 * match for (`has:`, `in:`, `label:` …) are dropped; anything else is
 * searched as text.
 */
type Node =
  | { kind: "term"; key: string | null; value: string; negated: boolean }
  | { kind: "group"; any: boolean; nodes: Node[]; negated: boolean };

const ADDRESS_KEYS = new Set(["from", "to", "cc", "bcc", "subject"]);
const IGNORED_KEYS = new Set(["has", "in", "label", "category", "filename", "list", "size", "larger", "smaller"]);

function parse(query: string): Node[] {
  let position = 0;

  const readValue = () => {
    if (query[position] === '"') {
      const end = query.indexOf('"', position + 1);
      const value = query.slice(position + 1, end < 0 ? undefined : end);
      position = end < 0 ? query.length : end + 1;
      return value;
    }
    const start = position;
    while (position < query.length && !/[\s(){}]/.test(query[position])) position++;
    return query.slice(start, position);
  };

  const readNodes = (close: string | null): Node[] => {
    const nodes: Node[] = [];
    while (position < query.length) {
      const char = query[position];
      if (/\s/.test(char)) {
        position++;
        continue;
      }
      if (char === close) {
        position++;
        break;
      }
      // A stray closing bracket is skipped rather than read as text.
      if (char === ")" || char === "}") {
        position++;
        continue;
      }
      const negated = char === "-" && position + 1 < query.length;
      if (negated) position++;
      const opener = query[position];
      if (opener === "(" || opener === "{") {
        position++;
        nodes.push({
          kind: "group",
          any: opener === "{",
          nodes: readNodes(opener === "(" ? ")" : "}"),
          negated,
        });
        continue;
      }
      const key = /^[a-z_]+:/i.exec(query.slice(position))?.[0];
      if (key) position += key.length;
      const value = readValue();
      nodes.push({
        kind: "term",
        key: key ? key.slice(0, -1).toLowerCase() : null,
        value,
        negated,
      });
    }
    return nodes;
  };

  return readNodes(null);
}

/**
 * The calendar day of a Gmail date value, as a UTC-midnight Date. IMAP compares
 * whole days and ignores time zones, so the local day is what has to survive.
 */
function toDay(value: string): Date | null {
  if (/^\d{9,}$/.test(value)) {
    const local = new Date(Number(value) * 1000);
    return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  }
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

const isEmpty = (search: SearchObject) => Object.keys(search).length === 0;

function termSearch(key: string | null, value: string): SearchObject {
  if (!value) return {};
  if (key === null) return { text: value };
  if (ADDRESS_KEYS.has(key)) return { [key]: value };
  if (key === "is") {
    if (value === "unread") return { seen: false };
    if (value === "read") return { seen: true };
    if (value === "starred") return { flagged: true };
    return {};
  }
  if (key === "after" || key === "newer") {
    const since = toDay(value);
    return since ? { since } : {};
  }
  if (key === "before" || key === "older") {
    const before = toDay(value);
    return before ? { before } : {};
  }
  if (IGNORED_KEYS.has(key)) return {};
  // An unknown operator: at least find its value.
  return { text: value };
}

/** All of `parts` must match. One search object holds one value per key. */
function all(parts: SearchObject[]): SearchObject {
  const merged: SearchObject = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      const target = merged as Record<string, unknown>;
      // NOT a AND NOT b is NOT (a OR b), which fits the single `not` slot.
      const exclude = (search: SearchObject) => {
        merged.not = merged.not ? { or: [merged.not, search] } : search;
      };
      if (key === "text" && typeof target.text === "string") {
        // Several words: searched as one phrase.
        target.text = `${target.text} ${value as string}`;
      } else if (key === "not") {
        exclude(value as SearchObject);
      } else if (key === "or" && merged.or) {
        // A second OR cannot share the object; NOT(NOT x) carries it.
        exclude({ not: { or: value as SearchObject[] } });
      } else {
        target[key] = value;
      }
    }
  }
  return merged;
}

function nodeSearch(node: Node): SearchObject {
  let search: SearchObject;
  if (node.kind === "term") {
    search = termSearch(node.key, node.value);
  } else {
    const parts = node.nodes.map(nodeSearch).filter((part) => !isEmpty(part));
    search = !node.any ? all(parts) : parts.length > 1 ? { or: parts } : (parts[0] ?? {});
  }
  return node.negated && !isEmpty(search) ? { not: search } : search;
}

export function toImapSearch(query: string | undefined): SearchObject {
  const search = all(
    parse(query ?? "")
      .map(nodeSearch)
      .filter((part) => !isEmpty(part)),
  );
  return isEmpty(search) ? { all: true } : search;
}
