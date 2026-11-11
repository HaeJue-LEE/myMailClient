import { app, type BrowserWindow, type Rectangle, screen } from "electron";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Window sizes remembered between runs, per kind of window: the main window
 * keeps its place and whether it was maximized; pop-ups keep their size only,
 * so several of them do not open exactly on top of one another.
 */
export type WindowKind = "main" | "thread" | "compose";

const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;

const boundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(MIN_WIDTH).max(20_000),
  height: z.number().int().min(MIN_HEIGHT).max(20_000),
});
const entrySchema = z.object({ bounds: boundsSchema, maximized: z.boolean().default(false) });
const fileSchema = z.object({
  main: entrySchema.optional(),
  thread: entrySchema.optional(),
  compose: entrySchema.optional(),
});
type StateFile = z.infer<typeof fileSchema>;
type Entry = z.infer<typeof entrySchema>;

const filePath = () => path.join(app.getPath("userData"), "window-state.json");

let state: StateFile | null = null;

/** Read once, synchronously: windows need it before they are created. */
function load(): StateFile {
  if (state) return state;
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(filePath(), "utf8")));
    state = parsed.success ? parsed.data : {};
  } catch {
    state = {};
  }
  return state;
}

/**
 * Written synchronously: closing the last window quits the app at once, and
 * an asynchronous write could be cut off. The file is a few hundred bytes.
 */
function persist() {
  try {
    const temporary = `${filePath()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), "utf8");
    renameSync(temporary, filePath());
  } catch {
    // Not worth failing a window close over; the old sizes stay.
  }
}

/**
 * `bounds` made to fit the screens there are now: shrunk to the work area it
 * shows on most, and moved fully onto it when a screen has gone (e.g. a
 * monitor unplugged). Without a position, only the size is fitted.
 */
export function fitToScreens(
  bounds: Rectangle,
  workAreas: Rectangle[],
  keepPosition: boolean,
): Partial<Rectangle> & { width: number; height: number } {
  if (workAreas.length === 0) return { width: bounds.width, height: bounds.height };
  const overlap = (area: Rectangle) =>
    Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)) *
    Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  const best = workAreas.reduce((a, b) => (overlap(b) > overlap(a) ? b : a));
  const width = Math.min(bounds.width, best.width);
  const height = Math.min(bounds.height, best.height);
  if (!keepPosition) return { width, height };
  const x = Math.min(Math.max(bounds.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(bounds.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}

/** Where a new window of `kind` opens: its remembered size (and place), else `fallback`. */
export function initialBounds(kind: WindowKind, fallback: { width: number; height: number }) {
  const saved = load()[kind];
  if (!saved) return { bounds: fallback, maximized: false };
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  return {
    bounds: fitToScreens(saved.bounds, workAreas, kind === "main"),
    maximized: kind === "main" && saved.maximized,
  };
}

/**
 * Remembers the window's size as it closes. The size it had before being
 * maximized is kept, so un-maximizing next time goes back to it.
 */
export function rememberBounds(window: BrowserWindow, kind: WindowKind) {
  const save = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const maximized = window.isMaximized();
    const bounds = maximized ? window.getNormalBounds() : window.getBounds();
    const entry: Entry = { bounds, maximized };
    if (!entrySchema.safeParse(entry).success) return;
    load()[kind] = entry;
    persist();
  };
  // "close" still has the window's bounds; "closed" does not.
  window.on("close", save);
}
