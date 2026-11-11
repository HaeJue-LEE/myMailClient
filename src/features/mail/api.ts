"use client";

import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  Account,
  IpcResult,
  MailApi,
  MailErrorCode,
  SendMessageInput,
} from "@/features/mail/bridge";
import {
  applyContactEdits,
  emptyContactEdits,
  forgetPerson,
  mergeContacts,
  pruneContactEdits,
  recentContacts,
} from "@/features/mail/contacts";
import type { MailList } from "@/features/mail/routes";
import { threadListRequest } from "@/features/mail/search";
import { type MailAccountInput, sortAccounts } from "@/features/mail/mail-accounts";
import type { Contact, ThreadPage } from "@/features/mail/types";

export class MailApiError extends Error {
  constructor(readonly code: MailErrorCode | "unavailable") {
    super(code);
  }
}

function bridge(): MailApi {
  // Absent when the UI is opened in a regular browser instead of the app.
  if (!window.mailApi) throw new MailApiError("unavailable");
  return window.mailApi;
}

async function unwrap<T>(pending: Promise<IpcResult<T>>): Promise<T> {
  const result = await pending;
  if (result.ok) return result.data;
  if (result.error === "unauthorized") {
    // A full navigation is intended: it also discards the cached mail of the old session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }
  throw new MailApiError(result.error);
}

const accountKey = ["account"];

export function useAccount() {
  return useQuery({
    queryKey: accountKey,
    queryFn: () => unwrap(bridge().getAccount()),
    staleTime: Infinity,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(bridge().login()),
    onSuccess: (account) => {
      const previous = queryClient.getQueryData<Account | null>(accountKey);
      if (previous && (previous.id !== account.id || previous.email !== account.email)) {
        // Signing in again (e.g. from the contacts page) may pick another
        // account. Like logout, a full navigation drops everything cached for
        // the old one: mail, contacts, send-as addresses, pending edits.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/mail");
        return;
      }
      queryClient.setQueryData(accountKey, account);
      void queryClient.invalidateQueries({ queryKey: accountsKey });
      // Same account: a new sign-in may grant permissions (e.g. contacts) the
      // old one lacked, so refetch what depends on them.
      void queryClient.invalidateQueries({ queryKey: ["contacts"] });
      void queryClient.invalidateQueries({ queryKey: ["sendAs"] });
    },
  });
}

const accountsKey = ["accounts"];

/** Every account added to the app: the Google account and IMAP accounts. */
export function useAccounts() {
  return useQuery({
    queryKey: accountsKey,
    queryFn: () => unwrap(bridge().listAccounts()),
    staleTime: Infinity,
  });
}

/**
 * Query keys are not scoped by account, so changing the account in use is a
 * full navigation: it drops the old account's cached mail, labels, and contacts.
 */
function reloadMail() {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/mail");
}

export function useSwitchAccount() {
  return useMutation({
    mutationFn: (id: string) => unwrap(bridge().setActiveAccount({ id })),
    onSuccess: reloadMail,
  });
}

/** Signs out of Google, or forgets an IMAP account and its password. */
export function useRemoveAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(bridge().removeAccount({ id })),
    onSuccess: (_, id) => {
      const active = queryClient.getQueryData<Account | null>(accountKey);
      // Removing the account in use moves on to another one, or to the login screen.
      if (active?.id === id) reloadMail();
      else void queryClient.invalidateQueries({ queryKey: accountsKey });
    },
  });
}

/** Account pictures appear wherever accounts do: refetch both account queries. */
function refreshAccounts(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: accountsKey });
  void queryClient.invalidateQueries({ queryKey: accountKey });
}

/**
 * Moves an account one place up or down in the list. The list changes at
 * once and goes back if saving the order fails.
 */
export function useMoveAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids }: { ids: string[] }) => unwrap(bridge().setAccountOrder({ ids })),
    onMutate: async ({ ids }) => {
      await queryClient.cancelQueries({ queryKey: accountsKey });
      const previous = queryClient.getQueryData<Account[]>(accountsKey);
      if (previous) queryClient.setQueryData(accountsKey, sortAccounts(previous, ids));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(accountsKey, context.previous);
    },
    onSuccess: (accounts) => queryClient.setQueryData(accountsKey, accounts),
  });
}

/** Asks for an image file (in the main process) and makes it the account's picture. */
export function useChooseAccountAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(bridge().chooseAccountAvatar({ id })),
    onSuccess: ({ changed }) => {
      if (changed) refreshAccounts(queryClient);
    },
  });
}

/** Goes back to the account's first letter. */
export function useRemoveAccountAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(bridge().removeAccountAvatar({ id })),
    onSuccess: () => refreshAccounts(queryClient),
  });
}

