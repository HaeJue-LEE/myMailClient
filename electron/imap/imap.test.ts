import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { InvalidRequestError, MailServerError } from "../errors";
import { buildMimeMessage } from "../gmail/mime";
import { toImapError } from "./connection";
import { type Folder, mapFolders, resolveLabel } from "./folders";
import { decodeMessageId, encodeMessageId } from "./ids";
import {
  decodeSnippet,
  findTextPart,
  listedAttachments,
  parsedHasAttachment,
  structureHasAttachment,
  toMailMessage,
  toThreadSummary,
} from "./parse";
import { toImapSearch } from "./query";
import { heloName, toSmtpError } from "./smtp";

describe("message ids", () => {
  it("round-trips folder, UIDVALIDITY, and UID", () => {
    const ref = { path: "보낸메일함/2026.11", uidValidity: "1699999999", uid: 42 };
    const id = encodeMessageId(ref);
    expect(id).toMatch(/^[A-Za-z0-9_-]+\.\d+\.\d+$/);
    expect(decodeMessageId(id)).toEqual(ref);
  });

  it("rejects anything that is not an id", () => {
    for (const id of ["", "INBOX", "a.b.c", "SU5CT1g.1.0", "18c2f0a1b2c3d4e5", "SU5CT1g.1.2.3"]) {
      expect(() => decodeMessageId(id), id).toThrow(InvalidRequestError);
    }
  });
});

describe("toImapSearch", () => {
  const epoch = (year: number, month: number, day: number) =>
    Math.floor(new Date(year, month - 1, day).getTime() / 1000);

  it("matches everything when there is no query", () => {
    expect(toImapSearch(undefined)).toEqual({ all: true });
    expect(toImapSearch("   ")).toEqual({ all: true });
  });

  it("translates the list filters", () => {
    expect(toImapSearch(`is:unread after:${epoch(2026, 11, 3)}`)).toEqual({
      seen: false,
      // The local calendar day, whatever the time zone.
      since: new Date(Date.UTC(2026, 10, 3)),
    });
  });

  it("translates a sender search and free text", () => {
    expect(toImapSearch("from:kim@example.com")).toEqual({ from: "kim@example.com" });
    expect(toImapSearch("회의 일정")).toEqual({ text: "회의 일정" });
    expect(toImapSearch('subject:"주간 보고" 첨부')).toEqual({
      subject: "주간 보고",
      text: "첨부",
    });
  });

  it("translates the contact search (an OR group of quoted addresses)", () => {
    expect(toImapSearch('{from:"a@x.com" to:"a@x.com" cc:"a@x.com" bcc:"a@x.com"}')).toEqual({
      or: [{ from: "a@x.com" }, { to: "a@x.com" }, { cc: "a@x.com" }, { bcc: "a@x.com" }],
    });
  });

  it("keeps filters outside a grouped search", () => {
    expect(toImapSearch("(from:a@x.com) is:unread")).toEqual({ from: "a@x.com", seen: false });
    expect(toImapSearch('({from:"a@x.com" to:"a@x.com"}) is:unread')).toEqual({
      or: [{ from: "a@x.com" }, { to: "a@x.com" }],
      seen: false,
    });
  });

  it("negates, and drops operators IMAP cannot express", () => {
    expect(toImapSearch("-from:spam@x.com")).toEqual({ not: { from: "spam@x.com" } });
    expect(toImapSearch("has:attachment in:anywhere label:work")).toEqual({ all: true });
    expect(toImapSearch("-from:a@x.com -from:b@x.com")).toEqual({
      not: { or: [{ from: "a@x.com" }, { from: "b@x.com" }] },
    });
  });

  it("survives unbalanced brackets and quotes", () => {
    expect(toImapSearch('(from:a@x.com "열린 따옴표')).toEqual({
      from: "a@x.com",
      text: "열린 따옴표",
    });
    expect(toImapSearch(") } hello")).toEqual({ text: "hello" });
  });
});

