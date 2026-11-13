import type { NativeImage } from "electron";
import { describe, expect, it, vi } from "vitest";
import { APP_ICON_SIZE } from "@/features/apps/apps";

vi.mock("electron", () => ({}));
vi.mock("../avatars", () => ({ chooseImage: vi.fn() }));

const { toAppIcon } = await import("./icons");

/** A stand-in for Electron's image that records how it was resized. */
function fakeImage(width: number, height: number) {
  const resized: unknown[] = [];
  const image = {
    getSize: () => ({ width, height }),
    resize: (options: unknown) => {
      resized.push(options);
      return image;
    },
    toPNG: () => Buffer.from("png"),
  };
  return { image: image as unknown as NativeImage, resized };
}

describe("toAppIcon", () => {
  it("shrinks a large logo to fit the icon square, keeping its shape", () => {
    const { image, resized } = fakeImage(1024, 256);
    expect(toAppIcon(image)).toBe(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
    expect(resized).toEqual([{ width: APP_ICON_SIZE, height: 32, quality: "best" }]);
  });

  it("leaves a small image at its size", () => {
    const { image, resized } = fakeImage(32, 32);
    toAppIcon(image);
    expect(resized).toEqual([]);
  });

  it("never makes a side zero", () => {
    const { image, resized } = fakeImage(5000, 10);
    toAppIcon(image);
    expect(resized).toEqual([{ width: APP_ICON_SIZE, height: 1, quality: "best" }]);
  });
});
