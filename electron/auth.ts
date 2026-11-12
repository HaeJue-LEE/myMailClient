import { gmail as createGmail, type gmail_v1 } from "@googleapis/gmail";
import { app, safeStorage, shell } from "electron";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { z } from "zod";
import { InvalidRequestError } from "./errors";
import { type GoogleClient, getGoogleClient } from "./google-client";

/**
 * gmail.modify covers read, label changes, and send, but not permanent delete.
 * contacts reads and adds saved contacts; "Other contacts" are only read.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.other.readonly",
];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const storedSchema = z.object({ email: z.string(), refreshToken: z.string() });
type Stored = z.infer<typeof storedSchema>;

/** `auth` is for Google APIs other than Gmail (e.g. People for contacts). */
export type Session = { email: string; gmail: gmail_v1.Gmail; auth: OAuth2Client };

export class LoginCancelledError extends Error {}

let current: Session | null = null;
/** The client `current` was made with; a session is tied to its client. */
let currentClientId: string | null = null;
let activeLogin: AbortController | null = null;

function oauthClient(client: GoogleClient, redirectUri?: string) {
  // Built in from .env.local or entered by the user. For desktop OAuth
  // clients Google does not treat the secret as confidential; PKCE protects
  // the exchange.
  return new OAuth2Client({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri,
  });
}

/** Forgets the open session, e.g. after the Google client changed. */
export function dropSession() {
  current = null;
  currentClientId = null;
}

function storePath() {
  return path.join(app.getPath("userData"), "account.bin");
}

async function readStored(): Promise<Stored | null> {
  try {
    const encrypted = await readFile(storePath());
    const parsed = storedSchema.safeParse(
      JSON.parse(safeStorage.decryptString(encrypted)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeStored(stored: Stored) {
  // safeStorage uses DPAPI on Windows, so only this OS user can decrypt it.
  await writeFile(storePath(), safeStorage.encryptString(JSON.stringify(stored)), {
    mode: 0o600,
  });
}

function createSession(stored: Stored, client: GoogleClient): Session {
  const oauth = oauthClient(client);
  oauth.setCredentials({ refresh_token: stored.refreshToken });
  oauth.on("tokens", (tokens) => {
    if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
      void writeStored({ ...stored, refreshToken: tokens.refresh_token });
    }
  });
  return {
    email: stored.email,
    gmail: createGmail({ version: "v1", auth: oauth }),
    auth: oauth,
  };
}

export async function getSession() {
  // A sign-in cannot be refreshed without the client it was made with.
  const { client } = await getGoogleClient();
  if (!client) return null;
  if (current && currentClientId === client.clientId) return current;
  const stored = await readStored();
  current = stored ? createSession(stored, client) : null;
  currentClientId = current ? client.clientId : null;
  return current;
}

export async function signOut({ revoke }: { revoke: boolean }) {
  const stored = revoke ? await readStored() : null;
  dropSession();
  await rm(storePath(), { force: true });
  const { client } = await getGoogleClient();
  if (stored && client) {
    await oauthClient(client)
      .revokeToken(stored.refreshToken)
      .catch(() => undefined);
  }
}

const RESULT_PAGE = (message: string) =>
  `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Mail Client</title>` +
  `<body style="font-family:sans-serif;padding:48px;text-align:center">` +
  `<p>${message}</p></body></html>`;

/** Resolves with the authorization code from Google's loopback redirect. */
function waitForCode(server: Server, state: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const fail = () => reject(new LoginCancelledError());
    const timer = setTimeout(fail, LOGIN_TIMEOUT_MS);
    signal.addEventListener("abort", fail, { once: true });

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const ok = code !== null && url.searchParams.get("state") === state;
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          RESULT_PAGE(
            ok
              ? "로그인되었습니다. 이 창을 닫고 Mail Client로 돌아가세요."
              : "로그인이 취소되었습니다. 앱에서 다시 시도해 주세요.",
          ),
        );
      clearTimeout(timer);
      if (ok) resolve(code);
      else fail();
    });
  });
}

/**
 * Google blocks sign-in inside embedded browsers, so the consent screen opens
 * in the system browser and redirects back to a one-shot loopback server.
 * Starting a new login cancels any login still waiting.
 */
export async function signIn(): Promise<{ email: string }> {
  const { client } = await getGoogleClient();
  if (!client) throw new InvalidRequestError("No Google client is set up");
  activeLogin?.abort();
  const controller = new AbortController();
  activeLogin = controller;

  const server = createServer();
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const oauth = oauthClient(client, `http://127.0.0.1:${port}/callback`);
    const { codeVerifier, codeChallenge } =
      await oauth.generateCodeVerifierAsync();
    const state = randomUUID();
    const code = waitForCode(server, state, controller.signal);

    await shell.openExternal(
      oauth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
      }),
    );

    const { tokens } = await oauth.getToken({
      code: await code,
      codeVerifier,
    });
    if (!tokens.refresh_token) throw new Error("Google returned no refresh token");

    oauth.setCredentials(tokens);
    const { data } = await createGmail({ version: "v1", auth: oauth })
      .users.getProfile({ userId: "me" });
    if (!data.emailAddress) throw new Error("Google returned no email address");

    const stored = { email: data.emailAddress, refreshToken: tokens.refresh_token };
    await writeStored(stored);
    current = createSession(stored, client);
    currentClientId = client.clientId;
    return { email: stored.email };
  } finally {
    if (activeLogin === controller) activeLogin = null;
    server.closeAllConnections();
    server.close();
  }
}
