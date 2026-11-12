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
import { createZohoBackend } from "./zoho/backend";
import { getZohoAccount, listZohoAccounts } from "./zoho/store";

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

/** Every account that can be used: the Google account first, then IMAP, POP3, and Zoho accounts. */
export async function listAccounts(): Promise<Account[]> {
  const [session, mailAccounts, zohoAccounts, order] = await Promise.all([
    getSession(),
    listMailAccounts(),
    listZohoAccounts(),
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
    ...zohoAccounts.map(({ id, email, name }) => ({ id, kind: "zoho" as const, email, name })),
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
  return { account, backend: await backendFor(account) };
}

/**
 * The backend of any account, in use or not (e.g. for sending a scheduled
 * mail of another account); null when the account no longer exists.
 */
export async function backendForAccountId(
  id: string,
): Promise<{ account: Account; backend: MailBackend } | null> {
  const account = (await listAccounts()).find((item) => item.id === id);
  return account ? { account, backend: await backendFor(account) } : null;
}

async function backendFor(account: Account): Promise<MailBackend> {
  if (account.kind === "gmail") {
    const session = await getSession();
    if (!session) throw new UnauthorizedError();
    return createGmailBackend(session);
  }
  if (account.kind === "zoho") {
    const zoho = await getZohoAccount(account.id);
    // Not UnauthorizedError: that signs the Google account out.
    if (!zoho) throw new MailServerError("auth_failed");
    return createZohoBackend(zoho);
  }
  const credentials = await getMailCredentials(account.id);
  // The password can no longer be decrypted (e.g. another Windows user).
  if (!credentials) throw new MailServerError("auth_failed");
  return credentials.protocol === "pop3"
    ? createPop3Backend(credentials)
    : createImapBackend(credentials);
}
