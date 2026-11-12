import { shell } from "electron";
import { mailApiBase, ZOHO_REGIONS } from "@/features/mail/zoho";
import { LoginCancelledError } from "../auth";
import { InvalidRequestError, MailServerError } from "../errors";
import { parseZohoJson } from "./json";
import { getZohoClient, type ZohoAccount, type ZohoClient } from "./store";

/**
 * Zoho sign-in and Mail API calls. Sign-in uses Zoho's device flow (the
 * "Non-browser Applications" client type): Zoho wants redirect URIs registered
 * exactly, which a loopback server on a free port cannot promise. The user
 * approves in the system browser while the app polls for the grant.
 */
const SCOPES = ["ZohoMail.accounts.READ", "ZohoMail.messages.ALL", "ZohoMail.folders.ALL"];
/** Zoho asks for at least 5 seconds between polls. */
const MIN_POLL_MS = 5000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh a little before Zoho's hour is up. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;

let activeLogin: AbortController | null = null;

/**
 * A duration from the device flow. Zoho sends milliseconds (interval 5000,
 * expires_in 300000, as observed); a value under 1000 is taken as seconds
 * (e.g. 5 or 300), so either reading works.
 */
export function toMs(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1000 ? number * 1000 : number;
}

type Token = { value: string; expires: number };
/**
 * Access tokens by account id. Zoho limits how often tokens may be made, so
 * one is kept for its hour, and concurrent calls share one refresh.
 */
const tokens = new Map<string, Promise<Token>>();

export function dropZohoToken(accountId: string) {
  tokens.delete(accountId);
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  user_location?: string;
};

