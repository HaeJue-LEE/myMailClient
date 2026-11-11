export type ContactSource =
  /** Saved in Google Contacts. */
  | "google"
  /** Google's "Other contacts": people the user has emailed, collected by Google. */
  | "other"
  /** Senders of mail loaded in this app session. */
  | "recent";

export type Contact = {
  name: string;
  /** Lower-cased address; unique within a contact list. */
  email: string;
  source: ContactSource;
  /**
   * Addresses of the app's accounts this contact came from (the Google
   * account's address book, or mail loaded for an account). Contacts are kept
   * in one list across accounts; this only says where each one is from.
   */
  accounts: string[];
  /**
   * The Google Contacts person (`people/c…`) for saved contacts; needed to edit
   * or delete. One person can have several addresses, i.e. several contacts.
   */
  resourceName?: string;
};

/** An address Gmail lets this account send as ("Send mail as"), verified. */
export type SendAsAddress = {
  email: string;
  /** Display name for the From header; may be empty. */
  name: string;
  /** Gmail's default From address. */
  isDefault: boolean;
  /** The account's own Gmail address. */
  isPrimary: boolean;
  /** Gmail signature for this address (HTML, untrusted); "" when none. */
  signature: string;
};

export type MailLabel = {
  id: string;
  name: string;
  type: "system" | "user";
};

export type ThreadSummary = {
  id: string;
  subject: string;
  /** Display name of the latest sender. */
  from: string;
  /** Lower-cased email address of the latest sender. */
  fromAddress: string;
  snippet: string;
  date: number | null;
  unread: boolean;
  messageCount: number;
  /**
   * Some message has a real attachment: business cards (vCard), digital
   * signatures, and images shown inside the body do not count.
   */
  hasAttachment: boolean;
};

export type ThreadPage = {
  threads: ThreadSummary[];
  nextPageToken: string | null;
};

export type MailAttachment = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type MailMessage = {
  id: string;
  messageIdHeader: string | null;
  from: string;
  to: string;
  cc: string;
  /** Where replies should go, when it differs from From (e.g. mailing lists). */
  replyTo: string;
  /** Message-IDs of earlier messages in the conversation, for threading replies. */
  references: string;
  subject: string;
  date: number | null;
  html: string | null;
  text: string | null;
  attachments: MailAttachment[];
  unread: boolean;
  /** An unsent draft (Gmail's DRAFT label). */
  isDraft: boolean;
};

export type MailThread = {
  id: string;
  subject: string;
  messages: MailMessage[];
};
