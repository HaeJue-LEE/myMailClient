import { contextBridge, ipcRenderer } from "electron";
import { channelOf, MAIL_METHODS, type MailApi } from "@/features/mail/bridge";

// Only these invoke wrappers cross into the page; ipcRenderer itself is never exposed.
const mailApi = Object.fromEntries(
  MAIL_METHODS.map((method) => [
    method,
    (input?: unknown) => ipcRenderer.invoke(channelOf(method), input),
  ]),
) as MailApi;

contextBridge.exposeInMainWorld("mailApi", mailApi);
