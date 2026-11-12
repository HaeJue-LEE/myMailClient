import { type ParsedMail, simpleParser } from "mailparser";
import type { FileAttachment } from "@/features/mail/bridge";
import type { SendAsAddress, ThreadSummary } from "@/features/mail/types";
import type { MailBackend } from "../backend";
import { buildOutgoing, type OutgoingSource } from "../compose";
import { InvalidRequestError, MailServerError } from "../errors";
import { safeFilename } from "../gmail/mime";
import { addressText, toMailMessage } from "../imap/parse";
import { zohoRequest, type ZohoRequest } from "./auth";
import { zohoId } from "./json";
import {
  decodeZohoId,
  encodeZohoId,
  isUnread,
  mapZohoFolders,
  receivedAt,
  resolveZohoLabel,
  toZohoSummary,
  withoutQuote,
  type ZohoFolder,
  type ZohoFolderMap,
  type ZohoListedMessage,
} from "./parse";
import { toZohoSearch } from "./query";
import type { ZohoAccount } from "./store";

const PAGE_SIZE = 20;
/** Folders change rarely; the list is fetched again after this long. */
const FOLDERS_TTL_MS = 5 * 60 * 1000;

const folderCache = new Map<string, { map: Promise<ZohoFolderMap>; at: number }>();

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

/** Forgets what is cached for an account, e.g. when it is removed. */
export function dropZohoCaches(accountId: string) {
  folderCache.delete(accountId);
  for (const key of parsedCache.keys()) {
    if (key.startsWith(`${accountId}:`)) parsedCache.delete(key);
  }
}

type UploadedAttachment = { storeName: string; attachmentPath: string; attachmentName: string };

