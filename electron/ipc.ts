import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  shell,
} from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";
import {
  channelOf,
  type IpcResult,
  type MailMethods,
} from "@/features/mail/bridge";
import { MAX_CONTACT_NAME_LENGTH } from "@/features/mail/contacts";
import { emailSchema } from "@/features/mail/email";
import {
  type Account,
  mailAccountInputSchema,
} from "@/features/mail/mail-accounts";
import { MAX_SEARCH_LENGTH } from "@/features/mail/routes";
import {
  getActiveId,
  getMailAccount,
  removeMailAccount,
  resolveCredentials,
  setAccountOrder,
  setActiveId,
  storeMailAccount,
} from "./accounts";
import {
  dropSessions,
  getSession,
  LoginCancelledError,
  type Session,
  signIn,
  signOut,
  signOutAll,
} from "./auth";
import {
  clientHint,
  getGoogleClient,
  googleClientSchema,
  removeCustomGoogleClient,
  saveCustomGoogleClient,
} from "./google-client";
import { chooseAvatar, removeAvatar } from "./avatars";
import {
  getActiveAccount,
  listAccounts,
  requireBackend,
} from "./backend";
import {
  createContact,
  deleteContact,
  listContacts,
  PERSON_RESOURCE,
  updateContact,
} from "./contacts";
import { composeSchema } from "./compose";
import {
  forGoogleAccount,
  GoogleSignInExpired,
  InvalidRequestError,
  toErrorCode,
} from "./errors";
import { getGoogleAccount } from "./google-accounts";
import { safeFilename } from "./gmail/mime";
import { getHiddenContacts, setContactsHidden } from "./hidden-contacts";
import { dropImap, verifyImap } from "./imap/connection";
import { markFromInternet, openWarning, writeNewFile } from "./open-attachment";
import { verifySmtp } from "./imap/smtp";
import { verifyPop3 } from "./pop3/client";
import { removeLocalStore } from "./pop3/store";
import {
  cancelScheduled,
  listScheduled,
  rescheduleSend,
  scheduleSend,
  sendScheduledNow,
} from "./scheduled";
import { SHORTCUT_PLACES, setShortcut, shortcutStatus } from "./shortcuts";
import {
  cancelUpdateDownload,
  checkForUpdate,
  downloadUpdate,
  getUpdateStatus,
  installDownloadedDmg,
  openUpdatePage,
  restartToUpdate,
} from "./updater";
import { revokeZoho, signInZoho } from "./zoho/auth";
import { dropZohoCaches } from "./zoho/backend";
import {
  getZohoAccount,
  getZohoClient,
  removeZohoAccount,
  removeZohoClient,
  saveZohoClient,
  storeZohoAccount,
  zohoClientSchema,
} from "./zoho/store";

type Input<K extends keyof MailMethods> = Parameters<MailMethods[K]>[0];
type Handler<K extends keyof MailMethods> = {
  input: z.ZodType<Input<K>>;
  /** `event` identifies the calling window, e.g. to parent a dialog. */
  run: (
    input: Input<K>,
    event: IpcMainInvokeEvent,
  ) => Promise<ReturnType<MailMethods[K]>>;
};

const noInput = z.undefined();
const id = z.string().min(1);
const accountId = z.string().min(1).max(64);
const addresses = z.array(emailSchema);
/**
 * An address as it appears in the contact list. Only matched or used as a key,
 * never sent anywhere, so Google's stored form is accepted as is.
 */
const listedAddress = z.string().trim().min(1).max(320);
/** Bounded so one request cannot fan out into an unbounded burst of server calls. */
const threadIds = z.array(id).min(1).max(100);
/** Goes into a People API URL path, so only `people/<id>` is accepted. */
const personResource = z.string().regex(PERSON_RESOURCE);
/** Enough for a whole address book in one go, but bounded. */
const MAX_HIDE_BATCH = 5000;

const backend = async () => (await requireBackend()).backend;

