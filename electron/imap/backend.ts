import type { FetchMessageObject, ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import type { FileAttachment } from "@/features/mail/bridge";
import type { SendAsAddress } from "@/features/mail/types";
import type { MailAccountCredentials } from "../accounts";
import type { MailBackend } from "../backend";
import { buildOutgoing, type OutgoingSource } from "../compose";
import { InvalidRequestError, MailServerError } from "../errors";
import { buildMimeMessage, newMessageId } from "../gmail/mime";
import { getFolders, type ImapState, runImap } from "./connection";
import { resolveLabel } from "./folders";
import { decodeMessageId, encodeMessageId, type MessageRef } from "./ids";
import {
  addressText,
  decodeSnippet,
  findTextPart,
  toMailMessage,
  toThreadSummary,
} from "./parse";
import { toImapSearch } from "./query";
import { sendSmtp } from "./smtp";

const PAGE_SIZE = 20;
/** Enough of a text part for a one-line preview (HTML needs more to get past its head). */
const SNIPPET_BYTES = { text: 1024, html: 6144 };

/**
 * Messages parsed most recently, so saving or forwarding the attachments of
 * the open message does not download it again.
 */
const parsedCache = new Map<string, ParsedMail>();
const PARSED_CACHE_SIZE = 4;

function remember(key: string, parsed: ParsedMail) {
  parsedCache.delete(key);
  parsedCache.set(key, parsed);
  for (const oldest of parsedCache.keys()) {
    if (parsedCache.size <= PARSED_CACHE_SIZE) break;
    parsedCache.delete(oldest);
  }
}

/** Selects the message's folder; fails when its UIDs are no longer valid. */
async function openFor(client: ImapFlow, ref: MessageRef) {
  const mailbox = await client.mailboxOpen(ref.path);
  if (String(mailbox.uidValidity) !== ref.uidValidity) {
    throw new InvalidRequestError("The folder changed; reload the list");
  }
  return mailbox;
}

async function readSnippet(client: ImapFlow, message: FetchMessageObject) {
  const part = findTextPart(message.bodyStructure);
  if (!part) return "";
  try {
    const fetched = await client.fetchOne(
      String(message.uid),
      {
        bodyParts: [
          {
            key: part.part,
            start: 0,
            maxLength: part.html ? SNIPPET_BYTES.html : SNIPPET_BYTES.text,
          },
        ],
      },
      { uid: true },
    );
    const bytes = fetched && fetched.bodyParts?.values().next().value;
    return bytes ? decodeSnippet(bytes, part) : "";
  } catch {
    // A preview is not worth failing the list for.
    return "";
  }
}

/** Deletes a message for good (drafts only); one already gone counts as deleted. */
async function removeMessage(client: ImapFlow, id: string) {
  const ref = decodeMessageId(id);
  const mailbox = await client.mailboxOpen(ref.path);
  if (String(mailbox.uidValidity) !== ref.uidValidity) return;
  await client.messageDelete([ref.uid], { uid: true });
}

/** An IMAP/SMTP account such as Naver. Each message is a conversation of its own. */
export function createImapBackend(account: MailAccountCredentials): MailBackend {
  const run = <T>(task: (client: ImapFlow, state: ImapState) => Promise<T>) =>
    runImap(account, task);
  const cacheKey = (id: string) => `${account.id}:${id}`;

  const self: SendAsAddress = {
    email: account.email,
    name: account.name,
    isDefault: true,
    isPrimary: true,
    signature: "",
  };

  /** Downloads and parses a whole message. */
  const loadMessage = async (client: ImapFlow, id: string) => {
    const ref = decodeMessageId(id);
    await openFor(client, ref);
    const fetched = await client.fetchOne(
      String(ref.uid),
      { uid: true, flags: true, internalDate: true, source: true },
      { uid: true },
    );
    if (!fetched || !fetched.source) {
      throw new InvalidRequestError("Message not found");
    }
    const parsed = await simpleParser(fetched.source);
    remember(cacheKey(id), parsed);
    return { ref, fetched, parsed };
  };

  const parsedMessage = (id: string) => {
    const cached = parsedCache.get(cacheKey(id));
    return cached
      ? Promise.resolve(cached)
      : run(async (client) => (await loadMessage(client, id)).parsed);
  };

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

  /** Runs `task` once per folder, with the UIDs of `ids` that live in it. */
  const forEachFolder = (
    ids: string[],
    task: (client: ImapFlow, uids: number[], path: string, state: ImapState) => Promise<void>,
  ) => {
    const refs = ids.map(decodeMessageId);
    return run(async (client, state) => {
      for (const [path, group] of Map.groupBy(refs, (ref) => ref.path)) {
        await openFor(client, group[0]);
        const current = group.filter((ref) => ref.uidValidity === group[0].uidValidity);
        await task(client, current.map((ref) => ref.uid), path, state);
      }
    });
  };

  /** Stores a message in a folder and returns its id there. */
  const appendMessage = async (
    client: ImapFlow,
    path: string,
    raw: string,
    flags: string[],
    messageId: string,
  ) => {
    const appended = await client.append(path, raw, flags);
    if (appended && appended.uid && appended.uidValidity !== undefined) {
      return encodeMessageId({
        path,
        uidValidity: String(appended.uidValidity),
        uid: appended.uid,
      });
    }
    // The server did not report the new UID: find the message by its Message-ID.
    const mailbox = await client.mailboxOpen(path);
    const found = await client.search(
      { header: { "message-id": messageId } },
      { uid: true },
    );
    const uid = found ? Math.max(...found) : 0;
    if (!found || uid < 1) throw new MailServerError("server_error", "Draft was not stored");
    return encodeMessageId({ path, uidValidity: String(mailbox.uidValidity), uid });
  };

  return {
    ...source,

    listLabels: () =>
      run(async (client, state) => (await getFolders(client, state, true)).labels),

    listThreads: ({ labelId, query, pageToken }) =>
      run(async (client, state) => {
        const folders = await getFolders(client, state);
        // A search without a label looks through the inbox.
        const target = resolveLabel(folders, labelId ?? "INBOX");
        const mailbox = await client.mailboxOpen(target.path);
        const search = toImapSearch(query);
        const found = await client.search(
          target.flagged ? { ...search, flagged: true } : search,
          { uid: true },
        );
        // UIDs grow as mail arrives, so descending is newest first.
        const uids = [...(found || [])].sort((a, b) => b - a);
        const offset = pageToken && /^\d+$/.test(pageToken) ? Number(pageToken) : 0;
        const page = uids.slice(offset, offset + PAGE_SIZE);
        if (page.length === 0) return { threads: [], nextPageToken: null };

        const fetched = await client.fetchAll(
          page,
          { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true },
          { uid: true },
        );
        const byUid = new Map(fetched.map((message) => [message.uid, message]));
        const threads = [];
        for (const uid of page) {
          const message = byUid.get(uid);
          if (!message) continue;
          const id = encodeMessageId({
            path: mailbox.path,
            uidValidity: String(mailbox.uidValidity),
            uid,
          });
          threads.push(toThreadSummary(message, id, await readSnippet(client, message)));
        }
        const next = offset + PAGE_SIZE;
        return { threads, nextPageToken: next < uids.length ? String(next) : null };
      }),

    getThread: (threadId) =>
      run(async (client, state) => {
        const folders = await getFolders(client, state);
        const { ref, fetched, parsed } = await loadMessage(client, threadId);
        const message = toMailMessage(parsed, {
          id: threadId,
          unread: !fetched.flags?.has("\\Seen"),
          isDraft: ref.path === folders.system.DRAFT || Boolean(fetched.flags?.has("\\Draft")),
          date: fetched.internalDate,
        });
        return { id: threadId, subject: message.subject, messages: [message] };
      }),

    modifyThreads: (threadIds, { addLabelIds, removeLabelIds }) => {
      // Labels that are message flags in IMAP: [label, flag, set when the label is added].
      const flagChanges: [string, string, boolean][] = [
        ["UNREAD", "\\Seen", false],
        ["STARRED", "\\Flagged", true],
      ];
      const known = new Set(flagChanges.map(([label]) => label));
      if ([...addLabelIds, ...removeLabelIds].some((label) => !known.has(label))) {
        // E.g. archiving (removing INBOX): folders are not labels.
        throw new InvalidRequestError("This account does not support that change");
      }
      return forEachFolder(threadIds, async (client, uids) => {
        for (const [label, flag, setOnAdd] of flagChanges) {
          const adding = addLabelIds.includes(label);
          if (!adding && !removeLabelIds.includes(label)) continue;
          if (adding === setOnAdd) await client.messageFlagsAdd(uids, [flag], { uid: true });
          else await client.messageFlagsRemove(uids, [flag], { uid: true });
        }
      });
    },

    trashThreads: (threadIds) =>
      forEachFolder(threadIds, async (client, uids, path, state) => {
        const { system } = await getFolders(client, state);
        if (!system.TRASH) throw new MailServerError("server_error", "No trash folder");
        if (path === system.TRASH) return;
        await client.messageMove(uids, system.TRASH, { uid: true });
      }),

    untrashThreads: (threadIds) =>
      forEachFolder(threadIds, async (client, uids, path, state) => {
        const { system } = await getFolders(client, state);
        const inbox = system.INBOX ?? "INBOX";
        if (path === inbox) return;
        await client.messageMove(uids, inbox, { uid: true });
      }),

    sendMessage: async (input) => {
      // Built before the connection is taken: forwarding reads attachments over it.
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
      try {
        await run(async (client, state) => {
          const { system } = await getFolders(client, state);
          if (account.saveSentCopy && system.SENT) {
            await client.append(system.SENT, buildMimeMessage({ ...stamped, bcc }), ["\\Seen"]);
          }
          if (input.draftId) await removeMessage(client, input.draftId);
        });
      } catch (error) {
        // The mail is out: reporting a failure now would invite sending it twice.
        console.warn("[imap] sent, but tidying up failed", (error as Error).message);
      }
      return { id: stamped.messageId, threadId: "" };
    },

    saveDraft: async (input) => {
      const message = await buildOutgoing(source, account.email, input);
      const messageId = newMessageId(account.email);
      // Drafts keep their Bcc header; it is how the recipients are restored.
      const raw = buildMimeMessage({ ...message, date: new Date(), messageId });
      return run(async (client, state) => {
        const { system } = await getFolders(client, state);
        if (!system.DRAFT) throw new MailServerError("server_error", "No drafts folder");
        const draftId = await appendMessage(
          client,
          system.DRAFT,
          raw,
          ["\\Draft", "\\Seen"],
          messageId,
        );
        // IMAP cannot edit a message: the new copy replaces the old one.
        if (input.draftId) await removeMessage(client, input.draftId);
        return { draftId };
      });
    },

    deleteDraft: (draftId) => run((client) => removeMessage(client, draftId)),

    openDraft: async (messageId) => {
      const { parsed } = await run((client) => loadMessage(client, messageId));
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
