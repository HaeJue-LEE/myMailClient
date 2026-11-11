import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isEmail } from "@/features/mail/email";
import {
  INCOMING_PROTOCOLS,
  type MailAccountInput,
  type MailAccountSettings,
  SECURITY_MODES,
} from "@/features/mail/mail-accounts";
import { InvalidRequestError } from "./errors";

/**
 * IMAP/SMTP and POP3/SMTP accounts and which account is in use, kept on this computer.
 * Passwords are encrypted with safeStorage (DPAPI on Windows) before they
 * reach the file and are never returned to the renderer. The Google account
 * is stored separately (see auth.ts).
 */
const endpointSchema = z.object({
  host: z.string(),
  port: z.number(),
  security: z.enum(SECURITY_MODES),
});
const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  username: z.string(),
  /** Accounts saved before POP3 was supported have no protocol: they are IMAP. */
  protocol: z.enum(INCOMING_PROTOCOLS).default("imap"),
  /** Base64 of the safeStorage-encrypted password. */
  password: z.string().optional(),
  incoming: endpointSchema,
  outgoing: endpointSchema,
  saveSentCopy: z.boolean(),
  /** Absent in files written before the option existed. */
  sendCopyToSelf: z.boolean().default(false),
});
const fileSchema = z.object({
  activeId: z.string().nullable(),
  accounts: z.array(accountSchema),
  /**
   * The order accounts are listed in, by id (the Google account included);
   * absent until the user first reorders them.
   */
  order: z.array(z.string()).default([]),
});
type StoredAccount = z.infer<typeof accountSchema>;
type AccountsFile = z.infer<typeof fileSchema>;

/** An account with its password in the clear; for the main process only. */
export type MailAccountCredentials = Omit<StoredAccount, "password"> & {
  password: string;
};

/**
 * The earlier single-configuration file (`server-settings.json`), keyed by the
 * Google address. Its IMAP entries become accounts so nothing saved is lost.
 */
const legacySchema = z.object({
  accounts: z.record(
    z.string(),
    z.object({
      incoming: endpointSchema.extend({
        protocol: z.string(),
        username: z.string(),
        password: z.string().optional(),
      }),
      outgoing: endpointSchema,
    }),
  ),
});

/** Read once, then changed in memory; the promise is shared by concurrent first calls. */
let loaded: Promise<AccountsFile> | null = null;
/** Writes run one after another, so concurrent changes cannot interleave. */
let writing: Promise<unknown> = Promise.resolve();

const filePath = () => path.join(app.getPath("userData"), "accounts.json");
const legacyPath = () => path.join(app.getPath("userData"), "server-settings.json");

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function migrateLegacy(): Promise<AccountsFile> {
  const legacy = legacySchema.safeParse(await readJson(legacyPath()));
  const empty: AccountsFile = { activeId: null, accounts: [], order: [] };
  if (!legacy.success) return empty;
  const accounts = Object.values(legacy.data.accounts).flatMap(
    ({ incoming, outgoing }): StoredAccount[] => {
      const { protocol, username, password, ...server } = incoming;
      // POP3 was never usable, and an account needs an address to send from.
      if (protocol !== "imap" || !isEmail(username)) return [];
      return [
        {
          id: randomUUID(),
          name: "",
          email: username.toLowerCase(),
          username,
          protocol: "imap",
          password,
          incoming: server,
          outgoing,
          saveSentCopy: true,
          sendCopyToSelf: false,
        },
      ];
    },
  );
  if (accounts.length === 0) return empty;
  const file = { activeId: null, accounts, order: [] };
  await persist(file);
  return file;
}

async function readAccountsFile(): Promise<AccountsFile> {
  const raw = await readJson(filePath());
  if (raw === undefined) return migrateLegacy();
  const parsed = fileSchema.safeParse(raw);
  // Damaged: start empty; the next save rewrites it.
  return parsed.success ? parsed.data : { activeId: null, accounts: [], order: [] };
}

function load() {
  loaded ??= readAccountsFile();
  return loaded;
}

async function persist(file: AccountsFile) {
  const json = JSON.stringify(file, null, 2);
  // Write to a temporary file and rename, so a crash cannot leave half a file.
  writing = writing
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${filePath()}.tmp`;
      await writeFile(temporary, json, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, filePath());
    });
  await writing;
}

function encrypt(password: string) {
  // Refuse rather than fall back to storing the password in plain text.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("safeStorage encryption is unavailable");
  }
  return safeStorage.encryptString(password).toString("base64");
}

function decrypt(encrypted: string | undefined) {
  if (!encrypted) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
}

function toSettings(stored: StoredAccount): MailAccountSettings {
  const { password, ...rest } = stored;
  return { ...rest, hasPassword: Boolean(password) };
}

export async function listMailAccounts(): Promise<MailAccountSettings[]> {
  return (await load()).accounts.map(toSettings);
}

export async function getMailAccount(id: string): Promise<MailAccountSettings | null> {
  const stored = (await load()).accounts.find((account) => account.id === id);
  return stored ? toSettings(stored) : null;
}

/** The account with its password decrypted, or null when it cannot sign in. */
export async function getMailCredentials(
  id: string,
): Promise<MailAccountCredentials | null> {
  const stored = (await load()).accounts.find((account) => account.id === id);
  const password = decrypt(stored?.password);
  return stored && password !== null ? { ...stored, password } : null;
}

/**
 * What `input` would sign in with: its new password, or the stored one when
 * an existing account is edited without retyping it.
 */
export async function resolveCredentials(
  input: MailAccountInput,
): Promise<MailAccountCredentials> {
  const { id, password, ...settings } = input;
  const file = await load();
  const previous = id ? file.accounts.find((account) => account.id === id) : undefined;
  if (id && !previous) throw new InvalidRequestError("No such account");
  const email = settings.email.toLowerCase();
  if (file.accounts.some((account) => account.email === email && account.id !== id)) {
    throw new InvalidRequestError("This address is already added");
  }
  const resolved = password || decrypt(previous?.password);
  if (!resolved) throw new InvalidRequestError("A password is required");
  return { ...settings, email, id: previous?.id ?? randomUUID(), password: resolved };
}

/** Adds the account, or replaces the one with the same id. */
export async function storeMailAccount(
  credentials: MailAccountCredentials,
): Promise<MailAccountSettings> {
  const file = await load();
  const stored: StoredAccount = {
    ...credentials,
    password: encrypt(credentials.password),
  };
  const index = file.accounts.findIndex((account) => account.id === stored.id);
  if (index >= 0) file.accounts[index] = stored;
  else file.accounts.push(stored);
  await persist(file);
  return toSettings(stored);
}

/** Removes the account, its stored password included. */
export async function removeMailAccount(id: string): Promise<void> {
  const file = await load();
  const remaining = file.accounts.filter((account) => account.id !== id);
  if (remaining.length === file.accounts.length) return;
  file.accounts = remaining;
  if (file.activeId === id) file.activeId = null;
  file.order = file.order.filter((item) => item !== id);
  await persist(file);
}

/** The id last chosen as the account in use; it may no longer exist. */
export async function getActiveId(): Promise<string | null> {
  return (await load()).activeId;
}

export async function setActiveId(id: string | null): Promise<void> {
  const file = await load();
  if (file.activeId === id) return;
  file.activeId = id;
  await persist(file);
}

/** The account ids in the order the user chose; empty until they reorder. */
export async function getAccountOrder(): Promise<string[]> {
  return [...(await load()).order];
}

export async function setAccountOrder(ids: string[]): Promise<void> {
  const file = await load();
  file.order = [...new Set(ids)];
  await persist(file);
}
