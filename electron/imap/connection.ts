import { ImapFlow } from "imapflow";
import type { ServerEndpoint } from "@/features/mail/mail-accounts";
import { InvalidRequestError, MailServerError } from "../errors";
import { type FolderMap, mapFolders } from "./folders";

export type ImapConfig = {
  /** Account id; one connection is kept per account. */
  id: string;
  username: string;
  password: string;
  incoming: ServerEndpoint;
};

const CONNECT_TIMEOUT_MS = 15_000;
/** Longer than any single command should take, shorter than a hung socket. */
const SOCKET_TIMEOUT_MS = 2 * 60_000;

/** Socket, DNS, and timeout failures: the server could not be reached. */
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ETIMEOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "ClosedAfterConnectTLS",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
]);

/** Reduces an IMAP failure to a code the renderer may see. */
export function toImapError(error: unknown): Error {
  if (error instanceof MailServerError || error instanceof InvalidRequestError) {
    return error;
  }
  const { authenticationFailed, code, message } = error as {
    authenticationFailed?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const detail = typeof message === "string" ? message : undefined;
  if (authenticationFailed) return new MailServerError("auth_failed", detail);
  if (
    typeof code === "string" &&
    // TLS failures (bad certificate, wrong security mode) carry these prefixes.
    (CONNECTION_CODES.has(code) || /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED)/.test(code))
  ) {
    return new MailServerError("connection_failed", detail);
  }
  return new MailServerError("server_error", detail);
}

function createClient(config: ImapConfig) {
  const { host, port, security } = config.incoming;
  const client = new ImapFlow({
    host,
    port,
    secure: security === "ssl",
    // "starttls" must upgrade (the password never crosses in the clear);
    // "none" is the user's explicit choice not to.
    doSTARTTLS: security === "ssl" ? undefined : security === "starttls",
    auth: { user: config.username, pass: config.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
  // Without a listener an 'error' event would crash the main process.
  client.on("error", () => undefined);
  return client;
}

export type ImapState = {
  client: ImapFlow | null;
  /** Commands run one at a time: IMAP has a single selected folder. */
  queue: Promise<unknown>;
  folders: FolderMap | null;
};

const states = new Map<string, ImapState>();

async function connect(state: ImapState, config: ImapConfig) {
  if (state.client?.usable) return state.client;
  const client = createClient(config);
  client.on("close", () => {
    if (state.client === client) state.client = null;
  });
  await client.connect();
  state.client = client;
  return client;
}

/**
 * Runs `task` on the account's connection, after any task already queued.
 * A connection the server dropped while idle is reopened and the task retried
 * once. Do not call `runImap` from inside a task: it would wait on itself.
 */
export function runImap<T>(
  config: ImapConfig,
  task: (client: ImapFlow, state: ImapState) => Promise<T>,
): Promise<T> {
  let state = states.get(config.id);
  if (!state) {
    state = { client: null, queue: Promise.resolve(), folders: null };
    states.set(config.id, state);
  }
  const current = state;
  const result = current.queue
    .catch(() => undefined)
    .then(async () => {
      for (let attempt = 0; ; attempt++) {
        const reused = Boolean(current.client?.usable);
        try {
          return await task(await connect(current, config), current);
        } catch (error) {
          const dropped = !current.client?.usable;
          if (dropped) {
            current.client?.close();
            current.client = null;
          }
          // Only a connection that had been idle is worth one more try.
          if (attempt === 0 && reused && dropped) continue;
          throw toImapError(error);
        }
      }
    });
  current.queue = result;
  return result;
}

/** Closes the account's connection, e.g. after its settings change or it is removed. */
export function dropImap(id: string) {
  const state = states.get(id);
  states.delete(id);
  state?.client?.close();
}

/** The account's folders, listed once per connection state unless `refresh`. */
export async function getFolders(client: ImapFlow, state: ImapState, refresh = false) {
  if (!state.folders || refresh) state.folders = mapFolders(await client.list());
  return state.folders;
}

/** Signs in and out once, to check the settings before they are saved. */
export async function verifyImap(config: ImapConfig) {
  const client = createClient(config);
  try {
    await client.connect();
    await client.logout().catch(() => undefined);
  } catch (error) {
    throw toImapError(error);
  } finally {
    client.close();
  }
}