describe("folders", () => {
  const folder = (path: string, extra: Partial<Folder> = {}): Folder => ({
    path,
    name: path.split("/").pop() ?? path,
    delimiter: "/",
    flags: new Set(),
    ...extra,
  });

  it("maps special-use folders and leaves the rest as labels", () => {
    const map = mapFolders([
      folder("INBOX"),
      folder("Sent Messages", { specialUse: "\\Sent" }),
      folder("Drafts", { specialUse: "\\Drafts" }),
      folder("Deleted Messages", { specialUse: "\\Trash" }),
      folder("Junk", { specialUse: "\\Junk" }),
      folder("업무/프로젝트"),
      folder("업무", { flags: new Set(["\\Noselect"]) }),
    ]);
    expect(map.system).toEqual({
      INBOX: "INBOX",
      SENT: "Sent Messages",
      DRAFT: "Drafts",
      TRASH: "Deleted Messages",
      SPAM: "Junk",
    });
    expect(map.labels).toEqual([{ id: "업무/프로젝트", name: "업무/프로젝트", type: "user" }]);
  });

  it("falls back to well-known names, Korean ones included", () => {
    const map = mapFolders([
      folder("INBOX"),
      folder("보낸메일함"),
      folder("임시보관함"),
      folder("휴지통"),
      folder("스팸메일함"),
      folder("내게쓴메일함"),
    ]);
    expect(map.system).toMatchObject({
      SENT: "보낸메일함",
      DRAFT: "임시보관함",
      TRASH: "휴지통",
      SPAM: "스팸메일함",
    });
    expect(map.labels.map((label) => label.id)).toEqual(["내게쓴메일함"]);
  });

  it("resolves label ids to folders", () => {
    const map = mapFolders([folder("INBOX"), folder("Trash"), folder("Work")]);
    expect(resolveLabel(map, "INBOX")).toEqual({ path: "INBOX" });
    expect(resolveLabel(map, "TRASH")).toEqual({ path: "Trash" });
    expect(resolveLabel(map, "STARRED")).toEqual({ path: "INBOX", flagged: true });
    expect(resolveLabel(map, "Work")).toEqual({ path: "Work" });
    expect(() => resolveLabel(map, "IMPORTANT")).toThrow(InvalidRequestError);
    expect(() => resolveLabel(map, "SENT")).toThrow(InvalidRequestError);
  });
});

describe("snippets", () => {
  it("picks plain text over HTML and skips attachments", () => {
    const structure = {
      type: "multipart/mixed",
      childNodes: [
        {
          type: "multipart/alternative",
          childNodes: [
            { part: "1.1", type: "text/html", encoding: "base64", parameters: { charset: "utf-8" } },
            { part: "1.2", type: "text/plain", encoding: "quoted-printable", parameters: { charset: "euc-kr" } },
          ],
        },
        { part: "2", type: "text/plain", disposition: "attachment" },
      ],
    };
    expect(findTextPart(structure)).toEqual({
      part: "1.2",
      encoding: "quoted-printable",
      charset: "euc-kr",
      html: false,
    });
    expect(findTextPart({ type: "text/html", encoding: "7bit" })).toMatchObject({
      part: "1",
      html: true,
    });
    expect(findTextPart({ type: "image/png", part: "1" })).toBeNull();
  });

  it("decodes base64 UTF-8 that was cut mid-character", () => {
    const full = Buffer.from("안녕하세요. 회의 자료 보내드립니다.", "utf8").toString("base64");
    const snippet = decodeSnippet(Buffer.from(full.slice(0, 30)), {
      encoding: "base64",
      charset: "utf-8",
      html: false,
    });
    // 28 usable characters are 21 bytes: seven whole characters and a third of one.
    expect(snippet).toBe("안녕하세요. 회");
    expect(snippet).not.toContain("�");
  });

  it("decodes quoted-printable EUC-KR", () => {
    // "안녕" in EUC-KR is BE C8 B3 E7.
    const snippet = decodeSnippet(Buffer.from("=BE=C8=B3=E7 hello=\r\n world"), {
      encoding: "quoted-printable",
      charset: "euc-kr",
      html: false,
    });
    expect(snippet).toBe("안녕 hello world");
  });

  it("reduces HTML to text, even when cut off", () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body><p>Tom &amp; Jerry</p><script>x()</script><a href=";
    expect(decodeSnippet(Buffer.from(html), { encoding: "7bit", charset: "utf-8", html: true })).toBe(
      "Tom & Jerry",
    );
  });

  it("falls back to UTF-8 for an unknown charset", () => {
    expect(
      decodeSnippet(Buffer.from("plain"), { encoding: "", charset: "x-no-such", html: false }),
    ).toBe("plain");
  });
});

