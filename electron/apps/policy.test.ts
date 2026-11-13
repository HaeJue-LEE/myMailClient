import { describe, expect, it } from "vitest";
import {
  ALLOWED_PERMISSIONS,
  formatFingerprint,
  mayNavigate,
  partitionFor,
  popupTarget,
  toViewBounds,
  viewsToClose,
} from "./policy";

const APP_URL = "https://nas.example.lan:5001/";

describe("partitionFor", () => {
  it("gives each app a persistent session of its own", () => {
    expect(partitionFor("abc")).toBe("persist:myapp-abc");
    expect(partitionFor("abc")).not.toBe(partitionFor("abd"));
  });
});

describe("mayNavigate", () => {
  it("lets app pages go to web addresses only", () => {
    expect(mayNavigate("https://sso.example.org/login")).toBe(true);
    expect(mayNavigate("http://192.0.2.10:5000/")).toBe(true);
    expect(mayNavigate("about:blank")).toBe(true);
    expect(mayNavigate("file:///C:/Windows/win.ini")).toBe(false);
    expect(mayNavigate("app://bundle/mail")).toBe(false);
    expect(mayNavigate("javascript:alert(1)")).toBe(false);
  });
});

describe("popupTarget", () => {
  it("keeps the app's own pop-ups in its session", () => {
    expect(popupTarget("https://nas.example.lan:5001/preview?id=1", APP_URL, APP_URL)).toBe("child");
    // The page the pop-up was opened from counts too (e.g. after a redirect to another port).
    expect(popupTarget("https://nas.example.lan:5443/x", "https://nas.example.lan:5443/", APP_URL)).toBe("child");
    expect(popupTarget("about:blank", APP_URL, APP_URL)).toBe("child");
  });

  it("sends other sites and mailto: to the default browser", () => {
    expect(popupTarget("https://www.example.com/help", APP_URL, APP_URL)).toBe("external");
    // Another port is another origin.
    expect(popupTarget("https://nas.example.lan:8443/", APP_URL, APP_URL)).toBe("external");
    expect(popupTarget("mailto:someone@example.com", APP_URL, APP_URL)).toBe("external");
  });

  it("refuses anything else", () => {
    expect(popupTarget("file:///C:/Windows", APP_URL, APP_URL)).toBe("deny");
    expect(popupTarget("app://bundle/mail", APP_URL, APP_URL)).toBe("deny");
  });
});

describe("ALLOWED_PERMISSIONS", () => {
  it("gives app pages no device or location access", () => {
    for (const permission of ["media", "geolocation", "notifications", "openExternal", "hid", "serial"]) {
      expect(ALLOWED_PERMISSIONS.has(permission), permission).toBe(false);
    }
  });
});

describe("toViewBounds", () => {
  it("rounds the page's rectangle into window pixels", () => {
    expect(toViewBounds({ x: 296.4, y: 45.6, width: 900.2, height: 700.5 }, 1)).toEqual({
      x: 296,
      y: 46,
      width: 901,
      height: 700,
    });
  });

  it("scales by the page's zoom and never goes negative", () => {
    expect(toViewBounds({ x: 100, y: 50, width: 400, height: 300 }, 1.25)).toEqual({
      x: 125,
      y: 63,
      width: 500,
      height: 375,
    });
    expect(toViewBounds({ x: -5, y: 0, width: 10, height: 10 }, 0)).toEqual({ x: 0, y: 0, width: 5, height: 10 });
  });
});

describe("viewsToClose", () => {
  it("closes the least recently shown beyond the limit, never the one shown", () => {
    const shown = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
    ]);
    expect(viewsToClose(shown, 4, "e")).toEqual(["a"]);
    expect(viewsToClose(shown, 3, "a")).toEqual(["b", "c"]);
    expect(viewsToClose(shown, 5, "e")).toEqual([]);
  });
});

describe("formatFingerprint", () => {
  it("shows Electron's sha256/base64 fingerprint as hex pairs", () => {
    const bytes = Buffer.from([0xab, 0x01, 0xff]);
    expect(formatFingerprint(`sha256/${bytes.toString("base64")}`)).toBe("AB:01:FF");
  });
});
