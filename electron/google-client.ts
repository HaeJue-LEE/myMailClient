import { app, safeStorage } from "electron";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { InvalidRequestError } from "./errors";

/**
 * The Google OAuth client the app signs in with: the one built in from
 * .env.local, or else one the user entered in the app (from their own Google
 * Cloud project), kept encrypted on this computer. Builds handed out carry
 * none, so each user brings their own.
 */
export type GoogleClient = { clientId: string; clientSecret: string };
export type GoogleClientSource = "built-in" | "custom" | "none";

/** `123456789012-abc….apps.googleusercontent.com` */
const CLIENT_ID = /^[0-9]{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/;

export const googleClientSchema = z.object({
  clientId: z.string().trim().regex(CLIENT_ID),
  clientSecret: z.string().trim().min(8).max(200).regex(/^\S+$/),
});

const filePath = () => path.join(app.getPath("userData"), "google-client.bin");

let custom: Promise<GoogleClient | null> | null = null;

function builtIn(): GoogleClient | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

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

/** The client to sign in with, and where it came from; the built-in one wins. */
export async function getGoogleClient(): Promise<{
  client: GoogleClient | null;
  source: GoogleClientSource;
}> {
  const fixed = builtIn();
  if (fixed) return { client: fixed, source: "built-in" };
  custom ??= readCustom();
  const entered = await custom;
  return entered ? { client: entered, source: "custom" } : { client: null, source: "none" };
}

/** Keeps a client the user entered. Refused when one is built in (it would never be used). */
export async function saveCustomGoogleClient(input: GoogleClient) {
  if (builtIn()) throw new InvalidRequestError("This build has its own Google client");
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
