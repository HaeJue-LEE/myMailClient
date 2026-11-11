"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/features/mail/components/icon";
import {
  isIsoDate,
  listHref,
  type MailList,
  toIsoDate,
} from "@/features/mail/routes";

/** Typing a date changes the value per segment; wait for the user to pause. */
const COMMIT_DELAY_MS = 500;

/** "Received on or after" date for the list, kept in the URL as `since`. */
export function DateFilter({ list }: { list: MailList }) {
  const router = useRouter();
  const applied = list.since ?? "";
  const [value, setValue] = useState(applied);
  // Follow the URL when it changes elsewhere (e.g. picking a label clears the date).
  const [seen, setSeen] = useState(applied);
  if (seen !== applied) {
    setSeen(applied);
    setValue(applied);
  }

  // Other filters (e.g. unread only) stay as they are.
  const hrefFor = (since: string) =>
    listHref({ ...list, since: since || undefined });
  const target = hrefFor(value);

  useEffect(() => {
    // Skip half-typed dates; an empty value means the field was cleared.
    if (value === applied || (value && !isIsoDate(value))) return;
    const timer = setTimeout(() => router.replace(target), COMMIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value, applied, target, router]);

  const clear = () => {
    setValue("");
    router.replace(hrefFor(""));
  };

  return (
    <div
      title="이 날짜부터 받은 메일만 봅니다"
      className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-foreground/5 pl-2 pr-1.5 text-sm focus-within:ring-2 focus-within:ring-foreground/20"
    >
      <input
        type="date"
        value={value}
        max={toIsoDate(new Date())}
        onChange={(event) => setValue(event.target.value)}
        aria-label="시작 날짜"
        className="bg-transparent text-sm outline-none"
      />
      <span className="text-xs opacity-60">부터</span>
      {applied && (
        <button
          type="button"
          onClick={clear}
          title="날짜 조건 지우기"
          aria-label="날짜 조건 지우기"
          className="rounded p-0.5 opacity-60 hover:bg-foreground/10 hover:opacity-100"
        >
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
