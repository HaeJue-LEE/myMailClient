import type {
  Contact,
  ContactSource,
  ThreadSummary,
} from "@/features/mail/types";

export const MAX_CONTACT_NAME_LENGTH = 200;

export const CONTACT_SOURCE_LABEL: Record<ContactSource, string> = {
  google: "주소록",
  other: "주고받은 사람",
  recent: "최근 메일",
};

/** Earlier sources win when the same address appears in several. */
const SOURCE_RANK: Record<ContactSource, number> = {
  google: 0,
  other: 1,
  recent: 2,
};

const collator = new Intl.Collator("ko", { sensitivity: "base", numeric: true });

/**
 * One entry per address, keeping the best source and a name if any has one,
 * and every account it came from; sorted by name.
 */
export function mergeContacts(contacts: Iterable<Contact>): Contact[] {
  const byEmail = new Map<string, Contact>();
  for (const contact of contacts) {
    const email = contact.email.trim().toLowerCase();
    if (!email) continue;
    const seen = byEmail.get(email);
    if (!seen) {
      byEmail.set(email, { ...contact, email, accounts: [...contact.accounts] });
      continue;
    }
    const better = SOURCE_RANK[contact.source] < SOURCE_RANK[seen.source];
    const [winner, loser] = better ? [contact, seen] : [seen, contact];
    // The winner keeps its source and resourceName; a name may come from either.
    byEmail.set(email, {
      ...winner,
      email,
      name: (winner.name || loser.name).trim(),
      accounts: [...new Set([...winner.accounts, ...loser.accounts])],
    });
  }
  return [...byEmail.values()].sort(
    (a, b) =>
      collator.compare(a.name || a.email, b.name || b.email) ||
      a.email.localeCompare(b.email),
  );
}

/**
 * Changes made from this app session. Google's contact list can take a few
 * minutes to reflect them, so they are laid over every fetched list until it
 * does; otherwise a refresh would undo them on screen and invite repeats.
 */
export type ContactEdits = {
  /** Added contacts, by address. */
  created: Map<string, Contact>;
  /** Edited people: their contacts as saved. */
  replaced: Map<string, Contact[]>;
  /** Deleted people. */
  removed: Set<string>;
};

export function emptyContactEdits(): ContactEdits {
  return { created: new Map(), replaced: new Map(), removed: new Set() };
}

/** Records an edit or deletion, superseding earlier pending changes to that person. */
export function forgetPerson(edits: ContactEdits, resourceName: string) {
  for (const [email, contact] of edits.created) {
    if (contact.resourceName === resourceName) edits.created.delete(email);
  }
  edits.replaced.delete(resourceName);
  edits.removed.delete(resourceName);
}

/** The list with the session's changes applied. Applying twice changes nothing. */
export function applyContactEdits(
  contacts: readonly Contact[],
  edits: ContactEdits,
): Contact[] {
  const kept = contacts.filter(
    (contact) =>
      !contact.resourceName ||
      (!edits.removed.has(contact.resourceName) &&
        !edits.replaced.has(contact.resourceName)),
  );
  return mergeContacts([
    ...kept,
    ...[...edits.replaced.values()].flat(),
    ...edits.created.values(),
  ]);
}

/** Drops pending changes that a freshly fetched list already shows. */
export function pruneContactEdits(fetched: readonly Contact[], edits: ContactEdits) {
  const byPerson = Map.groupBy(
    fetched.filter((contact) => contact.resourceName),
    (contact) => contact.resourceName as string,
  );
  const describe = (contacts: readonly Contact[]) =>
    contacts
      .map((contact) => `${contact.email}\u0000${contact.name}`)
      .sort()
      .join("\n");

  for (const email of edits.created.keys()) {
    if (fetched.some((c) => c.email === email && c.source === "google")) {
      edits.created.delete(email);
    }
  }
  for (const resourceName of edits.removed) {
    if (!byPerson.has(resourceName)) edits.removed.delete(resourceName);
  }
  for (const [resourceName, saved] of edits.replaced) {
    const current = byPerson.get(resourceName) ?? [];
    if (describe(current) === describe(saved)) edits.replaced.delete(resourceName);
  }
}

/** Senders of the threads loaded so far for `account`, as contacts. */
export function recentContacts(
  threads: Iterable<ThreadSummary>,
  account: string,
): Contact[] {
  const contacts: Contact[] = [];
  for (const thread of threads) {
    if (!thread.fromAddress) continue;
    // A bare address as the display name adds nothing.
    const name = thread.from === thread.fromAddress ? "" : thread.from;
    contacts.push({
      name,
      email: thread.fromAddress,
      source: "recent",
      accounts: account ? [account] : [],
    });
  }
  return contacts;
}

/**
 * Contacts whose name or address contains `text`, ignoring case. Matches at
 * the start of the name or address come first, then by source.
 */
export function matchContacts(
  contacts: readonly Contact[],
  text: string,
  { limit = 8, exclude = [] }: { limit?: number; exclude?: Iterable<string> } = {},
): Contact[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  const skip = new Set([...exclude].map((email) => email.toLowerCase()));

  const scored: { contact: Contact; score: number }[] = [];
  for (const contact of contacts) {
    if (skip.has(contact.email)) continue;
    const name = contact.name.toLowerCase();
    if (!name.includes(needle) && !contact.email.includes(needle)) continue;
    const prefix = name.startsWith(needle) || contact.email.startsWith(needle);
    scored.push({
      contact,
      score: (prefix ? 0 : 10) + SOURCE_RANK[contact.source],
    });
  }
  // Stable sort keeps the alphabetical order of the input within a score.
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ contact }) => contact);
}

/** Recipient fields separate entries the way `parseAddresses` reads them. */
const SEPARATOR = /[,;\n]/g;

function lastSeparatorEnd(value: string) {
  let end = 0;
  for (const match of value.matchAll(SEPARATOR)) end = match.index + 1;
  return end;
}

/** The entry being typed: the text after the last separator. */
export function currentRecipientText(value: string) {
  return value.slice(lastSeparatorEnd(value)).trim();
}

/** The entries before the one being typed. */
export function completedRecipientText(value: string) {
  return value.slice(0, lastSeparatorEnd(value));
}

/** Replaces the entry being typed with `recipient` and starts the next entry. */
export function replaceCurrentRecipient(value: string, recipient: string) {
  const head = completedRecipientText(value);
  const gap = head && !/\s$/.test(head) ? " " : "";
  return `${head}${gap}${recipient}, `;
}

/**
 * `이름 <a@example.com>` for the recipient field. Characters that the field
 * treats as separators or brackets are dropped from the name.
 */
export function formatRecipient(contact: Pick<Contact, "name" | "email">) {
  const name = contact.name.replace(/[,;<>"\n]/g, " ").replace(/\s+/g, " ").trim();
  return name ? `${name} <${contact.email}>` : contact.email;
}
