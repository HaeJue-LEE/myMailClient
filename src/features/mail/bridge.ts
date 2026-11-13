import type {
  Contact,
  MailLabel,
  MailThread,
  SendAsAddress,
  ThreadPage,
} from "@/features/mail/types";
import type {
  Account,
  MailAccountInput,
  MailAccountSettings,
} from "@/features/mail/mail-accounts";
import type { ScheduledMail } from "@/features/mail/scheduled";
import type { ZohoRegion } from "@/features/mail/zoho";

/** Contract between the renderer and the Electron main process. */

export type { Account };

export type MailErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "gmail_error"
  /** Gmail's per-minute quota is used up even after retries; try again shortly. */
  | "rate_limited"
  /** Signed in before a newer permission (e.g. contacts) was requested. */
  | "missing_scope"
  /** A Google API the feature needs (e.g. People) is off in the Cloud project. */
  | "api_disabled"
  | "login_cancelled"
  /** An IMAP account's server refused the user name or password. */
  | "auth_failed"
  /** An IMAP account's server could not be reached (address, port, security, network). */
  | "connection_failed"
  /** As the two above, for the outgoing (SMTP) server. */
  | "smtp_auth_failed"
  | "smtp_connection_failed"
  /** The mail server refused the request, e.g. a recipient or a missing folder. */
  | "server_error"
  | "internal_error";

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: MailErrorCode };

/** A file picked in the app, sent as bytes. */
export type FileAttachment = {
  kind: "file";
  filename: string;
  mimeType: string;
  data: Uint8Array;
};

/**
 * An attachment of an existing Gmail message (e.g. when forwarding). The main
 * process downloads it while building the message, so its bytes never pass
 * through the renderer.
 */
export type GmailAttachment = {
  kind: "gmail";
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type ComposeAttachment = FileAttachment | GmailAttachment;

/** One shape for sending and (later) saving drafts, so the two cannot drift. */
export type SendMessageInput = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Plain-text body; also the alternative part when `html` is set. */
  text: string;
  html?: string;
  /** A verified send-as address; Gmail's default sender when omitted. */
  from?: string;
  attachments?: ComposeAttachment[];
  /** Replies: keeps the message in the original conversation. */
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  /** The draft this message was saved as; sending it sends (and removes) the draft. */
  draftId?: string;
};

/** A saved draft, opened to keep writing it. */
export type DraftContent = {
  draftId: string;
  /** Address headers as stored in the draft. */
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** Untrusted until sanitized for the editor. */
  html: string | null;
  text: string | null;
  /** Downloaded, so later saves do not depend on the draft's old message. */
  attachments: FileAttachment[];
  threadId?: string;
  inReplyTo?: string;
  references?: string;
};

/** Gmail's attachment limit is 25 MB; base64 and the body need headroom. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Where updating from GitHub releases stands. Only copies started through
 * the launcher update; `reason` says why one does not (`dev`: no launcher,
 * e.g. `npm run dev`; `local`: a build with a built-in Google client).
 */
export type UpdateStatus = {
  currentVersion: string;
  /**
   * `available`: a later release was found and waits for the user to say
   * whether to download it; `ready`: downloaded, installed on restart.
   */
  state:
    | "idle"
    | "unsupported"
    | "checking"
    | "latest"
    | "available"
    | "downloading"
    | "ready"
    | "error";
  reason?: "dev" | "local";
  /**
   * The Mac app: the dmg of a later release is downloaded by the app and
   * installed by hand (`installDownloadedDmg` opens it and quits); there is
   * no restart into the new version.
   */
  byHand?: boolean;
  /** With `byHand`: the dmg for this Mac (as saved in Downloads, once there). */
  file?: string;
  /** The release found (available, downloading, ready, or failed to download). */
  version?: string;
  received?: number;
  total?: number;
  /** The release's notes (Markdown, untrusted: shown as text only). */
  notes?: string;
  checkedAt?: number;
  /** `rate_limited`: GitHub refused the check for its hourly limit (see `retryAt`). */
  error?: "check" | "download" | "rate_limited";
  /** With `rate_limited`: when GitHub may be asked again (ms since the epoch), when it said. */
  retryAt?: number;
};

/** What the app can do as set up now. */
export type AppFeatures = {
  /**
   * Google sign-in (Gmail API, Google contacts): needs a Google OAuth client,
   * built in or entered by the user. Gmail also works as an IMAP account.
   */
  googleSignIn: boolean;
  /** Where the client comes from: built in (.env.local), entered in the app, or none yet. */
  googleClient: "built-in" | "custom" | "none";
  /** The start of the client ID in use, to recognise it; never the secret. */
  googleClientHint: string | null;
  /**
   * The Zoho API client the user entered for Zoho sign-in (Zoho Mail API):
   * its data center and the start of its ID; null until one is entered.
   */
  zohoClient: { region: ZohoRegion; hint: string } | null;
  /**
   * Desktop and Start menu shortcuts: `available` only when the app was
   * started through its launcher exe, which the shortcuts point at.
   */
  shortcuts: { available: boolean; desktop: boolean; startMenu: boolean };
};

