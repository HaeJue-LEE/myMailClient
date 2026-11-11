import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountInput } from "@/features/mail/mail-accounts";

let userData = "";
let encryptionAvailable = true;
// A stand-in cipher: reversible, and visibly not the plain text.
const encryptString = (text: string) => Buffer.from(`enc:${[...text].reverse().join("")}`);
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString,
    decryptString: (data: Buffer) => {
      const text = data.toString();
      if (!text.startsWith("enc:")) throw new Error("not encrypted");
      return [...text.slice(4)].reverse().join("");
    },
  },
}));

/** A fresh module, as after an app restart (its in-memory cache is gone). */
const freshModule = async () => {
  vi.resetModules();
  return import("./accounts");
};

const input = (overrides: Partial<MailAccountInput> = {}): MailAccountInput => ({
  name: "홍길동",
  email: "me@naver.com",
  username: "me@naver.com",
  protocol: "imap",
  password: "s3cret",
  incoming: { host: "imap.naver.com", port: 993, security: "ssl" },
  outgoing: { host: "smtp.naver.com", port: 465, security: "ssl" },
  saveSentCopy: false,
  sendCopyToSelf: false,
  ...overrides,
});

const filePath = () => path.join(userData, "accounts.json");

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "accounts-"));
  encryptionAvailable = true;
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("mail accounts", () => {
  it("starts with no accounts", async () => {
    const store = await freshModule();
    expect(await store.listMailAccounts()).toEqual([]);
    expect(await store.getActiveId()).toBeNull();
  });

  it("stores several accounts without exposing or writing passwords", async () => {
    const store = await freshModule();
    const first = await store.storeMailAccount(await store.resolveCredentials(input()));
    const second = await store.storeMailAccount(
      await store.resolveCredentials(input({ email: "Other@Example.com", password: "0ther" })),
    );
    expect(first).toMatchObject({ email: "me@naver.com", hasPassword: true });
    expect(second.email).toBe("other@example.com");
    expect(first.id).not.toBe(second.id);
    expect(JSON.stringify([first, second])).not.toMatch(/s3cret|0ther/);
    expect(await readFile(filePath(), "utf8")).not.toMatch(/s3cret|0ther/);

    const restarted = await freshModule();
    expect((await restarted.listMailAccounts()).map((account) => account.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect((await restarted.getMailCredentials(first.id))?.password).toBe("s3cret");
    expect((await restarted.getMailCredentials(second.id))?.password).toBe("0ther");
  });

  it("keeps the stored password when an edit brings none", async () => {
    const store = await freshModule();
    const saved = await store.storeMailAccount(await store.resolveCredentials(input()));
    const edited = await store.resolveCredentials(
      input({ id: saved.id, password: undefined, name: "새 이름" }),
    );
    expect(edited).toMatchObject({ id: saved.id, password: "s3cret", name: "새 이름" });
    await store.storeMailAccount(edited);
    expect(await store.listMailAccounts()).toHaveLength(1);
    expect((await store.getMailAccount(saved.id))?.name).toBe("새 이름");
  });

  it("refuses a new account without a password, a duplicate address, or an unknown id", async () => {
    const store = await freshModule();
    await store.storeMailAccount(await store.resolveCredentials(input()));
    await expect(store.resolveCredentials(input({ email: "a@x.com", password: "" }))).rejects.toThrow();
    await expect(store.resolveCredentials(input({ email: "ME@naver.com" }))).rejects.toThrow();
    await expect(store.resolveCredentials(input({ id: "nope" }))).rejects.toThrow();
  });

  it("refuses to store a password when encryption is unavailable", async () => {
    const store = await freshModule();
    const credentials = await store.resolveCredentials(input());
    encryptionAvailable = false;
    await expect(store.storeMailAccount(credentials)).rejects.toThrow();
    expect(await (await freshModule()).listMailAccounts()).toEqual([]);
  });

  it("remembers the account in use, and forgets it when that account is removed", async () => {
    const store = await freshModule();
    const first = await store.storeMailAccount(await store.resolveCredentials(input()));
    const second = await store.storeMailAccount(
      await store.resolveCredentials(input({ email: "b@x.com" })),
    );
    await store.setActiveId(second.id);
    expect(await (await freshModule()).getActiveId()).toBe(second.id);

    const restarted = await freshModule();
    await restarted.removeMailAccount(second.id);
    expect(await restarted.getActiveId()).toBeNull();
    expect(await restarted.getMailCredentials(second.id)).toBeNull();
    expect((await restarted.listMailAccounts()).map((account) => account.id)).toEqual([first.id]);
  });

  it("reads accounts saved before POP3 was supported as IMAP accounts", async () => {
    const endpoint = { host: "imap.naver.com", port: 993, security: "ssl" };
    await writeFile(
      filePath(),
      JSON.stringify({
        activeId: "old",
        accounts: [
          {
            id: "old",
            name: "",
            email: "me@naver.com",
            username: "me@naver.com",
            password: encryptString("pw").toString("base64"),
            incoming: endpoint,
            outgoing: { ...endpoint, host: "smtp.naver.com", port: 465 },
            saveSentCopy: true,
          },
        ],
      }),
    );
    const store = await freshModule();
    expect(await store.listMailAccounts()).toMatchObject([{ id: "old", protocol: "imap" }]);
    expect(await store.getActiveId()).toBe("old");
  });

  it("keeps a POP3 account's protocol", async () => {
    const store = await freshModule();
    const saved = await store.storeMailAccount(
      await store.resolveCredentials(
        input({
          email: "me@company.co.kr",
          protocol: "pop3",
          incoming: { host: "pop3s.hiworks.com", port: 995, security: "ssl" },
        }),
      ),
    );
    expect((await (await freshModule()).getMailAccount(saved.id))?.protocol).toBe("pop3");
  });

  it("remembers the account order, and forgets removed accounts in it", async () => {
    const store = await freshModule();
    const first = await store.storeMailAccount(await store.resolveCredentials(input()));
    const second = await store.storeMailAccount(
      await store.resolveCredentials(input({ email: "b@x.com" })),
    );
    expect(await store.getAccountOrder()).toEqual([]);
    await store.setAccountOrder([second.id, "gmail", first.id, second.id]);
    // Saved without repeats, and kept across restarts.
    expect(await (await freshModule()).getAccountOrder()).toEqual([second.id, "gmail", first.id]);

    const restarted = await freshModule();
    await restarted.removeMailAccount(second.id);
    expect(await restarted.getAccountOrder()).toEqual(["gmail", first.id]);
  });

  it("starts empty when the file is damaged", async () => {
    await writeFile(filePath(), "{not json");
    const store = await freshModule();
    expect(await store.listMailAccounts()).toEqual([]);
    await store.storeMailAccount(await store.resolveCredentials(input()));
    expect(await (await freshModule()).listMailAccounts()).toHaveLength(1);
  });

  it("turns the earlier single-configuration file into accounts", async () => {
    const stored = encryptString("legacy-pw").toString("base64");
    const server = { host: "smtp.example.com", port: 587, security: "starttls" };
    await writeFile(
      path.join(userData, "server-settings.json"),
      JSON.stringify({
        accounts: {
          "google@gmail.com": {
            incoming: {
              protocol: "imap",
              host: "imap.example.com",
              port: 993,
              security: "ssl",
              username: "Me@Example.com",
              password: stored,
            },
            outgoing: { ...server, username: "me@example.com" },
          },
          // Nothing spoke POP3, so there is nothing to carry over.
          "other@gmail.com": {
            incoming: { protocol: "pop3", host: "pop.x.com", port: 995, security: "ssl", username: "p@x.com" },
            outgoing: { ...server, username: "" },
          },
        },
      }),
    );
    const store = await freshModule();
    const accounts = await store.listMailAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      email: "me@example.com",
      username: "Me@Example.com",
      incoming: { host: "imap.example.com", port: 993, security: "ssl" },
      outgoing: server,
      hasPassword: true,
    });
    expect((await store.getMailCredentials(accounts[0].id))?.password).toBe("legacy-pw");
    // Written out at once, so the ids are the same after a restart.
    expect((await (await freshModule()).listMailAccounts())[0].id).toBe(accounts[0].id);
  });
});
