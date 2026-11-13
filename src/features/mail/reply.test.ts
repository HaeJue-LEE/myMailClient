import { describe, expect, it } from "vitest";
import { normalizeLink, pastedLinkHtml } from "@/features/mail/components/rich-editor";
import {
  parseAddressList,
  startReply,
  subjectFor,
  textToHtml,
} from "@/features/mail/reply";
import type { MailMessage } from "@/features/mail/types";

const message = (overrides: Partial<MailMessage>): MailMessage => ({
  id: "m1",
  messageIdHeader: "<m1@mail.x.com>",
  from: "김영희 <younghee@x.com>",
  to: "G.D.HONG <alias@example.org>",
  cc: "",
  replyTo: "",
  references: "",
  subject: "회의 자료",
  date: Date.UTC(2026, 10, 10, 6, 0),
  html: null,
  text: "안녕하세요\n자료 보내드립니다",
  attachments: [],
  unread: false,
  isDraft: false,
  ...overrides,
});

const ME = ["me@gmail.com", "alias@example.org"];
const identity = (html: string) => html;

describe("parseAddressList", () => {
  it("splits on commas outside quotes and brackets", () => {
    expect(
      parseAddressList('"Doe, John" <J@x.com>, b@y.com; 김영희 <k@z.com>, ,bad'),
    ).toEqual([
      { name: "Doe, John", email: "j@x.com" },
      { name: "", email: "b@y.com" },
      { name: "김영희", email: "k@z.com" },
    ]);
  });
});

describe("subjectFor", () => {
  it.each([
    ["reply", "회의", "Re: 회의"],
    ["reply", "RE: 회의", "RE: 회의"],
    ["replyAll", "회신: 회의", "회신: 회의"],
    ["forward", "회의", "Fwd: 회의"],
    ["forward", "FW: 회의", "FW: 회의"],
    ["forward", "Re: 회의", "Fwd: Re: 회의"],
  ] as const)("%s %s -> %s", (mode, subject, expected) => {
    expect(subjectFor(mode, subject)).toBe(expected);
  });
});

describe("startReply", () => {
  it("replies to the sender, from the alias the mail reached, threaded", () => {
    const reply = startReply(
      message({ references: "<m0@mail.x.com>" }),
      "t1",
      "reply",
      ME,
      identity,
    );
    expect(reply.to).toBe("김영희 <younghee@x.com>, ");
    expect(reply.cc).toBe("");
    expect(reply.subject).toBe("Re: 회의 자료");
    expect(reply.from).toBe("alias@example.org");
    expect(reply.threadId).toBe("t1");
    expect(reply.inReplyTo).toBe("<m1@mail.x.com>");
    expect(reply.references).toBe("<m0@mail.x.com> <m1@mail.x.com>");
    expect(reply.quoteHtml).toContain("<blockquote");
    expect(reply.quoteHtml).toContain("안녕하세요<br>자료 보내드립니다");
    expect(reply.quoteHtml).toContain("김영희 &lt;younghee@x.com&gt;님이 작성:");
  });

  it("prefers Reply-To", () => {
    const reply = startReply(
      message({ replyTo: "list@x.com" }),
      "t1",
      "reply",
      ME,
      identity,
    );
    expect(reply.to).toBe("list@x.com, ");
  });

  it("reply-all adds everyone except any of my addresses, without duplicates", () => {
    const reply = startReply(
      message({
        to: "alias@example.org, a@x.com, younghee@x.com",
        cc: "me@gmail.com, b@x.com, a@x.com",
      }),
      "t1",
      "replyAll",
      ME,
      identity,
    );
    expect(reply.to).toBe("김영희 <younghee@x.com>, a@x.com, ");
    expect(reply.cc).toBe("b@x.com, ");
  });

  it("replying to my own message goes to its recipients", () => {
    const reply = startReply(
      message({ from: "G.D.HONG <alias@example.org>", to: "k@x.com" }),
      "t1",
      "reply",
      ME,
      identity,
    );
    expect(reply.to).toBe("k@x.com, ");
    expect(reply.from).toBe("alias@example.org");
  });

  it("forwards with a header block and the original attachments, unthreaded", () => {
    const reply = startReply(
      message({
        html: "<p>본문</p>",
        attachments: [
          { attachmentId: "a1", filename: "견적.pdf", mimeType: "application/pdf", size: 1234 },
        ],
      }),
      "t1",
      "forward",
      ME,
      (html) => `[safe]${html}`,
    );
    expect(reply.to).toBe("");
    expect(reply.subject).toBe("Fwd: 회의 자료");
    expect(reply.threadId).toBeUndefined();
    expect(reply.quoteHtml).toContain("---------- 전달된 메일 ----------");
    expect(reply.quoteHtml).toContain("[safe]<p>본문</p>");
    expect(reply.attachments).toEqual([
      {
        kind: "gmail",
        messageId: "m1",
        attachmentId: "a1",
        filename: "견적.pdf",
        mimeType: "application/pdf",
        size: 1234,
      },
    ]);
  });

  it("passes the original HTML through the sanitizer and escapes header text", () => {
    const reply = startReply(
      message({ html: "<img onerror=x>", from: "<b>evil</b> <e@x.com>" }),
      "t1",
      "reply",
      ME,
      () => "CLEAN",
    );
    expect(reply.quoteHtml).toContain("CLEAN");
    expect(reply.quoteHtml).not.toContain("<img");
    expect(reply.quoteHtml).not.toContain("<b>evil");
  });
});

describe("textToHtml and normalizeLink", () => {
  it("escapes text and keeps line breaks", () => {
    expect(textToHtml('a<b>&"\nc')).toBe("a&lt;b&gt;&amp;&quot;<br>c");
  });

  it.each([
    ["example.com", "https://example.com"],
    ["https://a.com/x", "https://a.com/x"],
    ["kim@x.com", "mailto:kim@x.com"],
    ["javascript:alert(1)", null],
    ["file:///c:/x", null],
    ["  ", null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeLink(input)).toBe(expected);
  });
});

describe("pastedLinkHtml", () => {
  it("pastes an address copied from the address bar as itself, not the page title", () => {
    expect(pastedLinkHtml(" https://example.com/a?b=1&c=2\r\n")).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>',
    );
  });

  it("leaves other text to the HTML or plain-text paste", () => {
    expect(pastedLinkHtml("see https://example.com")).toBeNull();
    expect(pastedLinkHtml("example.com")).toBeNull();
    expect(pastedLinkHtml("javascript:alert(1)")).toBeNull();
    expect(pastedLinkHtml('https://example.com/"><img src=x onerror=alert(1)>')).toBeNull();
    expect(pastedLinkHtml("")).toBeNull();
  });
});
