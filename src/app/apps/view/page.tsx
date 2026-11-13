import { Suspense } from "react";
import { AppView } from "@/features/apps/components/app-view";

export default function AppViewPage() {
  return (
    <Suspense>
      <AppView />
    </Suspense>
  );
}
