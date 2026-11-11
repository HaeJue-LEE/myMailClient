"use client";

import { type FormEvent, useState } from "react";
import {
  MailApiError,
  useCreateContact,
  useLogin,
  useUpdateContact,
} from "@/features/mail/api";
import { MAX_CONTACT_NAME_LENGTH } from "@/features/mail/contacts";
import { isEmail } from "@/features/mail/email";
import type { Contact } from "@/features/mail/types";

const INPUT_CLASS =
  "w-full rounded-md border border-foreground/20 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-foreground/60 aria-[invalid=true]:border-red-600";

export type ContactDraft = { name: string; email: string };

/**
 * Adds a contact to Google Contacts, or edits a saved one (`editing`).
 * `initial` pre-fills the fields, e.g. from a recent sender.
 */
export function ContactForm({
  initial,
  editing,
  otherAddresses = 0,
  savedContacts,
  onSaved,
  onCancel,
}: {
  initial: ContactDraft;
  /** The saved contact being changed; absent when adding. */
  editing?: Contact & { resourceName: string };
  /** Further addresses of the person being edited; the name is shared with them. */
  otherAddresses?: number;
  /** Contacts already in Google Contacts, to catch duplicates before saving. */
  savedContacts: readonly Contact[];
  /** Receives a sentence describing what was saved. */
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const create = useCreateContact();
  const update = useUpdateContact();
  const mutation = editing ? update : create;
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [problem, setProblem] = useState<string | null>(null);
  const title = editing ? "연락처 수정" : "Google 주소록에 추가";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    const trimmedName = name.trim();
    if (!isEmail(address)) {
      setProblem("올바른 이메일 주소를 입력해 주세요.");
      return;
    }
    if (
      savedContacts.some(
        (contact) => contact.email === address && contact.email !== editing?.email,
      )
    ) {
      setProblem("이미 주소록에 있는 주소입니다.");
      return;
    }
    setProblem(null);

    if (!editing) {
      create.mutate(
        { name: trimmedName, email: address },
        {
          onSuccess: (contact) =>
            onSaved(`${contact.name || contact.email}님을 Google 주소록에 추가했습니다.`),
        },
      );
      return;
    }
    if (trimmedName === editing.name && address === editing.email) {
      onCancel();
      return;
    }
    update.mutate(
      {
        resourceName: editing.resourceName,
        email: editing.email,
        name: trimmedName,
        newEmail: address,
      },
      {
        onSuccess: () =>
          onSaved(`${trimmedName || address} 연락처를 수정했습니다.`),
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={title}
      className="m-4 space-y-3 rounded-md border border-foreground/15 p-4"
    >
      <p className="text-sm font-semibold">{title}</p>
      {editing && otherAddresses > 0 && (
        <p className="text-xs opacity-70">
          이 사람에게는 다른 주소가 {otherAddresses}개 더 있습니다. 이름을 바꾸면
          그 주소들의 이름도 함께 바뀌고, 주소는 이 주소만 바뀝니다.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="min-w-48 flex-1 text-sm">
          <span className="mb-1 block opacity-70">이름</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_CONTACT_NAME_LENGTH}
            autoFocus
            className={INPUT_CLASS}
          />
        </label>
        <label className="min-w-48 flex-1 text-sm">
          <span className="mb-1 block opacity-70">이메일</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={problem ? true : undefined}
            className={INPUT_CLASS}
          />
        </label>
      </div>

      {problem && (
        <p role="alert" className="text-sm text-red-600">
          {problem}
        </p>
      )}
      {mutation.error && <ContactChangeError error={mutation.error} />}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {mutation.isPending ? "저장하는 중…" : "저장"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
        >
          취소
        </button>
      </div>
    </form>
  );
}

/** Why a contact change failed, with a re-login button when permission is missing. */
export function ContactChangeError({
  error,
  action = "저장",
}: {
  error: Error;
  /** The verb for the messages, e.g. "저장" or "삭제". */
  action?: string;
}) {
  const login = useLogin();
  const code = error instanceof MailApiError ? error.code : null;

  if (code === "missing_scope") {
    return (
      <div role="alert" className="space-y-2 text-sm text-red-600">
        <p>
          주소록을 변경할 권한이 없습니다. 다시 로그인하고 연락처 권한을 허용한
          뒤 다시 {action}해 주세요.
        </p>
        <button
          type="button"
          onClick={() => login.mutate()}
          className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm text-foreground"
        >
          {login.isPending ? "브라우저에서 로그인을 완료해 주세요…" : "다시 로그인"}
        </button>
      </div>
    );
  }
  return (
    <p role="alert" className="text-sm text-red-600">
      {code === "api_disabled"
        ? `Google Cloud Console에서 People API를 사용 설정해야 ${action}할 수 있습니다.`
        : `연락처를 ${action}하지 못했습니다. 잠시 후 다시 시도해 주세요.`}
    </p>
  );
}
