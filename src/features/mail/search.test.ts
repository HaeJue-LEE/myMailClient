import { describe, expect, it } from "vitest";
import {
  afterQuery,
  contactMailQuery,
  MAX_CONTACT_SEARCH_ADDRESSES,
  isGmailQuery,
  matchesFilter,
  senderQuery,
  suggestSenders,
  threadListRequest,
} from "@/features/mail/search";
import type { ThreadSummary } from "@/features/mail/types";

const thread = (overrides: Partial<ThreadSummary>): ThreadSummary => ({
  id: "t",
  subject: "",
  from: "",
  fromAddress: "",
  snippet: "",
  date: null,
  unread: false,
  messageCount: 1,
  hasAttachment: false,
  ...overrides,
});

const instagram = thread({
  id: "t1",
  from: "Instagram",
  fromAddress: "follow-suggestions@mail.instagram.com",
  subject: "새 팔로워",
  date: 300,
});

describe("contactMailQuery", () => {
  it("finds mail from or to any of the addresses", () => {
    expect(contactMailQuery(["Kim@x.com", "kim@x.com", "k2@y.com"])).toBe(
      '{from:"kim@x.com" to:"kim@x.com" cc:"kim@x.com" bcc:"kim@x.com" ' +
        'from:"k2@y.com" to:"k2@y.com" cc:"k2@y.com" bcc:"k2@y.com"}',
    );
  });

  it("quotes addresses with characters Gmail would read as operators", () => {
    const bounce = "x-me=gmail.com@bf05x.hubspotemail.net";
    expect(contactMailQuery([bounce])).toContain(`from:"${bounce}"`);
    expect(contactMailQuery(['a"b@x.com'])).toContain('from:"ab@x.com"');
  });

  it("caps the number of addresses so the query stays bounded", () => {
    const many = Array.from({ length: 30 }, (_, i) => `p${i}@x.com`);
    expect(contactMailQuery(many).match(/from:/g)).toHaveLength(
      MAX_CONTACT_SEARCH_ADDRESSES,
    );
  });
});

describe("threadListRequest", () => {
  const after = `after:${new Date(2026, 10, 1).getTime() / 1000}`;

  it("uses local midnight as an epoch-seconds boundary", () => {
    expect(afterQuery("2026-11-01")).toBe(after);
  });

  it("lists a label, with the date as a query when set", () => {
    expect(threadListRequest({ label: "INBOX" })).toEqual({
      labelId: "INBOX",
      query: undefined,
    });
    expect(threadListRequest({ label: "INBOX", since: "2026-11-01" })).toEqual({
      labelId: "INBOX",
      query: after,
    });
  });

  it("adds is:unread for labels and searches", () => {
    expect(threadListRequest({ label: "INBOX", unread: true })).toEqual({
      labelId: "INBOX",
      query: "is:unread",
    });
    expect(
      threadListRequest({ label: "INBOX", unread: true, since: "2026-11-01" }),
    ).toEqual({ labelId: "INBOX", query: `is:unread ${after}` });
    expect(threadListRequest({ search: "a OR b", unread: true })).toEqual({
      query: "(a OR b) is:unread",
    });
  });

  it("groups a search so OR cannot bypass the date", () => {
    expect(threadListRequest({ search: "a OR b" })).toEqual({ query: "a OR b" });
    expect(
      threadListRequest({ search: "a OR b", since: "2026-11-01" }),
    ).toEqual({ query: `(a OR b) ${after}` });
  });
});

describe("isGmailQuery", () => {
  it.each(["from:insta", "is:unread", "a -label:x", "subject:(회의)"])(
    "%s uses operators",
    (text) => expect(isGmailQuery(text)).toBe(true),
  );
  it.each(["insta", "회의 10:30", "http"])("%s is plain text", (text) =>
    expect(isGmailQuery(text)).toBe(false),
  );
});

describe("matchesFilter", () => {
  it("matches a partial word, ignoring case", () => {
    expect(matchesFilter(instagram, "INSTA")).toBe(true);
  });

  it("matches the address, subject, and snippet", () => {
    expect(matchesFilter(instagram, "suggestions@")).toBe(true);
    expect(matchesFilter(instagram, "팔로")).toBe(true);
    expect(matchesFilter(thread({ snippet: "invoice 42" }), "voice")).toBe(true);
  });

  it("rejects non-matching threads and accepts an empty filter", () => {
    expect(matchesFilter(instagram, "facebook")).toBe(false);
    expect(matchesFilter(instagram, "  ")).toBe(true);
  });
});

describe("suggestSenders", () => {
  const older = thread({
    id: "t0",
    from: "Insta (old name)",
    fromAddress: instagram.fromAddress,
    date: 100,
  });
  const other = thread({
    id: "t2",
    from: "Instacart",
    fromAddress: "orders@instacart.com",
    date: 200,
  });
  const unrelated = thread({ id: "t3", from: "Bank", fromAddress: "a@bank.com" });

  it("returns distinct matching senders with their latest name, newest first", () => {
    expect(suggestSenders([older, other, instagram, unrelated], "insta")).toEqual([
      { name: "Instagram", address: instagram.fromAddress },
      { name: "Instacart", address: "orders@instacart.com" },
    ]);
  });

  it("matches on the address too and honours the limit", () => {
    expect(suggestSenders([other, instagram], "mail.insta", 1)).toEqual([
      { name: "Instagram", address: instagram.fromAddress },
    ]);
  });

  it("suggests nothing for empty text or Gmail operators", () => {
    expect(suggestSenders([instagram], " ")).toEqual([]);
    expect(suggestSenders([instagram], "from:insta")).toEqual([]);
  });

  it("builds a sender search", () => {
    expect(senderQuery("a@b.com")).toBe("from:a@b.com");
  });
});
