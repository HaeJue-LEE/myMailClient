import { describe, expect, it } from "vitest";
import {
  type ImportChoices,
  MIN_PASSPHRASE_LENGTH,
  passphraseLength,
} from "@/features/mail/settings-transfer";
import type { PortableMailAccount, SettingsPayload } from "./payload";
import { planImport, previewImport, type TargetState } from "./plan";

/** Made-up accounts and clients only. */
const GOOGLE_CLIENT = {
  clientId: "123456789012-abcdefgh12345678.apps.googleusercontent.com",
  clientSecret: "TEST-not-a-real-secret",
};
const OTHER_GOOGLE_ID = "210987654321-zyxwvuts87654321.apps.googleusercontent.com";
const ZOHO_CLIENT = { clientId: "1000.TESTCLIENTID", clientSecret: "TEST-zoho-secret", region: "us" as const };

const mailAccount = (id: string, email: string, password: string | null = "TEST-pw"): PortableMailAccount => ({
  id,
  name: "",
  email,
  username: email,
  protocol: "imap",
  password,
  incoming: { host: "imap.example.com", port: 993, security: "ssl" },
  outgoing: { host: "smtp.example.com", port: 465, security: "ssl" },
  saveSentCopy: true,
  sendCopyToSelf: false,
});

const payload = (change: Partial<SettingsPayload> = {}): SettingsPayload => ({
  exportedAt: "2026-11-15T00:00:00.000Z",
  appVersion: "0.1.9",
  platform: "darwin",
  mail: { accounts: [mailAccount("m1", "one@example.com"), mailAccount("m2", "two@example.com", null)] },
  google: {
    client: GOOGLE_CLIENT,
    accounts: [{ id: "gmail", email: "me@example.com", refreshToken: "TEST-google-token" }],
  },
  zoho: {
    client: ZOHO_CLIENT,
    accounts: [
      {
        id: "zoho-111",
        email: "z@example.com",
        name: "",
        zohoAccountId: "111",
        accountsServer: "https://accounts.zoho.com",
        refreshToken: "TEST-zoho-token",
      },
    ],
  },
  order: ["m2", "gmail", "m1", "zoho-111"],
  activeId: "m1",
  avatars: { gmail: "UE5HAA==", m1: "UE5HAQ==" },
  ...change,
});

const empty: TargetState = {
  mailAccounts: [],
  googleAccounts: [],
  zohoAccounts: [],
  googleClientId: null,
  zohoClientId: null,
  order: [],
  activeId: null,
};

const keepAll: ImportChoices = { overwrite: [], replaceGoogleClient: false, replaceZohoClient: false };
let counter = 0;
const deps = {
  newId: () => `new-${++counter}`,
  googleIdFor: (email: string) => `gmail-${email}`,
};

