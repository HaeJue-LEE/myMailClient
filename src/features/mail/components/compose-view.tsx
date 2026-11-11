"use client";

import { useSearchParams } from "next/navigation";
import {
  useAccount,
  useOpenDraft,
  useSendAs,
  useThread,
} from "@/features/mail/api";
import { formatRecipient } from "@/features/mail/contacts";
import {
  ComposeForm,
  type ComposeStart,
  initialSender,
  NEW_MESSAGE,
} from "@/features/mail/components/compose-form";
import {
  parseAddressList,
  type ReplyMode,
  startReply,
  textToHtml,
} from "@/features/mail/reply";
import { sanitizeForEditor } from "@/features/mail/sanitize";
import { initialBody, signatureBlock } from "@/features/mail/signature";
import type { SendAsAddress } from "@/features/mail/types";

const REPLY_MODES: Record<ReplyMode, string> = {
  reply: "답장",
  replyAll: "전체답장",
  forward: "전달",
};

const isReplyMode = (value: string | null): value is ReplyMode =>
  value !== null && value in REPLY_MODES;

const LOADING = <p className="p-6 text-sm opacity-60">불러오는 중…</p>;

/** The signature block of the address the message will start from. */
function startingSignature(senders: SendAsAddress[] | undefined, from?: string) {
  const sender = senders?.length ? initialSender(senders, from) : undefined;
  return signatureBlock(sender?.signature ?? "", sanitizeForEditor);
}

/**
 * Chooses what the compose form starts with from the URL:
 * - `?mode=reply|replyAll|forward&thread=…&message=…` answers a message;
 * - `?to=…` (e.g. from a contact) fills in the recipient;
 * - otherwise a new, empty message.
 */
export function ComposeView() {
  const params = useSearchParams();
  const mode = params.get("mode");
  const threadId = params.get("thread");
  const messageId = params.get("message");

  const draft = params.get("draft");

  if (draft) return <DraftCompose messageId={draft} />;
  if (isReplyMode(mode) && threadId && messageId) {
    return <ReplyCompose mode={mode} threadId={threadId} messageId={messageId} />;
  }
  return <NewCompose to={params.get("to")} />;
}

const asField = (header: string) => {
  const list = parseAddressList(header).map((mailbox) => formatRecipient(mailbox));
  return list.length ? `${list.join(", ")}, ` : "";
};

/** Continues a saved draft: its fields, body (re-sanitized), and attachments. */
function DraftCompose({ messageId }: { messageId: string }) {
  const draft = useOpenDraft(messageId);
  // Once loaded, the form stays even if a later fetch fails.
  if (!draft.data) {
    return draft.isError ? (
      <p role="alert" className="p-6 text-sm text-red-600">
        임시저장된 메일을 열지 못했습니다. 이미 보냈거나 삭제되었을 수 있습니다.
      </p>
    ) : (
      LOADING
    );
  }
  const content = draft.data;
  const start: ComposeStart = {
    title: "임시저장된 메일",
    to: asField(content.to),
    cc: asField(content.cc),
    bcc: asField(content.bcc),
    subject: content.subject,
    from: parseAddressList(content.from)[0]?.email,
    // The body already holds any signature and quote.
    bodyHtml:
      content.html !== null
        ? sanitizeForEditor(content.html)
        : textToHtml(content.text ?? ""),
    attachments: content.attachments,
    threadId: content.threadId,
    inReplyTo: content.inReplyTo,
    references: content.references,
    draftId: content.draftId,
    // Saved drafts lose the signature marker, so a sender change must not
    // add a second signature.
    swapSignature: false,
    focus: "body",
  };
  return <ComposeForm key={content.draftId} start={start} />;
}

function NewCompose({ to }: { to: string | null }) {
  // Waits for the sender list, which holds the signature to start with.
  const senders = useSendAs();
  if (senders.isPending) return LOADING;
  const start: ComposeStart = {
    ...NEW_MESSAGE,
    ...(to ? { to: `${to}, `, focus: "subject" as const } : {}),
    bodyHtml: initialBody(startingSignature(senders.data)),
  };
  return <ComposeForm key={to ?? "new"} start={start} />;
}

function ReplyCompose({
  mode,
  threadId,
  messageId,
}: {
  mode: ReplyMode;
  threadId: string;
  messageId: string;
}) {
  const thread = useThread(threadId);
  const senders = useSendAs();
  const account = useAccount();

  // Once loaded, the form stays even if a background refetch fails.
  if (!thread.data) {
    return thread.isError ? (
      <p role="alert" className="p-6 text-sm text-red-600">
        원본 메일을 불러오지 못했습니다.
      </p>
    ) : (
      LOADING
    );
  }
  // Waits for the sender list too: it decides which of my addresses to skip.
  if (senders.isPending || !account.data) return LOADING;
  const original = thread.data.messages.find((message) => message.id === messageId);
  if (!original) {
    return (
      <p role="alert" className="p-6 text-sm text-red-600">
        원본 메일을 찾을 수 없습니다.
      </p>
    );
  }

  const myAddresses = [
    account.data.email,
    ...(senders.data ?? []).map((sender) => sender.email),
  ];
  const reply = startReply(original, threadId, mode, myAddresses, sanitizeForEditor);
  const start: ComposeStart = {
    title: REPLY_MODES[mode],
    to: reply.to,
    cc: reply.cc,
    bcc: "",
    subject: reply.subject,
    from: reply.from,
    bodyHtml: initialBody(startingSignature(senders.data, reply.from), reply.quoteHtml),
    attachments: reply.attachments,
    threadId: reply.threadId,
    inReplyTo: reply.inReplyTo,
    references: reply.references,
    focus: mode === "forward" ? "to" : "body",
  };
  return <ComposeForm key={`${mode}:${messageId}`} start={start} />;
}
