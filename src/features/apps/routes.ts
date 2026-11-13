/**
 * MyApps pages. Like mail, the app ships as a static export without runtime
 * dynamic segments, so the app shown is in the query string.
 */
export const APPS_HREF = "/apps";
export const APP_VIEW_PATH = "/apps/view";
export const APPS_SETTINGS_HREF = "/apps/settings";

export function appViewHref(id: string) {
  return `${APP_VIEW_PATH}?${new URLSearchParams({ id })}`;
}

/** The settings page with the form open: for a new app, or to edit `id`. */
export function appEditHref(id?: string) {
  return `${APPS_SETTINGS_HREF}?${new URLSearchParams({ edit: id ?? "new" })}`;
}

/** True for the page that shows an embedded app (`/apps/view`, any query). */
export function isAppViewPath(pathname: string) {
  return pathname.replace(/\/+$/, "") === APP_VIEW_PATH;
}
