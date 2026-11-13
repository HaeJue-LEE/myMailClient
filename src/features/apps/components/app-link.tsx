"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useOpenApp } from "@/features/apps/api";
import { type MyApp, openLabel } from "@/features/apps/apps";
import { appViewHref } from "@/features/apps/routes";

/**
 * Opens an app the way it is set to: a link to its page in the app for an
 * embedded web app, a button that opens its window or the default browser,
 * or runs the program, otherwise.
 */
export function AppLink({
  app,
  current = false,
  className,
  title,
  children,
}: {
  app: MyApp;
  current?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const openApp = useOpenApp();
  if (app.kind === "web" && app.openIn === "embed") {
    return (
      <Link
        href={appViewHref(app.id)}
        aria-current={current ? "page" : undefined}
        title={title}
        className={className}
      >
        {children}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openApp.mutate({ id: app.id })}
      disabled={openApp.isPending}
      title={`${title ?? app.name} (${openLabel(app)})`}
      className={className}
    >
      {children}
    </button>
  );
}
