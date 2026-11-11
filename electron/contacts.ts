import type { OAuth2Client } from "google-auth-library";
import { mergeContacts } from "@/features/mail/contacts";
import type { Contact, ContactSource } from "@/features/mail/types";

/**
 * Reads Google Contacts and Google's "Other contacts" (people the user has
 * emailed), and adds, edits, and deletes saved contacts, through the People
 * API. "Other contacts" are read-only. Needs the
 * contacts and contacts.other.readonly scopes, and the People API enabled.
 */
const PEOPLE_API = "https://people.googleapis.com/v1";
const PAGE_SIZE = 1000;
/** Upper bound per source, so a huge address book cannot stall the app. */
const MAX_PEOPLE = 5000;

type EmailAddress = { value?: string | null; type?: string | null };

export type Person = {
  resourceName?: string | null;
  etag?: string | null;
  names?: { displayName?: string | null }[];
  emailAddresses?: EmailAddress[];
};

/** Saved contacts are `people/<id>`; anything else is not editable here. */
export const PERSON_RESOURCE = /^people\/[A-Za-z0-9_-]+$/;

/**
 * Every email address of every person becomes one contact. Saved contacts
 * keep their person's resourceName so they can be edited or deleted.
 */
export function toContacts(
  people: Person[],
  source: ContactSource,
  account: string,
): Contact[] {
  return people.flatMap((person) => {
    const name = person.names?.[0]?.displayName?.trim() ?? "";
    const resourceName =
      source === "google" && person.resourceName && PERSON_RESOURCE.test(person.resourceName)
        ? { resourceName: person.resourceName }
        : {};
    return (person.emailAddresses ?? []).flatMap((address) => {
      const email = address.value?.trim().toLowerCase();
      return email
        ? [{ name, email, source, accounts: [account], ...resourceName }]
        : [];
    });
  });
}

/**
 * The person's addresses with `from` replaced by `to` (or `to` added if `from`
 * is gone). Other addresses and their types are kept.
 */
export function replaceEmail(
  addresses: readonly EmailAddress[],
  from: string,
  to: string,
): EmailAddress[] {
  const kept = addresses
    .filter((address) => address.value)
    .map(({ value, type }) => ({ value, ...(type ? { type } : {}) }));
  const index = kept.findIndex(
    (address) => address.value?.trim().toLowerCase() === from.toLowerCase(),
  );
  if (index === -1) return [...kept, { value: to }];
  return kept.map((address, i) => (i === index ? { ...address, value: to } : address));
}

/** Changes the person's name and one of their addresses; returns all their contacts as saved. */
export async function updateContact(
  auth: OAuth2Client,
  account: string,
  input: { resourceName: string; email: string; name: string; newEmail: string },
): Promise<Contact[]> {
  // Read first for the current etag and the person's other addresses.
  const { data: person } = await auth.request<Person>({
    url: `${PEOPLE_API}/${input.resourceName}`,
    params: { personFields: "names,emailAddresses" },
  });
  const { data: saved } = await auth.request<Person>({
    url: `${PEOPLE_API}/${input.resourceName}:updateContact`,
    method: "PATCH",
    params: {
      updatePersonFields: "names,emailAddresses",
      personFields: "names,emailAddresses",
    },
    data: {
      etag: person.etag,
      // An empty list clears the name.
      names: input.name ? [{ unstructuredName: input.name }] : [],
      emailAddresses: replaceEmail(
        person.emailAddresses ?? [],
        input.email,
        input.newEmail,
      ),
    },
  });
  return toContacts([saved], "google", account);
}

/**
 * Deletes the whole person, including any other addresses they have. A person
 * already gone (e.g. deleted on another device) counts as deleted.
 */
export async function deleteContact(auth: OAuth2Client, resourceName: string) {
  try {
    await auth.request({
      url: `${PEOPLE_API}/${resourceName}:deleteContact`,
      method: "DELETE",
    });
  } catch (error) {
    if ((error as { status?: unknown }).status !== 404) throw error;
  }
}

async function fetchAll(
  auth: OAuth2Client,
  path: string,
  params: Record<string, string>,
  key: "connections" | "otherContacts",
) {
  const people: Person[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await auth.request<
      Partial<Record<typeof key, Person[]>> & { nextPageToken?: string }
    >({
      url: `${PEOPLE_API}/${path}`,
      params: { ...params, pageSize: PAGE_SIZE, pageToken },
    });
    people.push(...(data[key] ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken && people.length < MAX_PEOPLE);
  return people;
}

/** The People API body for a new contact; Google splits the free-form name itself. */
export function newPersonBody({ name, email }: { name: string; email: string }) {
  return {
    ...(name ? { names: [{ unstructuredName: name }] } : {}),
    emailAddresses: [{ value: email }],
  };
}

/** Saves a contact to Google Contacts and returns it as stored. */
export async function createContact(
  auth: OAuth2Client,
  account: string,
  input: { name: string; email: string },
): Promise<Contact> {
  const { data } = await auth.request<Person>({
    url: `${PEOPLE_API}/people:createContact`,
    method: "POST",
    params: { personFields: "names,emailAddresses" },
    data: newPersonBody(input),
  });
  return (
    toContacts([data], "google", account)[0] ?? {
      name: input.name,
      email: input.email.toLowerCase(),
      source: "google",
      accounts: [account],
    }
  );
}

/** `account` is the Google account's address, recorded on every contact. */
export async function listContacts(
  auth: OAuth2Client,
  account: string,
): Promise<Contact[]> {
  const [saved, other] = await Promise.all([
    fetchAll(
      auth,
      "people/me/connections",
      { personFields: "names,emailAddresses" },
      "connections",
    ),
    fetchAll(auth, "otherContacts", { readMask: "names,emailAddresses" }, "otherContacts"),
  ]);
  return mergeContacts([
    ...toContacts(saved, "google", account),
    ...toContacts(other, "other", account),
  ]);
}
