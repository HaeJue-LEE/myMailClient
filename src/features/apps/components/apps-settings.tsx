"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useApps, useClearTrustedCerts, useRemoveApp, useReorderApps } from "@/features/apps/api";
import { appTarget, groupSuggestions, type MyApp, openLabel } from "@/features/apps/apps";
import { AppForm } from "@/features/apps/components/app-form";
import { AppTile } from "@/features/apps/components/app-tile";
import { appEditHref, APPS_SETTINGS_HREF } from "@/features/apps/routes";
import { Icon } from "@/features/mail/components/icon";
import { useDragReorder } from "@/features/mail/components/use-drag-reorder";

type DragProps = ReturnType<typeof useDragReorder>;

/** Adding, editing, ordering, and removing apps. `?edit=new` or `?edit=<id>` opens the form. */
export function AppsSettings() {
  const router = useRouter();
  const edit = useSearchParams().get("edit");
  const { data: apps, isPending, isError, refetch } = useApps();
  const list = apps ?? [];
  const reorderApps = useReorderApps();
  const reorder = useDragReorder(
    list.map((app) => app.id),
    (ids) => reorderApps.mutate(ids),
  );
  const editing = edit && edit !== "new" ? list.find((app) => app.id === edit) : undefined;
  const showForm = edit === "new" || editing !== undefined;
  const closeForm = () => router.replace(APPS_SETTINGS_HREF);

  return (
    <div>
      <div className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-foreground/10 bg-background px-4">
        <h1 className="text-sm font-semibold">앱 관리</h1>
        <span className="text-xs opacity-60">{list.length}개</span>
        <Link
          href={appEditHref()}
          className="ml-auto rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
        >
          앱 추가
        </Link>
      </div>
      <div className="max-w-3xl space-y-4 p-4">
        {showForm && (
          <AppForm key={edit} app={editing} groups={groupSuggestions(list)} onDone={closeForm} />
        )}
        {isPending ? (
          <p className="text-sm opacity-60">불러오는 중…</p>
        ) : isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p className="text-red-600">앱 목록을 불러오지 못했습니다.</p>
            <button type="button" onClick={() => void refetch()} className="underline">
              다시 시도
            </button>
          </div>
        ) : list.length === 0 ? (
          !showForm && <p className="py-8 text-center text-sm opacity-60">추가한 앱이 없습니다.</p>
        ) : (
          <>
            <ul className="divide-y divide-foreground/10 rounded-md border border-foreground/15">
              {list.map((app) => (
                <AppRow
                  key={app.id}
                  app={app}
                  rowProps={reorder.rowProps(app.id)}
                  handleProps={reorder.handleProps(app.id)}
                  onRemoved={() => {
                    if (edit === app.id) closeForm();
                  }}
                />
              ))}
            </ul>
            {reorderApps.isError && (
              <p role="alert" className="text-sm text-red-600">
                순서를 저장하지 못했습니다.
              </p>
            )}
            <p className="text-xs opacity-60">
              순서는 사이드바와 레일에 그대로 쓰입니다. 앱마다 로그인 정보(쿠키)를 따로 보관하며, 메일 계정과 섞이지 않습니다.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function AppRow({
  app,
  rowProps,
  handleProps,
  onRemoved,
}: {
  app: MyApp;
  /** Spread on the row and its drag handle (see `useDragReorder`). */
  rowProps: ReturnType<DragProps["rowProps"]>;
  handleProps: ReturnType<DragProps["handleProps"]>;
  onRemoved: () => void;
}) {
  const remove = useRemoveApp();
  const clearCerts = useClearTrustedCerts();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <li {...rowProps} role="alertdialog" aria-label="앱 삭제 확인" className="space-y-2 bg-red-500/5 px-4 py-3 text-sm">
        <p>
          <b>{app.name}</b>을(를) 삭제할까요? 이 앱의 로그인 상태와 캐시도 이 컴퓨터에서 지워집니다. 앱 자체(NAS 등)의
          데이터는 그대로 남습니다.
        </p>
        {remove.isError && (
          <p role="alert" className="text-red-600">
            삭제하지 못했습니다. 다시 시도해 주세요.
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => remove.mutate(app.id, { onSuccess: onRemoved })}
            className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            {remove.isPending ? "삭제하는 중…" : "삭제"}
          </button>
          {/* Focus starts on the safe choice: a stray Enter must not delete. */}
          <button
            type="button"
            autoFocus
            onClick={() => setConfirming(false)}
            className="rounded-md px-3 py-1.5 hover:bg-foreground/5"
          >
            취소
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      {...rowProps}
      className="bg-background py-2.5 pl-1.5 pr-4 data-[dragging]:rounded-md data-[dragging]:shadow-lg data-[dragging]:ring-1 data-[dragging]:ring-foreground/15"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          {...handleProps}
          title="끌어서 순서 바꾸기 (↑/↓ 키로도 이동)"
          aria-label={`${app.name} 순서 바꾸기. 위아래 화살표 키로 이동합니다`}
          className="shrink-0 select-none rounded p-1 opacity-40 hover:bg-foreground/10 hover:opacity-100 focus-visible:opacity-100"
        >
          <Icon name="grip" />
        </button>
        <AppTile app={app} className="size-9 text-sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {app.name}
            {app.group && <span className="ml-2 text-xs font-normal opacity-60">{app.group}</span>}
          </p>
          <p className="truncate text-xs opacity-60">
            {appTarget(app)} · {openLabel(app)}
            {app.pinned ? " · 레일에 고정" : ""}
            {app.kind === "web" && app.openIn === "embed" && app.hideAddressBar ? " · 주소 표시줄 숨김" : ""}
          </p>
          {app.kind === "web" && app.trustedCerts.length > 0 && (
            <p className="text-xs opacity-60">
              신뢰한 인증서 {app.trustedCerts.length}개{" "}
              <button
                type="button"
                onClick={() => clearCerts.mutate(app.id)}
                disabled={clearCerts.isPending}
                title="이미 열어 둔 연결에는 앱을 다시 시작한 뒤부터 적용됩니다"
                className="underline hover:opacity-100 disabled:opacity-40"
              >
                지우기
              </button>
            </p>
          )}
        </div>
        <Link
          href={appEditHref(app.id)}
          className="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm hover:bg-foreground/10"
        >
          <Icon name="edit" />
          편집
        </Link>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-sm hover:bg-foreground/10"
        >
          <Icon name="trash" />
          삭제
        </button>
      </div>
    </li>
  );
}
