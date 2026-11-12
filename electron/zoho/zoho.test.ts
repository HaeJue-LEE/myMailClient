import { describe, expect, it } from "vitest";
import { mailApiBase, regionOf } from "@/features/mail/zoho";
import { toMs } from "./auth";
import { parseZohoJson, zohoId } from "./json";
import {
  decodeZohoId,
  encodeZohoId,
  mapZohoFolders,
  resolveZohoLabel,
  toZohoSummary,
  withoutQuote,
  type ZohoFolder,
} from "./parse";
import { toZohoSearch } from "./query";

describe("Zoho JSON", () => {
  it("keeps ids past Number.MAX_SAFE_INTEGER exact", () => {
    const parsed = parseZohoJson(
      '{"data":[{"folderId":900001000000002014,"count":3,"size":1.5,"name":"9007199254740993"}]}',
    ) as { data: Record<string, unknown>[] };
    expect(parsed.data[0]).toEqual({
      folderId: "900001000000002014",
      count: 3,
      size: 1.5,
      name: "9007199254740993",
    });
  });

  it("writes ids back as bare numbers", () => {
    expect(JSON.stringify({ messageId: [zohoId("900001000000002014")] })).toBe(
      '{"messageId":[900001000000002014]}',
    );
    expect(() => zohoId("12; drop")).toThrow();
  });
});

describe("Zoho regions", () => {
  it("finds the Mail API next to the accounts server", () => {
    expect(mailApiBase("https://accounts.zoho.com")).toBe("https://mail.zoho.com/api");
    expect(mailApiBase("https://accounts.zohocloud.ca")).toBe("https://mail.zohocloud.ca/api");
    expect(regionOf("https://accounts.zoho.eu/")).toBe("eu");
    expect(() => mailApiBase("https://example.com")).toThrow();
  });
});

describe("Zoho message ids", () => {
  it("round-trips folder and message", () => {
    const id = encodeZohoId("900001000000002014", "1709887058769100001");
    expect(decodeZohoId(id)).toEqual({
      folderId: "900001000000002014",
      messageId: "1709887058769100001",
    });
    expect(() => decodeZohoId("INBOX:1")).toThrow();
    expect(() => decodeZohoId("../1:2")).toThrow();
  });
});

const folder = (folderId: string, folderName: string, folderType: string, path = `/${folderName}`): ZohoFolder => ({
  folderId,
  folderName,
  folderType,
  path,
});

describe("mapZohoFolders", () => {
  const map = mapZohoFolders([
    folder("1", "Newsletter", "Inbox"),
    folder("2", "Inbox", "Inbox"),
    folder("3", "Drafts", "Drafts"),
    folder("4", "Templates", "Templates"),
    folder("5", "Sent", "Sent"),
    folder("6", "Spam", "Spam"),
    folder("7", "Trash", "Trash"),
    folder("8", "Outbox", "Outbox"),
    folder("9", "Archive", "Archive"),
    folder("10", "Work", "Inbox", "/Projects/Work"),
  ]);

  it("finds the system folders by type, the inbox by its path", () => {
    expect(map.system.INBOX?.folderId).toBe("2");
    expect(map.system.DRAFT?.folderId).toBe("3");
    expect(map.system.SENT?.folderId).toBe("5");
    expect(map.system.SPAM?.folderId).toBe("6");
    expect(map.system.TRASH?.folderId).toBe("7");
  });

  it("offers the other folders as labels, without templates and outbox", () => {
    expect(map.labels.map((label) => [label.id, label.name])).toEqual([
      ["9", "Archive"],
      ["1", "Newsletter"],
      ["10", "Projects/Work"],
    ]);
    expect(resolveZohoLabel(map, "SENT").folderId).toBe("5");
    expect(resolveZohoLabel(map, "10").folderId).toBe("10");
    expect(() => resolveZohoLabel(map, "4")).toThrow();
  });
});

