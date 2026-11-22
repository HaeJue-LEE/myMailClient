"use client";

import { type FormEvent, useState } from "react";
import {
  MailApiError,
  reloadMail,
  useChooseSettingsFile,
  useExportSettings,
  useImportSettings,
  useOpenSettingsFile,
} from "@/features/mail/api";
import type { AccountKind } from "@/features/mail/mail-accounts";
import {
  type ImportChoices,
  type ImportItem,
  type ImportOutcome,
  type ImportPreview,
  type ImportResult,
  importOutcome,
  MIN_PASSPHRASE_LENGTH,
  passphraseLength,
  platformLabel,
} from "@/features/mail/settings-transfer";

const INPUT_CLASS =
  "w-full rounded-md border border-foreground/20 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-foreground/60 aria-[invalid=true]:border-red-600";
const PRIMARY =
  "rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50";
const SECONDARY =
  "rounded-md border border-foreground/20 px-3 py-1.5 text-sm hover:bg-foreground/5 disabled:opacity-50";

const KIND_LABEL: Record<AccountKind, string> = {
  gmail: "Google",
  imap: "IMAP",
  pop3: "POP3",
  zoho: "Zoho",
};

/** What will happen to an account, before importing. */
const PLANNED: Record<Exclude<ImportOutcome, "failed">, string> = {
  added: "추가합니다",
  replaced: "파일의 설정으로 덮어씁니다",
  skipped: "이미 있어 그대로 둡니다",
  sign_in_again: "가져오지 않습니다 · 이 컴퓨터에서 다시 로그인",
  needs_password: "추가합니다 · 비밀번호는 다시 입력",
};

/** What happened to an account, after importing. */
const DONE: Record<ImportOutcome, string> = {
  added: "추가함",
  replaced: "덮어씀",
  skipped: "그대로 둠",
  sign_in_again: "가져오지 않음 · 다시 로그인 필요",
  needs_password: "추가함 · 비밀번호 다시 입력 필요",
  failed: "가져오지 못함",
};

function errorText(error: unknown) {
  const code = error instanceof MailApiError ? error.code : null;
  if (code === "wrong_passphrase") {
    return "암호가 맞지 않습니다. 파일을 만들 때 정한 암호를 그대로 입력해 주세요.";
  }
  if (code === "not_settings_file") return "Mail Client 설정 파일이 아니거나 손상된 파일입니다.";
  if (code === "newer_settings_file") {
    return "더 새 버전의 Mail Client에서 만든 파일입니다. 이 앱을 업데이트한 뒤 다시 가져와 주세요.";
  }
  if (code === "invalid_request") return "파일을 다시 골라 주세요.";
  return "처리하지 못했습니다. 다시 시도해 주세요.";
}

/** The section of the accounts screen: saving the accounts to a file, or bringing them in from one. */
export function SettingsTransfer({ hasAccounts }: { hasAccounts: boolean }) {
  const [mode, setMode] = useState<"export" | "import" | null>(null);
  return (
    <section
      aria-labelledby="settings-transfer-title"
      className="space-y-3 rounded-md border border-foreground/15 px-4 py-3"
    >
      <h2 id="settings-transfer-title" className="text-sm font-semibold">
        다른 컴퓨터로 설정 옮기기
      </h2>
      {mode === null && (
        <>
          <p className="text-xs opacity-60">
            메일 계정을 파일 하나로 내보내고, 다른 컴퓨터의 Mail Client에서 가져옵니다. 윈도우와 맥
            사이에서도 주고받을 수 있습니다.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!hasAccounts}
              onClick={() => setMode("export")}
              className={SECONDARY}
            >
              설정 내보내기
            </button>
            <button type="button" onClick={() => setMode("import")} className={SECONDARY}>
              설정 가져오기
            </button>
          </div>
        </>
      )}
      {mode === "export" && <ExportForm onClose={() => setMode(null)} />}
      {mode === "import" && <SettingsImport onCancel={() => setMode(null)} />}
    </section>
  );
}

