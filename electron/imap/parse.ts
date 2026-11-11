import type { FetchMessageObject, MessageStructureObject } from "imapflow";
import type { AddressObject, ParsedMail } from "mailparser";
import { isRealAttachment } from "@/features/mail/attachments";
import type {
  MailAttachment,
  MailMessage,
  ThreadSummary,
} from "@/features/mail/types";
import { decodeEntities } from "../gmail/parse";

const NO_SUBJECT = "(제목 없음)";
const SNIPPET_LENGTH = 200;

export type TextPart = {
  /** IMAP part number, e.g. `1` or `1.2`. */
  part: string;
  encoding: string;
  charset: string;
  html: boolean;
};

/** The body part to preview: the first plain-text part, else the first HTML part. */
export function findTextPart(structure: MessageStructureObject | undefined): TextPart | null {
  let html: TextPart | null = null;
  const visit = (node: MessageStructureObject): TextPart | null => {
    if (node.childNodes?.length) {
      for (const child of node.childNodes) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    }
    const type = node.type.toLowerCase();
    if (node.disposition?.toLowerCase() === "attachment") return null;
    if (type !== "text/plain" && type !== "text/html") return null;
    const part: TextPart = {
      part: node.part ?? "1",
      encoding: (node.encoding ?? "").toLowerCase(),
      charset: node.parameters?.charset ?? "utf-8",
      html: type === "text/html",
    };
    if (!part.html) return part;
    html ??= part;
    return null;
  };
  return (structure && visit(structure)) || html;
}

function decodeTransfer(bytes: Buffer, encoding: string) {
  if (encoding === "base64") {
    const clean = bytes.toString("latin1").replace(/[^A-Za-z0-9+/]/g, "");
    // The bytes are a prefix of the part: drop an incomplete final group.
    return Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
  }
  if (encoding === "quoted-printable") {
    const text = bytes
      .toString("latin1")
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
      .replace(/=[0-9A-Fa-f]?$/, "");
    return Buffer.from(text, "latin1");
  }
  return bytes;
}

function decodeCharset(bytes: Buffer, charset: string) {
  try {
    // Korean mail is often EUC-KR; TextDecoder knows the legacy charsets.
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Plain text of a (possibly cut-off) HTML fragment; rendered as text, never as HTML. */
function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<(style|script|head|title)\b[\s\S]*?(<\/\1>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(-->|$)/g, " ")
      .replace(/<[^>]*(>|$)/g, " "),
  );
}

/** A one-line preview from the first bytes of a message's text part. */
export function decodeSnippet(bytes: Buffer, part: Omit<TextPart, "part">) {
  const decoded = decodeCharset(decodeTransfer(bytes, part.encoding), part.charset)
    // A multi-byte character cut in half at the end.
    .replace(/�+$/, "");
  return (part.html ? htmlToText(decoded) : decoded)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNIPPET_LENGTH);
}

function timestamp(value: Date | string | undefined) {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** True when the body structure holds a file worth flagging (see `isRealAttachment`). */
export function structureHasAttachment(structure: MessageStructureObject | undefined): boolean {
  const visit = (node: MessageStructureObject, inRelated: boolean): boolean => {
    const type = node.type.toLowerCase();
    if (node.childNodes?.length) {
      const related = inRelated || type === "multipart/related";
      return node.childNodes.some((child) => visit(child, related));
    }
    return isRealAttachment({
      mimeType: type,
      filename: node.dispositionParameters?.filename ?? node.parameters?.name,
      disposition: node.disposition,
      hasContentId: Boolean(node.id),
      inRelated,
      // The encoded size; close enough to tell an icon from a photo.
      size: node.size,
    });
  };
  return structure ? visit(structure, false) : false;
}

/** The same test for a fully downloaded message. */
export function parsedHasAttachment(parsed: ParsedMail): boolean {
  return parsed.attachments.some((attachment) =>
    isRealAttachment({
      mimeType: attachment.contentType,
      filename: attachment.filename,
      disposition: attachment.contentDisposition,
      hasContentId: Boolean(attachment.contentId || attachment.cid),
      inRelated: attachment.related,
      size: attachment.size,
    }),
  );
}

/** One message shown as a conversation of its own in the list. */
export function toThreadSummary(
  message: FetchMessageObject,
  id: string,
  snippet: string,
): ThreadSummary {
  const sender = message.envelope?.from?.[0];
  const address = (sender?.address ?? "").toLowerCase();
  return {
    id,
    subject: message.envelope?.subject || NO_SUBJECT,
    from: sender?.name || address,
    fromAddress: address,
    snippet,
    date: timestamp(message.internalDate) ?? timestamp(message.envelope?.date),
    unread: !message.flags?.has("\\Seen"),
    messageCount: 1,
    hasAttachment: structureHasAttachment(message.bodyStructure),
  };
}

/** An address header as text, e.g. `"홍길동" <hong@example.com>, kim@example.com`. */
export function addressText(value: AddressObject | AddressObject[] | undefined) {
  return [value]
    .flat()
    .flatMap((item) => (item ? [item.text] : []))
    .join(", ");
}

/**
 * The attachments to offer for saving, each with its position in
 * `parsed.attachments` as the id. Images shown inside the HTML body are left out.
 */
export function listedAttachments(parsed: ParsedMail): MailAttachment[] {
  return parsed.attachments.flatMap((attachment, index) =>
    attachment.related && parsed.html
      ? []
      : [
          {
            attachmentId: String(index),
            filename: attachment.filename || `attachment-${index + 1}`,
            mimeType: attachment.contentType || "application/octet-stream",
            size: attachment.size,
          },
        ],
  );
}

export function toMailMessage(
  parsed: ParsedMail,
  meta: { id: string; unread: boolean; isDraft: boolean; date: Date | string | undefined },
): MailMessage {
  return {
    id: meta.id,
    messageIdHeader: parsed.messageId || null,
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    replyTo: addressText(parsed.replyTo),
    references: [parsed.references].flat().filter(Boolean).join(" "),
    subject: parsed.subject || NO_SUBJECT,
    date: timestamp(meta.date) ?? timestamp(parsed.date),
    html: parsed.html || null,
    text: parsed.text ?? null,
    attachments: listedAttachments(parsed),
    unread: meta.unread,
    isDraft: meta.isDraft,
  };
}
