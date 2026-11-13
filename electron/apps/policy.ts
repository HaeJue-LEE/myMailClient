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
 *   NAS's file preview or upload window, which need its sign-in, or a single
 *   sign-on popup (Google, Microsoft, …) that returns the token to the opener;
 * - `external`: the default browser, for other web addresses and `mailto:`;
 * - `deny`: anything else (`file:`, the app's own scheme, …).
 */
export function popupTarget(url: string, openerUrl: string, appUrl: string): "child" | "external" | "deny" {
  const target = webUrl(url);
  if (!target) return /^mailto:/i.test(url) ? "external" : url === "about:blank" ? "child" : "deny";
  if (isSignInUrl(target)) return "child";
  const origins = [openerUrl, appUrl].map((raw) => webUrl(raw)?.origin);
  return origins.includes(target.origin) || isSameSiteHost(target.hostname, [openerUrl, appUrl])
    ? "child"
    : "external";
}

/** Hosts that serve nothing but sign-in, so any of their pages is a sign-in pop-up. */
const SIGN_IN_HOSTS: ReadonlySet<string> = new Set([
  "accounts.google.com",
  "accounts.youtube.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
]);
/** Sign-in services where each customer has a subdomain of its own. */
const SIGN_IN_DOMAINS = [".okta.com", ".auth0.com", ".onelogin.com"];
/** Sign-in pages of sites that serve other pages too: only these paths, so other links still go to the browser. */
const SIGN_IN_PATHS: ReadonlyMap<string, readonly string[]> = new Map([
  ["github.com", ["/login"]],
  ["slack.com", ["/oauth", "/openid"]],
]);

function isSignInUrl(url: URL) {
  const host = url.hostname.toLowerCase();
  if (SIGN_IN_HOSTS.has(host) || SIGN_IN_DOMAINS.some((domain) => host.endsWith(domain))) return true;
  const paths = SIGN_IN_PATHS.get(host) ?? [];
  return paths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`));
}

/**
 * True when `hostname` is another host of the same site as one of `urls`,
 * e.g. `auth.example.com` for `team.example.com`. The same host on another
 * port is not: that is another origin.
 */
function isSameSiteHost(hostname: string, urls: string[]) {
  const host = hostname.toLowerCase();
  const site = siteOf(host);
  if (!site) return false;
  return urls.some((raw) => {
    const parsed = webUrl(raw);
    return parsed !== null && parsed.hostname.toLowerCase() !== host && siteOf(parsed.hostname) === site;
  });
}

/**
 * Domains anyone can get a subdomain of (e.g. a NAS's DDNS address): each
 * subdomain is a site of its own, not one site with the others.
 */
const SHARED_DOMAINS: ReadonlySet<string> = new Set([
  "synology.me",
  "myqnapcloud.com",
  "quickconnect.to",
  "duckdns.org",
  "github.io",
  "netlify.app",
  "vercel.app",
  "pages.dev",
  "herokuapp.com",
]);

/** The registrable domain of `hostname` (`example.com`, `example.co.kr`), or null for IP addresses and single-label names. */
function siteOf(hostname: string): string | null {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2 || /^\d+$/.test(parts.at(-1)!) || hostname.includes(":")) return null;
  const lastTwo = parts.slice(-2).join(".");
  const suffixLabels =
    SHARED_DOMAINS.has(lastTwo) || /^(?:co|com|net|org|ac|gov|edu|or|ne|go|pe|re)\.[a-z]{2}$/.test(lastTwo) ? 2 : 1;
  return parts.length > suffixLabels ? parts.slice(-(suffixLabels + 1)).join(".") : null;
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

/**
 * The browser an app's pages say they run in: Chrome, as it really is
 * underneath. Electron adds its own name and the app's (`Electron/45.2.3`,
 * `MailClient/0.1.5`), and some services turn away a browser they do not
 * know. Those names are dropped, and the Chrome version is cut to its major
 * number as Chrome itself sends it.
 */
export function browserUserAgent(userAgent: string) {
  return userAgent
    .replace(/ (?!(?:AppleWebKit|Chrome|Safari)\/)[^\s()/]+\/\S+/g, "")
    .replace(/Chrome\/(\d+)[\d.]*/, "Chrome/$1.0.0.0");
}
