import type { AccountKind } from "@/features/mail/mail-accounts";
import {
  type ClientMatch,
  type ImportChoices,
  type ImportItem,
  type ImportOutcome,
  type ImportPreview,
  importOutcome,
} from "@/features/mail/settings-transfer";
import type {
  PortableGoogleAccount,
  PortableMailAccount,
  PortableZohoAccount,
  SettingsPayload,
} from "./payload";

/**
 * How the accounts of a settings file join those on this computer. Decided
 * here without touching anything, so the preview and the import agree and
 * both can be tested; apply.ts carries the plan out.
 *
 * - An IMAP/POP3 or Google account is the same one when its address is; a
 *   Zoho account when its Zoho account id is (its app id carries it).
 * - One already here is left alone unless the user chose to replace it,
 *   which keeps its id here, and so its place, its picture and anything else
 *   tied to the id.
 * - A refresh token works only with the client it was issued to. A Google
 *   or Zoho account comes along when this computer has no client of that
 *   kind (the file's is put in), the same one, or the user chose to replace
 *   this computer's (its own sign-ins of that kind go).
 */

export type TargetState = {
  mailAccounts: { id: string; email: string }[];
  googleAccounts: { id: string; email: string }[];
  zohoAccounts: { id: string }[];
  googleClientId: string | null;
  zohoClientId: string | null;
  order: string[];
  activeId: string | null;
};

export type PlanDeps = {
  /** A fresh id for an IMAP/POP3 account whose id is taken here. */
  newId: () => string;
  /** The id a Google address gets when signed in here for the first time (google-accounts.ts). */
  googleIdFor: (email: string) => string;
};

type ClientAction = "keep" | "install" | "replace";

export type ImportPlan = {
  googleClient: ClientAction;
  zohoClient: ClientAction;
  mail: { account: PortableMailAccount; targetId: string; key: string; outcome: ImportOutcome }[];
  google: { account: PortableGoogleAccount; targetId: string; key: string; outcome: ImportOutcome }[];
  zoho: { account: PortableZohoAccount; targetId: string; key: string; outcome: ImportOutcome }[];
  /** Accounts left out, with why. */
  left: { key: string; kind: AccountKind; email: string; outcome: ImportOutcome }[];
  /** Pictures to keep, by the account's id here (base64 PNG). */
  avatars: { targetId: string; png: string }[];
  /** The new order of accounts; null leaves it as it is. */
  order: string[] | null;
  /** The account to use; undefined leaves the choice as it is. */
  activeId: string | null | undefined;
};

const lower = (email: string) => email.toLowerCase();

function clientMatch(fileClientId: string | null, hereClientId: string | null): ClientMatch {
  if (!fileClientId) return "none";
  if (!hereClientId) return "install";
  return fileClientId === hereClientId ? "same" : "differs";
}

function clientAction(match: ClientMatch, replace: boolean): ClientAction {
  if (match === "install") return "install";
  if (match === "differs" && replace) return "replace";
  return "keep";
}

/** What the user is shown before importing, with the file's accounts in its order. */
export function previewImport(
  payload: SettingsPayload,
  target: TargetState,
): Omit<ImportPreview, "token" | "unreadable"> {
  const hereMail = new Set(target.mailAccounts.map((account) => lower(account.email)));
  const hereGoogle = new Set(target.googleAccounts.map((account) => lower(account.email)));
  const hereZoho = new Set(target.zohoAccounts.map((account) => account.id));
  const items: ImportItem[] = [
    ...payload.google.accounts.map((account) => ({
      key: account.id,
      kind: "gmail" as const,
      email: account.email,
      name: "",
      exists: hereGoogle.has(lower(account.email)),
      missingPassword: false,
    })),
    ...payload.mail.accounts.map((account) => ({
      key: account.id,
      kind: account.protocol,
      email: account.email,
      name: account.name,
      exists: hereMail.has(lower(account.email)),
      missingPassword: account.password === null,
    })),
    ...payload.zoho.accounts.map((account) => ({
      key: account.id,
      kind: "zoho" as const,
      email: account.email,
      name: account.name,
      exists: hereZoho.has(account.id),
      missingPassword: false,
    })),
  ];
  const rank = new Map(payload.order.map((id, index) => [id, index]));
  items.sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
  return {
    exportedAt: payload.exportedAt,
    fromPlatform: payload.platform,
    items,
    google: clientMatch(payload.google.client?.clientId ?? null, target.googleClientId),
    zoho: clientMatch(payload.zoho.client?.clientId ?? null, target.zohoClientId),
    googleAccountsHere: target.googleAccounts.length,
    zohoAccountsHere: target.zohoAccounts.length,
  };
}

