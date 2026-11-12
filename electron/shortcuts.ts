import { app, type BrowserWindow, dialog, shell } from "electron";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Desktop and Start menu shortcuts, for copies started through the launcher
 * (`MailClient-<version>.exe`, see launcher/). Shortcuts point at the
 * launcher, not at the unpacked app, so starting from them also picks up a
 * newer exe put in its place. Copies not started that way (`npm run dev`, a
 * plain unpacked folder) offer none.
 */
export type ShortcutPlace = "desktop" | "startMenu";
export const SHORTCUT_PLACES: readonly ShortcutPlace[] = ["desktop", "startMenu"];

const SHORTCUT_NAME = "Mail Client.lnk";

const samePath = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * The launcher that started this app, when it is genuinely ours: an exe
 * beside the folder the app runs from (`<dir>\Mail Client\Mail Client.exe`).
 */
export function launcherPath(
  env: Record<string, string | undefined> = process.env,
  appExe: string = process.execPath,
): string | null {
  const launcher = env.MAIL_CLIENT_LAUNCHER;
  if (!launcher || !path.isAbsolute(launcher) || !/\.exe$/i.test(launcher)) return null;
  if (!samePath(path.dirname(launcher), path.dirname(path.dirname(appExe)))) return null;
  try {
    return statSync(launcher).isFile() ? launcher : null;
  } catch {
    return null;
  }
}

function shortcutFile(place: ShortcutPlace) {
  const folder =
    place === "desktop"
      ? app.getPath("desktop")
      : path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  return path.join(folder, SHORTCUT_NAME);
}

/** True when a shortcut there points at this launcher. */
function hasShortcut(place: ShortcutPlace, launcher: string) {
  const file = shortcutFile(place);
  if (!existsSync(file)) return false;
  try {
    return samePath(shell.readShortcutLink(file).target, launcher);
  } catch {
    return false;
  }
}

export function shortcutStatus() {
  const launcher = launcherPath();
  return {
    available: launcher !== null,
    desktop: launcher !== null && hasShortcut("desktop", launcher),
    startMenu: launcher !== null && hasShortcut("startMenu", launcher),
  };
}

/**
 * Creates (or points at this launcher again) or removes the shortcut. Only
 * a shortcut to this launcher is removed; anything else of that name stays.
 */
export function setShortcut(place: ShortcutPlace, enabled: boolean) {
  const launcher = launcherPath();
  if (!launcher) throw new Error("Not started through the launcher");
  const file = shortcutFile(place);
  if (!enabled) {
    if (hasShortcut(place, launcher)) rmSync(file, { force: true });
    return;
  }
  const written = shell.writeShortcutLink(file, existsSync(file) ? "replace" : "create", {
    target: launcher,
    cwd: path.dirname(launcher),
    description: "Mail Client",
    // The launcher carries the app's icon.
    icon: launcher,
    iconIndex: 0,
  });
  if (!written) throw new Error("Could not write the shortcut");
}

/**
 * Right after the launcher set the app up for the first time, asks once
 * whether to put a shortcut on the desktop (and in the Start menu).
 */
export async function offerShortcutsOnFirstInstall(window: BrowserWindow) {
  if (process.env.MAIL_CLIENT_FIRST_INSTALL !== "1") return;
  // Asked once per start: a reload of the page must not ask again.
  delete process.env.MAIL_CLIENT_FIRST_INSTALL;
  const status = shortcutStatus();
  if (!status.available || status.desktop) return;
  const { response, checkboxChecked } = await dialog.showMessageBox(window, {
    type: "question",
    title: "Mail Client",
    message: "바탕 화면에 Mail Client 바로가기를 만들까요?",
    detail: "나중에 메일 계정 화면의 '바로가기'에서 만들거나 지울 수 있습니다.",
    buttons: ["만들기", "나중에"],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: "시작 메뉴에도 추가",
    checkboxChecked: true,
    noLink: true,
  });
  if (response !== 0) return;
  try {
    setShortcut("desktop", true);
    if (checkboxChecked) setShortcut("startMenu", true);
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: "warning",
      title: "Mail Client",
      message: "바로가기를 만들지 못했습니다.",
      detail: (error as Error).message,
    });
  }
}
