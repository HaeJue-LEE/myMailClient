import { type BrowserWindow, type WebContents, WebContentsView } from "electron";
import type { MyApp } from "@/features/apps/apps";
import {
  type AppViewState,
  VIEW_STATE_CHANNEL,
  type ViewAction,
  type ViewBounds,
} from "@/features/apps/bridge";
import { isAppViewPath } from "@/features/apps/routes";
import { appWebPreferences, forgetDeclined, wireAppContents } from "./contents";
import { toViewBounds, viewsToClose } from "./policy";

/**
 * Apps shown inside the main window ("앱 안에서"): one WebContentsView per
 * app, laid over the content area of `/apps/view` at the bounds the page
 * reports. A view stays loaded (and signed in) when another page is shown,
 * up to MAX_LIVE_VIEWS; the least recently shown beyond that are closed.
 *
 * A native view is drawn above the page, so nothing of the page may overlap
 * the area it covers (no pop-over or dialog there): the view is hidden while
 * the page shows something in its place (e.g. a load error).
 */
const MAX_LIVE_VIEWS = 4;

/** Chromium's "aborted" (e.g. a navigation replaced by another): not a failure to show. */
const ERR_ABORTED = -3;

type Live = {
  app: MyApp;
  view: WebContentsView;
  error?: AppViewState["error"];
};

export class AppViews {
  private readonly live = new Map<string, Live>();
  private readonly lastShown = new Map<string, number>();
  private activeId: string | null = null;
  /**
   * Counts hides. A `show` asked for before the latest hide (e.g. the page
   * was left while the app was still being looked up) is not carried out.
   */
  private hides = 0;

  constructor(
    private readonly window: BrowserWindow,
    private readonly icon: string,
  ) {
    window.on("closed", () => {
      for (const { view } of this.live.values()) view.webContents.close();
      this.live.clear();
    });
    // Safety net: whatever the page does, a view never stays over another page.
    const onNavigate = (url: string) => {
      let pathname = "";
      try {
        pathname = new URL(url).pathname;
      } catch {
        // Not a URL: hide.
      }
      if (!isAppViewPath(pathname)) this.hide();
    };
    window.webContents.on("did-navigate", (_event, url) => onNavigate(url));
    window.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) onNavigate(url);
    });
    window.webContents.on("render-process-gone", () => this.hide());
  }

  /** Pass to `show`: it is carried out only if no hide came in between. */
  get ticket() {
    return this.hides;
  }

  /** Shows the app's view at `bounds`, creating and loading it the first time. */
  show(item: MyApp, bounds: ViewBounds, ticket: number): AppViewState {
    if (ticket !== this.hides) {
      const current = this.live.get(item.id);
      return current
        ? this.stateOf(current)
        : { id: item.id, url: item.url, title: "", loading: false, canGoBack: false, canGoForward: false };
    }
    const entry = this.live.get(item.id) ?? this.create(item);
    if (this.activeId && this.activeId !== item.id) {
      this.live.get(this.activeId)?.view.setVisible(false);
    }
    this.activeId = item.id;
    this.lastShown.set(item.id, Date.now());
    this.place(entry, bounds);
    entry.view.setVisible(true);
    for (const id of viewsToClose(this.lastShown, MAX_LIVE_VIEWS, this.activeId)) this.close(id);
    return this.stateOf(entry);
  }

  setBounds(id: string, bounds: ViewBounds) {
    const entry = this.live.get(id);
    if (entry && id === this.activeId) this.place(entry, bounds);
  }

  hide() {
    this.hides += 1;
    if (!this.activeId) return;
    this.live.get(this.activeId)?.view.setVisible(false);
    this.activeId = null;
  }

  action(id: string, action: ViewAction) {
    const entry = this.live.get(id);
    if (!entry) return;
    const contents = entry.view.webContents;
    if (action === "reload" || action === "home") forgetDeclined(id);
    switch (action) {
      case "back":
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        break;
      case "forward":
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        break;
      case "stop":
        contents.stop();
        break;
      case "reload":
        // After a failure the page in the view is Chromium's error page: load the address again.
        if (entry.error) this.load(entry, contents.getURL() || entry.app.url);
        else contents.reload();
        break;
      case "home":
        this.load(entry, entry.app.url);
        break;
    }
  }

  /** The app as just saved: its view keeps going unless its address changed. */
  update(item: MyApp) {
    const entry = this.live.get(item.id);
    if (!entry) return;
    if (entry.app.url !== item.url) this.close(item.id);
    else entry.app = item;
  }

  /** Closes the app's view (e.g. its address changed or it was removed). */
  close(id: string) {
    const entry = this.live.get(id);
    if (!entry) return;
    if (this.activeId === id) this.activeId = null;
    this.live.delete(id);
    this.lastShown.delete(id);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
  }

  private create(item: MyApp): Live {
    const view = new WebContentsView({ webPreferences: appWebPreferences(item.id) });
    const entry: Live = { app: item, view };
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    this.live.set(item.id, entry);

    const contents = view.webContents;
    wireAppContents(contents, item, this.icon);
    const push = () => this.push(entry);
    contents.on("did-start-loading", () => {
      entry.error = undefined;
      push();
    });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      entry.error = { code, description };
      push();
    });
    contents.on("did-stop-loading", push);
    contents.on("did-navigate", push);
    contents.on("did-navigate-in-page", push);
    contents.on("page-title-updated", push);
    // The menu bar is hidden and its reload would reload the mail app's page: F5 reloads the app.
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F5") {
        event.preventDefault();
        this.action(item.id, "reload");
      } else if (input.alt && !input.control && !input.shift && !input.meta) {
        // As in a browser; the only way back and forward while the toolbar is hidden.
        if (input.key === "ArrowLeft" || input.key === "ArrowRight") {
          event.preventDefault();
          this.action(item.id, input.key === "ArrowLeft" ? "back" : "forward");
        }
      }
    });
    contents.on("render-process-gone", () => {
      entry.error = { code: 0, description: "render-process-gone" };
      push();
    });
    this.load(entry, item.url);
    return entry;
  }

  private load(entry: Live, url: string) {
    // A failure is reported through did-fail-load; the promise only rejects with it.
    entry.view.webContents.loadURL(url).catch(() => undefined);
  }

  private place(entry: Live, bounds: ViewBounds) {
    entry.view.setBounds(toViewBounds(bounds, this.window.webContents.getZoomFactor()));
  }

  private stateOf({ app: item, view, error }: Live): AppViewState {
    const contents: WebContents = view.webContents;
    return {
      id: item.id,
      url: contents.getURL() || item.url,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...(error ? { error } : {}),
    };
  }

  private push(entry: Live) {
    if (this.window.isDestroyed() || entry.view.webContents.isDestroyed()) return;
    this.window.webContents.send(VIEW_STATE_CHANNEL, this.stateOf(entry));
  }
}