export function planImport(
  payload: SettingsPayload,
  target: TargetState,
  choices: ImportChoices,
  deps: PlanDeps,
): ImportPlan {
  const preview = previewImport(payload, target);
  const googleClient = clientAction(preview.google, choices.replaceGoogleClient);
  const zohoClient = clientAction(preview.zoho, choices.replaceZohoClient);
  const outcomes = new Map(
    preview.items.map((item) => [item.key, importOutcome(item, preview, choices)]),
  );
  const outcomeOf = (key: string) => outcomes.get(key) ?? "skipped";
  const isImported = (outcome: ImportOutcome) =>
    outcome === "added" || outcome === "replaced" || outcome === "needs_password";

  const plan: ImportPlan = {
    googleClient,
    zohoClient,
    mail: [],
    google: [],
    zoho: [],
    left: [],
    avatars: [],
    order: null,
    activeId: undefined,
  };
  /** Ids in use here once the import is done, so a new id cannot take one. */
  const taken = new Set([
    ...target.mailAccounts.map((account) => account.id),
    ...(googleClient === "replace" ? [] : target.googleAccounts.map((account) => account.id)),
    ...(zohoClient === "replace" ? [] : target.zohoAccounts.map((account) => account.id)),
  ]);
  const idMap = new Map<string, string>();

  for (const account of payload.google.accounts) {
    const outcome = outcomeOf(account.id);
    if (!isImported(outcome)) {
      plan.left.push({ key: account.id, kind: "gmail", email: account.email, outcome });
      continue;
    }
    const here =
      googleClient === "replace"
        ? undefined
        : target.googleAccounts.find((item) => lower(item.email) === lower(account.email));
    const targetId = here?.id ?? deps.googleIdFor(account.email);
    taken.add(targetId);
    idMap.set(account.id, targetId);
    plan.google.push({ account, targetId, key: account.id, outcome });
  }

  for (const account of payload.zoho.accounts) {
    const outcome = outcomeOf(account.id);
    if (!isImported(outcome)) {
      plan.left.push({ key: account.id, kind: "zoho", email: account.email, outcome });
      continue;
    }
    taken.add(account.id);
    idMap.set(account.id, account.id);
    plan.zoho.push({ account, targetId: account.id, key: account.id, outcome });
  }

  for (const account of payload.mail.accounts) {
    const outcome = outcomeOf(account.id);
    if (!isImported(outcome)) {
      plan.left.push({ key: account.id, kind: account.protocol, email: account.email, outcome });
      continue;
    }
    const here = target.mailAccounts.find((item) => lower(item.email) === lower(account.email));
    let targetId = here?.id ?? account.id;
    if (!here && taken.has(targetId)) targetId = deps.newId();
    taken.add(targetId);
    idMap.set(account.id, targetId);
    plan.mail.push({ account, targetId, key: account.id, outcome });
  }

  for (const [sourceId, targetId] of idMap) {
    const png = payload.avatars[sourceId];
    if (png) plan.avatars.push({ targetId, png });
  }

  const hadAccounts =
    target.mailAccounts.length + target.googleAccounts.length + target.zohoAccounts.length > 0;
  const mapped = (ids: string[]) =>
    ids.flatMap((id) => {
      const targetId = idMap.get(id);
      return targetId ? [targetId] : [];
    });
  if (!hadAccounts) {
    // Nothing here yet (a first start): as it was on the other computer.
    if (payload.order.length > 0) plan.order = mapped(payload.order);
    plan.activeId = payload.activeId ? (idMap.get(payload.activeId) ?? null) : null;
  } else if (target.order.length > 0) {
    // The user ordered the accounts here: the new ones go after them, in the file's order.
    const known = new Set(target.order);
    const added = mapped([...payload.order, ...idMap.keys()]).filter((id) => !known.has(id));
    plan.order = [...target.order, ...new Set(added)];
  }
  return plan;
}
