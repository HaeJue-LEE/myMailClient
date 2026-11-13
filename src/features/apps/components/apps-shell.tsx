"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { AppsApiError, useApps } from "@/features/apps/api";
import { groupApps } from "@/features/apps/apps";
import { AppLink } from "@/features/apps/components/app-link";
import { AppRail, AppRailFallback } from "@/features/apps/components/app-rail";
import { AppTile } from "@/features/apps/components/app-tile";
import { useSidebarCollapsed } from "@/features/apps/components/sidebar-collapse";
import { appEditHref, APPS_SETTINGS_HREF, isAppViewPath } from "@/features/apps/routes";
import { UpdateNotice } from "@/features/mail/components/app-update";
import { Icon } from "@/features/mail/components/icon";
import { Unavailable } from "@/features/mail/components/mail-shell";

/**
 * The MyApps pages: the rail, the list of apps, and the page. Unlike mail
 * there is no sign-in gate: apps work without any mail account.
 *
 * No pop-over (such as the update prompt) is shown here: an embedded app is
 * a native view drawn above the page, which would cover it. Updates are
 * offered at the bottom of the list instead.
 */
export function AppsShell({ children }: { children: ReactNode }) {
  const { error } = useApps();
  const sidebarCollapsed = useSidebarCollapsed();
  if (error instanceof AppsApiError && error.code === "unavailable") return <Unavailable />;

  return (
    <div className="flex h-dvh">
      <Suspense fallback={<AppRailFallback />}>
        <AppRail />
      </Suspense>
      {!sidebarCollapsed && (
        <Suspense fallback={<aside className="w-60 shrink-0 border-r border-foreground/10" />}>
          <AppsSidebar />
        </Suspense>
      )}
      <main className="relative min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

function AppsSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const shownId = isAppViewPath(pathname) ? searchParams.get("id") : null;
  const { data: apps, isPending, isError, refetch } = useApps();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-foreground/10">
      <div className="flex items-center gap-1 px-3 pb-1 pt-3">
        <h2 className="flex-1 text-sm font-semibold">MyApps</h2>
        <Link
          href={appEditHref()}
          title="앱 추가"
          aria-label="앱 추가"
          className="flex size-7 items-center justify-center rounded-md text-base hover:bg-foreground/10"
        >
          +
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {isPending ? (
          <p className="px-3 py-1.5 text-sm opacity-60">불러오는 중…</p>
        ) : isError ? (
          <div role="alert" className="space-y-1 px-3 py-1.5 text-sm">
            <p className="text-red-600">앱 목록을 불러오지 못했습니다.</p>
            <button type="button" onClick={() => void refetch()} className="underline">
              다시 시도
            </button>
          </div>
        ) : apps.length === 0 ? (
          <p className="px-3 py-1.5 text-sm opacity-60">
            추가한 앱이 없습니다. <b>+</b>를 눌러 NAS나 웹앱 주소를 추가하세요.
          </p>
        ) : (
          groupApps(apps).map(({ group, apps: items }) => (
            <section key={group} aria-label={group || "그룹 없음"} className="mb-2">
              {group && <h3 className="px-3 pb-0.5 pt-1 text-xs font-medium opacity-60">{group}</h3>}
              <ul>
                {items.map((app) => (
                  <li key={app.id}>
                    <AppLink
                      app={app}
                      current={app.id === shownId}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-foreground/5 disabled:opacity-50 aria-[current=page]:bg-foreground/10 aria-[current=page]:font-medium"
                    >
                      <AppTile app={app} className="size-5 text-[10px]" />
                      <span className="min-w-0 flex-1 truncate">{app.name}</span>
                      {app.openIn !== "embed" && (
                        <Icon name={app.openIn === "window" ? "popOut" : "globe"} className="opacity-50" />
                      )}
                    </AppLink>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        <div className="mt-2 border-t border-foreground/10 pt-2">
          <Link
            href={APPS_SETTINGS_HREF}
            aria-current={pathname === APPS_SETTINGS_HREF ? "page" : undefined}
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5 aria-[current=page]:bg-foreground/10 aria-[current=page]:font-medium"
          >
            <Icon name="settings" className="opacity-70" />앱 관리
          </Link>
        </div>
      </nav>
      <UpdateNotice />
    </aside>
  );
}
