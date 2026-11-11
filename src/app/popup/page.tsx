import { Suspense } from "react";
import { PopupThread } from "@/features/mail/components/popup-thread";

/** A thread in a window of its own, without the sidebar. */
export default function PopupPage() {
  return (
    <Suspense>
      <PopupThread />
    </Suspense>
  );
}
