"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import {
  openComposeWindow,
  useMarkThreadRead,
  useOpenAttachment,
  useOpenThreadWindow,
  useSaveAttachment,
  useThread,
} from "@/features/mail/api";
import { formatBytes } from "@/features/mail/components/attachment-picker";
import { Icon } from "@/features/mail/components/icon";
import type { MailAttachment } from "@/features/mail/types";
import { MessageBody } from "@/features/mail/components/message-body";
import { ThreadActionButtons } from "@/features/mail/components/thread-actions";
import {
  ToolButton,
  ToolDivider,
  Toolbar,
} from "@/features/mail/components/toolbar";
import {
  draftHref,
  listHref,
  listLabel,
  type MailList,
  replyHref,
} from "@/features/mail/routes";

const REPLY_ACTIONS = [
  ["reply", "답장"],
  ["replyAll", "전체답장"],
  ["forward", "전달"],
] as const;

const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ThreadView({
  list,
  threadId,
  popup = false,
}: {
  /** The list this thread was opened from; "back" returns to it. */
  list: MailList;
  threadId: string;
  /**
   * Shown in a window of its own: "back" closes the window, and replies and
   * drafts open in the main window.
   */
  popup?: boolean;
}) {
  const router = useRouter();
  const query = useThread(threadId);
  const { mutate: markRead } = useMarkThreadRead();
  const openWindow = useOpenThreadWindow();
  const hasUnread =
    query.data?.messages.some((message) => message.unread) ?? false;
  // Decided once, on the first load, so a refetch after "mark unread" does not undo it.
  const readHandled = useRef(false);
  const loaded = query.data !== undefined;
  const backToList = () => (popup ? window.close() : router.push(listHref(list)));
  const subject = query.data?.subject;

  useEffect(() => {
    if (!loaded || readHandled.current) return;
    readHandled.current = true;
    if (hasUnread) markRead(threadId);
  }, [loaded, hasUnread, markRead, threadId]);

  useEffect(() => {
    // A pop-up window is told apart from the others by its subject.
    if (popup && subject) document.title = `${subject} - Mail Client`;
  }, [popup, subject]);

  return (
    <>
      <Toolbar>
        {popup ? (
          <ToolButton icon="close" label="닫기" onClick={backToList} />
        ) : (
          <ToolButton icon="back" label="목록" onClick={backToList} />
        )}
        <ToolDivider />
        <ThreadActionButtons
          list={list}
          threadIds={query.data ? [threadId] : []}
          markAs="unread"
          onDone={backToList}
        />
        <ToolDivider />
        <ToolButton
          icon="refresh"
          label="새로고침"
          spinning={query.isFetching}
          disabled={query.isFetching}
          onClick={() => query.refetch()}
        />
        {!popup && (
          <ToolButton
            icon="popOut"
            label="새 창으로 열기"
            disabled={openWindow.isPending}
            onClick={() =>
              openWindow.mutate({ threadId, labelId: listLabel(list) ?? undefined })
            }
          />
        )}
      </Toolbar>
      {openWindow.isError && (
        <p role="alert" className="px-6 pt-3 text-sm text-red-600">
          새 창을 열지 못했습니다. 다시 시도해 주세요.
        </p>
      )}
      <ThreadContent query={query} popup={popup} />
    </>
  );
}

/**
 * A link to a compose page. In a pop-up window the reply is written in a
 * pop-up window of its own too.
 */
function AppLink({
  href,
  popup,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string; popup: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!popup) return <Link href={href} {...props} />;
  return (
    <Link
      href={href}
      prefetch={false}
      {...props}
      aria-invalid={failed || undefined}
      onClick={(event) => {
        event.preventDefault();
        openComposeWindow(href).then(
          () => setFailed(false),
          () => setFailed(true),
        );
      }}
    />
  );
}