describe("messages", () => {
  it("summarises a fetched message", () => {
    const summary = toThreadSummary(
      {
        seq: 1,
        uid: 7,
        flags: new Set(["\\Flagged"]),
        internalDate: new Date("2026-11-10T01:02:03Z"),
        envelope: { subject: "안내", from: [{ name: "홍길동", address: "Hong@Example.com" }] },
      },
      "id-7",
      "미리보기",
    );
    expect(summary).toEqual({
      id: "id-7",
      subject: "안내",
      from: "홍길동",
      fromAddress: "hong@example.com",
      snippet: "미리보기",
      date: Date.parse("2026-11-10T01:02:03Z"),
      unread: true,
      messageCount: 1,
      hasAttachment: false,
    });
  });

  it("reads back what the MIME builder writes", async () => {
    const raw = buildMimeMessage({
      from: '"홍길동" <me@naver.com>',
      to: ["you@example.com"],
      cc: ["cc@example.com"],
      bcc: ["hidden@example.com"],
      subject: "한글 제목입니다",
      text: "본문",
      html: "<p>본문</p>",
      inReplyTo: "<a@x>",
      references: "<a@x> <b@x>",
      date: new Date("2026-11-10T03:04:05Z"),
      messageId: "<new@naver.com>",
      attachments: [{ filename: "보고서.txt", mimeType: "text/plain", data: Buffer.from("첨부") }],
    });
    const parsed = await simpleParser(raw);
    const message = toMailMessage(parsed, {
      id: "id-1",
      unread: false,
      isDraft: true,
      date: undefined,
    });
    expect(message).toMatchObject({
      id: "id-1",
      messageIdHeader: "<new@naver.com>",
      to: "you@example.com",
      cc: "cc@example.com",
      subject: "한글 제목입니다",
      references: "<a@x> <b@x>",
      date: Date.parse("2026-11-10T03:04:05Z"),
      isDraft: true,
      unread: false,
    });
    expect(message.from).toContain("me@naver.com");
    expect(message.from).toContain("홍길동");
    expect(message.html).toContain("본문");
    expect(message.text?.trim()).toBe("본문");
    expect(listedAttachments(parsed)).toEqual([
      { attachmentId: "0", filename: "보고서.txt", mimeType: "text/plain", size: 6 },
    ]);
    expect(parsed.attachments[0].content.toString("utf8")).toBe("첨부");
    // Drafts keep Bcc so the recipients can be restored.
    expect(parsed.bcc).toBeDefined();
  });

  it("decodes EUC-KR mail", async () => {
    const raw = Buffer.concat([
      Buffer.from(
        "From: a@x.com\r\nSubject: =?EUC-KR?B?vsiz5w==?=\r\nContent-Type: text/plain; charset=EUC-KR\r\n\r\n",
      ),
      Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]),
    ]);
    const message = toMailMessage(await simpleParser(raw), {
      id: "id",
      unread: true,
      isDraft: false,
      date: undefined,
    });
    expect(message.subject).toBe("안녕");
    expect(message.text?.trim()).toBe("안녕");
  });
});

