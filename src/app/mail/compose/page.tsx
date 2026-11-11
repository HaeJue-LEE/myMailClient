import { Suspense } from "react";
import { ComposeView } from "@/features/mail/components/compose-view";

export default function ComposePage() {
  // Reads the URL (?to=, ?mode=reply…), which a static export resolves on the client.
  return (
    <Suspense>
      <ComposeView />
    </Suspense>
  );
}
