"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, type KeyboardEvent, useId, useRef, useState } from "react";
import { useLoadedThreads } from "@/features/mail/api";
import { Icon } from "@/features/mail/components/icon";
import {
  DEFAULT_LABEL,
  type ListFilters,
  listHref,
  MAX_SEARCH_LENGTH,
  parseMailList,
} from "@/features/mail/routes";
import {
  isGmailQuery,
  senderQuery,
  suggestSenders,
} from "@/features/mail/search";

/**
 * Typing filters the visible list (`onFilterChange`) and suggests senders;
 * Enter runs a Gmail search; picking a sender searches `from:<address>`.
 */
export function SearchBar({
  onFilterChange,
}: {
  /** Receives the in-progress text, or "" when there is nothing to filter by. */
  onFilterChange?: (filter: string) => void;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const list = pathname === "/mail" ? parseMailList(params) : null;
  const current = list && "search" in list ? list.search : "";
  const filters: ListFilters = { since: list?.since, unread: list?.unread };

  // Keyed by the current search so the field follows navigation (e.g. picking a label clears it).
  return (
    <SearchForm
      key={current}
      current={current}
      filters={filters}
      onFilterChange={onFilterChange}
    />
  );
}

function SearchForm({
  current,
  filters,
  onFilterChange,
}: {
  current: string;
  /** Filters already applied (date, unread only); new searches keep them. */
  filters: ListFilters;
  onFilterChange?: (filter: string) => void;
}) {
  const router = useRouter();
  const loadedThreads = useLoadedThreads();
  const input = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [text, setText] = useState(current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const typed = text.trim();
  // The committed search is already on screen; only new text filters or suggests.
  const editing = typed !== current && !isGmailQuery(typed);
  const suggestions =
    open && editing ? suggestSenders(loadedThreads(), typed) : [];
  const expanded = suggestions.length > 0;

  const change = (value: string) => {
    setText(value);
    setOpen(true);
    setActive(-1);
    const next = value.trim();
    onFilterChange?.(next !== current && !isGmailQuery(next) ? next : "");
  };
  const go = (search: string) => {
    setOpen(false);
    router.push(
      listHref(
        search
          ? { search, ...filters }
          : { label: DEFAULT_LABEL, ...filters },
      ),
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const chosen = suggestions[active];
    go(chosen ? senderQuery(chosen.address) : typed);
  };
  const clear = () => {
    change("");
    setOpen(false);
    if (current) go("");
    input.current?.focus();
  };
  const keyDown = (event: KeyboardEvent) => {
    const count = suggestions.length;
    if (event.key === "ArrowDown" && count) {
      event.preventDefault();
      setActive((index) => (index + 1) % count);
    } else if (event.key === "ArrowUp" && count) {
      event.preventDefault();
      setActive((index) => (index <= 0 ? count - 1 : index - 1));
    } else if (event.key === "Escape") {
      if (expanded) setOpen(false);
      else clear();
    }
  };

  return (
    // Shrinks before the toolbar buttons do when the window gets narrow.
    <form
      role="search"
      onSubmit={submit}
      className="relative flex h-8 w-72 min-w-40 shrink items-center gap-2 rounded-md bg-foreground/5 px-2.5 focus-within:bg-background focus-within:ring-2 focus-within:ring-foreground/20"
    >
      <Icon name="search" className="opacity-60" />
      <input
        ref={input}
        type="search"
        name="q"
        value={text}
        onChange={(event) => change(event.target.value)}
        onKeyDown={keyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        maxLength={MAX_SEARCH_LENGTH}
        placeholder="메일 검색"
        title="입력하는 동안 불러온 목록을 거르고, Enter로 전체 메일을 검색합니다. Gmail 검색 문법 사용 가능 (예: from:홍길동 has:attachment)"
        aria-label="메일 검색"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-activedescendant={
          expanded && active >= 0 ? `${listboxId}-${active}` : undefined
        }
        autoComplete="off"
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          onClick={clear}
          title="검색 지우기"
          aria-label="검색 지우기"
          className="rounded p-0.5 opacity-60 hover:bg-foreground/10 hover:opacity-100"
        >
          <Icon name="close" />
        </button>
      )}
      {expanded && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-foreground/10 bg-background shadow-lg">
          <p className="px-3 pb-1 pt-2 text-xs opacity-60">보낸 사람</p>
          <ul id={listboxId} role="listbox" aria-label="보낸 사람 제안">
            {suggestions.map((sender, index) => (
              <li
                key={sender.address}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === active}
                // Keep focus in the field so blur does not close the list before the click.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(senderQuery(sender.address))}
                className="cursor-pointer px-3 py-1.5 aria-selected:bg-foreground/5"
              >
                <span className="block truncate text-sm">{sender.name}</span>
                <span className="block truncate text-xs opacity-60">
                  {sender.address}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-foreground/10 px-3 py-1.5 text-xs opacity-60">
            Enter: 전체 메일에서 ‘{typed}’ 검색
          </p>
        </div>
      )}
    </form>
  );
}
