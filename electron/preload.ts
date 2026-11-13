import { contextBridge, ipcRenderer } from "electron";
import {
  APPS_METHODS,
  type AppsApi,
  type AppViewState,
  appsChannelOf,
  VIEW_STATE_CHANNEL,
} from "@/features/apps/bridge";
import { channelOf, MAIL_METHODS, type MailApi } from "@/features/mail/bridge";

// Only these invoke wrappers cross into the page; ipcRenderer itself is never exposed.
const mailApi = Object.fromEntries(
  MAIL_METHODS.map((method) => [
    method,
    (input?: unknown) => ipcRenderer.invoke(channelOf(method), input),
  ]),
) as MailApi;

contextBridge.exposeInMainWorld("mailApi", mailApi);

const appsApi = {
  ...Object.fromEntries(
    APPS_METHODS.map((method) => [
      method,
      (input?: unknown) => ipcRenderer.invoke(appsChannelOf(method), input),
    ]),
  ),
  // The page gets the state only, never the IPC event (which carries the sender).
  onViewState: (listener: (state: AppViewState) => void) => {
    const handler = (_event: unknown, state: AppViewState) => listener(state);
    ipcRenderer.on(VIEW_STATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(VIEW_STATE_CHANNEL, handler);
    };
  },
} as AppsApi;

contextBridge.exposeInMainWorld("appsApi", appsApi);
