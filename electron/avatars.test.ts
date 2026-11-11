import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidRequestError } from "./errors";

let userData = "";
let picked: string[] = [];
const PNG_OUT = Buffer.from("small-png");
const crops: unknown[] = [];

/** A stand-in for Electron's image: "IMG:<w>x<h>" decodes, anything else is empty. */
function fakeImage(bytes: Buffer) {
  const match = /^IMG:(\d+)x(\d+)$/.exec(bytes.toString());
  const size = match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 };
  const image = {
    isEmpty: () => !match,
    getSize: () => size,
    crop: (rect: unknown) => {
      crops.push(rect);
      return image;
    },
    resize: () => image,
    toPNG: () => PNG_OUT,
  };
  return image;
}

vi.mock("electron", () => ({
  app: { getPath: () => userData },
  dialog: {
    showOpenDialog: async () => ({ canceled: picked.length === 0, filePaths: picked }),
  },
  nativeImage: { createFromBuffer: (bytes: Buffer) => fakeImage(bytes) },
}));

const { chooseAvatar, getAvatar, removeAvatar } = await import("./avatars");

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "avatars-"));
  picked = [];
  crops.length = 0;
});
afterEach(() => rm(userData, { recursive: true, force: true }));

async function pick(contents: string) {
  const file = path.join(userData, "picked.png");
  await writeFile(file, contents);
  picked = [file];
}

describe("account pictures", () => {
  it("has none until one is chosen", async () => {
    expect(await getAvatar("gmail")).toBeNull();
  });

  it("stores the middle square of the chosen image and returns it as a PNG data URL", async () => {
    await pick("IMG:300x200");
    expect(await chooseAvatar(null, "acct-1")).toBe(true);
    expect(crops).toEqual([{ x: 50, y: 0, width: 200, height: 200 }]);
    expect(await getAvatar("acct-1")).toBe(`data:image/png;base64,${PNG_OUT.toString("base64")}`);
    // Pictures are per account.
    expect(await getAvatar("acct-2")).toBeNull();
  });

  it("changes nothing when the dialog is cancelled", async () => {
    expect(await chooseAvatar(null, "acct-1")).toBe(false);
    expect(await getAvatar("acct-1")).toBeNull();
  });

  it("refuses a file that is not an image, keeping the earlier picture", async () => {
    await pick("IMG:10x10");
    await chooseAvatar(null, "acct-1");
    await pick("not an image");
    await expect(chooseAvatar(null, "acct-1")).rejects.toThrow(InvalidRequestError);
    expect(await getAvatar("acct-1")).not.toBeNull();
    // No temporary file is left behind.
    expect((await readdir(path.join(userData, "avatars"))).length).toBe(1);
  });

  it("goes back to the first letter when removed, even twice", async () => {
    await pick("IMG:10x10");
    await chooseAvatar(null, "acct-1");
    await removeAvatar("acct-1");
    await removeAvatar("acct-1");
    expect(await getAvatar("acct-1")).toBeNull();
  });

  it("keeps account ids from becoming paths", async () => {
    await pick("IMG:10x10");
    await chooseAvatar(null, "../../evil");
    const files = await readdir(path.join(userData, "avatars"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[A-Za-z0-9_-]+\.png$/);
  });
});
