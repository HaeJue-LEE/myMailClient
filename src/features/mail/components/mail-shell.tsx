"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { MailApiError, useAccount } from "@/features/mail/api";
import { Sidebar } from "@/features/mail/components/sidebar";

export function Unavailable() {
  return (
    <p role="alert" className="p-6 text-sm text-red-600">
      이 화면은 Mail Client 데스크톱 앱 안에서만 동작합니다.
    </p>
  );
}

/** Client-side auth gate: there is no server to redirect unauthenticated users. */
export function MailShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: account, isPending, error } = useAccount();
  const signedOut = !isPending && !error && account === null;

  useEffect(() => {
    if (signedOut) router.replace("/login");
  }, [signedOut, router]);

  if (error instanceof MailApiError && error.code === "unavailable") {
    return <Unavailable />;
  }
  if (!account) return null;

  return (
    <div className="flex h-dvh">
      <Suspense fallback={<aside className="w-60 shrink-0 border-r border-foreground/10" />}>
        <Sidebar account={account} />
      </Suspense>
      {/* Scroll container for the views; their toolbars stick to its top.
          relative: absolutely placed content (e.g. screen-reader-only text)
          stays inside it instead of lengthening the page (a second scrollbar). */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