function ExportForm({ onClose }: { onClose: () => void }) {
  const save = useExportSettings();
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [problem, setProblem] = useState<"short" | "mismatch" | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (passphraseLength(passphrase) < MIN_PASSPHRASE_LENGTH) return setProblem("short");
    if (passphrase.normalize("NFC") !== again.normalize("NFC")) return setProblem("mismatch");
    setProblem(null);
    save.mutate({ passphrase, includeSecrets }, {
      onSuccess: ({ saved }) => {
        if (!saved) return;
        setPassphrase("");
        setAgain("");
      },
    });
  };

  if (save.data?.saved) {
    return (
      <div className="space-y-3 text-sm">
        <p role="status">계정 {save.data.accounts}개를 설정 파일에 저장했습니다.</p>
        <p className="text-xs opacity-70">
          다른 컴퓨터로 파일을 옮긴 뒤, 그 컴퓨터의 Mail Client에서 &lsquo;설정 가져오기&rsquo;로
          열고 이 암호를 입력하세요. 처음 실행한 화면에도 &lsquo;다른 컴퓨터에서 설정
          가져오기&rsquo;가 있습니다.
        </p>
        <button type="button" onClick={onClose} className={SECONDARY}>
          닫기
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3 text-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={includeSecrets}
          onChange={(event) => setIncludeSecrets(event.target.checked)}
          className="mt-1"
        />
        <span>
          비밀번호·로그인 포함
          <span className="block text-xs opacity-70">
            {includeSecrets
              ? "메일 계정과 비밀번호, Google·Zoho 로그인과 클라이언트(ID·보안 비밀), 계정 사진과 순서를 파일 하나에 담아 아래 암호로 잠급니다. 가져온 컴퓨터에서 다시 로그인하지 않아도 됩니다."
              : "IMAP·POP3 계정의 서버 설정과 계정 사진, 순서만 담습니다. Google·Zoho 계정은 빠지고, 가져온 뒤 비밀번호를 다시 입력해야 합니다."}
          </span>
        </span>
      </label>
      {includeSecrets && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          파일과 암호를 함께 가진 사람은 이 계정들의 메일을 읽고 보낼 수 있습니다. 암호는 파일과
          다른 방법으로 전하고, 다 옮긴 뒤에는 파일을 지워 주세요.
        </p>
      )}
      <label className="block">
        <span className="mb-1 block opacity-70">암호 ({MIN_PASSPHRASE_LENGTH}자 이상)</span>
        <input
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          autoComplete="new-password"
          autoFocus
          aria-invalid={problem === "short" || undefined}
          className={INPUT_CLASS}
        />
      </label>
      <label className="block">
        <span className="mb-1 block opacity-70">암호 확인</span>
        <input
          type="password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          autoComplete="new-password"
          aria-invalid={problem === "mismatch" || undefined}
          className={INPUT_CLASS}
        />
      </label>
      {problem && (
        <p role="alert" className="text-xs text-red-600">
          {problem === "short"
            ? `암호를 ${MIN_PASSPHRASE_LENGTH}자 이상으로 정해 주세요.`
            : "두 암호가 다릅니다."}
        </p>
      )}
      {save.isError && (
        <p role="alert" className="text-xs text-red-600">
          {save.error instanceof MailApiError && save.error.code === "invalid_request"
            ? "내보낼 메일 계정이 없습니다."
            : "설정 파일을 저장하지 못했습니다. 다시 시도해 주세요."}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={save.isPending} className={PRIMARY}>
          {save.isPending ? "저장하는 중…" : "파일로 저장…"}
        </button>
        <button type="button" onClick={onClose} className={SECONDARY}>
          취소
        </button>
      </div>
    </form>
  );
}

/**
 * Bringing accounts in from a settings file: pick it, open it with its
 * passphrase, see what will happen to each account, import. Used on the
 * accounts screen and on the first screen, before any account exists.
 */
export function SettingsImport({ onCancel }: { onCancel: () => void }) {
  const choose = useChooseSettingsFile();
  const [file, setFile] = useState<{ token: string; fileName: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const pick = () =>
    choose.mutate(undefined, {
      onSuccess: (picked) => {
        if (!picked) return;
        setFile(picked);
        setPreview(null);
      },
    });

  if (result) return <ImportDone result={result} onClose={onCancel} />;
  if (preview) {
    return <ImportReview preview={preview} onImported={setResult} onBack={() => setPreview(null)} />;
  }
  if (file) {
    return <OpenFile file={file} onOpened={setPreview} onPickAgain={pick} onCancel={onCancel} />;
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs opacity-70">
        다른 컴퓨터의 Mail Client에서 &lsquo;설정 내보내기&rsquo;로 만든 파일(.mcsettings)을
        골라 주세요. 윈도우에서 만든 파일도, 맥에서 만든 파일도 가져올 수 있습니다.
      </p>
      {choose.isError && (
        <p role="alert" className="text-xs text-red-600">
          {errorText(choose.error)}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" disabled={choose.isPending} onClick={pick} className={PRIMARY}>
          설정 파일 고르기…
        </button>
        <button type="button" onClick={onCancel} className={SECONDARY}>
          취소
        </button>
      </div>
    </div>
  );
}

function OpenFile({
  file,
  onOpened,
  onPickAgain,
  onCancel,
}: {
  file: { token: string; fileName: string };
  onOpened: (preview: ImportPreview) => void;
  onPickAgain: () => void;
  onCancel: () => void;
}) {
  const open = useOpenSettingsFile();
  const [passphrase, setPassphrase] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // No minimum here: the file opens with whatever passphrase it was made with.
    if (!passphrase) return;
    open.mutate({ token: file.token, passphrase }, { onSuccess: onOpened });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3 text-sm">
      <p>
        <span className="opacity-70">파일:</span> {file.fileName}
      </p>
      <label className="block">
        <span className="mb-1 block opacity-70">파일을 만들 때 정한 암호</span>
        <input
          type="password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          autoComplete="off"
          autoFocus
          className={INPUT_CLASS}
        />
      </label>
      {open.isError && (
        <p role="alert" className="text-xs text-red-600">
          {errorText(open.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={open.isPending || !passphrase}
          className={PRIMARY}
        >
          {open.isPending ? "여는 중…" : "열기"}
        </button>
        <button type="button" onClick={onPickAgain} className={SECONDARY}>
          다른 파일 고르기…
        </button>
        <button type="button" onClick={onCancel} className={SECONDARY}>
          취소
        </button>
      </div>
    </form>
  );
}

function ImportReview({
  preview,
  onImported,
  onBack,
}: {
  preview: ImportPreview;
  onImported: (result: ImportResult) => void;
  onBack: () => void;
}) {
  const importing = useImportSettings();
  const [choices, setChoices] = useState<ImportChoices>({
    overwrite: [],
    replaceGoogleClient: false,
    replaceZohoClient: false,
  });
  const has = (kind: AccountKind) => preview.items.some((item) => item.kind === kind);
  const outcome = (item: ImportItem) => importOutcome(item, preview, choices);
  const setOverwrite = (key: string, overwrite: boolean) =>
    setChoices((current) => ({
      ...current,
      overwrite: overwrite
        ? [...current.overwrite, key]
        : current.overwrite.filter((item) => item !== key),
    }));
  const willImport = preview.items.filter((item) =>
    ["added", "replaced", "needs_password"].includes(outcome(item)),
  ).length;
  const made = new Date(preview.exportedAt);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs opacity-70">
        {Number.isNaN(made.getTime()) ? "" : `${made.toLocaleString("ko-KR")}에 `}
        {platformLabel(preview.fromPlatform)}에서 만든 파일입니다. 계정 {preview.items.length}개가
        들어 있습니다.
      </p>
      {preview.unreadable > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          읽지 못한 계정 {preview.unreadable}개는 빼고 가져옵니다.
        </p>
      )}

      <ul className="divide-y divide-foreground/10 rounded-md border border-foreground/15">
        {preview.items.map((item) => {
          const planned = outcome(item);
          // A copy without a password is never offered for replacing one here.
          const choosable =
            item.exists &&
            !item.missingPassword &&
            planned !== "sign_in_again" &&
            !(item.kind === "gmail" && choices.replaceGoogleClient) &&
            !(item.kind === "zoho" && choices.replaceZohoClient);
          return (
            <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0 flex-1 truncate">
                {item.email}
                <span className="ml-2 text-xs opacity-60">{KIND_LABEL[item.kind]}</span>
              </span>
              {choosable ? (
                <select
                  aria-label={`${item.email}: 이미 있는 계정`}
                  value={choices.overwrite.includes(item.key) ? "overwrite" : "keep"}
                  onChange={(event) => setOverwrite(item.key, event.target.value === "overwrite")}
                  className="rounded-md border border-foreground/20 bg-background px-2 py-1 text-xs"
                >
                  <option value="keep">이미 있음 · 그대로 두기</option>
                  <option value="overwrite">이미 있음 · 파일의 설정으로 덮어쓰기</option>
                </select>
              ) : (
                <span
                  className={`text-xs ${planned === "sign_in_again" ? "text-amber-700 dark:text-amber-400" : "opacity-70"}`}
                >
                  {PLANNED[planned]}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {has("gmail") && (
        <ClientNote
          kind="Google"
          match={preview.google}
          here={preview.googleAccountsHere}
          replace={choices.replaceGoogleClient}
          onReplace={(replaceGoogleClient) => setChoices((current) => ({ ...current, replaceGoogleClient }))}
        />
      )}
      {has("zoho") && (
        <ClientNote
          kind="Zoho"
          match={preview.zoho}
          here={preview.zohoAccountsHere}
          replace={choices.replaceZohoClient}
          onReplace={(replaceZohoClient) => setChoices((current) => ({ ...current, replaceZohoClient }))}
        />
      )}

      <p className="text-xs opacity-60">
        맥에서는 가져올 때 키체인 접근을 묻는 창이 뜰 수 있습니다. &lsquo;허용&rsquo;을 눌러 주세요.
        {(has("gmail") || has("zoho")) &&
          " Google·Zoho 계정은 두 컴퓨터가 같은 로그인을 함께 쓰므로, 한쪽에서 그 계정을 삭제(로그아웃)하면 다른 쪽도 다시 로그인해야 합니다."}
      </p>
      {importing.isError && (
        <p role="alert" className="text-xs text-red-600">
          {errorText(importing.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={importing.isPending || willImport === 0}
          onClick={() => importing.mutate({ token: preview.token, choices }, { onSuccess: onImported })}
          className={PRIMARY}
        >
          {importing.isPending ? "가져오는 중…" : `계정 ${willImport}개 가져오기`}
        </button>
        <button type="button" disabled={importing.isPending} onClick={onBack} className={SECONDARY}>
          뒤로
        </button>
      </div>
    </div>
  );
}

function ClientNote({
  kind,
  match,
  here,
  replace,
  onReplace,
}: {
  kind: "Google" | "Zoho";
  match: ImportPreview["google"];
  here: number;
  replace: boolean;
  onReplace: (replace: boolean) => void;
}) {
  if (match === "install") {
    return <p className="text-xs opacity-70">파일에 든 {kind} 클라이언트도 함께 등록합니다.</p>;
  }
  if (match !== "differs") return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
      <p>
        이 컴퓨터에는 다른 {kind} 클라이언트가 등록되어 있어, 파일의 {kind} 로그인은 그대로 쓸 수
        없습니다.
      </p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={replace}
          onChange={(event) => onReplace(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          이 컴퓨터의 {kind} 클라이언트를 파일의 것으로 바꾸기
          {here > 0 && ` (이 컴퓨터의 ${kind} 계정 ${here}개는 로그아웃됩니다)`}
        </span>
      </label>
    </div>
  );
}

function ImportDone({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const needsPassword = result.items.some((item) => item.outcome === "needs_password");
  const signInAgain = result.items.some((item) => item.outcome === "sign_in_again");
  const sharedSignIn = result.items.some(
    (item) => (item.kind === "gmail" || item.kind === "zoho") &&
      (item.outcome === "added" || item.outcome === "replaced"),
  );
  return (
    <div className="space-y-3 text-sm">
      <p role="status">
        {result.imported > 0
          ? `계정 ${result.imported}개를 가져왔습니다.`
          : "가져온 계정이 없습니다."}
      </p>
      <ul className="divide-y divide-foreground/10 rounded-md border border-foreground/15">
        {result.items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="min-w-0 flex-1 truncate">
              {item.email}
              <span className="ml-2 text-xs opacity-60">{KIND_LABEL[item.kind]}</span>
            </span>
            <span
              className={`text-xs ${item.outcome === "failed" ? "text-red-600" : "opacity-70"}`}
            >
              {DONE[item.outcome]}
            </span>
          </li>
        ))}
      </ul>
      {needsPassword && (
        <p className="text-xs opacity-70">
          비밀번호가 없는 계정은 메일 계정 화면에서 그 계정의 &lsquo;수정&rsquo;으로 비밀번호를
          넣어 주세요.
        </p>
      )}
      {signInAgain && (
        <p className="text-xs opacity-70">
          가져오지 않은 Google·Zoho 계정은 &lsquo;메일 계정 추가&rsquo;에서 이 컴퓨터의
          클라이언트로 다시 로그인해 주세요.
        </p>
      )}
      {sharedSignIn && (
        <p className="text-xs opacity-70">
          Google·Zoho 계정은 원래 컴퓨터와 같은 로그인을 함께 씁니다. 어느 한쪽에서 그 계정을
          삭제(로그아웃)하면 다른 쪽에서도 다시 로그인해야 합니다.
        </p>
      )}
      <div className="flex gap-2">
        {result.imported > 0 ? (
          <button type="button" onClick={reloadMail} className={PRIMARY}>
            메일로 이동
          </button>
        ) : (
          <button type="button" onClick={onClose} className={SECONDARY}>
            닫기
          </button>
        )}
      </div>
    </div>
  );
}
