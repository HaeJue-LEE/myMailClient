import { describe, expect, it } from "vitest";
import { isRealAttachment } from "@/features/mail/attachments";

describe("isRealAttachment", () => {
  it("counts ordinary files", () => {
    for (const [mimeType, filename] of [
      ["application/pdf", "견적서.pdf"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "매출.xlsx"],
      ["application/zip", "자료.zip"],
      ["text/calendar", "invite.ics"],
      ["application/octet-stream", "data.bin"],
    ]) {
      expect(isRealAttachment({ mimeType, filename, disposition: "attachment" }), filename).toBe(true);
    }
  });

  it("leaves out business cards and digital signatures", () => {
    for (const [mimeType, filename] of [
      ["text/vcard", "홍길동.vcf"],
      ["text/x-vcard", "card.vcf"],
      ["application/octet-stream", "명함.vcf"],
      ["application/pkcs7-signature", "smime.p7s"],
      ["application/x-pkcs7-signature", "smime.p7s"],
      ["application/pgp-signature", "signature.asc"],
    ]) {
      expect(isRealAttachment({ mimeType, filename, disposition: "attachment" }), filename).toBe(false);
    }
  });

  it("leaves out images shown inside the body", () => {
    // Outlook signature logo: inline, with a Content-ID.
    expect(
      isRealAttachment({ mimeType: "image/png", filename: "image001.png", disposition: "inline", hasContentId: true, size: 4_000 }),
    ).toBe(false);
    // Part of a multipart/related body.
    expect(isRealAttachment({ mimeType: "image/jpeg", filename: "logo.jpg", inRelated: true })).toBe(false);
    // A small inline icon without a Content-ID.
    expect(isRealAttachment({ mimeType: "image/gif", filename: "icon.gif", disposition: "inline", size: 2_000 })).toBe(false);
  });

  it("still counts pictures that were sent as files", () => {
    expect(isRealAttachment({ mimeType: "image/jpeg", filename: "현장사진.jpg", disposition: "attachment", hasContentId: true })).toBe(true);
    // Apple Mail sends photos inline but without a Content-ID.
    expect(isRealAttachment({ mimeType: "image/jpeg", filename: "IMG_0001.jpg", disposition: "inline", size: 2_000_000 })).toBe(true);
  });

  it("ignores body text and containers", () => {
    expect(isRealAttachment({ mimeType: "text/plain" })).toBe(false);
    expect(isRealAttachment({ mimeType: "text/html", disposition: "inline" })).toBe(false);
    expect(isRealAttachment({ mimeType: "multipart/mixed", filename: "x" })).toBe(false);
    // A nameless part explicitly sent as an attachment still counts.
    expect(isRealAttachment({ mimeType: "application/pdf", disposition: "attachment" })).toBe(true);
  });
});