describe("outgoing SMTP message", () => {
  it("has Date and Message-ID, and no Bcc header when bcc is left out", () => {
    const raw = buildMimeMessage({
      from: "me@naver.com",
      to: ["you@example.com"],
      bcc: undefined,
      subject: "hi",
      text: "body",
      date: new Date("2026-11-10T03:04:05Z"),
      messageId: "<id@naver.com>",
    });
    // Written in the computer's time zone, e.g. `12:04:05 +0900` in Korea.
    const date = /^Date: (.+)\r$/m.exec(raw)?.[1];
    expect(date).toMatch(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
    expect(new Date(date ?? "").toISOString()).toBe("2026-11-10T03:04:05.000Z");
    expect(raw).toContain("Message-ID: <id@naver.com>\r\n");
    expect(raw).not.toMatch(/^Bcc:/im);
  });
});

describe("server errors", () => {
  it("maps IMAP failures", () => {
    const code = (error: unknown) => (toImapError(error) as MailServerError).code;
    expect(code({ authenticationFailed: true, message: "Invalid credentials" })).toBe("auth_failed");
    expect(code({ code: "ENOTFOUND" })).toBe("connection_failed");
    expect(code({ code: "CONNECT_TIMEOUT" })).toBe("connection_failed");
    expect(code({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("connection_failed");
    expect(code(new Error("NO [TRYCREATE] folder"))).toBe("server_error");
    const invalid = new InvalidRequestError("x");
    expect(toImapError(invalid)).toBe(invalid);
  });

  it("maps SMTP failures", () => {
    const code = (error: unknown) => (toSmtpError(error) as MailServerError).code;
    expect(code({ code: "EAUTH" })).toBe("smtp_auth_failed");
    expect(code({ code: "ESOCKET" })).toBe("smtp_connection_failed");
    expect(code({ code: "EENVELOPE", message: "No recipients" })).toBe("server_error");
  });
});

describe("heloName", () => {
  it("greets with the sender's domain, never a loopback address", () => {
    expect(heloName("staff@company.co.kr")).toBe("company.co.kr");
    expect(heloName("Me@Example.COM")).toBe("example.com");
    // Nothing usable: nodemailer's own choice is left in place.
    expect(heloName("me@localhost")).toBeUndefined();
    expect(heloName("not an address")).toBeUndefined();
  });
});

describe("attachment flag", () => {
  it("reads it from an IMAP body structure", () => {
    const signatureOnly = {
      type: "multipart/mixed",
      childNodes: [
        {
          type: "multipart/related",
          childNodes: [
            { type: "text/html" },
            { type: "image/png", id: "<logo@x>", disposition: "inline", dispositionParameters: { filename: "logo.png" }, size: 5_000 },
          ],
        },
        { type: "text/vcard", disposition: "attachment", dispositionParameters: { filename: "card.vcf" } },
        { type: "application/pkcs7-signature", parameters: { name: "smime.p7s" } },
      ],
    };
    expect(structureHasAttachment(signatureOnly)).toBe(false);
    expect(
      structureHasAttachment({
        type: "multipart/mixed",
        childNodes: [
          { type: "text/plain" },
          // The name may come from Content-Type alone.
          { type: "application/vnd.ms-excel", parameters: { name: "매출.xls" }, size: 40_000 },
        ],
      }),
    ).toBe(true);
    expect(structureHasAttachment({ type: "text/plain" })).toBe(false);
    expect(structureHasAttachment(undefined)).toBe(false);
  });

  it("reads it from a downloaded message", async () => {
    const base = { from: "me@x.com", to: ["you@x.com"], subject: "s", text: "body" };
    const file = (filename: string, mimeType: string) => ({ filename, mimeType, data: Buffer.from("content") });
    expect(await simpleParser(buildMimeMessage(base)).then(parsedHasAttachment)).toBe(false);
    expect(
      await simpleParser(buildMimeMessage({ ...base, attachments: [file("명함.vcf", "text/vcard")] })).then(parsedHasAttachment),
    ).toBe(false);
    expect(
      await simpleParser(
        buildMimeMessage({ ...base, attachments: [file("명함.vcf", "text/vcard"), file("견적서.pdf", "application/pdf")] }),
      ).then(parsedHasAttachment),
    ).toBe(true);
  });
});
