import { app, shell } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, renameSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { UpdateStatus } from "@/features/mail/bridge";
import { getGoogleClient } from "./google-client";
import { launcherPath } from "./shortcuts";
import {
  checkPackageTrailer,
  type ReleaseExe,
  releaseExe,
  type ReleasePage,
  releasePage,
  TRAILER_BYTES,
} from "./update-check";

/**
 * Updates from GitHub releases, for copies started through the launcher
 * (`MailClient-<version>.exe`). A later release's exe is downloaded in the
 * background and checked (size, GitHub's SHA-256, the launcher package
 * trailer). When the app quits it takes the launcher's place, under the
 * launcher's own name so shortcuts keep working; the launcher unpacks the new
 * app on its next start. "Restart now" does the same and starts it at once,
 * telling the launcher to wait for this app to end first.
 *
 * Not offered when there is no launcher (`npm run dev`, the unpacked folder),
 * nor for builds with a built-in Google client (`npm run dist`): the public
 * exe would take that client, and the sign-in made with it, away.
 *
 * The Mac app is a plain .app bundle without the launcher, and not signed by
 * Apple, so it cannot replace itself. It only says when a later release has
 * a dmg for this Mac, and opens that release's page (`byHand`); the user
 * downloads it and replaces the app in Applications.
 */

/** Updates are installed by hand from the release page (the Mac app). */
const BY_HAND = process.platform === "darwin";

/** Replaced at build time; empty except in builds made to test the updater. */
const FEED_OVERRIDE = process.env.MAIL_CLIENT_UPDATE_FEED ?? "";
const FEED =
  FEED_OVERRIDE || "https://api.github.com/repos/HaeJue-LEE/myMailClient/releases/latest";
/** After start, so the first screen is up first; the check is one small request. */
const FIRST_CHECK_DELAY_MS = 3 * 1000;
const FEED_TIMEOUT_MS = 30 * 1000;
/** For the whole download; a 150 MB exe on a slow line still fits. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
/** Generic: the request says nothing about the user. */
const USER_AGENT = "myMailClient-updater";

let status: UpdateStatus = {
  state: "idle",
  currentVersion: app.getVersion(),
  ...(BY_HAND ? { byHand: true } : {}),
};
/** The later release found, offered until the user downloads it. */
let found: ReleaseExe | null = null;
/** The Mac app's later release, whose page is opened to download it. */
let foundPage: ReleasePage | null = null;
let checking = false;
let downloading: AbortController | null = null;
let staged: { version: string; file: string; launcher: string } | null = null;
let applied = false;

const set = (next: Omit<UpdateStatus, "currentVersion" | "byHand">) => {
  status = { ...next, currentVersion: app.getVersion(), ...(BY_HAND ? { byHand: true } : {}) };
};

const offer = (exe: ReleaseExe) =>
  set({ state: "available", version: exe.version, total: exe.size, notes: exe.notes });

async function unsupportedReason(): Promise<"dev" | "local" | null> {
  if (BY_HAND) return app.isPackaged ? null : "dev";
  if (!app.isPackaged || !launcherPath()) return "dev";
  if ((await getGoogleClient()).source === "built-in") return "local";
  return null;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  if (status.state === "idle" || status.state === "unsupported") {
    const reason = await unsupportedReason();
    if (reason) set({ state: "unsupported", reason });
  }
  return status;
}

/** Downloads `exe` beside the launcher and checks it; resolves with its path. */
async function download(exe: ReleaseExe, launcher: string, signal: AbortSignal): Promise<string> {
  const file = `${launcher}.update`;
  await rm(file, { force: true });
  const progress = (received: number) =>
    set({ state: "downloading", version: exe.version, received, total: exe.size, notes: exe.notes });
  progress(0);
  const response = await fetch(exe.url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
  });
  if (!response.ok || !response.body) throw new Error(`download ${response.status}`);
  const hash = createHash("sha256");
  let received = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > exe.size) {
        done(new Error("download larger than announced"));
        return;
      }
      hash.update(chunk);
      progress(received);
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      count,
      createWriteStream(file, { mode: 0o755 }),
      { signal },
    );
    if (received !== exe.size) throw new Error("download size mismatch");
    if (hash.digest("hex") !== exe.sha256) throw new Error("download hash mismatch");
    // The same trailer the launcher reads: the file really is a package of that version.
    const handle = await open(file, "r");
    try {
      const length = Math.min(exe.size, 512);
      const tail = Buffer.alloc(length);
      await handle.read(tail, 0, length, exe.size - length);
      if (length < TRAILER_BYTES || !checkPackageTrailer(tail, exe.size, exe.version)) {
        throw new Error("not a Mail Client package");
      }
    } finally {
      await handle.close();
    }
    return file;
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

/**
 * Looks for a later release. One found is only offered (`available`): the
 * user decides whether to download it. Network and feed failures leave the
 * status as it was, unless the user asked.
 */
