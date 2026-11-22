import type { AccountKind } from "@/features/mail/mail-accounts";

/**
 * Carrying the accounts to another computer: a settings file made on one
 * (Windows or Mac) is opened on the other with the passphrase chosen when it
 * was made. Shared by the screens and the main process.
 */

/** The settings file's extension, without the dot. */
export const SETTINGS_EXTENSION = "mcsettings";
export const MIN_PASSPHRASE_LENGTH = 10;
export const MAX_PASSPHRASE_LENGTH = 1024;

/**
 * A passphrase's length as both systems count it: macOS may hand Korean over
 * decomposed (more characters), so the length is taken composed (NFC), as the
 * file's key is made. Only a new passphrase is held to the minimum; opening a
 * file takes whatever it was made with.
 */
export const passphraseLength = (passphrase: string) => passphrase.normalize("NFC").length;

/** Where a sign-in made with a client stands on this computer. */
export type ClientMatch =
  /** The file carries no client of this kind. */
  | "none"
  /** This computer has none: the file's is put in. */
  | "install"
  /** The same client is here already. */
  | "same"
  /** Another client is here: the file's sign-ins work only if it is replaced. */
  | "differs";

export type ImportItem = {
  /** The account's id in the file; how choices name it. */
  key: string;
  kind: AccountKind;
  email: string;
  name: string;
  /** The account is here already (same address, or the same Zoho account). */
  exists: boolean;
  /** An IMAP/POP3 account whose password the file lacks: entered again here. */
  missingPassword: boolean;
};

export type ImportPreview = {
  /** Names the opened file in the following calls. */
  token: string;
  /** When the file was made, as an ISO date. */
  exportedAt: string;
  /** The system it was made on (`win32`, `darwin`, …), for the user's information. */
  fromPlatform: string;
  items: ImportItem[];
  google: ClientMatch;
  zoho: ClientMatch;
  /** Accounts signed in with this computer's own client, signed out if it is replaced. */
  googleAccountsHere: number;
  zohoAccountsHere: number;
  /** Accounts in the file that could not be read and are left out. */
  unreadable: number;
};

export type ImportChoices = {
  /** Keys of accounts already here that the file's copy replaces; the others are left as they are. */
  overwrite: string[];
  /** Put the file's Google client in place of this computer's (`google: "differs"`). */
  replaceGoogleClient: boolean;
  replaceZohoClient: boolean;
};

export type ImportOutcome =
  | "added"
  | "replaced"
  /** Already here, and left as it was. */
  | "skipped"
  /** Its sign-in was made with another client than this computer's: sign in again here. */
  | "sign_in_again"
  /** Added, but its password must be entered again (edit the account). */
  | "needs_password"
  | "failed";

export type ImportResult = {
  items: { key: string; kind: AccountKind; email: string; outcome: ImportOutcome }[];
  /** How many accounts were added or replaced. */
  imported: number;
};

/** What the user sees for the system a file was made on. */
export function platformLabel(platform: string) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  return platform || "알 수 없는 시스템";
}

/** What one account will become, given the choices (the main process decides the same way). */
export function importOutcome(
  item: ImportItem,
  preview: Pick<ImportPreview, "google" | "zoho">,
  choices: ImportChoices,
): Exclude<ImportOutcome, "failed"> {
  const match = item.kind === "gmail" ? preview.google : item.kind === "zoho" ? preview.zoho : null;
  const replacing =
    (item.kind === "gmail" && choices.replaceGoogleClient) ||
    (item.kind === "zoho" && choices.replaceZohoClient);
  if (match === "differs" && !replacing) return "sign_in_again";
  // Replacing a client signs this computer's accounts of that kind out: nothing is left to keep.
  // A copy without a password never replaces one here: it would only lose the stored password.
  if (item.exists && !replacing && (item.missingPassword || !choices.overwrite.includes(item.key))) {
    return "skipped";
  }
  if (item.missingPassword) return "needs_password";
  return item.exists && !replacing ? "replaced" : "added";
}
