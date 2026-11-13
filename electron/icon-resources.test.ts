import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { largestIconPng, pngSize } from "./icon-resources";

/** The start of a PNG of the given size: enough for the header to be read. */
function fakePng(size: number) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(size, 16);
  header.writeUInt32BE(size, 20);
  return header;
}

/** A bitmap picture (BITMAPINFOHEADER first), as small icons are stored. */
function fakeBitmap() {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(40, 0);
  return data;
}

type Picture = { size: number; bitCount?: number; data: Buffer };

function icoFile(pictures: Picture[]) {
  const header = Buffer.alloc(6 + pictures.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pictures.length, 4);
  let offset = header.length;
  pictures.forEach((picture, index) => {
    const at = 6 + index * 16;
    header[at] = picture.size >= 256 ? 0 : picture.size;
    header[at + 1] = picture.size >= 256 ? 0 : picture.size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(picture.bitCount ?? 32, at + 6);
    header.writeUInt32LE(picture.data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += picture.data.length;
  });
  return Buffer.concat([header, ...pictures.map((picture) => picture.data)]);
}

/** Appends buffers and tells where each went, so offsets can be filled in later. */
class Layout {
  parts: Buffer[] = [];
  length = 0;
  add(buffer: Buffer) {
    const at = this.length;
    this.parts.push(buffer);
    this.length += buffer.length;
    return at;
  }
}

const SUBDIRECTORY = 0x80000000;
const NAMED = 0x80000000;

/** A resource section: `groups` (RT_GROUP_ICON, in directory order) listing pictures stored as RT_ICON. */
function resourceSection(baseRva: number, groups: { name?: string; id?: number; pictures: Picture[] }[]) {
  const layout = new Layout();
  const directory = (named: number, numbered: number) => {
    const buffer = Buffer.alloc(16 + (named + numbered) * 8);
    buffer.writeUInt16LE(named, 12);
    buffer.writeUInt16LE(numbered, 14);
    return { buffer, at: layout.add(buffer) };
  };
  const setEntry = (dir: Buffer, index: number, name: number, target: number) => {
    dir.writeUInt32LE(name >>> 0, 16 + index * 8);
    dir.writeUInt32LE(target >>> 0, 16 + index * 8 + 4);
  };

  const icons = groups.flatMap((group) => group.pictures).map((picture, index) => ({ id: index + 1, picture }));
  const root = directory(0, 2);
  const iconType = directory(0, icons.length);
  const named = groups.filter((group) => group.name).length;
  const groupType = directory(named, groups.length - named);
  setEntry(root.buffer, 0, 3, SUBDIRECTORY | iconType.at);
  setEntry(root.buffer, 1, 14, SUBDIRECTORY | groupType.at);

  const pending: { record: Buffer; data: Buffer }[] = [];
  /** name → language → data entry. */
  const leaf = (data: Buffer) => {
    const language = directory(0, 1);
    const record = Buffer.alloc(16);
    setEntry(language.buffer, 0, 0x409, layout.add(record));
    pending.push({ record, data });
    return language.at;
  };
  icons.forEach(({ id, picture }, index) => setEntry(iconType.buffer, index, id, SUBDIRECTORY | leaf(picture.data)));

  let nextIcon = 1;
  groups.forEach((group, index) => {
    const data = Buffer.alloc(6 + group.pictures.length * 14);
    data.writeUInt16LE(1, 2);
    data.writeUInt16LE(group.pictures.length, 4);
    group.pictures.forEach((picture, pictureIndex) => {
      const at = 6 + pictureIndex * 14;
      data[at] = picture.size >= 256 ? 0 : picture.size;
      data[at + 1] = picture.size >= 256 ? 0 : picture.size;
      data.writeUInt16LE(1, at + 4);
      data.writeUInt16LE(picture.bitCount ?? 32, at + 6);
      data.writeUInt32LE(picture.data.length, at + 8);
      data.writeUInt16LE(nextIcon++, at + 12);
    });
    let name = group.id ?? index + 100;
    if (group.name) {
      const text = Buffer.alloc(2 + group.name.length * 2);
      text.writeUInt16LE(group.name.length, 0);
      text.write(group.name, 2, "utf16le");
      name = NAMED | layout.add(text);
    }
    setEntry(groupType.buffer, index, name, SUBDIRECTORY | leaf(data));
  });

  for (const { record, data } of pending) {
    record.writeUInt32LE(baseRva + layout.add(data), 0);
    record.writeUInt32LE(data.length, 4);
  }
  return Buffer.concat(layout.parts);
}

/** A minimal Windows program: headers, one section holding the resources. */
function peFile(resources: (baseRva: number) => Buffer, { is64 = true } = {}) {
  const rva = 0x1000;
  const rawOffset = 0x200;
  const section = resources(rva);
  const peOffset = 0x40;
  const optionalSize = is64 ? 0xf0 : 0xe0;
  const file = Buffer.alloc(rawOffset + section.length);
  file.write("MZ", 0, "latin1");
  file.writeUInt32LE(peOffset, 0x3c);
  file.write("PE\0\0", peOffset, "latin1");
  file.writeUInt16LE(1, peOffset + 6);
  file.writeUInt16LE(optionalSize, peOffset + 20);
  const optional = peOffset + 24;
  file.writeUInt16LE(is64 ? 0x20b : 0x10b, optional);
  const directories = optional + (is64 ? 112 : 96);
  file.writeUInt32LE(16, directories - 4);
  file.writeUInt32LE(rva, directories + 16);
  file.writeUInt32LE(section.length, directories + 20);
  const table = optional + optionalSize;
  file.writeUInt32LE(section.length, table + 8);
  file.writeUInt32LE(rva, table + 12);
  file.writeUInt32LE(section.length, table + 16);
  file.writeUInt32LE(rawOffset, table + 20);
  section.copy(file, rawOffset);
  return file;
}

let dir = "";
const write = async (name: string, data: Buffer) => {
  const file = path.join(dir, name);
  await writeFile(file, data);
  return file;
};
const sizeOf = (png: Buffer | null) => (png ? pngSize(png).width : null);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "icon-resources-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("largestIconPng from .ico files", () => {
  it("takes the largest PNG picture", async () => {
    const file = await write(
      "app.ico",
      icoFile([
        { size: 16, bitCount: 8, data: fakeBitmap() },
        { size: 256, data: fakePng(256) },
        { size: 64, data: fakePng(64) },
      ]),
    );
    expect(sizeOf(await largestIconPng(file))).toBe(256);
  });

  it("skips a large bitmap for the next PNG, but not down to Windows' own size", async () => {
    const file = await write(
      "old.ico",
      icoFile([
        { size: 256, data: fakeBitmap() },
        { size: 128, data: fakePng(128) },
      ]),
    );
    expect(sizeOf(await largestIconPng(file))).toBe(128);
    const small = await write("small.ico", icoFile([{ size: 48, data: fakePng(48) }]));
    expect(await largestIconPng(small)).toBeNull();
  });
});

