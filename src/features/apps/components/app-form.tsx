"use client";

import { useId, useState } from "react";
import { AppsApiError, useChooseAppIcon, useChooseProgram, useSaveApp } from "@/features/apps/api";
import {
  type AppKind,
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

const KIND_LABELS: Record<AppKind, string> = {
  web: "웹 주소",
  program: "이 PC의 프로그램",
};

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
  const web = app?.kind === "web" ? app : undefined;
  const [kind, setKind] = useState<AppKind>(app?.kind ?? "web");
  const [name, setName] = useState(app?.name ?? "");
  const [url, setUrl] = useState(web?.url ?? "");
  const [path, setPath] = useState(app?.kind === "program" ? app.path : "");
  const [group, setGroup] = useState(app?.group ?? "");
  const [openIn, setOpenIn] = useState<OpenMode>(web?.openIn ?? "embed");
  const [pinned, setPinned] = useState(app?.pinned ?? true);
  const [icon, setIcon] = useState<string | null>(app?.icon ?? null);
  // The icon taken from the last program picked, replaced when another one is.
  const [programIcon, setProgramIcon] = useState<string | null>(null);
  const [hideAddressBar, setHideAddressBar] = useState(web?.hideAddressBar ?? false);
  const chooseIcon = useChooseAppIcon();
  const chooseProgram = useChooseProgram();
  const [submitted, setSubmitted] = useState(false);
  const groupList = useId();

  const fullUrl = withScheme(url);
  const parsedUrl = parseAppUrl(fullUrl);
  const problems = {
    name: !name.trim() ? "이름을 입력해 주세요." : null,
    url:
      kind !== "web"
        ? null
        : !url.trim()
          ? "주소를 입력해 주세요."
          : !parsedUrl
            ? "http:// 또는 https://로 시작하는 웹 주소를 입력해 주세요. 주소에 아이디·비밀번호는 넣을 수 없습니다."
            : null,
    path: kind === "program" && !path ? "실행할 프로그램을 골라 주세요." : null,
  };
  const invalid = Object.values(problems).some(Boolean);
  const title = app ? `${app.name} 편집` : "앱 추가";

  const pickProgram = () =>
    chooseProgram.mutate(undefined, {
      onSuccess: (picked) => {
        if (!picked) return;
        setPath(picked.path);
        if (!name.trim()) setName(picked.name);
        // The program's own icon, unless the user chose a picture of their own.
        if (picked.icon && (icon === null || icon === programIcon)) setIcon(picked.icon);
        setProgramIcon(picked.icon);
      },
    });

  return (
    <form
      aria-label={title}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (invalid) return;
        const common = { ...(app ? { id: app.id } : {}), name, group, pinned, icon };
        save.mutate(
          kind === "web"
            ? { ...common, kind, url: fullUrl, openIn, hideAddressBar }
            : { ...common, kind, path },
          { onSuccess: onDone },
        );
      }}
      className="space-y-4 rounded-md border border-foreground/15 p-4"
    >
      <p className="text-sm font-semibold">{title}</p>
      <fieldset className="text-sm">
        <legend className="mb-1 opacity-70">종류</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {(Object.keys(KIND_LABELS) as AppKind[]).map((item) => (
            <label key={item} className="flex items-center gap-2">
              <input
                type="radio"
                name="kind"
                value={item}
                checked={kind === item}
                onChange={() => setKind(item)}
                className="size-4 shrink-0"
              />
              {KIND_LABELS[item]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-56 flex-1 text-sm">
          <span className="mb-1 block opacity-70">이름</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_APP_NAME_LENGTH}
            placeholder={kind === "web" ? "예: 우리집 NAS" : "예: 원격 접속 도구"}
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
      {kind === "web" ? (
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
      ) : (
        <div className="text-sm">
          <span className="mb-1 block opacity-70">프로그램</span>
          <div className="flex gap-2">
            {/* Shown, not typed: only a program picked in the dialog can be saved. */}
            <p
              aria-invalid={submitted && !!problems.path}
              title={path || undefined}
              className={`${INPUT_CLASS} min-w-0 flex-1 truncate ${path ? "" : "opacity-50"}`}
            >
              {path || "선택한 프로그램이 없습니다"}
            </p>
            <button
              type="button"
              disabled={chooseProgram.isPending}
              onClick={pickProgram}
              className="shrink-0 rounded-md border border-foreground/20 px-3 py-1.5 hover:bg-foreground/5 disabled:opacity-50"
            >
              {path ? "다른 프로그램…" : "프로그램 선택…"}
            </button>
          </div>
          {chooseProgram.isError ? (
            <span role="alert" className="mt-1 block text-xs text-red-600">
              이 파일은 실행할 수 없습니다. 프로그램(.exe), 바로 가기(.lnk), 배치 파일(.bat, .cmd)을 골라 주세요.
            </span>
          ) : submitted && problems.path ? (
            <span className="mt-1 block text-xs text-red-600">{problems.path}</span>
          ) : (
            <span className="mt-1 block text-xs opacity-60">
              파일을 더블클릭한 것처럼 실행합니다. 프로그램(.exe), 바로 가기(.lnk), 배치 파일(.bat, .cmd)을 고를 수 있으며,
              실행할 때 옵션(명령줄 인수)은 넘기지 않습니다. 옵션이 필요하면 옵션을 넣은 바로 가기를 만들어 고르세요.
            </span>
          )}
        </div>
      )}
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
                  ? "이 파일은 아이콘으로 쓸 수 없습니다. 20MB 이하의 PNG·JPG 이미지나 프로그램(EXE)·아이콘(ICO) 파일을 골라 주세요."
                  : "이미지를 불러오지 못했습니다. 다시 시도해 주세요."}
              </span>
            ) : (
              <span className="block text-xs opacity-60">
                {kind === "program"
                  ? "프로그램을 고르면 그 프로그램의 아이콘을 씁니다. PNG·JPG 이미지나 다른 프로그램(EXE)·아이콘(ICO) 파일의 아이콘으로 바꿀 수도 있습니다."
                  : "PNG·JPG 이미지, 또는 프로그램(EXE)·아이콘(ICO) 파일을 고르면 그 아이콘을 씁니다. 모양은 그대로 두고 128px 안에 맞게 줄여 저장합니다."}
              </span>
            )}
          </div>
        </div>
      </fieldset>
      {kind === "web" && (
        <>
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
        </>
      )}
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
            ? kind === "program"
              ? "저장할 수 없습니다. 이름을 확인하고, 프로그램을 다시 골라 주세요."
              : "입력한 내용을 저장할 수 없습니다. 이름과 주소를 확인해 주세요."
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
