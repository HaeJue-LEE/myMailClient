import { app, Notification, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ComposeAttachment, SendMessageInput } from "@/features/mail/bridge";
import type { Account } from "@/features/mail/mail-accounts";
import { isSchedulable, type ScheduledMail } from "@/features/mail/scheduled";
import { backendForAccountId, type MailBackend } from "./backend";
import { InvalidRequestError, toErrorCode } from "./errors";

/**
 * Scheduled sending (see features/mail/scheduled.ts). Each scheduled message
 * is kept whole, attachments included, in its own file under
 * userData/scheduled, and the list of them in index.bin; both encrypted with
 * safeStorage. Its draft, if it had one, is deleted when it is scheduled, so
 * the message lives in one place only. A check every 30 seconds sends what is
 * due, through the account it was written in.
 *
 * A message is marked `sending` (on disk) before it goes out. One still
 * marked so when the app starts was cut off mid-send: it may or may not have
 * left, so it is never sent again by itself (`interrupted`).
 */

const CHECK_INTERVAL_MS = 30 * 1000;
const FIRST_CHECK_DELAY_MS = 5 * 1000;

const entrySchema = z.object({
  id: z.string().uuid(),
  accountId: z.string(),
  accountEmail: z.string(),
  sendAt: z.number(),
  subject: z.string(),
  to: z.array(z.string()),
  attachmentCount: z.number(),
  createdAt: z.number(),
  status: z.enum(["pending", "sending", "failed"]),
  error: z.string().optional(),
  interrupted: z.boolean().optional(),
});
type Entry = z.infer<typeof entrySchema>;

const dir = () => path.join(app.getPath("userData"), "scheduled");
const indexFile = () => path.join(dir(), "index.bin");
const payloadFile = (id: string) => path.join(dir(), `${id}.bin`);

let loaded: Promise<Entry[]> | null = null;
let writing: Promise<unknown> = Promise.resolve();
/** Ids being sent now, so the timer and "send now" never send one twice. */
const inFlight = new Set<string>();

function encrypt(text: string) {
  // Refuse rather than fall back to keeping mail in plain text.
  if (!safeStorage.isEncryptionAvailable()) throw new Error("safeStorage encryption is unavailable");
  return safeStorage.encryptString(text);
}

