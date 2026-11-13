import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

/**
 * The largest picture in a program's icon (`.exe`, `.dll`) or an icon file
 * (`.ico`), as PNG bytes. Windows itself hands out at most 48px icons
 * (`app.getFileIcon`), too small for a 128px app icon; the 256px picture
 * most programs carry is read from the file here.
 *
 * Only pictures stored as PNG are taken, which is how the large ones are
 * stored. When there is none larger than Windows' own, null tells the
 * caller to use `app.getFileIcon`. So does any file this cannot read: it
 * never throws, and reads only the few parts it needs (a game's .exe can be
 * gigabytes).
 */

/** What `app.getFileIcon(…, { size: "large" })` gives on Windows. */
export const SHELL_ICON_SIZE = 48;
/** One picture of an icon; a 256px PNG is rarely over 100 KB. */
const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
/** Resource directories are small; this only stops a damaged file looping. */
const MAX_DIRECTORY_ENTRIES = 4096;

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const ICON_FILE_EXTENSIONS = ["exe", "dll", "ico"] as const;

export async function largestIconPng(file: string): Promise<Buffer | null> {
  const extension = path.extname(file).slice(1).toLowerCase();
  if (!(ICON_FILE_EXTENSIONS as readonly string[]).includes(extension)) return null;
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, "r");
    const reader = new Reader(handle);
    return extension === "ico" ? await fromIcoFile(reader) : await fromProgram(reader);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

class Reader {
  private readonly handle: FileHandle;

  constructor(handle: FileHandle) {
    this.handle = handle;
  }

  /** Exactly `length` bytes at `offset`; throws when the file is shorter. */
  async bytes(offset: number, length: number) {
    if (offset < 0 || length < 0 || length > MAX_PICTURE_BYTES) throw new Error("bad range");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error("short file");
    return buffer;
  }
}

/** One picture listed in an icon: its size (0 in the file means 256) and where to find it. */
type Picture = { size: number; bitCount: number; load: () => Promise<Buffer> };

/**
 * The largest PNG picture above `SHELL_ICON_SIZE`, tried largest first (and
 * the most colours first among the same size); null when there is none.
 */
async function pickPng(pictures: Picture[]): Promise<Buffer | null> {
  const candidates = pictures
    .filter((picture) => picture.size > SHELL_ICON_SIZE)
    .sort((a, b) => b.size - a.size || b.bitCount - a.bitCount);
  for (const picture of candidates) {
    const data = await picture.load();
    if (isPng(data)) return data;
  }
  return null;
}