/** An IMAP account's stored settings, fetched fresh each time they are edited. */
export function useMailAccount(id: string) {
  return useQuery({
    queryKey: ["mailAccount", id],
    queryFn: () => unwrap(bridge().getMailAccount({ id })),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

/** Adds or changes an IMAP account; the main process signs in to both servers first. */
export function useSaveMailAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MailAccountInput) =>
      unwrap(bridge().saveMailAccount(input)),
    onSuccess: (account) => {
      const active = queryClient.getQueryData<Account | null>(accountKey);
      // The first account, or the one in use: start over with its new settings.
      if (!active || active.id === account.id) reloadMail();
      else void queryClient.invalidateQueries({ queryKey: accountsKey });
    },
  });
}

export function useLabels() {
  return useQuery({
    queryKey: ["labels"],
    queryFn: () => unwrap(bridge().listLabels()),
  });
}

export function useThreads(list: MailList) {
  return useInfiniteQuery({
    queryKey: ["threads", list],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      unwrap(
        bridge().listThreads({
          ...threadListRequest(list),
          pageToken: pageParam || undefined,
        }),
      ),
    getNextPageParam: (page) => page.nextPageToken ?? undefined,
    // A dated list may hold hundreds of auto-loaded threads; refetching them all
    // on every window focus would be slow and eat Gmail quota. Refresh is manual.
    refetchOnWindowFocus: !list.since,
  });
}

/** Contact changes made this session, laid over fetches until Google shows them. */
const contactEdits = emptyContactEdits();

const contactsKey = ["contacts"];

/** Google Contacts and "Other contacts". Errors (e.g. missing permission) stay on this query. */
export function useGoogleContacts() {
  return useQuery({
    queryKey: contactsKey,
    queryFn: async () => {
      const fetched = await unwrap(bridge().listContacts());
      pruneContactEdits(fetched, contactEdits);
      return applyContactEdits(fetched, contactEdits);
    },
    staleTime: 10 * 60_000,
  });
}

/** Records a change in `contactEdits` and shows it in the cached list at once. */
function useContactMutation<Input, Result>(
  request: (input: Input) => Promise<IpcResult<Result>>,
  record: (result: Result, input: Input) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Input) => unwrap(request(input)),
    onSuccess: (result, input) => {
      record(result, input);
      queryClient.setQueryData<Contact[]>(contactsKey, (contacts) =>
        applyContactEdits(contacts ?? [], contactEdits),
      );
    },
  });
}

export function useCreateContact() {
  return useContactMutation(
    (input: { name: string; email: string }) => bridge().createContact(input),
    (contact) => void contactEdits.created.set(contact.email, contact),
  );
}

export function useUpdateContact() {
  return useContactMutation(
    (input: {
      resourceName: string;
      email: string;
      name: string;
      newEmail: string;
    }) => bridge().updateContact(input),
    (contacts, { resourceName }) => {
      forgetPerson(contactEdits, resourceName);
      contactEdits.replaced.set(resourceName, contacts);
    },
  );
}

export function useDeleteContact() {
  return useContactMutation(
    (input: { resourceName: string }) => bridge().deleteContact(input),
    (_, { resourceName }) => {
      forgetPerson(contactEdits, resourceName);
      contactEdits.removed.add(resourceName);
    },
  );
}

const hiddenKey = ["hiddenContacts"];

/** Addresses hidden from the contact list (kept on this computer, for every account). */
export function useHiddenContacts() {
  return useQuery({
    queryKey: hiddenKey,
    queryFn: async () => new Set(await unwrap(bridge().getHiddenContacts())),
    staleTime: Infinity,
  });
}

export function useSetContactsHidden() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { emails: string[]; hidden: boolean }) =>
      unwrap(bridge().setContactsHidden(input)),
    onSuccess: (emails) => queryClient.setQueryData(hiddenKey, new Set(emails)),
  });
}

/**
 * Every known contact, whichever account is in use: Google's lists plus
 * senders of mail loaded so far, split into those shown by default and those
 * the user hid. Each records the accounts it came from. Usable even when the
 * Google part fails, so the recent senders still show.
 */
export function useContacts() {
  const google = useGoogleContacts();
  const hidden = useHiddenContacts();
  const account = useAccount().data?.email ?? "";
  const loadedThreads = useLoadedThreads();
  const contacts = mergeContacts([
    ...(google.data ?? []),
    ...recentContacts(loadedThreads(), account),
  ]);
  const hiddenEmails = hidden.data ?? new Set<string>();
  const [hiddenContacts, visibleContacts] = partition(contacts, (contact) =>
    hiddenEmails.has(contact.email),
  );
  return { contacts, visibleContacts, hiddenContacts, google };
}

function partition<T>(items: readonly T[], test: (item: T) => boolean) {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (test(item) ? yes : no).push(item);
  return [yes, no] as const;
}

