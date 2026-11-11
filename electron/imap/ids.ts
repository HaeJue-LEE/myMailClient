import { InvalidRequestError } from "../errors";

/**
 * One IMAP message. The renderer only ever hands back an id, so the id carries
 * everything needed to find the message again: its folder, the folder's
 * UIDVALIDITY (UIDs mean nothing once that changes), and the UID.
 */
export type MessageRef = { path: string; uidValidity: string; uid: number };

export function encodeMessageId({ path, uidValidity, uid }: MessageRef) {
  return `${Buffer.from(path, "utf8").toString("base64url")}.${uidValidity}.${uid}`;
}

export function decodeMessageId(id: string): MessageRef {
  const match = /^([A-Za-z0-9_-]+)\.(\d{1,20})\.(\d{1,10})$/.exec(id);
  const path = match ? Buffer.from(match[1], "base64url").toString("utf8") : "";
  const uid = match ? Number(match[3]) : 0;
  if (!match || !path || uid < 1) throw new InvalidRequestError("Not a message id");
  return { path, uidValidity: match[2], uid };
}
