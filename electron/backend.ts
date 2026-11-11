import type { DraftContent, SendMessageInput } from "@/features/mail/bridge";
import { type Account, GMAIL_ACCOUNT_ID, sortAccounts } from "@/features/mail/mail-accounts";
import type {
  MailLabel,
  MailThread,
  SendAsAddress,
  ThreadPage,
} from "@/features/mail/types";
import {
  getAccountOrder,
  getActiveId,
  getMailCredentials,
  listMailAccounts,
} from "./accounts";
import { getSession } from "./auth";
import { getAvatar } from "./avatars";
import { MailServerError, UnauthorizedError } from "./errors";
import { createGmailBackend } from "./gmail/backend";
import { createImapBackend } from "./imap/backend";
import { createPop3Backend } from "./pop3/backend";

/**
 * What every kind of account can do with mail. The renderer always speaks in
 * Gmail's terms (label ids such as `INBOX`, Gmail search syntax); a backend
 * maps them to what its server understands.
 */
export type MailBackend = {
  listLabels: () => Promise<MailLabel[]>;
  listThreads: (input: {
    labelId?: string;
    query?: string;
    pageToken?: string;
  }) => Promise<ThreadPage>;
  getThread: (threadId: string) => Promise<MailThread>;
  modifyThreads: (
    threadIds: string[],
    change: { addLabelIds: string[]; removeLabelIds: string[] },
  ) => Promise<void>;
  trashThreads: (threadIds: string[]) => Promise<void>;
  untrashThreads: (threadIds: string[]) => Promise<void>;
  sendMessage: (input: SendMessageInput) => Promise<{ id: string; threadId: string }>;
  saveDraft: (input: SendMessageInput) => Promise<{ draftId: string }>;
  deleteDraft: (draftId: string) => Promise<void>;
  openDraft: (messageId: string) => Promise<DraftContent>;
  listSendAs: () => Promise<SendAsAddress[]>;
  getAttachmentData: (messageId: string, attachmentId: string) => Promise<Buffer>;
};

/** Every account that can be used: the Google account first, then IMAP and POP3 accounts. */
export async function listAccounts(): Promise<Account[]> {
  const [session, mailAccounts, order] = await Promise.all([
    getSession(),
    listMailAccounts(),
    getAccountOrder(),
  ]);
  const accounts: Account[] = [
    ...(session
      ? [{ id: GMAIL_ACCOUNT_ID, kind: "gmail" as const, email: session.email, name: "" }]
      : []),
    ...mailAccounts.map(({ id, email, name, protocol }) => ({
      id,
      kind: protocol,
      email,
      name,
    })),
  ];
  return Promise.all(
    sortAccounts(accounts, order).map(async (account) => ({
      ...account,
      avatar: await getAvatar(account.id),
    })),
  );
}

/** The chosen account, or the first one when the choice no longer exists. */
export async function getActiveAccount(): Promise<Account | null> {
  const [accounts, activeId] = await Promise.all([listAccounts(), getActiveId()]);
  return accounts.find((account) => account.id === activeId) ?? accounts[0] ?? null;
}

export async function requireAccount(): Promise<Account> {
  const account = await getActiveAccount();
  if (!account) throw new UnauthorizedError();
  return account;
}

/** The account in use and the backend that reaches its mail. */
export async function requireBackend(): Promise<{
  account: Account;
  backend: MailBackend;
}> {
  const account = await requireAccount();
  if (account.kind === "gmail") {
    const session = await getSession();
    if (!session) throw new UnauthorizedError();
    return { account, backend: createGmailBackend(session) };
  }
  const credentials = await getMailCredentials(account.id);
  // The password can no longer be decrypted (e.g. another Windows user).
  if (!credentials) throw new MailServerError("auth_failed");
  return {
    account,
    backend:
      credentials.protocol === "pop3"
        ? createPop3Backend(credentials)
        : createImapBackend(credentials),
  };
}
