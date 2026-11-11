/**
 * Which MIME parts count as an attachment worth flagging in the mail list.
 * Mail often carries files nobody would call an attachment: a business card
 * (vCard), a digital signature (S/MIME, PGP), or the logo of an email
 * signature shown inside the body. Those are left out.
 */

/** One MIME part as each mail source describes it. */
export type PartInfo = {
  mimeType: string;
  filename?: string | null;
  /** `inline` or `attachment`, from Content-Disposition. */
  disposition?: string | null;
  /** Has a Content-ID: the body refers to it (an embedded image). */
  hasContentId?: boolean;
  /** Inside a multipart/related: part of the body's layout. */
  inRelated?: boolean;
  /** Size in bytes, when known. */
  size?: number | null;
};

/** Business cards and digital signatures. */
const EXCLUDED_TYPES = new Set([
  "text/vcard",
  "text/x-vcard",
  "text/directory",
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
  "application/pgp-signature",
  "application/pgp-keys",
]);
const EXCLUDED_EXTENSIONS = new Set(["vcf", "vcard", "p7s", "sig", "asc"]);

/** Inline images smaller than this are signature logos, icons, and the like. */
const SMALL_INLINE_IMAGE_BYTES = 40 * 1024;

function extension(filename: string) {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match ? match[1].toLowerCase() : "";
}

/** True for a part a reader would call an attachment. */
export function isRealAttachment(part: PartInfo): boolean {
  const mimeType = part.mimeType.toLowerCase().split(";")[0].trim();
  const filename = part.filename?.trim() ?? "";
  const disposition = part.disposition?.toLowerCase() ?? "";
  if (mimeType.startsWith("multipart/")) return false;
  // A nameless part is body text, unless it is explicitly an attachment.
  if (!filename && disposition !== "attachment") return false;
  if (EXCLUDED_TYPES.has(mimeType) || EXCLUDED_EXTENSIONS.has(extension(filename))) return false;

  if (mimeType.startsWith("image/") && disposition !== "attachment") {
    // Shown inside the body (signature logos, pasted pictures).
    if (part.hasContentId || part.inRelated) return false;
    // Small inline pictures are icons or logos rather than files sent.
    if (disposition === "inline" && (part.size ?? 0) < SMALL_INLINE_IMAGE_BYTES) return false;
  }
  return true;
}
