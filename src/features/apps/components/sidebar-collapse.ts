"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the sidebar (mail folders, the app list) is folded away, leaving
 * only the rail. One setting for mail and MyApps, remembered on this
 * computer. Storage may be unavailable (or throw); the sidebar then just
 * starts open.
 */
const KEY = "sidebarCollapsed";
const listeners = new Set<() => void>();
/** Kept in memory too, so folding works even where storage does not. */
let collapsed: boolean | null = null;

function read() {
  if (collapsed === null) {
    try {
      collapsed = window.localStorage.getItem(KEY) === "1";
    } catch {
      collapsed = false;
    }
  }
  return collapsed;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function setSidebarCollapsed(next: boolean) {
  collapsed = next;
  try {
    window.localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // Remembered for this run only.
  }
  for (const listener of listeners) listener();
}

/** True while the sidebar is folded away. Open on the server render, as before hydration. */
export function useSidebarCollapsed() {
  return useSyncExternalStore(subscribe, read, () => false);
}
