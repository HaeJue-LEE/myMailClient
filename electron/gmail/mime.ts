import { randomUUID } from "node:crypto";

export type OutgoingAttachment = {
  filename: string;
  /** Untrusted (from the renderer); checked before it reaches a header. */
  mimeType: string;
  data: Uint8Array;
};

export type OutgoingMessage = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutgoingAttachment[];
  /**
   * `Date` and `Message-ID` headers. Gmail adds its own, so they are set only
   * for mail that goes out over SMTP or is stored over IMAP.
   */
  date?: Date;
  messageId?: string;
};

/** A new `Message-ID` value in the domain of the sender's address. */
export function newMessageId(email: string) {
  const domain = /@([a-z0-9.-]+)$/i.exec(email.trim())?.[1] ?? "localhost";
  return `<${randomUUID()}@${domain}>`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * RFC 5322 date-time in the computer's time zone, as other mail programs
 * write it, e.g. `Wed, 11 Nov 2026 22:15:26 +0900` on a Korean PC.
 * `offsetMinutes` (east of UTC) is for tests; it defaults to the local one.
 */
export function formatDate(date: Date, offsetMinutes = -date.getTimezoneOffset()) {
  // The local wall-clock time, read through the UTC getters.
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(offsetMinutes);
  return (
    `${DAYS[local.getUTCDay()]}, ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ` +
    `${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:` +
    `${pad(local.getUTCSeconds())} ${sign}${pad(Math.floor(offset / 60))}${pad(offset % 60)}`
  );
}

const CRLF = "\r\n";
/** Keeps each RFC 2047 encoded-word within the 75 character limit. */
const MAX_ENCODED_WORD_BYTES = 45;
/** `type/subtype` made of RFC 2045 token characters only. */
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const FALLBACK_MIME_TYPE = "application/octet-stream";

function stripLineBreaks(value: string) {
  return value.replace(/[\r\n]+/g, " ");
}

function encodeHeaderValue(raw: string) {
  const value = stripLineBreaks(raw);
  if (/^[\x20-\x7e]*$/.test(value)) return value;

  const chunks: string[] = [];
  let current = "";
  for (const char of value) {
    if (Buffer.byteLength(current + char) > MAX_ENCODED_WORD_BYTES) {
      chunks.push(current);
      current = "";
    }
    current += char;
  }
  chunks.push(current);

  return chunks
    .map(
      (chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`,
    )
    .join(`${CRLF} `);
}

/**
 * `"Name" <a@x.com>` for an address header. ASCII names are quoted (so `.` in
 * "G.D.HONG" is allowed); other names become RFC 2047 encoded-words.
 */
export function formatMailbox(name: string, email: string) {
  const address = stripLineBreaks(email).trim();
  const display = stripLineBreaks(name).trim();
  if (!display) return address;
  const phrase = /^[\x20-\x7e]*$/.test(display)
    ? `"${display.replace(/["\\]/g, "\\$&")}"`
    : encodeHeaderValue(display);
  return `${phrase} <${address}>`;
}

/**
 * A filename safe to put in a header: no path, control characters, quotes,
 * or backslashes. Never empty.
 */
export function safeFilename(raw: string) {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\x00-\x1f\x7f"\\]/g, "")
    .trim()
    .slice(0, 200);
  return cleaned || "attachment";
}

/** RFC 2231 / 5987 `ext-value` for a UTF-8 parameter, e.g. `filename*`. */
function extendedValue(value: string) {
  const encoded = encodeURIComponent(value).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `UTF-8''${encoded}`;
}

function base64Lines(data: Uint8Array | string) {
  const encoded = Buffer.from(data as Uint8Array).toString("base64");
  return encoded.match(/.{1,76}/g)?.join(CRLF) ?? "";
}

function textPart(subtype: "plain" | "html", content: string) {
  return [
    `Content-Type: text/${subtype}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(content, "utf8")),
  ].join(CRLF);
}

function multipart(subtype: "alternative" | "mixed", parts: string[]) {
  const boundary = `----=_mail_${randomUUID()}`;
  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    "",
    ...parts.flatMap((part) => [`--${boundary}`, part]),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

/**
 * The quoted `filename`/`name` value. Non-ASCII names use an RFC 2047
 * encoded-word, as Gmail itself sends them: Gmail (and many mail apps) read
 * this form and ignore `filename*`, so an ASCII stand-in would show as
 * "___.txt". `filename*` is added too, for strict RFC 2231 readers.
 */
function quotedFilename(filename: string) {
  return /^[\x20-\x7e]*$/.test(filename)
    ? filename
    : `=?UTF-8?B?${Buffer.from(filename, "utf8").toString("base64")}?=`;
}

function attachmentPart(attachment: OutgoingAttachment) {
  const filename = safeFilename(attachment.filename);
  const mimeType = MIME_TYPE.test(attachment.mimeType)
    ? attachment.mimeType.toLowerCase()
    : FALLBACK_MIME_TYPE;
  const quoted = quotedFilename(filename);
  return [
    `Content-Type: ${mimeType}; name="${quoted}"`,
    `Content-Disposition: attachment; filename="${quoted}"; filename*=${extendedValue(filename)}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(attachment.data),
  ].join(CRLF);
}

function addressHeader(name: string, addresses: string[] | undefined) {
  return addresses?.length
    ? [`${name}: ${addresses.map(stripLineBreaks).join(", ")}`]
    : [];
}

function optionalHeader(name: string, value: string | undefined) {
  return value ? [`${name}: ${stripLineBreaks(value)}`] : [];
}

/**
 * Builds an RFC 5322 message: text, or text + HTML alternatives, wrapped in
 * multipart/mixed when there are attachments.
 */
export function buildMimeMessage(message: OutgoingMessage) {
  const headers = [
    `From: ${stripLineBreaks(message.from)}`,
    ...addressHeader("To", message.to),
    ...addressHeader("Cc", message.cc),
    ...addressHeader("Bcc", message.bcc),
    `Subject: ${encodeHeaderValue(message.subject)}`,
    ...(message.date ? [`Date: ${formatDate(message.date)}`] : []),
    ...optionalHeader("Message-ID", message.messageId),
    ...optionalHeader("In-Reply-To", message.inReplyTo),
    ...optionalHeader("References", message.references),
    "MIME-Version: 1.0",
  ];

  const body =
    message.html === undefined
      ? textPart("plain", message.text)
      : multipart("alternative", [
          textPart("plain", message.text),
          textPart("html", message.html),
        ]);
  const entity = message.attachments?.length
    ? multipart("mixed", [body, ...message.attachments.map(attachmentPart)])
    : body;

  return [...headers, entity].join(CRLF);
}

/** The message encoded for the Gmail API `raw` field. */
export function buildRawMessage(message: OutgoingMessage) {
  return Buffer.from(buildMimeMessage(message), "utf8").toString("base64url");
}
