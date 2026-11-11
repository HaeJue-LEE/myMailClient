import { z } from "zod";
import { emailSchema } from "@/features/mail/email";

/**
 * Mail accounts: the Google account (Gmail API) and any number of IMAP/SMTP
 * accounts such as Naver, and POP3/SMTP accounts such as Hiworks. Shared by
 * the screens and the main process.
 */
export type AccountKind = "gmail" | "imap" | "pop3";

/** How an account's incoming mail is read. */
export const INCOMING_PROTOCOLS = ["imap", "pop3"] as const;
export type IncomingProtocol = (typeof INCOMING_PROTOCOLS)[number];

/** The id of the one Google account; IMAP accounts have generated ids. */
export const GMAIL_ACCOUNT_ID = "gmail";

export type Account = {
  id: string;
  kind: AccountKind;
  email: string;
  /** Display name for the From header; may be empty. */
  name: string;
  /**
   * The picture chosen for the account, as a `data:image/png` URL; absent
   * when none was chosen (its first letter is shown) or not looked up.
   */
  avatar?: string | null;
};

/**
 * `accounts` in the order the user chose (`order`: account ids). Accounts not
 * in it (e.g. added since) keep their place relative to each other, after
 * the ordered ones.
 */
export function sortAccounts<T extends { id: string }>(accounts: T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return accounts
    .map((account, index) => ({ account, key: rank.get(account.id) ?? order.length + index }))
    .sort((a, b) => a.key - b.key)
    .map(({ account }) => account);
}

export const SECURITY_MODES = ["ssl", "starttls", "none"] as const;
export type ServerSecurity = (typeof SECURITY_MODES)[number];

export type ServerKind = IncomingProtocol | "smtp";

const DEFAULT_PORTS: Record<ServerKind, Record<ServerSecurity, number>> = {
  imap: { ssl: 993, starttls: 143, none: 143 },
  pop3: { ssl: 995, starttls: 110, none: 110 },
  smtp: { ssl: 465, starttls: 587, none: 25 },
};

/** The standard port for a protocol and connection security. */
export function defaultPort(kind: ServerKind, security: ServerSecurity) {
  return DEFAULT_PORTS[kind][security];
}

export const MAX_ACCOUNT_NAME_LENGTH = 100;
export const MAX_USERNAME_LENGTH = 320;
export const MAX_PASSWORD_LENGTH = 1024;

/** A DNS name or IPv4 address: no scheme, port, path, or spaces. */
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/);

const portSchema = z.number().int().min(1).max(65535);

export function isHostname(value: string) {
  return hostSchema.safeParse(value).success;
}

export function isPort(value: number) {
  return portSchema.safeParse(value).success;
}

const endpointSchema = z.object({
  host: hostSchema,
  port: portSchema,
  security: z.enum(SECURITY_MODES),
});
export type ServerEndpoint = z.infer<typeof endpointSchema>;

export const mailAccountInputSchema = z.object({
  /** The account being changed; absent when adding one. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().max(MAX_ACCOUNT_NAME_LENGTH),
  email: emailSchema,
  /** Signs in to both servers. */
  username: z.string().trim().min(1).max(MAX_USERNAME_LENGTH),
  /** Absent for accounts saved before POP3 was supported: those are IMAP. */
  protocol: z.enum(INCOMING_PROTOCOLS).default("imap"),
  /** Left empty (or omitted) when editing to keep the stored password. */
  password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  incoming: endpointSchema,
  outgoing: endpointSchema,
  /**
   * Copy sent mail into the Sent folder. Off for servers that already keep a
   * copy of what goes through their SMTP server, or it would appear twice.
   */
  saveSentCopy: z.boolean(),
  /**
   * POP3 accounts: also send each mail to this address, so a copy stays on
   * the server (POP3 cannot store one). The copy's subject is prefixed with
   * `SENT_COPY_SUBJECT_PREFIX`; the recipients' message is unchanged.
   */
  sendCopyToSelf: z.boolean().default(false),
});

/** Marks the copy sent to the account itself; only that copy carries it. */
export const SENT_COPY_SUBJECT_PREFIX = "[내가보낸메일] ";

export type MailAccountInput = z.infer<typeof mailAccountInputSchema>;

/** A stored IMAP or POP3 account. The password never leaves the main process. */
export type MailAccountSettings = Omit<MailAccountInput, "id" | "password"> & {
  id: string;
  hasPassword: boolean;
};

export type AccountPreset = {
  id: string;
  label: string;
  protocol: IncomingProtocol;
  incoming: ServerEndpoint;
  outgoing: ServerEndpoint;
  saveSentCopy: boolean;
  sendCopyToSelf?: boolean;
  /** What must be set up at the provider before signing in works. */
  notes: string[];
};