describe("largestIconPng from programs", () => {
  it.each([true, false])("reads the first icon group (64-bit: %s)", async (is64) => {
    const file = await write(
      `app-${is64}.exe`,
      peFile(
        (rva) =>
          resourceSection(rva, [
            // A named group comes first in the directory, as MAINICON often does.
            { name: "MAINICON", pictures: [{ size: 32, data: fakeBitmap() }, { size: 256, data: fakePng(256) }] },
            { id: 2, pictures: [{ size: 128, data: fakePng(128) }] },
          ]),
        { is64 },
      ),
    );
    expect(sizeOf(await largestIconPng(file))).toBe(256);
  });

  it("leaves programs without a large PNG, damaged files, and other files to Windows", async () => {
    const small = await write(
      "small.exe",
      peFile((rva) => resourceSection(rva, [{ id: 1, pictures: [{ size: 48, data: fakeBitmap() }] }])),
    );
    expect(await largestIconPng(small)).toBeNull();

    const cut = peFile((rva) => resourceSection(rva, [{ id: 1, pictures: [{ size: 256, data: fakePng(256) }] }]));
    expect(await largestIconPng(await write("cut.exe", cut.subarray(0, 0x220)))).toBeNull();
    expect(await largestIconPng(await write("text.exe", Buffer.from("not a program")))).toBeNull();
    expect(await largestIconPng(await write("picture.png", fakePng(256)))).toBeNull();
    expect(await largestIconPng(path.join(dir, "missing.exe"))).toBeNull();
  });

  const notepad = "C:\\Windows\\System32\\notepad.exe";
  it.skipIf(!existsSync(notepad))("reads a real Windows program", async () => {
    expect(sizeOf(await largestIconPng(notepad))).toBe(256);
  });
});
