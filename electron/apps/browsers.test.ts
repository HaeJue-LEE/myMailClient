import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebApp } from "@/features/apps/apps";

const spawned: { command: string; args: string[] }[] = [];
/** How the next program run fails: not starting at all, or exiting with an error. */
let spawnFails: false | "error" | "exit" = false;
let registry: Record<string, string> = {};
let installed = new Set<string>();
const external: string[] = [];
let messages: { message: string; buttons: string[] }[] = [];
let response = 0;

vi.mock("electron", () => ({
  dialog: {
    showMessageBox: async (options: { message: string; buttons: string[] }) => {
      messages.push(options);
      return { response };
    },
  },
  shell: { openExternal: async (url: string) => void external.push(url) },
}));

vi.mock("node:fs/promises", () => ({
  access: async (file: string) => {
    if (!installed.has(file)) throw new Error("ENOENT");
  },
}));

vi.mock("node:child_process", () => ({
  // `reg query` through cmd: answers with the listing of the key it names.
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    done: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    const key = /reg query "([^"]+)"/.exec(args.at(-1) ?? "")?.[1] ?? "";
    if (key in registry) done(null, { stdout: registry[key], stderr: "" });
    else done(new Error("ERROR: The system was unable to find the specified registry key or value."));
  },
  spawn: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { unref: () => undefined });
    spawned.push({ command, args });
    queueMicrotask(() => {
      if (spawnFails === "error") child.emit("error", new Error("spawn EACCES"));
      else {
        child.emit("spawn");
        child.emit("exit", spawnFails === "exit" ? 1 : 0);
      }
    });
    return child;
  },
}));

const browsers = await import("./browsers");

const MACHINE = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet";
const USER = "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WHALE = "C:\\Users\\Example\\AppData\\Local\\Naver\\Naver Whale\\Application\\whale.exe";

/** A `reg query … /s` listing as Windows prints it. */
const listing = (root: string, browsersIn: { key: string; name: string; command: string; appName?: string }[]) =>
  [
    root,
    "    (Default)    REG_SZ    ",
    "",
    ...browsersIn.flatMap(({ key, name, command, appName }) => [
      `${root}\\${key}`,
      `    (Default)    REG_SZ    ${name}`,
      "",
      `${root}\\${key}\\Capabilities`,
      `    ApplicationName    REG_SZ    ${appName ?? name}`,
      "",
      `${root}\\${key}\\Capabilities\\URLAssociations`,
      "    https    REG_SZ    ChromeHTML",
      "",
      `${root}\\${key}\\shell\\open\\command`,
      `    (Default)    REG_SZ    ${command}`,
      "",
    ]),
  ].join("\r\n");

const realPlatform = process.platform;
const onPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: platform });

const app = (browser: WebApp["browser"]): WebApp => ({
  kind: "web",
  id: "a",
  name: "ChatGPT",
  url: "https://chatgpt.com/",
  group: "",
  openIn: "browser",
  pinned: false,
  icon: null,
  hideAddressBar: false,
  browser,
  trustedCerts: [],
});

beforeEach(() => {
  spawned.length = 0;
  external.length = 0;
  messages = [];
  response = 0;
  spawnFails = false;
  registry = {};
  installed = new Set();
});
afterEach(() => onPlatform(realPlatform));

describe("reading the Windows registry", () => {
  it("takes each browser's name and program, quoted or not, with variables expanded", () => {
    process.env.EXAMPLE_LOCAL = "C:\\Users\\Example\\AppData\\Local";
    const found = browsers.browsersInRegistry(
      MACHINE,
      listing(MACHINE, [
        { key: "Google Chrome", name: "Google Chrome", command: `"${CHROME}"` },
        { key: "FIREFOX.EXE", name: "Firefox", command: "C:\\Program Files\\Mozilla Firefox\\firefox.exe -osint -url" },
        { key: "Whale", name: "Whale", command: '"%EXAMPLE_LOCAL%\\Naver\\Naver Whale\\Application\\whale.exe"', appName: "네이버 웨일" },
      ]),
    );
    expect(found).toEqual([
      { path: CHROME, name: "Google Chrome" },
      { path: "C:\\Program Files\\Mozilla Firefox\\firefox.exe", name: "Firefox" },
      { path: WHALE, name: "네이버 웨일" },
    ]);
  });

  it("reads a translated default value name, and skips a resource name and Internet Explorer", () => {
    const output = listing(MACHINE, [
      { key: "Microsoft Edge", name: "Microsoft Edge", command: `"${EDGE}"`, appName: "@C:\\x\\edge.dll,-1" },
      { key: "IEXPLORE.EXE", name: "Internet Explorer", command: "C:\\Program Files\\Internet Explorer\\iexplore.exe" },
    ]).replaceAll("(Default)", "(기본값)");
    expect(browsers.browsersInRegistry(MACHINE, output)).toEqual([{ path: EDGE, name: "Microsoft Edge" }]);
  });

  it("finds the program in a command line", () => {
    expect(browsers.commandProgram(`"${CHROME}" --flag`)).toBe(CHROME);
    expect(browsers.commandProgram("C:\\Tools\\browser.exe -url")).toBe("C:\\Tools\\browser.exe");
    expect(browsers.commandProgram("")).toBeNull();
  });
});

