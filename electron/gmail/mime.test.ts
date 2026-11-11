import { describe, expect, it } from "vitest";
import { buildMimeMessage, buildRawMessage, formatDate, formatMailbox, safeFilename } from "./mime";

const base = {
  from: "me@example.com",
  to: ["you@example.com"],
  subject: "hello",
  text: "body",
};

function decode(raw: string) {
  return Buffer.from(raw, "base64url").toString("utf8");
}

function decodeEncodedWords(header: string) {
  return [...header.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf8"))
    .join("");
}

/** Splits a multipart entity into its parts, using the boundary it declares. */
function parts(message: string) {
  const boundary = message.match(/multipart\/mixed; boundary="([^"]+)"/)?.[1];
  if (!boundary) return [];
  return message
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => part.trim());
}

describe("attachments", () => {
  const pdf = { filename: "report.pdf", mimeType: "application/pdf", data: new Uint8Array([1, 2, 3, 250]) };

  it("wraps the body and each file in multipart/mixed", () => {
    const message = decode(
      buildRawMessage({ ...base, html: "<b>body</b>", attachments: [pdf, { ...pdf, filename: "b.pdf" }] }),
    );
    const [body, first, second] = parts(message);
    expect(parts(message)).toHaveLength(3);
    expect(body).toContain("multipart/alternative");
    expect(first).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(first).toContain("Content-Type: application/pdf");
    expect(first.split("\r\n\r\n")[1]).toBe(Buffer.from(pdf.data).toString("base64"));
    expect(second).toContain('filename="b.pdf"');
  });

  it("encodes Korean file names the way Gmail reads them, plus RFC 2231", () => {
    const name = "견적서 (최종).pdf";
    const message = decode(
      buildRawMessage({ ...base, attachments: [{ ...pdf, filename: name }] }),
    );
    // Gmail reads the quoted filename/name (verified against the real API);
    // an ASCII stand-in there showed up as "___ (__).pdf".
    const quoted = message.match(/filename="([^"]+)"/)?.[1] ?? "";
    expect(decodeEncodedWords(quoted)).toBe(name);
    expect(decodeEncodedWords(message.match(/name="([^"]+)"/)?.[1] ?? "")).toBe(name);
    const extended = message.match(/filename\*=UTF-8''([^\r\n;]+)/)?.[1] ?? "";
    expect(decodeURIComponent(extended)).toBe(name);
    expect(extended).not.toMatch(/[()' ]/);
    expect(message).not.toContain("___");
  });

  it("keeps ASCII file names readable", () => {
    const message = decode(buildRawMessage({ ...base, attachments: [pdf] }));
    expect(message).toContain('filename="report.pdf"');
  });

  it("keeps hostile names and types out of the headers", () => {
    const message = decode(
      buildRawMessage({
        ...base,
        attachments: [
          {
            filename: '..\\..\\evil"\r\nBcc: x@evil.com.exe',
            mimeType: "text/html\r\nBcc: y@evil.com",
            data: new Uint8Array([0]),
          },
        ],
      }),
    );
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message).toContain("Content-Type: application/octet-stream;");
    expect(safeFilename('C:\\temp\\a"b.txt')).toBe("ab.txt");
    expect(safeFilename("\u0000")).toBe("attachment");
  });
});

describe("formatMailbox", () => {
  it("quotes ASCII names, so dots and quotes are safe", () => {
    expect(formatMailbox("G.D.HONG", "alias@example.org")).toBe('"G.D.HONG" <alias@example.org>');
    expect(formatMailbox('Kim "K"', "k@x.com")).toBe('"Kim \\"K\\"" <k@x.com>');
  });

  it("encodes non-ASCII names and leaves a bare address without one", () => {
    const header = formatMailbox("홍길동", "alias@example.org");
    expect(header).toMatch(/^=\?UTF-8\?B\?[^?]+\?= <alias@example.org>$/);
    expect(decodeEncodedWords(header)).toBe("홍길동");
    expect(formatMailbox("  ", "me@x.com")).toBe("me@x.com");
  });

  it("cannot be used to inject headers", () => {
    const message = decode(
      buildRawMessage({ ...base, from: formatMailbox("x\r\nBcc: evil@x.com", "me@x.com") }),
    );
    expect(message).not.toMatch(/^Bcc:/m);
  });
});

describe("buildRawMessage", () => {
  it("keeps ASCII subjects readable and base64-encodes the body", () => {
    const message = decode(buildRawMessage(base));
    expect(message).toContain("Subject: hello\r\n");
    expect(message).toContain("To: you@example.com\r\n");
    expect(message).toContain(Buffer.from("body").toString("base64"));
  });

  it("encodes long Korean subjects into valid folded encoded-words", () => {
    const subject = "안녕하세요 메일 제목 테스트입니다 ".repeat(6).trim();
    const message = decode(buildRawMessage({ ...base, subject }));
    const header = message.match(/Subject: ((?:.*\r\n )*.*)\r\n/)?.[1] ?? "";

    expect(decodeEncodedWords(header)).toBe(subject);
    for (const line of header.split("\r\n ")) {
      expect(line.length).toBeLessThanOrEqual(75);
    }
  });

  it("does not allow header injection through the subject", () => {
    const message = decode(
      buildRawMessage({ ...base, subject: "hi\r\nBcc: evil@example.com" }),
    );
    expect(message).not.toMatch(/^Bcc:/m);
  });

  it("builds multipart/alternative when html is present", () => {
    const message = decode(buildRawMessage({ ...base, html: "<b>body</b>" }));
    const boundary = message.match(/boundary="([^"]+)"/)?.[1];

    expect(boundary).toBeDefined();
    expect(message).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(message).toContain("Content-Type: text/html; charset=UTF-8");
    expect(message).toContain(`--${boundary}--`);
  });
});

describe("formatDate", () => {
  // 2026-11-11 13:15:26 UTC.
  const instant = new Date(Date.UTC(2026, 10, 11, 13, 15, 26));

  it("writes the local time with its offset, as webmail does", () => {
    expect(formatDate(instant, 9 * 60)).toBe("Wed, 11 Nov 2026 22:15:26 +0900");
    expect(formatDate(instant, 0)).toBe("Wed, 11 Nov 2026 13:15:26 +0000");
  });

  it("handles negative and half-hour offsets and a date change", () => {
    expect(formatDate(instant, -14 * 60)).toBe("Tue, 10 Nov 2026 23:15:26 -1400");
    expect(formatDate(instant, 5 * 60 + 30)).toBe("Wed, 11 Nov 2026 18:45:26 +0530");
    expect(formatDate(new Date(Date.UTC(2026, 11, 31, 20, 0, 5)), 9 * 60)).toBe(
      "Fri, 1 Jan 2027 05:00:05 +0900",
    );
  });

  it("describes the same instant whatever the offset", () => {
    for (const offset of [9 * 60, 0, -300]) {
      expect(new Date(formatDate(instant, offset)).getTime()).toBe(instant.getTime());
    }
  });

  it("uses the computer's time zone in messages", () => {
    const raw = buildMimeMessage({ from: "a@x.com", to: ["b@x.com"], subject: "s", text: "t", date: instant });
    expect(raw).toContain(`Date: ${formatDate(instant, -instant.getTimezoneOffset())}`);
  });
});
