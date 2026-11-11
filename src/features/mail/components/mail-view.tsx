"use client";

import { useSearchParams } from "next/navigation";
import { ThreadList } from "@/features/mail/components/thread-list";
import { ThreadView } from "@/features/mail/components/thread-view";
import { baseList, listHref, parseMailList } from "@/features/mail/routes";

export function MailView() {
  const params = useSearchParams();
  const list = parseMailList(params);
  const threadId = params.get("thread");

  return threadId ? (
    <ThreadView key={threadId} list={list} threadId={threadId} />
  ) : (
    // A new label or search starts afresh; a filter change keeps the list
    // mounted, so e.g. the date field keeps focus while it is being edited.
    <ThreadList key={listHref(baseList(list))} list={list} />
  );
}