export const ACCOUNT_PRESETS: AccountPreset[] = [
  {
    id: "naver",
    label: "네이버 메일",
    protocol: "imap",
    incoming: { host: "imap.naver.com", port: 993, security: "ssl" },
    outgoing: { host: "smtp.naver.com", port: 465, security: "ssl" },
    // Whether Naver files SMTP mail under Sent by itself is unconfirmed: a
    // duplicate is visible and one checkbox from fixed, a missing copy is not.
    saveSentCopy: true,
    notes: [
      "네이버 메일 → 환경설정 → POP3/IMAP 설정 → IMAP/SMTP 설정에서 '사용함'으로 바꿔 주세요.",
      "네이버 로그인 비밀번호로 로그인이 거부되면 애플리케이션 비밀번호를 만들어 넣어 주세요. (네이버 → 내 정보 → 보안설정 → 2단계 인증 → 애플리케이션 비밀번호 관리)",
      "사용자 이름은 네이버 메일 주소 전체(예: id@naver.com)를 넣습니다. 거부되면 @ 앞의 아이디만 넣어 보세요.",
    ],
  },
  {
    id: "hiworks",
    label: "하이웍스 메일 (POP3)",
    protocol: "pop3",
    incoming: { host: "pop3s.hiworks.com", port: 995, security: "ssl" },
    outgoing: { host: "smtps.hiworks.com", port: 465, security: "ssl" },
    // POP3 has no Sent folder: the copy is kept on this computer.
    saveSentCopy: true,
    // Hiworks does not keep SMTP mail in its Sent folder (checked by sending one).
    sendCopyToSelf: true,
    notes: [
      "하이웍스 메일은 POP3로 받습니다. 목록에는 제목·보낸사람·날짜만 받아 오고, 본문은 메일을 열 때 받습니다.",
      "서버의 메일은 지우지 않습니다. 읽음 표시·임시보관함·보낸편지함은 이 컴퓨터에만 저장됩니다.",
      "하이웍스 메일 → 메일 환경설정 → 기본 설정 → POP3/SMTP에서 '사용 함'을 선택해 주세요. 회사 관리자가 막아 둔 경우도 있습니다.",
      "OTP 로그인을 쓰면 하이웍스 비밀번호 대신 같은 화면에서 만든 '메일 전용 비밀번호'를 넣어 주세요.",
      "POP3로는 최근 6개월 메일만 받습니다(같은 화면의 '수신 대상'). '읽음 표시'가 'POP3로 가져간 메일 읽음 표시'이면 이 앱에서 받은 메일이 웹메일에서도 읽음으로 바뀔 수 있습니다.",
      "SMTP로 보낸 메일은 하이웍스 웹메일의 보낸메일함에 저장되지 않습니다(직접 확인함). 그래서 보낼 때마다 제목에 [내가보낸메일]을 붙인 사본을 나에게도 보내 서버에 남깁니다(서버 설정에서 끌 수 있음). 이 앱의 받은편지함에는 그 사본이 보이지 않습니다.",
      "웹메일에서도 사본을 보낸메일함에 모아 보려면: 하이웍스 메일 → 메일 환경설정 → 메일 자동분류에서 '제목에 [내가보낸메일] 포함 → 보낸메일함으로 이동' 규칙을 만들어 주세요.",
      "사용자 이름은 메일 주소 전체(예: id@회사도메인)를 넣어 보세요. 거부되면 @ 앞의 아이디만 넣어 보세요.",
    ],
  },
  {
    id: "custom",
    label: "직접 입력 (IMAP/SMTP)",
    protocol: "imap",
    incoming: { host: "", port: 993, security: "ssl" },
    outgoing: { host: "", port: 465, security: "ssl" },
    saveSentCopy: true,
    notes: [],
  },
  {
    id: "custom-pop3",
    label: "직접 입력 (POP3/SMTP)",
    protocol: "pop3",
    incoming: { host: "", port: 995, security: "ssl" },
    outgoing: { host: "", port: 465, security: "ssl" },
    saveSentCopy: true,
    notes: [
      "POP3는 받은편지함만 있습니다. 읽음 표시·임시보관함·보낸편지함은 이 컴퓨터에만 저장되고, 서버의 메일은 지우지 않습니다.",
    ],
  },
];

/**
 * The preset a stored account matches, for showing its notes when it is
 * edited: the provider whose incoming server it uses, else the custom preset
 * of its protocol.
 */
export function presetFor(
  account: Pick<MailAccountSettings, "protocol" | "incoming">,
): AccountPreset | undefined {
  const host = account.incoming.host.toLowerCase();
  return (
    ACCOUNT_PRESETS.find(
      (item) =>
        item.protocol === account.protocol && item.incoming.host !== "" && item.incoming.host === host,
    ) ??
    ACCOUNT_PRESETS.find(
      (item) => item.protocol === account.protocol && item.id.startsWith("custom"),
    )
  );
}
