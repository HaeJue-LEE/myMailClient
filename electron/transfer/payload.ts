import { z } from "zod";
import { mailAccountInputSchema, MAX_PASSWORD_LENGTH } from "@/features/mail/mail-accounts";
import { googleAccountSchema } from "../google-accounts";
import { googleClientSchema } from "../google-client";
import { zohoAccountSchema, zohoClientSchema } from "../zoho/store";

/**
 * What a settings file holds once opened (see bundle.ts). Read like any
 * other input from outside: an account that does not pass its checks is
 * left out (and counted), rather than losing the whole file.
 */

const accountId = z.string().min(1).max(64);

/** As the account form accepts it, with its id, and the password in the clear or null. */
export const portableMailAccountSchema = mailAccountInputSchema
  .omit({ id: true, password: true })
  .extend({
    id: accountId,
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH).nullable(),
  });

/** The stored picture (96 px PNG), base64; a little room over its real size. */
const avatarSchema = z.string().max(512 * 1024);

const sectionSchema = <T extends z.ZodTypeAny>(client: T) =>
  z.object({ client: client.nullable(), accounts: z.array(z.unknown()).max(500) });

const payloadSchema = z.object({
  exportedAt: z.string().max(64),
  appVersion: z.string().max(64),
  platform: z.string().max(32),
  mail: z.object({ accounts: z.array(z.unknown()).max(500) }),
  google: sectionSchema(googleClientSchema),
  zoho: sectionSchema(zohoClientSchema),
  /** Every account's id, in the order the user chose; empty when never reordered. */
  order: z.array(accountId).max(1500),
  activeId: accountId.nullable(),
  /** Account pictures by account id. */
  avatars: z.record(accountId, avatarSchema),
});

export type PortableMailAccount = z.infer<typeof portableMailAccountSchema>;
export type PortableGoogleAccount = z.infer<typeof googleAccountSchema>;
export type PortableZohoAccount = z.infer<typeof zohoAccountSchema>;

export type SettingsPayload = {
  exportedAt: string;
  appVersion: string;
  platform: string;
  mail: { accounts: PortableMailAccount[] };
  google: { client: z.infer<typeof googleClientSchema> | null; accounts: PortableGoogleAccount[] };
  zoho: { client: z.infer<typeof zohoClientSchema> | null; accounts: PortableZohoAccount[] };
  order: string[];
  activeId: string | null;
  avatars: Record<string, string>;
};

function readEach<T>(items: unknown[], schema: z.ZodType<T>) {
  const read: T[] = [];
  let unreadable = 0;
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) read.push(parsed.data);
    else unreadable += 1;
  }
  return { read, unreadable };
}

/** The settings of an opened file; null when it is not shaped like one at all. */
export function readPayload(raw: unknown): { payload: SettingsPayload; unreadable: number } | null {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { mail, google, zoho, ...rest } = parsed.data;
  const mailAccounts = readEach(mail.accounts, portableMailAccountSchema);
  const googleAccounts = readEach(google.accounts, googleAccountSchema);
  const zohoAccounts = readEach(zoho.accounts, zohoAccountSchema);
  return {
    payload: {
      ...rest,
      mail: { accounts: mailAccounts.read },
      google: { client: google.client, accounts: googleAccounts.read },
      zoho: { client: zoho.client, accounts: zohoAccounts.read },
    },
    unreadable: mailAccounts.unreadable + googleAccounts.unreadable + zohoAccounts.unreadable,
  };
}