/** A Zoho Mail account, through the Zoho Mail API. Each message is a conversation of its own. */
export function createZohoBackend(account: ZohoAccount): MailBackend {
  const api = <T>(path: string, request?: ZohoRequest) =>
    zohoRequest<T>(account, `/accounts/${account.zohoAccountId}${path}`, request);
  const cacheKey = (id: string) => `${account.id}:${id}`;

  const folders = (fresh = false): Promise<ZohoFolderMap> => {
    const cached = folderCache.get(account.id);
    if (!fresh && cached && Date.now() - cached.at < FOLDERS_TTL_MS) return cached.map;
    const map = api<ZohoFolder[]>("/folders").then((list) =>
      mapZohoFolders(
        (list ?? []).map((folder) => ({
          ...folder,
          folderId: String(folder.folderId),
        })),
      ),
    );
    folderCache.set(account.id, { map, at: Date.now() });
    map.catch(() => {
      if (folderCache.get(account.id)?.map === map) folderCache.delete(account.id);
    });
    return map;
  };

  const systemFolder = async (id: keyof ZohoFolderMap["system"]) => {
    const folder = (await folders()).system[id];
    if (!folder) throw new MailServerError("server_error", `No ${id} folder`);
    return folder;
  };

  const self: SendAsAddress = {
    email: account.email,
    name: account.name,
    isDefault: true,
    isPrimary: true,
    signature: "",
  };

  /** Downloads a whole message (MIME) and parses it. */
  const loadMessage = async (id: string) => {
    const { messageId } = decodeZohoId(id);
    const original = await api<{ content?: string }>(`/messages/${messageId}/originalmessage`);
    if (typeof original?.content !== "string") throw new InvalidRequestError("Message not found");
    const parsed = await simpleParser(Buffer.from(original.content, "utf8"));
    remember(cacheKey(id), parsed);
    return parsed;
  };

  const parsedMessage = (id: string) => {
    const cached = parsedCache.get(cacheKey(id));
    return cached ? Promise.resolve(cached) : loadMessage(id);
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

  const updateMessages = (ids: string[], change: Record<string, unknown>) =>
    api("/updatemessage", {
      method: "PUT",
      json: { ...change, messageId: ids.map((id) => zohoId(decodeZohoId(id).messageId)) },
    });

  /** Moves messages (not already there) to a folder. */
  const moveTo = async (ids: string[], folder: ZohoFolder) => {
    const moving = ids.filter((id) => decodeZohoId(id).folderId !== folder.folderId);
    if (moving.length === 0) return;
    await updateMessages(moving, { mode: "moveMessage", destfolderId: zohoId(folder.folderId) });
  };

  const removeForGood = async (id: string) => {
    const { folderId, messageId } = decodeZohoId(id);
    await api(`/folders/${folderId}/messages/${messageId}`, {
      method: "DELETE",
      query: { expunge: true },
    });
  };

  /** Uploads attachments for a message about to be sent or saved. */
  const upload = async (attachments: { filename: string; data: Uint8Array }[]) => {
    const uploaded: UploadedAttachment[] = [];
    for (const attachment of attachments) {
      const result = await api<UploadedAttachment | UploadedAttachment[]>("/messages/attachments", {
        method: "POST",
        query: { fileName: safeFilename(attachment.filename), isInline: false },
        body: attachment.data,
        // Zoho refuses the file's own type (415, checked with text/plain);
        // it takes the type from the file name.
        contentType: "application/octet-stream",
      });
      const item = Array.isArray(result) ? result[0] : result;
      if (!item?.storeName || !item.attachmentPath) {
        throw new MailServerError("server_error", "Zoho did not store the attachment");
      }
      uploaded.push({
        storeName: String(item.storeName),
        attachmentPath: item.attachmentPath,
        attachmentName: item.attachmentName,
      });
    }
    return uploaded;
  };

  /** The fields Zoho's send, reply, and draft calls share. */
  const messageFields = async (input: Parameters<MailBackend["sendMessage"]>[0]) => {
    const message = await buildOutgoing(source, account.email, input);
    const attachments = await upload(message.attachments ?? []);
    return {
      fields: {
        fromAddress: account.email,
        toAddress: message.to.join(","),
        ...(message.cc?.length ? { ccAddress: message.cc.join(",") } : {}),
        ...(message.bcc?.length ? { bccAddress: message.bcc.join(",") } : {}),
        subject: message.subject,
        content: message.html ?? message.text,
        mailFormat: message.html ? "html" : "plaintext",
        encoding: "UTF-8",
        ...(attachments.length ? { attachments } : {}),
      },
      message,
    };
  };

  const listPage = async (
    path: string,
    query: ZohoRequest["query"],
    start: number,
    keep: (message: ZohoListedMessage) => boolean,
    since?: number,
  ) => {
    const items =
      (await api<ZohoListedMessage[]>(path, {
        query: { ...query, start, limit: PAGE_SIZE },
      })) ?? [];
    let done = items.length < PAGE_SIZE;
    let kept = items;
    if (since !== undefined) {
      // Newest first: past the first older message, the rest is older too.
      const older = items.findIndex((message) => (receivedAt(message) ?? 0) < since);
      if (older >= 0) {
        kept = items.slice(0, older);
        done = true;
      }
    }
    const threads: ThreadSummary[] = kept.filter(keep).map(toZohoSummary);
    return {
      threads,
      nextPageToken: done ? null : String(start + items.length),
    };
  };

  return {
    ...source,

    listLabels: async () => (await folders(true)).labels,

    listThreads: async ({ labelId, query, pageToken }) => {
      const search = toZohoSearch(query);
      const start = pageToken && /^\d+$/.test(pageToken) ? Number(pageToken) : 1;
      const keepSeen = (message: ZohoListedMessage) =>
        search.seen === undefined || isUnread(message) !== search.seen;

      if (search.searchKey === null) {
        const map = await folders();
        const starred = labelId === "STARRED";
        const folder = starred
          ? map.system.INBOX
          : resolveZohoLabel(map, labelId ?? "INBOX");
        if (!folder) throw new MailServerError("server_error", "No inbox");
        return listPage(
          "/messages/view",
          {
            folderId: folder.folderId,
            status: search.seen === false ? "unread" : search.seen === true ? "read" : "all",
            flaggedMails: starred || search.flagged ? true : undefined,
            sortorder: false,
          },
          start,
          () => true,
          search.since,
        );
      }
      return listPage(
        "/messages/search",
        {
          searchKey: search.searchKey,
          // Zoho otherwise leaves out the last two minutes of mail.
          receivedTime: Date.now() + 24 * 60 * 60 * 1000,
        },
        start,
        keepSeen,
      );
    },

    getThread: async (threadId) => {
      const { folderId, messageId } = decodeZohoId(threadId);
      const [parsed, details, map] = await Promise.all([
        loadMessage(threadId),
        api<ZohoListedMessage>(`/folders/${folderId}/messages/${messageId}/details`).catch(
          () => null,
        ),
        folders(),
      ]);
      const received = details ? receivedAt(details) : null;
      const message = toMailMessage(parsed, {
        id: threadId,
        unread: details ? isUnread(details) : false,
        isDraft: folderId === map.system.DRAFT?.folderId,
        date: received ? new Date(received) : undefined,
      });
      return { id: threadId, subject: message.subject, messages: [message] };
    },

    modifyThreads: async (threadIds, { addLabelIds, removeLabelIds }) => {
      const known = new Set(["UNREAD", "STARRED"]);
      if ([...addLabelIds, ...removeLabelIds].some((label) => !known.has(label))) {
        // E.g. archiving (removing INBOX): folders are not labels.
        throw new InvalidRequestError("This account does not support that change");
      }
      if (addLabelIds.includes("UNREAD")) await updateMessages(threadIds, { mode: "markAsUnread" });
      if (removeLabelIds.includes("UNREAD")) await updateMessages(threadIds, { mode: "markAsRead" });
      if (addLabelIds.includes("STARRED")) {
        await updateMessages(threadIds, { mode: "setFlag", flagid: "important" });
      }
      if (removeLabelIds.includes("STARRED")) {
        await updateMessages(threadIds, { mode: "setFlag", flagid: "flag_not_set" });
      }
    },

    trashThreads: async (threadIds) => moveTo(threadIds, await systemFolder("TRASH")),

    untrashThreads: async (threadIds) => moveTo(threadIds, await systemFolder("INBOX")),

    sendMessage: async (input) => {
      const { fields } = await messageFields(input);
      const original = input.threadId ? safeDecode(input.threadId) : null;
      if (original) {
        // Zoho's reply call threads the answer under the message it answers.
        await api(`/messages/${original.messageId}`, {
          method: "POST",
          json: {
            ...fields,
            // Zoho quotes the original itself (checked by replying).
            content: fields.mailFormat === "html" ? withoutQuote(fields.content) : fields.content,
            action: "reply",
          },
        });
      } else {
        await api("/messages", { method: "POST", json: fields });
      }
      if (input.draftId) {
        // Zoho keeps its own copy in Sent; the draft is done with.
        await removeForGood(input.draftId).catch((error: Error) =>
          console.warn("[zoho] sent, but the draft was not removed", error.message),
        );
      }
      return { id: "", threadId: "" };
    },

    saveDraft: async (input) => {
      const { fields, message } = await messageFields(input);
      const saved = await api<{ messageId?: string | number } | null>("/messages", {
        method: "POST",
        json: {
          ...fields,
          mode: "draft",
          ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
          ...(message.references ? { refHeader: message.references } : {}),
        },
      });
      const drafts = await systemFolder("DRAFT");
      let messageId = saved?.messageId !== undefined ? String(saved.messageId) : null;
      if (!messageId) {
        // Not reported: the newest draft is the one just saved.
        const [newest] =
          (await api<ZohoListedMessage[]>("/messages/view", {
            query: { folderId: drafts.folderId, start: 1, limit: 1, sortorder: false },
          })) ?? [];
        if (!newest) throw new MailServerError("server_error", "Draft was not stored");
        messageId = String(newest.messageId);
      }
      // A draft cannot be edited: the new copy replaces the old one.
      if (input.draftId) await removeForGood(input.draftId).catch(() => undefined);
      return { draftId: encodeZohoId(drafts.folderId, messageId) };
    },

    deleteDraft: (draftId) => removeForGood(draftId),

    openDraft: async (messageId) => {
      const parsed = await loadMessage(messageId);
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

function safeDecode(id: string) {
  try {
    return decodeZohoId(id);
  } catch {
    return null;
  }
}