export async function checkForUpdate({ manual }: { manual: boolean }): Promise<UpdateStatus> {
  const reason = await unsupportedReason();
  if (reason) {
    set({ state: "unsupported", reason });
    return status;
  }
  // Downloading or downloaded: nothing to add until that is done with.
  if (checking || downloading || staged) return status;
  checking = true;
  const before = status;
  try {
    if (manual) set({ state: "checking" });
    let release: unknown;
    try {
      const response = await fetch(FEED, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`feed ${response.status}`);
      release = await response.json();
    } catch (error) {
      console.warn("[update] check failed", (error as Error).message);
      if (manual) set({ state: "error", error: "check" });
      // Tried: the screen stops asking every few seconds for a result.
      else if (before.state === "idle") set({ state: "idle", checkedAt: Date.now() });
      else status = before;
      return status;
    }
    if (BY_HAND) {
      foundPage = releasePage((release ?? {}) as Parameters<typeof releasePage>[0], app.getVersion(), process.arch);
      if (foundPage) {
        const { version, file, size, notes } = foundPage;
        set({ state: "available", version, file, total: size, notes });
      } else set({ state: "latest", checkedAt: Date.now() });
      return status;
    }
    const exe = releaseExe(
      (release ?? {}) as Parameters<typeof releaseExe>[0],
      app.getVersion(),
      Boolean(FEED_OVERRIDE),
    );
    found = exe;
    if (exe) offer(exe);
    else set({ state: "latest", checkedAt: Date.now() });
    return status;
  } finally {
    checking = false;
  }
}

/** Starts downloading the release offered; the status follows its progress. */
export function downloadUpdate(): UpdateStatus {
  const launcher = launcherPath();
  const exe = found;
  if (!exe || !launcher || downloading || staged) return status;
  const controller = new AbortController();
  downloading = controller;
  void download(exe, launcher, controller.signal)
    .then((file) => {
      staged = { version: exe.version, file, launcher };
      set({ state: "ready", version: exe.version, notes: exe.notes });
    })
    .catch((error: Error) => {
      if (controller.signal.aborted) {
        // Cancelled: offered again.
        offer(exe);
        return;
      }
      console.warn("[update] download failed", error.message);
      set({ state: "error", error: "download", version: exe.version });
    })
    .finally(() => {
      if (downloading === controller) downloading = null;
    });
  set({ state: "downloading", version: exe.version, received: 0, total: exe.size, notes: exe.notes });
  return status;
}

/**
 * Opens the page of the release offered to the Mac app, in the browser.
 * Only that page: the address comes from the release, never from the screen.
 */
export function openUpdatePage(): boolean {
  if (!foundPage) return false;
  void shell.openExternal(foundPage.page);
  return true;
}

export function cancelUpdateDownload(): UpdateStatus {
  downloading?.abort();
  return status;
}

/** Puts the downloaded exe in the launcher's place. Synchronous: it runs as the app quits. */
function applyStaged(): boolean {
  if (!staged || applied) return applied;
  const { file, launcher } = staged;
  try {
    renameSync(file, launcher);
  } catch {
    // Some setups refuse to replace in one go: move the old one aside first.
    try {
      rmSync(`${launcher}.old`, { force: true });
      renameSync(launcher, `${launcher}.old`);
      renameSync(file, launcher);
    } catch (error) {
      console.warn("[update] could not replace the launcher", (error as Error).message);
      return false;
    }
  }
  applied = true;
  return true;
}

/**
 * Installs the downloaded update now: the launcher is replaced and started,
 * and waits for this app (pid) to end before unpacking; then the app quits.
 * Open compose windows save their drafts as they close.
 */
export function restartToUpdate(): boolean {
  if (!staged || !applyStaged()) return false;
  // The same options again (e.g. --user-data-dir); the launcher passes them on.
  const child = spawn(staged.launcher, process.argv.slice(1), {
    // Not the app's own folder (this process's working directory): Windows
    // will not rename a folder a process has as its working directory, so
    // the launcher could never swap the new app in.
    cwd: path.dirname(staged.launcher),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MAIL_CLIENT_WAIT_PID: String(process.pid) },
  });
  child.on("error", (error) => console.warn("[update] could not start the launcher", error.message));
  child.unref();
  app.quit();
  return true;
}

/** Checks once, shortly after start, and arranges for a downloaded update to be applied at quit. */
export function startUpdater() {
  const launcher = launcherPath();
  if (launcher) {
    // Leftovers of an earlier update.
    rmSync(`${launcher}.old`, { force: true });
    rmSync(`${launcher}.update`, { force: true });
  }
  app.on("will-quit", () => {
    applyStaged();
  });
  // Once per start; later only when the user asks (메일 계정 → 업데이트 확인).
  setTimeout(() => void checkForUpdate({ manual: false }), FIRST_CHECK_DELAY_MS);
}
