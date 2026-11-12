"use client";

import { type FormEvent, type ReactNode, useState } from "react";
import { MailApiError, useSaveMailAccount } from "@/features/mail/api";
import { isEmail } from "@/features/mail/email";
import {
  ACCOUNT_PRESETS,
  type Account,
  type AccountPreset,
  defaultPort,
  GOOGLE_SIGN_IN_CHOICE,
  isHostname,
  isPort,
  type MailAccountSettings,
  MAX_ACCOUNT_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  presetFor,
  type ServerEndpoint,
  type ServerKind,
  type ServerSecurity,
  SENT_COPY_SUBJECT_PREFIX,
} from "@/features/mail/mail-accounts";
import { GoogleAccountSetup } from "@/features/mail/components/google-account-setup";
import { mailServerErrorText } from "@/features/mail/server-errors";

const INPUT_CLASS =
  "w-full rounded-md border border-foreground/20 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-foreground/60 aria-[invalid=true]:border-red-600";

const SECURITY_OPTIONS: [value: ServerSecurity, label: string][] = [
  ["ssl", "SSL/TLS"],
  ["starttls", "STARTTLS"],
  ["none", "암호화 없음"],
];

/** Example addresses for providers whose address form is known. */
const EMAIL_PLACEHOLDERS: Record<string, string> = {
  naver: "id@naver.com",
  "gmail-imap": "id@gmail.com",
};

/** A server as typed; the port stays text until it is checked on save. */
type ServerDraft = { host: string; port: string; security: ServerSecurity };

type Side = "incoming" | "outgoing";
type Problems = Partial<
  Record<"email" | "username" | "password" | `${Side}.${"host" | "port"}`, string>
>;

const toDraft = (server: ServerEndpoint): ServerDraft => ({
  ...server,
  port: String(server.port),
});

/** Moves the port to the new standard one, unless the user typed their own. */
function followDefault(port: string, previous: number, next: number) {
  return port.trim() === "" || Number(port) === previous ? String(next) : port;
}

function serverProblems(side: Side, draft: ServerDraft): Problems {
  const problems: Problems = {};
  if (!isHostname(draft.host)) {
    problems[`${side}.host`] =
      "서버 주소만 입력해 주세요. 예: mail.example.com (http://나 포트 번호 제외)";
  }
  if (!/^\d+$/.test(draft.port.trim()) || !isPort(Number(draft.port))) {
    problems[`${side}.port`] = "1~65535 사이의 숫자를 입력해 주세요.";
  }
  return problems;
}

/**
 * Adds an IMAP/SMTP or POP3/SMTP account (from a provider preset or typed in), or edits a
 * stored one. Saving signs in to both servers; nothing is stored on failure.
 */
