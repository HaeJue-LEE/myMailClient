import { type ParsedMail, simpleParser } from "mailparser";
import type { FileAttachment } from "@/features/mail/bridge";
import { SENT_COPY_SUBJECT_PREFIX } from "@/features/mail/mail-accounts";
import type { MailLabel, SendAsAddress, ThreadSummary } from "@/features/mail/types";
import type { MailAccountCredentials } from "../accounts";
import type { MailBackend } from "../backend";
import { buildOutgoing, type OutgoingSource } from "../compose";
import { InvalidRequestError } from "../errors";
import { buildMimeMessage, newMessageId } from "../gmail/mime";
import { addressText, parsedHasAttachment, toMailMessage } from "../imap/parse";
import { toImapSearch } from "../imap/query";
import { sendSmtp } from "../imap/smtp";
import { type Pop3Session, withPop3 } from "./client";
import { type HeaderFacts, matchesSearch } from "./search";
import {
  addLocalMessage,
  type LocalFolder,
  listLocalMessages,
  readLocalMessage,
  readLocalState,
  removeLocalMessage,
  updateLocalState,
} from "./store";

const PAGE_SIZE = 20;
/**
 * Most headers downloaded for one page of a filtered list. Without a server
 * search every candidate costs a TOP; past this the page ends early and the
 * list offers to load more. Headers already cached cost nothing and do not count.
 */
const MAX_SCAN = 200;
const NO_SUBJECT = "(제목 없음)";
const SNIPPET_LENGTH = 200;

/**
 * Message ids handed to the renderer: `m.<UIDL>` for mail on the server, and
 * `d.<name>` / `s.<name>` for drafts and sent copies kept on this computer.
 * Message numbers are not used: they change from one session to the next.
 */
type MessageRef =
  | { where: "server"; uid: string }
  | { where: "local"; folder: LocalFolder; name: string };

export function encodePop3Id(ref: MessageRef) {
  return ref.where === "server"
    ? `m.${Buffer.from(ref.uid, "latin1").toString("base64url")}`
    : `${ref.folder === "drafts" ? "d" : "s"}.${ref.name}`;
}

export function decodePop3Id(id: string): MessageRef {
  const server = /^m\.([A-Za-z0-9_-]{1,200})$/.exec(id);
  if (server) {
    const uid = Buffer.from(server[1], "base64url").toString("latin1");
    // RFC 1939: 1 to 70 printable characters.
    if (/^[\x21-\x7e]{1,70}$/.test(uid)) return { where: "server", uid };
  }
  const local = /^([ds])\.([0-9a-f-]{36})$/.exec(id);
  if (local) {
    return { where: "local", folder: local[1] === "d" ? "drafts" : "sent", name: local[2] };
  }
  throw new InvalidRequestError("Not a message id");
}

type Headers = Omit<HeaderFacts, "seen" | "flagged"> & {
  fromName: string;
  fromAddress: string;
  /** Carries the mark of a copy this app sent to the account itself. */
  sentCopy: boolean;
  /** Exact once the whole message was read; from the headers alone, a best guess. */
  hasAttachment: boolean;
};

/**
 * Whether headers alone show a real attachment. Only Outlook says so outright
 * (`X-MS-Has-Attach`). The message's type is no guide: Hiworks sends every
 * mail as multipart/mixed, files or not, and a wrong clip in the list is
 * worse than one that appears once the message has been opened.
 */
export function headersSuggestAttachment(parsed: Pick<ParsedMail, "headers">): boolean {
  const outlook = parsed.headers.get("x-ms-has-attach");
  return typeof outlook === "string" && /^yes$/i.test(outlook.trim());
}

/** Set on the copy sent to the account itself, so the inbox can leave it out. */
const SENT_COPY_HEADER = "X-Mail-Client-Copy";

/**
 * The copy of a sent message that goes to the account itself: the subject
 * gets `SENT_COPY_SUBJECT_PREFIX`, and the Bcc header stays, so the copy
 * records every recipient. It has a Message-ID of its own, so a server that
 * drops duplicates cannot mistake it for the original (when the account is
 * also a recipient).
 */
export function sentCopyMessage(
  message: Parameters<typeof buildMimeMessage>[0],
  email: string,
) {
  const subject = message.subject.startsWith(SENT_COPY_SUBJECT_PREFIX)
    ? message.subject
    : `${SENT_COPY_SUBJECT_PREFIX}${message.subject}`;
  const raw = buildMimeMessage({ ...message, subject, messageId: newMessageId(email) });
  return `${SENT_COPY_HEADER}: sent\r\n${raw}`;
}

/** Parsed headers by account and UIDL: a message's headers never change. */
const headerCache = new Map<string, Headers>();
const HEADER_CACHE_SIZE = 20_000;

