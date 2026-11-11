import type { GmailAttachment } from "@/features/mail/bridge";
import { formatRecipient } from "@/features/mail/contacts";
import type { MailMessage } from "@/features/mail/types";

export type ReplyMode = "reply" | "replyAll" | "forward";

export type Mailbox = { name: string; email: string };

/**
 * Splits an address header (`"Kim, J" <j@x.com>, b@y.com`) into mailboxes.
 * Commas inside quotes or angle brackets do not split.
 */
export function parseAddressList(header: string): Mailbox[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const char of header) {
    if (char === '"' && !angled) quoted = !quoted;
    else if (char === "<" && !quoted) angled = true;
    else if (char === ">" && !quoted) angled = false;
    if ((char === "," || char === ";") && !quoted && !angled) {
      entries.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  entries.push(current);

  return entries.flatMap((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return [];
    const bracketed = trimmed.match(/^(.*)<([^<>]+)>\s*$/);
    const email = (bracketed ? bracketed[2] : trimmed).trim().toLowerCase();
    if (!email.includes("@")) return [];
    const name = bracketed
      ? bracketed[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim()
      : "";
    return [{ name, email }];
  });
}

const REPLY_PREFIX = /^\s*(re|회신|답장)\s*:/i;
const FORWARD_PREFIX = /^\s*(fwd?|전달)\s*:/i;

/** `Re:` / `Fwd:` added once; existing prefixes (any case, Korean too) are kept. */
export function subjectFor(mode: ReplyMode, subject: string) {
  if (mode === "forward") {
    return FORWARD_PREFIX.test(subject) ? subject : `Fwd: ${subject}`;
  }
  return REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`;
}

export function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text as HTML that keeps its line breaks. */
export function textToHtml(text: string) {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

const quoteDate = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "full",
  timeStyle: "short",
});

function dedupe(mailboxes: Mailbox[], skip: Set<string>) {
  const seen = new Set(skip);
  return mailboxes.filter((mailbox) => {
    if (seen.has(mailbox.email)) return false;
    seen.add(mailbox.email);
    return true;
  });
}

const formatList = (mailboxes: Mailbox[]) =>
  mailboxes.map((mailbox) => formatRecipient(mailbox)).join(", ");

export type ReplyStart = {
  to: string;
  cc: string;
  subject: string;
  /** The alias the original was addressed to, to reply from it. */
  from?: string;
  /** HTML placed below the (empty) new text: the quote or forwarded message. */
  quoteHtml: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments: GmailAttachment[];
};

/**
 * What a reply, reply-all, or forward starts with. `myAddresses` are the
 * account's own addresses (all send-as aliases), never replied to.
 * `sanitize` makes the original's HTML safe for the editor.
 */
export function startReply(
  original: MailMessage,
  threadId: string,
  mode: ReplyMode,
  myAddresses: readonly string[],
  sanitize: (html: string) => string,
): ReplyStart {
  const me = new Set(myAddresses.map((email) => email.toLowerCase()));
  const from = parseAddressList(original.from);
  const to = parseAddressList(original.to);
  const cc = parseAddressList(original.cc);
  const replyTo = parseAddressList(original.replyTo);
  const sentByMe = from.some((mailbox) => me.has(mailbox.email));

  // Reply from the address the message reached (or was sent from, if mine).
  const alias = [...(sentByMe ? from : []), ...to, ...cc].find((mailbox) =>
    me.has(mailbox.email),
  )?.email;

  const body = original.html !== null
    ? sanitize(original.html)
    : textToHtml(original.text ?? "");
  const when = original.date ? quoteDate.format(original.date) : "";

  if (mode === "forward") {
    const lines = [
      "---------- 전달된 메일 ----------",
      `보낸사람: ${original.from}`,
      when && `날짜: ${when}`,
      `제목: ${original.subject}`,
      `받는사람: ${original.to}`,
      original.cc && `참조: ${original.cc}`,
    ].filter(Boolean) as string[];
    return {
      to: "",
      cc: "",
      subject: subjectFor("forward", original.subject),
      from: alias,
      quoteHtml: `<div data-mc="quote"><div>${lines.map(escapeHtml).join("<br>")}</div><br>${body}</div>`,
      attachments: original.attachments.map((attachment) => ({
        kind: "gmail",
        messageId: original.id,
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
    };
  }

  // Replying to my own message goes to its recipients, as Gmail does.
  const primary = sentByMe ? to : replyTo.length > 0 ? replyTo : from;
  const toList = dedupe(
    mode === "replyAll" ? [...primary, ...(sentByMe ? [] : to)] : primary,
    me,
  );
  const ccList =
    mode === "replyAll"
      ? dedupe(cc, new Set([...me, ...toList.map((mailbox) => mailbox.email)]))
      : [];

  const author = from[0] ? formatRecipient(from[0]) : original.from;
  const attribution = `${when ? `${when}, ` : ""}${author}님이 작성:`;
  const references = [original.references, original.messageIdHeader]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    to: toList.length ? `${formatList(toList)}, ` : "",
    cc: ccList.length ? `${formatList(ccList)}, ` : "",
    subject: subjectFor(mode, original.subject),
    from: alias,
    quoteHtml:
      `<div data-mc="quote"><div>${escapeHtml(attribution)}</div>` +
      `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`,
    threadId,
    inReplyTo: original.messageIdHeader ?? undefined,
    references: references || undefined,
    attachments: [],
  };
}
