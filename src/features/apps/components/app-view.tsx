"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { appsBridge, unwrapApps, useApps, useOpenApp, useSaveApp } from "@/features/apps/api";
import { fileNameOf, OPEN_MODE_LABELS, type WebApp } from "@/features/apps/apps";
import type { AppViewState, ViewAction, ViewBounds } from "@/features/apps/bridge";
import { AppTile } from "@/features/apps/components/app-tile";
import { appEditHref, APPS_HREF } from "@/features/apps/routes";
import { Icon, type IconName } from "@/features/mail/components/icon";

const TOOL =
  "flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-foreground/10 disabled:opacity-30 disabled:hover:bg-transparent";

/** The app picked by `?id=`, shown inside the window. */
export function AppView() {
  const id = useSearchParams().get("id") ?? "";
  const { data: apps, isPending } = useApps();
  const app = apps?.find((item) => item.id === id);
  const openApp = useOpenApp();

  if (isPending) return <p className="p-6 text-sm opacity-60">불러오는 중…</p>;
  if (!app) {
    return (
      <div className="space-y-2 p-6 text-sm">
        <p>이 앱을 찾을 수 없습니다. 지워졌을 수 있습니다.</p>
        <Link href={APPS_HREF} className="underline">
          MyApps로 돌아가기
        </Link>
      </div>
    );
  }
  if (app.kind === "program" || app.openIn !== "embed") {
    return (
      <div className="space-y-3 p-6 text-sm">
        {app.kind === "program" ? (
          <p>
            <b>{app.name}</b>은(는) 이 컴퓨터의 프로그램입니다 ({fileNameOf(app.path)}).
          </p>
        ) : (
          <p>
            <b>{app.name}</b>은(는) {OPEN_MODE_LABELS[app.openIn]} 열도록 설정되어 있습니다.
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => openApp.mutate({ id: app.id })}
            className="rounded-md bg-foreground px-3 py-1.5 font-medium text-background"
          >
            {app.kind === "program" ? "실행" : "열기"}
          </button>
          <Link href={appEditHref(app.id)} className="rounded-md border border-foreground/20 px-3 py-1.5">
            {app.kind === "program" ? "설정 바꾸기" : "열기 방식 바꾸기"}
          </Link>
        </div>
      </div>
    );
  }
  // A new key for each app: its view is shown afresh, and the old one hidden.
  return <EmbeddedApp key={app.id} app={app} />;
}

function boundsOf(element: HTMLElement): ViewBounds {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * The toolbar, and the area the app's native view is laid over. The view
 * follows the area's size and place; it is hidden when the page leaves, and
 * while the area shows a load error instead.
 */
function EmbeddedApp({ app }: { app: WebApp }) {
  const area = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<AppViewState | null>(null);
  const openApp = useOpenApp();
  const save = useSaveApp();
  const failed = state?.error;
  const hasFailed = failed !== undefined;
  // Shown after a failure anyway, for its buttons; the page is not there to cover.
  const barHidden = app.hideAddressBar && !hasFailed;
  const setBarHidden = (hidden: boolean) => {
    const { id, name, url, group, openIn, pinned } = app;
    save.mutate({ kind: "web", id, name, url, group, openIn, pinned, hideAddressBar: hidden });
  };

  useEffect(
    () =>
      appsBridge().onViewState((next) => {
        if (next.id === app.id) setState(next);
      }),
    [app.id],
  );

  useEffect(() => {
    const element = area.current;
    if (!element || hasFailed) return;
    const api = appsBridge();
    void unwrapApps(api.showView({ id: app.id, bounds: boundsOf(element) }))
      .then(setState)
      .catch(() => undefined);
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void api.setViewBounds({ id: app.id, bounds: boundsOf(element) }));
    };
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    // A change of place without a change of size (e.g. the sidebar resized) still moves the area.
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", follow);
      void api.hideView();
    };
  }, [app.id, hasFailed]);

  const act = (action: ViewAction) => void appsBridge().viewAction({ id: app.id, action });
  const shownUrl = state?.url ?? app.url;
  let host = shownUrl;
  let insecure = false;
  try {
    const url = new URL(shownUrl);
    host = url.host;
    insecure = url.protocol === "http:";
  } catch {
    // Shown as is.
  }

  return (
    <div className="flex h-full flex-col">
      {barHidden ? (
        // Above the app's view rather than over it: nothing can be drawn over a native view.
        <button
          type="button"
          onClick={() => setBarHidden(false)}
          disabled={save.isPending}
          title="주소 표시줄 보이기"
          aria-label="주소 표시줄 보이기"
          className="group flex h-2.5 w-full shrink-0 items-center justify-center border-b border-foreground/10 hover:bg-foreground/10"
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-foreground/20 group-hover:bg-foreground/50" />
        </button>
      ) : (
        <div className="flex items-center gap-1 border-b border-foreground/10 px-2 py-1.5">
          <Tool icon="back" label="뒤로 (Alt+←)" disabled={!state?.canGoBack} onClick={() => act("back")} />
          <Tool icon="next" label="앞으로 (Alt+→)" disabled={!state?.canGoForward} onClick={() => act("forward")} />
          {state?.loading ? (
            <Tool icon="close" label="중지" onClick={() => act("stop")} />
          ) : (
            <Tool icon="refresh" label="새로고침 (F5)" onClick={() => act("reload")} />
          )}
          <Tool icon="home" label="처음 주소로" onClick={() => act("home")} />
          <div className="ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md bg-foreground/5 px-2 py-1">
            <AppTile app={app} className="size-4 text-[9px]" />
            <span className="min-w-0 truncate text-sm">
              <span className="font-medium">{state?.title || app.name}</span>
              <span className="ml-2 opacity-60">{host}</span>
            </span>
            {insecure && (
              <span
                title="암호화되지 않은 연결(http)입니다. 같은 네트워크의 다른 기기가 내용을 볼 수 있습니다."
                className="ml-auto flex shrink-0 items-center gap-1 text-xs text-amber-600"
              >
                <Icon name="lockOpen" className="size-3.5" />
                암호화 안 됨
              </span>
            )}
          </div>
          <Tool icon="popOut" label="새 창에서 열기" onClick={() => openApp.mutate({ id: app.id, mode: "window" })} />
          <Tool icon="globe" label="기본 브라우저에서 열기" onClick={() => openApp.mutate({ id: app.id, mode: "browser" })} />
          <Tool
            icon="chevronUp"
            label="주소 표시줄 숨기기"
            disabled={save.isPending || hasFailed}
            onClick={() => setBarHidden(true)}
          />
        </div>
      )}
      <div ref={area} className="relative min-h-0 flex-1">
        {failed ? (
          <div role="alert" className="space-y-3 p-6 text-sm">
            <p className="font-medium">페이지를 열지 못했습니다.</p>
            <p className="opacity-70">
              {host}에 연결할 수 없습니다 ({failed.description}). 기기가 켜져 있는지, 같은 네트워크에 있는지, 주소와 포트가
              맞는지 확인해 주세요.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => act("reload")}
                className="rounded-md bg-foreground px-3 py-1.5 font-medium text-background"
              >
                다시 시도
              </button>
              <Link href={appEditHref(app.id)} className="rounded-md border border-foreground/20 px-3 py-1.5">
                주소 고치기
              </Link>
            </div>
          </div>
        ) : (
          !state && <p className="p-6 text-sm opacity-60">여는 중…</p>
        )}
      </div>
    </div>
  );
}

function Tool({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={TOOL}>
      <Icon name={icon} />
    </button>
  );
}
