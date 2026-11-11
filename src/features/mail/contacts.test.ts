import { describe, expect, it } from "vitest";
import { parseAddresses } from "@/features/mail/addresses";
import {
  applyContactEdits,
  completedRecipientText,
  emptyContactEdits,
  forgetPerson,
  pruneContactEdits,
  currentRecipientText,
  formatRecipient,
  matchContacts,
  mergeContacts,
  recentContacts,
  replaceCurrentRecipient,
} from "@/features/mail/contacts";
import type { Contact, ThreadSummary } from "@/features/mail/types";

const contact = (
  name: string,
  email: string,
  source: Contact["source"] = "google",
  accounts: string[] = ["me@gmail.com"],
): Contact => ({ name, email, source, accounts });

describe("mergeContacts", () => {
  it("keeps one entry per address, preferring saved contacts and any name", () => {
    expect(
      mergeContacts([
        contact("", "Hong@Example.com", "recent"),
        contact("홍길동", "hong@example.com", "google"),
        contact("Kim", "kim@example.com", "other"),
        contact("", "kim@example.com", "google"),
      ]),
    ).toEqual([
      contact("홍길동", "hong@example.com", "google"),
      contact("Kim", "kim@example.com", "google"),
    ]);
  });

  it("lists every account an address came from", () => {
    expect(
      mergeContacts([
        contact("홍길동", "hong@x.com", "google", ["me@gmail.com"]),
        contact("", "Hong@x.com", "recent", ["me@naver.com"]),
        contact("", "hong@x.com", "recent", ["me@gmail.com"]),
      ]),
    ).toEqual([contact("홍길동", "hong@x.com", "google", ["me@gmail.com", "me@naver.com"])]);
  });

  it("sorts Korean names first, then others, unnamed ones by address", () => {
    const sorted = mergeContacts([
      contact("나", "b@x.com"),
      contact("", "z@x.com"),
      contact("Bob", "a@x.com"),
      contact("가", "c@x.com"),
    ]);
    expect(sorted.map((c) => c.name || c.email)).toEqual([
      "가",
      "나",
      "Bob",
      "z@x.com",
    ]);
  });
});

describe("contact edits overlay", () => {
  const saved = (name: string, email: string, resourceName: string): Contact => ({
    name,
    email,
    source: "google",
    accounts: ["me@gmail.com"],
    resourceName,
  });
  const fetched = [
    saved("홍길동", "hong@x.com", "people/c1"),
    saved("홍길동", "hong2@x.com", "people/c1"),
    saved("김영희", "kim@x.com", "people/c2"),
    contact("Other", "other@x.com", "other"),
  ];

  it("keeps the saved contact's resourceName when merging duplicates", () => {
    expect(
      mergeContacts([contact("", "kim@x.com", "other"), fetched[2]]),
    ).toEqual([fetched[2]]);
  });

  it("applies adds, edits, and deletes, and is idempotent", () => {
    const edits = emptyContactEdits();
    edits.created.set("new@x.com", saved("새사람", "new@x.com", "people/c9"));
    edits.replaced.set("people/c1", [saved("홍길순", "hong@x.com", "people/c1")]);
    edits.removed.add("people/c2");

    const once = applyContactEdits(fetched, edits);
    expect(once.map((c) => `${c.name}:${c.email}`)).toEqual([
      "새사람:new@x.com",
      "홍길순:hong@x.com",
      "Other:other@x.com",
    ]);
    expect(applyContactEdits(once, edits)).toEqual(once);
  });

  it("forgets pending changes once Google's list shows them", () => {
    const edits = emptyContactEdits();
    edits.created.set("kim@x.com", fetched[2]);
    edits.created.set("late@x.com", saved("", "late@x.com", "people/c8"));
    edits.replaced.set("people/c1", [fetched[0], fetched[1]]);
    edits.removed.add("people/c2");
    edits.removed.add("people/c7");

    pruneContactEdits(fetched, edits);

    expect([...edits.created.keys()]).toEqual(["late@x.com"]);
    expect([...edits.replaced.keys()]).toEqual([]);
    // c2 still listed: its deletion has not reached the list yet.
    expect([...edits.removed]).toEqual(["people/c2"]);
  });

  it("lets a later change to a person supersede earlier ones", () => {
    const edits = emptyContactEdits();
    edits.created.set("new@x.com", saved("새사람", "new@x.com", "people/c9"));
    edits.replaced.set("people/c9", []);
    forgetPerson(edits, "people/c9");
    expect(edits.created.size + edits.replaced.size + edits.removed.size).toBe(0);
  });
});

