import { stat } from "node:fs/promises";
import path from "node:path";

async function isFile(candidate: string) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Maps a URL path to a file in the static export, the way a static host would:
 * `/mail` serves `mail.html`, `/` serves `index.html`. Paths that escape the
 * root resolve to null.
 */
export async function resolveAppFile(root: string, urlPath: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const base = path.resolve(root);
  const target = path.join(base, decoded);
  if (target !== base && !target.startsWith(base + path.sep)) return null;

  for (const candidate of [
    target,
    `${target}.html`,
    path.join(target, "index.html"),
  ]) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * `href` resolved against the app's origin, when it is one of the app's
 * `/mail` pages; null for anything else (another origin or scheme, another
 * page, or not a URL). Protocol and host are compared rather than `origin`,
 * which Node reports as "null" for custom schemes such as `app:`.
 */
export function mailPageUrl(href: string, appOrigin: string): URL | null {
  let url: URL;
  try {
    url = new URL(href, appOrigin);
  } catch {
    return null;
  }
  const base = new URL(appOrigin);
  return url.protocol === base.protocol &&
    url.host === base.host &&
    /^\/mail(\/|$)/.test(url.pathname)
    ? url
    : null;
}