function ThreadContent({
  query,
  popup,
}: {
  query: ReturnType<typeof useThread>;
  popup: boolean;
}) {
  const { data: thread, isPending, isError } = query;

  if (isPending) return <p className="p-6 text-sm opacity-60">불러오는 중…</p>;
  if (isError) {
    return (
      <p role="alert" className="p-6 text-sm text-red-600">
        메일을 불러오지 못했습니다.
      </p>
    );
  }

  return (
    // As wide as the window, like the compose page: wide mail needs the room.
    <article className="w-full space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">{thread.subject}</h1>
      </header>
      {thread.messages.map((message) => (
        <section
          key={message.id}
          className="rounded-lg border border-foreground/10 p-4"
        >
          <div className="mb-3 flex items-start gap-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{message.from}</p>
              <p className="opacity-60">받는사람: {message.to}</p>
              {message.cc && <p className="opacity-60">참조: {message.cc}</p>}
              {message.date && (
                <p className="opacity-60">{dateFormat.format(message.date)}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-0.5">
              {message.isDraft ? (
                <AppLink
                  popup={popup}
                  href={draftHref(message.id)}
                  className="flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 text-background"
                >
                  <Icon name="edit" />
                  이어 쓰기
                </AppLink>
              ) : (
                REPLY_ACTIONS.map(([mode, label]) => (
                  <AppLink
                    popup={popup}
                    key={mode}
                    href={replyHref(mode, thread.id, message.id)}
                    title={popup ? `${label} (새 창에서 작성)` : label}
                    className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-foreground/10 aria-[invalid=true]:text-red-600"
                  >
                    <Icon name={mode} />
                    <span className="hidden lg:inline">{label}</span>
                  </AppLink>
                ))
              )}
            </div>
          </div>
          <MessageBody html={message.html} text={message.text} />
          {message.attachments.length > 0 && (
            <ReceivedAttachments
              messageId={message.id}
              attachments={message.attachments}
            />
          )}
        </section>
      ))}
    </article>
  );
}

function ReceivedAttachments({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: MailAttachment[];
}) {
  const save = useSaveAttachment();
  const open = useOpenAttachment();
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div className="mt-3 space-y-2 border-t border-foreground/10 pt-3">
      <ul className="flex flex-wrap gap-2" aria-label="첨부파일">
        {attachments.map((attachment) => (
          <li
            key={attachment.attachmentId}
            className="flex max-w-sm items-center gap-2 rounded-md bg-foreground/5 py-1 pl-2.5 pr-1 text-sm"
          >
            <Icon name="attach" className="opacity-60" />
            <span className="truncate" title={attachment.filename}>
              {attachment.filename}
            </span>
            <span className="shrink-0 text-xs opacity-60">
              {formatBytes(attachment.size)}
            </span>
            <button
              type="button"
              disabled={open.isPending}
              onClick={() => {
                setStatus(null);
                open.mutate(
                  {
                    messageId,
                    attachmentId: attachment.attachmentId,
                    filename: attachment.filename,
                  },
                  {
                    onSuccess: (result) => {
                      if (result.problem) {
                        setStatus(
                          `다운로드 폴더에 ${result.filename}(으)로 저장했지만 열지 못했습니다: ${result.problem}`,
                        );
                      } else if (result.opened) {
                        setStatus(`다운로드 폴더에 저장하고 열었습니다: ${result.filename}`);
                      }
                    },
                    onError: () =>
                      setStatus(`${attachment.filename}을(를) 열지 못했습니다.`),
                  },
                );
              }}
              title={`${attachment.filename} 보기 (다운로드 폴더에 저장한 뒤 엽니다)`}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-foreground/10 disabled:opacity-50"
            >
              <Icon name="eye" />
              보기
            </button>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => {
                setStatus(null);
                save.mutate(
                  {
                    messageId,
                    attachmentId: attachment.attachmentId,
                    filename: attachment.filename,
                  },
                  {
                    onSuccess: (result) =>
                      setStatus(result.saved ? `저장했습니다: ${result.filename}` : null),
                    onError: () =>
                      setStatus(`${attachment.filename}을(를) 저장하지 못했습니다.`),
                  },
                );
              }}
              title={`${attachment.filename} 저장`}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-foreground/10 disabled:opacity-50"
            >
              <Icon name="download" />
              저장
            </button>
          </li>
        ))}
      </ul>
      {status && (
        <p role="status" className="text-xs opacity-70">
          {status}
        </p>
      )}
    </div>
  );
}
