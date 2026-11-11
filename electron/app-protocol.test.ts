import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mailPageUrl, resolveAppFile } from "./app-protocol";

let root: string;
let secret: string;

beforeAll(async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "app-protocol-"));
  root = path.join(parent, "out");
  secret = path.join(parent, "secret.txt");
  await mkdir(path.join(root, "mail"), { recursive: true });
  await mkdir(path.join(root, "_next", "static"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "index.html"), ""),
    writeFile(path.join(root, "mail.html"), ""),
    writeFile(path.join(root, "mail", "compose.html"), ""),
    writeFile(path.join(root, "_next", "static", "app.js"), ""),
    writeFile(secret, ""),
  ]);
});

afterAll(() => rm(path.dirname(root), { recursive: true, force: true }));

describe("resolveAppFile", () => {
  it.each([
    ["/", "index.html"],
    ["/mail", "mail.html"],
    ["/mail/compose", path.join("mail", "compose.html")],
    ["/_next/static/app.js", path.join("_next", "static", "app.js")],
  ])("%s -> %s", async (urlPath, expected) => {
    expect(await resolveAppFile(root, urlPath)).toBe(path.join(root, expected));
  });

  it("returns null for missing files", async () => {
    expect(await resolveAppFile(root, "/nope")).toBeNull();
  });

  it.each(["/../secret.txt", "/%2e%2e/secret.txt", "/mail/..%5c..%5csecret.txt"])(
    "refuses to leave the root: %s",
    async (urlPath) => {
      expect(await resolveAppFile(root, urlPath)).toBeNull();
    },
  );

  it("rejects malformed escapes", async () => {
    expect(await resolveAppFile(root, "/%E0%A4%A")).toBeNull();
  });
});

describe("mailPageUrl", () => {
  for (const origin of ["app://bundle", "http://localhost:3000"]) {
    it(`accepts only the app's /mail pages (${origin})`, () => {
      expect(mailPageUrl("/mail/compose?mode=reply&thread=t&message=m", origin)?.toString()).toBe(
        `${origin}/mail/compose?mode=reply&thread=t&message=m`,
      );
      expect(mailPageUrl("/mail", origin)).not.toBeNull();
      expect(mailPageUrl("/mail?label=INBOX", origin)).not.toBeNull();
      for (const href of [
        "/login",
        "/popup?thread=t",
        "/mailbox",
        "https://evil.example/mail",
        "app://other/mail",
        "other://bundle/mail",
        "//evil.example/mail",
        "javascript:alert(1)",
        "file:///C:/mail",
      ]) {
        expect(mailPageUrl(href, origin), href).toBeNull();
      }
    });
  }
});
