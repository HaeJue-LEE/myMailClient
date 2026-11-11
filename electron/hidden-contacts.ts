import { app } from "electron";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Addresses the user chose to hide from the contact list. Contacts are one
 * list shared by every account, so this list is too. Kept on this computer
 * only, so it covers every contact source (Google, "Other contacts", recent
 * senders) without touching Google data.
 */
const fileSchema = z.object({ emails: z.array(z.string()) });
type HiddenFile = z.infer<typeof fileSchema>;

/** The earlier layout, one list per signed-in account; read once and merged. */
const perAccountSchema = z.object({
  accounts: z.record(z.string(), z.array(z.string())),
});

/**
 * The file's contents, read once and then changed in memory. Holding the
 * promise (not the result) makes simultaneous first calls share one object,
 * so none of their changes is lost.
 */
let loaded: Promise<HiddenFile> | null = null;
/** Writes run one after another, so concurrent changes cannot interleave. */
let writing: Promise<unknown> = Promise.resolve();

function filePath() {
  return path.join(app.getPath("userData"), "hidden-contacts.json");
}

async function readHiddenFile(): Promise<HiddenFile> {
  try {
    const json: unknown = JSON.parse(await readFile(filePath(), "utf8"));
    const parsed = fileSchema.safeParse(json);
    if (parsed.success) return parsed.data;
    const old = perAccountSchema.safeParse(json);
    if (old.success) {
      // Whatever any account hid stays hidden; the next change rewrites the file.
      return { emails: normalise(Object.values(old.data.accounts).flat()) };
    }
    return { emails: [] };
  } catch {
    // Missing or damaged: start empty; the next change rewrites it.
    return { emails: [] };
  }
}

function load() {
  loaded ??= readHiddenFile();
  return loaded;
}

const key = (email: string) => email.trim().toLowerCase();

/** Lower-cased, without duplicates, sorted. */
function normalise(emails: Iterable<string>) {
  return [...new Set([...emails].map(key))].sort();
}

export async function getHiddenContacts(): Promise<string[]> {
  return (await load()).emails;
}

/** Hides or shows `emails`; returns every hidden address. */
export async function setContactsHidden(
  emails: string[],
  hidden: boolean,
): Promise<string[]> {
  const file = await load();
  const set = new Set(file.emails);
  for (const email of emails) {
    if (hidden) set.add(key(email));
    else set.delete(key(email));
  }
  const next = normalise(set);
  file.emails = next;

  const json = JSON.stringify(file, null, 2);
  // Write to a temporary file and rename, so a crash cannot leave half a file.
  writing = writing
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${filePath()}.tmp`;
      await writeFile(temporary, json, "utf8");
      await rename(temporary, filePath());
    });
  await writing;
  return next;
}
