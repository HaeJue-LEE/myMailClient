import { createTransport } from "nodemailer";
import type { ServerEndpoint } from "@/features/mail/mail-accounts";
import { MailServerError } from "../errors";

export type SmtpConfig = {
  /** The account's address; its domain is the name the client greets with. */
  email: string;
  username: string;
  password: string;
  outgoing: ServerEndpoint;
};

const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 2 * 60_000;

const CONNECTION_CODES = new Set([
  "ESOCKET",
  "ECONNECTION",
  "ETIMEDOUT",
  "EDNS",
  "ETLS",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** Reduces an SMTP failure to a code the renderer may see. */
export function toSmtpError(error: unknown): Error {
  if (error instanceof MailServerError) return error;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const detail = typeof message === "string" ? message : undefined;
  if (code === "EAUTH") return new MailServerError("smtp_auth_failed", detail);
  if (typeof code === "string" && CONNECTION_CODES.has(code)) {
    return new MailServerError("smtp_connection_failed", detail);
  }
  // E.g. the server refused a recipient or the message itself.
  return new MailServerError("server_error", detail);
}

/**
 * The name sent in EHLO. Left to itself nodemailer falls back to `[127.0.0.1]`
 * when the computer's name is not a full domain name (as on most Windows
 * PCs). The server writes that name into the Received header, and spam
 * filters such as Gmail's count a loopback greeting against the mail. The
 * sender's own domain is what a desktop client can honestly claim.
 */
export function heloName(email: string) {
  const domain = email.split("@").pop()?.trim().toLowerCase() ?? "";
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
    ? domain
    : undefined;
}

function transport({ email, username, password, outgoing }: SmtpConfig) {
  return createTransport({
    host: outgoing.host,
    port: outgoing.port,
    name: heloName(email),
    secure: outgoing.security === "ssl",
    // "starttls" must upgrade before signing in; "none" never does.
    requireTLS: outgoing.security === "starttls",
    ignoreTLS: outgoing.security === "none",
    auth: { user: username, pass: password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

/** Connects and signs in without sending, to check the settings before they are saved. */
export async function verifySmtp(config: SmtpConfig) {
  const smtp = transport(config);
  try {
    await smtp.verify();
  } catch (error) {
    throw toSmtpError(error);
  } finally {
    smtp.close();
  }
}

/**
 * Sends a finished RFC 5322 message. Recipients come from `recipients` alone
 * (the SMTP envelope), so Bcc addresses need not, and must not, be in `raw`.
 */
export async function sendSmtp(
  config: SmtpConfig,
  message: { from: string; recipients: string[]; raw: string },
) {
  const smtp = transport(config);
  try {
    await smtp.sendMail({
      envelope: { from: message.from, to: message.recipients },
      raw: message.raw,
    });
  } catch (error) {
    throw toSmtpError(error);
  } finally {
    smtp.close();
  }
}
