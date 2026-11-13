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
  programPathSchema,
  type TrustedCert,
  type WebApp,
} from "@/features/apps/apps";
import { InvalidRequestError } from "../errors";

/**
 * The MyApps list (`apps.json`), one for the whole app. Holds no passwords:
 * each web app signs in by itself, and its session is kept in its own
 * Electron partition (see contents.ts).
 */
const trustedCertSchema = z.object({ host: z.string(), fingerprint: z.string() });
const commonFields = {
  id: z.string().min(1),
  name: z.string(),
  group: z.string().default(""),
  pinned: z.boolean().default(false),
  // Missing (a file from before pictures) or damaged: the letter tile.
  icon: appIconSchema.nullable().catch(null),
};
const webAppSchema = z.object({
  ...commonFields,
  kind: z.literal("web"),
  url: z.string(),
  openIn: z.enum(OPEN_MODES).catch("embed"),
  hideAddressBar: z.boolean().catch(false),
  trustedCerts: z.array(trustedCertSchema).default([]),
});
const programAppSchema = z.object({
  ...commonFields,
  kind: z.literal("program"),
  // Checked again on reading: a hand-edited file cannot make it run anything else.
  path: programPathSchema,
});
const appSchema = z.preprocess(
  // Apps saved before programs existed have no kind: they are web apps.
  (value) =>
    value && typeof value === "object" && !("kind" in value) ? { ...value, kind: "web" } : value,
  z.discriminatedUnion("kind", [webAppSchema, programAppSchema]),
);

type AppsFile = { apps: MyApp[] };

export class AppNotFoundError extends Error {}

/** Read once, then changed in memory; the promise is shared by concurrent first calls. */
let loaded: Promise<AppsFile> | null = null;
/** Writes run one after another, so concurrent changes cannot interleave. */
let writing: Promise<unknown> = Promise.resolve();

const filePath = () => path.join(app.getPath("userData"), "apps.json");

async function readAppsFile(): Promise<AppsFile> {
  try {
    const parsed = z
      .object({ apps: z.array(z.unknown()) })
      .safeParse(JSON.parse(await readFile(filePath(), "utf8")));
    if (parsed.success) {
      // An app that cannot be read is left out, rather than losing the whole list.
      const apps = parsed.data.apps.flatMap((item) => {
        const one = appSchema.safeParse(item);
        return one.success ? [one.data] : [];
      });
      return { apps };
    }
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

const copy = (item: MyApp): MyApp =>
  item.kind === "web" ? { ...item, trustedCerts: [...item.trustedCerts] } : { ...item };

export async function listApps(): Promise<MyApp[]> {
  return (await load()).apps.map(copy);
}

export async function getApp(id: string): Promise<MyApp> {
  const found = (await load()).apps.find((item) => item.id === id);
  if (!found) throw new AppNotFoundError(id);
  return copy(found);
}

/**
 * The app as saved from the form's `fields`, over `previous` when editing.
 * What the form leaves out (the picture, the address bar setting) is kept;
 * an app changed to the other kind keeps nothing of its old kind.
 */
function build(id: string, fields: z.output<typeof myAppInputSchema>, previous: MyApp | null): MyApp {
  const common = {
    id,
    name: fields.name,
    group: fields.group,
    pinned: fields.pinned,
    icon: fields.icon === undefined ? (previous?.icon ?? null) : fields.icon,
  };
  if (fields.kind === "program") return { ...common, kind: "program", path: fields.path };
  const before = previous?.kind === "web" ? previous : null;
  return {
    ...common,
    kind: "web",
    url: fields.url,
    openIn: fields.openIn,
    hideAddressBar: fields.hideAddressBar ?? before?.hideAddressBar ?? false,
    trustedCerts: before ? [...before.trustedCerts] : [],
  };
}

/**
 * Adds an app (no `id`) at the end of the list, or changes one. Returns it
 * and, for a change, the app as it was (to tell what changed).
 */
export async function saveApp(raw: MyAppInput): Promise<{ saved: MyApp; previous: MyApp | null }> {
  const fields = myAppInputSchema.parse(raw);
  const { id } = fields;
  const file = await load();
  if (id) {
    const index = file.apps.findIndex((item) => item.id === id);
    if (index < 0) throw new AppNotFoundError(id);
    const previous = file.apps[index];
    const saved = build(id, fields, previous);
    file.apps[index] = saved;
    await persist(file);
    return { saved: copy(saved), previous: copy(previous) };
  }
  if (file.apps.length >= MAX_APPS) throw new InvalidRequestError("Too many apps");
  const saved = build(randomUUID(), fields, null);
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
export function isCertTrusted(item: Pick<WebApp, "trustedCerts">, cert: TrustedCert) {
  return item.trustedCerts.some(
    (trusted) => trusted.host === cert.host && trusted.fingerprint === cert.fingerprint,
  );
}

/** The web app with this id; programs have no certificates. */
function findWebApp(file: AppsFile, id: string): WebApp {
  const found = file.apps.find((item) => item.id === id);
  if (!found) throw new AppNotFoundError(id);
  if (found.kind !== "web") throw new InvalidRequestError("Not a web app");
  return found;
}

/** Trusts `cert` for the app; a host keeps one certificate, the latest trusted. */
export async function trustCert(id: string, cert: TrustedCert): Promise<WebApp> {
  const file = await load();
  const found = findWebApp(file, id);
  found.trustedCerts = [...found.trustedCerts.filter((item) => item.host !== cert.host), cert];
  await persist(file);
  return { ...found, trustedCerts: [...found.trustedCerts] };
}

export async function clearTrustedCerts(id: string): Promise<WebApp> {
  const file = await load();
  const found = findWebApp(file, id);
  found.trustedCerts = [];
  await persist(file);
  return { ...found, trustedCerts: [] };
}
