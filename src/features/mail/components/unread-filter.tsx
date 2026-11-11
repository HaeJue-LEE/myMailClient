"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/features/mail/components/icon";
import { listHref, type MailList } from "@/features/mail/routes";

/**
 * Shows only threads with unread mail. Gmail applies it (`is:unread`), so it
 * covers the whole mailbox, not just the pages loaded so far.
 */
export function UnreadFilter({ list }: { list: MailList }) {
  const router = useRouter();
  const on = Boolean(list.unread);
  const label = "안 읽은 메일만";

  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() =>
        // Other filters (e.g. the start date) stay as they are.
        router.replace(listHref({ ...list, unread: on ? undefined : true }))
      }
      title={on ? "모든 메일 보기" : "읽지 않은 메일만 보기"}
      aria-label={label}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-foreground/5 px-2.5 text-sm hover:bg-foreground/10 aria-pressed:bg-foreground aria-pressed:text-background"
    >
      <Icon name="filter" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}
