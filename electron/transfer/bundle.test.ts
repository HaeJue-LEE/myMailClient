import { describe, expect, it } from "vitest";
import { SettingsFileError } from "../errors";
import { decryptSettings, encryptSettings, type KdfParams, SETTINGS_VERSION } from "./bundle";

/** The weakest settings a file may use: keeps the tests fast. */
const FAST: KdfParams = { N: 2 ** 14, r: 8, p: 1 };
const PASSPHRASE = "TEST-passphrase-1";
const SETTINGS = { mail: { accounts: [{ email: "someone@example.com", password: "TEST-pw" }] } };

const codeOf = async (pending: Promise<unknown>) => {
  try {
    await pending;
    return "opened";
  } catch (error) {
    return error instanceof SettingsFileError ? error.code : String(error);
  }
};

const edit = (file: Buffer, change: (json: Record<string, unknown>) => void) => {
  const json = JSON.parse(file.toString("utf8"));
  change(json);
  return Buffer.from(JSON.stringify(json));
};

describe("settings file", { timeout: 30_000 }, () => {
  it("opens with its passphrase, and holds no settings in the clear", async () => {
    const file = await encryptSettings(SETTINGS, PASSPHRASE, FAST);
    expect(await decryptSettings(file, PASSPHRASE)).toEqual(SETTINGS);
    expect(file.toString("utf8")).not.toContain("someone@example.com");
    expect(file.toString("utf8")).not.toContain("TEST-pw");
  });

  it("is made with the default strength", async () => {
    const file = await encryptSettings(SETTINGS, PASSPHRASE);
    expect(JSON.parse(file.toString("utf8")).kdf).toMatchObject({ name: "scrypt", N: 2 ** 17, r: 8, p: 1 });
    expect(await decryptSettings(file, PASSPHRASE)).toEqual(SETTINGS);
  });

  it("refuses a wrong passphrase", async () => {
    const file = await encryptSettings(SETTINGS, PASSPHRASE, FAST);
    expect(await codeOf(decryptSettings(file, "TEST-passphrase-2"))).toBe("wrong_passphrase");
  });

  it("takes a Korean passphrase typed on a Mac (decomposed) on Windows, and back", async () => {
    const composed = "테스트용암호입니다".normalize("NFC");
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    const fromMac = await encryptSettings(SETTINGS, decomposed, FAST);
    expect(await decryptSettings(fromMac, composed)).toEqual(SETTINGS);
    const fromWindows = await encryptSettings(SETTINGS, composed, FAST);
    expect(await decryptSettings(fromWindows, decomposed)).toEqual(SETTINGS);
  });

  it("opens after an editor added a byte order mark and Windows line endings", async () => {
    const file = await encryptSettings(SETTINGS, PASSPHRASE, FAST);
    const touched = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(file.toString("utf8").replace(/\n/g, "\r\n")),
    ]);
    expect(await decryptSettings(touched, PASSPHRASE)).toEqual(SETTINGS);
  });

  it("refuses a file whose header or contents were changed", async () => {
    const file = await encryptSettings(SETTINGS, PASSPHRASE, FAST);
    const iv = Buffer.alloc(12, 7).toString("base64");
    const data = JSON.parse(file.toString("utf8")).data as string;
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 1;
    const changed = [
      edit(file, (json) => ((json.cipher as { iv: string }).iv = iv)),
      edit(file, (json) => (json.data = flipped.toString("base64"))),
    ];
    for (const one of changed) {
      expect(await codeOf(decryptSettings(one, PASSPHRASE))).toBe("wrong_passphrase");
    }
  });

  it("says a file made by a later version is one", async () => {
    const file = await encryptSettings(SETTINGS, PASSPHRASE, FAST);
    const later = edit(file, (json) => (json.version = SETTINGS_VERSION + 1));
    expect(await codeOf(decryptSettings(later, PASSPHRASE))).toBe("newer_settings_file");
  });

  it("refuses what is not a settings file", async () => {
    const file = await encryptSettings(SETTINGS, PASSPHRASE, FAST);
    const notOnes = [
      Buffer.from("not json"),
      Buffer.from(JSON.stringify({ hello: "world" })),
      Buffer.from(JSON.stringify(SETTINGS)),
      edit(file, (json) => (json.format = "something-else")),
      edit(file, (json) => delete json.data),
      // Scrypt settings beyond what a file may ask for (memory), or not a power of two.
      edit(file, (json) => ((json.kdf as { N: number }).N = 2 ** 24)),
      edit(file, (json) => ((json.kdf as { N: number }).N = 3 * 2 ** 14)),
      edit(file, (json) => ((json.kdf as { r: number }).r = 1000)),
      Buffer.alloc(11 * 1024 * 1024, 0x20),
    ];
    for (const one of notOnes) {
      expect(await codeOf(decryptSettings(one, PASSPHRASE))).toBe("not_settings_file");
    }
  });
});
