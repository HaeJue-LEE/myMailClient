/**
 * The parts of updating that need no Electron, kept apart to be tested:
 * reading a GitHub release, choosing its exe, and checking a downloaded one.
 */

/** `0.1.12` → [0, 1, 12]; null for anything that is not plain dotted numbers. */
export function parseVersion(value: string): number[] | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
}

/** True when `candidate` is a strictly later version than `current`. */
export function isNewer(candidate: string, current: string) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

/** The fields of GitHub's release JSON (`releases/latest`) the updater reads. */
export type GithubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  body?: unknown;
  assets?: unknown;
};

export type ReleaseExe = {
  version: string;
  url: string;
  size: number;
  /** Lower-case hex SHA-256 of the file, from GitHub's asset digest. */
  sha256: string;
  notes: string;
};

const MAX_EXE_BYTES = 1024 * 1024 * 1024;

/**
 * The exe to update to from `release`, or null when there is none to use:
 * not a later version, a draft or pre-release, no `MailClient-<version>.exe`
 * asset, or no SHA-256 to check it against. `allowHttp` is for test feeds.
 */
export function releaseExe(
  release: GithubRelease,
  currentVersion: string,
  allowHttp = false,
): ReleaseExe | null {
  if (release.draft === true || release.prerelease === true) return null;
  if (typeof release.tag_name !== "string") return null;
  const version = release.tag_name.trim().replace(/^v/, "");
  if (!parseVersion(version) || !isNewer(version, currentVersion)) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as { name?: unknown }).name === `MailClient-${version}.exe`,
  );
  if (!asset) return null;
  const url = asset.browser_download_url;
  const size = asset.size;
  const digest = asset.digest;
  if (typeof url !== "string" || typeof size !== "number" || typeof digest !== "string") return null;
  const parsedUrl = URL.canParse(url) ? new URL(url) : null;
  if (!parsedUrl || !(parsedUrl.protocol === "https:" || (allowHttp && parsedUrl.protocol === "http:"))) {
    return null;
  }
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(digest)?.[1]?.toLowerCase();
  if (!sha256 || !Number.isSafeInteger(size) || size <= 20 || size > MAX_EXE_BYTES) return null;
  return {
    version,
    url,
    size,
    sha256,
    notes: typeof release.body === "string" ? release.body : "",
  };
}

const MAGIC = Buffer.from("MCPKG001");
/** `[id length: u32][zip length: u64]["MCPKG001"]`, as scripts/dist-public.mjs writes it. */
export const TRAILER_BYTES = 20;

/**
 * Whether the end of an exe is a launcher package trailer for `version`:
 * the magic, lengths that fit in `fileSize`, and a package id
 * (`<version>+<hash>`) of that version. `tail` is the file's last bytes,
 * at least `TRAILER_BYTES` plus the id.
 */
export function checkPackageTrailer(tail: Buffer, fileSize: number, version: string): boolean {
  if (tail.length < TRAILER_BYTES) return false;
  const trailer = tail.subarray(tail.length - TRAILER_BYTES);
  if (!trailer.subarray(12, 20).equals(MAGIC)) return false;
  const idLength = trailer.readUInt32LE(0);
  const zipLength = Number(trailer.readBigUInt64LE(4));
  if (idLength === 0 || idLength > 256 || idLength + TRAILER_BYTES > tail.length) return false;
  if (!Number.isSafeInteger(zipLength) || idLength + zipLength + TRAILER_BYTES > fileSize) return false;
  const id = tail
    .subarray(tail.length - TRAILER_BYTES - idLength, tail.length - TRAILER_BYTES)
    .toString("utf8");
  return id.startsWith(`${version}+`);
}
