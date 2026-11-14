import { app, safeStorage } from "electron";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * The Google OAuth client the app signs in with: one the user entered in the
 * app (from their own Google Cloud project), kept encrypted on this computer.
 * No build carries one, so the secret never ships inside the executable.
 */
export type GoogleClient = { clientId: string; clientSecret: string };
export type GoogleClientSource = "custom" | "none";

/** `123456789012-abc….apps.googleusercontent.com` */
const CLIENT_ID = /^[0-9]{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/;

export const googleClientSchema = z.object({
  clientId: z.string().trim().regex(CLIENT_ID),
  clientSecret: z.string().trim().min(8).max(200).regex(/^\S+$/),
});

const filePath = () => path.join(app.getPath("userData"), "google-client.bin");

let custom: Promise<GoogleClient | null> | null = null;

async function readCustom(): Promise<GoogleClient | null> {
  try {
    const parsed = googleClientSchema.safeParse(
      JSON.parse(safeStorage.decryptString(await readFile(filePath()))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The client to sign in with, and whether there is one. */
export async function getGoogleClient(): Promise<{
  client: GoogleClient | null;
  source: GoogleClientSource;
}> {
  custom ??= readCustom();
  const entered = await custom;
  return entered ? { client: entered, source: "custom" } : { client: null, source: "none" };
}

/** Keeps a client the user entered. */
export async function saveCustomGoogleClient(input: GoogleClient) {
  const client = googleClientSchema.parse(input);
  // Refuse rather than fall back to storing the secret in plain text.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("safeStorage encryption is unavailable");
  }
  await writeFile(filePath(), safeStorage.encryptString(JSON.stringify(client)), { mode: 0o600 });
  custom = Promise.resolve(client);
}

export async function removeCustomGoogleClient() {
  await rm(filePath(), { force: true });
  custom = Promise.resolve(null);
}

/** The start of the client ID, enough to recognise it; the secret never leaves here. */
export function clientHint(client: GoogleClient) {
  return `${client.clientId.slice(0, 12)}…`;
}
