import net from "node:net";
import tls from "node:tls";
import type { ServerEndpoint } from "@/features/mail/mail-accounts";
import { MailServerError } from "../errors";

/**
 * A minimal POP3 client (RFC 1939, STLS from RFC 2595): one session from
 * sign-in to QUIT. Responses are kept as bytes, because Korean mail often
 * carries raw EUC-KR headers that a text decode here would corrupt.
 */

export type Pop3Config = {
  username: string;
  password: string;
  incoming: ServerEndpoint;
};

const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 2 * 60_000;

const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

/** A `-ERR` reply to a command. */
export class Pop3CommandError extends Error {
  constructor(
    readonly command: string,
    readonly reply: string,
  ) {
    super(`${command}: ${reply}`);
  }
}

/** A failure that is not about the server's answer: socket, TLS, timeout. */
class Pop3ConnectionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Reduces a POP3 failure to a code the renderer may see. */
export function toPop3Error(error: unknown): Error {
  if (error instanceof MailServerError) return error;
  if (error instanceof Pop3CommandError) {
    return new MailServerError(
      error.command === "USER" || error.command === "PASS" ? "auth_failed" : "server_error",
      error.message,
    );
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  const detail = typeof message === "string" ? message : undefined;
  if (
    error instanceof Pop3ConnectionError ||
    (typeof code === "string" &&
      (CONNECTION_CODES.has(code) ||
        /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED)/.test(code)))
  ) {
    return new MailServerError("connection_failed", detail);
  }
  return new MailServerError("server_error", detail);
}

const CRLF = Buffer.from("\r\n");
const EMPTY_BODY = Buffer.from(".\r\n");
const TERMINATOR = Buffer.from("\r\n.\r\n");

/**
 * The body of a multi-line response: the lines between the status line and
 * the terminating `.`, with RFC 1939 dot-stuffing undone.
 */
export function unstuff(block: Buffer): Buffer {
  const lines: Buffer[] = [];
  let start = 0;
  while (start < block.length) {
    let end = block.indexOf(CRLF, start);
    if (end < 0) end = block.length;
    const line = block.subarray(start, end);
    lines.push(line[0] === 0x2e ? line.subarray(1) : line);
    start = end + 2;
  }
  return Buffer.concat(lines.flatMap((line, index) => (index ? [CRLF, line] : [line])));
}

/** Reads replies from a byte stream that may split or merge them anywhere. */
export class ReplyReader {
  /** Received bytes not yet consumed are `storage[start, end)`. */
  private storage: Buffer = Buffer.alloc(64 * 1024);
  private start = 0;
  private end = 0;
  /** How far the current reply was already searched for its terminator. */
  private scanned = 0;
  private waiting: {
    multiline: boolean;
    resolve: (reply: { status: string; body: Buffer | null }) => void;
    reject: (error: Error) => void;
  } | null = null;
  private failure: Error | null = null;

  private get buffer() {
    return this.storage.subarray(this.start, this.end);
  }

  /** Drops `count` consumed bytes from the front. */
  private consume(count: number) {
    this.start += count;
    this.scanned = 0;
  }

  push(chunk: Buffer) {
    // Grown by doubling, so a large message costs linear time to receive.
    if (this.end + chunk.length > this.storage.length) {
      const pending = this.end - this.start;
      let size = this.storage.length;
      while (size < pending + chunk.length) size *= 2;
      const next = size === this.storage.length ? this.storage : Buffer.alloc(size);
      this.storage.copy(next, 0, this.start, this.end);
      this.storage = next;
      this.start = 0;
      this.end = pending;
    }
    chunk.copy(this.storage, this.end);
    this.end += chunk.length;
    this.drain();
  }

  fail(error: Error) {
    this.failure ??= error;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(this.failure);
  }

  /** The next reply; with `multiline`, a `+OK` reply also carries its body. */
  next(multiline: boolean) {
    if (this.waiting) throw new Error("A reply is already awaited");
    return new Promise<{ status: string; body: Buffer | null }>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.waiting = { multiline, resolve, reject };
      this.drain();
    });
  }

  private drain() {
    const waiting = this.waiting;
    if (!waiting) return;
    const buffer = this.buffer;
    const lineEnd = buffer.indexOf(CRLF);
    if (lineEnd < 0) return;
    const status = buffer.subarray(0, lineEnd).toString("latin1");
    const ok = status.startsWith("+OK");
    if (!waiting.multiline || !ok) {
      this.consume(lineEnd + 2);
      this.waiting = null;
      waiting.resolve({ status, body: null });
      return;
    }
    const bodyStart = lineEnd + 2;
    // An empty body is the terminator line straight after the status line.
    if (buffer.subarray(bodyStart, bodyStart + 3).equals(EMPTY_BODY)) {
      this.consume(bodyStart + 3);
      this.waiting = null;
      waiting.resolve({ status, body: Buffer.alloc(0) });
      return;
    }
    // Only the new bytes are searched, plus enough to catch a split terminator.
    const from = Math.max(bodyStart, this.scanned - TERMINATOR.length);
    const end = buffer.indexOf(TERMINATOR, from);
    if (end < 0) {
      this.scanned = buffer.length;
      return;
    }
    // Copied out: the storage is reused for the bytes that follow.
    const body = Buffer.from(unstuff(buffer.subarray(bodyStart, end)));
    this.consume(end + TERMINATOR.length);
    this.waiting = null;
    waiting.resolve({ status, body });
  }
}

