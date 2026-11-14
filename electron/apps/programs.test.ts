import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramApp } from "@/features/apps/apps";
import { InvalidRequestError } from "../errors";

const TOOL_PATH = "C:\\Tools\\Example\\example.exe";

let picked: string[] = [];
let dialogOptions: unknown = null;
let openResult = "";
const opened: string[] = [];
const messages: { message: string; detail: string }[] = [];

vi.mock("electron", () => ({
  app: { getFileIcon: async () => ({ isEmpty: () => true }) },
  nativeImage: { createThumbnailFromPath: async () => ({ isEmpty: () => true }) },
  dialog: {
    showOpenDialog: async (options: unknown) => {
      dialogOptions = options;
      return { canceled: picked.length === 0, filePaths: picked };
    },
    showMessageBox: async (options: { message: string; detail: string }) => {
      messages.push(options);
      return { response: 0 };
    },
  },
  shell: {
    openPath: async (file: string) => {
      opened.push(file);
      return openResult;
    },
  },
}));

const { checkProgramPath, chooseProgram, launchProgram } = await import("./programs");

const input = (programPath: string) => ({
  kind: "program" as const,
  name: "Example",
  path: programPath,
  group: "",
  pinned: false,
});

let folder = "";
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "programs-"));
  picked = [];
  openResult = "";
  opened.length = 0;
  messages.length = 0;
});
afterEach(() => rm(folder, { recursive: true, force: true }));

describe("picking a program", () => {
  it("returns the picked program with its file name as the name", async () => {
    picked = [TOOL_PATH];
    expect(await chooseProgram(null)).toEqual({ path: TOOL_PATH, name: "example", icon: null });
  });

  it("returns a picked Mac app with its name without .app", async () => {
    picked = ["/Applications/Example Tool.app"];
    expect(await chooseProgram(null)).toEqual({
      path: "/Applications/Example Tool.app",
      name: "Example Tool",
      icon: null,
    });
  });

  it("returns null when the dialog is cancelled, and refuses a file that is not a program", async () => {
    expect(await chooseProgram(null)).toBeNull();
    picked = ["C:\\Tools\\notes.txt"];
    await expect(chooseProgram(null)).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe("the file dialog", () => {
  const platform = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: platform }));

  /** `chooseProgram` as loaded on `os`, which it checks once when loaded. */
  async function chooseOn(os: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: os });
    vi.resetModules();
    return (await import("./programs")).chooseProgram;
  }

  it("offers programs, shortcuts kept as themselves, and batch files on Windows", async () => {
    await (await chooseOn("win32"))(null);
    expect(dialogOptions).toMatchObject({
      properties: ["openFile", "noResolveAliases"],
      filters: [{ extensions: ["exe", "lnk", "bat", "cmd"] }],
    });
  });

  it("offers apps and Terminal scripts from Applications on a Mac, following aliases", async () => {
    await (await chooseOn("darwin"))(null);
    expect(dialogOptions).toMatchObject({
      defaultPath: "/Applications",
      properties: ["openFile"],
      filters: [{ extensions: ["app", "command"] }],
    });
  });
});

describe("saving a program", () => {
  it("accepts only a path picked in the dialog, or the one already saved", async () => {
    const other = "C:\\Tools\\Other\\other.exe";
    // Never picked: refused, even though it is a valid path.
    expect(() => checkProgramPath(input(other), null)).toThrow(InvalidRequestError);
    // Already saved for the app being edited: fine.
    expect(() => checkProgramPath(input(other), { kind: "program", path: other })).not.toThrow();
    // Picked this run: fine.
    picked = [other];
    await chooseProgram(null);
    expect(() => checkProgramPath(input(other), null)).not.toThrow();
  });

  it("does not check web apps", () => {
    const web = { kind: "web" as const, name: "NAS", url: "https://nas.example.lan", group: "", openIn: "embed" as const, pinned: false };
    expect(() => checkProgramPath(web, null)).not.toThrow();
  });
});

describe("running a program", () => {
  const program = (programPath: string): ProgramApp => ({
    kind: "program",
    id: "p",
    name: "Example",
    path: programPath,
    group: "",
    pinned: false,
    icon: null,
  });

  it("opens an existing program, with nothing to tell", async () => {
    const file = path.join(folder, "example.exe");
    await writeFile(file, "");
    await launchProgram(program(file), null);
    expect(opened).toEqual([file]);
    expect(messages).toEqual([]);
  });

  it("opens a Mac app, which is a folder", async () => {
    const app = path.join(folder, "Example.app");
    await mkdir(app);
    await launchProgram(program(app), null);
    expect(opened).toEqual([app]);
    expect(messages).toEqual([]);
  });

  it("tells when the program is gone, without trying to open it", async () => {
    const file = path.join(folder, "missing.exe");
    await launchProgram(program(file), null);
    expect(opened).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0].detail).toContain(file);
    expect(messages[0].detail).toContain("찾을 수 없습니다");
  });

  it("tells when Windows refuses to open it", async () => {
    const file = path.join(folder, "example.exe");
    await writeFile(file, "");
    openResult = "Failed to open path";
    await launchProgram(program(file), null);
    expect(messages[0].detail).toContain("Failed to open path");
  });
});
