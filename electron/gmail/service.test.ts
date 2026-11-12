import { beforeEach, describe, expect, it, vi } from "vitest";

/** Units charged per call, in order. */
const charged: number[] = [];
vi.mock("./pacer", async (original) => {
  const actual = await original<typeof import("./pacer")>();
  return {
    ...actual,
    paced: async <T>(units: number, request: () => Promise<T>) => {
      charged.push(units);
      return request();
    },
  };
});
const { clearSummaryCache, listThreads } = await import("./service");

type Part = { mimeType: string; filename?: string; headers?: { name: string; value: string }[]; parts?: Part[] };
const file = (mimeType: string, filename: string): Part => ({
  mimeType,
  filename,
  headers: [{ name: "Content-Disposition", value: "attachment" }],
});
const mixed = (...files: Part[]): Part => ({ mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain" }, ...files] });

/**
 * A mailbox of 20 threads, newest first. Gmail's `has:attachment` matches
 * t1 (pdf), t2 (card only), t3 (pdf + card) and t4 (pdf in an older
 * message); the card search matches t2 and t3.
 */
function fakeGmail() {
  const ids = Array.from({ length: 20 }, (_, i) => `t${i + 1}`);
  const history = new Map(ids.map((id) => [id, "100"]));
  const parts: Record<string, Part[]> = {
    t1: [mixed(file("application/pdf", "a.pdf"))],
    t2: [mixed(file("text/vcard", "card.vcf"))],
    t3: [mixed(file("application/pdf", "q.pdf"), file("text/vcard", "card.vcf"))],
    t4: [mixed(file("application/pdf", "old.pdf")), { mimeType: "text/plain" }],
  };
  const queries: string[] = [];
  const gets: { id: string; format: string }[] = [];
  const gmail = {
    users: {
      threads: {
        list: async (params: { q?: string }) => {
          queries.push(params.q ?? "");
          const q = params.q ?? "";
          const match = q.includes("filename:(")
            ? ["t2", "t3"]
            : q.includes("has:attachment")
              ? ["t1", "t2", "t3", "t4"]
              : ids;
          return {
            data: {
              threads: match.map((id) => ({ id, historyId: history.get(id) })),
              nextPageToken: q.includes("has:attachment") ? undefined : "next",
            },
          };
        },
        get: async (params: { id: string; format: string }) => {
          gets.push({ id: params.id, format: params.format });
          const index = ids.indexOf(params.id);
          return {
            data: {
              id: params.id,
              messages: (parts[params.id] ?? [{ mimeType: "text/plain" }]).map((payload, n) => ({
                id: `${params.id}-${n}`,
                internalDate: String(Date.UTC(2026, 10, 12) - index * 60_000 - n),
                labelIds: ["INBOX"],
                snippet: "",
                payload: { ...payload, headers: [{ name: "Subject", value: `subject ${params.id}` }, { name: "From", value: "a@x.com" }] },
              })),
            },
          };
        },
      },
    },
  };
  return { gmail: gmail as never, history, queries, gets };
}

const sum = (units: number[]) => units.reduce((total, unit) => total + unit, 0);

beforeEach(() => {
  charged.length = 0;
  clearSummaryCache();
});

describe("listThreads quota cost", () => {
  it("costs a list, header fetches, two searches, and full fetches only for the unsure", async () => {
    const fake = fakeGmail();
    const page = await listThreads(fake.gmail, { labelId: "INBOX" });
    // 10 + 20 × 40 + 10 + 10 + 2 × 120 (t2, t3 are unsure)
    expect(sum(charged)).toBe(10 + 800 + 20 + 240);
    expect(fake.gets.filter((get) => get.format === "full").map((get) => get.id).sort()).toEqual(["t2", "t3"]);
    expect(fake.gets.filter((get) => get.format === "metadata")).toHaveLength(20);

    const flags = Object.fromEntries(page.threads.map((t) => [t.id, t.hasAttachment]));
    expect(flags).toMatchObject({ t1: true, t2: false, t3: true, t4: true, t5: false, t20: false });
  });

  it("refreshing an unchanged page costs only the list call", async () => {
    const fake = fakeGmail();
    const first = await listThreads(fake.gmail, { labelId: "INBOX" });
    charged.length = 0;
    const again = await listThreads(fake.gmail, { labelId: "INBOX" });
    expect(charged).toEqual([10]);
    expect(again.threads).toEqual(first.threads);
  });

  it("fetches again only the threads that changed", async () => {
    const fake = fakeGmail();
    await listThreads(fake.gmail, { labelId: "INBOX" });
    charged.length = 0;
    fake.history.set("t7", "101");
    await listThreads(fake.gmail, { labelId: "INBOX" });
    // list, t7's headers, one has:attachment search (t7 has none, so no card search)
    expect(charged).toEqual([10, 40, 10]);
  });

  it("searches all mail up to the page's newest thread, not just the label or search", async () => {
    const fake = fakeGmail();
    await listThreads(fake.gmail, { labelId: "INBOX", query: "from:a@x.com OR from:b@x.com" });
    const searches = fake.queries.filter((q) => q.includes("has:attachment"));
    // An inbox thread whose file is in a message the user sent (Sent only)
    // would be missed if the search were limited to the inbox.
    expect(searches[0]).toMatch(/^has:attachment before:\d+$/);
    expect(searches[1]).toMatch(/^has:attachment filename:\(vcf OR vcard OR p7s OR asc OR sig\) before:\d+$/);
  });
});
