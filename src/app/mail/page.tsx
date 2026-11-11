import { Suspense } from "react";
import { MailView } from "@/features/mail/components/mail-view";

export default function MailPage() {
  return (
    <Suspense>
      <MailView />
    </Suspense>
  );
}
