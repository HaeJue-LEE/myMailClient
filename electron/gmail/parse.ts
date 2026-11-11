import type { gmail_v1 } from "@googleapis/gmail";
import { isRealAttachment } from "@/features/mail/attachments";
import type {
  MailAttachment,
  MailMessage,
  MailThread,
  ThreadSummary,
} from "@/features/mail/types";

type Message = gmail_v1.Schema$Message;
type Part = gmail_v1.Schema$MessagePart;

const NO_SUBJECT = "(제목 없음)";
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function header(message: Message, name: string) {
  const target = name.toLowerCase();
  const found = message.payload?.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === target,
  );
  return found?.value ?? "";
}

function partHeader(part: Part, name: string) {
  const target = name.toLowerCase();
  return part.headers?.find((candidate) => candidate.name?.toLowerCase() === target)?.value ?? "";
}

/** True when the message carries a file worth flagging (see `isRealAttachment`). */
export function hasRealAttachment(message: Message): boolean {
  const visit = (part: Part, inRelated: boolean): boolean => {
    const mimeType = (part.mimeType ?? "").toLowerCase();
    if (part.parts?.length) {
      const related = inRelated || mimeType === "multipart/related";
      return part.parts.some((child) => visit(child, related));
    }
    return isRealAttachment({
      mimeType,
      filename: part.filename,
      disposition: partHeader(part, "Content-Disposition").split(";")[0].trim(),
      hasContentId: Boolean(partHeader(part, "Content-ID")),
      inRelated,
      size: part.body?.size,
    });
  };
  return message.payload ? visit(message.payload, false) : false;
}

function messageDate(message: Message) {
  const timestamp = Number(message.internalDate);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function isUnread(message: Message) {
  return message.labelIds?.includes("UNREAD") ?? false;
}

/** `"홍길동" <hong@example.com>` becomes `홍길동`; bare addresses are kept. */
export function displayName(address: string) {
  const match = address.match(/^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/);
  return match?.[1] || address.replace(/[<>]/g, "").trim();
}

/** `"홍길동" <hong@example.com>` becomes `hong@example.com`; bare addresses are kept. */
export function emailAddress(address: string) {
  const bracketed = address.match(/<([^>]+)>/);
  return (bracketed?.[1] ?? address).trim().toLowerCase();
}

/** Gmail snippets arrive HTML-escaped, but they are rendered as plain text. */
export function decodeEntities(value: string) {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, body: string) => {
      if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
      const isHex = body[1].toLowerCase() === "x";
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
}

function decodeBody(data: string) {
  return Buffer.from(data, "base64url").toString("utf8");
}

function collect(part: Part, result: Pick<MailMessage, "html" | "text" | "attachments">) {
  const attachmentId = part.body?.attachmentId;
  if (part.filename && attachmentId) {
    const attachment: MailAttachment = {
      attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
    };
    result.attachments.push(attachment);
  } else if (part.body?.data && !part.filename) {
    if (part.mimeType === "text/html" && result.html === null) {
      result.html = decodeBody(part.body.data);
    } else if (part.mimeType === "text/plain" && result.text === null) {
      result.text = decodeBody(part.body.data);
    }
  }
  part.parts?.forEach((child) => collect(child, result));
}

export function toMailMessage(message: Message): MailMessage {
  const body: Pick<MailMessage, "html" | "text" | "attachments"> = {
    html: null,
    text: null,
    attachments: [],
  };
  if (message.payload) collect(message.payload, body);

  return {
    id: message.id ?? "",
    messageIdHeader: header(message, "Message-ID") || null,
    from: header(message, "From"),
    to: header(message, "To"),
    cc: header(message, "Cc"),
    replyTo: header(message, "Reply-To"),
    references: header(message, "References"),
    subject: header(message, "Subject") || NO_SUBJECT,
    date: messageDate(message),
    unread: isUnread(message),
    isDraft: message.labelIds?.includes("DRAFT") ?? false,
    ...body,
  };
}

/**
 * The parts of a draft needed to keep editing it, beyond `toMailMessage`:
 * Bcc (kept in drafts only), threading headers, and the raw subject.
 */
export function toDraftFields(message: Message) {
  return {
    bcc: header(message, "Bcc"),
    subject: header(message, "Subject"),
    inReplyTo: header(message, "In-Reply-To") || undefined,
    threadId: message.threadId ?? undefined,
  };
}

export function toMailThread(thread: gmail_v1.Schema$Thread): MailThread {
  const messages = (thread.messages ?? []).map(toMailMessage);
  return {
    id: thread.id ?? "",
    subject: messages[0]?.subject ?? NO_SUBJECT,
    messages,
  };
}

export function toThreadSummary(thread: gmail_v1.Schema$Thread): ThreadSummary {
  const messages = thread.messages ?? [];
  const first = messages[0];
  const last = messages[messages.length - 1];
  const from = last ? header(last, "From") : "";
  return {
    id: thread.id ?? "",
    subject: (first && header(first, "Subject")) || NO_SUBJECT,
    from: from && displayName(from),
    fromAddress: from && emailAddress(from),
    snippet: decodeEntities(last?.snippet ?? ""),
    date: last ? messageDate(last) : null,
    unread: messages.some(isUnread),
    messageCount: messages.length,
    hasAttachment: messages.some(hasRealAttachment),
  };
}