/** Messages parsed most recently, so saving an attachment does not download again. */
const parsedCache = new Map<string, ParsedMail>();
const PARSED_CACHE_SIZE = 4;

function remember<T>(cache: Map<string, T>, size: number, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  for (const oldest of cache.keys()) {
    if (cache.size <= size) break;
    cache.delete(oldest);
  }
}

/** One POP3 session per account at a time: servers lock the mailbox while signed in. */
const queues = new Map<string, Promise<unknown>>();

const HEADER_END = Buffer.from("\r\n\r\n");

/**
 * The message with its header section in UTF-8. Some Korean mailers put raw
 * EUC-KR bytes into headers instead of encoded words; a parser reading them
 * as UTF-8 shows garbage. The body is left alone: its charset is declared.
 */
export function normalizeHeaders(raw: Buffer): Buffer {
  const end = raw.indexOf(HEADER_END);
  const head = end < 0 ? raw : raw.subarray(0, end);
  if (!head.some((byte) => byte >= 0x80)) return raw;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return raw;
  } catch {
    // Not UTF-8: CP949, the superset of EUC-KR that Korean mail actually uses.
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("euc-kr").decode(head);
  } catch {
    return raw;
  }
  return Buffer.concat([Buffer.from(decoded, "utf8"), end < 0 ? Buffer.alloc(0) : raw.subarray(end)]);
}

const parse = (raw: Buffer) => simpleParser(normalizeHeaders(raw));

