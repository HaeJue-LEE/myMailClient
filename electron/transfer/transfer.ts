import { app, type BrowserWindow, dialog } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ImportChoices,
  type ImportPreview,
  type ImportResult,
  SETTINGS_EXTENSION,
} from "@/features/mail/settings-transfer";
import {
  exportMailAccounts,
  getAccountOrder,
  getActiveId,
  importMailAccount,
  listMailAccounts,
  setAccountOrder,
  setActiveId,
} from "../accounts";
import { dropSessions, signOutAll } from "../auth";
import { importAvatar, readAvatarPng, removeAvatar } from "../avatars";
import { InvalidRequestError, SettingsFileError } from "../errors";
import { googleAccountId, listGoogleAccounts, storeGoogleAccount } from "../google-accounts";
import { getGoogleClient, saveCustomGoogleClient } from "../google-client";
import { dropImap } from "../imap/connection";
import { dropZohoCaches } from "../zoho/backend";
import {
  getZohoClient,
  listZohoAccounts,
  removeZohoClient,
  saveZohoClient,
  storeZohoAccount,
} from "../zoho/store";
import { decryptSettings, encryptSettings, MAX_SETTINGS_BYTES } from "./bundle";
import { readPayload, type SettingsPayload } from "./payload";
import { type ImportPlan, planImport, previewImport, type TargetState } from "./plan";

/**
 * Carrying the accounts to another computer: everything is decrypted here,
 * in the main process, and locked again with the user's passphrase; on the
 * other computer it is opened with it and stored through the usual stores,
 * which encrypt it with that computer's safeStorage (DPAPI, or the macOS
 * Keychain). Neither the file's contents nor the passphrase's key ever reach
 * the page, which sees only addresses and what will happen to them.
 */

const FILE_FILTER = { name: "Mail Client 설정", extensions: [SETTINGS_EXTENSION] };

/** A file picked for importing, held here between the steps; one at a time. */
let pending: {
  token: string;
  file: Buffer;
  payload: SettingsPayload | null;
  unreadable: number;
  expires: number;
} | null = null;
/** Long enough to read the preview and decide; the file is picked again after. */
const PENDING_MS = 30 * 60 * 1000;

