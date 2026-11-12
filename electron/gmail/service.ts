import type { gmail_v1 } from "@googleapis/gmail";
import pLimit from "p-limit";
import type {
  MailLabel,
  SendAsAddress,
  ThreadPage,
  ThreadSummary,
} from "@/features/mail/types";
import { buildMimeMessage, type OutgoingMessage } from "./mime";
import { GMAIL_COST as COST, paced } from "./pacer";
import { hasRealAttachment, toMailThread, toThreadSummary } from "./parse";

type Gmail = gmail_v1.Gmail;

const USER = "me";
const PAGE_SIZE = 20;
/** Parallel requests per batch; the pacer still caps the overall request rate. */
const THREAD_FETCH_CONCURRENCY = 5;

// Every Gmail call goes through `paced` with its quota cost, which keeps the
// account under Gmail's per-user units per minute and retries throttled calls.

export async function listLabels(gmail: Gmail): Promise<MailLabel[]> {
  const { data } = await paced(COST.labelsList, () => gmail.users.labels.list({ userId: USER }));
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

/** The part tree of each message, for the few threads whose attachments need a closer look. */
const THREAD_PARTS_FIELDS = `id,messages(payload(${partFields(5)}))`;

/** Files that make Gmail's `has:attachment` match but are not attachments to the reader. */
const NOT_ATTACHMENTS = "filename:(vcf OR vcard OR p7s OR asc OR sig)";

/** Rows by thread id, reused while Gmail's historyId for the thread is unchanged. */
const summaryCache = new Map<string, { historyId: string; summary: ThreadSummary }>();
const SUMMARY_CACHE_SIZE = 3_000;

function remember(id: string, historyId: string, summary: ThreadSummary) {
  summaryCache.delete(id);
  summaryCache.set(id, { historyId, summary });
  for (const oldest of summaryCache.keys()) {
    if (summaryCache.size <= SUMMARY_CACHE_SIZE) break;
    summaryCache.delete(oldest);
  }
}

/** For tests: forget every cached row. */
export function clearSummaryCache() {
  summaryCache.clear();
}

type ListParams = { labelId?: string; query?: string; pageToken?: string };

/**
 * Ids of the threads Gmail finds for `search` among those up to `before`
 * (epoch seconds), until all of `wanted` were seen or a few pages were read.
 *
 * Deliberately over all mail, not within the label or search being shown:
 * Gmail applies those to each message, so an inbox thread whose attachment is
 * in a message the user sent (labelled Sent only) would be missed. Thread ids
 * are the same everywhere, so the results still match the rows. A thread's
 * newest message is its list date, so all its messages are before `before`.
 */
async function searchThreadIds(
  gmail: Gmail,
  params: ListParams,
  search: string,
  before: number,
  wanted: Set<string>,
) {
  const found = new Set<string>();
  const q = `${search} before:${before}`;
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    const { data } = await paced(COST.threadsList, () =>
      gmail.users.threads.list({
        userId: USER,
        q,
        pageToken,
        maxResults: 500,
        includeSpamTrash: params.labelId === "SPAM" || params.labelId === "TRASH",
        fields: "threads/id,nextPageToken",
      }),
    );
    for (const thread of data.threads ?? []) if (thread.id) found.add(thread.id);
    pageToken = data.nextPageToken ?? undefined;
    if (!pageToken || [...wanted].every((id) => found.has(id))) break;
  }
  return found;
}

/**
 * Which of `rows` carry a real attachment. Gmail's own search does most of it
 * at 10 units: `has:attachment` (business cards and signature files count
 * there), less threads whose only files may be those. Threads that have
 * both are fetched with their part tree (120 units each) and decided by
 * `hasRealAttachment`, which also ignores pictures shown in the body.
 */
async function attachmentFlags(gmail: Gmail, params: ListParams, rows: ThreadSummary[]) {
  const flags = new Map<string, boolean>();
  if (rows.length === 0) return flags;
  const ids = new Set(rows.map((row) => row.id));
  const newest = Math.max(...rows.map((row) => row.date ?? Date.now()));
  const before = Math.floor(newest / 1000) + 1;
  const withFiles = await searchThreadIds(gmail, params, "has:attachment", before, ids);
  const candidates = new Set([...ids].filter((id) => withFiles.has(id)));
  const withCards = candidates.size
    ? await searchThreadIds(gmail, params, `has:attachment ${NOT_ATTACHMENTS}`, before, candidates)
    : new Set<string>();
  for (const id of ids) flags.set(id, candidates.has(id) && !withCards.has(id));

  const unsure = [...candidates].filter((id) => withCards.has(id));
  const limit = pLimit(THREAD_FETCH_CONCURRENCY);
  await Promise.all(
    unsure.map((id) =>
      limit(async () => {
        const { data } = await paced(COST.threadsGetFull, () =>
          gmail.users.threads.get({ userId: USER, id, format: "full", fields: THREAD_PARTS_FIELDS }),
        );
        flags.set(id, (data.messages ?? []).some(hasRealAttachment));
      }),
    ),
  );
  return flags;
}

