import { type BrowserWindow, dialog, nativeImage, type OpenDialogOptions, shell } from "electron";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  fileNameOf,
  isProgramPath,
  MAC_PROGRAM_EXTENSIONS,
  MAX_APP_NAME_LENGTH,
  type MyAppInput,
  PROGRAM_EXTENSIONS,
  type ProgramApp,
} from "@/features/apps/apps";
import type { PickedProgram } from "@/features/apps/bridge";
import { fileIconImage } from "../avatars";
import { InvalidRequestError } from "../errors";
import { toAppIcon } from "./icons";

/**
 * Programs as MyApps. The page never names a program to run: a path is
 * saved only if the user picked it in the file dialog during this run (or it
 * is the one already saved for that app), so a script that got into the page
 * still could not make the app run something of its choosing.
 */
const picked = new Set<string>();

const ON_MAC = process.platform === "darwin";

async function showDialog(window: BrowserWindow | null) {
  const options: OpenDialogOptions = ON_MAC
    ? {
        title: "실행할 앱 선택",
        // A Mac open panel shows this, not the title.
        message: "MyApps에 넣을 앱을 고르세요.",
        defaultPath: "/Applications",
        // An app is picked as one item, not opened as a folder; an alias is
        // followed to the app it stands for.
        properties: ["openFile"],
        filters: [{ name: "앱 (app, command)", extensions: [...MAC_PROGRAM_EXTENSIONS] }],
      }
    : {
        title: "실행할 프로그램 선택",
        // A shortcut is kept as itself (with its options), not swapped for its target.
        properties: ["openFile", "noResolveAliases"],
        filters: [{ name: "프로그램 (exe, 바로 가기, bat, cmd)", extensions: [...PROGRAM_EXTENSIONS] }],
      };
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
}

/**
 * The file whose icon a picked program shows. A shortcut shows its program's
 * icon, or the icon file it names: read from there, it comes at its largest.
 * A shortcut with an icon other than its file's first (an index into a DLL)
 * keeps its own, as Windows draws it.
 */
function iconSource(file: string) {
  if (path.extname(file).toLowerCase() !== ".lnk") return file;
  try {
    const link = shell.readShortcutLink(file);
    const expand = (value: string) =>
      value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
    if (link.icon) return link.iconIndex === 0 ? expand(link.icon) : file;
    return link.target ? expand(link.target) : file;
  } catch {
    return file;
  }
}

/**
 * A picked program's icon, large. On a Mac, an app's icon as Finder draws
 * it (Electron's own file icon there is 32px); elsewhere, or when that
 * fails, the icon read from the file (see `fileIconImage`).
 */
async function programIcon(file: string) {
  if (ON_MAC) {
    try {
      const icon = await nativeImage.createThumbnailFromPath(file, { width: 256, height: 256 });
      if (!icon.isEmpty()) return icon;
    } catch {
      // Electron's file icon below.
    }
  }
  return fileIconImage(iconSource(file), file);
}

/**
 * Asks for a program and returns it with a suggested name (its file name)
 * and its own icon; null when the dialog is cancelled.
 */
export async function chooseProgram(window: BrowserWindow | null): Promise<PickedProgram | null> {
  const choice = await showDialog(window);
  const file = choice.filePaths[0];
  if (choice.canceled || !file) return null;
  if (!isProgramPath(file)) throw new InvalidRequestError("Not a program");
  picked.add(file);

  let icon: string | null = null;
  try {
    icon = toAppIcon(await programIcon(file));
  } catch {
    // No icon: the letter tile.
  }
  const name = path.parse(fileNameOf(file)).name.slice(0, MAX_APP_NAME_LENGTH) || "프로그램";
  return { path: file, name, icon };
}

/** Refuses a program path the user did not pick (see above). */
export function checkProgramPath(input: MyAppInput, previous: { kind: string; path?: string } | null) {
  if (input.kind !== "program") return;
  const unchanged = previous?.kind === "program" && previous.path === input.path;
  if (!unchanged && !picked.has(input.path)) throw new InvalidRequestError("Program not picked");
}

/**
 * Runs the program as if double-clicked (so shortcuts, batch files, and
 * programs asking for administrator rights work too). A missing file or a
 * refusal is told in a message box: the program may have been moved or
 * uninstalled since it was added.
 */
export async function launchProgram(item: ProgramApp, window: BrowserWindow | null) {
  let problem = "";
  try {
    await access(item.path);
  } catch {
    problem = "파일을 찾을 수 없습니다. 옮겨졌거나 지워졌을 수 있습니다.";
  }
  // Resolves to an error message rather than rejecting.
  if (!problem) problem = await shell.openPath(item.path);
  if (!problem) return;
  const options = {
    type: "warning" as const,
    title: "프로그램 실행",
    message: `${item.name}을(를) 실행하지 못했습니다.`,
    detail: `${item.path}\n\n${problem}\n앱 관리에서 프로그램을 다시 선택해 주세요.`,
    buttons: ["확인"],
  };
  if (window) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}