describe("toZohoSummary", () => {
  it("reads a listed message", () => {
    expect(
      toZohoSummary({
        messageId: "1709887058769100001",
        folderId: "900001000000002014",
        subject: "Re: &quot;Hello&quot;",
        sender: "Hong Gildong",
        fromAddress: "hong@example.com",
        summary: "reply   test",
        receivedTime: "1709887053409",
        status: "0",
        flagid: "flag_not_set",
        hasAttachment: "1",
      }),
    ).toEqual({
      id: "900001000000002014:1709887058769100001",
      subject: 'Re: "Hello"',
      from: "Hong Gildong",
      fromAddress: "hong@example.com",
      snippet: "reply test",
      date: 1709887053409,
      unread: true,
      messageCount: 1,
      hasAttachment: true,
    });
  });

  it("falls back to the address and a placeholder subject", () => {
    const summary = toZohoSummary({
      messageId: 1,
      folderId: 2,
      fromAddress: "&lt;Kim@Example.com&gt;",
      status: "1",
      hasAttachment: "0",
    });
    expect(summary.from).toBe("kim@example.com");
    expect(summary.subject).toBe("(제목 없음)");
    expect(summary.unread).toBe(false);
    expect(summary.hasAttachment).toBe(false);
  });
});

describe("toZohoSearch", () => {
  it("leaves label filters to the list call", () => {
    const since = Math.floor(new Date(2026, 10, 1).getTime() / 1000);
    expect(toZohoSearch(`is:unread after:${since}`)).toEqual({
      searchKey: null,
      seen: false,
      since: new Date(2026, 10, 1).getTime(),
    });
    expect(toZohoSearch(undefined)).toEqual({ searchKey: null });
  });

  it("writes fields in Zoho's syntax", () => {
    expect(toZohoSearch('from:hong@example.com subject:"weekly report"').searchKey).toBe(
      'sender:hong@example.com::subject:"weekly report"',
    );
    expect(toZohoSearch("invoice").searchKey).toBe("entire:invoice");
  });

  it("keeps a date range and read state alongside a search", () => {
    const result = toZohoSearch("(invoice) is:unread after:2026/11/01");
    expect(result.searchKey).toBe("entire:invoice::fromDate:01-Nov-2026");
    expect(result.seen).toBe(false);
  });

  it("writes a contact's OR group, dropping what Zoho cannot search", () => {
    expect(
      toZohoSearch('{from:"a@example.com" to:"a@example.com" cc:"a@example.com" bcc:"a@example.com"}')
        .searchKey,
    ).toBe("sender:a@example.com:or:to:a@example.com:or:cc:a@example.com");
  });
});

describe("withoutQuote", () => {
  it("drops the app's quote block, nested divs included", () => {
    expect(
      withoutQuote(
        '<div dir="ltr"><p>Thanks</p><div data-mc-quote=""><div>On Monday</div><blockquote><div>old</div></blockquote></div><p>PS</p></div>',
      ),
    ).toBe('<div dir="ltr"><p>Thanks</p><p>PS</p></div>');
  });

  it("leaves a message without one alone", () => {
    expect(withoutQuote("<p>hi</p>")).toBe("<p>hi</p>");
  });
});

describe("toMs", () => {
  it("reads Zoho's device-flow durations in either unit", () => {
    // As Zoho sent them: milliseconds.
    expect(toMs(5000)).toBe(5000);
    expect(toMs(300000)).toBe(300000);
    // Seconds, as other OAuth servers send them.
    expect(toMs(5)).toBe(5000);
    expect(toMs("300")).toBe(300000);
    expect(toMs(undefined)).toBeNull();
    expect(toMs(0)).toBeNull();
  });
});

describe("stripQuoteMark", () => {
  it("takes the app's quote marker off before mail leaves", async () => {
    const { stripQuoteMark } = await import("../compose");
    expect(stripQuoteMark('<div data-mc-quote=""><p>old</p></div><div data-mc-quote>x</div>')).toBe(
      "<div><p>old</p></div><div>x</div>",
    );
    expect(stripQuoteMark('<p title="data-mc-quote">kept</p>')).toBe('<p title="data-mc-quote">kept</p>');
  });
});
