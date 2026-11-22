import { type BrowserWindow, dialog, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type BrowserChoice,
  MAX_BROWSER_NAME_LENGTH,
  type MyApp,
  type MyAppInput,
  type WebApp,
} from "@/features/apps/apps";
import { InvalidRequestError } from "../errors";

/**
 * The browsers installed on this computer, to open a web app in one of them
 * instead of the default browser. Found here, never named by the page: a
 * saved choice is opened only while its path is still one of these.
 */

const run = promisify(execFile);

/** Where browsers register themselves on Windows; the per-user list first. */
const WINDOWS_BROWSER_KEYS = [
  "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet",
];

/** Registered, but only hands the address on to Edge now. */
const RETIRED_PROGRAMS = new Set(["iexplore.exe"]);

/** Mac browsers looked for, by app name, in /Applications and ~/Applications. */
const MAC_BROWSERS = [
  "Safari",
  "Google Chrome",
  "Firefox",
  "Microsoft Edge",
  "Naver Whale",
  "Whale",
  "Brave Browser",
  "Arc",
  "Opera",
  "Vivaldi",
  "Chromium",
  "Orion",
  "Zen",
  "Zen Browser",
  "DuckDuckGo",
  "Firefox Developer Edition",
  "Google Chrome Canary",
];

type RegistryKeys = Map<string, Map<string, string>>;

/**
 * Parses `reg query … /s`: a key's full name on its own line, then its
 * values, each `    name    REG_TYPE    data`. Key names are lower-cased.
 */
export function parseRegistry(output: string): RegistryKeys {
  const keys: RegistryKeys = new Map();
  let current: Map<string, string> | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      current = new Map();
      keys.set(line.trim().toLowerCase(), current);
      continue;
    }
    const value = /^ {4}(.*?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (value && current) current.set(value[1], (value[3] ?? "").trim());
  }
  return keys;
}

/** A key's default value: shown as `(Default)`, or its translation. */
function defaultValue(values: Map<string, string> | undefined) {
  for (const [name, data] of values ?? []) if (/^\(.+\)$/.test(name)) return data;
  return "";
}

const expand = (value: string) =>
  value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);

/** The program a `shell\open\command` runs: its quoted path, or up to `.exe`. */
export function commandProgram(command: string) {
  const text = command.trim();
  const quoted = /^"([^"]+)"/.exec(text);
  const program = quoted ? quoted[1] : /^(.+?\.exe)\b/i.exec(text)?.[1];
  return program ? expand(program) : null;
}

/**
 * The browsers in a `reg query <root> /s` listing: each key right under
 * `root`, by the name it gives itself, with the program it opens.
 */
