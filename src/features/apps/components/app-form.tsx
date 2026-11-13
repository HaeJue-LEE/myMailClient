"use client";

import { useId, useState } from "react";
import { AppsApiError, useChooseAppIcon, useSaveApp } from "@/features/apps/api";
import {
  MAX_APP_NAME_LENGTH,
  MAX_GROUP_LENGTH,
  type MyApp,
  OPEN_MODE_LABELS,
  OPEN_MODES,
  type OpenMode,
  parseAppUrl,
  withScheme,
} from "@/features/apps/apps";
import { AppTile } from "@/features/apps/components/app-tile";

const INPUT_CLASS =
  "w-full rounded-md border border-foreground/20 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-foreground/60 aria-[invalid=true]:border-red-600";

const OPEN_MODE_NOTES: Record<OpenMode, string> = {
  embed: "메일과 같은 창 안에서 엽니다. 사이드바와 레일로 바로 오갈 수 있습니다.",
  window: "앱 전용 창을 엽니다. 메일과 나란히 놓고 쓰기 좋습니다.",
  browser: "Chrome, Edge 같은 기본 브라우저에서 엽니다. 브라우저 확장이나 저장된 비밀번호가 필요할 때 쓰세요.",
};

/** Adds an app (no `app`) or edits one. */
export function AppForm({
  app,
  groups,
  onDone,
}: {
  app?: MyApp;
  groups: string[];
  onDone: () => void;
}) {
  const save = useSaveApp();
  const [name, setName] = useState(app?.name ?? "");
  const [url, setUrl] = useState(app?.url ?? "");
  const [group, setGroup] = useState(app?.group ?? "");
  const [openIn, setOpenIn] = useState<OpenMode>(app?.openIn ?? "embed");
  const [pinned, setPinned] = useState(app?.pinned ?? true);
  const [icon, setIcon] = useState<string | null>(app?.icon ?? null);
  const [hideAddressBar, setHideAddressBar] = useState(app?.hideAddressBar ?? false);
  const chooseIcon = useChooseAppIcon();
  const [submitted, setSubmitted] = useState(false);
  const groupList = useId();

  const fullUrl = withScheme(url);
  const parsedUrl = parseAppUrl(fullUrl);
  const problems = {
    name: !name.trim() ? "이름을 입력해 주세요." : null,
    url: !url.trim()
      ? "주소를 입력해 주세요."
      : !parsedUrl
        ? "http:// 또는 https://로 시작하는 웹 주소를 입력해 주세요. 주소에 아이디·비밀번호는 넣을 수 없습니다."
        : null,
  };
  const invalid = Object.values(problems).some(Boolean);
  const title = app ? `${app.name} 편집` : "앱 추가";

  return (
    <form
      aria-label={title}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (invalid) return;
        save.mutate(
          { ...(app ? { id: app.id } : {}), name, url: fullUrl, group, openIn, pinned, icon, hideAddressBar },
          { onSuccess: onDone },
        );
      }}
      className="space-y-4 rounded-md border border-foreground/15 p-4"
    >
      <p className="text-sm font-semibold">{title}</p>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block opacity-70">이름</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_APP_NAME_LENGTH}
            placeholder="예: 우리집 NAS"
            autoFocus
            aria-invalid={submitted && !!problems.name}
            className={INPUT_CLASS}
          />
          {submitted && problems.name && <span className="mt-1 block text-xs text-red-600">{problems.name}</span>}
        </label>
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block opacity-70">그룹 (선택)</span>
          <input
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            maxLength={MAX_GROUP_LENGTH}
            list={groupList}
            placeholder="예: NAS"
            className={INPUT_CLASS}
          />
          <datalist id={groupList}>
            {groups.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block opacity-70">주소</span>
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="예: https://nas.example.lan:5001 또는 192.0.2.10:5000"
          spellCheck={false}
          aria-invalid={submitted && !!problems.url}
          className={INPUT_CLASS}
        />
        {submitted && problems.url ? (
          <span className="mt-1 block text-xs text-red-600">{problems.url}</span>
        ) : (
          <span className="mt-1 block text-xs opacity-60">
            자체 서명 인증서를 쓰는 NAS는 처음 열 때 인증서 지문을 보여 주고 신뢰할지 묻습니다. 로그인은 각 앱 화면에서 하며,
            비밀번호는 이 앱에 저장되지 않습니다.
          </span>
        )}
      </label>
      <fieldset className="text-sm">
        <legend className="mb-1 opacity-70">아이콘</legend>
        <div className="flex items-center gap-3">
          {/* The name typed so far, so the letter tile is the one the app will get. */}
          <AppTile app={{ name: name || "?", icon }} className="size-12 text-xl" />
          <div className="space-y-1">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={chooseIcon.isPending}
                onClick={() =>
                  chooseIcon.mutate(undefined, {
                    onSuccess: (picked) => {
                      if (picked) setIcon(picked);
                    },
                  })
                }
                className="rounded-md border border-foreground/20 px-3 py-1 hover:bg-foreground/5 disabled:opacity-50"
              >
                {icon ? "다른 이미지로 바꾸기…" : "이미지 선택…"}
              </button>
              {icon && (
                <button
                  type="button"
                  onClick={() => setIcon(null)}
                  className="rounded-md px-3 py-1 hover:bg-foreground/5"
                >
                  첫 글자로 되돌리기
                </button>
              )}
            </div>
            {chooseIcon.isError ? (
              <span role="alert" className="block text-xs text-red-600">
                {chooseIcon.error instanceof AppsApiError && chooseIcon.error.code === "invalid_request"
                  ? "이 파일은 아이콘으로 쓸 수 없습니다. 20MB 이하의 PNG나 JPG 이미지를 골라 주세요."
                  : "이미지를 불러오지 못했습니다. 다시 시도해 주세요."}
              </span>
            ) : (
              <span className="block text-xs opacity-60">
                PNG나 JPG 이미지. 모양은 그대로 두고 128px 안에 맞게 줄여 저장합니다.
              </span>
            )}
          </div>
        </div>
      </fieldset>
      <fieldset className="space-y-1.5 text-sm">
        <legend className="mb-1 opacity-70">열기 방식</legend>
        {OPEN_MODES.map((mode) => (
          <label key={mode} className="flex items-start gap-2">
            <input
              type="radio"
              name="openIn"
              value={mode}
              checked={openIn === mode}
              onChange={() => setOpenIn(mode)}
              className="mt-0.5 size-4 shrink-0"
            />
            <span>
              {OPEN_MODE_LABELS[mode]}
              <span className="block text-xs opacity-60">{OPEN_MODE_NOTES[mode]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-2 text-sm has-disabled:opacity-50">
        <input
          type="checkbox"
          checked={hideAddressBar}
          disabled={openIn !== "embed"}
          onChange={(event) => setHideAddressBar(event.target.checked)}
          className="mt-0.5 size-4 shrink-0"
        />
        <span>
          주소 표시줄 숨기기
          <span className="block text-xs opacity-60">
            {openIn === "embed"
              ? "위쪽의 이동 버튼과 주소 줄을 감추고 앱을 화면 가득 보여 줍니다. 맨 위의 가는 줄을 누르면 다시 보입니다. 숨긴 동안에도 Alt+←/→로 이동하고 F5로 새로고침합니다."
              : "앱 안에서 열 때만 쓰입니다."}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={pinned}
          onChange={(event) => setPinned(event.target.checked)}
          className="mt-0.5 size-4 shrink-0"
        />
        <span>
          왼쪽 레일에 고정
          <span className="block text-xs opacity-60">메일을 보다가도 아이콘 한 번으로 엽니다.</span>
        </span>
      </label>
      {save.isError && (
        <p role="alert" className="text-sm text-red-600">
          {save.error instanceof AppsApiError && save.error.code === "invalid_request"
            ? "입력한 내용을 저장할 수 없습니다. 이름과 주소를 확인해 주세요."
            : "앱을 저장하지 못했습니다. 다시 시도해 주세요."}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-foreground px-4 py-1.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {save.isPending ? "저장하는 중…" : app ? "저장" : "추가"}
        </button>
        <button type="button" onClick={onDone} className="rounded-md px-3 py-1.5 text-sm hover:bg-foreground/5">
          취소
        </button>
      </div>
    </form>
  );
}
