import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

/** A fresh module, as after an app restart (its in-memory cache is gone). */
const freshModule = async () => {
  vi.resetModules();
  return import("./hidden-contacts");
};

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "hidden-contacts-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("hidden contacts", () => {
  it("hides and shows addresses, normalised", async () => {
    const store = await freshModule();
    expect(await store.setContactsHidden([" B@x.com", "a@x.com"], true)).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
    expect(await store.setContactsHidden(["b@x.com"], false)).toEqual(["a@x.com"]);
    expect(await store.getHiddenContacts()).toEqual(["a@x.com"]);
  });

  it("survives a restart", async () => {
    const first = await freshModule();
    await first.setContactsHidden(["a@x.com"], true);

    const second = await freshModule();
    expect(await second.getHiddenContacts()).toEqual(["a@x.com"]);
    const file = JSON.parse(await readFile(path.join(userData, "hidden-contacts.json"), "utf8"));
    expect(file).toEqual({ emails: ["a@x.com"] });
  });

  it("merges the earlier per-account lists into one", async () => {
    await writeFile(
      path.join(userData, "hidden-contacts.json"),
      JSON.stringify({
        accounts: { "me@gmail.com": ["a@x.com", "b@x.com"], "me@naver.com": ["B@x.com", "c@x.com"] },
      }),
    );
    const store = await freshModule();
    expect(await store.getHiddenContacts()).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(await store.setContactsHidden(["a@x.com"], false)).toEqual(["b@x.com", "c@x.com"]);
    const file = JSON.parse(await readFile(path.join(userData, "hidden-contacts.json"), "utf8"));
    expect(file).toEqual({ emails: ["b@x.com", "c@x.com"] });
  });

  it("starts empty when the file is missing or damaged", async () => {
    await writeFile(path.join(userData, "hidden-contacts.json"), "{not json");
    const store = await freshModule();
    expect(await store.getHiddenContacts()).toEqual([]);
    expect(await store.setContactsHidden(["a@x.com"], true)).toEqual(["a@x.com"]);
  });

  it("keeps every change when several arrive at once", async () => {
    const store = await freshModule();
    await Promise.all(
      ["a", "b", "c", "d"].map((n) => store.setContactsHidden([`${n}@x.com`], true)),
    );
    const reloaded = await freshModule();
    expect(await reloaded.getHiddenContacts()).toHaveLength(4);
  });
});
