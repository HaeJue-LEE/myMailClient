"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  useAccounts,
  useLabels,
  useOpenComposeWindow,
  useSwitchAccount,
} from "@/features/mail/api";
import { AccountAvatar } from "@/features/mail/components/account-avatar";
import { UpdateNotice } from "@/features/mail/components/app-update";
import { Icon } from "@/features/mail/components/icon";
import type { Account } from "@/features/mail/mail-accounts";
import {
  CONTACTS_HREF,
  labelHref,
  listLabel,
  parseMailList,
  SERVER_SETTINGS_HREF,
} from "@/features/mail/routes";

/** Gmail's label ids; IMAP accounts map them to folders (and have no 'important'). */
const SYSTEM_LABELS: [id: string, name: string][] = [
  ["INBOX", "받은편지함"],
  ["STARRED", "별표"],
  ["IMPORTANT", "중요"],
  ["SENT", "보낸편지함"],
  ["DRAFT", "임시보관함"],
  ["SPAM", "스팸"],
  ["TRASH", "휴지통"],
];

/** POP3 has the inbox only; drafts and sent mail are kept on this computer. */
const POP3_LABELS = new Set(["INBOX", "SENT", "DRAFT"]);

export function Sidebar({ account }: { account: Account }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // No label is highlighted on the compose page or while showing search results.
  const activeLabel =
    pathname === "/mail" ? listLabel(parseMailList(searchParams)) : null;
  const { data: labels = [] } = useLabels();
  const { data: accounts = [] } = useAccounts();
  const switchAccount = useSwitchAccount();
  const openCompose = useOpenComposeWindow();
  const userLabels = labels.filter((label) => label.type === "user");
  const items = [
    ...SYSTEM_LABELS.filter(([id]) =>
      account.kind === "gmail"
        ? true
        : account.kind === "pop3"
          ? POP3_LABELS.has(id)
          : id !== "IMPORTANT",
    ).map(([id, name]) => ({ id, name })),
    ...userLabels,
  ];

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-foreground/10">
      <div className="px-2 pt-2">
        <div className="flex gap-1">
          <Link
            href="/mail/compose"
            className="block flex-1 rounded-md bg-foreground px-3 py-2 text-center text-sm font-medium text-background"
          >
            메일 쓰기
          </Link>
          <button
            type="button"
            onClick={() => openCompose.mutate("/mail/compose")}
            disabled={openCompose.isPending}
            title="새 창에서 메일 쓰기"
            aria-label="새 창에서 메일 쓰기"
            className="flex items-center rounded-md bg-foreground px-2.5 text-background disabled:opacity-50"
          >
            <Icon name="popOut" />
          </button>
        </div>
        {openCompose.isError && (
          <p role="alert" className="mt-1 px-1 text-xs text-red-600">
            새 창을 열지 못했습니다.
          </p>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={labelHref(item.id)}
                aria-current={item.id === activeLabel ? "page" : undefined}
                className="block truncate rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5 aria-[current=page]:bg-foreground/10 aria-[current=page]:font-medium"
              >
                {item.name}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-2 border-t border-foreground/10 pt-2">
          <Link
            href={CONTACTS_HREF}
            aria-current={pathname === CONTACTS_HREF ? "page" : undefined}
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5 aria-[current=page]:bg-foreground/10 aria-[current=page]:font-medium"
          >
            <Icon name="contacts" className="opacity-70" />
            연락처
          </Link>
          <Link
            href={SERVER_SETTINGS_HREF}
            aria-current={pathname === SERVER_SETTINGS_HREF ? "page" : undefined}
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5 aria-[current=page]:bg-foreground/10 aria-[current=page]:font-medium"
          >
            <Icon name="server" className="opacity-70" />
            메일 계정
          </Link>
        </div>
      </nav>
      <UpdateNotice />
      <div className="border-t border-foreground/10 p-2 text-xs">
        <p className="truncate px-1 pb-1.5 opacity-60" title={account.email}>
          {account.email}
        </p>
        <div role="group" aria-label="사용할 메일 계정" className="grid grid-cols-3 gap-1">
          {(accounts.length ? accounts : [account]).map((item) => (
            <AccountTile
              key={item.id}
              account={item}
              active={item.id === account.id}
              // The tile being switched to stays highlighted until the app reloads.
              pending={switchAccount.isPending && switchAccount.variables === item.id}
              disabled={switchAccount.isPending}
              onSelect={() => switchAccount.mutate(item.id)}
            />
          ))}
          <Link
            href={SERVER_SETTINGS_HREF}
            title="메일 계정 추가 · 관리"
            className="flex flex-col items-center gap-1 rounded-md px-1 py-1.5 hover:bg-foreground/5"
          >
            <span
              aria-hidden
              className="flex size-9 items-center justify-center rounded-full border border-dashed border-foreground/30 text-base opacity-70"
            >
              +
            </span>
            <span className="w-full truncate text-center text-[11px] opacity-70">추가</span>
          </Link>
        </div>
        {switchAccount.isError && (
          <p role="alert" className="mt-1 px-1 text-red-600">
            계정을 바꾸지 못했습니다.
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * One account as its picture (or first letter) with a short label; picking
 * it switches to it.
 */
function AccountTile({
  account,
  active,
  pending,
  disabled,
  onSelect,
}: {
  account: Account;
  active: boolean;
  pending: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const label = account.name || account.email.split("@")[0];
  const service =
    account.kind === "gmail"
      ? "Google"
      : account.kind === "zoho"
        ? `Zoho · ${account.email.split("@")[1]}`
        : account.email.split("@")[1];
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled || active}
      onClick={onSelect}
      title={`${account.email} (${service})${active ? " · 사용 중" : ""}`}
      className="flex flex-col items-center gap-1 rounded-md px-1 py-1.5 hover:bg-foreground/5 disabled:cursor-default aria-pressed:bg-foreground/10 aria-pressed:hover:bg-foreground/10"
    >
      <span className="relative">
        <AccountAvatar
          account={account}
          className={`size-9 text-sm ${
            active ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""
          } ${pending ? "animate-pulse" : ""}`}
        />
        {/* Which kind of account: Gmail API or IMAP. */}
        <span
          aria-hidden
          className="absolute -bottom-1 -right-1 rounded-full border border-background bg-foreground px-1 text-[9px] font-semibold leading-tight text-background"
        >
          {account.kind === "gmail" ? "G" : account.kind === "zoho" ? "Z" : "@"}
        </span>
      </span>
      <span className={`w-full truncate text-center text-[11px] ${active ? "font-medium" : "opacity-70"}`}>
        {label}
      </span>
    </button>
  );
}
