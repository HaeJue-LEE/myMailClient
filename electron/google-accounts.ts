import { app, safeStorage } from "electron";
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GMAIL_ACCOUNT_ID } from "@/features/mail/mail-accounts";

/**
 * The Google accounts signed in (Gmail API), each with its refresh token,
 * kept on this computer in one file encrypted with safeStorage (DPAPI on
 * Windows, the Keychain on macOS).
 *
 * Before several accounts were possible, the one sign-in lived in
 * `account.bin`. It is copied here on first read and keeps its account id
 * (`gmail`), so what refers to that id (the account in use, the order of
 * accounts, its picture, scheduled mail) stays with it. `account.bin` stays
 * until that account is removed, so an older version of the app sharing
 * this folder keeps its sign-in.
 */

const accountSchema = z.object({
  /** The app's id for the account: `gmail` (the first one) or `gmail-<hash of the address>`. */
  id: z.string().min(1).max(64),
  email: z.string().min(1),
  refreshToken: z.string().min(1),
});
export type GoogleAccount = z.infer<typeof accountSchema>;

const fileSchema = z.object({ accounts: z.array(accountSchema).default([]) });
type GoogleFile = z.infer<typeof fileSchema>;

const legacySchema = z.object({ email: z.string().min(1), refreshToken: z.string().min(1) });

let loaded: Promise<GoogleFile> | null = null;
let writing: Promise<unknown> = Promise.resolve();

const filePath = () => path.join(app.getPath("userData"), "google.bin");
const legacyPath = () => path.join(app.getPath("userData"), "account.bin");

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The id a newly signed-in address gets: the same one each time for the same address. */
export function googleAccountId(email: string) {
  const hash = createHash("sha256").update(email.toLowerCase()).digest("hex");
  return `${GMAIL_ACCOUNT_ID}-${hash.slice(0, 16)}`;
}

async function decrypt(file: string): Promise<unknown> {
  return JSON.parse(safeStorage.decryptString(await readFile(file)));
}

async function readLegacy(): Promise<GoogleAccount | null> {
  try {
    const parsed = legacySchema.safeParse(await decrypt(legacyPath()));
    return parsed.success ? { id: GMAIL_ACCOUNT_ID, ...parsed.data } : null;
  } catch {
    return null;
  }
}

async function read(): Promise<GoogleFile> {
  try {
    const parsed = fileSchema.safeParse(await decrypt(filePath()));
    if (parsed.success) return parsed.data;
  } catch (error) {
    // Written by another OS user, or damaged: start empty, as before.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { accounts: [] };
  }
  const legacy = await readLegacy();
  const file = { accounts: legacy ? [legacy] : [] };
  if (legacy) {
    try {
      await persist(file);
    } catch {
      // Copied on a later start.
    }
  }
  return file;
}

const load = () => (loaded ??= read());

async function persist(file: GoogleFile) {
  // Refuse rather than fall back to storing tokens in plain text.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("safeStorage encryption is unavailable");
  }
  const data = safeStorage.encryptString(JSON.stringify(file));
  writing = writing
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${filePath()}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, filePath());
    });
  await writing;
}

export async function listGoogleAccounts(): Promise<GoogleAccount[]> {
  return [...(await load()).accounts];
}

export async function getGoogleAccount(id: string): Promise<GoogleAccount | null> {
  return (await load()).accounts.find((account) => account.id === id) ?? null;
}

/**
 * Keeps a sign-in. Signing in again to an address already here replaces its
 * token and keeps its id; another address is added. Returns the stored account.
 */
export async function storeGoogleAccount(email: string, refreshToken: string): Promise<GoogleAccount> {
  const file = await load();
  const index = file.accounts.findIndex((account) => sameAddress(account.email, email));
  const id = index >= 0 ? file.accounts[index].id : googleAccountId(email);
  const stored = accountSchema.parse({ id, email, refreshToken });
  if (index >= 0) file.accounts[index] = stored;
  else file.accounts.push(stored);
  await persist(file);
  return stored;
}

/** Google handed out a new refresh token for the account. */
export async function updateGoogleToken(id: string, refreshToken: string) {
  const file = await load();
  const account = file.accounts.find((item) => item.id === id);
  if (!account || account.refreshToken === refreshToken) return;
  account.refreshToken = refreshToken;
  await persist(file);
}

/** Forgets the account; returns it, or null when it was not here. */
export async function removeGoogleAccount(id: string): Promise<GoogleAccount | null> {
  const file = await load();
  const account = file.accounts.find((item) => item.id === id) ?? null;
  if (!account) return null;
  file.accounts = file.accounts.filter((item) => item !== account);
  await persist(file);
  // Gone for an older version of the app too.
  if (id === GMAIL_ACCOUNT_ID) await rm(legacyPath(), { force: true });
  return account;
}