describe("recentContacts", () => {
  it("turns loaded senders into contacts, dropping names that are just the address", () => {
    const threads = [
      { from: "Instagram", fromAddress: "a@instagram.com" },
      { from: "b@x.com", fromAddress: "b@x.com" },
      { from: "", fromAddress: "" },
    ] as ThreadSummary[];
    expect(recentContacts(threads, "me@naver.com")).toEqual([
      contact("Instagram", "a@instagram.com", "recent", ["me@naver.com"]),
      contact("", "b@x.com", "recent", ["me@naver.com"]),
    ]);
  });
});

describe("matchContacts", () => {
  const all = mergeContacts([
    contact("김철수", "chulsoo@work.com", "other"),
    contact("Instagram", "a@mail.instagram.com", "recent"),
    contact("박지민", "jimin.kim@x.com", "google"),
    contact("김영희", "younghee@x.com", "google"),
  ]);

  it("matches name or address anywhere, prefix matches first", () => {
    expect(matchContacts(all, "김").map((c) => c.name)).toEqual([
      "김영희",
      "김철수",
    ]);
    // "jimin.kim@" matches in the middle, so it comes after the prefix match.
    expect(
      matchContacts(
        [...all, contact("Kim Lee", "lee@x.com", "recent")],
        "kim",
      ).map((c) => c.name),
    ).toEqual(["Kim Lee", "박지민"]);
    expect(matchContacts(all, "INSTA").map((c) => c.name)).toEqual(["Instagram"]);
  });

  it("skips excluded addresses and honours the limit", () => {
    expect(
      matchContacts(all, "김", { exclude: ["YOUNGHEE@x.com"], limit: 1 }),
    ).toEqual([contact("김철수", "chulsoo@work.com", "other")]);
  });

  it("returns nothing for blank text", () => {
    expect(matchContacts(all, "  ")).toEqual([]);
  });
});

describe("recipient field editing", () => {
  it("finds the entry being typed", () => {
    expect(currentRecipientText("a@x.com, 김")).toBe("김");
    expect(currentRecipientText("a@x.com; b")).toBe("b");
    expect(currentRecipientText("김")).toBe("김");
    expect(completedRecipientText("a@x.com, 김")).toBe("a@x.com,");
  });

  it("replaces the entry being typed and starts the next one", () => {
    expect(replaceCurrentRecipient("김", "김영희 <y@x.com>")).toBe(
      "김영희 <y@x.com>, ",
    );
    expect(replaceCurrentRecipient("a@x.com, 김", "김영희 <y@x.com>")).toBe(
      "a@x.com, 김영희 <y@x.com>, ",
    );
    expect(replaceCurrentRecipient("a@x.com,김", "y@x.com")).toBe(
      "a@x.com, y@x.com, ",
    );
  });

  it("formats names so the field still parses", () => {
    const formatted = formatRecipient({ name: 'Doe, "John" <J>', email: "j@x.com" });
    expect(formatted).toBe("Doe John J <j@x.com>");
    expect(parseAddresses(`${formatted}, `).valid).toEqual(["j@x.com"]);
    expect(formatRecipient({ name: "", email: "j@x.com" })).toBe("j@x.com");
  });
});