describe("listing browsers", () => {
  it("on Windows, lists the installed ones once, the user's own first", async () => {
    onPlatform("win32");
    registry = {
      [USER]: listing(USER, [{ key: "Whale", name: "Whale", command: `"${WHALE}"` }]),
      [MACHINE]: listing(MACHINE, [
        { key: "Google Chrome", name: "Google Chrome", command: `"${CHROME}"` },
        { key: "Microsoft Edge", name: "Microsoft Edge", command: `"${EDGE}"` },
        { key: "Gone", name: "Gone", command: '"C:\\Gone\\gone.exe"' },
      ]),
      // The 32-bit list repeats a browser already found.
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet": listing(
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet",
        [{ key: "Google Chrome", name: "Google Chrome", command: `"${CHROME.toUpperCase()}"` }],
      ),
    };
    installed = new Set([WHALE, CHROME, EDGE, CHROME.toUpperCase()]);
    expect((await browsers.listBrowsers()).map((item) => item.name)).toEqual(["Whale", "Google Chrome", "Microsoft Edge"]);
  });

  it("on a Mac, lists the browser apps in Applications, Safari first", async () => {
    onPlatform("darwin");
    installed = new Set(["/Applications/Safari.app", "/Applications/Firefox.app", "/Applications/Google Chrome.app"]);
    expect(await browsers.listBrowsers()).toEqual([
      { path: "/Applications/Safari.app", name: "Safari" },
      { path: "/Applications/Google Chrome.app", name: "Google Chrome" },
      { path: "/Applications/Firefox.app", name: "Firefox" },
    ]);
  });

  it("finds none elsewhere", async () => {
    onPlatform("linux");
    expect(await browsers.listBrowsers()).toEqual([]);
  });
});

describe("saving a browser choice", () => {
  const web = {
    kind: "web" as const,
    name: "ChatGPT",
    url: "https://chatgpt.com/",
    group: "",
    openIn: "browser" as const,
    pinned: false,
  };

  it("takes an installed browser, with the name found here", async () => {
    onPlatform("win32");
    registry = { [MACHINE]: listing(MACHINE, [{ key: "Google Chrome", name: "Google Chrome", command: `"${CHROME}"` }]) };
    installed = new Set([CHROME]);
    const checked = await browsers.checkBrowserChoice({ ...web, browser: { path: CHROME.toLowerCase(), name: "x" } }, null);
    expect(checked).toMatchObject({ browser: { path: CHROME, name: "Google Chrome" } });
    expect(await browsers.checkBrowserChoice({ ...web, browser: null }, null)).toMatchObject({ browser: null });
  });

  it("refuses a program that is not an installed browser, unless the app already had it", async () => {
    onPlatform("win32");
    const other = { path: "C:\\Windows\\System32\\cmd.exe", name: "Chrome" };
    await expect(browsers.checkBrowserChoice({ ...web, browser: other }, null)).rejects.toThrow();
    const kept = await browsers.checkBrowserChoice({ ...web, browser: other }, app(other));
    expect(kept).toMatchObject({ browser: other });
  });
});

describe("opening in a browser", () => {
  it("opens in the default browser when none is picked", async () => {
    await browsers.openAppInBrowser(app(null), null);
    expect(external).toEqual(["https://chatgpt.com/"]);
    expect(spawned).toEqual([]);
  });

  it("on Windows, runs the browser with the address", async () => {
    onPlatform("win32");
    registry = { [MACHINE]: listing(MACHINE, [{ key: "Google Chrome", name: "Google Chrome", command: `"${CHROME}"` }]) };
    installed = new Set([CHROME]);
    await browsers.openAppInBrowser(app({ path: CHROME, name: "Google Chrome" }), null);
    expect(spawned).toEqual([{ command: CHROME, args: ["https://chatgpt.com/"] }]);
    expect(external).toEqual([]);
  });

  it("on a Mac, opens the address with the browser app", async () => {
    onPlatform("darwin");
    installed = new Set(["/Applications/Firefox.app"]);
    await browsers.openAppInBrowser(app({ path: "/Applications/Firefox.app", name: "Firefox" }), null);
    expect(spawned).toEqual([{ command: "open", args: ["-a", "/Applications/Firefox.app", "https://chatgpt.com/"] }]);
  });

  it("says so when the browser is gone, and offers the default one", async () => {
    onPlatform("darwin");
    await browsers.openAppInBrowser(app({ path: "/Applications/Firefox.app", name: "Firefox" }), null);
    expect(spawned).toEqual([]);
    expect(messages[0].message).toContain("Firefox");
    expect(external).toEqual(["https://chatgpt.com/"]);

    response = 1;
    await browsers.openAppInBrowser(app({ path: "/Applications/Firefox.app", name: "Firefox" }), null);
    expect(external).toHaveLength(1);
  });

  it("says so when the browser fails to start", async () => {
    response = 1;
    onPlatform("darwin");
    installed = new Set(["/Applications/Firefox.app", CHROME]);
    spawnFails = "exit";
    await browsers.openAppInBrowser(app({ path: "/Applications/Firefox.app", name: "Firefox" }), null);
    onPlatform("win32");
    registry = { [MACHINE]: listing(MACHINE, [{ key: "Google Chrome", name: "Google Chrome", command: `"${CHROME}"` }]) };
    spawnFails = "error";
    await browsers.openAppInBrowser(app({ path: CHROME, name: "Google Chrome" }), null);
    expect(messages.map((item) => item.message)).toEqual([
      "Firefox에서 ChatGPT을(를) 열지 못했습니다.",
      "Google Chrome에서 ChatGPT을(를) 열지 못했습니다.",
    ]);
    expect(external).toEqual([]);
  });
});
