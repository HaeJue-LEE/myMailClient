import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * What a POP3 server cannot keep for a POP3 account, kept on this computer
 * instead: which messages were read or starred, drafts, and copies of sent
 * mail. Removed with the account.
 */

export type LocalFolder = "drafts" | "sent";

const stateSchema = z.object({
  /** UIDLs of messages opened or marked read. */
  read: z.array(z.string()).default([]),
  starred: z.array(z.string()).default([]),
  /**
   * Whether each message opened so far has a real attachment, by UIDL. The
   * list cannot tell without downloading the message, so what opening it
   * showed is kept for the next time.
   */
  attachments: z.record(z.string(), z.boolean()).default({}),
});
export type Pop3LocalState = {
  read: Set<string>;
  starred: Set<string>;
  attachments: Map<string, boolean>;
};

const emptyState = (): Pop3LocalState => ({
  read: new Set(),
  starred: new Set(),
  attachments: new Map(),
});

const accountDir = (accountId: string) =>
  path.join(app.getPath("userData"), "pop3", Buffer.from(accountId).toString("base64url"));

/** Writes run one after another per account, so changes cannot interleave. */
const writing = new Map<string, Promise<unknown>>();

function serialized<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const result = (writing.get(accountId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(task);
  writing.set(accountId, result);
  return result;
}

async function writeAtomic(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
}

export async function readLocalState(accountId: string): Promise<Pop3LocalState> {
  try {
    const raw = JSON.parse(await readFile(path.join(accountDir(accountId), "state.json"), "utf8"));
    const parsed = stateSchema.parse(raw);
    return {
      read: new Set(parsed.read),
      starred: new Set(parsed.starred),
      attachments: new Map(Object.entries(parsed.attachments)),
    };
  } catch {
    return emptyState();
  }
}

/** Applies `change` to the stored state and saves it. */
export function updateLocalState(
  accountId: string,
  change: (state: Pop3LocalState) => void,
): Promise<void> {
  return serialized(accountId, async () => {
    const state = await readLocalState(accountId);
    change(state);
    await writeAtomic(
      path.join(accountDir(accountId), "state.json"),
      JSON.stringify({
        read: [...state.read],
        starred: [...state.starred],
        attachments: Object.fromEntries(state.attachments),
      }),
    );
  });
}

const folderDir = (accountId: string, folder: LocalFolder) =>
  path.join(accountDir(accountId), folder);

/** Local message names are generated UUIDs; nothing else is ever a path. */
const isLocalName = (name: string) => /^[0-9a-f-]{36}$/.test(name);

/** Stores a raw message and returns its name. */
export async function addLocalMessage(
  accountId: string,
  folder: LocalFolder,
  raw: string | Buffer,
): Promise<string> {
  const name = randomUUID();
  await writeAtomic(path.join(folderDir(accountId, folder), `${name}.eml`), raw);
  return name;
}

export async function readLocalMessage(
  accountId: string,
  folder: LocalFolder,
  name: string,
): Promise<Buffer | null> {
  if (!isLocalName(name)) return null;
  try {
    return await readFile(path.join(folderDir(accountId, folder), `${name}.eml`));
  } catch {
    return null;
  }
}

/** Deletes a stored message; one already gone counts as deleted. */
export async function removeLocalMessage(accountId: string, folder: LocalFolder, name: string) {
  if (!isLocalName(name)) return;
  await rm(path.join(folderDir(accountId, folder), `${name}.eml`), { force: true });
}

/** The folder's messages, most recently stored first. */
export async function listLocalMessages(
  accountId: string,
  folder: LocalFolder,
): Promise<{ name: string; storedAt: number }[]> {
  let files: string[];
  try {
    files = await readdir(folderDir(accountId, folder));
  } catch {
    return [];
  }
  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith(".eml") && isLocalName(file.slice(0, -4)))
      .map(async (file) => {
        try {
          const { mtimeMs } = await stat(path.join(folderDir(accountId, folder), file));
          return [{ name: file.slice(0, -4), storedAt: mtimeMs }];
        } catch {
          return [];
        }
      }),
  );
  return entries.flat().sort((a, b) => b.storedAt - a.storedAt);
}

/** Everything kept for the account, e.g. when the account is removed. */
export async function removeLocalStore(accountId: string) {
  await serialized(accountId, () =>
    rm(accountDir(accountId), { recursive: true, force: true }),
  );
  writing.delete(accountId);
}
