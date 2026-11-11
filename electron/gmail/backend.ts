import type { Session } from "../auth";
import type { MailBackend } from "../backend";
import { buildOutgoing, openDraft, type OutgoingSource } from "../compose";
import {
  deleteDraft,
  getAttachmentData,
  getThread,
  listLabels,
  listSendAs,
  listThreads,
  modifyThreads,
  saveDraft,
  sendDraft,
  sendMessage,
  trashThreads,
  untrashThreads,
} from "./service";

/** The Google account, through the Gmail API. */
export function createGmailBackend({ gmail, email }: Session): MailBackend {
  const source: OutgoingSource = {
    listSendAs: () => listSendAs(gmail),
    getAttachmentData: (messageId, attachmentId) =>
      getAttachmentData(gmail, messageId, attachmentId),
  };
  return {
    ...source,
    listLabels: () => listLabels(gmail),
    listThreads: (input) => listThreads(gmail, input),
    getThread: (threadId) => getThread(gmail, threadId),
    modifyThreads: (threadIds, change) => modifyThreads(gmail, threadIds, change),
    trashThreads: (threadIds) => trashThreads(gmail, threadIds),
    untrashThreads: (threadIds) => untrashThreads(gmail, threadIds),
    sendMessage: async (input) => {
      const outgoing = await buildOutgoing(source, email, input);
      if (input.draftId) {
        // Sends the final content as the draft, which Gmail then removes.
        return sendDraft(gmail, input.draftId, outgoing);
      }
      const { from, threadId, ...message } = outgoing;
      return sendMessage(gmail, from, { ...message, threadId });
    },
    // Unlike sending, a draft may have no recipients yet.
    saveDraft: async (input) => {
      const outgoing = await buildOutgoing(source, email, input);
      const { draftId } = await saveDraft(gmail, input.draftId, outgoing);
      return { draftId };
    },
    deleteDraft: (draftId) => deleteDraft(gmail, draftId),
    openDraft: (messageId) => openDraft(gmail, messageId),
  };
}
