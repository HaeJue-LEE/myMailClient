import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendMessageInput } from "@/features/mail/bridge";
import type { Account } from "@/features/mail/mail-accounts";
import type { MailBackend } from "./backend";

let userData = "";
const shown: { title: string; body: string }[] = [];
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`),
    decryptString: (data: Buffer) => {
      const text = data.toString();
      if (!text.startsWith("enc:")) throw new Error("not encrypted");
      return Buffer.from(text.slice(4), "base64").toString();
    },
  },
  Notification: class {
    static isSupported = () => true;
    constructor(private readonly options: { title: string; body: string }) {}
    show() {
      shown.push(this.options);
    }
  },
}));

const sent: SendMessageInput[] = [];
const drafts: SendMessageInput[] = [];
const deletedDrafts: string[] = [];
let sendFails = false;
const backend = {
  sendMessage: async (input: SendMessageInput) => {
    if (sendFails) throw Object.assign(new Error("server down"), { status: 500 });
    sent.push(input);
    return { id: "m", threadId: "" };
  },
  saveDraft: async (input: SendMessageInput) => {
    drafts.push(input);
    return { draftId: `draft-${drafts.length}` };
  },
  deleteDraft: async (id: string) => {
    deletedDrafts.push(id);
  },
} as unknown as MailBackend;
const account: Account = { id: "acc-1", kind: "imap", email: "me@example.com", name: "" };
let accountExists = true;
vi.mock("./backend", () => ({
  backendForAccountId: async (id: string) => (accountExists && id === account.id ? { account, backend } : null),
}));

const message = (overrides: Partial<SendMessageInput> = {}): SendMessageInput => ({
  to: ["you@example.com"],
  cc: [],
  bcc: [],
  subject: "주간 보고",
  text: "본문",
  html: "<p>본문</p>",
  attachments: [{ kind: "file", filename: "a.txt", mimeType: "text/plain", data: new Uint8Array([104, 105]) }],
  draftId: "draft-old",
  ...overrides,
});

/** A fresh module, as after an app restart. */
const fresh = async () => {
  vi.resetModules();
  return import("./scheduled");
};

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "mc-scheduled-"));
  sent.length = 0;
  drafts.length = 0;
  deletedDrafts.length = 0;
  shown.length = 0;
  sendFails = false;
  accountExists = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 12, 10, 0));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(userData, { recursive: true, force: true });
});

const inAnHour = () => Date.now() + 60 * 60 * 1000;

describe("scheduled sending", () => {
  it("keeps the message encrypted and replaces its draft", async () => {
    const scheduled = await fresh();
    const mail = await scheduled.scheduleSend(account, backend, message(), inAnHour());
    expect(mail).toMatchObject({ subject: "주간 보고", to: ["you@example.com"], attachmentCount: 1, status: "pending" });
    expect(deletedDrafts).toEqual(["draft-old"]);
    // Nothing on disk in the clear.
    const dir = path.join(userData, "scheduled");
    for (const file of await readdir(dir)) {
      expect((await readFile(path.join(dir, file))).toString()).not.toContain("주간 보고");
    }
    // Still there after a restart.
    expect((await (await fresh()).listScheduled()).map((item) => item.id)).toEqual([mail.id]);
  });

  it("refuses times too soon", async () => {
    const scheduled = await fresh();
    await expect(scheduled.scheduleSend(account, backend, message(), Date.now() + 1000)).rejects.toThrow();
  });

  it("sends now, with its attachments, through its account and then forgets it", async () => {
    const scheduled = await fresh();
    const mail = await scheduled.scheduleSend(account, backend, message(), inAnHour());
    await scheduled.sendScheduledNow(mail.id);
    expect(sent).toHaveLength(1);
    expect(sent[0].draftId).toBeUndefined();
    expect(Array.from((sent[0].attachments?.[0] as { data: Uint8Array }).data)).toEqual([104, 105]);
    expect(await scheduled.listScheduled()).toEqual([]);
    expect(shown[0].title).toBe("예약 메일을 보냈습니다");
  });

  it("keeps a failed one, marked, for the user", async () => {
    const scheduled = await fresh();
    const mail = await scheduled.scheduleSend(account, backend, message(), inAnHour());
    sendFails = true;
    await scheduled.sendScheduledNow(mail.id);
    const [failed] = await scheduled.listScheduled();
    expect(failed).toMatchObject({ id: mail.id, status: "failed" });
    expect(failed.error).toBeDefined();
    // Retried later, it goes.
    sendFails = false;
    await scheduled.sendScheduledNow(mail.id);
    expect(sent).toHaveLength(1);
  });

  it("goes back to drafts when cancelled, or is dropped", async () => {
    const scheduled = await fresh();
    const kept = await scheduled.scheduleSend(account, backend, message({ subject: "keep" }), inAnHour());
    const dropped = await scheduled.scheduleSend(account, backend, message({ subject: "drop" }), inAnHour());
    expect(await scheduled.cancelScheduled(kept.id, { discard: false })).toEqual({ draftId: "draft-1" });
    expect(drafts.map((draft) => draft.subject)).toEqual(["keep"]);
    expect(await scheduled.cancelScheduled(dropped.id, { discard: true })).toEqual({ draftId: null });
    expect(drafts).toHaveLength(1);
    expect(await scheduled.listScheduled()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("cannot go back to drafts of an account that is gone, but can be dropped", async () => {
    const scheduled = await fresh();
    const mail = await scheduled.scheduleSend(account, backend, message(), inAnHour());
    accountExists = false;
    await expect(scheduled.cancelScheduled(mail.id, { discard: false })).rejects.toThrow();
    await scheduled.cancelScheduled(mail.id, { discard: true });
    expect(await scheduled.listScheduled()).toEqual([]);
  });

  it("changes the time and clears a failure", async () => {
    const scheduled = await fresh();
    const mail = await scheduled.scheduleSend(account, backend, message(), inAnHour());
    sendFails = true;
    await scheduled.sendScheduledNow(mail.id);
    const later = inAnHour() + 60 * 60 * 1000;
    expect(await scheduled.rescheduleSend(mail.id, later)).toMatchObject({ sendAt: later, status: "pending" });
    expect((await scheduled.listScheduled())[0].error).toBeUndefined();
  });
});
