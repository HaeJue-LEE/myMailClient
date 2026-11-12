"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  MailApiError,
  useAccount,
  useCancelScheduled,
  useRescheduleSend,
  useScheduled,
  useSendScheduledNow,
} from "@/features/mail/api";
import { Icon } from "@/features/mail/components/icon";
import { SCHEDULE_NOTE, SchedulePicker } from "@/features/mail/components/schedule-picker";
import { draftHref } from "@/features/mail/routes";
import { type ScheduledMail, scheduleTimeFormat } from "@/features/mail/scheduled";
import { mailServerErrorText } from "@/features/mail/server-errors";

const BUTTON =
  "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm hover:bg-foreground/10 disabled:opacity-50";

/** "3시간 후", "곧", or "시간 지남" next to the time it is sent at. */
function fromNow(sendAt: number, now: number) {
  const minutes = Math.round((sendAt - now) / 60000);
  if (minutes < -1) return "시간 지남";
  if (minutes <= 1) return "곧";
  if (minutes < 60) return `${minutes}분 후`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}시간 후`;
  return `${Math.round(hours / 24)}일 후`;
}

function failureText(mail: ScheduledMail) {
  if (mail.interrupted) {
    return "보내는 중에 앱이 종료됐습니다. 보낸편지함에서 보내졌는지 확인한 뒤, 다시 보내거나 취소해 주세요.";
  }
  const reason = mail.error ? mailServerErrorText(new MailApiError(mail.error)) : null;
  return `보내지 못했습니다. ${reason ?? "네트워크와 계정 상태를 확인한 뒤 다시 보내 주세요."}`;
}

/** The scheduled messages of every account: when they go, and changing or stopping them. */
export function ScheduledView() {
  const { data: list, isPending, isError, refetch } = useScheduled();
  const accounts = new Set(list?.map((mail) => mail.accountEmail));
  // For "3시간 후": refreshed as often as the list is.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-foreground/10 bg-background px-4 py-2.5">
        <h1 className="text-base font-semibold">예약 메일</h1>
        {list && list.length > 0 && <span className="text-sm opacity-60">{list.length}통</span>}
      </div>
      <div className="space-y-4 p-4">
        <p className="text-xs opacity-60">{SCHEDULE_NOTE}</p>
        {isPending ? (
          <p className="text-sm opacity-60">불러오는 중…</p>
        ) : isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p className="text-red-600">예약 메일을 불러오지 못했습니다.</p>
            <button type="button" onClick={() => void refetch()} className={`${BUTTON} border border-foreground/20`}>
              다시 시도
            </button>
          </div>
        ) : list.length === 0 ? (
          <p className="py-8 text-center text-sm opacity-60">
            예약한 메일이 없습니다. 메일을 쓸 때 보내기 옆의 <b>예약</b>을 누르면 보낼 시간을 정할 수 있습니다.
          </p>
        ) : (
          <ul className="divide-y divide-foreground/10 rounded-md border border-foreground/15">
            {list.map((mail) => (
              <ScheduledRow key={mail.id} mail={mail} now={now} showAccount={accounts.size > 1} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ScheduledRow({
  mail,
  now,
  showAccount,
}: {
  mail: ScheduledMail;
  now: number;
  showAccount: boolean;
}) {
  const router = useRouter();
  const activeId = useAccount().data?.id;
  const sendNow = useSendScheduledNow();
  const reschedule = useRescheduleSend();
  const cancel = useCancelScheduled();
  const [confirming, setConfirming] = useState<"cancel" | "discard" | null>(null);
  const busy = mail.status === "sending" || sendNow.isPending || reschedule.isPending || cancel.isPending;
  const failed = mail.status === "failed";

  /** Back to drafts and open it there, when it belongs to the account in use. */
  const edit = () =>
    cancel.mutate(
      { id: mail.id },
      {
        onSuccess: ({ draftId }) => {
          if (draftId && mail.accountId === activeId) router.push(draftHref(draftId));
        },
      },
    );

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{mail.subject || "(제목 없음)"}</p>
          <p className="truncate text-xs opacity-70">
            받는사람 {mail.to.join(", ")}
            {mail.attachmentCount > 0 && ` · 첨부 ${mail.attachmentCount}개`}
            {showAccount && ` · ${mail.accountEmail}에서`}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="flex items-center justify-end gap-1 text-sm tabular-nums">
            <Icon name="clock" className="opacity-60" />
            {scheduleTimeFormat.format(mail.sendAt)}
          </p>
          <p className={`text-xs ${failed ? "text-red-600" : "opacity-60"}`}>
            {mail.status === "sending" ? "보내는 중…" : failed ? "보내지 못함" : fromNow(mail.sendAt, now)}
          </p>
        </div>
      </div>

      {failed && (
        <p role="alert" className="rounded-md bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          {failureText(mail)}
        </p>
      )}
      {(sendNow.isError || reschedule.isError || cancel.isError) && (
        <p role="alert" className="text-xs text-red-600">
          {cancel.isError
            ? "취소하지 못했습니다. 계정이 없어졌다면 '삭제'로 지워 주세요."
            : reschedule.isError
              ? "시간을 바꾸지 못했습니다. 1분 뒤 ~ 1년 안의 시간을 골라 주세요."
              : "보내지 못했습니다. 잠시 후 다시 시도해 주세요."}
        </p>
      )}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {confirming === "cancel"
              ? "예약을 취소하고 임시보관함으로 옮길까요?"
              : "이 메일을 보내지 않고 완전히 삭제할까요? 되돌릴 수 없습니다."}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              cancel.mutate(
                { id: mail.id, discard: confirming === "discard" },
                { onSettled: () => setConfirming(null) },
              )
            }
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
              confirming === "discard" ? "bg-red-600 text-white" : "bg-foreground text-background"
            }`}
          >
            {confirming === "cancel" ? "예약 취소" : "삭제"}
          </button>
          <button type="button" autoFocus onClick={() => setConfirming(null)} className={BUTTON}>
            그대로 두기
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" disabled={busy} onClick={() => sendNow.mutate(mail.id)} className={BUTTON}>
            <Icon name="forward" />
            {sendNow.isPending ? "보내는 중…" : failed ? "다시 보내기" : "지금 보내기"}
          </button>
          <SchedulePicker
            disabled={busy}
            onPick={(sendAt) => reschedule.mutate({ id: mail.id, sendAt })}
            className={BUTTON}
          >
            <Icon name="calendar" />
            시간 바꾸기
          </SchedulePicker>
          <button
            type="button"
            disabled={busy}
            onClick={edit}
            title={
              mail.accountId === activeId
                ? "예약을 풀고 임시보관함에서 이어서 씁니다"
                : `예약을 풀고 ${mail.accountEmail}의 임시보관함으로 옮깁니다`
            }
            className={BUTTON}
          >
            <Icon name="edit" />
            수정
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming("cancel")} className={BUTTON}>
            <Icon name="close" />
            예약 취소
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming("discard")}
            className={`${BUTTON} ml-auto text-red-600`}
          >
            <Icon name="trash" />
            삭제
          </button>
        </div>
      )}
    </li>
  );
}
