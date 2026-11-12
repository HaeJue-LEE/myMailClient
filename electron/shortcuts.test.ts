import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {}, shell: {} }));
const { launcherPath } = await import("./shortcuts");

// <base>\MailClient-0.1.0.exe beside <base>\Mail Client\Mail Client.exe
const base = mkdtempSync(path.join(tmpdir(), "launcher-"));
const launcher = path.join(base, "MailClient-0.1.0.exe");
const appExe = path.join(base, "Mail Client", "Mail Client.exe");
mkdirSync(path.dirname(appExe));
writeFileSync(launcher, "");
writeFileSync(appExe, "");
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("launcherPath", () => {
  it("accepts the launcher beside the app's folder", () => {
    expect(launcherPath({ MAIL_CLIENT_LAUNCHER: launcher }, appExe)).toBe(launcher);
    // Windows paths compare without regard to case.
    expect(launcherPath({ MAIL_CLIENT_LAUNCHER: launcher.toUpperCase() }, appExe)).toBe(
      launcher.toUpperCase(),
    );
  });

  it("refuses anything else as a shortcut target", () => {
    const elsewhere = path.join(tmpdir(), "MailClient-0.1.0.exe");
    for (const value of [
      undefined,
      "",
      "MailClient-0.1.0.exe",
      path.join(base, "missing.exe"),
      path.join(base, "Mail Client"),
      path.join(base, "script.cmd"),
      elsewhere,
    ]) {
      expect(launcherPath({ MAIL_CLIENT_LAUNCHER: value }, appExe), String(value)).toBeNull();
    }
    // Not started from an unpacked launcher folder (e.g. npm run dev).
    expect(launcherPath({ MAIL_CLIENT_LAUNCHER: launcher }, path.join(tmpdir(), "electron.exe"))).toBeNull();
  });
});
