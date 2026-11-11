"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MailApiError, useAccount, useLogin } from "@/features/mail/api";
import { MailAccountForm } from "@/features/mail/components/mail-account-form";
import { Unavailable } from "@/features/mail/components/mail-shell";

/** Shown while no account exists: sign in to Google, or add an IMAP account. */
export function LoginScreen() {
  const router = useRouter();
  const { data: account, error: accountError } = useAccount();
  const { mutate: login, isPending, error } = useLogin();
  const [addingMailAccount, setAddingMailAccount] = useState(false);

  useEffect(() => {
    if (account) router.replace("/mail");
  }, [account, router]);

  if (accountError instanceof MailApiError && accountError.code === "unavailable") {
    return <Unavailable />;
  }

  if (addingMailAccount) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 overflow-y-auto p-6">
        <h1 className="text-2xl font-semibold">Mail Client</h1>
        {/* Saving the first account reloads into the mail view. */}
        <MailAccountForm
          onSaved={() => undefined}
          onCancel={() => setAddingMailAccount(false)}
        />
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Mail Client</h1>
      {isPending && (
        <p className="text-sm opacity-70">
          브라우저에서 Google 로그인을 완료해 주세요.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error instanceof MailApiError && error.code === "login_cancelled"
            ? "로그인이 취소되었습니다."
            : "Google 로그인에 실패했습니다. 권한을 모두 허용했는지 확인하고 다시 시도해 주세요."}
        </p>
      )}
      <div className="flex flex-col items-stretch gap-2">
        {/* Stays enabled while waiting: clicking again reopens the browser and cancels the old attempt. */}
        <button
          type="button"
          onClick={() => login()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          {isPending ? "브라우저 다시 열기" : "Google 계정으로 로그인"}
        </button>
        <button
          type="button"
          onClick={() => setAddingMailAccount(true)}
          className="rounded-md border border-foreground/20 px-4 py-2 text-sm font-medium hover:bg-foreground/5"
        >
          네이버 등 다른 메일 계정 추가
        </button>
      </div>
    </main>
  );
}
