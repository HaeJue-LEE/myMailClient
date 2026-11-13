import { Suspense } from "react";
import { AppsSettings } from "@/features/apps/components/apps-settings";

export default function AppsSettingsPage() {
  return (
    <Suspense>
      <AppsSettings />
    </Suspense>
  );
}
