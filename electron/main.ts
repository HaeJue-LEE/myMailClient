import {
  app,
  BrowserWindow,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { popupComposeHref, popupThreadHref } from "@/features/mail/routes";
import { mailPageUrl, resolveAppFile } from "./app-protocol";
import { registerMailHandlers } from "./ipc";
import { offerShortcutsOnFirstInstall } from "./shortcuts";
import { initialBounds, rememberBounds, type WindowKind } from "./window-state";

const APP_SCHEME = "app";
const APP_HOST = "bundle";
/** `--dev` loads the Next dev server instead of the static export. */
const DEV_SERVER = "http://localhost:3000";
const isDev = process.argv.includes("--dev");
const appOrigin = isDev ? DEV_SERVER : `${APP_SCHEME}://${APP_HOST}`;
const startUrl = `${appOrigin}/mail`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

function isAppUrl(raw: string) {
  try {
    const url = new URL(raw);
    return isDev
      ? url.origin === DEV_SERVER
      : url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

function openExternally(url: string) {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
    void shell.openExternal(url);
  }
}

function isTrustedSender(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isAppUrl(frame.url);
}

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function loadAppUrl(window: BrowserWindow, url = startUrl) {
  for (;;) {
    try {
      await window.loadURL(url);
      return;
    } catch (error) {
      // The Next dev server may still be starting; the static export never needs a retry.
      if (!isDev || window.isDestroyed()) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * A window showing app pages, with the same isolation and link handling as
 * the main one. It opens at the size last used for its kind of window
 * (`fallback` the first time) and remembers its size when it closes.
 */
function createAppWindow(kind: WindowKind, fallback: { width: number; height: number }) {
  const { bounds, maximized } = initialBounds(kind, fallback);
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 360,
    title: "Mail Client",
    icon: path.join(__dirname, "../build/icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Links in emails (and anything else that tries to leave the app) open in
  // the default browser instead of inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  if (maximized) window.maximize();
  rememberBounds(window, kind);
  return window;
}

function createWindow(url = startUrl) {
  const window = createAppWindow("main", { width: 1280, height: 820 });
  // First start after the launcher set the app up: offer a desktop shortcut.
  window.webContents.once("did-finish-load", () => void offerShortcutsOnFirstInstall(window));
  window.on("closed", () => {
    mainWindow = null;
  });
  mainWindow = window;
  void loadAppUrl(window, url);
}

/** Pop-up windows by account and thread, so opening one again brings it forward. */
const threadWindows = new Map<string, BrowserWindow>();

/** Opens a thread of the account in use in a window of its own. */
function openThreadWindow(threadId: string, accountId: string, labelId?: string) {
  const key = `${accountId}\n${threadId}`;
  const existing = threadWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  const window = createAppWindow("thread", { width: 960, height: 820 });
  threadWindows.set(key, window);
  window.on("closed", () => threadWindows.delete(key));
  void window.loadURL(`${appOrigin}${popupThreadHref(threadId, accountId, labelId)}`);
}

/** Longest a closing compose window waits for its last draft save. */
const CLOSE_SAVE_TIMEOUT_MS = 10_000;

/**
 * Lets the page finish its work (e.g. save the draft) before the window
 * closes, whether by its own button or the window's close button.
 */
function saveBeforeClose(window: BrowserWindow) {
  let closing = false;
  window.on("close", (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    const finished = window.webContents
      .executeJavaScript("window.mailClientBeforeClose ? window.mailClientBeforeClose() : null", true)
      .catch(() => undefined);
    const timeout = new Promise((resolve) => setTimeout(resolve, CLOSE_SAVE_TIMEOUT_MS));
    void Promise.race([finished, timeout]).finally(() => {
      if (!window.isDestroyed()) window.destroy();
    });
  });
}

/** Compose windows of a draft or a reply, so the same one is not written twice at once. */
const composeWindows = new Map<string, BrowserWindow>();

/**
 * Opens the compose page `href` (`/mail/compose?…`) in a window of its own.
 * False for anything that is not the app's compose page.
 */
function openComposeWindow(href: string, accountId: string) {
  const url = mailPageUrl(href, appOrigin);
  if (!url || url.pathname !== "/mail/compose") return false;
  const params = url.searchParams;
  // A new message may be opened any number of times; a draft or reply once.
  const key =
    params.has("draft") || params.has("mode") ? `${accountId}\n${url.search}` : null;
  const existing = key ? composeWindows.get(key) : undefined;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return true;
  }
  const window = createAppWindow("compose", { width: 920, height: 860 });
  saveBeforeClose(window);
  if (key) {
    composeWindows.set(key, window);
    window.on("closed", () => composeWindows.delete(key));
  }
  void window.loadURL(`${appOrigin}${popupComposeHref(url.search, accountId)}`);
  return true;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusWindow);
  app.on("window-all-closed", () => app.quit());

  void app.whenReady().then(() => {
    const exportRoot = path.join(app.getAppPath(), "out");
    protocol.handle(APP_SCHEME, async (request) => {
      const file = await resolveAppFile(exportRoot, new URL(request.url).pathname);
      return file
        ? net.fetch(pathToFileURL(file).toString())
        : new Response("Not found", { status: 404 });
    });

    registerMailHandlers({
      isTrustedSender,
      onSignedIn: focusWindow,
      openThreadWindow,
      openComposeWindow,
    });
    createWindow();
  });
}
