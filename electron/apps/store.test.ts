import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebApp } from "@/features/apps/apps";

let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

/** A fresh module, as after an app restart (its in-memory cache is gone). */
const freshModule = async () => {
  vi.resetModules();
  return import("./store");
};

const nas = {
  kind: "web" as const,
  name: "NAS",
  url: "https://nas.example.lan:5001",
  group: "NAS",
  openIn: "embed" as const,
  pinned: true,
};
const tool = {
  kind: "program" as const,
  name: "Example",
  path: "C:\\Tools\\Example\\example.exe",
  group: "",
  pinned: false,
};
const ICON = "data:image/png;base64,iVBORw0KGgo=";
const cert = { host: "nas.example.lan:5001", fingerprint: "sha256/AAAA" };

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "apps-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("apps store", () => {
  it("adds, edits, and survives a restart", async () => {
    const store = await freshModule();
    const { saved } = await store.saveApp(nas);
    expect(saved).toMatchObject({ ...nas, url: "https://nas.example.lan:5001/", trustedCerts: [] });

    const edited = await store.saveApp({ ...nas, id: saved.id, name: "우리집 NAS", openIn: "window" });
    expect(edited.previous?.name).toBe("NAS");
    expect(edited.saved).toMatchObject({ id: saved.id, name: "우리집 NAS", openIn: "window" });

    const restarted = await freshModule();
    expect(await restarted.listApps()).toEqual([edited.saved]);
    const file = JSON.parse(await readFile(path.join(userData, "apps.json"), "utf8"));
    expect(file.apps).toHaveLength(1);
    // No password, ever.
    expect(JSON.stringify(file)).not.toMatch(/password/i);
  });

  it("refuses an invalid app and an unknown id", async () => {
    const store = await freshModule();
    await expect(store.saveApp({ ...nas, url: "file:///C:/" })).rejects.toThrow();
    await expect(store.saveApp({ ...nas, id: "missing" })).rejects.toBeInstanceOf(store.AppNotFoundError);
    await expect(store.removeApp("missing")).rejects.toBeInstanceOf(store.AppNotFoundError);
  });

  it("removes an app", async () => {
    const store = await freshModule();
    const a = (await store.saveApp(nas)).saved;
    const b = (await store.saveApp({ ...nas, name: "Photos" })).saved;
    await store.removeApp(a.id);
    expect((await store.listApps()).map((item) => item.id)).toEqual([b.id]);
  });

  it("reorders only with every app listed once", async () => {
    const store = await freshModule();
    const a = (await store.saveApp(nas)).saved;
    const b = (await store.saveApp({ ...nas, name: "Photos" })).saved;
    expect((await store.setAppOrder([b.id, a.id])).map((item) => item.id)).toEqual([b.id, a.id]);
    await expect(store.setAppOrder([b.id])).rejects.toThrow();
    await expect(store.setAppOrder([b.id, b.id])).rejects.toThrow();
    await expect(store.setAppOrder([b.id, "other"])).rejects.toThrow();
  });

  it("trusts a certificate per app and host, one per host", async () => {
    const store = await freshModule();
    const a = (await store.saveApp(nas)).saved;
    const b = (await store.saveApp({ ...nas, name: "Other" })).saved;
    const trusted = await store.trustCert(a.id, cert);
    expect(store.isCertTrusted(trusted, cert)).toBe(true);
    // Not for another app, and not for another certificate on the same host.
    expect(store.isCertTrusted((await store.getApp(b.id)) as WebApp, cert)).toBe(false);
    expect(store.isCertTrusted(trusted, { ...cert, fingerprint: "sha256/BBBB" })).toBe(false);

    const replaced = await store.trustCert(a.id, { ...cert, fingerprint: "sha256/BBBB" });
    expect(replaced.trustedCerts).toEqual([{ ...cert, fingerprint: "sha256/BBBB" }]);
    expect((await store.clearTrustedCerts(a.id)).trustedCerts).toEqual([]);
  });

  it("starts empty when the file is damaged, and fills in missing fields", async () => {
    await writeFile(path.join(userData, "apps.json"), "{not json");
    expect(await (await freshModule()).listApps()).toEqual([]);

    await writeFile(
      path.join(userData, "apps.json"),
      JSON.stringify({ apps: [{ id: "x", name: "NAS", url: "https://nas.example.lan/", openIn: "tab" }] }),
    );
    expect(await (await freshModule()).listApps()).toEqual([
      {
        // Saved before programs existed: a web app.
        kind: "web",
        id: "x",
        name: "NAS",
        url: "https://nas.example.lan/",
        group: "",
        openIn: "embed",
        pinned: false,
        icon: null,
        hideAddressBar: false,
        trustedCerts: [],
      },
    ]);
  });

  it("keeps an app's icon unless the edit changes or clears it", async () => {
    const store = await freshModule();
    const { saved } = await store.saveApp({ ...nas, icon: ICON });
    expect(saved.icon).toBe(ICON);
    // Left out: kept.
    expect((await store.saveApp({ ...nas, id: saved.id, name: "우리집 NAS" })).saved.icon).toBe(ICON);
    expect((await store.saveApp({ ...nas, id: saved.id, icon: null })).saved.icon).toBeNull();
    expect((await store.saveApp(nas)).saved.icon).toBeNull();
    await expect(store.saveApp({ ...nas, icon: "https://evil.test/x.png" })).rejects.toThrow();
  });

  it("keeps the address bar setting unless the edit sets it", async () => {
    const store = await freshModule();
    const web = (item: unknown) => item as WebApp;
    const { saved } = await store.saveApp(nas);
    expect(web(saved).hideAddressBar).toBe(false);
    const hidden = (await store.saveApp({ ...nas, id: saved.id, hideAddressBar: true })).saved;
    expect(web(hidden).hideAddressBar).toBe(true);
    expect(web((await store.saveApp({ ...nas, id: saved.id, name: "우리집 NAS" })).saved).hideAddressBar).toBe(true);
    expect(web(await (await freshModule()).getApp(saved.id)).hideAddressBar).toBe(true);
  });

  it("drops a damaged icon in the file, keeping the app", async () => {
    await writeFile(
      path.join(userData, "apps.json"),
      JSON.stringify({ apps: [{ id: "x", name: "NAS", url: "https://nas.example.lan/", icon: "javascript:1" }] }),
    );
    expect(await (await freshModule()).listApps()).toMatchObject([{ id: "x", icon: null }]);
  });

  it("saves a program, and drops what the other kind kept when an app changes kind", async () => {
    const store = await freshModule();
    const { saved: web } = await store.saveApp({ ...nas, hideAddressBar: true });
    await store.trustCert(web.id, cert);

    const { saved: program } = await store.saveApp({ ...tool, id: web.id, icon: ICON });
    expect(program).toEqual({ id: web.id, ...tool, icon: ICON });
    expect(await (await freshModule()).getApp(web.id)).toEqual(program);
    // Programs have no certificates.
    await expect(store.trustCert(web.id, cert)).rejects.toThrow();

    // Back to a web app: starts afresh, but keeps the picture.
    const again = (await store.saveApp({ ...nas, id: web.id })).saved as WebApp;
    expect(again).toMatchObject({ kind: "web", hideAddressBar: false, trustedCerts: [], icon: ICON });
    expect(again).not.toHaveProperty("path");
  });

  it("refuses a program path that is not a full path to a program", async () => {
    const store = await freshModule();
    for (const bad of ["example.exe", "C:\\Tools\\notes.txt", "C:\\Tools\\run.exe\nC:\\x.exe", ""]) {
      await expect(store.saveApp({ ...tool, path: bad })).rejects.toThrow();
    }
  });

  it("leaves out an app it cannot read, keeping the others", async () => {
    await writeFile(
      path.join(userData, "apps.json"),
      JSON.stringify({
        apps: [
          { kind: "program", id: "bad", name: "Bad", path: "notes.txt" },
          { kind: "program", id: "ok", name: "Tool", path: tool.path },
          { id: "web", name: "NAS", url: "https://nas.example.lan/" },
        ],
      }),
    );
    expect((await (await freshModule()).listApps()).map((item) => item.id)).toEqual(["ok", "web"]);
  });
});
