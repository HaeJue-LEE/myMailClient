import { app, safeStorage } from "electron";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ZOHO_REGIONS, type ZohoRegion } from "@/features/mail/zoho";

/**
 * The Zoho API client the user created (api-console.zoho.com, "Non-browser
 * Applications") and the Zoho accounts signed in with it, kept on this
 * computer in one file encrypted with safeStorage (DPAPI on Windows). Nothing
 * here is built into the app.
 */

export const zohoClientSchema = z.object({
  clientId: z.string().trim().min(10).max(200).regex(/^\S+$/),
  clientSecret: z.string().trim().min(10).max(200).regex(/^\S+$/),
  /** The data center the client was created in (api-console.zoho.com is "us"). */
  region: z.enum(Object.keys(ZOHO_REGIONS) as [ZohoRegion, ...ZohoRegion[]]),
});
export type ZohoClient = z.infer<typeof zohoClientSchema>;

const accountSchema = z.object({
  /** The app's id for the account: `zoho-<Zoho account id>`. */
  id: z.string().min(1),
  email: z.string(),
  name: z.string(),
  /** Zoho's account id (digits), in every Mail API path. */
  zohoAccountId: z.string().regex(/^\d+$/),
  /** Where the user's Zoho account lives, e.g. https://accounts.zoho.com. */
  accountsServer: z.string().url(),
  refreshToken: z.string().min(1),
});
export type ZohoAccount = z.infer<typeof accountSchema>;

const fileSchema = z.object({
  client: zohoClientSchema.nullable().default(null),
  accounts: z.array(accountSchema).default([]),
});
type ZohoFile = z.infer<typeof fileSchema>;

let loaded: Promise<ZohoFile> | null = null;
let writing: Promise<unknown> = Promise.resolve();

const filePath = () => path.join(app.getPath("userData"), "zoho.bin");

async function read(): Promise<ZohoFile> {
  try {
    const parsed = fileSchema.safeParse(
      JSON.parse(safeStorage.decryptString(await readFile(filePath()))),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Missing, or written by another Windows user: start empty.
  }
  return { client: null, accounts: [] };
}

const load = () => (loaded ??= read());

async function persist(file: ZohoFile) {
  // Refuse rather than fall back to storing secrets in plain text.
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

export async function getZohoClient(): Promise<ZohoClient | null> {
  return (await load()).client;
}

export async function saveZohoClient(client: ZohoClient) {
  const file = await load();
  file.client = zohoClientSchema.parse(client);
  await persist(file);
}

/**
 * Forgets the client. Its sign-ins cannot be refreshed without it, so the
 * accounts go too; returns their ids.
 */
export async function removeZohoClient(): Promise<string[]> {
  const file = await load();
  const ids = file.accounts.map((account) => account.id);
  file.client = null;
  file.accounts = [];
  await persist(file);
  return ids;
}

export async function listZohoAccounts(): Promise<ZohoAccount[]> {
  return [...(await load()).accounts];
}

export async function getZohoAccount(id: string): Promise<ZohoAccount | null> {
  return (await load()).accounts.find((account) => account.id === id) ?? null;
}

/** Adds the account, or replaces the one with the same id (signing in again). */
export async function storeZohoAccount(account: ZohoAccount) {
  const file = await load();
  const stored = accountSchema.parse(account);
  const index = file.accounts.findIndex((item) => item.id === stored.id);
  if (index >= 0) file.accounts[index] = stored;
  else file.accounts.push(stored);
  await persist(file);
}

export async function removeZohoAccount(id: string): Promise<boolean> {
  const file = await load();
  const remaining = file.accounts.filter((account) => account.id !== id);
  if (remaining.length === file.accounts.length) return false;
  file.accounts = remaining;
  await persist(file);
  return true;
}
