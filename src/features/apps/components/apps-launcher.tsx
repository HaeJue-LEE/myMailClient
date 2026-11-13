"use client";

import Link from "next/link";
import { useApps } from "@/features/apps/api";
import { appTarget, groupApps, openLabel } from "@/features/apps/apps";
import { AppLink } from "@/features/apps/components/app-link";
import { AppTile } from "@/features/apps/components/app-tile";
import { appEditHref, APPS_SETTINGS_HREF } from "@/features/apps/routes";

/** Every app as a card, by group. */
export function AppsLauncher() {
  const { data: apps, isPending } = useApps();

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-foreground/10 bg-background px-4 py-2.5">
        <h1 className="flex-1 text-base font-semibold">MyApps</h1>
        <Link href={APPS_SETTINGS_HREF} className="rounded-md px-2.5 py-1.5 text-sm hover:bg-foreground/10">
          앱 관리
        </Link>
        <Link
          href={appEditHref()}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
        >
          앱 추가
        </Link>
      </div>
      <div className="space-y-6 p-4">
        {isPending ? (
          <p className="text-sm opacity-60">불러오는 중…</p>
        ) : !apps || apps.length === 0 ? (
          <div className="mx-auto max-w-md space-y-3 py-12 text-center text-sm">
            <p className="font-medium">아직 추가한 앱이 없습니다.</p>
            <p className="opacity-70">
              NAS 관리 화면, 홈서버, 사내 웹앱처럼 자주 여는 웹 주소를 추가하면 메일과 나란히 열 수 있습니다. 메일 계정이
              없어도 쓸 수 있습니다.
            </p>
            <Link
              href={appEditHref()}
              className="inline-block rounded-md bg-foreground px-4 py-2 font-medium text-background"
            >
              첫 앱 추가
            </Link>
          </div>
        ) : (
          groupApps(apps).map(({ group, apps: items }) => (
            <section key={group} aria-label={group || "그룹 없음"} className="space-y-2">
              {group && <h2 className="text-sm font-semibold opacity-70">{group}</h2>}
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
                {items.map((app) => (
                  <li key={app.id}>
                    <AppLink
                      app={app}
                      className="flex w-full items-center gap-3 rounded-lg border border-foreground/15 p-3 text-left hover:bg-foreground/5 disabled:opacity-50"
                    >
                      <AppTile app={app} className="size-10 text-lg" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{app.name}</span>
                        <span className="block truncate text-xs opacity-60">{appTarget(app)}</span>
                        <span className="block text-[11px] opacity-50">{openLabel(app)}</span>
                      </span>
                    </AppLink>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