export function MailAccountForm({
  editing,
  onSaved,
  onCancel,
}: {
  /** The stored account being changed; absent when adding. */
  editing?: MailAccountSettings;
  onSaved: (account: Account) => void;
  onCancel?: () => void;
}) {
  const save = useSaveMailAccount();
  const [preset, setPreset] = useState<AccountPreset>(ACCOUNT_PRESETS[0]);
  // Gmail through Google sign-in comes first in the list; it has no server fields.
  const [googleChosen, setGoogleChosen] = useState(!editing);
  const [name, setName] = useState(editing?.name ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  // Follows the address until the user types a different user name.
  const [username, setUsername] = useState<string | null>(editing?.username ?? null);
  const [password, setPassword] = useState("");
  const [incoming, setIncoming] = useState(() => toDraft(editing?.incoming ?? preset.incoming));
  const [outgoing, setOutgoing] = useState(() => toDraft(editing?.outgoing ?? preset.outgoing));
  const [saveSentCopy, setSaveSentCopy] = useState(
    editing?.saveSentCopy ?? preset.saveSentCopy,
  );
  const [sendCopyToSelf, setSendCopyToSelf] = useState(
    editing?.sendCopyToSelf ?? preset.sendCopyToSelf ?? false,
  );
  const [problems, setProblems] = useState<Problems>({});
  const title = editing ? "메일 계정 수정" : "메일 계정 추가";
  const isCustom = Boolean(editing) || preset.id.startsWith("custom");
  // An account keeps the protocol it was added with.
  const protocol = editing?.protocol ?? preset.protocol;
  const incomingLabel = protocol === "pop3" ? "POP3" : "IMAP";
  // An account being edited shows the notes of the service it was set up for.
  const notes = (editing ? presetFor(editing) : preset)?.notes ?? [];

  const choosePreset = (id: string) => {
    setGoogleChosen(id === GOOGLE_SIGN_IN_CHOICE.id);
    const next = ACCOUNT_PRESETS.find((item) => item.id === id) ?? preset;
    setPreset(next);
    setIncoming(toDraft(next.incoming));
    setOutgoing(toDraft(next.outgoing));
    setSaveSentCopy(next.saveSentCopy);
    setSendCopyToSelf(next.sendCopyToSelf ?? false);
    setProblems({});
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    const user = (username ?? address).trim();
    const found: Problems = {
      ...serverProblems("incoming", incoming),
      ...serverProblems("outgoing", outgoing),
    };
    if (!isEmail(address)) found.email = "올바른 이메일 주소를 입력해 주세요.";
    if (!user) found.username = "사용자 이름을 입력해 주세요.";
    if (!password && !editing?.hasPassword) found.password = "비밀번호를 입력해 주세요.";
    setProblems(found);
    if (Object.keys(found).length > 0) return;

    const toServer = (draft: ServerDraft): ServerEndpoint => ({
      host: draft.host.trim().toLowerCase(),
      port: Number(draft.port),
      security: draft.security,
    });
    save.mutate(
      {
        ...(editing ? { id: editing.id } : {}),
        name: name.trim(),
        email: address,
        username: user,
        protocol,
        // Empty keeps the stored password.
        ...(password ? { password } : {}),
        incoming: toServer(incoming),
        outgoing: toServer(outgoing),
        saveSentCopy,
        // Only POP3 accounts send themselves a copy; IMAP stores one in Sent.
        sendCopyToSelf: protocol === "pop3" && sendCopyToSelf,
      },
      { onSuccess: onSaved },
    );
  };

  const field = (key: keyof Problems) => ({
    "aria-invalid": problems[key] ? (true as const) : undefined,
    "aria-describedby": problems[key] ? `account-${key}-problem` : undefined,
  });
  const problem = (key: keyof Problems) =>
    problems[key] && (
      <span id={`account-${key}-problem`} className="mt-1 block text-xs text-red-600">
        {problems[key]}
      </span>
    );
  const serverProblem = Object.keys(problems).some((key) => key.includes("."));

  const serviceSelect = !editing && (
    <label className="block max-w-xs text-sm">
      <span className="mb-1 block opacity-70">메일 서비스</span>
      <select
        value={googleChosen ? GOOGLE_SIGN_IN_CHOICE.id : preset.id}
        onChange={(event) => choosePreset(event.target.value)}
        className={INPUT_CLASS}
      >
        {[GOOGLE_SIGN_IN_CHOICE, ...ACCOUNT_PRESETS].map((item) => (
          <option key={item.id} value={item.id} className="bg-background text-foreground">
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );

  if (!editing && googleChosen) {
    return (
      <div aria-label={title} className="space-y-4 rounded-md border border-foreground/15 p-4">
        <p className="text-sm font-semibold">{title}</p>
        {serviceSelect}
        <GoogleAccountSetup onSignedIn={onSaved} onCancel={onCancel} />
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={title}
      className="space-y-4 rounded-md border border-foreground/15 p-4"
    >
      <p className="text-sm font-semibold">{title}</p>

      {serviceSelect}
      {notes.length > 0 && (
        <ul className="list-disc space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 py-3 pl-8 pr-4 text-xs">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-3">
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block opacity-70">이메일 주소</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={EMAIL_PLACEHOLDERS[preset.id] ?? "me@example.com"}
            spellCheck={false}
            autoFocus
            {...field("email")}
            className={INPUT_CLASS}
          />
          {problem("email")}
        </label>
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block opacity-70">보내는 사람 이름 (선택)</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_ACCOUNT_NAME_LENGTH}
            className={INPUT_CLASS}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block opacity-70">사용자 이름</span>
          <input
            value={username ?? email}
            onChange={(event) => setUsername(event.target.value)}
            maxLength={MAX_USERNAME_LENGTH}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            {...field("username")}
            className={INPUT_CLASS}
          />
          {problem("username")}
        </label>
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block opacity-70">비밀번호</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            maxLength={MAX_PASSWORD_LENGTH}
            autoComplete="new-password"
            placeholder={editing?.hasPassword ? "저장됨 · 바꾸려면 새로 입력" : ""}
            {...field("password")}
            className={INPUT_CLASS}
          />
          {problem("password")}
        </label>
      </div>

      {/* Presets fill the servers in; they stay reachable for the odd exception. */}
      <details open={isCustom || serverProblem} className="text-sm">
        <summary className="cursor-pointer select-none opacity-70">서버 설정</summary>
        <div className="mt-3 space-y-3">
          <ServerFields
            side="incoming"
            kind={protocol}
            legend={`받는 메일 서버 (${incomingLabel})`}
            placeholder={protocol === "pop3" ? "pop.example.com" : "imap.example.com"}
            draft={incoming}
            onChange={setIncoming}
            field={field}
            problem={problem}
          />
          <ServerFields
            side="outgoing"
            kind="smtp"
            legend="보내는 메일 서버 (SMTP)"
            placeholder="smtp.example.com"
            draft={outgoing}
            onChange={setOutgoing}
            field={field}
            problem={problem}
          />
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={saveSentCopy}
              onChange={(event) => setSaveSentCopy(event.target.checked)}
              className="mt-0.5 size-4 shrink-0"
            />
            <span>
              {protocol === "pop3"
                ? "보낸 메일을 이 컴퓨터의 보낸편지함에 보관"
                : "보낸 메일을 보낸편지함에 복사"}
              <span className="block text-xs opacity-70">
                {protocol === "pop3"
                  ? "POP3 서버에는 보낸편지함이 없어 이 컴퓨터에만 저장됩니다."
                  : "보낸 메일이 보낸편지함에 두 통씩 보이면 서버가 스스로 보관하는 것이니 끄세요."}
              </span>
            </span>
          </label>
        </div>
      </details>

      {protocol === "pop3" && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={sendCopyToSelf}
            onChange={(event) => setSendCopyToSelf(event.target.checked)}
            className="mt-0.5 size-4 shrink-0"
          />
          <span>
            보낸 메일 사본을 나에게도 보내 서버에 남기기
            <span className="block text-xs opacity-70">
              POP3로는 서버의 보낸편지함에 저장할 수 없어, 제목 앞에
              &lsquo;{SENT_COPY_SUBJECT_PREFIX.trim()}&rsquo;을 붙인 사본을 내 주소로 보냅니다. 받는
              사람에게 가는 메일은 그대로이고, 이 앱의 받은편지함에는 사본이 보이지
              않습니다.
            </span>
          </span>
        </label>
      )}

      {save.error && <SaveError error={save.error} />}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {save.isPending ? "서버에 로그인해 확인하는 중…" : "연결 확인 후 저장"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5"
          >
            취소
          </button>
        )}
        <p className="text-xs opacity-60">
          비밀번호는 Windows 사용자 계정으로 암호화해 이 컴퓨터에만 저장합니다.
        </p>
      </div>
    </form>
  );
}

function SaveError({ error }: { error: Error }) {
  const code = error instanceof MailApiError ? error.code : null;
  return (
    <p role="alert" className="text-sm text-red-600">
      {mailServerErrorText(error) ??
        (code === "invalid_request"
          ? "저장할 수 없는 값이 있습니다. 이미 추가한 주소가 아닌지, 서버 주소와 포트가 맞는지 확인해 주세요."
          : code === "server_error"
            ? "메일 서버가 요청을 거부했습니다. 서버 설정을 확인해 주세요."
            : "메일 계정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.")}
    </p>
  );
}

/** Host, port, and connection security of one server. */
function ServerFields({
  side,
  kind,
  legend,
  placeholder,
  draft,
  onChange,
  field,
  problem,
}: {
  side: Side;
  kind: ServerKind;
  legend: string;
  placeholder: string;
  draft: ServerDraft;
  onChange: (draft: ServerDraft) => void;
  field: (key: keyof Problems) => object;
  problem: (key: keyof Problems) => ReactNode;
}) {
  return (
    <fieldset className="space-y-2 rounded-md border border-foreground/15 p-3">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block opacity-70">서버 주소</span>
          <input
            value={draft.host}
            onChange={(event) => onChange({ ...draft, host: event.target.value })}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="none"
            {...field(`${side}.host`)}
            className={INPUT_CLASS}
          />
          {problem(`${side}.host`)}
        </label>
        <label className="w-28 text-sm">
          <span className="mb-1 block opacity-70">포트</span>
          <input
            value={draft.port}
            onChange={(event) => onChange({ ...draft, port: event.target.value })}
            inputMode="numeric"
            maxLength={5}
            {...field(`${side}.port`)}
            className={INPUT_CLASS}
          />
          {problem(`${side}.port`)}
        </label>
        <label className="w-40 text-sm">
          <span className="mb-1 block opacity-70">연결 보안</span>
          <select
            value={draft.security}
            onChange={(event) => {
              const security = event.target.value as ServerSecurity;
              onChange({
                ...draft,
                security,
                port: followDefault(
                  draft.port,
                  defaultPort(kind, draft.security),
                  defaultPort(kind, security),
                ),
              });
            }}
            className={INPUT_CLASS}
          >
            {SECURITY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value} className="bg-background text-foreground">
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {draft.security === "none" && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          암호화 없이 연결하면 비밀번호와 메일 내용이 그대로 전송됩니다. 서버가
          지원한다면 SSL/TLS나 STARTTLS를 선택하세요.
        </p>
      )}
    </fieldset>
  );
}
