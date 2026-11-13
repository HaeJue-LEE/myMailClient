import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isRunnable,
  markFromInternet,
  numberedName,
  openWarning,
  windowsFilename,
  writeNewFile,
} from "./open-attachment";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "open-attachment-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("windowsFilename", () => {
  it.each([
    ["보고서.pdf", "보고서.pdf"],
    ["..\\..\\Windows\\evil.exe", "evil.exe"],
    ["a.txt:Zone.Identifier", "a.txt_Zone.Identifier"],
    ['what?<>|*".doc', "what_____.doc"],
    ["evil.exe. . ", "evil.exe"],
    ["CON.txt", "_CON.txt"],
    ["nul", "_nul"],
    ["console.log", "console.log"],
    ["...", "attachment"],
  ])("%s -> %s", (raw, expected) => {
    expect(windowsFilename(raw)).toBe(expected);
  });
});

describe("numberedName", () => {
  it("numbers before the extension", () => {
    expect(numberedName("a.pdf", 0)).toBe("a.pdf");
    expect(numberedName("a.pdf", 2)).toBe("a (2).pdf");
    expect(numberedName("README", 1)).toBe("README (1)");
    expect(numberedName(".env", 1)).toBe(".env (1)");
  });
});

describe("writeNewFile", () => {
  it("never replaces a file already in the folder", async () => {
    await writeFile(path.join(dir, "invoice.pdf"), "mine");
    const first = await writeNewFile(dir, "invoice.pdf", Buffer.from("one"));
    const second = await writeNewFile(dir, "invoice.pdf", Buffer.from("two"));
    expect(path.basename(first)).toBe("invoice (1).pdf");
    expect(path.basename(second)).toBe("invoice (2).pdf");
    expect(await readFile(path.join(dir, "invoice.pdf"), "utf8")).toBe("mine");
    expect(await readFile(second, "utf8")).toBe("two");
  });

  it("stays in the folder whatever the name says", async () => {
    const file = await writeNewFile(dir, "../../outside.txt", Buffer.from("x"));
    expect(path.dirname(file)).toBe(dir);
  });
});

describe("markFromInternet", () => {
  it.skipIf(process.platform !== "win32")("marks the file as from the internet", async () => {
    const file = path.join(dir, "marked.txt");
    await writeFile(file, "x");
    await markFromInternet(file);
    expect(await readFile(`${file}:Zone.Identifier`, "utf8")).toContain("ZoneId=3");
    // The mark is a stream of the file, not a file beside it.
    expect(existsSync(path.join(dir, "marked.txt_Zone.Identifier"))).toBe(false);
  });
});

describe("openWarning", () => {
  it("asks once, cancelling by default, and says so plainly for programs", () => {
    const pdf = openWarning("견적서.pdf");
    expect(pdf.buttons).toEqual(["열기", "취소"]);
    expect(pdf.defaultId).toBe(1);
    expect(pdf.cancelId).toBe(1);
    expect(pdf.detail).not.toContain("바로 실행");

    expect(isRunnable("setup.EXE")).toBe(true);
    expect(isRunnable("report.xlsm")).toBe(true);
    expect(openWarning("invoice.pdf.exe").detail).toContain("바로 실행");
    // Saved, and run, as `.exe`.
    expect(openWarning("invoice.exe.").detail).toContain("바로 실행");
  });
});
