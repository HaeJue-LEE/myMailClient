import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PRESETS,
  defaultPort,
  isHostname,
  isPort,
  mailAccountInputSchema,
  presetFor,
  sortAccounts,
} from "@/features/mail/mail-accounts";

describe("defaultPort", () => {
  it("gives the standard port for each protocol and security", () => {
    expect(defaultPort("imap", "ssl")).toBe(993);
    expect(defaultPort("imap", "starttls")).toBe(143);
    expect(defaultPort("smtp", "ssl")).toBe(465);
    expect(defaultPort("smtp", "starttls")).toBe(587);
    expect(defaultPort("smtp", "none")).toBe(25);
  });
});

describe("isHostname", () => {
  it("accepts DNS names and IPv4 addresses", () => {
    for (const host of ["imap.example.com", "mail", "192.168.0.10", " IMAP.Example.com "]) {
      expect(isHostname(host), host).toBe(true);
    }
  });

  it("rejects URLs, ports, spaces, and empty values", () => {
    for (const host of ["", "  ", "imap://example.com", "example.com:993", "exa mple.com", "-bad.com", "a..b"]) {
      expect(isHostname(host), host).toBe(false);
    }
  });
});

describe("isPort", () => {
  it("accepts 1 to 65535 only", () => {
    expect(isPort(1)).toBe(true);
    expect(isPort(65535)).toBe(true);
    expect(isPort(0)).toBe(false);
    expect(isPort(65536)).toBe(false);
    expect(isPort(993.5)).toBe(false);
    expect(isPort(Number.NaN)).toBe(false);
  });
});

describe("mailAccountInputSchema", () => {
  const valid = {
    name: " 홍길동 ",
    email: "me@naver.com",
    username: " me@naver.com ",
    incoming: { host: " IMAP.Naver.com ", port: 993, security: "ssl" },
    outgoing: { host: "smtp.naver.com", port: 465, security: "ssl" },
    saveSentCopy: false,
  };

  it("normalises hosts, names, and user names", () => {
    const parsed = mailAccountInputSchema.parse(valid);
    expect(parsed.incoming.host).toBe("imap.naver.com");
    expect(parsed.name).toBe("홍길동");
    expect(parsed.username).toBe("me@naver.com");
  });

  it("requires an address and a user name", () => {
    expect(mailAccountInputSchema.safeParse({ ...valid, email: "me" }).success).toBe(false);
    expect(mailAccountInputSchema.safeParse({ ...valid, username: " " }).success).toBe(false);
  });

  it("accepts every preset's servers", () => {
    // The custom presets start with empty servers for the user to fill in.
    for (const preset of ACCOUNT_PRESETS.filter((item) => !item.id.startsWith("custom"))) {
      const result = mailAccountInputSchema.safeParse({
        ...valid,
        protocol: preset.protocol,
        incoming: preset.incoming,
        outgoing: preset.outgoing,
      });
      expect(result.success, preset.id).toBe(true);
      expect(result.data?.protocol, preset.id).toBe(preset.protocol);
    }
  });

  it("treats input without a protocol as IMAP", () => {
    const withoutProtocol: Record<string, unknown> = { ...valid };
    delete withoutProtocol.protocol;
    expect(mailAccountInputSchema.parse(withoutProtocol).protocol).toBe("imap");
  });
});

describe("presetFor", () => {
  const endpoint = (host: string) => ({ host, port: 995, security: "ssl" as const });

  it("finds the provider of a stored account by its incoming server", () => {
    expect(presetFor({ protocol: "pop3", incoming: endpoint("pop3s.hiworks.com") })?.id).toBe("hiworks");
    expect(presetFor({ protocol: "imap", incoming: endpoint("IMAP.naver.com") })?.id).toBe("naver");
    expect(presetFor({ protocol: "imap", incoming: endpoint("imap.gmail.com") })?.id).toBe("gmail-imap");
  });

  it("falls back to the custom preset of the account's protocol", () => {
    expect(presetFor({ protocol: "pop3", incoming: endpoint("pop.example.com") })?.id).toBe("custom-pop3");
    expect(presetFor({ protocol: "imap", incoming: endpoint("imap.example.com") })?.id).toBe("custom");
  });
});

describe("account order", () => {
  const accounts = ["gmail", "naver", "hiworks", "daou"].map((id) => ({ id }));
  const ids = (list: { id: string }[]) => list.map((account) => account.id);

  it("lists accounts in the chosen order", () => {
    expect(ids(sortAccounts(accounts, ["hiworks", "gmail", "daou", "naver"]))).toEqual([
      "hiworks",
      "gmail",
      "daou",
      "naver",
    ]);
  });

  it("keeps accounts outside the order after it, as they were", () => {
    // "daou" was added after the order was set; "gone" was removed since.
    expect(ids(sortAccounts(accounts, ["hiworks", "gone", "gmail"]))).toEqual([
      "hiworks",
      "gmail",
      "naver",
      "daou",
    ]);
    expect(ids(sortAccounts(accounts, []))).toEqual(["gmail", "naver", "hiworks", "daou"]);
  });

});
