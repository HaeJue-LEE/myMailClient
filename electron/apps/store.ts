import { app } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  appIconSchema,
  MAX_APPS,
  type MyApp,
  type MyAppInput,
  myAppInputSchema,
  OPEN_MODES,
  type TrustedCert,
} from "@/features/apps/apps";
import { InvalidRequestError } from "../errors";

/**
 * The MyApps list (`apps.json`), one for the whole app. Holds no passwords:
 * each web app signs in by itself, and its session is kept in its own
 * Electron partition (see sessions.ts).
 */
const trustedCertSchema = z.object({ host: z.string(), fingerprint: z.string() });
const appSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.string(),
  group: z.string().default(""),
  openIn: z.enum(OPEN_MODES).catch("embed"),
  pinned: z.boolean().default(false),
  // Missing (a file from before pictures) or damaged: the letter tile.
  icon: appIconSchema.nullable().catch(null),
  hideAddressBar: z.boolean().catch(false),
  trustedCerts: z.array(trustedCertSchema).default([]),
});
const fileSchema = z.object({ apps: z.array(appSchema) });
type AppsFile = z.infer<typeof fileSchema>;

export class AppNotFoundError extends Error {}

/** Read once, then changed in memory; the promise is shared by concurrent first calls. */
let loaded: Promise<AppsFile> | null = null;
/** Writes run one after another, so concurrent changes cannot interleave. */
let writing: Promise<unknown> = Promise.resolve();

const filePath = () => path.join(app.getPath("userData"), "apps.json");

async function readAppsFile(): Promise<AppsFile> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(await readFile(filePath(), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or not JSON.
  }
  // Damaged or missing: start empty; the next change rewrites it.
  return { apps: [] };
}

function load() {
  loaded ??= readAppsFile();
  return loaded;
}

async function persist(file: AppsFile) {
  const json = JSON.stringify(file, null, 2);
  // Write to a temporary file and rename, so a crash cannot leave half a file.
  writing = writing
    .catch(() => undefined)
    .then(async () => {
      const temporary = `${filePath()}.tmp`;
      await writeFile(temporary, json, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, filePath());
    });
  await writing;
}

const copy = (item: MyApp): MyApp => ({ ...item, trustedCerts: [...item.trustedCerts] });

export async function listApps(): Promise<MyApp[]> {
  return (await load()).apps.map(copy);
}

export async function getApp(id: string): Promise<MyApp> {
  const found = (await load()).apps.find((item) => item.id === id);
  if (!found) throw new AppNotFoundError(id);
  return copy(found);
}

/**
 * Adds an app (no `id`) at the end of the list, or changes one. Returns it
 * and, for a change, the app as it was (to tell what changed).
 */
export async function saveApp(raw: MyAppInput): Promise<{ saved: MyApp; previous: MyApp | null }> {
  const input = myAppInputSchema.parse(raw);
  const file = await load();
  const { id, ...fields } = input;
  if (id) {
    const index = file.apps.findIndex((item) => item.id === id);
    if (index < 0) throw new AppNotFoundError(id);
    const previous = file.apps[index];
    const saved = {
      ...previous,
      ...fields,
      icon: fields.icon === undefined ? previous.icon : fields.icon,
      hideAddressBar: fields.hideAddressBar ?? previous.hideAddressBar,
    };
    file.apps[index] = saved;
    await persist(file);
    return { saved: copy(saved), previous: copy(previous) };
  }
  if (file.apps.length >= MAX_APPS) throw new InvalidRequestError("Too many apps");
  const saved: MyApp = {
    id: randomUUID(),
    ...fields,
    icon: fields.icon ?? null,
    hideAddressBar: fields.hideAddressBar ?? false,
    trustedCerts: [],
  };
  file.apps.push(saved);
  await persist(file);
  return { saved: copy(saved), previous: null };
}

export async function removeApp(id: string) {
  const file = await load();
  const index = file.apps.findIndex((item) => item.id === id);
  if (index < 0) throw new AppNotFoundError(id);
  file.apps.splice(index, 1);
  await persist(file);
}

/** Every app's id, in the new order; any other list is refused. */
export async function setAppOrder(ids: string[]): Promise<MyApp[]> {
  const file = await load();
  const byId = new Map(file.apps.map((item) => [item.id, item]));
  if (ids.length !== byId.size || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    throw new InvalidRequestError("The order must list every app once");
  }
  file.apps = ids.map((id) => byId.get(id)!);
  await persist(file);
  return file.apps.map(copy);
}

/** True when `cert` was trusted for the app (same host and fingerprint). */
export function isCertTrusted(item: Pick<MyApp, "trustedCerts">, cert: TrustedCert) {
  return item.trustedCerts.some(
    (trusted) => trusted.host === cert.host && trusted.fingerprint === cert.fingerprint,
  );
}

/** Trusts `cert` for the app; a host keeps one certificate, the latest trusted. */
export async function trustCert(id: string, cert: TrustedCert): Promise<MyApp> {
  const file = await load();
  const found = file.apps.find((item) => item.id === id);
  if (!found) throw new AppNotFoundError(id);
  found.trustedCerts = [...found.trustedCerts.filter((item) => item.host !== cert.host), cert];
  await persist(file);
  return copy(found);
}

export async function clearTrustedCerts(id: string): Promise<MyApp> {
  const file = await load();
  const found = file.apps.find((item) => item.id === id);
  if (!found) throw new AppNotFoundError(id);
  found.trustedCerts = [];
  await persist(file);
  return copy(found);
}