function timestamp(value: Date | undefined) {
  const time = value ? value.getTime() : Number.NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** `complete`: `parsed` is the whole message, not just its headers (TOP n 0). */
function toHeaders(parsed: ParsedMail, complete: boolean): Headers {
  const sender = [parsed.from].flat()[0]?.value[0];
  const address = (sender?.address ?? "").toLowerCase();
  return {
    subject: parsed.subject ?? "",
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    bcc: addressText(parsed.bcc),
    date: timestamp(parsed.date),
    fromName: sender?.name || address,
    fromAddress: address,
    sentCopy: parsed.headers.has(SENT_COPY_HEADER.toLowerCase()),
    hasAttachment: complete ? parsedHasAttachment(parsed) : headersSuggestAttachment(parsed),
  };
}

function summary(
  id: string,
  headers: Headers,
  meta: { unread: boolean; snippet: string; date?: number | null },
): ThreadSummary {
  return {
    id,
    subject: headers.subject || NO_SUBJECT,
    from: headers.fromName,
    fromAddress: headers.fromAddress,
    snippet: meta.snippet,
    date: headers.date ?? meta.date ?? null,
    unread: meta.unread,
    messageCount: 1,
    hasAttachment: headers.hasAttachment,
  };
}

const LOCAL_LABELS: Record<string, LocalFolder> = { DRAFT: "drafts", SENT: "sent" };

/**
 * A POP3/SMTP account such as Hiworks. The server has the inbox only and is
 * never changed: nothing is deleted there. Lists show headers fetched with
 * TOP (no body); a body is downloaded when the message is opened.
 */
export function createPop3Backend(account: MailAccountCredentials): MailBackend {
  const key = (part: string) => `${account.id}:${part}`;

  const session = <T>(task: (session: Pop3Session) => Promise<T>): Promise<T> => {
    const result = (queues.get(account.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => withPop3(account, task));
    queues.set(account.id, result);
    return result;
  };

  const self: SendAsAddress = {
    email: account.email,
    name: account.name,
    isDefault: true,
    isPrimary: true,
    signature: "",
  };

  const headersOf = async (pop: Pop3Session, number: number, uid: string) => {
    const cached = headerCache.get(key(uid));
    if (cached) return cached;
    const headers = toHeaders(await parse(await pop.headers(number)), false);
    remember(headerCache, HEADER_CACHE_SIZE, key(uid), headers);
    return headers;
  };

  /** Downloads and parses a whole message. */
  const loadMessage = async (id: string) => {
    const ref = decodePop3Id(id);
    let raw: Buffer | null;
    if (ref.where === "local") {
      raw = await readLocalMessage(account.id, ref.folder, ref.name);
    } else {
      raw = await session(async (pop) => {
        const found = (await pop.uidl()).find((message) => message.uid === ref.uid);
        return found ? pop.retrieve(found.number) : null;
      });
    }
    if (!raw) throw new InvalidRequestError("Message not found");
    const parsed = await parse(raw);
    remember(parsedCache, PARSED_CACHE_SIZE, key(id), parsed);
    if (ref.where === "server") {
      // Now the attachment flag is exact; the list shows that from here on,
      // also after a restart (it is kept with the account's read marks).
      const headers = toHeaders(parsed, true);
      remember(headerCache, HEADER_CACHE_SIZE, key(ref.uid), headers);
      await updateLocalState(account.id, (state) => {
        state.attachments.set(ref.uid, headers.hasAttachment);
      }).catch((error: Error) => {
        // The message is open; a flag not kept is not worth failing that for.
        console.warn("[pop3] could not keep the attachment flag", error.message);
      });
    }
    return { ref, parsed };
  };

  const parsedMessage = async (id: string) =>
    parsedCache.get(key(id)) ?? (await loadMessage(id)).parsed;

  const getAttachmentData = async (messageId: string, attachmentId: string) => {
    const parsed = await parsedMessage(messageId);
    const attachment = /^\d+$/.test(attachmentId)
      ? parsed.attachments[Number(attachmentId)]
      : undefined;
    if (!attachment) throw new InvalidRequestError("Attachment not found");
    return attachment.content;
  };

  const source: OutgoingSource = {
    listSendAs: async () => [self],
    getAttachmentData,
  };

  const listServer = async (
    search: ReturnType<typeof toImapSearch>,
    starredOnly: boolean,
    offset: number,
  ) => {
    const state = await readLocalState(account.id);
    return session(async (pop) => {
      // Message numbers follow arrival order, so descending is newest first.
      const messages = (await pop.uidl()).sort((a, b) => b.number - a.number);
      const threads: ThreadSummary[] = [];
      let index = offset;
      let downloaded = 0;
      for (; index < messages.length; index++) {
        if (threads.length === PAGE_SIZE || downloaded === MAX_SCAN) break;
        const { number, uid } = messages[index];
        const flagged = state.starred.has(uid);
        if (starredOnly && !flagged) continue;
        if (!headerCache.has(key(uid))) downloaded++;
        const headers = await headersOf(pop, number, uid);
        // Copies of sent mail are kept on the server only; Sent shows the local copy.
        if (headers.sentCopy && headers.fromAddress === account.email) continue;
        const seen = state.read.has(uid);
        if (!matchesSearch(search, { ...headers, seen, flagged })) continue;
        // No snippet: a preview would mean downloading part of the body.
        // What opening the message showed beats what its headers suggest.
        const hasAttachment = state.attachments.get(uid) ?? headers.hasAttachment;
        threads.push(
          summary(encodePop3Id({ where: "server", uid }), { ...headers, hasAttachment }, {
            unread: !seen,
            snippet: "",
          }),
        );
      }
      return { threads, nextPageToken: index < messages.length ? String(index) : null };
    });
  };

  const listLocal = async (
    folder: LocalFolder,
    search: ReturnType<typeof toImapSearch>,
    offset: number,
  ) => {
    // Few enough to read in full; drafts and sent mail are always read.
    const matched: ThreadSummary[] = [];
    for (const { name, storedAt } of await listLocalMessages(account.id, folder)) {
      const raw = await readLocalMessage(account.id, folder, name);
      if (!raw) continue;
      const parsed = await parse(raw);
      const headers = toHeaders(parsed, true);
      if (!matchesSearch(search, { ...headers, seen: true, flagged: false })) continue;
      const snippet = (parsed.text ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_LENGTH);
      matched.push(
        summary(encodePop3Id({ where: "local", folder, name }), headers, {
          unread: false,
          snippet,
          date: storedAt,
        }),
      );
    }
    const next = offset + PAGE_SIZE;
    return {
      threads: matched.slice(offset, next),
      nextPageToken: next < matched.length ? String(next) : null,
    };
  };

  /** Stores the outgoing message as a draft and drops the one it replaces. */
  const storeDraft = async (raw: string, previous: string | undefined) => {
    const name = await addLocalMessage(account.id, "drafts", raw);
    if (previous) await deleteLocal(previous, "drafts");
    return encodePop3Id({ where: "local", folder: "drafts", name });
  };

  const deleteLocal = async (id: string, only?: LocalFolder) => {
    const ref = decodePop3Id(id);
    if (ref.where !== "local" || (only && ref.folder !== only)) {
      throw new InvalidRequestError("Not a stored message");
    }
    await removeLocalMessage(account.id, ref.folder, ref.name);
    parsedCache.delete(key(id));
  };

  return {
    ...source,

    // POP3 has the inbox only; drafts and sent mail are the app's own.
    listLabels: async (): Promise<MailLabel[]> => [],

    listThreads: async ({ labelId, query, pageToken }) => {
      const label = labelId ?? "INBOX";
      const offset = pageToken && /^\d+$/.test(pageToken) ? Number(pageToken) : 0;
      const search = toImapSearch(query);
      if (label === "INBOX" || label === "STARRED") {
        return listServer(search, label === "STARRED", offset);
      }
      const folder = LOCAL_LABELS[label];
      if (folder) return listLocal(folder, search, offset);
      // Spam, trash and the like do not exist here.
      return { threads: [], nextPageToken: null };
    },

    getThread: async (threadId) => {
      const { ref, parsed } = await loadMessage(threadId);
      const state = ref.where === "server" ? await readLocalState(account.id) : null;
      const message = toMailMessage(parsed, {
        id: threadId,
        unread: ref.where === "server" && !state?.read.has(ref.uid),
        isDraft: ref.where === "local" && ref.folder === "drafts",
        date: parsed.date,
      });
      return { id: threadId, subject: message.subject, messages: [message] };
    },

    modifyThreads: async (threadIds, { addLabelIds, removeLabelIds }) => {
      const known = new Set(["UNREAD", "STARRED"]);
      if ([...addLabelIds, ...removeLabelIds].some((label) => !known.has(label))) {
        throw new InvalidRequestError("This account does not support that change");
      }
      const uids = threadIds.flatMap((id) => {
        const ref = decodePop3Id(id);
        return ref.where === "server" ? [ref.uid] : [];
      });
      if (uids.length === 0) return;
      await updateLocalState(account.id, (state) => {
        for (const uid of uids) {
          if (addLabelIds.includes("UNREAD")) state.read.delete(uid);
          if (removeLabelIds.includes("UNREAD")) state.read.add(uid);
          if (addLabelIds.includes("STARRED")) state.starred.add(uid);
          if (removeLabelIds.includes("STARRED")) state.starred.delete(uid);
        }
      });
    },

    trashThreads: async (threadIds) => {
      const refs = threadIds.map(decodePop3Id);
      // Deleting on a POP3 server cannot be undone, and webmail would lose it too.
      if (refs.some((ref) => ref.where === "server")) {
        throw new InvalidRequestError("Mail on a POP3 server is not deleted from this app");
      }
      for (const id of threadIds) await deleteLocal(id);
    },

    untrashThreads: async () => {
      throw new InvalidRequestError("This account has no trash");
    },

    sendMessage: async (input) => {
      const message = await buildOutgoing(source, account.email, input);
      const { bcc } = message;
      const stamped = {
        ...message,
        bcc: undefined,
        date: new Date(),
        messageId: newMessageId(account.email),
      };
      await sendSmtp(account, {
        from: account.email,
        recipients: [...message.to, ...(message.cc ?? []), ...(bcc ?? [])],
        // No Bcc header: SMTP servers pass headers on as they are.
        raw: buildMimeMessage(stamped),
      });
      if (account.sendCopyToSelf) {
        try {
          await sendSmtp(account, {
            from: account.email,
            recipients: [account.email],
            raw: sentCopyMessage({ ...stamped, bcc }, account.email),
          });
        } catch (error) {
          // The mail itself is out; a missing server copy is not worth an error.
          console.warn("[pop3] sent, but the copy to self failed", (error as Error).message);
        }
      }
      try {
        if (account.saveSentCopy) {
          await addLocalMessage(account.id, "sent", buildMimeMessage({ ...stamped, bcc }));
        }
        if (input.draftId) await deleteLocal(input.draftId, "drafts");
      } catch (error) {
        // The mail is out: reporting a failure now would invite sending it twice.
        console.warn("[pop3] sent, but tidying up failed", (error as Error).message);
      }
      return { id: stamped.messageId, threadId: "" };
    },

    saveDraft: async (input) => {
      const message = await buildOutgoing(source, account.email, input);
      // Drafts keep their Bcc header; it is how the recipients are restored.
      const raw = buildMimeMessage({
        ...message,
        date: new Date(),
        messageId: newMessageId(account.email),
      });
      return { draftId: await storeDraft(raw, input.draftId) };
    },

    deleteDraft: (draftId) => deleteLocal(draftId, "drafts"),

    openDraft: async (messageId) => {
      const { parsed } = await loadMessage(messageId);
      const attachments = parsed.attachments.map(
        (attachment, index): FileAttachment => ({
          kind: "file",
          filename: attachment.filename || `attachment-${index + 1}`,
          mimeType: attachment.contentType || "application/octet-stream",
          data: attachment.content,
        }),
      );
      return {
        draftId: messageId,
        from: addressText(parsed.from),
        to: addressText(parsed.to),
        cc: addressText(parsed.cc),
        bcc: addressText(parsed.bcc),
        subject: parsed.subject ?? "",
        html: parsed.html || null,
        text: parsed.text ?? null,
        attachments,
        inReplyTo: parsed.inReplyTo,
        references: [parsed.references].flat().filter(Boolean).join(" ") || undefined,
      };
    },
  };
}
