import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  displayName,
  emailAddress,
  hasRealAttachment,
  toMailMessage,
  toThreadSummary,
} from "./parse";

const encode = (value: string) => Buffer.from(value).toString("base64url");

describe("displayName", () => {
  it.each([
    ['"홍길동" <hong@example.com>', "홍길동"],
    ["Hong Gil <hong@example.com>", "Hong Gil"],
    ["<hong@example.com>", "hong@example.com"],
    ["hong@example.com", "hong@example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(displayName(input)).toBe(expected);
  });
});

describe("emailAddress", () => {
  it.each([
    ['"홍길동" <Hong@Example.com>', "hong@example.com"],
    ["Instagram <no-reply@mail.instagram.com>", "no-reply@mail.instagram.com"],
    [" hong@example.com ", "hong@example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(emailAddress(input)).toBe(expected);
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal, and hex entities once", () => {
    expect(decodeEntities("a &amp; b &#39;c&#x27; &amp;lt;")).toBe(
      "a & b 'c' &lt;",
    );
  });

  it("leaves unknown and out-of-range entities alone", () => {
    expect(decodeEntities("&unknown; &#x110000;")).toBe(
      "&unknown; &#x110000;",
    );
  });
});

describe("toMailMessage", () => {
  it("extracts html, text, and attachments from nested parts", () => {
    const message = toMailMessage({
      id: "m1",
      internalDate: "1700000000000",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "subject", value: "제목" },
          { name: "FROM", value: "a@example.com" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: encode("안녕") } },
              { mimeType: "text/html", body: { data: encode("<p>안녕</p>") } },
            ],
          },
          {
            mimeType: "application/pdf",
            filename: "a.pdf",
            body: { attachmentId: "att1", size: 10 },
          },
        ],
      },
    });

    expect(message).toMatchObject({
      subject: "제목",
      from: "a@example.com",
      text: "안녕",
      html: "<p>안녕</p>",
      date: 1700000000000,
      unread: true,
      attachments: [
        { attachmentId: "att1", filename: "a.pdf", mimeType: "application/pdf" },
      ],
    });
  });

  it("does not treat a text file attachment with inline data as the body", () => {
    const message = toMailMessage({
      payload: {
        mimeType: "text/plain",
        filename: "note.txt",
        body: { data: encode("file") },
      },
    });
    expect(message.text).toBeNull();
  });
});

describe("toThreadSummary", () => {
  it("uses the first subject, the last sender, and any unread state", () => {
    const summary = toThreadSummary({
      id: "t1",
      messages: [
        {
          labelIds: ["UNREAD"],
          payload: {
            headers: [
              { name: "Subject", value: "처음" },
              { name: "From", value: "first@example.com" },
            ],
          },
        },
        {
          snippet: "R&amp;D",
          internalDate: "2000",
          payload: {
            headers: [
              { name: "Subject", value: "Re: 처음" },
              { name: "From", value: "Last <last@example.com>" },
            ],
          },
        },
      ],
    });

    expect(summary).toEqual({
      id: "t1",
      subject: "처음",
      from: "Last",
      fromAddress: "last@example.com",
      snippet: "R&D",
      date: 2000,
      unread: true,
      messageCount: 2,
      hasAttachment: false,
    });
  });
});

describe("hasRealAttachment", () => {
  const part = (mimeType: string, extra: object = {}) => ({ mimeType, ...extra });
  const disposition = (value: string) => ({ headers: [{ name: "Content-Disposition", value }] });
  const message = (payload: object) => ({ payload });

  it("finds a file a few levels down", () => {
    expect(
      hasRealAttachment(
        message(
          part("multipart/mixed", {
            parts: [
              part("multipart/alternative", { parts: [part("text/plain"), part("text/html")] }),
              part("application/pdf", { filename: "견적서.pdf", ...disposition('attachment; filename="q.pdf"'), body: { size: 120_000 } }),
            ],
          }),
        ),
      ),
    ).toBe(true);
  });

  it("is false for a signature logo and a business card only", () => {
    expect(
      hasRealAttachment(
        message(
          part("multipart/mixed", {
            parts: [
              part("multipart/related", {
                parts: [
                  part("text/html"),
                  part("image/png", {
                    filename: "image001.png",
                    headers: [
                      { name: "Content-Disposition", value: "inline" },
                      { name: "Content-ID", value: "<image001@x>" },
                    ],
                    body: { size: 3_000 },
                  }),
                ],
              }),
              part("text/x-vcard", { filename: "홍길동.vcf", ...disposition("attachment") }),
            ],
          }),
        ),
      ),
    ).toBe(false);
  });

  it("is false for plain mail and a message without a payload", () => {
    expect(hasRealAttachment(message(part("text/plain")))).toBe(false);
    expect(hasRealAttachment({})).toBe(false);
  });
});

describe("toThreadSummary attachment flag", () => {
  it("is set when any message of the thread has a file", () => {
    const withFile = {
      payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "s" }], parts: [
        { mimeType: "text/plain" },
        { mimeType: "application/zip", filename: "a.zip", headers: [{ name: "Content-Disposition", value: "attachment" }] },
      ] },
    };
    const plain = { payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "s" }] } };
    expect(toThreadSummary({ id: "t", messages: [plain, withFile] }).hasAttachment).toBe(true);
    expect(toThreadSummary({ id: "t", messages: [plain] }).hasAttachment).toBe(false);
  });
});
