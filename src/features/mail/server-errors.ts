import { MailApiError } from "@/features/mail/api";

const SERVER_ERROR_TEXT: Partial<Record<MailApiError["code"], string>> = {
  auth_failed:
    "받는 메일 서버(IMAP/POP3)가 로그인을 거부했습니다. 사용자 이름과 비밀번호를 확인해 주세요.",
  connection_failed:
    "받는 메일 서버(IMAP/POP3)에 연결하지 못했습니다. 서버 주소, 포트, 연결 보안과 네트워크 상태를 확인해 주세요.",
  smtp_auth_failed:
    "보내는 메일 서버(SMTP)가 로그인을 거부했습니다. 사용자 이름과 비밀번호를 확인해 주세요.",
  smtp_connection_failed:
    "보내는 메일 서버(SMTP)에 연결하지 못했습니다. 서버 주소, 포트, 연결 보안과 네트워크 상태를 확인해 주세요.",
};

/**
 * What went wrong with an IMAP account's server, in words; null for any other
 * error, which the caller describes itself.
 */
export function mailServerErrorText(error: unknown): string | null {
  return error instanceof MailApiError
    ? (SERVER_ERROR_TEXT[error.code] ?? null)
    : null;
}