describe("importing settings", () => {
  it("brings everything to a computer with nothing set up yet, as it was", () => {
    const preview = previewImport(payload(), empty);
    expect(preview.google).toBe("install");
    expect(preview.zoho).toBe("install");
    expect(preview.items.map((item) => item.key)).toEqual(["m2", "gmail", "m1", "zoho-111"]);
    expect(preview.items.find((item) => item.key === "m2")?.missingPassword).toBe(true);

    const plan = planImport(payload(), empty, keepAll, deps);
    expect(plan.googleClient).toBe("install");
    expect(plan.zohoClient).toBe("install");
    expect(plan.mail.map((entry) => [entry.targetId, entry.outcome])).toEqual([
      ["m1", "added"],
      ["m2", "needs_password"],
    ]);
    // The old single Google account's id is "gmail"; here it gets the id a new address gets.
    expect(plan.google.map((entry) => entry.targetId)).toEqual(["gmail-me@example.com"]);
    expect(plan.zoho.map((entry) => entry.targetId)).toEqual(["zoho-111"]);
    expect(plan.order).toEqual(["m2", "gmail-me@example.com", "m1", "zoho-111"]);
    expect(plan.activeId).toBe("m1");
    expect(plan.avatars).toEqual(
      expect.arrayContaining([
        { targetId: "gmail-me@example.com", png: "UE5HAA==" },
        { targetId: "m1", png: "UE5HAQ==" },
      ]),
    );
    expect(plan.left).toEqual([]);
  });

  it("leaves accounts already here alone unless asked, keeping their ids when replaced", () => {
    const target: TargetState = {
      ...empty,
      mailAccounts: [{ id: "here-1", email: "ONE@example.com" }],
      googleAccounts: [{ id: "gmail-here", email: "me@example.com" }],
      googleClientId: GOOGLE_CLIENT.clientId,
      order: ["gmail-here", "here-1"],
      activeId: "here-1",
    };
    const kept = planImport(payload(), target, keepAll, deps);
    expect(kept.googleClient).toBe("keep");
    expect(kept.left.map((item) => [item.key, item.outcome])).toEqual(
      expect.arrayContaining([
        ["gmail", "skipped"],
        ["m1", "skipped"],
      ]),
    );
    // The choice of account here stays; new accounts go after the ones ordered here.
    expect(kept.activeId).toBeUndefined();
    expect(kept.order).toEqual(["gmail-here", "here-1", "m2", "zoho-111"]);

    const replaced = planImport(payload(), target, { ...keepAll, overwrite: ["m1", "gmail"] }, deps);
    expect(replaced.mail.find((entry) => entry.key === "m1")).toMatchObject({
      targetId: "here-1",
      outcome: "replaced",
    });
    expect(replaced.google).toMatchObject([{ targetId: "gmail-here", outcome: "replaced" }]);
    expect(replaced.order).toEqual(["gmail-here", "here-1", "m2", "zoho-111"]);
  });

  it("keeps sign-ins out when this computer has another client, unless it is replaced", () => {
    const target: TargetState = {
      ...empty,
      googleAccounts: [{ id: "gmail-other", email: "other@example.com" }],
      googleClientId: OTHER_GOOGLE_ID,
    };
    expect(previewImport(payload(), target)).toMatchObject({ google: "differs", googleAccountsHere: 1 });

    const kept = planImport(payload(), target, keepAll, deps);
    expect(kept.googleClient).toBe("keep");
    expect(kept.google).toEqual([]);
    expect(kept.left).toContainEqual({ key: "gmail", kind: "gmail", email: "me@example.com", outcome: "sign_in_again" });

    const replaced = planImport(payload(), target, { ...keepAll, replaceGoogleClient: true }, deps);
    expect(replaced.googleClient).toBe("replace");
    expect(replaced.google).toMatchObject([{ targetId: "gmail-me@example.com", outcome: "added" }]);
  });

  it("gives an IMAP account a new id when its id is taken here", () => {
    const target: TargetState = { ...empty, mailAccounts: [{ id: "m1", email: "else@example.com" }] };
    const plan = planImport(payload(), target, keepAll, deps);
    const entry = plan.mail.find((item) => item.key === "m1");
    expect(entry?.targetId).toMatch(/^new-/);
    expect(plan.avatars).toContainEqual({ targetId: entry?.targetId, png: "UE5HAQ==" });
  });

  it("leaves the order alone when it was never chosen here", () => {
    const target: TargetState = { ...empty, mailAccounts: [{ id: "here-1", email: "x@example.com" }] };
    expect(planImport(payload(), target, keepAll, deps).order).toBeNull();
  });

  it("brings the Google client even without Google accounts", () => {
    const plan = planImport(payload({ google: { client: GOOGLE_CLIENT, accounts: [] } }), empty, keepAll, deps);
    expect(plan.googleClient).toBe("install");
  });

  it("never replaces an account here with a copy that has no password", () => {
    const target: TargetState = { ...empty, mailAccounts: [{ id: "here-2", email: "two@example.com" }] };
    const plan = planImport(payload(), target, { ...keepAll, overwrite: ["m2"] }, deps);
    expect(plan.mail.some((entry) => entry.key === "m2")).toBe(false);
    expect(plan.left).toContainEqual({ key: "m2", kind: "imap", email: "two@example.com", outcome: "skipped" });
  });
});

describe("passphrase length", () => {
  it("is counted composed, as both systems make the key", () => {
    const composed = "테스트용암호열글자요".normalize("NFC");
    expect(composed.length).toBe(MIN_PASSPHRASE_LENGTH);
    // A Mac may hand the same text over decomposed: three times as many characters.
    expect(composed.normalize("NFD").length).toBeGreaterThan(MIN_PASSPHRASE_LENGTH);
    expect(passphraseLength(composed.normalize("NFD"))).toBe(MIN_PASSPHRASE_LENGTH);
  });
});
