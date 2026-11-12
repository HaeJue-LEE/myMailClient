"use client";

import { type FormEvent, useState } from "react";
import {
  MailApiError,
  useAccounts,
  useAppFeatures,
  useLogin,
  useRemoveGoogleClient,
  useSaveGoogleClient,
} from "@/features/mail/api";
import type { Account } from "@/features/mail/mail-accounts";

const INPUT_CLASS =
  "w-full rounded-md border border-foreground/20 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-foreground/60 aria-[invalid=true]:border-red-600";

/** `123456789012-abc….apps.googleusercontent.com`, as Google shows it. */
const CLIENT_ID = /^[0-9]{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/;

const SETUP_STEPS = [
  "Google Cloud Console(console.cloud.google.com)에서 프로젝트를 만들고 Gmail API와 People API를 사용 설정합니다.",
  "Google 인증 플랫폼 → 대상에서 로그인할 Gmail 주소를 테스트 사용자로 추가합니다.",
  "데이터 액세스에 gmail.modify, contacts, contacts.other.readonly 범위를 추가합니다.",
  "클라이언트 → 클라이언트 만들기에서 애플리케이션 유형을 '데스크톱 앱'으로 만들고, 클라이언트 ID와 클라이언트 보안 비밀을 아래에 넣습니다.",
];

/**
 * Adding Gmail through Google sign-in (Gmail API). Without a Google OAuth
 * client (builds handed out carry none) the user's own is set up first;
 * then sign-in opens the system browser.
 */
export function GoogleAccountSetup({
  onSignedIn,
  onCancel,
}: {
  onSignedIn: (account: Account) => void;
  onCancel?: () => void;
}) {
  const features = useAppFeatures();
  const accounts = useAccounts();
  const login = useLogin();
  const google = accounts.data?.find((account) => account.kind === "gmail");

  if (features.isPending) return <p className="text-sm opacity-60">불러오는 중…</p>;
  if (!features.data) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Google 로그인 설정을 불러오지 못했습니다.
      </p>
    );
  }

  const cancel = onCancel && (
    <button
      type="button"
      onClick={onCancel}
      className="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
    >
      취소
    </button>
  );

  if (google) {
    return (
      <div className="space-y-3 text-sm">
        <p>
          Google 계정은 하나만 추가할 수 있습니다. 이미 <b>{google.email}</b> 계정이 있습니다.
          다른 Gmail 주소는 &lsquo;Gmail (IMAP, 앱 비밀번호)&rsquo;로 추가해 주세요.
        </p>
        {cancel}
      </div>
    );
  }

  if (features.data.googleClient === "none") return <ClientForm cancel={cancel} />;

  return (
    <div className="space-y-3 text-sm">
      <p>
        버튼을 누르면 브라우저에서 Google 로그인 화면이 열립니다. 로그인하고 권한을 허용하면 이
        앱으로 돌아와 계정이 추가됩니다.
      </p>
      <ClientInUse source={features.data.googleClient} hint={features.data.googleClientHint} />
      {login.error && (
        <p role="alert" className="text-red-600">
          {login.error instanceof MailApiError && login.error.code === "login_cancelled"
            ? "로그인이 취소되었습니다."
            : "Google 로그인에 실패했습니다. 클라이언트 설정(테스트 사용자, 범위)과 권한 허용을 확인해 주세요."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* Stays enabled while waiting: clicking again reopens the browser and cancels the old attempt. */}
        <button
          type="button"
          onClick={() => login.mutate(undefined, { onSuccess: onSignedIn })}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
        >
          {login.isPending ? "브라우저 다시 열기" : "Google 계정으로 로그인"}
        </button>
        {cancel}
        {login.isPending && (
          <span className="text-xs opacity-70">브라우저에서 로그인을 완료해 주세요…</span>
        )}
      </div>
    </div>
  );
}

/** Which client sign-in uses; an entered one can be removed to enter another. */
function ClientInUse({ source, hint }: { source: "built-in" | "custom"; hint: string | null }) {
  const remove = useRemoveGoogleClient();
  if (source === "built-in") {
    return <p className="text-xs opacity-60">이 앱에 내장된 Google 클라이언트를 사용합니다.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="opacity-60">직접 입력한 Google 클라이언트 사용 중 ({hint})</span>
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
        className="underline opacity-70 hover:opacity-100 disabled:opacity-40"
      >
        다른 클라이언트로 바꾸기
      </button>
      {remove.isError && <span className="text-red-600">지우지 못했습니다.</span>}
    </div>
  );
}

/** Entering the user's own Google OAuth client (desktop app type). */
function ClientForm({ cancel }: { cancel: React.ReactNode }) {
  const save = useSaveGoogleClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [problem, setProblem] = useState<"id" | "secret" | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!CLIENT_ID.test(id)) return setProblem("id");
    if (secret.length < 8 || /\s/.test(secret)) return setProblem("secret");
    setProblem(null);
    save.mutate({ clientId: id, clientSecret: secret });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3 text-sm">
      <p>
        Google 로그인을 쓰려면 먼저 <b>본인의 Google Cloud 프로젝트에서 만든 OAuth 클라이언트</b>가
        필요합니다. 한 번만 설정하면 됩니다. 번거로우면 &lsquo;Gmail (IMAP, 앱 비밀번호)&rsquo;를
        쓰세요. 키 없이 바로 연결됩니다.
      </p>
      <ol className="list-decimal space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 py-3 pl-8 pr-4 text-xs">
        {SETUP_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <label className="block">
        <span className="mb-1 block opacity-70">클라이언트 ID</span>
        <input
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="123456789012-xxxxxxxx.apps.googleusercontent.com"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem === "id" || undefined}
          className={INPUT_CLASS}
        />
        {problem === "id" && (
          <span className="mt-1 block text-xs text-red-600">
            &lsquo;…apps.googleusercontent.com&rsquo;으로 끝나는 클라이언트 ID를 그대로 붙여 넣어 주세요.
          </span>
        )}
      </label>
      <label className="block">
        <span className="mb-1 block opacity-70">클라이언트 보안 비밀</span>
        <input
          type="password"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem === "secret" || undefined}
          className={INPUT_CLASS}
        />
        {problem === "secret" && (
          <span className="mt-1 block text-xs text-red-600">클라이언트 보안 비밀을 붙여 넣어 주세요.</span>
        )}
      </label>
      {save.isError && (
        <p role="alert" className="text-red-600">
          저장하지 못했습니다. 값을 확인하고 다시 시도해 주세요.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
        >
          저장하고 다음
        </button>
        {cancel}
        <span className="text-xs opacity-60">
          Windows 사용자 계정으로 암호화해 이 컴퓨터에만 저장합니다.
        </span>
      </div>
    </form>
  );
}
