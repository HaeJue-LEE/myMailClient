import type { gmail_v1 } from "@googleapis/gmail";
import pLimit from "p-limit";
import type {
  MailLabel,
  SendAsAddress,
  ThreadPage,
} from "@/features/mail/types";
import { buildMimeMessage, type OutgoingMessage } from "./mime";
import { paced } from "./pacer";
import { toMailThread, toThreadSummary } from "./parse";

type Gmail = gmail_v1.Gmail;

const USER = "me";
const PAGE_SIZE = 20;
/** Parallel requests per batch; the pacer still caps the overall request rate. */
const THREAD_FETCH_CONCURRENCY = 5;

// Every Gmail call goes through `paced`, which spaces requests to stay under the
// per-user quota and retries throttled ones.

export async function listLabels(gmail: Gmail): Promise<MailLabel[]> {
  const { data } = await paced(() => gmail.users.labels.list({ userId: USER }));
  return (data.labels ?? []).flatMap((label) => {
    if (!label.id || !label.name) return [];
    return [
      {
        id: label.id,
        name: label.name,
        type: label.type === "system" ? "system" : "user",
      },
    ];
  });
}

/** A MIME part without its data, nested `depth` levels (attachments sit a few levels down). */
function partFields(depth: number): string {
  const own = "mimeType,filename,headers(name,value),body/size";
  return depth === 0 ? own : `${own},parts(${partFields(depth - 1)})`;
}

/** What a list row needs from each message: headers, labels, and the part tree. */
const THREAD_SUMMARY_FIELDS = `id,messages(id,labelIds,internalDate,snippet,payload(${partFields(5)}))`;

export async function listThreads(
  gmail: Gmail,
  params: { labelId?: string; query?: string; pageToken?: string },
): Promise<ThreadPage> {
  const { data } = await paced(() =>
    gmail.users.threads.list({
      userId: USER,
      labelIds: params.labelId ? [params.labelId] : undefined,
      // Gmail search syntax; like Gmail itself, spam and trash are excluded unless in:spam / in:trash.
      q: params.query,
      pageToken: params.pageToken,
      maxResults: PAGE_SIZE,
      includeSpamTrash:
        params.labelId === "SPAM" || params.labelId === "TRASH",
    }),
  );

  const limit = pLimit(THREAD_FETCH_CONCURRENCY);
  const threads = await Promise.all(
    (data.threads ?? []).map((thread) =>
      limit(async () => {
        const { data: detail } = await paced(() =>
          gmail.users.threads.get({
            userId: USER,
            id: thread.id ?? "",
            // The MIME structure (to flag attachments) needs "full"; the field
            // mask keeps body data out, so the response stays small.
            format: "full",
            fields: THREAD_SUMMARY_FIELDS,
          }),
        );
        return toThreadSummary(detail);
      }),
    ),
  );

  return { threads, nextPageToken: data.nextPageToken ?? null };
}

export async function getThread(gmail: Gmail, id: string) {
  const { data } = await paced(() =>
    gmail.users.threads.get({ userId: USER, id, format: "full" }),
  );
  return toMailThread(data);
}

/** Gmail has no batch endpoint for threads, so bulk actions fan out per thread. */
async function forEachThread(ids: string[], run: (id: string) => Promise<unknown>) {
  const limit = pLimit(THREAD_FETCH_CONCURRENCY);
  await Promise.all(ids.map((id) => limit(() => paced(() => run(id)))));
}

export async function modifyThreads(
  gmail: Gmail,
  ids: string[],
  change: { addLabelIds: string[]; removeLabelIds: string[] },
) {
  await forEachThread(ids, (id) =>
    gmail.users.threads.modify({ userId: USER, id, requestBody: change }),
  );
}

/** Moves to Trash; Gmail purges it after 30 days. Nothing here deletes permanently. */
export async function trashThreads(gmail: Gmail, ids: string[]) {
  await forEachThread(ids, (id) => gmail.users.threads.trash({ userId: USER, id }));
}

export async function untrashThreads(gmail: Gmail, ids: string[]) {
  await forEachThread(ids, (id) =>
    gmail.users.threads.untrash({ userId: USER, id }),
  );
}

