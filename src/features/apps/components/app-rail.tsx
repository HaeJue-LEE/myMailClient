"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useApps } from "@/features/apps/api";
import { AppLink } from "@/features/apps/components/app-link";
import { AppTile } from "@/features/apps/components/app-tile";
import { setSidebarCollapsed, useSidebarCollapsed } from "@/features/apps/components/sidebar-collapse";
import { APPS_HREF, isAppViewPath } from "@/features/apps/routes";
import { Icon, type IconName } from "@/features/mail/components/icon";

const RAIL_ITEM =
  "flex size-10 items-center justify-center rounded-lg hover:bg-foreground/10 aria-[current=page]:bg-foreground/15";

function RailLink({ href, icon, label, current }: { href: string; icon: IconName; label: string; current: boolean }) {
  return (
    <Link href={href} title={label} aria-label={label} aria-current={current ? "page" : undefined} className={RAIL_ITEM}>
      <Icon name={icon} className="size-5" />
    </Link>
  );
}

/**
 * The left edge of the main window: switches between mail and MyApps, and
 * opens the apps pinned to it in one click.
 */
export function AppRail() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: apps = [] } = useApps();
  const pinned = apps.filter((app) => app.pinned);
  const shownId = isAppViewPath(pathname) ? searchParams.get("id") : null;
  const collapsed = useSidebarCollapsed();
  const toggleLabel = collapsed ? "사이드바 펼치기" : "사이드바 접기";

  return (
    <nav
      aria-label="메일과 MyApps"
      className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-foreground/10 bg-foreground/[0.03] py-2"
    >
      <RailLink href="/mail" icon="mail" label="메일" current={/^\/mail(\/|$)/.test(pathname)} />
      {/* The sidebar's compose button is folded away with it. */}
      {collapsed && /^\/mail(\/|$)/.test(pathname) && (
        <RailLink href="/mail/compose" icon="edit" label="메일 쓰기" current={pathname === "/mail/compose"} />
      )}
      <RailLink
        href={APPS_HREF}
        icon="apps"
        label="MyApps"
        current={/^\/apps(\/|$)/.test(pathname) && !shownId}
      />
      {pinned.length > 0 && <div aria-hidden className="my-1 h-px w-8 bg-foreground/15" />}
      {pinned.map((app) => (
        <AppLink
          key={app.id}
          app={app}
          current={app.id === shownId}
          title={app.name}
          className={`${RAIL_ITEM} disabled:opacity-50`}
        >
          <AppTile app={app} className="size-7 text-sm" />
          <span className="sr-only">{app.name}</span>
        </AppLink>
      ))}
      <button
        type="button"
        onClick={() => setSidebarCollapsed(!collapsed)}
        aria-pressed={collapsed}
        title={toggleLabel}
        aria-label={toggleLabel}
        className={`${RAIL_ITEM} mt-auto shrink-0 opacity-70 hover:opacity-100`}
      >
        <Icon name={collapsed ? "sidebarOpen" : "sidebarClose"} className="size-5" />
      </button>
    </nav>
  );
}

/** Space kept for the rail while it loads. */
export function AppRailFallback() {
  return <div className="w-14 shrink-0 border-r border-foreground/10 bg-foreground/[0.03]" />;
}
