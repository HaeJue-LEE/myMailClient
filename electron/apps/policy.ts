import type { ViewBounds } from "@/features/apps/bridge";

/**
 * Rules for the pages of MyApps, kept free of Electron so they can be tested.
 * Those pages are other people's code: they get no preload (so no
 * `mailApi`/`appsApi`), run sandboxed, and keep their cookies in a partition
 * of their own, apart from the mail app's session.
 */

/** Each app's own persistent session: its sign-in survives restarts, shared with nothing else. */
export function partitionFor(appId: string) {
  return `persist:myapp-${appId}`;
}

/**
 * The permissions an app's pages are given; everything else (camera,
 * microphone, location, notifications, …) is refused without asking.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
]);

function webUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Where an app's page may go in place: any http(s) address, so sign-in
 * redirects (e.g. to a single sign-on server) work. The toolbar shows the
 * host, so leaving the app's own server is visible.
 */
export function mayNavigate(url: string) {
  return webUrl(url) !== null || url === "about:blank";
}

/**
 * What a page's `window.open` / `target=_blank` becomes:
 * - `child`: a window of the app (same session), for its own pages, e.g. a
 *   NAS's file preview or upload window, which need its sign-in;
 * - `external`: the default browser, for other web addresses and `mailto:`;
 * - `deny`: anything else (`file:`, the app's own scheme, …).
 */
export function popupTarget(url: string, openerUrl: string, appUrl: string): "child" | "external" | "deny" {
  const target = webUrl(url);
  if (!target) return /^mailto:/i.test(url) ? "external" : url === "about:blank" ? "child" : "deny";
  const origins = [openerUrl, appUrl].map((raw) => webUrl(raw)?.origin);
  return origins.includes(target.origin) ? "child" : "external";
}

/**
 * The page's rectangle (CSS pixels, as measured in the page) in the window's
 * pixels: scaled by the page's zoom, rounded, and never negative.
 */
export function toViewBounds(bounds: ViewBounds, zoomFactor: number): ViewBounds {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const x = Math.max(0, Math.round(bounds.x * scale));
  const y = Math.max(0, Math.round(bounds.y * scale));
  return {
    x,
    y,
    width: Math.max(0, Math.round((bounds.x + bounds.width) * scale) - x),
    height: Math.max(0, Math.round((bounds.y + bounds.height) * scale) - y),
  };
}

/** Least recently shown first: the ones to close when too many are open. */
export function viewsToClose(lastShown: ReadonlyMap<string, number>, keep: number, activeId: string | null) {
  const candidates = [...lastShown].filter(([id]) => id !== activeId).sort((a, b) => a[1] - b[1]);
  const excess = lastShown.size - keep;
  return excess > 0 ? candidates.slice(0, excess).map(([id]) => id) : [];
}

/** `AA:BB:…` for a fingerprint as Electron gives it (`sha256/<base64>`). */
export function formatFingerprint(fingerprint: string) {
  const base64 = fingerprint.replace(/^sha256\//, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return fingerprint;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
}
