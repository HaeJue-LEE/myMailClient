import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two computers, each with its own app folder and its own safeStorage key
 * (as DPAPI on Windows and the Keychain on a Mac are): what one encrypts the
 * other cannot read, so only the settings file carries anything across.
 */
type Computer = { userData: string; key: string };
let computer: Computer;
let savePath = "";

vi.mock("electron", () => {
  const image = { isEmpty: () => false, getSize: () => ({ width: 4, height: 4 }) };
  const square = { resize: () => ({ toPNG: () => Buffer.from("TEST-png") }) };
  return {
    app: {
      getPath: (name: string) => (name === "userData" ? computer.userData : tmpdir()),
      getVersion: () => "0.1.9",
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) =>
        Buffer.from(`${computer.key}:${Buffer.from(text).toString("base64")}`),
      decryptString: (data: Buffer) => {
        const [key, body] = data.toString().split(":");
        if (key !== computer.key) throw new Error("Encrypted on another computer");
        return Buffer.from(body, "base64").toString();
      },
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: savePath }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [savePath] }),
    },
    nativeImage: { createFromBuffer: () => ({ ...image, crop: () => square }) },
    shell: { openExternal: async () => undefined },
  };
});

/** Made-up accounts and clients only. */
const GOOGLE_CLIENT = {
  clientId: "123456789012-abcdefgh12345678.apps.googleusercontent.com",
  clientSecret: "TEST-not-a-real-secret",
};
const ZOHO_CLIENT = { clientId: "1000.TESTCLIENTID", clientSecret: "TEST-zoho-secret", region: "us" as const };
const PASSPHRASE = "TEST-passphrase-1";
const IMAP_PASSWORD = "TEST-imap-password";

let root = "";
const newComputer = async (name: string): Promise<Computer> => {
  const userData = path.join(root, name);
  mkdirSync(userData, { recursive: true });
  return { userData, key: `key-${name}` };
};

/** The app's modules as just started on `on`. */
async function start(on: Computer) {
  computer = on;
  vi.resetModules();
  return {
    transfer: await import("./transfer"),
    accounts: await import("../accounts"),
    google: await import("../google-accounts"),
    googleClient: await import("../google-client"),
    zoho: await import("../zoho/store"),
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "settings-transfer-"));
  savePath = path.join(root, "MailClient-settings.mcsettings");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setUpWindows() {
  const windows = await newComputer("windows");
  const app = await start(windows);
  await app.googleClient.saveCustomGoogleClient(GOOGLE_CLIENT);
  const google = await app.google.storeGoogleAccount("me@example.com", "TEST-google-token");
  await app.accounts.storeMailAccount({
    id: "imap-1",
    name: "Me",
    email: "me@example.net",
    username: "me@example.net",
    protocol: "imap",
    password: IMAP_PASSWORD,
    incoming: { host: "imap.example.net", port: 993, security: "ssl" },
    outgoing: { host: "smtp.example.net", port: 465, security: "ssl" },
    saveSentCopy: true,
    sendCopyToSelf: false,
  });
  await app.zoho.saveZohoClient(ZOHO_CLIENT);
  await app.zoho.storeZohoAccount({
    id: "zoho-111",
    email: "me@example.org",
    name: "",
    zohoAccountId: "111",
    accountsServer: "https://accounts.zoho.com",
    refreshToken: "TEST-zoho-token",
  });
  await app.accounts.setAccountOrder(["imap-1", google.id, "zoho-111"]);
  await app.accounts.setActiveId("zoho-111");
  const avatars = path.join(windows.userData, "avatars");
  mkdirSync(avatars, { recursive: true });
  await writeFile(path.join(avatars, `${Buffer.from("imap-1").toString("base64url")}.png`), "TEST-png");
  return { windows, app, googleId: google.id };
}

