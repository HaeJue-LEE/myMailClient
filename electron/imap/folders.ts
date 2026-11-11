import type { MailLabel } from "@/features/mail/types";
import { InvalidRequestError } from "../errors";

/** The part of an IMAP LIST entry that folder mapping reads. */
export type Folder = {
  path: string;
  name: string;
  delimiter: string;
  flags: Set<string>;
  specialUse?: string;
};

/** The renderer's (Gmail's) label ids that stand for a server folder. */
const SYSTEM_FOLDERS = {
  SENT: {
    flag: "\\Sent",
    names: ["sent", "sent messages", "sent items", "sent mail", "보낸메일함", "보낸편지함"],
  },
  DRAFT: {
    flag: "\\Drafts",
    names: ["drafts", "draft", "임시보관함"],
  },
  SPAM: {
    flag: "\\Junk",
    names: ["junk", "spam", "junk e-mail", "junk email", "bulk mail", "스팸메일함", "스팸편지함"],
  },
  TRASH: {
    flag: "\\Trash",
    names: ["trash", "deleted messages", "deleted items", "휴지통", "지운메일함", "지운편지함"],
  },
} as const;

type SystemId = "INBOX" | keyof typeof SYSTEM_FOLDERS;

export type FolderMap = {
  /** Folder path of each system label the server has. */
  system: Partial<Record<SystemId, string>>;
  /** Every other selectable folder, offered as a user label (its path is the id). */
  labels: MailLabel[];
};

const selectable = (folder: Folder) =>
  !folder.flags.has("\\Noselect") && !folder.flags.has("\\NonExistent");

/**
 * Sorts a server's folders into the fixed labels the app shows (by the
 * special-use flag, else by well-known names) and user labels.
 */
export function mapFolders(folders: Folder[]): FolderMap {
  const usable = folders.filter(selectable);
  const system: FolderMap["system"] = {};
  const inbox = usable.find(
    (folder) => folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX",
  );
  if (inbox) system.INBOX = inbox.path;

  const taken = new Set(inbox ? [inbox.path] : []);
  for (const [id, { flag, names }] of Object.entries(SYSTEM_FOLDERS)) {
    const free = usable.filter((folder) => !taken.has(folder.path));
    const found =
      free.find((folder) => folder.specialUse === flag) ??
      free.find((folder) => (names as readonly string[]).includes(folder.name.toLowerCase()));
    if (!found) continue;
    system[id as SystemId] = found.path;
    taken.add(found.path);
  }

  const labels = usable
    .filter((folder) => !taken.has(folder.path))
    .map((folder): MailLabel => ({
      id: folder.path,
      name: folder.delimiter
        ? folder.path.split(folder.delimiter).join("/")
        : folder.path,
      type: "user",
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return { system, labels };
}

/**
 * The folder a label id stands for. `STARRED` has no folder of its own: it is
 * the flagged mail of the inbox.
 */
export function resolveLabel(
  map: FolderMap,
  labelId: string,
): { path: string; flagged?: boolean } {
  if (labelId === "STARRED" && map.system.INBOX) {
    return { path: map.system.INBOX, flagged: true };
  }
  const system = map.system[labelId as SystemId];
  if (system) return { path: system };
  if (map.labels.some((label) => label.id === labelId)) return { path: labelId };
  throw new InvalidRequestError("This account has no such folder");
}
