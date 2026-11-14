import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * True in the Mac app, to word things for a Mac (apps rather than .exe
 * files). False while the page is prerendered, so it first shows the Windows
 * wording and switches once it runs.
 */
export function useOnMac() {
  return useSyncExternalStore(
    subscribe,
    () => /Macintosh|Mac OS X/.test(navigator.userAgent),
    () => false,
  );
}
