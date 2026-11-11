import type { gmail_v1 } from "@googleapis/gmail";
import { z } from "zod";
import {
  type DraftContent,
  type FileAttachment,
  MAX_ATTACHMENT_BYTES,
  type SendMessageInput,
} from "@/features/mail/bridge";
import { emailSchema } from "@/features/mail/email";
import { InvalidRequestError } from "./errors";
import { formatMailbox, type OutgoingAttachment, type OutgoingMessage } from "./gmail/mime";
import { toDraftFields, toMailMessage } from "./gmail/parse";
import { findDraft, getAttachmentData } from "./gmail/service";
import type { SendAsAddress } from "@/features/mail/types";

const addresses = z.array(emailSchema);
const id = z.string().min(1).max(512);
/** Message-ID style header values; line breaks are stripped again when written. */
const headerValue = z.string().max(4000);

const attachment = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    filename: z.string().min(1).max(255),
    mimeType: z.string().max(255),
    data: z.instanceof(Uint8Array),
  }),
  z.object({
    kind: z.literal("gmail"),
    messageId: id,
    attachmentId: z.string().min(1).max(4096),
    filename: z.string().min(1).max(255),
    mimeType: z.string().max(255),
    size: z.number().int().nonnegative(),
  }),
]);

/** What the renderer may send for a message; shared by sending and drafts. */
export const composeSchema = z.object({
  to: addresses,
  cc: addresses,
  bcc: addresses,
  subject: z.string().max(998),
  text: z.string(),
  html: z.string().optional(),
  from: emailSchema.optional(),
  attachments: z.array(attachment).max(100).optional(),
  threadId: id.optional(),
  inReplyTo: headerValue.optional(),
  references: headerValue.optional(),
  draftId: id.optional(),
}) satisfies z.ZodType<SendMessageInput>;

/**
 * A draft ready to edit. Its attachments are downloaded: each save replaces
 * the draft's message, so references to the old one would stop working.
 */
export async function openDraft(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<DraftContent> {
  const found = await findDraft(gmail, messageId);
  if (!found) throw new InvalidRequestError("Draft not found");
  const message = toMailMessage(found.message);
  const fields = toDraftFields(found.message);
  const attachments: FileAttachment[] = [];
  for (const attachment of message.attachments) {
    attachments.push({
      kind: "file",
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      data: await getAttachmentData(gmail, message.id, attachment.attachmentId),
    });
  }
  return {
    draftId: found.draftId,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: fields.bcc,
    subject: fields.subject,
    html: message.html,
    text: message.text,
    attachments,
    threadId: fields.threadId,
    inReplyTo: fields.inReplyTo,
    references: message.references || undefined,
  };
}

/** Total attachment size, counting Gmail attachments by their reported size. */
export function attachmentBytes(attachments: SendMessageInput["attachments"]) {
  return (attachments ?? []).reduce(
    (total, item) => total + (item.kind === "file" ? item.data.byteLength : item.size),
    0,
  );
}

/** What building a message needs from the account it is sent from. */
export type OutgoingSource = {
  listSendAs: () => Promise<SendAsAddress[]>;
  /** The bytes of an attachment of an existing message (e.g. when forwarding). */
  getAttachmentData: (messageId: string, attachmentId: string) => Promise<Buffer>;
};

/**
 * Turns the renderer's request into a message ready to send: the From header
 * of a verified send-as address, and every attachment as bytes.
 */
export async function buildOutgoing(
  source: OutgoingSource,
  accountEmail: string,
  input: SendMessageInput,
): Promise<OutgoingMessage & { threadId?: string }> {
  if (attachmentBytes(input.attachments) > MAX_ATTACHMENT_BYTES) {
    throw new InvalidRequestError("Attachments exceed the size limit");
  }

  // Checked against the account every time: only its verified addresses may be used.
  const senders = await source.listSendAs();
  const sender = input.from
    ? senders.find((alias) => alias.email === input.from?.toLowerCase())
    : (senders.find((alias) => alias.isDefault) ??
      senders.find((alias) => alias.isPrimary));
  if (input.from && !sender) {
    throw new InvalidRequestError("From address is not a verified send-as address");
  }

  const attachments: OutgoingAttachment[] = [];
  for (const item of input.attachments ?? []) {
    attachments.push({
      filename: item.filename,
      mimeType: item.mimeType,
      data:
        item.kind === "file"
          ? item.data
          : await source.getAttachmentData(item.messageId, item.attachmentId),
    });
  }
  // The real size of downloaded attachments, in case a reported size was off.
  const total = attachments.reduce((sum, item) => sum + item.data.byteLength, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new InvalidRequestError("Attachments exceed the size limit");
  }

  return {
    from: sender ? formatMailbox(sender.name, sender.email) : accountEmail,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments,
    threadId: input.threadId,
  };
}