/** Every thread summary currently cached, across all lists that have been opened. */
export function useLoadedThreads() {
  const queryClient = useQueryClient();
  return () =>
    queryClient
      .getQueriesData<InfiniteData<ThreadPage>>({ queryKey: ["threads"] })
      .flatMap(([, data]) => data?.pages.flatMap((page) => page.threads) ?? []);
}

/** Opens a thread in a window of its own. */
export function useOpenThreadWindow() {
  return useMutation({
    mutationFn: (input: { threadId: string; labelId?: string }) =>
      unwrap(bridge().openThreadWindow(input)),
  });
}

/** Opens a compose page (`/mail/compose?…`) in a window of its own. */
export function openComposeWindow(href: string) {
  return unwrap(bridge().openComposeWindow({ href }));
}

export function useOpenComposeWindow() {
  return useMutation({ mutationFn: openComposeWindow });
}

export function useThread(threadId: string) {
  return useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => unwrap(bridge().getThread({ threadId })),
  });
}

/**
 * Draft requests for the compose form, which runs them through its own save
 * queue (so they are plain calls, not mutations).
 */
export const draftRequests = {
  save: (input: SendMessageInput) => unwrap(bridge().saveDraft(input)),
  delete: (draftId: string) => unwrap(bridge().deleteDraft({ draftId })),
};

/** The Drafts list, refreshed after a draft is saved, sent, or deleted. */
export const draftListKey = ["threads", { label: "DRAFT" }];

/**
 * A saved draft, opened to keep writing. Fetched once: the first autosave
 * replaces the draft's message, so a refetch by the old id would fail.
 */
export function useOpenDraft(messageId: string) {
  return useQuery({
    queryKey: ["draft", messageId],
    queryFn: () => unwrap(bridge().openDraft({ messageId })),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

/** Saves a received attachment where the user picks in a save dialog. */
export function useSaveAttachment() {
  return useMutation({
    mutationFn: (input: {
      messageId: string;
      attachmentId: string;
      filename: string;
    }) => unwrap(bridge().saveAttachment(input)),
  });
}

/** Addresses the account may send from: its own and verified Gmail aliases. */
export function useSendAs() {
  return useQuery({
    queryKey: ["sendAs"],
    queryFn: () => unwrap(bridge().listSendAs()),
    staleTime: 10 * 60_000,
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: SendMessageInput) =>
      unwrap(bridge().sendMessage(message)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["threads"] }),
  });
}

export function useMarkThreadRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      unwrap(
        bridge().modifyThreads({
          threadIds: [threadId],
          removeLabelIds: ["UNREAD"],
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["threads"] }),
  });
}

export type ThreadAction =
  | "trash"
  | "restore"
  | "archive"
  | "markRead"
  | "markUnread";

/** Actions after which the thread no longer belongs to the label being viewed. */
const LEAVES_LABEL: Record<ThreadAction, boolean> = {
  trash: true,
  restore: true,
  archive: true,
  markRead: false,
  markUnread: false,
};

function runThreadAction(action: ThreadAction, threadIds: string[]) {
  const api = bridge();
  switch (action) {
    case "trash":
      return api.trashThreads({ threadIds });
    case "restore":
      return api.untrashThreads({ threadIds });
    case "archive":
      return api.modifyThreads({ threadIds, removeLabelIds: ["INBOX"] });
    case "markRead":
      return api.modifyThreads({ threadIds, removeLabelIds: ["UNREAD"] });
    case "markUnread":
      return api.modifyThreads({ threadIds, addLabelIds: ["UNREAD"] });
  }
}

export function useThreadAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      action,
      threadIds,
    }: {
      action: ThreadAction;
      threadIds: string[];
      /** The list being viewed, updated optimistically. */
      list: MailList;
    }) => unwrap(runThreadAction(action, threadIds)),
    onMutate: async ({ action, threadIds, list }) => {
      const ids = new Set(threadIds);
      // In an unread-only list, a thread marked read no longer belongs there either.
      const leaves =
        LEAVES_LABEL[action] || (list.unread === true && action === "markRead");
      await queryClient.cancelQueries({ queryKey: ["threads"] });
      queryClient.setQueriesData<InfiniteData<ThreadPage>>(
        { queryKey: leaves ? ["threads", list] : ["threads"] },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              threads: leaves
                ? page.threads.filter((thread) => !ids.has(thread.id))
                : page.threads.map((thread) =>
                    ids.has(thread.id)
                      ? { ...thread, unread: action === "markUnread" }
                      : thread,
                  ),
            })),
          },
      );
    },
    // Refetch on success and failure alike: on failure this rolls back the optimistic edit.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
        queryClient.invalidateQueries({ queryKey: ["thread"] }),
      ]),
  });
}
