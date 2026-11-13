import { z } from "zod";

/**
 * MyApps: web apps (a NAS, a home server, an admin page) the user added to
 * open from this app. The list is one for the whole app, shared by every
 * mail account, and works without any mail account.
 */

/**
 * How an app opens: inside the main window (`embed`), in a window of its own
 * (`window`), or in the default browser (`browser`).
 */
export const OPEN_MODES = ["embed", "window", "browser"] as const;
export type OpenMode = (typeof OPEN_MODES)[number];

export const OPEN_MODE_LABELS: Record<OpenMode, string> = {
  embed: "앱 안에서",
  window: "새 창에서",
  browser: "기본 브라우저에서",
};

/** Groups offered when adding an app; any other name may be typed. */
export const DEFAULT_GROUPS = ["NAS", "홈서버", "업무", "기타"] as const;

export const MAX_APP_NAME_LENGTH = 60;
export const MAX_GROUP_LENGTH = 40;
export const MAX_URL_LENGTH = 2000;
/** Bounded so the file (and the sidebar) cannot grow without limit. */
export const MAX_APPS = 200;

/**
 * An app's own picture, shown instead of its letter tile: the image the user
 * picked, shrunk to fit this square (twice the largest tile, for high-DPI
 * displays) and stored in apps.json as a PNG data URL.
 */
export const APP_ICON_SIZE = 128;
/** Well above a 128px PNG, so only a hand-edited file goes over it. */
export const MAX_APP_ICON_LENGTH = 200_000;
const APP_ICON_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/** True for a picture the app made: a PNG data URL of bounded size, nothing else. */
export function isAppIcon(value: string) {
  return value.length <= MAX_APP_ICON_LENGTH && APP_ICON_PATTERN.test(value);
}

export const appIconSchema = z.string().refine(isAppIcon, { message: "icon" });

/**
 * A certificate the user chose to trust for an app's host (`host` with its
 * port), e.g. a NAS's self-signed one. Matched by its SHA-256 fingerprint, so
 * a different certificate on the same host is asked about again.
 */
export type TrustedCert = { host: string; fingerprint: string };

export type MyApp = {
  id: string;
  name: string;
  url: string;
  /** Sidebar section; empty for none. */
  group: string;
  openIn: OpenMode;
  /** Also shown as an icon in the left rail, for one-click access. */
  pinned: boolean;
  /** The picked picture (see `isAppIcon`); null shows the letter tile. */
  icon: string | null;
  /**
   * Opened in the main window, the app fills the area without the toolbar
   * above it (navigation buttons, title and address); a thin strip brings
   * it back.
   */
  hideAddressBar: boolean;
  trustedCerts: TrustedCert[];
};

/**
 * The address of an app: http or https only (no `file:`, `javascript:`, or
 * the app's own scheme), and no user name or password in it. Null otherwise.
 */
export function parseAppUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || !url.hostname) return null;
  return url;
}

/**
 * Adds `http://` to an address typed without a scheme (e.g. `192.0.2.10:5000`),
 * as a browser's address bar would. Anything with a scheme is left as is.
 */
export function withScheme(raw: string) {
  const value = raw.trim();
  return value && !/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? `http://${value}` : value;
}

const appUrlSchema = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .refine((value) => parseAppUrl(value) !== null, { message: "url" })
  .transform((value) => (parseAppUrl(value) as URL).toString());

/** What the add / edit form sends; `id` changes an existing app. */
export const myAppInputSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(MAX_APP_NAME_LENGTH),
  url: appUrlSchema,
  group: z.string().trim().max(MAX_GROUP_LENGTH),
  openIn: z.enum(OPEN_MODES),
  pinned: z.boolean(),
  /** Left out: an edited app keeps its picture. Null: back to the letter tile. */
  icon: appIconSchema.nullable().optional(),
  /** Left out: an edited app keeps the setting. */
  hideAddressBar: z.boolean().optional(),
});
export type MyAppInput = z.input<typeof myAppInputSchema>;

/** Apps by group, in list order; groups in the order they first appear. */
export function groupApps(apps: readonly MyApp[]): { group: string; apps: MyApp[] }[] {
  const groups = new Map<string, MyApp[]>();
  for (const app of apps) {
    const list = groups.get(app.group);
    if (list) list.push(app);
    else groups.set(app.group, [app]);
  }
  return [...groups].map(([group, list]) => ({ group, apps: list }));
}

/** Group names to offer in the form: the ones in use, then the defaults. */
export function groupSuggestions(apps: readonly MyApp[]) {
  return [...new Set([...apps.map((app) => app.group).filter(Boolean), ...DEFAULT_GROUPS])];
}

/** The host (with its port) an app's address shows, e.g. `nas.example.lan:5001`. */
export function appHost(app: Pick<MyApp, "url">) {
  return parseAppUrl(app.url)?.host ?? app.url;
}

/** One letter for the app's tile when it has no picture. */
export function appInitial(name: string) {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

/** A tile colour picked from the name, so each app keeps the same one. */
export function appHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % 360;
}
