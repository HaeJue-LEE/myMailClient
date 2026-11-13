import { BrowserWindow, nativeImage, type NativeImage } from "electron";
import type { WebApp } from "@/features/apps/apps";
import { initialBounds, rememberBounds } from "../window-state";
import { appWebPreferences, forgetDeclined, wireAppContents } from "./contents";

/**
 * Apps opened "새 창에서": one window per app, in the app's own session, so
 * opening it again brings that window forward.
 */
const siteWindows = new Map<string, BrowserWindow>();

/** Chromium's "aborted" (e.g. a navigation replaced by another): not a failure to show. */
const ERR_ABORTED = -3;

/** The app's own picture for its window and taskbar button, else the app's icon. */
function windowIcon(item: WebApp, fallback: string): NativeImage | string {
  return item.icon ? nativeImage.createFromDataURL(item.icon) : fallback;
}

export function openSiteWindow(item: WebApp, icon: string) {
  const existing = siteWindows.get(item.id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  forgetDeclined(item.id);
  const { bounds, maximized } = initialBounds("site", { width: 1200, height: 860 });
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 360,
    title: item.name,
    icon: windowIcon(item, icon),
    autoHideMenuBar: true,
    webPreferences: appWebPreferences(item.id),
  });
  siteWindows.set(item.id, window);
  window.on("closed", () => {
    if (siteWindows.get(item.id) === window) siteWindows.delete(item.id);
  });
  wireAppContents(window.webContents, item, icon);

  // The page's title, with the app's name so the window is easy to find.
  window.on("page-title-updated", (event, title) => {
    event.preventDefault();
    window.setTitle(title && title !== item.name ? `${title} · ${item.name}` : item.name);
  });
  // Chromium shows a blank page when the address cannot be reached; say why in the title.
  window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== ERR_ABORTED) {
      window.setTitle(`${item.name} · 열지 못했습니다 (${description}) — F5로 다시 시도`);
    }
  });
  // No menu bar is shown, so F5 reloads by itself.
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F5") {
      event.preventDefault();
      forgetDeclined(item.id);
      window.webContents.reload();
    }
  });

  if (maximized) window.maximize();
  rememberBounds(window, "site");
  window.webContents.loadURL(item.url).catch(() => undefined);
}

/** Shows a changed app's picture on its open window. */
export function updateSiteWindow(item: WebApp, icon: string) {
  const window = siteWindows.get(item.id);
  if (window && !window.isDestroyed()) window.setIcon(windowIcon(item, icon));
}

/** Closes the app's window, if open (e.g. its address changed or it was removed). */
export function closeSiteWindow(id: string) {
  const window = siteWindows.get(id);
  siteWindows.delete(id);
  if (window && !window.isDestroyed()) window.close();
}
