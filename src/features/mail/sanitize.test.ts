// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildEmailDocument, sanitizeForEditor } from "@/features/mail/sanitize";

function parse(html: string) {
  return new DOMParser().parseFromString(buildEmailDocument(html), "text/html");
}

describe("sanitizeForEditor", () => {
  const fragment = (html: string) => {
    const container = document.createElement("div");
    container.innerHTML = sanitizeForEditor(html);
    return container;
  };

  it("drops scripts, handlers, and javascript: links", () => {
    const out = fragment(
      `<img src="x" onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">x</a><svg onload="alert(1)"></svg>`,
    );
    expect(out.querySelector("script")).toBeNull();
    expect(out.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(out.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(out.innerHTML).not.toContain("onload");
  });

  it("drops what could restyle or cover the app", () => {
    const out = fragment(
      `<style>body{display:none}</style><link rel="stylesheet" href="x.css"><div class="fixed inset-0 z-50" id="mailApi" name="x" data-mc="signature">t</div>`,
    );
    expect(out.querySelector("style, link")).toBeNull();
    const div = out.querySelector("div");
    for (const attribute of ["class", "id", "name", "data-mc"]) {
      expect(div?.hasAttribute(attribute)).toBe(false);
    }
    expect(div?.textContent).toBe("t");
  });

  it("keeps ordinary formatting and safe links", () => {
    const out = fragment(
      `<p style="color:red"><b>굵게</b> <a href="https://example.com">링크</a></p><ul><li>a</li></ul>`,
    );
    expect(out.querySelector("b")?.textContent).toBe("굵게");
    expect(out.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(out.querySelector("p")?.getAttribute("style")).toContain("color");
    expect(out.querySelector("ul li")).not.toBeNull();
  });
});

describe("buildEmailDocument", () => {
  it("removes scripts, event handlers, and forms", () => {
    const doc = parse(
      `<script>alert(1)</script><img src="https://a.test/x.png" onerror="alert(1)"><form action="https://evil.test"><input name="pw"></form><a href="javascript:alert(1)">x</a>`,
    );

    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("form, input")).toBeNull();
    expect(doc.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(doc.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  it("puts a restrictive CSP first in head and opens links in a new tab", () => {
    const doc = parse("<p>hello</p>");
    const first = doc.head.firstElementChild;

    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first?.getAttribute("content")).toContain("default-src 'none'");
    expect(doc.querySelector("base")?.getAttribute("target")).toBe("_blank");
    expect(doc.body.textContent).toBe("hello");
  });

  it("keeps head styles that email layouts depend on", () => {
    const doc = parse(
      "<html><head><style>p { color: red; }</style></head><body><p>x</p></body></html>",
    );
    expect(doc.querySelector("style")?.textContent).toContain("color: red");
  });
});
