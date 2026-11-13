import type { MyApp, MyAppInput } from "@/features/apps/apps";

/**
 * Contract between the renderer and the Electron main process for MyApps.
 * Kept apart from the mail bridge (`window.mailApi`): its own object
 * (`window.appsApi`) and channels (`apps:…`), and it needs no mail account.
 */

export type AppsErrorCode = "invalid_request" | "not_found" | "internal_error";

/** A program just picked in the file dialog, for the form to show and save. */
export type PickedProgram = { path: string; name: string; icon: string | null };

export type AppsResult<T> = { ok: true; data: T } | { ok: false; error: AppsErrorCode };

/** Where the embedded view goes in the window, in CSS pixels of the page. */
export type ViewBounds = { x: number; y: number; width: number; height: number };

export const VIEW_ACTIONS = ["back", "forward", "reload", "stop", "home"] as const;
export type ViewAction = (typeof VIEW_ACTIONS)[number];

/** What the embedded view of an app shows, pushed whenever it changes. */
export type AppViewState = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page failed to load (e.g. the NAS is off); the view is hidden meanwhile. */
  error?: { code: number; description: string };
};

export type AppsMethods = {
  listApps: () => MyApp[];
  /** Adds an app, or changes one (`id`). */
  saveApp: (input: MyAppInput) => MyApp;
  /** Removes an app with everything it kept on this computer (its sign-in, cache). */
  removeApp: (input: { id: string }) => null;
  /** Sets the order apps are listed in: every app id, in that order. */
  setAppOrder: (input: { ids: string[] }) => MyApp[];
  /** Forgets the certificates trusted for an app; they are asked about again. */
  clearTrustedCerts: (input: { id: string }) => MyApp;
  /**
   * Asks for an image file and returns it as an app icon (see `isAppIcon`),
   * for the edit form to show and save; null when the dialog is cancelled.
   */
  chooseAppIcon: () => { icon: string | null };
  /**
   * Asks for a program (exe, shortcut, batch file) with the file dialog;
   * null when cancelled. Only a path picked this way can be saved.
   */
  chooseProgram: () => { program: PickedProgram | null };
  /**
   * Opens a web app in a window of its own or in the default browser (as
   * set for it, or as `mode` says), or runs a program. Embedded apps are
   * shown with `showView`.
   */
  openApp: (input: { id: string; mode?: "window" | "browser" }) => null;
  /** Shows the app's embedded view at `bounds`, loading it the first time. */
  showView: (input: { id: string; bounds: ViewBounds }) => AppViewState;
  setViewBounds: (input: { id: string; bounds: ViewBounds }) => null;
  /** Hides whichever view is shown; it stays loaded for when it is shown again. */
  hideView: () => null;
  viewAction: (input: { id: string; action: ViewAction }) => null;
};

export type AppsApi = {
  [K in keyof AppsMethods]: (
    ...args: Parameters<AppsMethods[K]>
  ) => Promise<AppsResult<ReturnType<AppsMethods[K]>>>;
} & {
  /** Calls `listener` with each change of an embedded view; returns the unsubscribe. */
  onViewState: (listener: (state: AppViewState) => void) => () => void;
};

export const APPS_METHODS = [
  "listApps",
  "saveApp",
  "removeApp",
  "setAppOrder",
  "clearTrustedCerts",
  "chooseAppIcon",
  "chooseProgram",
  "openApp",
  "showView",
  "setViewBounds",
  "hideView",
  "viewAction",
] as const satisfies readonly (keyof AppsMethods)[];

export const appsChannelOf = (method: keyof AppsMethods) => `apps:${method}`;

/** Main → renderer: an embedded view's state changed. */
export const VIEW_STATE_CHANNEL = "apps-event:viewState";

declare global {
  interface Window {
    /** Present only inside the Electron main window, injected by the preload script. */
    appsApi?: AppsApi;
  }
}