export type MailMethods = {
  getAppFeatures: () => AppFeatures;
  /**
   * Keeps a Google OAuth client the user created (desktop app type) for
   * Google sign-in, encrypted on this computer. Refused when one is built in.
   */
  saveGoogleClient: (input: { clientId: string; clientSecret: string }) => AppFeatures;
  /** Forgets the entered client; a Google account signed in with it is signed out. */
  removeGoogleClient: () => AppFeatures;
  /**
   * Keeps the Zoho API client the user created ("Non-browser Applications"
   * at api-console.zoho.com), encrypted on this computer.
   */
  saveZohoClient: (input: { clientId: string; clientSecret: string; region: ZohoRegion }) => AppFeatures;
  /** Forgets the Zoho client, and with it every Zoho account signed in with it. */
  removeZohoClient: () => AppFeatures;
  /**
   * Adds (or signs in again to) a Zoho Mail account and switches to it. Opens
   * Zoho's approval page in the system browser and resolves once approved.
   */
  loginZoho: () => Account;
  getUpdateStatus: () => UpdateStatus;
  /** Looks for a later release now. One found is offered, not downloaded. */
  checkForUpdate: () => UpdateStatus;
  /** Downloads the release offered, in the background; the status shows the progress. */
  downloadUpdate: () => UpdateStatus;
  cancelUpdateDownload: () => UpdateStatus;
  /** The Mac app: opens the page of the release offered, in the browser; false when none is. */
  openUpdatePage: () => boolean;
  /** The Mac app: opens the downloaded dmg and quits, to drag the new app over this one; false when it cannot. */
  installDownloadedDmg: () => boolean;
  /** Installs the downloaded update: the app quits and starts again as the new version. */
  restartToUpdate: () => null;
  /** Creates or removes the desktop or Start menu shortcut to the launcher. */
  setShortcut: (input: { place: "desktop" | "startMenu"; enabled: boolean }) => AppFeatures;
  /** The account in use; null when no account has been added. */
  getAccount: () => Account | null;
  /** Every account added: the Google account and IMAP accounts. */
  listAccounts: () => Account[];
  /** Switches the account in use. */
  setActiveAccount: (input: { id: string }) => Account;
  /**
   * Adds (or signs in again to) the Google account and switches to it. Opens
   * the system browser and resolves once Google redirects back.
   */
  login: () => Account;
  /** Removes an account from the app: signs out of Google or Zoho, or forgets an IMAP account. */
  removeAccount: (input: { id: string }) => null;
  /**
   * Asks for an image file and makes it the account's picture (shown instead
   * of its first letter). `changed` is false when the dialog is cancelled.
   */
  chooseAccountAvatar: (input: { id: string }) => { changed: boolean };
  /** Goes back to showing the account's first letter. */
  removeAccountAvatar: (input: { id: string }) => null;
  /**
   * Sets the order accounts are listed in: every account id, in that order.
   * Returns the accounts in their new order.
   */
  setAccountOrder: (input: { ids: string[] }) => Account[];
  /** An IMAP account's settings, to edit them. */
  getMailAccount: (input: { id: string }) => MailAccountSettings;
  /**
   * Adds an IMAP account, or changes one (`id`). Signs in to both servers
   * first and stores nothing when either refuses.
   */
  saveMailAccount: (input: MailAccountInput) => Account;
  listLabels: () => MailLabel[];
  /** Lists a label, or searches with Gmail query syntax (`query`); at least one is required. */
  listThreads: (input: {
    labelId?: string;
    query?: string;
    pageToken?: string;
  }) => ThreadPage;
  getThread: (input: { threadId: string }) => MailThread;
  /**
   * Opens a thread of the account in use in a window of its own (or brings
   * forward the one already showing it).
   */
  openThreadWindow: (input: {
    threadId: string;
    /** The label it was opened from; decides its actions (e.g. restore in Trash). */
    labelId?: string;
  }) => null;
  /**
   * Opens the compose page `href` (`/mail/compose?…`: a new message, a reply,
   * or a draft) for the account in use in a window of its own.
   */
  openComposeWindow: (input: { href: string }) => null;
  modifyThreads: (input: {
    threadIds: string[];
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }) => null;
  /** Moves threads to Trash (recoverable for 30 days). */
  trashThreads: (input: { threadIds: string[] }) => null;
  untrashThreads: (input: { threadIds: string[] }) => null;
  sendMessage: (input: SendMessageInput) => { id: string; threadId: string };
  /**
   * Keeps the message (from the account in use) to be sent at `sendAt`
   * (epoch ms). Its draft, if any, is deleted: the scheduled copy replaces it.
   */
  scheduleSend: (input: SendMessageInput & { sendAt: number }) => ScheduledMail;
  /** Scheduled messages of every account, soonest first. */
  listScheduled: () => ScheduledMail[];
  rescheduleSend: (input: { id: string; sendAt: number }) => ScheduledMail;
  /** Sends a scheduled message now; resolves once it went or failed. */
  sendScheduledNow: (input: { id: string }) => null;
  /**
   * Stops a scheduled message: back to its account's drafts (the draft's id
   * is returned), or dropped with `discard`.
   */
  cancelScheduled: (input: { id: string; discard?: boolean }) => { draftId: string | null };
  /** Addresses the account may send from (its own and verified Gmail aliases). */
  listSendAs: () => SendAsAddress[];
  /** Creates or updates (with `draftId`) a Gmail draft. Recipients may be empty. */
  saveDraft: (input: SendMessageInput) => { draftId: string };
  /** Deletes a draft permanently (it is never sent). */
  deleteDraft: (input: { draftId: string }) => null;
  /** The draft whose message is `messageId` (e.g. opened from the Drafts list). */
  openDraft: (input: { messageId: string }) => DraftContent;
  /**
   * Asks where to save a received attachment and writes it there.
   * `saved` is false when the user cancels the dialog.
   */
  saveAttachment: (input: {
    messageId: string;
    attachmentId: string;
    filename: string;
  }) => { saved: boolean; filename?: string };
  /**
   * Opens a received attachment: after a warning (the main process's own
   * dialog), it is saved in the Downloads folder (numbered when the name is
   * taken) and opened with its program. `opened` is false when the user
   * cancels, or with `problem` when Windows could not open the saved file.
   */
  openAttachment: (input: {
    messageId: string;
    attachmentId: string;
    filename: string;
  }) => { opened: boolean; filename?: string; problem?: string };
  /**
   * Google Contacts plus Google's "Other contacts", merged by address. Shared
   * by every account: read from the Google account whichever one is in use,
   * and empty when there is no Google account.
   */
  listContacts: () => Contact[];
  /** Saves a contact to Google Contacts. */
  createContact: (input: { name: string; email: string }) => Contact;
  /**
   * Renames a saved person and changes one of their addresses (`email` →
   * `newEmail`); returns all of that person's contacts as saved.
   */
  updateContact: (input: {
    resourceName: string;
    email: string;
    name: string;
    newEmail: string;
  }) => Contact[];
  /** Deletes a saved person, with all of their addresses. */
  deleteContact: (input: { resourceName: string }) => null;
  /** Addresses hidden from the contact list, for every account (stored locally). */
  getHiddenContacts: () => string[];
  /** Hides or shows addresses; returns the updated hidden list. */
  setContactsHidden: (input: { emails: string[]; hidden: boolean }) => string[];
};

