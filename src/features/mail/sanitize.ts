import DOMPurify from "dompurify";

/** Blocks scripts, frames, and form posts even if a payload survives sanitizing. */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:";

/**
 * Untrusted HTML (a quoted email, a signature, pasted content) made safe to
 * place in the compose editor. Unlike the viewer, the editor lives in the
 * app's own page, next to `window.mailApi`, so besides scripts this also drops:
 * - `<style>`/`<link>`, which would restyle the whole app;
 * - `class`/`id`/`name`, so the app's CSS classes (e.g. "fixed inset-0")
 *   cannot be borrowed to cover the app, and nothing can clobber globals;
 * - `data-mc`, the app's own markers for quotes and signatures.
 * The editor additionally isolates layout with CSS containment.
 */
export function sanitizeForEditor(html: string) {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      "style",
      "link",
      "meta",
      "base",
      "title",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "iframe",
      "object",
      "embed",
    ],
    FORBID_ATTR: ["class", "id", "name", "data-mc"],
  });
}

/**
 * Turns untrusted email HTML into a document for a sandboxed iframe's srcdoc.
 * Browser only, since DOMPurify needs a DOM.
 */
export function buildEmailDocument(html: string) {
  const root = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS: ["form", "input", "button", "textarea", "select"],
  }) as HTMLElement;

  const owner = root.ownerDocument;
  const policy = owner.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", CONTENT_SECURITY_POLICY);
  const base = owner.createElement("base");
  base.setAttribute("target", "_blank");
  root.querySelector("head")?.prepend(policy, base);

  return `<!doctype html>${root.outerHTML}`;
}