async function writeAtomic(file: string, data: Buffer) {
  await mkdir(dir(), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
}

async function readIndex(): Promise<Entry[]> {
  try {
    const parsed = z
      .array(entrySchema)
      .safeParse(JSON.parse(safeStorage.decryptString(await readFile(indexFile()))));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const entries = () => (loaded ??= readIndex());

async function saveIndex(list: Entry[]) {
  const data = encrypt(JSON.stringify(list));
  writing = writing.catch(() => undefined).then(() => writeAtomic(indexFile(), data));
  await writing;
}

/** Attachments as JSON: file bytes in base64. */
type StoredInput = Omit<SendMessageInput, "attachments"> & {
  attachments?: (Exclude<ComposeAttachment, { kind: "file" }> | {
    kind: "file";
    filename: string;
    mimeType: string;
    data: string;
  })[];
};

async function savePayload(id: string, input: SendMessageInput) {
  const stored: StoredInput = {
    ...input,
    attachments: input.attachments?.map((item) =>
      item.kind === "file" ? { ...item, data: Buffer.from(item.data).toString("base64") } : item,
    ),
  };
  await writeAtomic(payloadFile(id), encrypt(JSON.stringify(stored)));
}

async function loadPayload(id: string): Promise<SendMessageInput> {
  const stored = JSON.parse(safeStorage.decryptString(await readFile(payloadFile(id)))) as StoredInput;
  return {
    ...stored,
    attachments: stored.attachments?.map((item) =>
      item.kind === "file" ? { ...item, data: new Uint8Array(Buffer.from(item.data, "base64")) } : item,
    ),
  };
}

const summary = (entry: Entry): ScheduledMail => ({
  ...entry,
  error: entry.error as ScheduledMail["error"],
});

export async function listScheduled(): Promise<ScheduledMail[]> {
  return [...(await entries())].sort((a, b) => a.sendAt - b.sendAt).map(summary);
}

async function update(id: string, change: (entry: Entry) => Entry | null) {
  const list = await entries();
  const index = list.findIndex((entry) => entry.id === id);
  if (index < 0) throw new InvalidRequestError("No such scheduled mail");
  const next = change(list[index]);
  if (next) list[index] = next;
  else list.splice(index, 1);
  await saveIndex(list);
  return next;
}

async function forget(id: string) {
  await update(id, () => null);
  await rm(payloadFile(id), { force: true });
}

/**
 * Keeps `input` to be sent from `account` at `sendAt`. Its draft, if any, is
 * deleted afterwards: from then on this is the only copy.
 */
export async function scheduleSend(
  account: Account,
  backend: MailBackend,
  input: SendMessageInput,
  sendAt: number,
): Promise<ScheduledMail> {
  if (!isSchedulable(sendAt)) throw new InvalidRequestError("The time is not in the allowed range");
  const { draftId, ...message } = input;
  const entry: Entry = {
    id: randomUUID(),
    accountId: account.id,
    accountEmail: account.email,
    sendAt,
    subject: message.subject,
    to: message.to,
    attachmentCount: message.attachments?.length ?? 0,
    createdAt: Date.now(),
    status: "pending",
  };
  await savePayload(entry.id, message);
  const list = await entries();
  list.push(entry);
  await saveIndex(list);
  if (draftId) {
    await backend.deleteDraft(draftId).catch((error: Error) => {
      // The draft stays behind; the schedule stands.
      console.warn("[scheduled] the draft was not deleted", error.message);
    });
  }
  return summary(entry);
}

export async function rescheduleSend(id: string, sendAt: number): Promise<ScheduledMail> {
  if (!isSchedulable(sendAt)) throw new InvalidRequestError("The time is not in the allowed range");
  if (inFlight.has(id)) throw new InvalidRequestError("It is being sent");
  const next = await update(id, (entry) => ({
    ...entry,
    sendAt,
    status: "pending",
    error: undefined,
    interrupted: undefined,
  }));
  return summary(next as Entry);
}

/**
 * Stops a scheduled message. Kept (the default): it goes back to its
 * account's drafts, and the draft's id is returned. `discard` drops it.
 */
export async function cancelScheduled(
  id: string,
  { discard }: { discard: boolean },
): Promise<{ draftId: string | null }> {
  if (inFlight.has(id)) throw new InvalidRequestError("It is being sent");
  let draftId: string | null = null;
  if (!discard) {
    const entry = (await entries()).find((item) => item.id === id);
    if (!entry) throw new InvalidRequestError("No such scheduled mail");
    const target = await backendForAccountId(entry.accountId);
    if (!target) throw new InvalidRequestError("The account is gone; discard it instead");
    ({ draftId } = await target.backend.saveDraft(await loadPayload(id)));
  }
  await forget(id);
  return { draftId };
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

/** Sends one scheduled message now; resolves when it went or failed (never throws). */
async function sendOne(id: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const entry = (await entries()).find((item) => item.id === id);
    if (!entry || entry.status === "sending") return;
    await update(id, (current) => ({ ...current, status: "sending", error: undefined }));
    try {
      const target = await backendForAccountId(entry.accountId);
      if (!target) throw new InvalidRequestError("The account is gone");
      await target.backend.sendMessage(await loadPayload(id));
    } catch (error) {
      const code = toErrorCode(error, () => false);
      console.warn("[scheduled] send failed", code, (error as Error).message);
      await update(id, (current) => ({ ...current, status: "failed", error: code }));
      notify("예약 메일을 보내지 못했습니다", `${entry.subject || "(제목 없음)"} · ${entry.accountEmail}`);
      return;
    }
    await forget(id);
    const late = Date.now() - entry.sendAt > 2 * CHECK_INTERVAL_MS;
    notify(
      late ? "예약 메일을 늦게 보냈습니다" : "예약 메일을 보냈습니다",
      `${entry.subject || "(제목 없음)"} → ${entry.to.join(", ")}`,
    );
  } finally {
    inFlight.delete(id);
  }
}

/** Sends a scheduled message at once (e.g. a failed one, again). */
export async function sendScheduledNow(id: string): Promise<void> {
  const entry = (await entries()).find((item) => item.id === id);
  if (!entry) throw new InvalidRequestError("No such scheduled mail");
  if (entry.status === "sending") {
    // Cut off mid-send before: the user has looked and asks to send again.
    await update(id, (current) => ({ ...current, status: "failed", interrupted: undefined }));
  }
  await sendOne(id);
}

async function sendDue() {
  const now = Date.now();
  // One after another: a burst of due mail should not open many connections.
  for (const entry of await entries()) {
    if (entry.status === "pending" && entry.sendAt <= now) await sendOne(entry.id);
  }
}

/** Starts sending due messages; one cut off mid-send last time is held back. */
export function startScheduler() {
  void (async () => {
    const list = await entries();
    if (list.some((entry) => entry.status === "sending")) {
      for (const entry of list) {
        if (entry.status === "sending") Object.assign(entry, { status: "failed", interrupted: true });
      }
      await saveIndex(list).catch(() => undefined);
    }
  })();
  setTimeout(() => void sendDue(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void sendDue(), CHECK_INTERVAL_MS);
}
