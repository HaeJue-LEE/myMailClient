import { AppsShell } from "@/features/apps/components/apps-shell";

export default function AppsLayout({ children }: LayoutProps<"/apps">) {
  return <AppsShell>{children}</AppsShell>;
}