export function isPng(data: Buffer) {
  return data.length > 24 && data.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Width and height in a PNG's header. */
export function pngSize(data: Buffer) {
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

const sizeOf = (byte: number) => (byte === 0 ? 256 : byte);

/** An `.ico` file: a 6-byte header, then 16-byte entries pointing into the file. */
async function fromIcoFile(reader: Reader) {
  const header = await reader.bytes(0, 6);
  if (header.readUInt16LE(0) !== 0 || header.readUInt16LE(2) !== 1) return null;
  const count = header.readUInt16LE(4);
  if (count === 0 || count > 255) return null;
  const entries = await reader.bytes(6, count * 16);
  const pictures: Picture[] = [];
  for (let index = 0; index < count; index++) {
    const at = index * 16;
    const length = entries.readUInt32LE(at + 8);
    const offset = entries.readUInt32LE(at + 12);
    pictures.push({
      size: sizeOf(entries[at]),
      bitCount: entries.readUInt16LE(at + 6),
      load: () => reader.bytes(offset, length),
    });
  }
  return pickPng(pictures);
}

type Section = { virtualAddress: number; virtualSize: number; rawSize: number; rawOffset: number };

/**
 * A Windows program (PE file): headers lead to the resource directory, a
 * tree of type → name → language. The first icon group (the one Explorer
 * shows) lists its pictures, each stored as an RT_ICON resource by id.
 */
async function fromProgram(reader: Reader) {
  const dos = await reader.bytes(0, 64);
  if (dos.toString("latin1", 0, 2) !== "MZ") return null;
  const peOffset = dos.readUInt32LE(0x3c);
  const coff = await reader.bytes(peOffset, 24);
  if (coff.toString("latin1", 0, 4) !== "PE\0\0") return null;
  const sectionCount = coff.readUInt16LE(6);
  const optionalSize = coff.readUInt16LE(20);
  const optionalOffset = peOffset + 24;
  const optional = await reader.bytes(optionalOffset, optionalSize);

  // PE32 and PE32+ (64-bit) put the data directories at different offsets.
  const magic = optional.readUInt16LE(0);
  const directoriesAt = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
  if (directoriesAt < 0) return null;
  const directoryCount = optional.readUInt32LE(directoriesAt - 4);
  if (directoryCount < 3 || directoriesAt + 3 * 8 > optional.length) return null;
  const resourceRva = optional.readUInt32LE(directoriesAt + 2 * 8);
  if (resourceRva === 0) return null;

  const table = await reader.bytes(optionalOffset + optionalSize, sectionCount * 40);
  const sections: Section[] = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = index * 40;
    sections.push({
      virtualSize: table.readUInt32LE(at + 8),
      virtualAddress: table.readUInt32LE(at + 12),
      rawSize: table.readUInt32LE(at + 16),
      rawOffset: table.readUInt32LE(at + 20),
    });
  }
  const fileOffset = (rva: number) => {
    const section = sections.find(
      (item) => rva >= item.virtualAddress && rva < item.virtualAddress + Math.max(item.virtualSize, item.rawSize),
    );
    if (!section) throw new Error("address outside the file");
    return section.rawOffset + (rva - section.virtualAddress);
  };
  const resourceBase = fileOffset(resourceRva);

  type Entry = { id: number | null; offset: number; isDirectory: boolean };
  /** A directory's entries in file order: named ones first, then numbered ones by id. */
  const directory = async (offset: number): Promise<Entry[]> => {
    const head = await reader.bytes(resourceBase + offset, 16);
    const count = head.readUInt16LE(12) + head.readUInt16LE(14);
    if (count > MAX_DIRECTORY_ENTRIES) throw new Error("directory too large");
    const raw = await reader.bytes(resourceBase + offset + 16, count * 8);
    return Array.from({ length: count }, (_, index) => {
      const name = raw.readUInt32LE(index * 8);
      const target = raw.readUInt32LE(index * 8 + 4);
      return {
        id: name & 0x80000000 ? null : name,
        offset: target & 0x7fffffff,
        isDirectory: (target & 0x80000000) !== 0,
      };
    });
  };
  /** The data of a name's first language. */
  const data = async (entry: Entry) => {
    let current = entry;
    // name → language → data; a damaged file could nest further.
    for (let depth = 0; current.isDirectory; depth++) {
      if (depth > 2) throw new Error("too deep");
      const [first] = await directory(current.offset);
      if (!first) throw new Error("empty directory");
      current = first;
    }
    const record = await reader.bytes(resourceBase + current.offset, 16);
    return reader.bytes(fileOffset(record.readUInt32LE(0)), record.readUInt32LE(4));
  };

  const types = await directory(0);
  const groupType = types.find((entry) => entry.id === RT_GROUP_ICON && entry.isDirectory);
  const iconType = types.find((entry) => entry.id === RT_ICON && entry.isDirectory);
  if (!groupType || !iconType) return null;
  const [firstGroup] = await directory(groupType.offset);
  if (!firstGroup) return null;
  const icons = await directory(iconType.offset);

  // GRPICONDIR: a 6-byte header, then 14-byte entries naming RT_ICON ids.
  const group = await data(firstGroup);
  if (group.length < 6 || group.readUInt16LE(2) !== 1) return null;
  const count = Math.min(group.readUInt16LE(4), Math.floor((group.length - 6) / 14));
  const pictures: Picture[] = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 14;
    const id = group.readUInt16LE(at + 12);
    const icon = icons.find((entry) => entry.id === id);
    if (!icon) continue;
    pictures.push({ size: sizeOf(group[at]), bitCount: group.readUInt16LE(at + 6), load: () => data(icon) });
  }
  return pickPng(pictures);
}