export type Pop3Session = {
  /** `UIDL`: each message's number in this session and its lasting id. */
  uidl: () => Promise<{ number: number; uid: string }[]>;
  /** `TOP n 0`: the headers only, without any of the body. */
  headers: (number: number) => Promise<Buffer>;
  /** `RETR n`: the whole message. */
  retrieve: (number: number) => Promise<Buffer>;
};

function openSocket(endpoint: ServerEndpoint): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const { host, port, security } = endpoint;
    const socket =
      security === "ssl"
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Pop3ConnectionError("Connection timed out", "ETIMEDOUT"));
    }, CONNECT_TIMEOUT_MS);
    socket.once(security === "ssl" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Upgrades a plain connection after a successful STLS. */
function upgrade(socket: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners("data");
    const secure = tls.connect({ socket, servername: host });
    secure.once("secureConnect", () => {
      secure.removeAllListeners("error");
      resolve(secure);
    });
    secure.once("error", reject);
  });
}

/**
 * Signs in, runs `task`, and signs out. Each call is a session of its own:
 * POP3 servers lock the mailbox and show a snapshot of it while signed in.
 * Messages are never deleted (no DELE is ever sent).
 */
export async function withPop3<T>(
  config: Pop3Config,
  task: (session: Pop3Session) => Promise<T>,
): Promise<T> {
  let socket: net.Socket | null = null;
  try {
    socket = await openSocket(config.incoming);
    let reader = new ReplyReader();
    const attach = (target: net.Socket, into: ReplyReader) => {
      target.setTimeout(SOCKET_TIMEOUT_MS);
      target.on("data", (chunk: Buffer) => into.push(chunk));
      target.on("timeout", () => {
        into.fail(new Pop3ConnectionError("Server stopped responding", "ETIMEDOUT"));
        target.destroy();
      });
      target.on("error", (error) => into.fail(error));
      target.on("close", () => into.fail(new Pop3ConnectionError("Connection closed")));
    };
    attach(socket, reader);

    const greeting = await reader.next(false);
    if (!greeting.status.startsWith("+OK")) {
      throw new Pop3ConnectionError(`Unexpected greeting: ${greeting.status}`);
    }

    const send = async (command: string, multiline: boolean, shown = command) => {
      if (!socket) throw new Pop3ConnectionError("Not connected");
      socket.write(`${command}\r\n`);
      const reply = await reader.next(multiline);
      if (!reply.status.startsWith("+OK")) {
        // The password is never put into an error message.
        throw new Pop3CommandError(shown, reply.status.replace(/^-ERR\s*/, ""));
      }
      return reply;
    };

    if (config.incoming.security === "starttls") {
      // The password must not cross in the clear: no STLS, no sign-in.
      await send("STLS", false);
      reader = new ReplyReader();
      socket = await upgrade(socket, config.incoming.host);
      attach(socket, reader);
    }

    await send(`USER ${config.username}`, false, "USER");
    await send(`PASS ${config.password}`, false, "PASS");

    const result = await task({
      uidl: async () => {
        const { body } = await send("UIDL", true);
        return (body ?? Buffer.alloc(0))
          .toString("latin1")
          .split("\r\n")
          .flatMap((line) => {
            const match = /^(\d+)\s+(\S+)/.exec(line);
            return match ? [{ number: Number(match[1]), uid: match[2] }] : [];
          });
      },
      headers: async (number) => (await send(`TOP ${number} 0`, true)).body ?? Buffer.alloc(0),
      retrieve: async (number) => (await send(`RETR ${number}`, true)).body ?? Buffer.alloc(0),
    });
    await send("QUIT", false).catch(() => undefined);
    return result;
  } catch (error) {
    throw toPop3Error(error);
  } finally {
    socket?.destroy();
  }
}

/**
 * Signs in and checks the commands this app relies on (UIDL, and TOP when
 * there is mail), so a server lacking them fails before the account is saved.
 */
export async function verifyPop3(config: Pop3Config) {
  await withPop3(config, async (session) => {
    const messages = await session.uidl();
    const last = messages.at(-1);
    if (last) await session.headers(last.number);
  });
}
