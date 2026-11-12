import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
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
  GMAIL_ACCOUNT_ID,
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
  dropSession,
  getSession,
  LoginCancelledError,
  signIn,
  signOut,
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
  InvalidRequestError,
  isAuthFailure,
  toErrorCode,
} from "./errors";
import { safeFilename } from "./gmail/mime";
import { getHiddenContacts, setContactsHidden } from "./hidden-contacts";
import { dropImap, verifyImap } from "./imap/connection";
import { verifySmtp } from "./imap/smtp";
import { verifyPop3 } from "./pop3/client";
import { removeLocalStore } from "./pop3/store";
import { SHORTCUT_PLACES, setShortcut, shortcutStatus } from "./shortcuts";

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
 * The Google session, for the address book. Contacts are shared by every
 * account, so this does not depend on which account is in use.
 */
async function googleSession() {
  const session = await getSession();
  if (!session) throw new InvalidRequestError("No Google account to keep contacts in");
  return session;
}

async function appFeatures() {
  const { client, source } = await getGoogleClient();
  return {
    googleSignIn: client !== null,
    googleClient: source,
    googleClientHint: client ? clientHint(client) : null,
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
        dropSession();
        return appFeatures();
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
          // Its sign-in would be useless without it.
          await signOut({ revoke: true });
          if ((await getActiveId()) === GMAIL_ACCOUNT_ID) await setActiveId(null);
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
        const { email } = await signIn();
        await setActiveId(GMAIL_ACCOUNT_ID);
        options.onSignedIn();
        return { id: GMAIL_ACCOUNT_ID, kind: "gmail", email, name: "" };
      },
    },
    removeAccount: {
      input: z.object({ id: accountId }),
      run: async ({ id }) => {
        if (id === GMAIL_ACCOUNT_ID) {
          await signOut({ revoke: true });
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
    listContacts: {
      input: noInput,
      run: async () => {
        // Only Google has an address book; without it only recent senders show.
        const session = await getSession();
        return session ? listContacts(session.auth, session.email) : [];
      },
    },
    createContact: {
      input: z.object({
        name: z.string().trim().max(MAX_CONTACT_NAME_LENGTH),
        email: emailSchema,
      }),
      run: async (input) => {
        const { auth, email } = await googleSession();
        return createContact(auth, email, input);
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
        const { auth, email } = await googleSession();
        return updateContact(auth, email, input);
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
        await deleteContact((await googleSession()).auth, resourceName);
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
          if (isAuthFailure(error)) await signOut({ revoke: false });
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
