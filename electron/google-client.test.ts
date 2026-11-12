import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userData = "";
let encryptionAvailable = true;
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (text: string) => Buffer.from(`enc:${[...text].reverse().join("")}`),
    decryptString: (data: Buffer) => [...data.toString().slice(4)].reverse().join(""),
  },
}));

/** Made-up values in Google's format; not a real client. */
const CLIENT = {
  clientId: "123456789012-abcdefgh12345678.apps.googleusercontent.com",
  clientSecret: "TEST-not-a-real-secret",
};

/** A fresh module, as after an app restart. */
const fresh = async () => {
  vi.resetModules();
  return import("./google-client");
};

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "google-client-"));
  encryptionAvailable = true;
  vi.unstubAllEnvs();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(userData, { recursive: true, force: true });
});

describe("Google client", () => {
  it("has none until one is built in or entered", async () => {
    const store = await fresh();
    expect(await store.getGoogleClient()).toEqual({ client: null, source: "none" });
  });

  it("keeps an entered client across restarts, encrypted", async () => {
    const store = await fresh();
    await store.saveCustomGoogleClient(CLIENT);
    expect(await (await fresh()).getGoogleClient()).toEqual({ client: CLIENT, source: "custom" });
    const file = await readFile(path.join(userData, "google-client.bin"), "utf8");
    expect(file).not.toContain(CLIENT.clientSecret);
  });

  it("uses the built-in client first, and refuses another one then", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "111111111111-builtinbuiltin.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "built-in-secret");
    const store = await fresh();
    expect((await store.getGoogleClient()).source).toBe("built-in");
    await expect(store.saveCustomGoogleClient(CLIENT)).rejects.toThrow();
  });

  it("refuses values that are not a desktop client's", async () => {
    const store = await fresh();
    for (const bad of [
      { ...CLIENT, clientId: "not-an-id" },
      { ...CLIENT, clientId: "123-abc.apps.googleusercontent.com.evil.com" },
      { ...CLIENT, clientSecret: "short" },
      { ...CLIENT, clientSecret: "has space inside" },
    ]) {
      await expect(store.saveCustomGoogleClient(bad)).rejects.toThrow();
    }
    expect((await store.getGoogleClient()).source).toBe("none");
  });

  it("will not store the secret unencrypted", async () => {
    encryptionAvailable = false;
    const store = await fresh();
    await expect(store.saveCustomGoogleClient(CLIENT)).rejects.toThrow();
    expect((await (await fresh()).getGoogleClient()).source).toBe("none");
  });

  it("forgets an entered client", async () => {
    const store = await fresh();
    await store.saveCustomGoogleClient(CLIENT);
    await store.removeCustomGoogleClient();
    expect(await store.getGoogleClient()).toEqual({ client: null, source: "none" });
    expect((await (await fresh()).getGoogleClient()).source).toBe("none");
  });

  it("shows only the start of the client ID", async () => {
    const { clientHint } = await fresh();
    expect(clientHint(CLIENT)).toBe("123456789012…");
    expect(clientHint(CLIENT)).not.toContain(CLIENT.clientSecret);
  });
});
