# Mail Client (myMailClient)

Gmail(Gmail API)과 네이버 등 IMAP/SMTP 메일 계정을 함께 쓰는 Windows 데스크톱 이메일 클라이언트입니다.
계정은 여러 개 추가할 수 있고, 왼쪽 아래 계정 선택이나 **메일 계정** 화면에서 사용할 계정을 고릅니다.
화면은 Next.js, 실행은 Electron으로 구성되며, 서버를 따로 실행하지 않습니다.

## 준비

Google 로그인(Gmail API·Google 주소록)은 **선택 사항**입니다. 아래 설정 없이 빌드하면 Google 로그인만 빠지고,
IMAP·POP3 계정(Gmail도 앱 비밀번호로 IMAP 연결 가능)은 그대로 쓸 수 있습니다. 남에게 나눠 줄 실행 파일은
`.env.local` 없이 빌드하세요. 있으면 클라이언트 ID와 시크릿이 실행 파일 안에 들어갑니다.

Google 로그인을 쓰려면:

1. [Google Cloud Console](https://console.cloud.google.com/)에서 **Gmail API**와 **People API**(연락처)를 사용 설정합니다.
2. **Google 인증 플랫폼 → 대상**에서 사용할 Gmail 계정을 테스트 사용자로 추가합니다.
   **데이터 액세스**에는 다음 범위를 추가합니다.
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/contacts` (Google 주소록 읽기·추가)
   - `https://www.googleapis.com/auth/contacts.other.readonly` (메일을 주고받은 사람)
3. **Google 인증 플랫폼 → 클라이언트**에서 애플리케이션 유형을 **데스크톱 앱**으로 선택해 클라이언트를 만듭니다.
   리디렉션 URI는 등록하지 않아도 됩니다.
4. `.env.example`을 `.env.local`로 복사하고 클라이언트 ID와 시크릿을 넣습니다.

## 네이버 등 IMAP 계정

**메일 계정 → 메일 계정 추가**에서 추가합니다. 저장할 때 IMAP·SMTP 서버에 실제로 로그인해 보고, 성공해야 저장됩니다.

- 네이버: 메일 환경설정에서 **IMAP/SMTP 사용함**으로 바꿉니다. 로그인 비밀번호가 거부되면 2단계 인증의 **애플리케이션 비밀번호**를 만들어 입력합니다. (imap.naver.com:993, smtp.naver.com:465, SSL)
- IMAP 계정은 메일 한 통을 대화 하나로 보여 주며, 검색은 받은편지함에서 합니다. Google 주소록·보관·중요 편지함은 Google 계정 전용입니다.
- 서버 설정은 `%APPDATA%\Mail Client\accounts.json`에, 비밀번호는 `safeStorage`로 암호화해 같은 파일에 저장합니다.

## 명령어

| 명령어 | 설명 |
| --- | --- |
| `npm run dist` | 실행 파일 생성 → `release/MailClient-<버전>-portable.exe` |
| `npm run dist:public` | 남에게 줄 실행 파일 생성 → `release/MailClient-<버전>.exe`. Google 키를 넣지 않고, 처음 실행하면 exe 옆 `Mail Client` 폴더에 앱을 풀어 둔 뒤 실행합니다(이후 실행은 바로 시작). Rust(`cargo`)가 필요합니다 |
| `npm start` | 빌드 후 앱 실행 |
| `npm run dev` | 개발 모드 (Next 개발 서버 + 앱). `src/` 수정은 즉시 반영, `electron/`·`.env.local` 수정은 앱 자동 재시작. 앱 창을 닫으면 종료 |
| `npm test` | 단위 테스트 |
| `npm run typecheck` / `npm run lint` | 타입 검사 / ESLint |

`release/` 폴더의 `.exe` 파일 하나만 있으면 설치 없이 실행됩니다.
코드 서명을 하지 않았으므로 처음 실행할 때 Windows SmartScreen 경고가 나오면 **추가 정보 → 실행**을 누릅니다.

## 구조

```
electron/            메인 프로세스 (Node.js)
  main.ts            창, app:// 프로토콜, 외부 링크 처리
  auth.ts            Google 로그인(시스템 브라우저 + 루프백), 토큰 암호화 저장
  accounts.ts        IMAP 계정 목록과 사용 중인 계정 (비밀번호 암호화 저장)
  backend.ts         계정 종류와 무관한 메일 기능 인터페이스, 사용 중인 계정 선택
  ipc.ts             화면 요청 검증 후 사용 중인 계정의 백엔드 호출
  preload.ts         화면에 window.mailApi만 노출
  gmail/             Gmail 서비스, 메시지 파싱, MIME 생성
  imap/              IMAP 연결·폴더 매핑·검색 변환·메시지 파싱, SMTP 전송
src/                 화면 (Next.js 정적 내보내기 → out/)
  app/               /login, /mail?label=…&thread=…, /mail/compose
  features/mail/     컴포넌트, React Query 훅, 브리지 타입, HTML 정화
scripts/             Electron 번들 스크립트 (esbuild)
```

## 설계 원칙

- **화면은 Google 토큰을 받지 않습니다.** Gmail 호출은 메인 프로세스만 하고, 화면은 IPC로 결과만 받습니다.
- **토큰은 Windows 사용자 계정으로 암호화됩니다.** 리프레시 토큰은 `safeStorage`(DPAPI)로 암호화해 `%APPDATA%\Mail Client\account.bin`에 저장합니다.
- **로그인은 시스템 브라우저에서 합니다.** Google이 앱 내장 브라우저 로그인을 차단하기 때문입니다.
- **메일 HTML은 신뢰하지 않습니다.** DOMPurify로 정화하고 CSP를 적용한 샌드박스 iframe에 표시하며, 링크는 기본 브라우저로 엽니다.

## 운영 시 주의사항

- OAuth 앱이 "테스트" 상태이면 **리프레시 토큰이 7일 후 만료**되어 다시 로그인해야 합니다.
- `gmail.modify`는 Google의 **제한된 범위**입니다. 불특정 사용자에게 배포하려면 OAuth 앱 검증이 필요합니다.
- `.env.local`이 있으면 클라이언트 ID와 시크릿이 실행 파일에 포함됩니다. 데스크톱 앱용 클라이언트에서는 Google도 이 값을 비밀로 취급하지 않으며, PKCE가 로그인을 보호합니다. 다만 실행 파일을 공개하면 누구나 이 값을 꺼내 같은 앱 이름으로 로그인 화면을 띄울 수 있으니, 배포용은 `.env.local` 없이 빌드하세요.
