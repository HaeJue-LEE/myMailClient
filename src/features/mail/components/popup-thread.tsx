"use client";

import { useSearchParams } from "next/navigation";
import { PopupWindow } from "@/features/mail/components/popup-window";
import { ThreadView } from "@/features/mail/components/thread-view";
import { DEFAULT_LABEL } from "@/features/mail/routes";

/** The thread named in the URL, in a pop-up window. */
export function PopupThread() {
  const params = useSearchParams();
  const threadId = params.get("thread");
  // The folder it was opened from decides its actions (e.g. restore in Trash).
  const label = params.get("label") || DEFAULT_LABEL;

  return (
    <PopupWindow>
      {threadId ? (
        <ThreadView list={{ label }} threadId={threadId} popup />
      ) : (
        <p role="alert" className="p-6 text-sm">
          열 메일이 없습니다.
        </p>
      )}
    </PopupWindow>
  );
}
