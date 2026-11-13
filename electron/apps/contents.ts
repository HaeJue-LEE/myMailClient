import {
  app,
  BrowserWindow,
  type Certificate,
  dialog,
  type Event,
  session,
  shell,
  type WebContents,
} from "electron";
import path from "node:path";
import type { MyApp } from "@/features/apps/apps";
import { safeFilename } from "../gmail/mime";
import {
  ALLOWED_PERMISSIONS,
  formatFingerprint,
  mayNavigate,
  partitionFor,
  popupTarget,
} from "./policy";
import { getApp, isCertTrusted, trustCert } from "./store";

/**
 * Everything an app's pages run with: their session (permissions,
 * downloads), where they may go, what their pop-ups become, and the
 * certificates the user trusted for them.
 */

/** Partitions already set up in this run. */
const configured = new Set<string>();

/** The app's session, set up the first time it is used in this run. */
export function appSession(appId: string) {
  const partition = partitionFor(appId);
  const appSessionObject = session.fromPartition(partition);
  if (!configured.has(partition)) {
    configured.add(partition);
    appSessionObject.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission)),
    );
    appSessionObject.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission),
    );
    // Without a save path Electron asks where to save; start in Downloads.
    appSessionObject.on("will-download", (_event, item) => {
      item.setSaveDialogOptions({
        defaultPath: path.join(app.getPath("downloads"), safeFilename(item.getFilename())),
      });
    });
  }
  return appSessionObject;
}

/** Forgets everything an app kept on this computer: its sign-in, storage, and cache. */
export async function clearAppSession(appId: string) {
  const appSessionObject = appSession(appId);
  await Promise.all([appSessionObject.clearStorageData(), appSessionObject.clearCache()]);
}

/** Pages of MyApps (views, windows, and their pop-ups) by `webContents.id`, with their app's id. */
const owners = new Map<number, string>();

export function appOf(contents: WebContents) {
  return owners.get(contents.id) ?? null;
}

/** webPreferences of every page of an app: no preload, sandboxed, in the app's session. */
export function appWebPreferences(appId: string) {
  appSession(appId);
  return {
    partition: partitionFor(appId),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
  };
}

/**
 * Applies the app's rules to one of its pages. Pop-ups it may open are app
 * windows too, and get the same rules.
 */
export function wireAppContents(contents: WebContents, item: Pick<MyApp, "id" | "url">, icon: string) {
  const { id } = contents;
  owners.set(id, item.id);
  contents.once("destroyed", () => owners.delete(id));

  contents.setWindowOpenHandler(({ url }) => {
    const target = popupTarget(url, contents.getURL(), item.url);
    if (target === "external") void shell.openExternal(url);
    if (target !== "child") return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        icon,
        webPreferences: appWebPreferences(item.id),
      },
    };
  });
  contents.on("did-create-window", (child) => wireAppContents(child.webContents, item, icon));

  const guard = (event: Event, url: string) => {
    if (mayNavigate(url)) return;
    event.preventDefault();
    if (/^mailto:/i.test(url)) void shell.openExternal(url);
  };
  contents.on("will-navigate", (event, url) => guard(event, url));
  contents.on("will-redirect", (event, url) => guard(event, url));
}

/**
 * Certificates the user declined in this run, so a page's many requests do
 * not ask again and again. Cleared when the user reloads or reopens the app.
 */
const declined = new Set<string>();
/** Questions on screen, so simultaneous requests share one. */
const asking = new Map<string, Promise<boolean>>();

const certKey = (appId: string, host: string, fingerprint: string) => `${appId}\n${host}\n${fingerprint}`;

/** Asks again about certificates declined for the app. */
export function forgetDeclined(appId: string) {
  for (const key of declined) if (key.startsWith(`${appId}\n`)) declined.delete(key);
}

async function askToTrust(contents: WebContents, item: MyApp, host: string, error: string, certificate: Certificate) {
  const parent = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.getFocusedWindow();
  const options = {
    type: "warning" as const,
    title: "인증서 확인",
    message: `'${item.name}'의 인증서를 확인할 수 없습니다.`,
    detail: [
      `주소: ${host}`,
      `오류: ${error}`,
      `발급 대상: ${certificate.subjectName}`,
      `발급자: ${certificate.issuerName}`,
      `유효 기간: ${new Date(certificate.validExpiry * 1000).toLocaleDateString("ko-KR")}까지`,
      `SHA-256 지문: ${formatFingerprint(certificate.fingerprint)}`,
      "",
      "NAS처럼 자체 서명 인증서를 쓰는 기기라면, 위 지문이 기기 설정에 표시된 값과 같은지 확인한 뒤 신뢰하세요. 신뢰한 인증서는 이 앱에서만, 이 주소에만 쓰이며, 인증서가 바뀌면 다시 묻습니다.",
    ].join("\n"),
    buttons: ["이 인증서 신뢰", "취소"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

/**
 * The app's `certificate-error` handler. Pages of MyApps load over a
 * certificate the user trusted for that app and host (e.g. a NAS's
 * self-signed one), after asking the first time; everything else keeps
 * Chromium's refusal. Nothing is ever trusted for every site.
 */
export function handleCertificateError(
  event: Event,
  contents: WebContents,
  url: string,
  error: string,
  certificate: Certificate,
  callback: (isTrusted: boolean) => void,
) {
  const appId = appOf(contents);
  if (!appId) return;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  event.preventDefault();
  const cert = { host, fingerprint: certificate.fingerprint };
  const key = certKey(appId, host, cert.fingerprint);
  void (async () => {
    const item = await getApp(appId);
    if (isCertTrusted(item, cert)) return true;
    if (declined.has(key)) return false;
    let pending = asking.get(key);
    if (!pending) {
      pending = askToTrust(contents, item, host, error, certificate)
        .then(async (trusted) => {
          if (trusted) await trustCert(appId, cert);
          else declined.add(key);
          return trusted;
        })
        .finally(() => asking.delete(key));
      asking.set(key, pending);
    }
    return pending;
  })()
    .catch(() => false)
    .then(callback);
}
