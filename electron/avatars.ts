import { app, type BrowserWindow, dialog, nativeImage, type NativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { InvalidRequestError } from "./errors";
import { largestIconPng } from "./icon-resources";

/**
 * A picture per account, shown instead of its first letter where accounts
 * are listed and picked. Chosen by the user, kept on this computer only, and
 * stored small (a square PNG) so it can travel to the page as a data URL.
 */

/** Twice the largest size shown, for sharp high-DPI displays. */
const AVATAR_SIZE = 96;
/** Larger files are refused before decoding: a photo for an icon need not be huge. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** What Electron's image decoder reads on every platform. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"];
/** Files whose icon is taken instead: programs and icon files. */
const ICON_EXTENSIONS = ["exe", "ico"];

const avatarDir = () => path.join(app.getPath("userData"), "avatars");
/** Account ids are generated or "gmail"; encoded anyway so no id becomes a path. */
const avatarPath = (accountId: string) =>
  path.join(avatarDir(), `${Buffer.from(accountId).toString("base64url")}.png`);

/** The account's picture as a data URL, or null when none was chosen. */
export async function getAvatar(accountId: string): Promise<string | null> {
  try {
    const png = await readFile(avatarPath(accountId));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

/** The middle square of the image, scaled to the stored size. */
export function toAvatar(image: NativeImage): Buffer {
  const { width, height } = image.getSize();
  const side = Math.min(width, height);
  const square = image.crop({
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    width: side,
    height: side,
  });
  return square.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, quality: "best" }).toPNG();
}

/**
 * The icon of a file as Explorer shows it, at its largest: the 256px picture
 * of a program or icon file when it has one, else Windows' own for
 * `shownFile` (48px, for any file; a shortcut whose icon is read from its
 * program shows its own when that program has no large one). Refuses a file
 * with no icon.
 */
export async function fileIconImage(file: string, shownFile = file): Promise<NativeImage> {
  const png = await largestIconPng(file);
  const large = png ? nativeImage.createFromBuffer(png) : null;
  if (large && !large.isEmpty()) return large;
  const icon = await app.getFileIcon(shownFile, { size: "large" });
  if (icon.isEmpty()) throw new InvalidRequestError("Not a supported image");
  return icon;
}

/**
 * Asks for a picture and decodes it: an image file (PNG or JPG), or a
 * program or icon file (EXE, ICO) whose icon is taken. Null when the dialog
 * is cancelled; refuses files that are too large or not pictures. A
 * shortcut picked in the dialog comes back as the program it points to.
 */
export async function chooseImage(window: BrowserWindow | null, title: string): Promise<NativeImage | null> {
  const options = {
    title,
    properties: ["openFile" as const],
    filters: [
      { name: "이미지·프로그램 아이콘 (PNG, JPG, EXE, ICO)", extensions: [...IMAGE_EXTENSIONS, ...ICON_EXTENSIONS] },
      { name: "이미지 (PNG, JPG)", extensions: IMAGE_EXTENSIONS },
      { name: "프로그램·아이콘 파일 (EXE, ICO)", extensions: ICON_EXTENSIONS },
    ],
  };
  const choice = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const file = choice.filePaths[0];
  if (choice.canceled || !file) return null;

  if (ICON_EXTENSIONS.includes(path.extname(file).slice(1).toLowerCase())) return fileIconImage(file);
  const bytes = await readFile(file);
  if (bytes.length > MAX_SOURCE_BYTES) throw new InvalidRequestError("Image too large");
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new InvalidRequestError("Not a supported image");
  return image;
}

/**
 * Asks for an image file and stores it as the account's picture. Returns
 * false when the dialog is cancelled; refuses files that are not images.
 */
export async function chooseAvatar(window: BrowserWindow | null, accountId: string) {
  const image = await chooseImage(window, "계정 사진 선택");
  if (!image) return false;

  await mkdir(avatarDir(), { recursive: true });
  const target = avatarPath(accountId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, toAvatar(image));
  await rename(temporary, target);
  return true;
}

/** Goes back to the first letter; also run when the account is removed. */
export async function removeAvatar(accountId: string) {
  await rm(avatarPath(accountId), { force: true });
}
