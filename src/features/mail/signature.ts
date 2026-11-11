/**
 * Gmail signatures in the compose editor. The block carries `data-mc` so a
 * change of sender can find and replace it; quoted mail cannot fake that
 * marker because editor sanitizing strips it.
 */
const SELECTOR = '[data-mc="signature"]';

/** The editor block for a signature (HTML from Gmail), or "" when there is none. */
export function signatureBlock(
  signatureHtml: string,
  sanitize: (html: string) => string,
) {
  const clean = sanitize(signatureHtml).trim();
  return clean ? `<div data-mc="signature"><div>--</div>${clean}</div>` : "";
}

/** An empty line where the cursor starts, then a second one before what follows. */
const OPENING = "<div><br></div><div><br></div>";

/** Initial editor content: room to type, the signature, then any quote. */
export function initialBody(signature: string, quoteHtml = "") {
  return `${OPENING}${signature}${quoteHtml}`;
}

/**
 * Puts `blockHtml` in place of the current signature block (or removes it
 * when empty). A new block goes before the quote, or at the end.
 */
export function swapSignature(root: HTMLElement, blockHtml: string) {
  const current = root.querySelector(SELECTOR);
  if (!blockHtml) {
    current?.remove();
    return;
  }
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = blockHtml;
  const next = template.content.firstElementChild;
  if (!next) return;
  if (current) {
    current.replaceWith(next);
    return;
  }
  const quote = root.querySelector('[data-mc="quote"]');
  if (quote) quote.before(next);
  else root.append(next);
}
