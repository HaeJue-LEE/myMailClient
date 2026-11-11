"use client";

import {
  type ThreadAction,
  useAccount,
  useThreadAction,
} from "@/features/mail/api";
import { ToolButton } from "@/features/mail/components/toolbar";
import { listLabel, type MailList } from "@/features/mail/routes";

/**
 * Delete / archive / read-state buttons for one or more threads, shared by the
 * list (for the selection) and the reader (for the open thread).
 */
export function ThreadActionButtons({
  list,
  threadIds,
  markAs,
  onDone,
}: {
  list: MailList;
  threadIds: string[];
  /** Which read-state toggle to offer. */
  markAs: "read" | "unread";
  onDone?: (action: ThreadAction) => void;
}) {
  const { mutate, isPending, isError } = useThreadAction();
  // Archiving removes a label; IMAP folders are not labels.
  const kind = useAccount().data?.kind;
  const canArchive = kind === "gmail";
  const disabled = isPending || threadIds.length === 0;
  // Search results span labels, so they get the label-neutral actions only.
  const labelId = listLabel(list);
  // POP3 mail is never deleted from the server here; only local copies can go.
  const canTrash = kind !== "pop3" || labelId === "SENT" || labelId === "DRAFT";
  const run = (action: ThreadAction) =>
    mutate(
      { action, threadIds, list },
      { onSuccess: () => onDone?.(action) },
    );

  return (
    <>
      {labelId === "TRASH" ? (
        <ToolButton
          icon="restore"
          label="복원"
          disabled={disabled}
          onClick={() => run("restore")}
        />
      ) : !canTrash ? null : (
        <ToolButton
          icon="trash"
          label="삭제"
          danger
          disabled={disabled}
          onClick={() => run("trash")}
        />
      )}
      {labelId === "INBOX" && canArchive && (
        <ToolButton
          icon="archive"
          label="보관"
          disabled={disabled}
          onClick={() => run("archive")}
        />
      )}
      {markAs === "read" ? (
        <ToolButton
          icon="markRead"
          label="읽음 표시"
          disabled={disabled}
          onClick={() => run("markRead")}
        />
      ) : (
        <ToolButton
          icon="markUnread"
          label="안 읽음 표시"
          disabled={disabled}
          onClick={() => run("markUnread")}
        />
      )}
      {isError && (
        <span role="alert" className="ml-2 text-xs text-red-600">
          작업에 실패했습니다.
        </span>
      )}
    </>
  );
}
