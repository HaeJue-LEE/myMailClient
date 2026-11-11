"use client";

import { useSearchParams } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import { MailApiError, useAccount } from "@/features/mail/api";
import { Unavailable } from "@/features/mail/components/mail-shell";

function Notice({ children }: { children: string }) {
  return (
    <div className="space-y-3 p-6 text-sm">
      <p role="alert">{children}</p>
      <button
        type="button"
        onClick={() => window.close()}
        className="rounded-md border border-foreground/20 px-3 py-1.5"
      >
        창 닫기
      </button>
    </div>
  );
}

/**
 * A pop-up window's page: shown only while the account it was opened for
 * (`?account=`) is the one in use. The main process serves the account in
 * use, so after a switch the window says so rather than mixing accounts.
 */
export function PopupWindow({ children }: { children: ReactNode }) {
  const accountId = useSearchParams().get("account");
  const { data: account, isPending, error } = useAccount();

  if (error instanceof MailApiError && error.code === "unavailable") return <Unavailable />;
  if (isPending) return <p className="p-6 text-sm opacity-60">불러오는 중…</p>;
  if (!account || account.id !== accountId) {
    return (
      <Notice>
        이 창을 연 계정이 지금 사용 중인 계정이 아닙니다. 기본 창에서 해당 계정으로 바꾼 뒤
        다시 열어 주세요.
      </Notice>
    );
  }
  return (
    <PopupWindowContext.Provider value>
      {/* The scroll container toolbars stick to, as <main> is in the main window. */}
      <main className="h-dvh overflow-y-auto">{children}</main>
    </PopupWindowContext.Provider>
  );
}

/**
 * True inside a pop-up window (a thread or a message being written in a
 * window of its own): such screens close their window instead of navigating.
 */
const PopupWindowContext = createContext(false);

export function usePopupWindow() {
  return useContext(PopupWindowContext);
}

declare global {
  interface Window {
    /**
     * Called by the main process before it closes this window (by its close
     * button too), which waits for the returned promise, e.g. to save a draft.
     */
    mailClientBeforeClose?: () => Promise<unknown>;
  }
}

/** Runs `task` before the window closes, however it is closed. */
export function useBeforeWindowClose(task: () => Promise<unknown>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    window.mailClientBeforeClose = task;
    return () => {
      if (window.mailClientBeforeClose === task) delete window.mailClientBeforeClose;
    };
  }, [task, enabled]);
}
