import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { safeFilename } from "./gmail/mime";

/**
 * Opening a received attachment ("보기"): after one warning, it is written
 * to the Downloads folder and opened with the program the system has for it.
 * The warning is the main process's own dialog, so a page cannot skip it.
 */

/**
 * Files that run code when opened: programs, scripts, shortcuts, installers,
 * disk images, and Office files with macros, on Windows and on macOS. The
 * warning says so plainly for these.
 */
const RUNNABLE_EXTENSIONS = new Set([
  "exe", "com", "scr", "pif", "msi", "msix", "msp", "appx", "appxbundle",
  "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
  "lnk", "url", "reg", "cpl", "msc", "jar", "dll", "iso", "img", "vhd", "vhdx",
  "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam",
  "app", "command", "tool", "sh", "zsh", "pkg", "mpkg", "dmg", "scpt",
  "applescript", "workflow", "terminal", "webloc", "inetloc",
]);

export function isRunnable(filename: string) {
  return RUNNABLE_EXTENSIONS.has(path.extname(filename).slice(1).toLowerCase());
}

/**
 * The attachment's name as a file name Windows accepts, saved without asking:
 * no characters Windows refuses (a `:` would even write into a hidden stream
 * of another file), no trailing dots or spaces, and no device names (`CON`,
 * `NUL`, …).
 */
export function windowsFilename(raw: string) {
  let name = safeFilename(raw)
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  return name || "attachment";
}

/** `name`, then `name (1)`, `name (2)`, … keeping the extension last. */
export function numberedName(filename: string, number: number) {
  if (number === 0) return filename;
  const extension = path.extname(filename);
  return `${filename.slice(0, filename.length - extension.length)} (${number})${extension}`;
}

const MAX_NUMBERED = 1000;

/**
 * Writes `data` into `folder` under the attachment's name, numbered when a
 * file of that name is already there: nothing there is ever replaced.
 * Returns the path written.
 */
export async function writeNewFile(folder: string, filename: string, data: Buffer) {
  const name = windowsFilename(filename);
  for (let number = 0; number < MAX_NUMBERED; number++) {
    const target = path.join(folder, numberedName(name, number));
    try {
      await writeFile(target, data, { flag: "wx" });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("No free file name");
}

/** The macOS quarantine mark: downloaded (flags 0081), when, by which app. */
export function quarantineValue(now = Date.now()) {
  return `0081;${Math.floor(now / 1000).toString(16)};Mail Client;`;
}

/**
 * Marks the file as downloaded from the internet, as browsers do, so the
 * system treats it with the same care. On Windows that is the
 * `Zone.Identifier` stream of NTFS: SmartScreen checks a program, Office opens
 * a document in Protected View. On macOS it is the `com.apple.quarantine`
 * attribute: Gatekeeper checks a program or script before it first runs.
 * Skipped where the drive cannot hold the mark.
 */
export async function markFromInternet(file: string) {
  try {
    if (process.platform === "win32") {
      await writeFile(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
    } else if (process.platform === "darwin") {
      await promisify(execFile)("/usr/bin/xattr", ["-w", "com.apple.quarantine", quarantineValue(), file]);
    }
  } catch {
    // FAT or network drives without alternate data streams or attributes.
  }
}

/** The warning shown once before an attachment is opened. */
export function openWarning(filename: string) {
  // The name as saved: `evil.exe.` is saved, and run, as `evil.exe`.
  const name = windowsFilename(filename);
  const runnable = isRunnable(name);
  return {
    type: "warning" as const,
    title: "첨부파일 열기",
    message: `'${name}'을(를) 열까요?`,
    detail: [
      "다운로드 폴더에 저장한 뒤, 이 컴퓨터에서 이 형식의 파일을 여는 프로그램으로 엽니다.",
      runnable
        ? "이 파일은 열면 바로 실행되는 형식(프로그램, 스크립트, 매크로 문서 등)입니다. 이 컴퓨터를 손상시키거나 정보를 빼낼 수 있습니다."
        : "첨부파일에는 악성 코드가 들어 있을 수 있습니다.",
      "보낸 사람을 확실히 알고, 받기로 한 파일일 때만 여세요.",
    ].join("\n\n"),
    buttons: ["열기", "취소"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}
