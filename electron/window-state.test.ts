import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let userData = "";
const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  screen: { getAllDisplays: () => displays },
}));

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

/** A fresh module (no cached state), as after an app restart. */
const fresh = async () => {
  vi.resetModules();
  return import("./window-state");
};

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "window-state-"));
});
afterEach(() => rm(userData, { recursive: true, force: true }));

describe("fitToScreens", () => {
  it("keeps a window that fits where it was", async () => {
    const { fitToScreens } = await fresh();
    const bounds = { x: 2100, y: 100, width: 1200, height: 800 };
    expect(fitToScreens(bounds, [primary, right], true)).toEqual(bounds);
  });

  it("brings back a window from a screen that is gone", async () => {
    const { fitToScreens } = await fresh();
    expect(fitToScreens({ x: 2100, y: 100, width: 1200, height: 800 }, [primary], true)).toEqual({
      x: 720,
      y: 100,
      width: 1200,
      height: 800,
    });
  });

  it("shrinks a window larger than its screen", async () => {
    const { fitToScreens } = await fresh();
    expect(fitToScreens({ x: -50, y: -20, width: 3000, height: 1200 }, [primary], true)).toEqual(
      primary,
    );
  });

  it("gives only a size for pop-ups", async () => {
    const { fitToScreens } = await fresh();
    expect(fitToScreens({ x: 2100, y: 100, width: 1000, height: 900 }, [primary], false)).toEqual({
      width: 1000,
      height: 900,
    });
  });
});

/** A stand-in BrowserWindow whose "close" can be fired. */
function fakeWindow(bounds: object, options: { maximized?: boolean; normal?: object } = {}) {
  const listeners: (() => void)[] = [];
  return {
    window: {
      isDestroyed: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      isMaximized: () => options.maximized ?? false,
      getBounds: () => bounds,
      getNormalBounds: () => options.normal ?? bounds,
      on: (event: string, listener: () => void) => {
        if (event === "close") listeners.push(listener);
      },
    },
    close: () => listeners.forEach((listener) => listener()),
  };
}

describe("remembered sizes", () => {
  it("opens at the default size the first time", async () => {
    const { initialBounds } = await fresh();
    expect(initialBounds("main", { width: 1280, height: 820 })).toEqual({
      bounds: { width: 1280, height: 820 },
      maximized: false,
    });
  });

  it("remembers each kind of window across restarts", async () => {
    const store = await fresh();
    const main = fakeWindow({ x: 100, y: 50, width: 1400, height: 900 });
    const popup = fakeWindow({ x: 300, y: 200, width: 1000, height: 700 });
    store.rememberBounds(main.window as never, "main");
    store.rememberBounds(popup.window as never, "compose");
    main.close();
    popup.close();

    const restarted = await fresh();
    expect(restarted.initialBounds("main", { width: 1, height: 1 })).toEqual({
      bounds: { x: 100, y: 50, width: 1400, height: 900 },
      maximized: false,
    });
    // Pop-ups get their size back, not their place.
    expect(restarted.initialBounds("compose", { width: 1, height: 1 })).toEqual({
      bounds: { width: 1000, height: 700 },
      maximized: false,
    });
    expect(restarted.initialBounds("thread", { width: 960, height: 820 }).bounds).toEqual({
      width: 960,
      height: 820,
    });
  });

  it("keeps the size from before maximizing, and that it was maximized", async () => {
    const store = await fresh();
    const main = fakeWindow(primary, {
      maximized: true,
      normal: { x: 200, y: 100, width: 1100, height: 700 },
    });
    store.rememberBounds(main.window as never, "main");
    main.close();
    expect((await fresh()).initialBounds("main", { width: 1, height: 1 })).toEqual({
      bounds: { x: 200, y: 100, width: 1100, height: 700 },
      maximized: true,
    });
  });

  it("ignores a damaged file", async () => {
    const store = await fresh();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(userData, "window-state.json"), "{oops");
    expect(store.initialBounds("main", { width: 1280, height: 820 }).bounds).toEqual({
      width: 1280,
      height: 820,
    });
    // And the next close writes a good one.
    const main = fakeWindow({ x: 0, y: 0, width: 800, height: 600 });
    store.rememberBounds(main.window as never, "main");
    main.close();
    expect(JSON.parse(await readFile(path.join(userData, "window-state.json"), "utf8")).main.bounds.width).toBe(800);
  });
});
