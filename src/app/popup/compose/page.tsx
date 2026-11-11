import { Suspense } from "react";
import { ComposeView } from "@/features/mail/components/compose-view";
import { PopupWindow } from "@/features/mail/components/popup-window";

/** A message being written in a window of its own, without the sidebar. */
export default function PopupComposePage() {
  // Reads the URL (?to=, ?mode=reply…, ?draft=…), resolved on the client.
  return (
    <Suspense>
      <PopupWindow>
        <ComposeView />
      </PopupWindow>
    </Suspense>
  );
}
