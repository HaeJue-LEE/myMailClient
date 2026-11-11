import { describe, expect, it } from "vitest";
import { contactMailQuery } from "@/features/mail/search";
import {
  baseList,
  contactMailHref,
  isIsoDate,
  MAX_SEARCH_LENGTH,
  listHref,
  listLabel,
  parseMailList,
  threadHref,
  toIsoDate,
  popupComposeHref,
  popupThreadHref,
} from "@/features/mail/routes";

const parse = (query: string) => parseMailList(new URLSearchParams(query));

describe("parseMailList", () => {
  it("defaults to the inbox", () => {
    expect(parse("")).toEqual({ label: "INBOX" });
  });

  it("reads the label", () => {
    expect(parse("label=SENT")).toEqual({ label: "SENT" });
  });

  it("prefers a search over the label and trims it", () => {
    expect(parse("label=SENT&q=%20from%3Aboss%20")).toEqual({
      search: "from:boss",
    });
  });

  it("treats a blank search as no search", () => {
    expect(parse("q=%20%20&label=TRASH")).toEqual({ label: "TRASH" });
  });
});

describe("since", () => {
  it("reads a valid date for labels and searches", () => {
    expect(parse("label=SENT&since=2026-11-01")).toEqual({
      label: "SENT",
      since: "2026-11-01",
    });
    expect(parse("q=insta&since=2026-11-01")).toEqual({
      search: "insta",
      since: "2026-11-01",
    });
  });

  it.each(["2026-02-30", "2026-13-01", "20261101", "1969-12-31", "x"])(
    "ignores %s",
    (since) => expect(parse(`since=${since}`)).toEqual({ label: "INBOX" }),
  );

  it("keeps the date through list and thread links", () => {
    const list = { search: "insta", since: "2026-11-01" };
    expect(parse(listHref(list).split("?")[1])).toEqual(list);
    const params = new URLSearchParams(threadHref(list, "t1").split("?")[1]);
    expect(params.get("since")).toBe("2026-11-01");
  });

  it("strips the filters", () => {
    expect(
      baseList({ label: "INBOX", since: "2026-11-01", unread: true }),
    ).toEqual({ label: "INBOX" });
  });

  it("formats local dates", () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(isIsoDate("2024-02-29")).toBe(true);
  });
});

describe("contact mail search", () => {
  it("links to a captioned search that survives the round trip", () => {
    const href = contactMailHref("김영희", ["kim@x.com"]);
    const list = parse(href.split("?")[1]);
    expect(list).toEqual({
      search: contactMailQuery(["kim@x.com"]),
      caption: "김영희님과 주고받은 메일",
    });
    // Opening a result and coming back keeps the caption.
    const thread = new URLSearchParams(threadHref(list, "t1").split("?")[1]);
    expect(thread.get("caption")).toBe("김영희님과 주고받은 메일");
  });

  it("ignores a caption without a search", () => {
    expect(parse("label=INBOX&caption=x")).toEqual({ label: "INBOX" });
  });

  it("fits a long address within the search length limit", () => {
    const bounce =
      "1axco6ydwzvmbk8gzctiifhgz1bwvwca5uff71-me=gmail.com@bf05x.hubspotemail.net";
    expect(contactMailQuery([bounce, `b${bounce}`]).length).toBeLessThan(
      MAX_SEARCH_LENGTH,
    );
  });
});

describe("unread", () => {
  it("reads only unread=1", () => {
    expect(parse("label=INBOX&unread=1")).toEqual({
      label: "INBOX",
      unread: true,
    });
    expect(parse("label=INBOX&unread=true")).toEqual({ label: "INBOX" });
  });

  it("keeps every filter through list and thread links", () => {
    const list = { label: "SENT", since: "2026-11-01", unread: true };
    expect(parse(listHref(list).split("?")[1])).toEqual(list);
    const params = new URLSearchParams(threadHref(list, "t1").split("?")[1]);
    expect(params.get("unread")).toBe("1");
    expect(params.get("since")).toBe("2026-11-01");
  });
});

describe("hrefs", () => {
  it("round-trips a search with special characters", () => {
    const list = { search: "subject:\"a & b\" 회의" };
    expect(parse(listHref(list).split("?")[1])).toEqual(list);
  });

  it("keeps the search when opening a thread", () => {
    const params = new URLSearchParams(
      threadHref({ search: "invoice" }, "t1").split("?")[1],
    );
    expect(params.get("q")).toBe("invoice");
    expect(params.get("thread")).toBe("t1");
    expect(params.has("label")).toBe(false);
  });

  it("scopes label actions only for labels", () => {
    expect(listLabel({ label: "INBOX" })).toBe("INBOX");
    expect(listLabel({ search: "x" })).toBeNull();
  });
});

describe("popupThreadHref", () => {
  it("names the thread, the account, and the folder it came from", () => {
    const params = new URLSearchParams(popupThreadHref("m.abc", "acct-1", "TRASH").split("?")[1]);
    expect(Object.fromEntries(params)).toEqual({ thread: "m.abc", account: "acct-1", label: "TRASH" });
    expect(popupThreadHref("t1", "gmail")).toBe("/popup?thread=t1&account=gmail");
  });
});

describe("popupComposeHref", () => {
  it("keeps the compose query and adds the account", () => {
    const href = popupComposeHref("?mode=reply&thread=t1&message=m1", "acct-1");
    expect(href.startsWith("/popup/compose?")).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(href.split("?")[1]))).toEqual({
      mode: "reply",
      thread: "t1",
      message: "m1",
      account: "acct-1",
    });
    // The account named in the query is replaced, never doubled.
    expect(popupComposeHref("?account=other", "acct-1")).toBe("/popup/compose?account=acct-1");
    expect(popupComposeHref("", "gmail")).toBe("/popup/compose?account=gmail");
  });
});
