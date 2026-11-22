import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { z } from "zod";
import { SettingsFileError } from "../errors";

/**
 * The settings file that carries accounts to another computer: a small JSON
 * header and the settings, encrypted with a passphrase the user chooses
 * (scrypt, then AES-256-GCM, both in Node and in Electron). Nothing in it
 * depends on the operating system, so a file made on Windows opens on a Mac
 * and the other way round:
 * - the passphrase is compared in Unicode NFC, as macOS may hand over text
 *   (Korean especially) decomposed where Windows does not;
 * - a byte order mark added by an editor is ignored, and the JSON does not
 *   care about line endings;
 * - the settings hold no file paths.
 *
 * The header is bound to the encrypted part (as GCM's additional data), so
 * changing either makes the file fail to open rather than open differently.
 */

export const SETTINGS_FORMAT = "mail-client-settings";
export const SETTINGS_VERSION = 1;
/** Far above any real file (a few accounts and small pictures); checked before reading. */
export const MAX_SETTINGS_BYTES = 10 * 1024 * 1024;

export type KdfParams = { N: number; r: number; p: number };

/** About a quarter of a second, and 128 MB, on an ordinary computer. */
const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };
/** What a file may ask for: room for stronger settings later, bounded so a crafted file cannot exhaust memory. */
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 4;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const bytes = (length: number) =>
  base64.refine((value) => Buffer.from(value, "base64").length === length);
const isPowerOfTwo = (value: number) => (value & (value - 1)) === 0;

const fileSchema = z.object({
  format: z.literal(SETTINGS_FORMAT),
  version: z.number().int().min(1),
  kdf: z.object({
    name: z.literal("scrypt"),
    N: z.number().int().min(MIN_N).max(MAX_N).refine(isPowerOfTwo),
    r: z.number().int().min(1).max(MAX_R),
    p: z.number().int().min(1).max(MAX_P),
    salt: bytes(SALT_BYTES),
  }),
  cipher: z.object({ name: z.literal("aes-256-gcm"), iv: bytes(IV_BYTES) }),
  data: base64.min(1),
});
type SettingsFile = z.infer<typeof fileSchema>;

function deriveKey(passphrase: string, salt: Buffer, { N, r, p }: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs about 128 * N * r bytes; the default limit (32 MB) is lower.
    const maxmem = 256 * N * r;
    scrypt(passphrase.normalize("NFC"), salt, 32, { N, r, p, maxmem }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Everything in the header, in a fixed order, so the same header always gives the same bytes. */
function additionalData({ format, version, kdf, cipher }: Omit<SettingsFile, "data">) {
  return Buffer.from(
    JSON.stringify([format, version, kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt, cipher.name, cipher.iv]),
  );
}

/** `settings` (anything JSON can hold) as a settings file locked with `passphrase`. */
export async function encryptSettings(
  settings: unknown,
  passphrase: string,
  kdf: KdfParams = DEFAULT_KDF,
): Promise<Buffer> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = {
    format: SETTINGS_FORMAT as typeof SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    kdf: { name: "scrypt" as const, ...kdf, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm" as const, iv: iv.toString("base64") },
  };
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(passphrase, salt, kdf), iv);
  cipher.setAAD(additionalData(header));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(settings), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const file = { ...header, data: encrypted.toString("base64") };
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/**
 * The settings in a file, parsed but not yet checked (see payload.ts).
 * Throws SettingsFileError saying why a file cannot be opened.
 */
export async function decryptSettings(file: Buffer, passphrase: string): Promise<unknown> {
  if (file.length > MAX_SETTINGS_BYTES) throw new SettingsFileError("not_settings_file");
  let raw: unknown;
  try {
    raw = JSON.parse(file.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new SettingsFileError("not_settings_file");
  }
  const { format, version } = (raw ?? {}) as { format?: unknown; version?: unknown };
  if (format !== SETTINGS_FORMAT) throw new SettingsFileError("not_settings_file");
  if (typeof version === "number" && version > SETTINGS_VERSION) {
    throw new SettingsFileError("newer_settings_file");
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new SettingsFileError("not_settings_file");
  const { kdf, cipher, data } = parsed.data;

  const encrypted = Buffer.from(data, "base64");
  if (encrypted.length <= TAG_BYTES) throw new SettingsFileError("not_settings_file");
  const key = await deriveKey(passphrase, Buffer.from(kdf.salt, "base64"), kdf);
  let text: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cipher.iv, "base64"));
    decipher.setAAD(additionalData(parsed.data));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - TAG_BYTES));
    text = Buffer.concat([
      decipher.update(encrypted.subarray(0, encrypted.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM cannot tell a wrong passphrase from a changed file, and need not.
    throw new SettingsFileError("wrong_passphrase");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SettingsFileError("not_settings_file");
  }
}
