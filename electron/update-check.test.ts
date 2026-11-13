import { describe, expect, it } from "vitest";
import {
  checkPackageTrailer,
  isNewer,
  parseVersion,
  releaseExe,
  releasePage,
  TRAILER_BYTES,
} from "./update-check";

describe("versions", () => {
  it("compares numerically, not as text", () => {
    expect(parseVersion("v0.1.12")).toEqual([0, 1, 12]);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("v0.2.0", "0.1.12")).toBe(true);
    expect(isNewer("0.1.2", "0.1.2")).toBe(false);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
    expect(isNewer("0.2.0-beta", "0.1.2")).toBe(false);
    expect(isNewer("latest", "0.1.2")).toBe(false);
  });
});

const SHA = "b7e1d61840579e84eeed88167bab1ab80ae0db7ee2ae11dff1ed5ab59f5f20ec";

const release = (overrides: Record<string, unknown> = {}, asset: Record<string, unknown> = {}) => ({
  tag_name: "v0.1.3",
  draft: false,
  prerelease: false,
  body: "notes",
  assets: [
    { name: "other.zip", browser_download_url: "https://example.com/other.zip", size: 10, digest: `sha256:${SHA}` },
    {
      name: "MailClient-0.1.3.exe",
      browser_download_url: "https://github.com/owner/repo/releases/download/v0.1.3/MailClient-0.1.3.exe",
      size: 149_000_000,
      digest: `sha256:${SHA.toUpperCase()}`,
      ...asset,
    },
  ],
  ...overrides,
});

describe("releaseExe", () => {
  it("picks the exe of a later release with its hash", () => {
    expect(releaseExe(release(), "0.1.2")).toEqual({
      version: "0.1.3",
      url: "https://github.com/owner/repo/releases/download/v0.1.3/MailClient-0.1.3.exe",
      size: 149_000_000,
      sha256: SHA,
      notes: "notes",
    });
  });

  it("skips what is not a later, published release", () => {
    expect(releaseExe(release(), "0.1.3")).toBeNull();
    expect(releaseExe(release({ draft: true }), "0.1.2")).toBeNull();
    expect(releaseExe(release({ prerelease: true }), "0.1.2")).toBeNull();
    expect(releaseExe(release({ tag_name: 3 }), "0.1.2")).toBeNull();
    expect(releaseExe({}, "0.1.2")).toBeNull();
  });

  it("will not install without the right exe and a SHA-256", () => {
    expect(releaseExe(release({}, { name: "MailClient-0.1.3-local.exe" }), "0.1.2")).toBeNull();
    expect(releaseExe(release({}, { digest: undefined }), "0.1.2")).toBeNull();
    expect(releaseExe(release({}, { digest: "md5:abc" }), "0.1.2")).toBeNull();
    expect(releaseExe(release({}, { size: "big" }), "0.1.2")).toBeNull();
  });

  it("downloads over https only, except from a test feed", () => {
    const plain = release({}, { browser_download_url: "http://127.0.0.1:8000/MailClient-0.1.3.exe" });
    expect(releaseExe(plain, "0.1.2")).toBeNull();
    expect(releaseExe(plain, "0.1.2", true)?.url).toBe("http://127.0.0.1:8000/MailClient-0.1.3.exe");
    expect(releaseExe(release({}, { browser_download_url: "file:///C:/x.exe" }), "0.1.2", true)).toBeNull();
  });
});

/** The end of a package exe, as scripts/dist-public.mjs writes it. */
function packageTail(id: string, zipLength: number, magic = "MCPKG001") {
  const lengths = Buffer.alloc(12);
  lengths.writeUInt32LE(Buffer.byteLength(id), 0);
  lengths.writeBigUInt64LE(BigInt(zipLength), 4);
  return Buffer.concat([Buffer.from("zip bytes"), Buffer.from(id), lengths, Buffer.from(magic)]);
}

describe("checkPackageTrailer", () => {
  it("accepts a package of the expected version", () => {
    const tail = packageTail("0.1.3+590327569010d930", 1000);
    expect(checkPackageTrailer(tail, 5000, "0.1.3")).toBe(true);
  });

  it("refuses another version, a wrong magic, or lengths past the file", () => {
    expect(checkPackageTrailer(packageTail("0.1.2+abc", 1000), 5000, "0.1.3")).toBe(false);
    expect(checkPackageTrailer(packageTail("0.1.3+abc", 1000, "MCPKG000"), 5000, "0.1.3")).toBe(false);
    expect(checkPackageTrailer(packageTail("0.1.3+abc", 5000), 5000, "0.1.3")).toBe(false);
    expect(checkPackageTrailer(Buffer.alloc(TRAILER_BYTES - 1), 5000, "0.1.3")).toBe(false);
  });
});

describe("releasePage", () => {
  const PAGE = "https://github.com/HaeJue-LEE/myMailClient/releases/tag/v0.1.7";
  const macRelease = (overrides: Record<string, unknown> = {}, names = ["MailClient-0.1.7-mac-arm64.dmg"]) => ({
    tag_name: "v0.1.7",
    html_url: PAGE,
    draft: false,
    prerelease: false,
    body: "notes",
    assets: [
      { name: "MailClient-0.1.7.exe", size: 149_000_000 },
      ...names.map((name) => ({ name, size: 130_000_000 })),
    ],
    ...overrides,
  });

  it("offers the page of a later release with a dmg for this Mac", () => {
    expect(releasePage(macRelease(), "0.1.6", "arm64")).toEqual({
      version: "0.1.7",
      page: PAGE,
      file: "MailClient-0.1.7-mac-arm64.dmg",
      size: 130_000_000,
      notes: "notes",
    });
  });

  it("waits until the dmg for this Mac is attached", () => {
    expect(releasePage(macRelease({}, []), "0.1.6", "arm64")).toBeNull();
    expect(releasePage(macRelease(), "0.1.6", "x64")).toBeNull();
  });

  it("offers nothing older, unpublished, or elsewhere", () => {
    expect(releasePage(macRelease(), "0.1.7", "arm64")).toBeNull();
    expect(releasePage(macRelease({ draft: true }), "0.1.6", "arm64")).toBeNull();
    expect(releasePage(macRelease({ prerelease: true }), "0.1.6", "arm64")).toBeNull();
    expect(releasePage(macRelease({ html_url: "https://example.com/releases/v0.1.7" }), "0.1.6", "arm64")).toBeNull();
    expect(
      releasePage(macRelease({ html_url: "https://github.com/someone-else/myMailClient/releases/tag/v0.1.7" }), "0.1.6", "arm64"),
    ).toBeNull();
  });
});
