import { gmail as createGmail, type gmail_v1 } from "@googleapis/gmail";
import { shell } from "electron";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InvalidRequestError } from "./errors";
import {
  type GoogleAccount,
  getGoogleAccount,
  listGoogleAccounts,
  removeGoogleAccount,
  storeGoogleAccount,
  updateGoogleToken,
} from "./google-accounts";
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

/** `auth` is for Google APIs other than Gmail (e.g. People for contacts). */
export type Session = { id: string; email: string; gmail: gmail_v1.Gmail; auth: OAuth2Client };

export class LoginCancelledError extends Error {}

/** Open sessions by account id, with the client each was made with: a session is tied to its client. */
const sessions = new Map<string, { session: Session; clientId: string }>();
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

/** Forgets the open sessions, e.g. after the Google client changed. */
export function dropSessions() {
  sessions.clear();
}

function createSession(account: GoogleAccount, client: GoogleClient): Session {
  const oauth = oauthClient(client);
  oauth.setCredentials({ refresh_token: account.refreshToken });
  oauth.on("tokens", (tokens) => {
    if (tokens.refresh_token && tokens.refresh_token !== account.refreshToken) {
      void updateGoogleToken(account.id, tokens.refresh_token).catch(() => undefined);
    }
  });
  return {
    id: account.id,
    email: account.email,
    gmail: createGmail({ version: "v1", auth: oauth }),
    auth: oauth,
  };
}

/**
 * The signed-in Google accounts. None while there is no Google client: a
 * sign-in cannot be refreshed without the client it was made with.
 */
export async function listSignedIn(): Promise<{ id: string; email: string }[]> {
  if (!(await getGoogleClient()).client) return [];
  return (await listGoogleAccounts()).map(({ id, email }) => ({ id, email }));
}

/** The session of a signed-in Google account; null when there is none. */
export async function getSession(id: string): Promise<Session | null> {
  const { client } = await getGoogleClient();
  if (!client) return null;
  const open = sessions.get(id);
  if (open && open.clientId === client.clientId) return open.session;
  const account = await getGoogleAccount(id);
  if (!account) {
    sessions.delete(id);
    return null;
  }
  const session = createSession(account, client);
  sessions.set(id, { session, clientId: client.clientId });
  return session;
}

/** Signs one Google account out; with `revoke`, Google forgets the grant too. */
export async function signOut(id: string, { revoke }: { revoke: boolean }) {
  sessions.delete(id);
  const removed = await removeGoogleAccount(id);
  const { client } = await getGoogleClient();
  if (revoke && removed && client) {
    await oauthClient(client)
      .revokeToken(removed.refreshToken)
      .catch(() => undefined);
  }
}

/** Signs every Google account out (their client is going away); returns their ids. */
export async function signOutAll({ revoke }: { revoke: boolean }): Promise<string[]> {
  const ids = (await listGoogleAccounts()).map((account) => account.id);
  for (const id of ids) await signOut(id, { revoke });
  return ids;
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
 *
 * Google asks which account to use, so another one can be added. Signing in
 * to an account already here renews its sign-in; another account is added.
 */
export async function signIn(): Promise<{ id: string; email: string }> {
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
        prompt: "select_account consent",
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

    const stored = await storeGoogleAccount(data.emailAddress, tokens.refresh_token);
    sessions.set(stored.id, { session: createSession(stored, client), clientId: client.clientId });
    return { id: stored.id, email: stored.email };
  } finally {
    if (activeLogin === controller) activeLogin = null;
    server.closeAllConnections();
    server.close();
  }
}