export function browsersInRegistry(root: string, output: string): BrowserChoice[] {
  const keys = parseRegistry(output);
  const prefix = `${root.toLowerCase()}\\`;
  const found: BrowserChoice[] = [];
  for (const [key, values] of keys) {
    if (!key.startsWith(prefix) || key.slice(prefix.length).includes("\\")) continue;
    const program = commandProgram(defaultValue(keys.get(`${key}\\shell\\open\\command`)));
    if (!program || !/\.exe$/i.test(program)) continue;
    if (RETIRED_PROGRAMS.has(path.win32.basename(program).toLowerCase())) continue;
    // `ApplicationName` may be a resource reference (`@C:\…\x.dll,-123`), unreadable here.
    const appName = keys.get(`${key}\\capabilities`)?.get("ApplicationName") ?? "";
    const name =
      [appName, defaultValue(values)].find((item) => item && !item.startsWith("@")) ??
      path.win32.parse(program).name;
    found.push({ path: program, name: name.slice(0, MAX_BROWSER_NAME_LENGTH) });
  }
  return found;
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

async function windowsBrowsers(): Promise<BrowserChoice[]> {
  const lists = await Promise.all(
    WINDOWS_BROWSER_KEYS.map(async (key) => {
      try {
        // UTF-8, so names and paths in other scripts come through. Passed
        // verbatim: cmd reads its own quotes (`/s` takes off the outer pair),
        // not the escaping Node would add. `key` is one of the constants above.
        const { stdout } = await run(
          "cmd.exe",
          ["/d", "/s", "/c", `"chcp 65001 >nul && reg query "${key}" /s"`],
          { windowsHide: true, windowsVerbatimArguments: true, maxBuffer: 4 * 1024 * 1024 },
        );
        return browsersInRegistry(key, stdout);
      } catch {
        // The key is missing (no browser registered there).
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const browsers: BrowserChoice[] = [];
  for (const browser of lists.flat()) {
    const key = browser.path.toLowerCase();
    if (seen.has(key) || !(await exists(browser.path))) continue;
    seen.add(key);
    browsers.push(browser);
  }
  return browsers;
}

async function macBrowsers(): Promise<BrowserChoice[]> {
  const folders = ["/Applications", path.join(homedir(), "Applications")];
  const browsers: BrowserChoice[] = [];
  for (const name of MAC_BROWSERS) {
    for (const folder of folders) {
      const app = path.posix.join(folder, `${name}.app`);
      if (await exists(app)) {
        browsers.push({ path: app, name });
        break;
      }
    }
  }
  return browsers;
}

/** The browsers installed on this computer, for the form to offer. */
export async function listBrowsers(): Promise<BrowserChoice[]> {
  if (process.platform === "win32") return windowsBrowsers();
  if (process.platform === "darwin") return macBrowsers();
  return [];
}

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The installed browser at `choice.path`, as found here; null when it is not one. */
export async function findBrowser(choice: Pick<BrowserChoice, "path">): Promise<BrowserChoice | null> {
  return (await listBrowsers()).find((browser) => samePath(browser.path, choice.path)) ?? null;
}

/**
 * The form's browser for a web app, as saved: one found here (with the name
 * found here), or the one the app already has, even if it is no longer
 * installed (so the rest of the app can still be edited). Anything else is
 * refused.
 */
export async function checkBrowserChoice(input: MyAppInput, previous: MyApp | null): Promise<MyAppInput> {
  if (input.kind !== "web" || !input.browser) return input;
  const found = await findBrowser(input.browser);
  if (found) return { ...input, browser: found };
  const before = previous?.kind === "web" ? previous.browser : null;
  if (before && samePath(before.path, input.browser.path)) return { ...input, browser: before };
  throw new InvalidRequestError("Not an installed browser");
}

/**
 * Opens `url` (an app's checked http/https address) in `browser`, one found
 * by `findBrowser`. Passed as an argument, never through a shell.
 */
function launchBrowser(browser: BrowserChoice, url: string) {
  return new Promise<void>((resolve, reject) => {
    if (process.platform === "darwin") {
      // `open` hands the address to the app and exits; a failure shows in its code.
      const child = spawn("open", ["-a", browser.path, url], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`open exited with ${code}`))));
      return;
    }
    // The browser keeps running after this app quits.
    const child = spawn(browser.path, [url], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Opens a web app in its browser, or in the default one when it has none.
 * A browser that is gone (uninstalled, moved) or fails to start is told in
 * a message box, which offers the default browser instead.
 */
export async function openAppInBrowser(item: WebApp, window: BrowserWindow | null) {
  if (!item.browser) {
    await shell.openExternal(item.url);
    return;
  }
  const browser = await findBrowser(item.browser);
  let problem = browser ? "" : "이 컴퓨터에서 이 브라우저를 찾을 수 없습니다. 지워졌거나 옮겨졌을 수 있습니다.";
  if (browser) {
    try {
      await launchBrowser(browser, item.url);
      return;
    } catch (error) {
      problem = `브라우저를 실행하지 못했습니다. (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  const options = {
    type: "warning" as const,
    title: "브라우저에서 열기",
    message: `${item.browser.name}에서 ${item.name}을(를) 열지 못했습니다.`,
    detail: `${problem}\n앱 관리에서 열 브라우저를 다시 골라 주세요.`,
    buttons: ["기본 브라우저에서 열기", "닫기"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response === 0) await shell.openExternal(item.url);
}