/**
 * The Google account whose address book the app shows and adds to: the
 * account in use when it is a Google account, otherwise the first Google
 * account in the list. Null when no Google account is signed in.
 */
async function addressBookSession(): Promise<Session | null> {
  const [accounts, active] = await Promise.all([listAccounts(), getActiveAccount()]);
  const google = active?.kind === "gmail" ? active : accounts.find((item) => item.kind === "gmail");
  return google ? getSession(google.id) : null;
}

/** Runs `work` with the address book's Google account; a dead sign-in names that account. */
async function withAddressBook<T>(work: (session: Session) => Promise<T>): Promise<T> {
  const session = await addressBookSession();
  if (!session) throw new InvalidRequestError("No Google account to keep contacts in");
  return forGoogleAccount(session.id, () => work(session));
}

async function appFeatures() {
  const [{ client, source }, zoho] = await Promise.all([getGoogleClient(), getZohoClient()]);
  return {
    googleSignIn: client !== null,
    googleClient: source,
    googleClientHint: client ? clientHint(client) : null,
    zohoClient: zoho ? { region: zoho.region, hint: `${zoho.clientId.slice(0, 12)}…` } : null,
    shortcuts: shortcutStatus(),
  };
}

export function registerMailHandlers(options: {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
  onSignedIn: () => void;
  openThreadWindow: (threadId: string, accountId: string, labelId?: string) => void;
  /** False when `href` is not the app's compose page. */
  openComposeWindow: (href: string, accountId: string) => boolean;
}) {
  const handlers: { [K in keyof MailMethods]: Handler<K> } = {
    getAppFeatures: {
      input: noInput,
      run: appFeatures,
    },
    saveGoogleClient: {
      input: googleClientSchema,
      run: async (client) => {
        await saveCustomGoogleClient(client);
        // A session made with another client cannot be refreshed with this one.
        dropSessions();
        return appFeatures();
      },
    },
    saveZohoClient: {
      input: zohoClientSchema,
      run: async (client) => {
        await saveZohoClient(client);
        return appFeatures();
      },
    },
    removeZohoClient: {
      input: noInput,
      run: async () => {
        // Sign-ins made with it cannot be refreshed without it.
        const activeId = await getActiveId();
        for (const id of await removeZohoClient()) {
          dropZohoCaches(id);
          await removeAvatar(id);
          if (activeId === id) await setActiveId(null);
        }
        return appFeatures();
      },
    },
    loginZoho: {
      input: noInput,
      run: async () => {
        const zoho = await signInZoho();
        dropZohoCaches(zoho.id);
        await storeZohoAccount(zoho);
        await setActiveId(zoho.id);
        options.onSignedIn();
        return { id: zoho.id, kind: "zoho", email: zoho.email, name: zoho.name };
      },
    },
    getUpdateStatus: {
      input: noInput,
      run: getUpdateStatus,
    },
    checkForUpdate: {
      input: noInput,
      run: () => checkForUpdate({ manual: true }),
    },
    downloadUpdate: {
      input: noInput,
      run: async () => downloadUpdate(),
    },
    cancelUpdateDownload: {
      input: noInput,
      run: async () => cancelUpdateDownload(),
    },
    openUpdatePage: {
      input: noInput,
      run: async () => openUpdatePage(),
    },
    installDownloadedDmg: {
      input: noInput,
      run: installDownloadedDmg,
    },
    restartToUpdate: {
      input: noInput,
      run: async () => {
        if (!restartToUpdate()) throw new InvalidRequestError("No update is ready to install");
        return null;
      },
    },
    setShortcut: {
      input: z.object({ place: z.enum(SHORTCUT_PLACES), enabled: z.boolean() }),
      run: async ({ place, enabled }) => {
        try {
          setShortcut(place, enabled);
        } catch (error) {
          throw new InvalidRequestError((error as Error).message);
        }
        return appFeatures();
      },
    },
    removeGoogleClient: {
      input: noInput,
      run: async () => {
        if ((await getGoogleClient()).source === "custom") {
          // Sign-ins made with it cannot be refreshed without it.
          const activeId = await getActiveId();
          for (const id of await signOutAll({ revoke: true })) {
            await removeAvatar(id);
            if (activeId === id) await setActiveId(null);
          }
          await removeCustomGoogleClient();
        }
        return appFeatures();
      },
    },
    getAccount: {
      input: noInput,
      run: getActiveAccount,
    },
    listAccounts: {
      input: noInput,
      run: listAccounts,
    },
    setActiveAccount: {
      input: z.object({ id: accountId }),
      run: async ({ id }) => {
        const account = (await listAccounts()).find((item) => item.id === id);
        if (!account) throw new InvalidRequestError("No such account");
        await setActiveId(id);
        return account;
      },
    },
    login: {
      input: noInput,
      run: async () => {
        const { id, email } = await signIn();
        await setActiveId(id);
        options.onSignedIn();
        return { id, kind: "gmail", email, name: "" };
      },
    },
    removeAccount: {
      input: z.object({ id: accountId }),
      run: async ({ id }) => {
        const zoho = await getZohoAccount(id);
        if (await getGoogleAccount(id)) {
          await signOut(id, { revoke: true });
          if ((await getActiveId()) === id) await setActiveId(null);
        } else if (zoho) {
          await revokeZoho(zoho);
          dropZohoCaches(id);
          await removeZohoAccount(id);
          if ((await getActiveId()) === id) await setActiveId(null);
        } else {
          dropImap(id);
          await removeMailAccount(id);
          // Read state, drafts and sent copies of a POP3 account.
          await removeLocalStore(id);
        }
        await removeAvatar(id);
        return null;
      },
    },
    chooseAccountAvatar: {
      input: z.object({ id: accountId }),
      run: async ({ id }, event) => {
        if (!(await listAccounts()).some((account) => account.id === id)) {
          throw new InvalidRequestError("No such account");
        }
        const changed = await chooseAvatar(BrowserWindow.fromWebContents(event.sender), id);
        return { changed };
      },
    },
    setAccountOrder: {
      input: z.object({ ids: z.array(accountId).max(200) }),
      run: async ({ ids }) => {
        const known = new Set((await listAccounts()).map((account) => account.id));
        // Only accounts that exist; one missing from `ids` keeps its place after them.
        await setAccountOrder(ids.filter((id) => known.has(id)));
        return listAccounts();
      },
    },
    removeAccountAvatar: {
      input: z.object({ id: accountId }),
      run: async ({ id }) => {
        await removeAvatar(id);
        return null;
      },
    },
    getMailAccount: {
      input: z.object({ id: accountId }),
      run: async ({ id }) => {
        const account = await getMailAccount(id);
        if (!account) throw new InvalidRequestError("No such account");
        return account;
      },
    },
    saveMailAccount: {
      input: mailAccountInputSchema,
      run: async (input) => {
        const credentials = await resolveCredentials(input);
        // Nothing is stored unless both servers accept the sign-in.
        if (credentials.protocol === "pop3") await verifyPop3(credentials);
        else await verifyImap(credentials);
        await verifySmtp(credentials);
        const hadAccount = (await getActiveAccount()) !== null;
        // An open connection may still use the old settings.
        dropImap(credentials.id);
        const { id, email, name, protocol } = await storeMailAccount(credentials);
        // The first account is put to use at once.
        if (!hadAccount) await setActiveId(id);
        return { id, kind: protocol, email, name } satisfies Account;
      },
    },
    listLabels: {
      input: noInput,
      run: async () => (await backend()).listLabels(),
    },
    listThreads: {
      input: z
        .object({
          labelId: id.optional(),
          query: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).optional(),
          pageToken: id.optional(),
        })
        .refine((input) => Boolean(input.labelId || input.query), {
          message: "labelId or query is required",
        }),
      run: async (input) => (await backend()).listThreads(input),
    },
    getThread: {
      input: z.object({ threadId: id }),
      run: async ({ threadId }) => (await backend()).getThread(threadId),
    },
    openThreadWindow: {
      input: z.object({ threadId: id.max(512), labelId: id.max(512).optional() }),
      run: async ({ threadId, labelId }) => {
        // The window is tied to the account in use now; it says so if that changes.
        const { account } = await requireBackend();
        options.openThreadWindow(threadId, account.id, labelId);
        return null;
      },
    },
    openComposeWindow: {
      input: z.object({ href: z.string().min(1).max(4096) }),
      run: async ({ href }) => {
        const { account } = await requireBackend();
        if (!options.openComposeWindow(href, account.id)) {
          throw new InvalidRequestError("Not a compose page");
        }
        return null;
      },
    },
    modifyThreads: {
      input: z.object({
        threadIds,
        addLabelIds: z.array(id).default([]),
        removeLabelIds: z.array(id).default([]),
      }),
      run: async ({ threadIds, addLabelIds = [], removeLabelIds = [] }) => {
        await (await backend()).modifyThreads(threadIds, {
          addLabelIds,
          removeLabelIds,
        });
        return null;
      },
    },
    trashThreads: {
      input: z.object({ threadIds }),
      run: async ({ threadIds }) => {
        await (await backend()).trashThreads(threadIds);
        return null;
      },
    },
    untrashThreads: {
      input: z.object({ threadIds }),
      run: async ({ threadIds }) => {
        await (await backend()).untrashThreads(threadIds);
        return null;
      },
    },
    sendMessage: {
      input: composeSchema.extend({ to: addresses.min(1) }),
      run: async (input) => (await backend()).sendMessage(input),
    },
    scheduleSend: {
      input: composeSchema.extend({ to: addresses.min(1), sendAt: z.number().int() }),
      run: async ({ sendAt, ...message }) => {
        const { account, backend } = await requireBackend();
        return scheduleSend(account, backend, message, sendAt);
      },
    },
    listScheduled: {
      input: noInput,
      run: listScheduled,
    },
    rescheduleSend: {
      input: z.object({ id: z.string().uuid(), sendAt: z.number().int() }),
      run: ({ id, sendAt }) => rescheduleSend(id, sendAt),
    },
    sendScheduledNow: {
      input: z.object({ id: z.string().uuid() }),
      run: async ({ id }) => {
        await sendScheduledNow(id);
        return null;
      },
    },
    cancelScheduled: {
      input: z.object({ id: z.string().uuid(), discard: z.boolean().optional() }),
      run: ({ id, discard }) => cancelScheduled(id, { discard: discard ?? false }),
    },
    saveDraft: {
      // Unlike sending, a draft may have no recipients yet.
      input: composeSchema,
      run: async (input) => (await backend()).saveDraft(input),
    },
    deleteDraft: {
      input: z.object({ draftId: id }),
      run: async ({ draftId }) => {
        await (await backend()).deleteDraft(draftId);
        return null;
      },
    },
    openDraft: {
      input: z.object({ messageId: id }),
      run: async ({ messageId }) => (await backend()).openDraft(messageId),
    },
    listSendAs: {
      input: noInput,
      run: async () => (await backend()).listSendAs(),
    },
    saveAttachment: {
      input: z.object({
        messageId: id,
        attachmentId: z.string().min(1).max(4096),
        filename: z.string().max(255),
      }),
      run: async ({ messageId, attachmentId, filename }, event) => {
        const mail = await backend();
        // The name comes from the email: keep only a plain file name.
        const options = {
          defaultPath: path.join(app.getPath("downloads"), safeFilename(filename)),
        };
        const window = BrowserWindow.fromWebContents(event.sender);
        const choice = window
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options);
        if (choice.canceled || !choice.filePath) return { saved: false };
        // Saved only, never opened: attachments may be executables.
        await writeFile(
          choice.filePath,
          await mail.getAttachmentData(messageId, attachmentId),
        );
        return { saved: true, filename: path.basename(choice.filePath) };
      },
    },
    openAttachment: {
      input: z.object({
        messageId: id,
        attachmentId: z.string().min(1).max(4096),
        filename: z.string().max(255),
      }),
      run: async ({ messageId, attachmentId, filename }, event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        const warning = openWarning(filename);
        const { response } = window
          ? await dialog.showMessageBox(window, warning)
          : await dialog.showMessageBox(warning);
        if (response !== 0) return { opened: false };

        const data = await (await backend()).getAttachmentData(messageId, attachmentId);
        const file = await writeNewFile(app.getPath("downloads"), filename, data);
        await markFromInternet(file);
        // Resolves to an error message rather than rejecting.
        const problem = await shell.openPath(file);
        return { opened: !problem, filename: path.basename(file), ...(problem ? { problem } : {}) };
      },
    },
    listContacts: {
      input: noInput,
      run: async () => {
        // Only Google has an address book; without it only recent senders show.
        const session = await addressBookSession();
        if (!session) return [];
        return forGoogleAccount(session.id, () => listContacts(session.auth, session.email));
      },
    },
    createContact: {
      input: z.object({
        name: z.string().trim().max(MAX_CONTACT_NAME_LENGTH),
        email: emailSchema,
      }),
      run: async (input) => {
        return withAddressBook(({ auth, email }) => createContact(auth, email, input));
      },
    },
    updateContact: {
      input: z.object({
        resourceName: personResource,
        // The address being replaced, as Google stored it.
        email: listedAddress,
        name: z.string().trim().max(MAX_CONTACT_NAME_LENGTH),
        newEmail: emailSchema,
      }),
      run: async (input) => {
        return withAddressBook(({ auth, email }) => updateContact(auth, email, input));
      },
    },
    getHiddenContacts: {
      input: noInput,
      run: getHiddenContacts,
    },
    setContactsHidden: {
      input: z.object({
        emails: z.array(listedAddress).min(1).max(MAX_HIDE_BATCH),
        hidden: z.boolean(),
      }),
      run: async ({ emails, hidden }) => setContactsHidden(emails, hidden),
    },
    deleteContact: {
      input: z.object({ resourceName: personResource }),
      run: async ({ resourceName }) => {
        await withAddressBook(({ auth }) => deleteContact(auth, resourceName));
        return null;
      },
    },
  };
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(
      channelOf(method as keyof MailMethods),
      async (event, raw: unknown): Promise<IpcResult<unknown>> => {
        if (!options.isTrustedSender(event)) {
          return { ok: false, error: "invalid_request" };
        }
        try {
          const input = handler.input.parse(raw);
          return { ok: true, data: await handler.run(input as never, event) };
        } catch (error) {
          // Only the Google account whose sign-in died is signed out.
          if (error instanceof GoogleSignInExpired) {
            await signOut(error.accountId, { revoke: false }).catch(() => undefined);
          }
          const code = toErrorCode(
            error,
            (e) => e instanceof LoginCancelledError,
          );
          if (code === "internal_error") console.error(error);
          else if (error instanceof ZodError) {
            // Which field failed and why, without the submitted values.
            const issues = error.issues.map(
              (issue) => `${issue.path.join(".") || "(input)"}: ${issue.code}`,
            );
            console.warn(`[mail:${method}] invalid_request`, issues.join(", "));
          } else if (!["unauthorized", "invalid_request", "login_cancelled"].includes(code)) {
            // Status and Gmail's message only: enough to diagnose, no request data.
            const { status, message } = error as { status?: unknown; message?: unknown };
            console.warn(`[mail:${method}] ${code}`, status, message);
          }
          return { ok: false, error: code };
        }
      },
    );
  }
}
