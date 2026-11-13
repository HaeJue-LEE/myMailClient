import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userData = "";
let encryptionAvailable = true;
const encrypt = (text: string) => Buffer.from(`enc:${[...text].reverse().join("")}`);
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: encrypt,
    decryptString: (data: Buffer) => {
      const text = data.toString();
      if (!text.startsWith("enc:")) throw new Error("not ours");
      return [...text.slice(4)].reverse().join("");
    },
  },
}));

/** A fresh module, as after an app restart. */
const fresh = async () => {
  vi.resetModules();
  return import("./google-accounts");
};

const legacyFile = () => path.join(userData, "account.bin");
const storeFile = () => path.join(userData, "google.bin");

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "google-accounts-"));
  encryptionAvailable = true;
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("Google accounts", () => {
  it("has none at first", async () => {
    expect(await (await fresh()).listGoogleAccounts()).toEqual([]);
  });

  it("takes the one earlier sign-in over, keeping its id", async () => {
    await writeFile(legacyFile(), encrypt(JSON.stringify({ email: "me@gmail.com", refreshToken: "old-token" })));
    const store = await fresh();
    expect(await store.listGoogleAccounts()).toEqual([
      { id: "gmail", email: "me@gmail.com", refreshToken: "old-token" },
    ]);
    // An older version of the app keeps its sign-in.
    expect(existsSync(legacyFile())).toBe(true);
    // Still there after a restart, now from the new file.
    expect((await (await fresh()).listGoogleAccounts()).map((account) => account.id)).toEqual(["gmail"]);
  });

  it("forgets the earlier file with the earlier account, and does not bring it back", async () => {
    await writeFile(legacyFile(), encrypt(JSON.stringify({ email: "me@gmail.com", refreshToken: "old-token" })));
    const store = await fresh();
    await store.removeGoogleAccount("gmail");
    expect(existsSync(legacyFile())).toBe(false);
    expect(await (await fresh()).listGoogleAccounts()).toEqual([]);
  });

  it("does not take the earlier file over again once it has its own", async () => {
    const store = await fresh();
    await store.storeGoogleAccount("me@example.com", "token");
    await writeFile(legacyFile(), encrypt(JSON.stringify({ email: "old@example.com", refreshToken: "old-token" })));
    expect((await (await fresh()).listGoogleAccounts()).map((account) => account.email)).toEqual(["me@example.com"]);
  });

  it("leaves the earlier sign-in in place when it cannot be stored encrypted", async () => {
    await writeFile(legacyFile(), encrypt(JSON.stringify({ email: "me@gmail.com", refreshToken: "old-token" })));
    encryptionAvailable = false;
    const store = await fresh();
    expect((await store.listGoogleAccounts()).map((account) => account.id)).toEqual(["gmail"]);
    expect(existsSync(legacyFile())).toBe(true);
  });

  it("adds other accounts, and renews one signed in again", async () => {
    const store = await fresh();
    const first = await store.storeGoogleAccount("me@gmail.com", "token-1");
    const second = await store.storeGoogleAccount("family@example.com", "token-2");
    expect(first.id).toBe(store.googleAccountId("me@gmail.com"));
    expect(second.id).not.toBe(first.id);
    expect(second.id).toMatch(/^gmail-[0-9a-f]{16}$/);

    // The same address, however it is capitalized, keeps its id.
    const again = await store.storeGoogleAccount("Me@Gmail.com", "token-3");
    expect(again.id).toBe(first.id);

    const restarted = await fresh();
    expect(await restarted.listGoogleAccounts()).toEqual([
      { id: first.id, email: "Me@Gmail.com", refreshToken: "token-3" },
      { id: second.id, email: "family@example.com", refreshToken: "token-2" },
    ]);
  });

  it("keeps the earlier id when the earlier account signs in again", async () => {
    await writeFile(legacyFile(), encrypt(JSON.stringify({ email: "me@gmail.com", refreshToken: "old-token" })));
    const store = await fresh();
    expect((await store.storeGoogleAccount("me@gmail.com", "new-token")).id).toBe("gmail");
  });

  it("keeps a new refresh token, and removes one account only", async () => {
    const store = await fresh();
    const first = await store.storeGoogleAccount("me@gmail.com", "token-1");
    const second = await store.storeGoogleAccount("family@example.com", "token-2");
    await store.updateGoogleToken(first.id, "token-1b");
    expect((await store.removeGoogleAccount(second.id))?.refreshToken).toBe("token-2");
    expect(await store.removeGoogleAccount(second.id)).toBeNull();

    expect(await (await fresh()).listGoogleAccounts()).toEqual([
      { id: first.id, email: "me@gmail.com", refreshToken: "token-1b" },
    ]);
  });

  it("stores tokens only encrypted", async () => {
    const store = await fresh();
    await store.storeGoogleAccount("me@gmail.com", "secret-refresh-token");
    expect(await readFile(storeFile(), "utf8")).not.toContain("secret-refresh-token");
  });

  it("refuses to store a sign-in without encryption", async () => {
    encryptionAvailable = false;
    const store = await fresh();
    await expect(store.storeGoogleAccount("me@gmail.com", "token")).rejects.toThrow();
  });

  it("starts empty from a file another user wrote, without touching it", async () => {
    await writeFile(storeFile(), "someone else's");
    await writeFile(legacyFile(), encrypt(JSON.stringify({ email: "me@gmail.com", refreshToken: "old-token" })));
    expect(await (await fresh()).listGoogleAccounts()).toEqual([]);
    expect(existsSync(legacyFile())).toBe(true);
  });
});
