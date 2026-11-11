"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MailApiError, useOpenThreadWindow, useThreads } from "@/features/mail/api";
import { mailServerErrorText } from "@/features/mail/server-errors";
import { DateFilter } from "@/features/mail/components/date-filter";
import { Icon } from "@/features/mail/components/icon";
import { ThreadActionButtons } from "@/features/mail/components/thread-actions";
import { UnreadFilter } from "@/features/mail/components/unread-filter";
import {
  ToolButton,
  ToolDivider,
  Toolbar,
} from "@/features/mail/components/toolbar";
import { listLabel, type MailList, threadHref } from "@/features/mail/routes";
import { isGmailQuery, matchesFilter } from "@/features/mail/search";
import type { ThreadSummary } from "@/features/mail/types";

const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * With a start date the list loads every page back to that date by itself.
 * Each thread costs a Gmail request, so the automatic part stops here and
 * "더 보기" takes over.
 */
const AUTO_LOAD_LIMIT = 500;

export function ThreadList({ list }: { list: MailList }) {
  const query = useThreads(list);
  const loaded = query.data?.pages.flatMap((page) => page.threads) ?? [];
  const autoLoading =
    Boolean(list.since) &&
    loaded.length < AUTO_LOAD_LIMIT &&
    query.hasNextPage &&
    // A failed page is not retried in a loop; "더 보기" shows up instead.
    !query.isFetchNextPageError;
  const { isFetching, fetchNextPage } = query;

  useEffect(() => {
    // Wait out any fetch in flight, as a refetch and a next page must not overlap.
    if (autoLoading && !isFetching) void fetchNextPage();
  }, [autoLoading, isFetching, fetchNextPage]);
  // Text being typed in the search field, matched locally by substring.
  const [filter, setFilter] = useState("");
  const threads = filter
    ? loaded.filter((thread) => matchesFilter(thread, filter))
    : loaded;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  // Only visible threads count as selected: actions never touch rows hidden by
  // the filter, nor ids that left the list (deleted, archived, refreshed away).
  const selected = threads.filter((thread) => checked.has(thread.id));
  const selectedIds = selected.map((thread) => thread.id);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const toggleAll = () =>
    setChecked(
      selected.length === threads.length
        ? new Set()
        : new Set(threads.map((thread) => thread.id)),
    );
  const unreadIds = threads
    .filter((thread) => thread.unread)
    .map((thread) => thread.id);
  // Replaces the selection, so read threads picked earlier are dropped.
  const selectUnread = () => setChecked(new Set(unreadIds));

  return (
    <div>
      <Toolbar
        onFilterChange={setFilter}
        filters={
          <>
            <UnreadFilter list={list} />
            <DateFilter list={list} />
          </>
        }
      >
        <SelectAll
          total={threads.length}
          selected={selected.length}
          onToggle={toggleAll}
        />
        <ToolButton
          icon="unreadDot"
          label="안 읽은 메일 선택"
          disabled={unreadIds.length === 0}
          onClick={selectUnread}
        />
        <ToolButton
          icon="refresh"
          label="새로고침"
          spinning={query.isFetching && !query.isFetchingNextPage}
          disabled={query.isFetching}
          onClick={() => query.refetch()}
        />
        {selected.length > 0 ? (
          <>
            <ToolDivider />
            <ThreadActionButtons
              list={list}
              threadIds={selectedIds}
              markAs={selected.some((thread) => thread.unread) ? "read" : "unread"}
              onDone={() => setChecked(new Set())}
            />
            <span className="ml-auto shrink-0 text-xs opacity-60">
              {selected.length}개 선택됨
            </span>
          </>
        ) : filter ? (
          <span
            className="ml-auto max-w-56 truncate text-xs opacity-60"
            title="불러온 메일에서만 거른 결과입니다. Enter를 누르면 전체 메일을 검색합니다."
          >
            불러온 {loaded.length}개 중 {threads.length}개 일치
          </span>
        ) : (
          <ListStatus
            list={list}
            count={loaded.length}
            loading={autoLoading}
          />
        )}
      </Toolbar>
      <ThreadRows
        query={query}
        threads={threads}
        autoLoading={autoLoading}
        filter={filter}
        list={list}
        checked={checked}
        onToggle={toggle}
      />
    </div>
  );
}

function loadErrorText(error: unknown) {
  return error instanceof MailApiError && error.code === "rate_limited"
    ? "Gmail 요청 한도(분당)를 넘어 더 불러오지 못했습니다. 1분쯤 뒤에 다시 시도해 주세요."
    : (mailServerErrorText(error) ?? "메일을 불러오지 못했습니다.");
}

function RetryButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
    >
      {busy ? "불러오는 중…" : "다시 시도"}
    </button>
  );
}

function ListStatus({
  list,
  count,
  loading,
}: {
  list: MailList;
  count: number;
  loading: boolean;
}) {
  const parts = [
    "search" in list && (list.caption ?? `‘${list.search}’ 검색 결과`),
    list.since && `${list.since}부터 ${count}개${loading ? " 불러오는 중…" : ""}`,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <span className="ml-auto max-w-72 truncate text-xs opacity-60">
      {parts.join(" · ")}
    </span>
  );
}

function SelectAll({
  total,
  selected,
  onToggle,
}: {
  total: number;
  selected: number;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const all = total > 0 && selected === total;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = selected > 0 && !all;
  }, [selected, all]);

  return (
    <label className="flex items-center rounded-md px-2.5 py-1.5 hover:bg-foreground/5">
      <input
        ref={ref}
        type="checkbox"
        checked={all}
        disabled={total === 0}
        onChange={onToggle}
        aria-label="전체 선택"
        className="size-4"
      />
    </label>
  );
}

