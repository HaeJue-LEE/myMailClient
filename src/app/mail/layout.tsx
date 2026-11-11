import { MailShell } from "@/features/mail/components/mail-shell";

export default function MailLayout({ children }: LayoutProps<"/mail">) {
  return <MailShell>{children}</MailShell>;
}
