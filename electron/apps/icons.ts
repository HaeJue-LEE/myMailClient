import type { BrowserWindow, NativeImage } from "electron";
import { APP_ICON_SIZE } from "@/features/apps/apps";
import { chooseImage } from "../avatars";

/**
 * The picture shown for an app instead of its letter tile. Unlike an account
 * picture it is not cut to a square: a logo keeps its whole shape, shrunk to
 * fit the icon square (never enlarged) and shown centred in the tile.
 */
export function toAppIcon(image: NativeImage): string {
  const { width, height } = image.getSize();
  const scale = Math.min(1, APP_ICON_SIZE / Math.max(width, height));
  const fitted =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: "best",
        })
      : image;
  return `data:image/png;base64,${fitted.toPNG().toString("base64")}`;
}

/**
 * Asks for an image file for an app's icon. Nothing is stored here: the
 * edit form shows the picture and saves it with the app's other fields.
 * Null when the dialog is cancelled.
 */
export async function chooseAppIcon(window: BrowserWindow | null): Promise<string | null> {
  const image = await chooseImage(window, "앱 아이콘 선택");
  return image ? toAppIcon(image) : null;
}
