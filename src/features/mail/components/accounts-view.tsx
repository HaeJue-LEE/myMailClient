"use client";

import { useState } from "react";
import {
  useAccount,
  useAccounts,
  useAppFeatures,
  useChooseAccountAvatar,
  useMailAccount,
  useMoveAccount,
  useRemoveAccount,
  useRemoveAccountAvatar,
  useSetShortcut,
  useSwitchAccount,
} from "@/features/mail/api";
import { AccountAvatar } from "@/features/mail/components/account-avatar";
import { Icon } from "@/features/mail/components/icon";
import { useDragReorder } from "@/features/mail/components/use-drag-reorder";
import { MailAccountForm } from "@/features/mail/components/mail-account-form";
import type { Account } from "@/features/mail/mail-accounts";

const KIND_LABEL: Record<Account["kind"], string> = {
  gmail: "Google",
  imap: "IMAP",
  pop3: "POP3",
  zoho: "Zoho",
};

const ROW_BUTTON =
  "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm hover:bg-foreground/10 disabled:opacity-50";

/** The open form: adding an account, or editing the one with this id. */
type FormState = { mode: "add" } | { mode: "edit"; id: string };

/** Lists the mail accounts; adds, edits, removes them, and picks the one in use. */
export function AccountsView() {
  const accounts = useAccounts();
  const { data: active } = useAccount();
  const switchAccount = useSwitchAccount();
  const move = useMoveAccount();
  const [form, setForm] = useState<FormState | null>(null);
  // Order of the accounts here and in the sidebar's account picker.
  const reorder = useDragReorder(
    (accounts.data ?? []).map((account) => account.id),
    (ids) => move.mutate({ ids }),
  );
  const [message, setMessage] = useState<string | null>(null);
  const list = accounts.data ?? [];
  const openForm = (next: FormState) => {
    setMessage(null);
    setForm(next);
  };

  return (
    <div>
      <div className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-foreground/10 bg-background px-4">
        <h1 className="text-sm font-semibold">메일 계정</h1>
        <span className="text-xs opacity-60">{list.length}개</span>
        {/* Gmail through Google sign-in is the form's first choice. */}
        <button
          type="button"
          onClick={() => openForm({ mode: "add" })}
          className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-sm font-medium text-background`}
        >
          <Icon name="personAdd" />
          메일 계정 추가
        </button>
      </div>

      <div className="max-w-3xl space-y-4 p-4">
        {switchAccount.isError && (
          <p role="alert" className="text-sm text-red-600">
            계정을 바꾸지 못했습니다. 다시 시도해 주세요.
          </p>
        )}
        {move.isError && (
          <p role="alert" className="text-sm text-red-600">
            계정 순서를 저장하지 못했습니다. 다시 시도해 주세요.
          </p>
        )}
        {message && (
          <p role="status" className="rounded-md bg-foreground/5 px-4 py-2 text-sm">
            {message}
          </p>
        )}

        {form?.mode === "add" && (
          <MailAccountForm
            onSaved={(account) => {
              setForm(null);
              setMessage(`${account.email} 계정을 추가했습니다.`);
            }}
            onCancel={() => setForm(null)}
          />
        )}
        {form?.mode === "edit" && (
          <EditAccount
            key={form.id}
            id={form.id}
            onSaved={(account) => {
              setForm(null);
              setMessage(`${account.email} 계정을 수정했습니다.`);
            }}
            onCancel={() => setForm(null)}
          />
        )}

        {accounts.isPending ? (
          <p className="py-2 text-sm opacity-60">불러오는 중…</p>
        ) : accounts.isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p className="text-red-600">메일 계정을 불러오지 못했습니다.</p>
            <button
              type="button"
              onClick={() => accounts.refetch()}
              className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm"
            >
              다시 시도
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-foreground/10 rounded-md border border-foreground/15">
            {list.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                rowProps={reorder.rowProps(account.id)}
                handleProps={reorder.handleProps(account.id)}
                isActive={account.id === active?.id}
                switching={switchAccount.isPending}
                onUse={() => switchAccount.mutate(account.id)}
                onEdit={() => openForm({ mode: "edit", id: account.id })}
                onRemoved={() => {
                  setForm(null);
                  setMessage(`${account.email} 계정을 이 앱에서 삭제했습니다.`);
                }}
              />
            ))}
          </ul>
        )}

        <p className="text-xs opacity-60">
          한 번에 한 계정의 메일을 봅니다. 사용할 계정은 여기나 왼쪽 아래의 계정
          선택에서 바꿀 수 있습니다. Google 주소록, 보관, 중요 편지함은 Google
          계정에서만 쓸 수 있습니다.
        </p>

        <Shortcuts />
      </div>
    </div>
  );
}

const SHORTCUT_LABELS = [
  ["desktop", "바탕 화면"],
  ["startMenu", "시작 메뉴"],
] as const;

/**
 * Desktop and Start menu shortcuts to the launcher exe. Shown only when the
 * app was started through it (not in `npm run dev` or an unpacked folder).
 */
function Shortcuts() {
  const features = useAppFeatures();
  const setShortcut = useSetShortcut();
  const shortcuts = features.data?.shortcuts;
  if (!shortcuts?.available) return null;

  return (
    <section aria-labelledby="shortcuts-title" className="space-y-2 rounded-md border border-foreground/15 px-4 py-3">
      <h2 id="shortcuts-title" className="text-sm font-semibold">
        바로가기
      </h2>
      <ul className="space-y-1.5">
        {SHORTCUT_LABELS.map(([place, label]) => (
          <li key={place} className="flex items-center gap-3 text-sm">
            <span className="w-20 shrink-0">{label}</span>
            <span className="flex-1 text-xs opacity-60">{shortcuts[place] ? "있음" : "없음"}</span>
            <button
              type="button"
              disabled={setShortcut.isPending}
              onClick={() => setShortcut.mutate({ place, enabled: !shortcuts[place] })}
              className={ROW_BUTTON}
            >
              {shortcuts[place] ? "지우기" : "만들기"}
            </button>
          </li>
        ))}
      </ul>
      {setShortcut.isError && (
        <p role="alert" className="text-xs text-red-600">
          바로가기를 바꾸지 못했습니다. 다시 시도해 주세요.
        </p>
      )}
      <p className="text-xs opacity-60">
        바로가기는 이 앱을 설치한 실행 파일을 가리킵니다. 새 버전 실행 파일을 같은 이름으로
        바꿔 두면 바로가기로 실행할 때 새 버전으로 바뀝니다.
      </p>
    </section>
  );
}

/** Loads the stored settings, then shows the form with them. */
function EditAccount({
  id,
  onSaved,
  onCancel,
}: {
  id: string;
  onSaved: (account: Account) => void;
  onCancel: () => void;
}) {
  const settings = useMailAccount(id);
  if (settings.isPending) return <p className="py-2 text-sm opacity-60">불러오는 중…</p>;
  if (settings.isError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        계정 설정을 불러오지 못했습니다.
      </p>
    );
  }
  return <MailAccountForm editing={settings.data} onSaved={onSaved} onCancel={onCancel} />;
}

function AccountRow({
  account,
  rowProps,
  handleProps,
  isActive,
  switching,
  onUse,
  onEdit,
  onRemoved,
}: {
  account: Account;
  /** Spread on the row and its drag handle (see `useDragReorder`). */
  rowProps: ReturnType<ReturnType<typeof useDragReorder>["rowProps"]>;
  handleProps: ReturnType<ReturnType<typeof useDragReorder>["handleProps"]>;
  isActive: boolean;
  switching: boolean;
  onUse: () => void;
  onEdit: () => void;
  onRemoved: () => void;
}) {
  const remove = useRemoveAccount();
  const chooseAvatar = useChooseAccountAvatar();
  const removeAvatar = useRemoveAccountAvatar();
  const [confirming, setConfirming] = useState(false);
  const isGoogle = account.kind === "gmail";
  // Signed in rather than set up with a password: nothing to edit, removing signs out.
  const isSignIn = isGoogle || account.kind === "zoho";

  if (confirming) {
    return (
      <li
        {...rowProps}
        role="alertdialog"
        aria-label="계정 삭제 확인"
        className="space-y-2 bg-red-500/5 px-4 py-3 text-sm"
      >
        <p>
          <b>{account.email}</b> 계정을 이 앱에서 삭제할까요?{" "}
          {isGoogle
            ? "Google 계정에서 로그아웃하며, 메일은 Gmail에 그대로 남습니다."
            : account.kind === "zoho"
              ? "Zoho 로그인을 해제하며, 메일은 Zoho 메일에 그대로 남습니다."
            : "저장된 서버 설정과 비밀번호가 지워지며, 메일은 서버에 그대로 남습니다."}
        </p>
        {remove.isError && (
          <p role="alert" className="text-red-600">
            계정을 삭제하지 못했습니다. 다시 시도해 주세요.
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => remove.mutate(account.id, { onSuccess: onRemoved })}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {remove.isPending ? "삭제하는 중…" : isSignIn ? "로그아웃" : "삭제"}
          </button>
          {/* Focus starts on the safe choice: a stray Enter must not delete. */}
          <button
            type="button"
            autoFocus
            onClick={() => setConfirming(false)}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
          >
            취소
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      {...rowProps}
      className="bg-background py-2.5 pl-1.5 pr-4 data-[dragging]:rounded-md data-[dragging]:shadow-lg data-[dragging]:ring-1 data-[dragging]:ring-foreground/15"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          {...handleProps}
          title="끌어서 순서 바꾸기 (↑/↓ 키로도 이동)"
          aria-label={`${account.email} 계정 순서 바꾸기. 위아래 화살표 키로 이동합니다`}
          className="shrink-0 select-none rounded p-1 opacity-40 hover:bg-foreground/10 hover:opacity-100 focus-visible:opacity-100"
        >
          <Icon name="grip" />
        </button>
        <button
          type="button"
          onClick={() => chooseAvatar.mutate(account.id)}
          disabled={chooseAvatar.isPending}
          title={`${account.email} 계정 사진 ${account.avatar ? "바꾸기" : "넣기"}`}
          className="group relative shrink-0 rounded-full disabled:opacity-50"
        >
          <AccountAvatar account={account} className="size-9 text-sm" />
          <span
            aria-hidden
            className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border border-background bg-foreground text-background opacity-70 group-hover:opacity-100"
          >
            <Icon name="edit" className="size-2.5!" />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{account.name || account.email}</p>
          {account.name && <p className="truncate text-xs opacity-60">{account.email}</p>}
          {account.avatar && (
            <button
              type="button"
              onClick={() => removeAvatar.mutate(account.id)}
              disabled={removeAvatar.isPending}
              className="text-xs underline opacity-60 hover:opacity-100 disabled:opacity-40"
            >
              사진 지우고 첫 글자로
            </button>
          )}
        </div>
        <span className="shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-xs opacity-70">
          {KIND_LABEL[account.kind]}
        </span>
        {isActive ? (
          <span className="shrink-0 rounded bg-foreground px-2 py-1 text-xs font-medium text-background">
            사용 중
          </span>
        ) : (
          <button type="button" disabled={switching} onClick={onUse} className={ROW_BUTTON}>
            이 계정 사용
          </button>
        )}
        {!isSignIn && (
          <button
            type="button"
            onClick={onEdit}
            title={`${account.email} 계정 수정`}
            className={ROW_BUTTON}
          >
            <Icon name="edit" />
            <span className="hidden lg:inline">수정</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title={`${account.email} 계정 삭제`}
          className={`${ROW_BUTTON} text-red-600`}
        >
          <Icon name="trash" />
          <span className="hidden lg:inline">{isSignIn ? "로그아웃" : "삭제"}</span>
        </button>
      </div>
      {(chooseAvatar.isError || removeAvatar.isError) && (
        <p role="alert" className="mt-1.5 text-xs text-red-600">
          {chooseAvatar.isError
            ? "사진을 넣지 못했습니다. PNG나 JPG 이미지 파일(20MB 이하)인지 확인해 주세요."
            : "사진을 지우지 못했습니다. 다시 시도해 주세요."}
        </p>
      )}
    </li>
  );
}
