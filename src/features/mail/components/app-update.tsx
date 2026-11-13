"use client";

import { useState } from "react";
import {
  useCancelUpdateDownload,
  useCheckForUpdate,
  useDownloadUpdate,
  useRestartToUpdate,
  useUpdateStatus,
} from "@/features/mail/api";
import type { UpdateStatus } from "@/features/mail/bridge";

const BUTTON =
  "shrink-0 rounded-md border border-foreground/20 px-2.5 py-1.5 text-sm hover:bg-foreground/5 disabled:opacity-50";
const PRIMARY =
  "shrink-0 rounded-md bg-foreground px-2.5 py-1.5 text-sm font-medium text-background disabled:opacity-50";

const percent = (status: UpdateStatus) =>
  status.total ? Math.floor(((status.received ?? 0) / status.total) * 100) : 0;

const megabytes = (bytes = 0) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** Progress of a download as a bar and "12.3MB / 142.9MB (8%)". */
function Progress({ status }: { status: UpdateStatus }) {
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={`새 버전 ${status.version ?? ""} 받는 중`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent(status)}
        className="h-2 w-full overflow-hidden rounded-full bg-foreground/10"
      >
        <div className="h-full bg-blue-600 transition-[width]" style={{ width: `${percent(status)}%` }} />
      </div>
      <p className="text-xs tabular-nums opacity-70">
        {megabytes(status.received)} / {megabytes(status.total)} ({percent(status)}%)
      </p>
    </div>
  );
}

/** The release notes, as text (they are Markdown from GitHub, never shown as HTML). */
function Notes({ notes }: { notes?: string }) {
  if (!notes) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none opacity-70">새 버전 안내 보기</summary>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-foreground/5 p-3 font-sans">
        {notes}
      </pre>
    </details>
  );
}

/**
 * The buttons and progress for where updating stands: asked before
 * downloading, progress while it runs, asked again before restarting.
 * `onLater` hides the asking (the prompt); without it no "later" is offered.
 */