async function postForm(url: string, params: Record<string, string>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  let response: Response;
  try {
    // Zoho's accounts server reads these parameters from the query string.
    response = await fetch(`${url}?${new URLSearchParams(params)}`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new MailServerError("connection_failed", "Zoho accounts server unreachable");
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

async function requireClient(): Promise<ZohoClient> {
  const client = await getZohoClient();
  if (!client) throw new InvalidRequestError("No Zoho client is set up");
  return client;
}

function isThrottled(body: Record<string, unknown>) {
  return /too many requests/i.test(String(body.error_description ?? body.error ?? ""));
}

async function refresh(account: ZohoAccount): Promise<Token> {
  const client = await requireClient();
  const { body } = await postForm(`${account.accountsServer}/oauth/v2/token`, {
    refresh_token: account.refreshToken,
    grant_type: "refresh_token",
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  const { access_token, expires_in } = body as TokenResponse;
  if (typeof access_token === "string" && access_token) {
    const lifetime = (typeof expires_in === "number" ? expires_in : 3600) * 1000;
    return { value: access_token, expires: Date.now() + lifetime - EXPIRY_MARGIN_MS };
  }
  if (isThrottled(body)) throw new MailServerError("rate_limited", "Zoho token limit");
  // A revoked grant, or a client that was deleted or changed: sign in again.
  throw new MailServerError("auth_failed", `Zoho refresh failed: ${String(body.error)}`);
}

async function accessToken(account: ZohoAccount): Promise<string> {
  const cached = tokens.get(account.id);
  if (cached) {
    const token = await cached.catch(() => null);
    if (token && token.expires > Date.now()) return token.value;
    if (tokens.get(account.id) !== cached) return accessToken(account);
  }
  const pending = refresh(account);
  tokens.set(account.id, pending);
  pending.catch(() => {
    if (tokens.get(account.id) === pending) tokens.delete(account.id);
  });
  return (await pending).value;
}

export type ZohoRequest = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as JSON; see `zohoId` for writing ids. */
  json?: unknown;
  /** Sent as is, e.g. an attachment's bytes. */
  body?: Uint8Array;
  contentType?: string;
};

/** Zoho's `{ status: { code }, data: { errorCode } }` as a failure the renderer may see. */
function failure(status: number, body: unknown): MailServerError {
  const data = (body as { data?: { errorCode?: unknown; moreInfo?: unknown } })?.data;
  const detail = `Zoho ${status} ${String(data?.errorCode ?? "")} ${String(data?.moreInfo ?? "")}`.trim();
  if (status === 401) return new MailServerError("auth_failed", detail);
  if (status === 429 || /TOO_MANY|THROTTL|LIMIT_EXCEEDED/i.test(String(data?.errorCode ?? ""))) {
    return new MailServerError("rate_limited", detail);
  }
  return new MailServerError("server_error", detail);
}

/** Calls the Mail API as `account`; resolves with the response's `data`. */
export async function zohoRequest<T>(
  account: ZohoAccount,
  path: string,
  request: ZohoRequest = {},
): Promise<T> {
  const url = new URL(`${mailApiBase(account.accountsServer)}${path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const send = async (token: string) => {
    const headers: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: "application/json",
    };
    let body: BodyInit | undefined;
    if (request.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(request.json);
    } else if (request.body) {
      headers["Content-Type"] = request.contentType ?? "application/octet-stream";
      body = request.body as BodyInit;
    }
    try {
      return await fetch(url, {
        method: request.method ?? "GET",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MailServerError("connection_failed", "Zoho Mail unreachable");
    }
  };

  let response = await send(await accessToken(account));
  if (response.status === 401) {
    // The token may have ended early (e.g. revoked sessions): one fresh try.
    dropZohoToken(account.id);
    response = await send(await accessToken(account));
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? parseZohoJson(text) : null;
  } catch {
    // Not JSON (e.g. a gateway error page).
  }
  if (!response.ok) throw failure(response.status, parsed);
  return (parsed as { data: T } | null)?.data as T;
}

type ZohoMailAccount = {
  accountId: string | number;
  primaryEmailAddress?: string;
  mailboxAddress?: string;
  displayName?: string;
  isDefaultAccount?: boolean;
};

/**
 * Signs in to Zoho in the system browser and returns the Zoho account it
 * reached. Starting again cancels a sign-in still waiting.
 */
export async function signInZoho(): Promise<ZohoAccount> {
  const client = await requireClient();
  activeLogin?.abort();
  const controller = new AbortController();
  activeLogin = controller;
  const { signal } = controller;

  try {
    let server: string = ZOHO_REGIONS[client.region].accounts;
    const start = await postForm(`${server}/oauth/v3/device/code`, {
      client_id: client.clientId,
      grant_type: "device_request",
      scope: SCOPES.join(","),
      access_type: "offline",
      prompt: "consent",
    });
    const deviceCode = start.body.device_code;
    const verify = start.body.verification_uri_complete ?? start.body.verification_url;
    if (typeof deviceCode !== "string" || typeof verify !== "string") {
      // Mostly invalid_client: a wrong client ID, type, or data center.
      throw new InvalidRequestError(`Zoho refused the client: ${String(start.body.error)}`);
    }
    if (!/^https:\/\/accounts\.zoho/.test(verify)) throw new Error("Unexpected Zoho sign-in page");
    await shell.openExternal(verify);

    const wait = Math.max(toMs(start.body.interval) ?? 0, MIN_POLL_MS);
    const deadline = Date.now() + Math.min(toMs(start.body.expires_in) ?? LOGIN_TIMEOUT_MS, LOGIN_TIMEOUT_MS);
    let granted: TokenResponse | null = null;
    while (!granted) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new LoginCancelledError());
          },
          { once: true },
        );
      });
      if (Date.now() > deadline) throw new LoginCancelledError();
      const poll = await postForm(`${server}/oauth/v3/device/token`, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "device_token",
        code: deviceCode,
      });
      const body = poll.body as TokenResponse;
      if (body.access_token) {
        granted = body;
        break;
      }
      if (body.error === "authorization_pending" || body.error === "slow_down") continue;
      if (body.error === "other_dc" && typeof body.user_location === "string") {
        // The user's account lives in another data center: ask that one.
        const region = ZOHO_REGIONS[body.user_location as keyof typeof ZOHO_REGIONS];
        if (!region) throw new Error(`Unknown Zoho data center ${body.user_location}`);
        server = region.accounts;
        continue;
      }
      if (body.error === "access_denied" || body.error === "expired") {
        throw new LoginCancelledError();
      }
      throw new InvalidRequestError(`Zoho sign-in failed: ${String(body.error)}`);
    }
    if (!granted.refresh_token || !granted.access_token) {
      throw new Error("Zoho returned no refresh token");
    }

    const probe: ZohoAccount = {
      id: "pending",
      email: "",
      name: "",
      zohoAccountId: "0",
      accountsServer: server,
      refreshToken: granted.refresh_token,
    };
    tokens.set(probe.id, Promise.resolve({ value: granted.access_token, expires: Date.now() + 50 * 60 * 1000 }));
    let mailAccounts: ZohoMailAccount[];
    try {
      mailAccounts = await zohoRequest<ZohoMailAccount[]>(probe, "/accounts");
    } finally {
      tokens.delete(probe.id);
    }
    const mailbox =
      mailAccounts.find((item) => item.isDefaultAccount) ?? mailAccounts[0];
    const email = (mailbox?.primaryEmailAddress ?? mailbox?.mailboxAddress ?? "").toLowerCase();
    if (!mailbox || !email) throw new Error("Zoho returned no mail account");
    const zohoAccountId = String(mailbox.accountId);
    const account: ZohoAccount = {
      id: `zoho-${zohoAccountId}`,
      email,
      name: mailbox.displayName ?? "",
      zohoAccountId,
      accountsServer: server,
      refreshToken: granted.refresh_token,
    };
    tokens.set(account.id, Promise.resolve({ value: granted.access_token, expires: Date.now() + 50 * 60 * 1000 }));
    return account;
  } finally {
    if (activeLogin === controller) activeLogin = null;
  }
}

/** Revokes a sign-in at Zoho, e.g. when its account is removed; failures are ignored. */
export async function revokeZoho(account: ZohoAccount) {
  dropZohoToken(account.id);
  await postForm(`${account.accountsServer}/oauth/v2/token/revoke`, {
    token: account.refreshToken,
  }).catch(() => undefined);
}
