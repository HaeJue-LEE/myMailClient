// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeForEditor } from "@/features/mail/sanitize";
import { initialBody, signatureBlock, swapSignature } from "@/features/mail/signature";

const block = (html: string) => signatureBlock(html, sanitizeForEditor);

function editor(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("signatureBlock", () => {
  it("wraps a sanitized signature, or yields nothing for an empty one", () => {
    const html = block('<b>G.D.HONG</b><img src="x" onerror="alert(1)">');
    expect(html).toMatch(/^<div data-mc="signature"><div>--<\/div><b>G.D.HONG<\/b>/);
    expect(html).not.toContain("onerror");
    expect(block("")).toBe("");
    expect(block("   ")).toBe("");
  });
});

describe("swapSignature", () => {
  const quote = '<div data-mc="quote"><blockquote>원문</blockquote></div>';

  it("replaces the current signature in place", () => {
    const root = editor(initialBody(block("A"), quote));
    swapSignature(root, block("B"));
    expect(root.querySelectorAll('[data-mc="signature"]')).toHaveLength(1);
    expect(root.querySelector('[data-mc="signature"]')?.textContent).toBe("--B");
    // Still above the quote.
    expect(root.lastElementChild?.getAttribute("data-mc")).toBe("quote");
  });

  it("removes it for a sender without one, and adds one before the quote", () => {
    const root = editor(initialBody(block("A"), quote));
    swapSignature(root, "");
    expect(root.querySelector('[data-mc="signature"]')).toBeNull();
    swapSignature(root, block("C"));
    expect(root.querySelector('[data-mc="signature"]')?.nextElementSibling?.getAttribute("data-mc")).toBe("quote");
  });

  it("appends when there is no quote, and keeps the typed text", () => {
    const root = editor(initialBody(""));
    root.firstElementChild!.textContent = "본문";
    swapSignature(root, block("D"));
    expect(root.lastElementChild?.textContent).toBe("--D");
    expect(root.textContent?.startsWith("본문")).toBe(true);
  });

  it("ignores a fake marker in quoted mail, which sanitizing removed", () => {
    const quoted = sanitizeForEditor('<div data-mc="signature">attacker</div>');
    const root = editor(initialBody("", `<div data-mc="quote">${quoted}</div>`));
    swapSignature(root, block("E"));
    expect(root.textContent).toContain("attacker");
    expect(root.querySelectorAll('[data-mc="signature"]')).toHaveLength(1);
  });
});
