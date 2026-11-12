"use client";

import { type FormEvent, useState } from "react";
import {
  MailApiError,
  useAccounts,
  useAppFeatures,
  useLoginZoho,
  useRemoveZohoClient,
  useSaveZohoClient,
} from "@/features/mail/api";
import { ZOHO_REGIONS, type ZohoRegion } from "@/features/mail/zoho";

const INPUT_CLASS =
  "w-full rounded-md border border-foreground/20 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-foreground/60 aria-[invalid=true]:border-red-600";

const SETUP_STEPS = [
  "Zoho API 콘솔(api-console.zoho.com)에 추가할 Zoho 메일 계정으로 로그인합니다.",
  "ADD CLIENT(클라이언트 추가) → 'Non-browser Applications'를 고르고, 이름(예: Mail Client)을 넣어 만듭니다.",
  "만들어진 클라이언트의 Client ID와 Client Secret을 아래에 넣습니다. 데이터 센터는 API 콘솔 주소가 api-console.zoho.com이면 '미국'입니다.",
];

/**
 * Adding a Zoho Mail account through Zoho sign-in (Zoho Mail API), which
 * works on Zoho's free plan where IMAP is not offered. The user's own Zoho
 * API client is set up first; then sign-in opens Zoho's approval page in the
 * system browser.
 */
export function ZohoAccountSetup({ onCancel }: { onCancel?: () => void }) {
  const features = useAppFeatures();
  const login = useLoginZoho();
  const zohoCount = useAccounts().data?.filter((account) => account.kind === "zoho").length ?? 0;

  if (features.isPending) return <p className="text-sm opacity-60">불러오는 중…</p>;
  if (!features.data) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Zoho 로그인 설정을 불러오지 못했습니다.
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

  const client = features.data.zohoClient;
  if (!client) return <ClientForm cancel={cancel} />;

  const code = login.error instanceof MailApiError ? login.error.code : null;
  return (
    <div className="space-y-3 text-sm">
      <p>
        버튼을 누르면 브라우저에서 Zoho 승인 화면이 열립니다. Zoho 메일 계정으로 로그인한 채 화면의
        코드를 확인하고 승인(Accept)을 누르면 이 앱에 계정이 추가됩니다. 5분 안에 승인해 주세요.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="opacity-60">
          Zoho 클라이언트 사용 중 ({client.hint}, {ZOHO_REGIONS[client.region].label})
        </span>
        <RemoveClient zohoCount={zohoCount} />
      </div>
      {login.error && (
        <p role="alert" className="text-red-600">
          {code === "login_cancelled"
            ? "승인이 취소되었거나 시간이 지났습니다. 다시 시도해 주세요."
            : code === "invalid_request"
              ? "Zoho가 클라이언트를 거부했습니다. 클라이언트 종류(Non-browser Applications), Client ID·Secret과 데이터 센터를 확인해 주세요."
              : "Zoho 로그인에 실패했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* Stays enabled while waiting: clicking again starts over and cancels the old attempt. */}
        <button
          type="button"
          onClick={() => login.mutate()}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
        >
          {login.isPending ? "승인 화면 다시 열기" : "Zoho 계정으로 로그인"}
        </button>
        {cancel}
        {login.isPending && (
          <span className="text-xs opacity-70">브라우저에서 승인을 완료해 주세요…</span>
        )}
      </div>
    </div>
  );
}

/** Forgets the client to enter another; its Zoho accounts go with it, so this asks first. */
function RemoveClient({ zohoCount }: { zohoCount: number }) {
  const remove = useRemoveZohoClient();
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span>
          {zohoCount > 0
            ? `이 클라이언트로 추가한 Zoho 계정 ${zohoCount}개도 앱에서 삭제됩니다. 계속할까요?`
            : "클라이언트를 지울까요?"}
        </span>
        <button
          type="button"
          disabled={remove.isPending}
          onClick={() => remove.mutate(undefined, { onSuccess: () => setConfirming(false) })}
          className="text-red-600 underline disabled:opacity-40"
        >
          지우기
        </button>
        <button type="button" autoFocus onClick={() => setConfirming(false)} className="underline">
          취소
        </button>
        {remove.isError && <span className="text-red-600">지우지 못했습니다.</span>}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="underline opacity-70 hover:opacity-100"
    >
      다른 클라이언트로 바꾸기
    </button>
  );
}

/** Entering the user's own Zoho API client ("Non-browser Applications"). */
function ClientForm({ cancel }: { cancel: React.ReactNode }) {
  const save = useSaveZohoClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [region, setRegion] = useState<ZohoRegion>("us");
  const [problem, setProblem] = useState<"id" | "secret" | null>(null);

  const valid = (value: string) => value.length >= 10 && !/\s/.test(value);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!valid(id)) return setProblem("id");
    if (!valid(secret)) return setProblem("secret");
    setProblem(null);
    save.mutate({ clientId: id, clientSecret: secret, region });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3 text-sm">
      <p>
        Zoho 로그인을 쓰려면 먼저 <b>본인의 Zoho API 클라이언트</b>가 필요합니다. 한 번만 설정하면
        되고, Zoho 무료 플랜에서도 쓸 수 있습니다.
      </p>
      <ol className="list-decimal space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 py-3 pl-8 pr-4 text-xs">
        {SETUP_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <label className="block">
        <span className="mb-1 block opacity-70">Client ID</span>
        <input
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="1000.XXXXXXXXXXXXXXXXXXXX"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem === "id" || undefined}
          className={INPUT_CLASS}
        />
        {problem === "id" && (
          <span className="mt-1 block text-xs text-red-600">Client ID를 그대로 붙여 넣어 주세요.</span>
        )}
      </label>
      <label className="block">
        <span className="mb-1 block opacity-70">Client Secret</span>
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
          <span className="mt-1 block text-xs text-red-600">Client Secret을 붙여 넣어 주세요.</span>
        )}
      </label>
      <label className="block max-w-xs">
        <span className="mb-1 block opacity-70">데이터 센터</span>
        <select
          value={region}
          onChange={(event) => setRegion(event.target.value as ZohoRegion)}
          className={INPUT_CLASS}
        >
          {Object.entries(ZOHO_REGIONS).map(([id, item]) => (
            <option key={id} value={id} className="bg-background text-foreground">
              {item.label}
            </option>
          ))}
        </select>
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