/**
 * One page of a label or search. Rows are built from each thread's headers
 * (`metadata`, 40 units); a thread whose historyId has not changed since it
 * was last shown is reused without asking again, so refreshing a list costs
 * little more than the list call itself.
 */
export async function listThreads(gmail: Gmail, params: ListParams): Promise<ThreadPage> {
  const { data } = await paced(COST.threadsList, () =>
    gmail.users.threads.list({
      userId: USER,
      labelIds: params.labelId ? [params.labelId] : undefined,
      // Gmail search syntax; like Gmail itself, spam and trash are excluded unless in:spam / in:trash.
      q: params.query,
      pageToken: params.pageToken,
      maxResults: PAGE_SIZE,
      includeSpamTrash: params.labelId === "SPAM" || params.labelId === "TRASH",
    }),
  );
  const listed = (data.threads ?? []).filter((thread) => thread.id);

  const limit = pLimit(THREAD_FETCH_CONCURRENCY);
  const fresh: ThreadSummary[] = [];
  const rows = await Promise.all(
    listed.map((thread) =>
      limit(async () => {
        const id = thread.id ?? "";
        const cached = summaryCache.get(id);
        if (cached && thread.historyId && cached.historyId === thread.historyId) {
          return cached.summary;
        }
        const { data: detail } = await paced(COST.threadsGetMetadata, () =>
          gmail.users.threads.get({
            userId: USER,
            id,
            format: "metadata",
            metadataHeaders: ["Subject", "From"],
          }),
        );
        const summary = toThreadSummary(detail);
        fresh.push(summary);
        return summary;
      }),
    ),
  );

  // Only rows fetched just now need their attachment flag; cached ones keep theirs.
  const flags = await attachmentFlags(gmail, params, fresh);
  const threads = rows.map((row) => {
    if (!flags.has(row.id)) return row;
    const flagged = { ...row, hasAttachment: flags.get(row.id) ?? false };
    const historyId = listed.find((thread) => thread.id === row.id)?.historyId;
    if (historyId) remember(row.id, historyId, flagged);
    return flagged;
  });
  return { threads, nextPageToken: data.nextPageToken ?? null };
}

export async function getThread(gmail: Gmail, id: string) {
  const { data } = await paced(COST.threadsGetFull, () =>
    gmail.users.threads.get({ userId: USER, id, format: "full" }),
  );
  return toMailThread(data);
}

/** Gmail has no batch endpoint for threads, so bulk actions fan out per thread. */
async function forEachThread(ids: string[], cost: number, run: (id: string) => Promise<unknown>) {
  const limit = pLimit(THREAD_FETCH_CONCURRENCY);
  await Promise.all(ids.map((id) => limit(() => paced(cost, () => run(id)))));
}

export async function modifyThreads(
  gmail: Gmail,
  ids: string[],
  change: { addLabelIds: string[]; removeLabelIds: string[] },
) {
  await forEachThread(ids, COST.threadsModify, (id) =>
    gmail.users.threads.modify({ userId: USER, id, requestBody: change }),
  );
}

/** Moves to Trash; Gmail purges it after 30 days. Nothing here deletes permanently. */
export async function trashThreads(gmail: Gmail, ids: string[]) {
  await forEachThread(ids, COST.threadsTrash, (id) => gmail.users.threads.trash({ userId: USER, id }));
}

export async function untrashThreads(gmail: Gmail, ids: string[]) {
  await forEachThread(ids, COST.threadsUntrash, (id) =>
    gmail.users.threads.untrash({ userId: USER, id }),
  );
}

/**
 * Addresses this account may send as: its own, plus "Send mail as" aliases
 * that Gmail has verified. Unverified ones would be rewritten or rejected.
 */
export async function listSendAs(gmail: Gmail): Promise<SendAsAddress[]> {
  const { data } = await paced(COST.sendAsList, () =>
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
  const { data } = await paced(COST.messagesSend, () =>
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
  const { data } = await paced(draftId ? COST.draftsUpdate : COST.draftsCreate, () =>
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
  const { data } = await paced(COST.draftsSend, () =>
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
    await paced(COST.draftsDelete, () => gmail.users.drafts.delete({ userId: USER, id: draftId }));
  } catch (error) {
    if ((error as { status?: unknown }).status !== 404) throw error;
  }
}

/** The draft whose current message is `messageId`, with that message in full. */
export async function findDraft(gmail: Gmail, messageId: string) {
  let pageToken: string | undefined;
  do {
    const { data } = await paced(COST.draftsList, () =>
      gmail.users.drafts.list({ userId: USER, maxResults: 500, pageToken }),
    );
    const draft = data.drafts?.find((item) => item.message?.id === messageId);
    if (draft?.id) {
      const { data: message } = await paced(COST.messagesGetFull, () =>
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
  const { data } = await paced(COST.attachmentsGet, () =>
    gmail.users.messages.attachments.get({
      userId: USER,
      messageId,
      id: attachmentId,
    }),
  );
  return Buffer.from(data.data ?? "", "base64url");
}
