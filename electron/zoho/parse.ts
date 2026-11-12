import type { MailLabel, ThreadSummary } from "@/features/mail/types";
import { InvalidRequestError } from "../errors";
import { decodeEntities } from "../gmail/parse";

const NO_SUBJECT = "(제목 없음)";

/**
 * The app's id of a Zoho message, `<folderId>:<messageId>`: most Mail API
 * calls need the folder too. Each message is a conversation of its own.
 */
export function encodeZohoId(folderId: string, messageId: string) {
  return `${folderId}:${messageId}`;
}

export function decodeZohoId(id: string): { folderId: string; messageId: string } {
  const match = /^(\d{1,20}):(\d{1,20})$/.exec(id);
  if (!match) throw new InvalidRequestError("Not a Zoho message id");
  return { folderId: match[1], messageId: match[2] };
}

export type ZohoFolder = {
  folderId: string;
  folderName: string;
  folderType: string;
  path?: string;
};

/** The renderer's (Gmail's) label ids that stand for a Zoho folder type. */
const SYSTEM_TYPES: Record<string, "INBOX" | "SENT" | "DRAFT" | "SPAM" | "TRASH"> = {
  Inbox: "INBOX",
  Sent: "SENT",
  Drafts: "DRAFT",
  Spam: "SPAM",
  Trash: "TRASH",
};
/** Folders that hold no mail to read here. */
const HIDDEN_TYPES = new Set(["Templates", "Outbox"]);

export type ZohoFolderMap = {
  system: Partial<Record<"INBOX" | "SENT" | "DRAFT" | "SPAM" | "TRASH", ZohoFolder>>;
  /** Every other folder, offered as a user label (its folder id is the label id). */
  labels: MailLabel[];
  byId: Map<string, ZohoFolder>;
};

/**
 * Sorts an account's folders into the fixed labels the app shows and user
 * labels. User folders also report the type `Inbox`; the inbox itself is the
 * one at `/Inbox` (or the first of its type).
 */
export function mapZohoFolders(folders: ZohoFolder[]): ZohoFolderMap {
  const system: ZohoFolderMap["system"] = {};
  const inboxes = folders.filter((folder) => folder.folderType === "Inbox");
  const inbox =
    inboxes.find((folder) => (folder.path ?? `/${folder.folderName}`) === "/Inbox") ?? inboxes[0];
  if (inbox) system.INBOX = inbox;
  const labels: MailLabel[] = [];
  for (const folder of folders) {
    if (folder === inbox || HIDDEN_TYPES.has(folder.folderType)) continue;
    const id = SYSTEM_TYPES[folder.folderType];
    if (id && id !== "INBOX" && !system[id]) {
      system[id] = folder;
      continue;
    }
    labels.push({
      id: folder.folderId,
      name: (folder.path ?? folder.folderName).replace(/^\/+/, "") || folder.folderName,
      type: "user",
    });
  }
  labels.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return {
    system,
    labels,
    byId: new Map(folders.map((folder) => [folder.folderId, folder])),
  };
}

/** The folder a label id stands for. */
export function resolveZohoLabel(map: ZohoFolderMap, labelId: string): ZohoFolder {
  const system = map.system[labelId as keyof ZohoFolderMap["system"]];
  if (system) return system;
  const folder = map.labels.some((label) => label.id === labelId)
    ? map.byId.get(labelId)
    : undefined;
  if (!folder) throw new InvalidRequestError("This account has no such folder");
  return folder;
}

/** A message as Zoho lists it (`messages/view`, `messages/search`). */
export type ZohoListedMessage = {
  messageId: string | number;
  folderId: string | number;
  subject?: string;
  sender?: string;
  fromAddress?: string;
  summary?: string;
  receivedTime?: string | number;
  /** "0" while unread. */
  status?: string | number;
  flagid?: string;
  hasAttachment?: string | number | boolean;
};

const truthy = (value: unknown) => value === true || value === "1" || value === 1 || value === "true";

export function isUnread(message: Pick<ZohoListedMessage, "status">) {
  return String(message.status) === "0";
}

export function isFlagged(message: Pick<ZohoListedMessage, "flagid">) {
  return Boolean(message.flagid) && message.flagid !== "flag_not_set";
}

export function receivedAt(message: Pick<ZohoListedMessage, "receivedTime">): number | null {
  const time = Number(message.receivedTime);
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** Zoho escapes HTML in list fields (e.g. `&lt;`, `&quot;`). */
const plain = (value: string | undefined) => decodeEntities(value ?? "").trim();

export function toZohoSummary(message: ZohoListedMessage): ThreadSummary {
  const address = plain(message.fromAddress).replace(/^.*<([^>]+)>.*$/, "$1").toLowerCase();
  return {
    id: encodeZohoId(String(message.folderId), String(message.messageId)),
    subject: plain(message.subject) || NO_SUBJECT,
    from: plain(message.sender) || address,
    fromAddress: address,
    snippet: plain(message.summary).replace(/\s+/g, " ").slice(0, 200),
    date: receivedAt(message),
    unread: isUnread(message),
    messageCount: 1,
    hasAttachment: truthy(message.hasAttachment),
  };
}

/**
 * `html` without the app's quote of the message being answered
 * (`<div data-mc="quote">…</div>`). Zoho's reply call quotes the original
 * itself, so keeping the app's quote would show it twice.
 */
export function withoutQuote(html: string): string {
  const start = html.search(/<div\b[^>]*\bdata-mc=["']?quote\b/i);
  if (start < 0) return html;
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(0, start) + html.slice(match.index + match[0].length);
  }
  // Unbalanced: the quote runs to the end.
  return html.slice(0, start);
}
