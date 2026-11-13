import { describe, expect, it } from "vitest";
import {
  appHost,
  appInitial,
  groupApps,
  groupSuggestions,
  isAppIcon,
  MAX_APP_ICON_LENGTH,
  type MyApp,
  myAppInputSchema,
  parseAppUrl,
  withScheme,
} from "@/features/apps/apps";
import { appEditHref, appViewHref, isAppViewPath } from "@/features/apps/routes";

const app = (id: string, group: string): MyApp => ({
  id,
  name: id,
  url: "https://nas.example.lan:5001/",
  group,
  openIn: "embed",
  pinned: false,
  icon: null,
  hideAddressBar: false,
  trustedCerts: [],
});

describe("parseAppUrl", () => {
  it("accepts http and https addresses, LAN ones included", () => {
    expect(parseAppUrl("https://nas.example.lan:5001")?.host).toBe("nas.example.lan:5001");
    expect(parseAppUrl(" http://192.0.2.10:5000/ ")?.port).toBe("5000");
  });

  it("refuses other schemes and addresses carrying credentials", () => {
    for (const raw of [
      "file:///C:/Windows",
      "javascript:alert(1)",
      "app://bundle/mail",
      "ftp://nas.example.lan",
      "https://admin:secret@nas.example.lan",
      "not a url",
      "",
    ]) {
      expect(parseAppUrl(raw), raw).toBeNull();
    }
  });
});

describe("withScheme", () => {
  it("adds http:// to an address typed without a scheme", () => {
    expect(withScheme("192.0.2.10:5000")).toBe("http://192.0.2.10:5000");
    expect(withScheme(" nas.example.lan ")).toBe("http://nas.example.lan");
  });

  it("leaves an address with a scheme, and an empty one, as is", () => {
    expect(withScheme("https://nas.example.lan")).toBe("https://nas.example.lan");
    expect(withScheme("")).toBe("");
  });
});

describe("myAppInputSchema", () => {
  it("normalises the address and trims the fields", () => {
    expect(
      myAppInputSchema.parse({
        name: "  우리집 NAS ",
        url: " https://NAS.example.lan:5001 ",
        group: " NAS ",
        openIn: "window",
        pinned: true,
      }),
    ).toEqual({
      name: "우리집 NAS",
      url: "https://nas.example.lan:5001/",
      group: "NAS",
      openIn: "window",
      pinned: true,
    });
  });

  it("refuses an empty name, a bad address, or an unknown way to open", () => {
    const valid = { name: "NAS", url: "https://nas.example.lan", group: "", openIn: "embed", pinned: false };
    expect(myAppInputSchema.safeParse(valid).success).toBe(true);
    expect(myAppInputSchema.safeParse({ ...valid, name: "  " }).success).toBe(false);
    expect(myAppInputSchema.safeParse({ ...valid, url: "file:///etc/passwd" }).success).toBe(false);
    expect(myAppInputSchema.safeParse({ ...valid, openIn: "tab" }).success).toBe(false);
    expect(myAppInputSchema.safeParse({ ...valid, icon: PNG }).success).toBe(true);
    expect(myAppInputSchema.safeParse({ ...valid, icon: null }).success).toBe(true);
    expect(myAppInputSchema.safeParse({ ...valid, icon: "https://evil.test/x.png" }).success).toBe(false);
  });
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("isAppIcon", () => {
  it("accepts only bounded PNG data URLs", () => {
    expect(isAppIcon(PNG)).toBe(true);
    // Remote addresses (a tracker), other types, and broken base64 are not icons.
    expect(isAppIcon("https://evil.test/x.png")).toBe(false);
    expect(isAppIcon("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isAppIcon("data:image/png;base64,ab\"><script>")).toBe(false);
    expect(isAppIcon(`data:image/png;base64,${"A".repeat(MAX_APP_ICON_LENGTH)}`)).toBe(false);
  });
});

describe("groups", () => {
  it("groups apps in list order, groups in the order they first appear", () => {
    const grouped = groupApps([app("a", "NAS"), app("b", ""), app("c", "NAS"), app("d", "업무")]);
    expect(grouped.map(({ group, apps }) => [group, apps.map((item) => item.id)])).toEqual([
      ["NAS", ["a", "c"]],
      ["", ["b"]],
      ["업무", ["d"]],
    ]);
  });

  it("suggests the groups in use, then the defaults, once each", () => {
    expect(groupSuggestions([app("a", "미디어"), app("b", "NAS"), app("c", "")])).toEqual([
      "미디어",
      "NAS",
      "홈서버",
      "업무",
      "기타",
    ]);
  });
});

describe("display", () => {
  it("shows the host with its port, and one letter", () => {
    expect(appHost(app("a", ""))).toBe("nas.example.lan:5001");
    expect(appInitial(" synology")).toBe("S");
    expect(appInitial("우리집")).toBe("우");
    expect(appInitial("")).toBe("?");
  });
});

describe("routes", () => {
  it("puts the app in the query string", () => {
    expect(appViewHref("a b")).toBe("/apps/view?id=a+b");
    expect(appEditHref()).toBe("/apps/settings?edit=new");
    expect(appEditHref("x")).toBe("/apps/settings?edit=x");
  });

  it("recognises the page that shows an embedded app", () => {
    expect(isAppViewPath("/apps/view")).toBe(true);
    expect(isAppViewPath("/apps/view/")).toBe(true);
    expect(isAppViewPath("/apps")).toBe(false);
    expect(isAppViewPath("/mail")).toBe(false);
  });
});