// Each file is made and opened with the real scrypt strength, slow by design.
describe("carrying settings to another computer", { timeout: 60_000 }, () => {
  it("moves every account from Windows to a Mac that has nothing yet", async () => {
    const { app } = await setUpWindows();
    expect(await app.transfer.exportSettings(null, PASSPHRASE, { includeSecrets: true })).toEqual({ saved: true, accounts: 3 });
    const file = await readFile(savePath, "utf8");
    for (const secret of [IMAP_PASSWORD, "TEST-google-token", GOOGLE_CLIENT.clientSecret, "me@example.net"]) {
      expect(file).not.toContain(secret);
    }

    const mac = await newComputer("mac");
    const there = await start(mac);
    const picked = await there.transfer.chooseSettingsFile(null);
    if (!picked) throw new Error("No file picked");
    const preview = await there.transfer.openSettingsFile(picked.token, PASSPHRASE);
    expect(preview).toMatchObject({ google: "install", zoho: "install", unreadable: 0 });
    expect(preview.items.map((item) => item.email)).toEqual([
      "me@example.net",
      "me@example.com",
      "me@example.org",
    ]);

    const result = await there.transfer.importSettings(picked.token, {
      overwrite: [],
      replaceGoogleClient: false,
      replaceZohoClient: false,
    });
    expect(result.imported).toBe(3);
    expect(result.items.map((item) => item.outcome)).toEqual(["added", "added", "added"]);

    // As after a restart of the app on the Mac.
    const after = await start(mac);
    expect((await after.accounts.getMailCredentials("imap-1"))?.password).toBe(IMAP_PASSWORD);
    expect(await after.google.listGoogleAccounts()).toMatchObject([
      { email: "me@example.com", refreshToken: "TEST-google-token" },
    ]);
    expect((await after.googleClient.getGoogleClient()).client).toEqual(GOOGLE_CLIENT);
    expect(await after.zoho.getZohoClient()).toEqual(ZOHO_CLIENT);
    expect(await after.zoho.listZohoAccounts()).toMatchObject([{ id: "zoho-111", refreshToken: "TEST-zoho-token" }]);
    expect(await after.accounts.getActiveId()).toBe("zoho-111");
    expect((await after.accounts.getAccountOrder())[0]).toBe("imap-1");
    const avatar = path.join(mac.userData, "avatars", `${Buffer.from("imap-1").toString("base64url")}.png`);
    expect((await readFile(avatar)).toString()).toBe("TEST-png");
    // Encrypted with the Mac's key, not carried as Windows wrote it.
    expect(await readFile(path.join(mac.userData, "accounts.json"), "utf8")).not.toContain(IMAP_PASSWORD);
  });

  it("carries only the mail servers' settings without secrets", async () => {
    const { app } = await setUpWindows();
    expect(await app.transfer.exportSettings(null, PASSPHRASE, { includeSecrets: false })).toEqual({
      saved: true,
      accounts: 1,
    });
    const mac = await newComputer("mac");
    const there = await start(mac);
    const picked = await there.transfer.chooseSettingsFile(null);
    if (!picked) throw new Error("No file picked");
    const preview = await there.transfer.openSettingsFile(picked.token, PASSPHRASE);
    expect(preview).toMatchObject({ google: "none", zoho: "none" });
    expect(preview.items).toMatchObject([{ email: "me@example.net", missingPassword: true }]);
    const result = await there.transfer.importSettings(picked.token, {
      overwrite: [],
      replaceGoogleClient: false,
      replaceZohoClient: false,
    });
    expect(result.items.map((item) => item.outcome)).toEqual(["needs_password"]);

    const after = await start(mac);
    expect(await after.accounts.listMailAccounts()).toMatchObject([{ id: "imap-1", hasPassword: false }]);
    expect((await after.googleClient.getGoogleClient()).client).toBeNull();
    expect(await after.zoho.getZohoClient()).toBeNull();
  });

  it("shows nothing of the file's contents with a wrong passphrase", async () => {
    const { app } = await setUpWindows();
    await app.transfer.exportSettings(null, PASSPHRASE, { includeSecrets: true });
    const there = await start(await newComputer("mac"));
    const picked = await there.transfer.chooseSettingsFile(null);
    if (!picked) throw new Error("No file picked");
    await expect(there.transfer.openSettingsFile(picked.token, "TEST-wrong-passphrase")).rejects.toMatchObject({
      code: "wrong_passphrase",
    });
    // Importing needs the file opened first.
    await expect(
      there.transfer.importSettings(picked.token, {
        overwrite: [],
        replaceGoogleClient: false,
        replaceZohoClient: false,
      }),
    ).rejects.toThrow();
  });

  it("leaves an account already on the other computer as it is unless asked", async () => {
    const { app } = await setUpWindows();
    await app.transfer.exportSettings(null, PASSPHRASE, { includeSecrets: true });

    const mac = await newComputer("mac");
    const there = await start(mac);
    await there.accounts.storeMailAccount({
      id: "mac-1",
      name: "",
      email: "me@example.net",
      username: "me@example.net",
      protocol: "imap",
      password: "TEST-mac-password",
      incoming: { host: "imap.example.net", port: 993, security: "ssl" },
      outgoing: { host: "smtp.example.net", port: 465, security: "ssl" },
      saveSentCopy: false,
      sendCopyToSelf: false,
    });
    const picked = await there.transfer.chooseSettingsFile(null);
    if (!picked) throw new Error("No file picked");
    await there.transfer.openSettingsFile(picked.token, PASSPHRASE);
    const result = await there.transfer.importSettings(picked.token, {
      overwrite: [],
      replaceGoogleClient: false,
      replaceZohoClient: false,
    });
    expect(result.items.find((item) => item.email === "me@example.net")?.outcome).toBe("skipped");
    const after = await start(mac);
    expect((await after.accounts.getMailCredentials("mac-1"))?.password).toBe("TEST-mac-password");
    expect(await after.accounts.listMailAccounts()).toHaveLength(1);
  });
});