/**
 * Addresses this account may send as: its own, plus "Send mail as" aliases
 * that Gmail has verified. Unverified ones would be rewritten or rejected.
 */
export async function listSendAs(gmail: Gmail): Promise<SendAsAddress[]> {
  const { data } = await paced(() =>
    gmail.users.settings.sendAs.list({ userId: USER }),
  );
  return (data.sendAs ?? []).flatMap((alias) => {
    const usable = alias.isPrimary || alias.verificationStatus === "accepted";
    if (!alias.sendAsEmail || !usable) return [];
    return [
      {
        email: alias.sendAsEmail.toLowerCase(),
        name: alias.displayName ?? "",
        isDefault: alias.isDefault ?? false,
        isPrimary: alias.isPrimary ?? false,
        signature: alias.signature ?? "",
      },
    ];
  });
}

/**
 * The message as an upload: the media endpoints take the RFC 822 text as is
 * (up to 35 MB), unlike `raw`, which must fit in a JSON body as base64.
 */
function rfc822(message: OutgoingMessage) {
  return { mimeType: "message/rfc822", body: buildMimeMessage(message) };
}

/** `from` is the complete From header value, e.g. from `formatMailbox`. */
export async function sendMessage(
  gmail: Gmail,
  from: string,
  message: Omit<OutgoingMessage, "from"> & { threadId?: string },
) {
  const { threadId, ...content } = message;
  const media = rfc822({ ...content, from });
  const { data } = await paced(() =>
    gmail.users.messages.send({
      userId: USER,
      requestBody: threadId ? { threadId } : {},
      media,
    }),
  );
  return { id: data.id ?? "", threadId: data.threadId ?? "" };
}

/** Creates the draft, or replaces its content when `draftId` is given. */
export async function saveDraft(
  gmail: Gmail,
  draftId: string | undefined,
  message: OutgoingMessage & { threadId?: string },
) {
  const { threadId, ...content } = message;
  const media = rfc822(content);
  const requestBody = { message: threadId ? { threadId } : {} };
  const { data } = await paced(() =>
    draftId
      ? gmail.users.drafts.update({
          userId: USER,
          id: draftId,
          requestBody: { ...requestBody, id: draftId },
          media,
        })
      : gmail.users.drafts.create({ userId: USER, requestBody, media }),
  );
  return { draftId: data.id ?? "", messageId: data.message?.id ?? "" };
}

/** Sends the draft with this final content; Gmail removes the draft. */
export async function sendDraft(
  gmail: Gmail,
  draftId: string,
  message: OutgoingMessage & { threadId?: string },
) {
  const { threadId, ...content } = message;
  const { data } = await paced(() =>
    gmail.users.drafts.send({
      userId: USER,
      requestBody: { id: draftId, message: threadId ? { threadId } : {} },
      media: rfc822(content),
    }),
  );
  return { id: data.id ?? "", threadId: data.threadId ?? "" };
}

/** Deletes a draft permanently; one already gone counts as deleted. */
export async function deleteDraft(gmail: Gmail, draftId: string) {
  try {
    await paced(() => gmail.users.drafts.delete({ userId: USER, id: draftId }));
  } catch (error) {
    if ((error as { status?: unknown }).status !== 404) throw error;
  }
}

/** The draft whose current message is `messageId`, with that message in full. */
export async function findDraft(gmail: Gmail, messageId: string) {
  let pageToken: string | undefined;
  do {
    const { data } = await paced(() =>
      gmail.users.drafts.list({ userId: USER, maxResults: 500, pageToken }),
    );
    const draft = data.drafts?.find((item) => item.message?.id === messageId);
    if (draft?.id) {
      const { data: message } = await paced(() =>
        gmail.users.messages.get({ userId: USER, id: messageId, format: "full" }),
      );
      return { draftId: draft.id, message };
    }
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return null;
}

/** The bytes of a received attachment. */
export async function getAttachmentData(
  gmail: Gmail,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const { data } = await paced(() =>
    gmail.users.messages.attachments.get({
      userId: USER,
      messageId,
      id: attachmentId,
    }),
  );
  return Buffer.from(data.data ?? "", "base64url");
}