function UpdateSteps({ status, onLater }: { status: UpdateStatus; onLater?: () => void }) {
  const check = useCheckForUpdate();
  const download = useDownloadUpdate();
  const cancel = useCancelUpdateDownload();
  const restart = useRestartToUpdate();
  const later = onLater && (
    <button type="button" onClick={onLater} className={BUTTON}>
      나중에
    </button>
  );

  switch (status.state) {
    case "available":
      return (
        <div className="space-y-2">
          <p className="text-sm">
            새 버전 <b>{status.version}</b>이(가) 있습니다
            {status.total ? ` (${megabytes(status.total)})` : ""}. 업데이트할까요?
          </p>
          <Notes notes={status.notes} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={download.isPending}
              onClick={() => download.mutate()}
              className={PRIMARY}
            >
              업데이트
            </button>
            {later}
          </div>
        </div>
      );
    case "downloading":
      return (
        <div className="space-y-2">
          <p className="text-sm">새 버전 {status.version}을(를) 받는 중입니다…</p>
          <Progress status={status} />
          <button
            type="button"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
            className={BUTTON}
          >
            취소
          </button>
        </div>
      );
    case "ready":
      return (
        <div className="space-y-2">
          <p className="text-sm">
            새 버전 <b>{status.version}</b>을(를) 다 받았습니다. 지금 다시 시작해 설치할까요?
          </p>
          <p className="text-xs opacity-70">
            쓰던 메일은 임시보관함에 저장됩니다. 나중에 하면 앱을 종료할 때 설치되어 다음 실행부터 새
            버전입니다.
          </p>
          {restart.isError && (
            <p role="alert" className="text-xs text-red-600">
              설치하지 못했습니다. 앱을 종료했다가 다시 실행해 주세요.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={restart.isPending}
              onClick={() => restart.mutate()}
              className={PRIMARY}
            >
              지금 다시 시작
            </button>
            {later}
          </div>
        </div>
      );
    case "error":
      return (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-red-600">
            {status.error === "download"
              ? `새 버전 ${status.version ?? ""}을(를) 받지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.`
              : "업데이트를 확인하지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요."}
          </p>
          <div className="flex flex-wrap gap-2">
            {status.error === "download" ? (
              <button
                type="button"
                disabled={download.isPending}
                onClick={() => download.mutate()}
                className={BUTTON}
              >
                다시 받기
              </button>
            ) : (
              <button
                type="button"
                disabled={check.isPending}
                onClick={() => check.mutate()}
                className={BUTTON}
              >
                다시 확인
              </button>
            )}
            {later}
          </div>
        </div>
      );
    default:
      return null;
  }
}

/** The installed version and updates, on the 메일 계정 page. */
export function AppUpdate() {
  const { data: status } = useUpdateStatus();
  const check = useCheckForUpdate();
  if (!status) return null;

  const idle = status.state === "idle" || status.state === "latest" || status.state === "checking";
  return (
    <section aria-labelledby="update-title" className="space-y-3 rounded-md border border-foreground/15 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="update-title" className="text-sm font-semibold">
          앱 버전
        </h2>
        <span className="text-sm">
          설치된 버전 <b className="tabular-nums">{status.currentVersion}</b>
        </span>
        {idle && (
          <button
            type="button"
            disabled={check.isPending || status.state === "checking"}
            onClick={() => check.mutate()}
            className={`${BUTTON} ml-auto`}
          >
            {status.state === "checking" ? "확인하는 중…" : "업데이트 확인"}
          </button>
        )}
      </div>
      {status.state === "unsupported" && (
        <p className="text-xs opacity-70">
          {status.reason === "local"
            ? "이 PC용 빌드(-local)는 자동으로 업데이트하지 않습니다. 새 버전은 npm run dist로 다시 만들어 주세요."
            : status.reason === "mac"
              ? "맥용 앱은 자동으로 업데이트하지 않습니다. 새 버전은 새로 받아 응용 프로그램 폴더의 앱을 바꿔 주세요."
              : "설치한 실행 파일(MailClient-<버전>.exe)로 실행하지 않아 업데이트를 확인하지 않습니다."}
        </p>
      )}
      {status.state === "latest" && <p className="text-xs opacity-70">최신 버전입니다.</p>}
      {status.state === "idle" && (
        <p className="text-xs opacity-70">새 버전은 앱을 시작할 때 GitHub에서 확인합니다.</p>
      )}
      <UpdateSteps status={status} />
    </section>
  );
}

/** Which prompts the user put off this session ("나중에"), by state and version. */
const laterKey = (status: UpdateStatus) => `${status.state}:${status.version ?? ""}`;

/**
 * Asks in the corner of the main window when a new version is found (and
 * again when it is downloaded), and shows the download's progress. "나중에"
 * puts it off for this session; the sidebar and the 메일 계정 page still offer it.
 */
export function UpdatePrompt({ showVersion = false }: {
  /** Where there is no sidebar (the first screen): the installed version when nothing is asked. */
  showVersion?: boolean;
}) {
  const { data: status } = useUpdateStatus();
  const [putOff, setPutOff] = useState<ReadonlySet<string>>(new Set());
  if (!status) return null;
  const asking =
    ["available", "downloading", "ready", "error"].includes(status.state) &&
    // A failed background check is not worth interrupting for; a failed download is.
    !(status.state === "error" && status.error !== "download") &&
    !putOff.has(laterKey(status));
  if (!asking) {
    return showVersion ? (
      <p className="fixed bottom-3 right-4 text-xs tabular-nums opacity-50">
        Mail Client {status.currentVersion}
      </p>
    ) : null;
  }

  return (
    <div
      role="dialog"
      aria-label="Mail Client 업데이트"
      className="fixed bottom-4 right-4 z-40 w-80 space-y-2 rounded-lg border border-foreground/15 bg-background p-4 shadow-xl"
    >
      <p className="text-xs font-semibold opacity-70">
        Mail Client 업데이트 · 설치된 버전 {status.currentVersion}
      </p>
      <UpdateSteps
        status={status}
        onLater={() => setPutOff((current) => new Set(current).add(laterKey(status)))}
      />
    </div>
  );
}

/**
 * The bottom of the sidebar: the installed version, and a short line while
 * a new version is available, downloading, or ready.
 */
export function UpdateNotice() {
  const { data: status } = useUpdateStatus();
  const download = useDownloadUpdate();
  const restart = useRestartToUpdate();
  if (!status) return null;

  return (
    <div className="space-y-1.5 border-t border-foreground/10 px-3 py-2 text-xs">
      {status.state === "available" && (
        <div className="flex items-center gap-2">
          <p className="flex-1">새 버전 {status.version} 있음</p>
          <button
            type="button"
            disabled={download.isPending}
            onClick={() => download.mutate()}
            className="rounded-md bg-foreground px-2 py-1 font-medium text-background disabled:opacity-50"
          >
            업데이트
          </button>
        </div>
      )}
      {status.state === "downloading" && (
        <div role="status" className="space-y-1">
          <p className="opacity-70">새 버전 {status.version} 받는 중</p>
          <Progress status={status} />
        </div>
      )}
      {status.state === "ready" && (
        <div className="flex items-center gap-2">
          <p className="flex-1">새 버전 {status.version} 준비됨</p>
          <button
            type="button"
            disabled={restart.isPending}
            onClick={() => restart.mutate()}
            title="앱을 다시 시작해 새 버전을 설치합니다. 쓰던 메일은 임시보관함에 저장됩니다."
            className="rounded-md bg-foreground px-2 py-1 font-medium text-background disabled:opacity-50"
          >
            다시 시작
          </button>
        </div>
      )}
      <p className="tabular-nums opacity-50">Mail Client {status.currentVersion}</p>
    </div>
  );
}