function pendingFor(token: string) {
  if (!pending || pending.token !== token || pending.expires < Date.now()) {
    throw new InvalidRequestError("Pick the settings file again");
  }
  return pending;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * This computer's accounts as a settings file holds them. Without secrets,
 * only the IMAP/POP3 accounts' settings: a Google or Zoho account is nothing
 * but its sign-in, and a client is a secret too.
 */
async function collect(includeSecrets: boolean): Promise<{ payload: SettingsPayload; accounts: number }> {
  const [mail, { client: googleClient }, zohoClient, zohoAccounts, order, activeId] =
    await Promise.all([
      exportMailAccounts(),
      getGoogleClient(),
      getZohoClient(),
      listZohoAccounts(),
      getAccountOrder(),
      getActiveId(),
    ]);
  // Without its client a sign-in is of no use, here or there.
  const googleAccounts = includeSecrets && googleClient ? await listGoogleAccounts() : [];
  const zoho = includeSecrets && zohoClient ? zohoAccounts : [];
  const mailAccounts = includeSecrets ? mail : mail.map((account) => ({ ...account, password: null }));
  const ids = [...mailAccounts, ...googleAccounts, ...zoho].map((account) => account.id);
  const avatars: Record<string, string> = {};
  for (const id of ids) {
    const png = await readAvatarPng(id);
    if (png) avatars[id] = png.toString("base64");
  }
  return {
    payload: {
      exportedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      mail: { accounts: mailAccounts },
      google: { client: includeSecrets ? googleClient : null, accounts: googleAccounts },
      zoho: { client: includeSecrets ? zohoClient : null, accounts: zoho },
      order,
      activeId,
      avatars,
    },
    accounts: ids.length,
  };
}

/** Saves this computer's accounts to a settings file the user picks; `saved` is false when cancelled. */
export async function exportSettings(
  window: BrowserWindow | null,
  passphrase: string,
  { includeSecrets }: { includeSecrets: boolean },
) {
  const { payload, accounts } = await collect(includeSecrets);
  if (accounts === 0) throw new InvalidRequestError("No account to export");
  const options = {
    title: "설정 내보내기",
    // ASCII only, so the name survives any way of carrying the file between systems.
    defaultPath: path.join(app.getPath("documents"), `MailClient-settings-${today()}.${SETTINGS_EXTENSION}`),
    filters: [FILE_FILTER],
  };
  const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return { saved: false, accounts: 0 };
  const file = await encryptSettings(payload, passphrase);
  await writeFile(choice.filePath, file, { mode: 0o600 });
  return { saved: true, accounts };
}

/** Asks for a settings file and holds it for the next steps; null when cancelled. */
export async function chooseSettingsFile(window: BrowserWindow | null) {
  const options = {
    title: "설정 가져오기",
    properties: ["openFile" as const],
    // Any file too: a messenger or a mail may have renamed it on the way.
    filters: [FILE_FILTER, { name: "모든 파일", extensions: ["*"] }],
  };
  const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const picked = choice.filePaths[0];
  if (choice.canceled || !picked) return null;
  if ((await stat(picked)).size > MAX_SETTINGS_BYTES) throw new SettingsFileError("not_settings_file");
  const token = randomUUID();
  pending = {
    token,
    file: await readFile(picked),
    payload: null,
    unreadable: 0,
    expires: Date.now() + PENDING_MS,
  };
  return { token, fileName: path.basename(picked) };
}

async function targetState(): Promise<TargetState> {
  const [mail, google, zoho, { client: googleClient }, zohoClient, order, activeId] =
    await Promise.all([
      listMailAccounts(),
      listGoogleAccounts(),
      listZohoAccounts(),
      getGoogleClient(),
      getZohoClient(),
      getAccountOrder(),
      getActiveId(),
    ]);
  return {
    mailAccounts: mail.map(({ id, email }) => ({ id, email })),
    googleAccounts: googleClient ? google.map(({ id, email }) => ({ id, email })) : [],
    zohoAccounts: zohoClient ? zoho.map(({ id }) => ({ id })) : [],
    googleClientId: googleClient?.clientId ?? null,
    zohoClientId: zohoClient?.clientId ?? null,
    order,
    activeId,
  };
}

/** Opens the file picked with its passphrase and says what importing it would do. */
export async function openSettingsFile(token: string, passphrase: string): Promise<ImportPreview> {
  const held = pendingFor(token);
  const read = readPayload(await decryptSettings(held.file, passphrase));
  if (!read) throw new SettingsFileError("not_settings_file");
  held.payload = read.payload;
  held.unreadable = read.unreadable;
  return { token, unreadable: read.unreadable, ...previewImport(read.payload, await targetState()) };
}

async function replaceGoogleClient() {
  // Their sign-ins cannot be refreshed with another client; as when the client is removed.
  for (const id of await signOutAll({ revoke: true })) await removeAvatar(id);
}

async function replaceZohoClient() {
  for (const id of await removeZohoClient()) {
    dropZohoCaches(id);
    await removeAvatar(id);
  }
}

async function apply(plan: ImportPlan, payload: SettingsPayload): Promise<ImportResult> {
  const before = await targetState();
  const removed = new Set<string>();
  if (plan.googleClient === "replace") {
    before.googleAccounts.forEach((account) => removed.add(account.id));
    await replaceGoogleClient();
  }
  if (plan.googleClient !== "keep" && payload.google.client) {
    await saveCustomGoogleClient(payload.google.client);
  }
  if (plan.zohoClient === "replace") {
    before.zohoAccounts.forEach((account) => removed.add(account.id));
    await replaceZohoClient();
  }
  if (plan.zohoClient !== "keep" && payload.zoho.client) {
    await saveZohoClient(payload.zoho.client);
  }

  const items: ImportResult["items"] = plan.left.map(({ key, kind, email, outcome }) => ({
    key,
    kind,
    email,
    outcome,
  }));
  const done = new Set<string>();
  /** Ids the stores gave that differ from the plan's (see the Google accounts below). */
  const renamed = new Map<string, string>();
  const finalId = (id: string) => renamed.get(id) ?? id;
  const attempt = async (
    entry: { key: string; targetId: string; outcome: ImportResult["items"][number]["outcome"] },
    kind: ImportResult["items"][number]["kind"],
    email: string,
    work: () => Promise<void>,
  ) => {
    try {
      await work();
      done.add(entry.targetId);
      items.push({ key: entry.key, kind, email, outcome: entry.outcome });
    } catch (error) {
      console.warn(`[settings import] ${kind} account not imported:`, (error as Error).message);
      items.push({ key: entry.key, kind, email, outcome: "failed" });
    }
  };

  for (const entry of plan.mail) {
    await attempt(entry, entry.account.protocol, entry.account.email, async () => {
      // An open connection may still use the settings it replaces.
      dropImap(entry.targetId);
      await importMailAccount({ ...entry.account, id: entry.targetId });
    });
  }
  for (const entry of plan.google) {
    await attempt(entry, "gmail", entry.account.email, async () => {
      const stored = await storeGoogleAccount(entry.account.email, entry.account.refreshToken);
      // An address left in google.bin without a client keeps its old id: the store decides.
      if (stored.id !== entry.targetId) renamed.set(entry.targetId, stored.id);
    });
  }
  // A session open with an old token or client would keep using it.
  if (plan.google.length > 0 || plan.googleClient !== "keep") dropSessions();
  for (const entry of plan.zoho) {
    await attempt(entry, "zoho", entry.account.email, async () => {
      dropZohoCaches(entry.targetId);
      await storeZohoAccount(entry.account);
    });
  }

  for (const { targetId, png } of plan.avatars) {
    if (!done.has(targetId)) continue;
    // A picture that does not come through leaves the first letter; the account is what matters.
    await importAvatar(finalId(targetId), Buffer.from(png, "base64")).catch(() => false);
  }
  if (plan.order) {
    const order = plan.order.filter((id) => done.has(id) || !removed.has(id)).map(finalId);
    await setAccountOrder(order);
  }
  if (plan.activeId !== undefined) {
    await setActiveId(plan.activeId && done.has(plan.activeId) ? finalId(plan.activeId) : null);
  } else if (before.activeId && removed.has(before.activeId)) {
    await setActiveId(null);
  }

  // In the file's order, as the preview showed them.
  const rank = new Map(
    previewImport(payload, before).items.map((item, index) => [item.key, index]),
  );
  items.sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  return {
    items,
    imported: items.filter((item) => ["added", "replaced", "needs_password"].includes(item.outcome))
      .length,
  };
}

/** Imports the opened file as the user chose. The file is let go afterwards. */
export async function importSettings(token: string, choices: ImportChoices): Promise<ImportResult> {
  const held = pendingFor(token);
  if (!held.payload) throw new InvalidRequestError("Open the settings file first");
  const { payload } = held;
  pending = null;
  const plan = planImport(payload, await targetState(), choices, {
    newId: randomUUID,
    googleIdFor: googleAccountId,
  });
  return apply(plan, payload);
}