function ThreadRows({
  query,
  threads,
  autoLoading,
  filter,
  list,
  checked,
  onToggle,
}: {
  query: ReturnType<typeof useThreads>;
  threads: ThreadSummary[];
  /** Older pages are being fetched automatically (start date set). */
  autoLoading: boolean;
  filter: string;
  list: MailList;
  checked: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const openWindow = useOpenThreadWindow();
  if (query.isPending) {
    return <p className="p-6 text-sm opacity-60">불러오는 중…</p>;
  }
  // With pages already shown, a failed refresh or next page keeps them on screen.
  if (query.isError && !query.data) {
    return (
      <div role="alert" className="space-y-2 p-6 text-sm text-red-600">
        <p>{loadErrorText(query.error)}</p>
        <RetryButton
          busy={query.isFetching}
          onClick={() => query.refetch()}
        />
      </div>
    );
  }
  if (threads.length === 0 && filter) {
    return (
      <p className="p-6 text-sm opacity-60">
        불러온 메일 중 ‘{filter}’이(가) 들어간 메일이 없습니다. Enter를 누르면
        전체 메일에서 검색합니다.
      </p>
    );
  }
  if (threads.length === 0) {
    return (
      <div className="space-y-1 p-6 text-sm opacity-60">
        <p>
          {"search" in list
            ? "검색 결과가 없습니다."
            : list.unread
              ? "읽지 않은 메일이 없습니다."
              : "메일이 없습니다."}
        </p>
        {list.since && (
          <p>
            {list.since}부터 받은 메일만 보고 있습니다. 날짜 조건을 지우면 더
            찾아볼 수 있습니다.
          </p>
        )}
        {"search" in list && !isGmailQuery(list.search) && (
          <p>
            Gmail 검색은 단어 전체가 일치해야 찾습니다. (예: insta → instagram)
            검색창에 입력하면 나오는 보낸 사람 제안을 이용해 보세요.
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <ul className="divide-y divide-foreground/10">
        {threads.map((thread) => {
          const isChecked = checked.has(thread.id);
          return (
            <li
              key={thread.id}
              className={`group flex items-center hover:bg-foreground/5 ${
                isChecked ? "bg-foreground/5" : ""
              }`}
            >
              <label className="flex items-center self-stretch py-2.5 pl-5 pr-1">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(thread.id)}
                  aria-label={`${thread.subject} 선택`}
                  className="size-4"
                />
              </label>
              <Link
                href={threadHref(list, thread.id)}
                className={`flex min-w-0 flex-1 items-baseline gap-4 py-2.5 pl-3 pr-4 text-sm ${
                  thread.unread ? "font-semibold" : "opacity-80"
                }`}
              >
                <span className="w-40 shrink-0 truncate">
                  {thread.from}
                  {thread.messageCount > 1 && (
                    <span className="ml-1 text-xs opacity-60">
                      {thread.messageCount}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {thread.subject}
                  <span className="ml-2 font-normal opacity-60">
                    {thread.snippet}
                  </span>
                </span>
                {/* A fixed slot keeps the dates lined up whether or not it shows. */}
                <span className="flex w-4 shrink-0 self-center justify-center">
                  {thread.hasAttachment && (
                    <span title="첨부파일 있음" className="opacity-60">
                      <Icon name="attach" className="size-3.5!" />
                      <span className="sr-only">첨부파일 있음</span>
                    </span>
                  )}
                </span>
                {thread.date && (
                  <time className="shrink-0 text-xs font-normal opacity-60">
                    {dateFormat.format(thread.date)}
                  </time>
                )}
              </Link>
              {/* Shown on hover or keyboard focus, so the row stays uncluttered. */}
              <button
                type="button"
                onClick={() =>
                  openWindow.mutate({ threadId: thread.id, labelId: listLabel(list) ?? undefined })
                }
                title="새 창으로 열기"
                aria-label={`${thread.subject} 새 창으로 열기`}
                className="mr-2 shrink-0 rounded p-1.5 opacity-0 hover:bg-foreground/10 focus-visible:opacity-100 group-hover:opacity-70 group-hover:hover:opacity-100"
              >
                <Icon name="popOut" />
              </button>
            </li>
          );
        })}
      </ul>
      {query.isFetchNextPageError || query.isRefetchError ? (
        <div role="alert" className="space-y-2 p-4 text-center text-sm">
          <p className="text-red-600">
            {loadErrorText(query.error)} 지금까지 {threads.length}개를
            불러왔습니다.
          </p>
          <RetryButton
            busy={query.isFetching}
            onClick={() =>
              query.isFetchNextPageError
                ? query.fetchNextPage()
                : query.refetch()
            }
          />
        </div>
      ) : autoLoading ? (
        <p className="p-4 text-center text-sm opacity-60">
          {list.since}까지 예전 메일을 불러오는 중… ({threads.length}개)
        </p>
      ) : (
        query.hasNextPage && (
          <div className="space-y-2 p-4 text-center">
            {list.since && (
              <p className="text-xs opacity-60">
                메일이 많아 {AUTO_LOAD_LIMIT}개까지만 자동으로 불러왔습니다.
              </p>
            )}
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
              className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {query.isFetchingNextPage ? "불러오는 중…" : "더 보기"}
            </button>
          </div>
        )
      )}
    </>
  );
}
