"use client";

import Link from "next/link";
import { useState } from "react";
import {
  MailApiError,
  useAccounts,
  useContacts,
  useDeleteContact,
  useLogin,
  useSetContactsHidden,
} from "@/features/mail/api";
import {
  ContactChangeError,
  ContactForm,
  type ContactDraft,
} from "@/features/mail/components/contact-form";
import { Icon } from "@/features/mail/components/icon";
import { CONTACT_SOURCE_LABEL } from "@/features/mail/contacts";
import { composeHref, contactMailHref } from "@/features/mail/routes";
import type { Contact } from "@/features/mail/types";

type SavedContact = Contact & { resourceName: string };

const isSaved = (contact: Contact): contact is SavedContact =>
  contact.source === "google" && Boolean(contact.resourceName);

/** The open add/edit form: what it starts with, and the contact being edited if any. */
type FormState = { initial: ContactDraft; editing?: SavedContact };

export function ContactsView() {
  const { contacts, visibleContacts, hiddenContacts, google } = useContacts();
  const setHidden = useSetContactsHidden();
  // Contacts are one list for every account. Only Google has an address book
  // to save to, so saving needs a Google account, whichever one is in use.
  const canSave = useAccounts().data?.some((account) => account.kind === "gmail") ?? false;
  const [filter, setFilter] = useState("");
  // false: the default list; true: only the contacts the user hid.
  const [showHidden, setShowHidden] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [form, setForm] = useState<FormState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const openForm = (next: FormState) => {
    setMessage(null);
    setForm(next);
  };
  const switchView = (hidden: boolean) => {
    setShowHidden(hidden);
    setChecked(new Set());
    setMessage(null);
  };
  const changeHidden = (emails: string[], hidden: boolean) => {
    setMessage(null);
    setHidden.mutate(
      { emails, hidden },
      {
        onSuccess: () => {
          setChecked(new Set());
          setMessage(
            hidden
              ? `${emails.length}명을 감췄습니다. 위쪽의 '감춘 연락처'에서 다시 볼 수 있습니다.`
              : `${emails.length}명을 다시 목록에 보이게 했습니다.`,
          );
        },
      },
    );
  };
  const savedContacts = (google.data ?? []).filter(isSaved);
  // Every address of each saved person: deleting removes them all, and a
  // mail search covers them all.
  const addressesByPerson = Map.groupBy(
    savedContacts,
    (contact) => contact.resourceName,
  );
  const addressesOf = (contact: Contact) =>
    (isSaved(contact) &&
      addressesByPerson.get(contact.resourceName)?.map((c) => c.email)) || [
      contact.email,
    ];
  const addressCount = new Map(
    [...addressesByPerson].map(([person, list]) => [person, list.length]),
  );
  const listed = showHidden ? hiddenContacts : visibleContacts;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? listed.filter(
        (contact) =>
          contact.name.toLowerCase().includes(needle) ||
          contact.email.includes(needle),
      )
    : listed;
  // Only rows on screen count, so a search cannot act on rows it filtered out.
  const selected = shown.filter((contact) => checked.has(contact.email));
  const toggle = (email: string) =>
    setChecked((previous) => {
      const next = new Set(previous);
      if (!next.delete(email)) next.add(email);
      return next;
    });

  return (
    <div>
      <div className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-foreground/10 bg-background px-4">
        <h1 className="text-sm font-semibold">
          {showHidden ? "감춘 연락처" : "연락처"}
        </h1>
        <span className="text-xs opacity-60">
          {needle ? `${listed.length}명 중 ${shown.length}명` : `${listed.length}명`}
        </span>
        {canSave && (
        <button
          type="button"
          onClick={() => google.refetch()}
          disabled={google.isFetching}
          title="Google 주소록 다시 불러오기"
          aria-label="Google 주소록 다시 불러오기"
          className="rounded-md p-1.5 hover:bg-foreground/5 disabled:opacity-40"
        >
          <Icon name="refresh" className={google.isFetching ? "animate-spin" : undefined} />
        </button>
        )}
        <button
          type="button"
          aria-pressed={showHidden}
          onClick={() => switchView(!showHidden)}
          title={showHidden ? "기본 목록으로 돌아가기" : "감춘 연락처만 보기"}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md bg-foreground/5 px-2.5 py-1.5 text-sm hover:bg-foreground/10 aria-pressed:bg-foreground aria-pressed:text-background"
        >
          <Icon name="eyeOff" />
          감춘 연락처 ({hiddenContacts.length})
        </button>
        {canSave && (
        <button
          type="button"
          onClick={() => openForm({ initial: { name: "", email: "" } })}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-sm font-medium text-background"
        >
          <Icon name="personAdd" />
          연락처 추가
        </button>
        )}
        <label className="flex h-8 w-72 min-w-40 items-center gap-2 rounded-md bg-foreground/5 px-2.5 focus-within:ring-2 focus-within:ring-foreground/20">
          <Icon name="search" className="opacity-60" />
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="이름 또는 주소로 찾기"
            aria-label="연락처 찾기"
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      </div>

      <GoogleContactsNotice google={google} />

      {form && (
        <ContactForm
          // Another row's button starts a fresh form.
          key={`${form.editing ? "edit" : "add"}:${form.initial.email}`}
          initial={form.initial}
          editing={form.editing}
          otherAddresses={
            form.editing
              ? (addressCount.get(form.editing.resourceName) ?? 1) - 1
              : 0
          }
          savedContacts={savedContacts}
          onSaved={(text) => {
            setForm(null);
            setMessage(text);
          }}
          onCancel={() => setForm(null)}
        />
      )}
      {message && (
        <p role="status" className="mx-4 mt-4 rounded-md bg-foreground/5 px-4 py-2 text-sm">
          {message}
        </p>
      )}
      {setHidden.isError && (
        <p role="alert" className="mx-4 mt-4 text-sm text-red-600">
          감추기 설정을 저장하지 못했습니다. 다시 시도해 주세요.
        </p>
      )}

      {showHidden && (
        <p className="mx-4 mt-4 text-xs opacity-70">
          감춘 연락처는 모든 계정의 기본 목록과 메일 쓰기 자동완성에 나오지
          않습니다. 이 컴퓨터에만 저장되며 Google 주소록은 바뀌지 않습니다.
        </p>
      )}

      {google.isPending && contacts.length === 0 ? (
        <p className="p-6 text-sm opacity-60">불러오는 중…</p>
      ) : shown.length === 0 ? (
        <p className="p-6 text-sm opacity-60">
          {needle
            ? "일치하는 연락처가 없습니다."
            : showHidden
              ? "감춘 연락처가 없습니다."
              : "연락처가 없습니다."}
        </p>
      ) : (
        <>
        <SelectionBar
          total={shown.length}
          selected={selected.length}
          showHidden={showHidden}
          busy={setHidden.isPending}
          onToggleAll={() =>
            setChecked(
              selected.length === shown.length
                ? new Set()
                : new Set(shown.map((contact) => contact.email)),
            )
          }
          onApply={() =>
            changeHidden(
              selected.map((contact) => contact.email),
              !showHidden,
            )
          }
        />
        <ul className="divide-y divide-foreground/10">
          {shown.map((contact) => {
            const initial = { name: contact.name, email: contact.email };
            return (
              <ContactRow
                key={contact.email}
                contact={contact}
                checked={checked.has(contact.email)}
                onCheck={() => toggle(contact.email)}
                isHidden={showHidden}
                busy={setHidden.isPending}
                onHiddenChange={() => changeHidden([contact.email], !showHidden)}
                otherAddresses={
                  isSaved(contact)
                    ? (addressCount.get(contact.resourceName) ?? 1) - 1
                    : 0
                }
                mailHref={contactMailHref(
                  contact.name || contact.email,
                  addressesOf(contact),
                )}
                onAdd={canSave ? () => openForm({ initial }) : undefined}
                onEdit={() =>
                  isSaved(contact) && openForm({ initial, editing: contact })
                }
                onDeleted={(text) => {
                  setForm(null);
                  setMessage(text);
                }}
              />
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
}

/** Select-all for the rows on screen, and the bulk hide/show action. */
function SelectionBar({
  total,
  selected,
  showHidden,
  busy,
  onToggleAll,
  onApply,
}: {
  total: number;
  selected: number;
  showHidden: boolean;
  busy: boolean;
  onToggleAll: () => void;
  onApply: () => void;
}) {
  const all = selected === total;
  return (
    <div className="flex h-11 items-center gap-3 border-b border-foreground/10 px-4 text-sm">
      <input
        type="checkbox"
        checked={all}
        ref={(input) => {
          if (input) input.indeterminate = selected > 0 && !all;
        }}
        onChange={onToggleAll}
        aria-label="보이는 연락처 전체 선택"
        className="size-4"
      />
      {selected > 0 ? (
        <>
          <span className="opacity-70">{selected}명 선택됨</span>
          <button
            type="button"
            disabled={busy}
            onClick={onApply}
            className={`${ROW_BUTTON} bg-foreground/5 disabled:opacity-50`}
          >
            <Icon name={showHidden ? "eye" : "eyeOff"} />
            {showHidden ? "선택한 연락처 다시 보이기" : "선택한 연락처 감추기"}
          </button>
        </>
      ) : (
        <span className="opacity-50">
          {showHidden
            ? "선택해서 다시 보이게 할 수 있습니다"
            : "선택해서 한꺼번에 감출 수 있습니다"}
        </span>
      )}
    </div>
  );
}

const ROW_BUTTON =
  "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm hover:bg-foreground/10";

function ContactRow({
  contact,
  checked,
  onCheck,
  isHidden,
  busy,
  onHiddenChange,
  otherAddresses,
  mailHref,
  onAdd,
  onEdit,
  onDeleted,
}: {
  contact: Contact;
  checked: boolean;
  onCheck: () => void;
  /** Shown in the hidden list; the button then brings it back. */
  isHidden: boolean;
  busy: boolean;
  onHiddenChange: () => void;
  /** Further addresses of the same saved person, deleted along with this one. */
  otherAddresses: number;
  /** Search results for mail exchanged with this person. */
  mailHref: string;
  /** Opens the add form pre-filled; offered for contacts not yet saved. */
  onAdd?: () => void;
  onEdit: () => void;
  onDeleted: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const label = contact.name || contact.email;

  if (confirming && isSaved(contact)) {
    return (
      <DeleteConfirm
        contact={contact}
        otherAddresses={otherAddresses}
        onDeleted={() => onDeleted(`${label} 연락처를 Google 주소록에서 삭제했습니다.`)}
        onCancel={() => setConfirming(false)}
      />
    );
  }

  const initial = label.charAt(0).toUpperCase();
  return (
    <li
      className={`flex items-center gap-3 px-4 py-2.5 hover:bg-foreground/5 ${
        checked ? "bg-foreground/5" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onCheck}
        aria-label={`${label} 선택`}
        className="size-4 shrink-0"
      />
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-sm font-medium"
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {contact.name || contact.email}
        </p>
        {contact.name && (
          <p className="truncate text-xs opacity-60">{contact.email}</p>
        )}
      </div>
      {contact.accounts.length > 0 && (
        <span
          className="flex min-w-0 max-w-56 shrink flex-wrap justify-end gap-1"
          title={`계정: ${contact.accounts.join(", ")}`}
        >
          {contact.accounts.map((account) => (
            <span
              key={account}
              className="truncate rounded bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-700 dark:text-sky-300"
            >
              {account}
            </span>
          ))}
        </span>
      )}
      <span className="shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-xs opacity-70">
        {CONTACT_SOURCE_LABEL[contact.source]}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onHiddenChange}
        title={isHidden ? `${label} 다시 보이기` : `${label} 목록에서 감추기`}
        className={`${ROW_BUTTON} disabled:opacity-50`}
      >
        <Icon name={isHidden ? "eye" : "eyeOff"} />
        <span className="hidden lg:inline">
          {isHidden ? "다시 보이기" : "감추기"}
        </span>
      </button>
      {isSaved(contact) ? (
        <>
          <button
            type="button"
            onClick={onEdit}
            title={`${label} 연락처 수정`}
            className={ROW_BUTTON}
          >
            <Icon name="edit" />
            <span className="hidden lg:inline">수정</span>
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title={`${label} 연락처 삭제`}
            className={`${ROW_BUTTON} text-red-600`}
          >
            <Icon name="trash" />
            <span className="hidden lg:inline">삭제</span>
          </button>
        </>
      ) : onAdd && (
        // "Other contacts" and recent senders cannot be edited; saving them is the way in.
        <button
          type="button"
          onClick={onAdd}
          title={`${label}을(를) 주소록에 추가`}
          className={ROW_BUTTON}
        >
          <Icon name="personAdd" />
          <span className="hidden lg:inline">주소록에 추가</span>
        </button>
      )}
      <Link
        href={mailHref}
        title={`${label}님과 주고받은 메일 찾기`}
        className={ROW_BUTTON}
      >
        <Icon name="search" />
        <span className="hidden lg:inline">주고받은 메일</span>
      </Link>
      <Link
        href={composeHref(contact.email)}
        title={`${contact.email}에게 메일 쓰기`}
        className={ROW_BUTTON}
      >
        <Icon name="compose" />
        <span className="hidden lg:inline">메일 쓰기</span>
      </Link>
    </li>
  );
}

/** Inline confirmation in place of the row; deleting cannot be undone from the app. */
function DeleteConfirm({
  contact,
  otherAddresses,
  onDeleted,
  onCancel,
}: {
  contact: SavedContact;
  otherAddresses: number;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const remove = useDeleteContact();
  return (
    <li
      role="alertdialog"
      aria-label="연락처 삭제 확인"
      className="space-y-2 bg-red-500/5 px-4 py-3 text-sm"
    >
      <p>
        <b>{contact.name || contact.email}</b> 연락처를 Google 주소록에서
        삭제할까요? 이 앱에서는 되돌릴 수 없습니다.
        {otherAddresses > 0 &&
          ` 이 사람의 다른 주소 ${otherAddresses}개도 함께 삭제됩니다.`}
      </p>
      {remove.error && <ContactChangeError error={remove.error} action="삭제" />}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { resourceName: contact.resourceName },
              { onSuccess: onDeleted },
            )
          }
          className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {remove.isPending ? "삭제하는 중…" : "삭제"}
        </button>
        {/* Focus starts on the safe choice: a stray Enter must not delete. */}
        <button
          type="button"
          autoFocus
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
        >
          취소
        </button>
      </div>
    </li>
  );
}

/** Explains why Google contacts are missing and offers the fix. */
function GoogleContactsNotice({
  google,
}: {
  google: ReturnType<typeof useContacts>["google"];
}) {
  const login = useLogin();
  if (!google.isError) return null;
  const code = google.error instanceof MailApiError ? google.error.code : null;

  return (
    <div
      role="alert"
      className="m-4 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
    >
      {code === "missing_scope" ? (
        <>
          <p>
            Google 주소록을 읽을 권한이 없습니다. 연락처 기능이 추가되기 전에
            로그인했기 때문입니다. 다시 로그인하고 연락처 권한을 허용해 주세요.
          </p>
          <button
            type="button"
            onClick={() => login.mutate()}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
          >
            {login.isPending ? "브라우저에서 로그인을 완료해 주세요…" : "다시 로그인"}
          </button>
        </>
      ) : code === "api_disabled" ? (
        <p>
          Google Cloud Console에서 <b>People API</b>를 사용 설정해야 Google
          주소록을 불러올 수 있습니다. (API 및 서비스 → 라이브러리 → People API
          → 사용) 설정 후 몇 분 뒤에 새로고침 버튼을 눌러 주세요.
        </p>
      ) : (
        <>
          <p>Google 주소록을 불러오지 못했습니다.</p>
          <button
            type="button"
            onClick={() => google.refetch()}
            className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm"
          >
            다시 시도
          </button>
        </>
      )}
      <p className="text-xs opacity-70">
        그동안은 앱에서 불러온 메일의 보낸 사람만 연락처에 표시됩니다.
      </p>
    </div>
  );
}