export type MailApi = {
  [K in keyof MailMethods]: (
    ...args: Parameters<MailMethods[K]>
  ) => Promise<IpcResult<ReturnType<MailMethods[K]>>>;
};

export const MAIL_METHODS = [
  "getAppFeatures",
  "saveGoogleClient",
  "removeGoogleClient",
  "saveZohoClient",
  "removeZohoClient",
  "loginZoho",
  "getUpdateStatus",
  "checkForUpdate",
  "downloadUpdate",
  "cancelUpdateDownload",
  "openUpdatePage",
  "installDownloadedDmg",
  "restartToUpdate",
  "setShortcut",
  "getAccount",
  "listAccounts",
  "setActiveAccount",
  "login",
  "removeAccount",
  "chooseAccountAvatar",
  "removeAccountAvatar",
  "setAccountOrder",
  "getMailAccount",
  "saveMailAccount",
  "listLabels",
  "listThreads",
  "getThread",
  "openThreadWindow",
  "openComposeWindow",
  "modifyThreads",
  "trashThreads",
  "untrashThreads",
  "sendMessage",
  "scheduleSend",
  "listScheduled",
  "rescheduleSend",
  "sendScheduledNow",
  "cancelScheduled",
  "listSendAs",
  "saveDraft",
  "deleteDraft",
  "openDraft",
  "saveAttachment",
  "openAttachment",
  "listContacts",
  "createContact",
  "updateContact",
  "deleteContact",
  "getHiddenContacts",
  "setContactsHidden",
] as const satisfies readonly (keyof MailMethods)[];

export const channelOf = (method: keyof MailMethods) => `mail:${method}`;

declare global {
  interface Window {
    /** Present only inside the Electron window, injected by the preload script. */
    mailApi?: MailApi;
  }
}
