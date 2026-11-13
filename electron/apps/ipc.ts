import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, shell } from "electron";
import { z, ZodError } from "zod";
import { MAX_APPS, myAppInputSchema } from "@/features/apps/apps";
import {
  type AppsErrorCode,
  type AppsMethods,
  type AppsResult,
  appsChannelOf,
  VIEW_ACTIONS,
} from "@/features/apps/bridge";
import { InvalidRequestError } from "../errors";
import { clearAppSession, forgetDeclined } from "./contents";
import { chooseAppIcon } from "./icons";
import {
  AppNotFoundError,
  clearTrustedCerts,
  getApp,
  listApps,
  removeApp,
  saveApp,
  setAppOrder,
} from "./store";
import type { AppViews } from "./views";
import { closeSiteWindow, openSiteWindow, updateSiteWindow } from "./windows";

type Input<K extends keyof AppsMethods> = Parameters<AppsMethods[K]>[0];
type Handler<K extends keyof AppsMethods> = {
  input: z.ZodType<Input<K>>;
  run: (input: Input<K>, event: IpcMainInvokeEvent) => Promise<ReturnType<AppsMethods[K]>>;
};

const noInput = z.undefined();
const id = z.string().min(1).max(64);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const size = z.number().finite().min(0).max(100_000);
const bounds = z.object({ x: coordinate, y: coordinate, width: size, height: size });

function toAppsError(error: unknown): AppsErrorCode {
  if (error instanceof AppNotFoundError) return "not_found";
  if (error instanceof ZodError || error instanceof InvalidRequestError) return "invalid_request";
  return "internal_error";
}

export function registerAppsHandlers(options: {
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
  /** The embedded views of the window that sent `event`; null for any but the main window. */
  viewsFor: (event: IpcMainInvokeEvent) => AppViews | null;
  /** Every window's embedded views, to close an app's view wherever it is. */
  allViews: () => AppViews[];
  icon: string;
}) {
  const views = (event: IpcMainInvokeEvent) => {
    const found = options.viewsFor(event);
    if (!found) throw new InvalidRequestError("Apps are shown in the main window only");
    return found;
  };

  const handlers: { [K in keyof AppsMethods]: Handler<K> } = {
    listApps: { input: noInput, run: listApps },
    saveApp: {
      input: myAppInputSchema,
      run: async (input) => {
        const { saved, previous } = await saveApp(input);
        if (previous) {
          for (const item of options.allViews()) item.update(saved);
          if (previous.url !== saved.url) closeSiteWindow(saved.id);
          else updateSiteWindow(saved, options.icon);
        }
        return saved;
      },
    },
    removeApp: {
      input: z.object({ id }),
      run: async ({ id: appId }) => {
        await removeApp(appId);
        for (const item of options.allViews()) item.close(appId);
        closeSiteWindow(appId);
        await clearAppSession(appId);
        return null;
      },
    },
    setAppOrder: {
      input: z.object({ ids: z.array(id).max(MAX_APPS) }),
      run: async ({ ids }) => setAppOrder(ids),
    },
    clearTrustedCerts: {
      input: z.object({ id }),
      run: async ({ id: appId }) => clearTrustedCerts(appId),
    },
    chooseAppIcon: {
      input: noInput,
      run: async (_input, event) => ({
        icon: await chooseAppIcon(BrowserWindow.fromWebContents(event.sender)),
      }),
    },
    openApp: {
      input: z.object({ id, mode: z.enum(["window", "browser"]).optional() }),
      run: async ({ id: appId, mode }) => {
        const item = await getApp(appId);
        const how = mode ?? item.openIn;
        forgetDeclined(appId);
        if (how === "browser") await shell.openExternal(item.url);
        else if (how === "window") openSiteWindow(item, options.icon);
        else throw new InvalidRequestError("Embedded apps are shown with showView");
        return null;
      },
    },
    showView: {
      input: z.object({ id, bounds }),
      run: async ({ id: appId, bounds: rect }, event) => {
        const target = views(event);
        const { ticket } = target;
        const item = await getApp(appId);
        return target.show(item, rect, ticket);
      },
    },
    setViewBounds: {
      input: z.object({ id, bounds }),
      run: async ({ id: appId, bounds: rect }, event) => {
        views(event).setBounds(appId, rect);
        return null;
      },
    },
    hideView: {
      input: noInput,
      run: async (_input, event) => {
        views(event).hide();
        return null;
      },
    },
    viewAction: {
      input: z.object({ id, action: z.enum(VIEW_ACTIONS) }),
      run: async ({ id: appId, action }, event) => {
        views(event).action(appId, action);
        return null;
      },
    },
  };

  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(
      appsChannelOf(method as keyof AppsMethods),
      async (event, raw: unknown): Promise<AppsResult<unknown>> => {
        if (!options.isTrustedSender(event)) return { ok: false, error: "invalid_request" };
        try {
          const input = handler.input.parse(raw);
          return { ok: true, data: await handler.run(input as never, event) };
        } catch (error) {
          const code = toAppsError(error);
          if (code === "internal_error") console.error(error);
          else if (error instanceof ZodError) {
            // Which field failed and why, without the submitted values.
            const issues = error.issues.map(
              (issue) => `${issue.path.join(".") || "(input)"}: ${issue.code}`,
            );
            console.warn(`[apps:${method}] invalid_request`, issues.join(", "));
          }
          return { ok: false, error: code };
        }
      },
    );
  }
}
