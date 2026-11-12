/**
 * Zoho data centers: where an API client is created and accounts live. From
 * https://accounts.zoho.com/oauth/serverinfo. The Mail API of each is the
 * same host with `mail.` in place of `accounts.`.
 */
export const ZOHO_REGIONS = {
  us: { label: "미국 (zoho.com)", accounts: "https://accounts.zoho.com" },
  eu: { label: "유럽 (zoho.eu)", accounts: "https://accounts.zoho.eu" },
  in: { label: "인도 (zoho.in)", accounts: "https://accounts.zoho.in" },
  au: { label: "호주 (zoho.com.au)", accounts: "https://accounts.zoho.com.au" },
  jp: { label: "일본 (zoho.jp)", accounts: "https://accounts.zoho.jp" },
  ca: { label: "캐나다 (zohocloud.ca)", accounts: "https://accounts.zohocloud.ca" },
  sa: { label: "사우디아라비아 (zoho.sa)", accounts: "https://accounts.zoho.sa" },
  uk: { label: "영국 (zoho.uk)", accounts: "https://accounts.zoho.uk" },
  ae: { label: "아랍에미리트 (zoho.ae)", accounts: "https://accounts.zoho.ae" },
  sg: { label: "싱가포르 (zoho.sg)", accounts: "https://accounts.zoho.sg" },
} as const;

export type ZohoRegion = keyof typeof ZOHO_REGIONS;

/** The data center of an accounts server, e.g. `https://accounts.zoho.eu` → `eu`. */
export function regionOf(accountsServer: string): ZohoRegion | null {
  const found = Object.entries(ZOHO_REGIONS).find(
    ([, region]) => region.accounts === accountsServer.replace(/\/+$/, ""),
  );
  return found ? (found[0] as ZohoRegion) : null;
}

/** The Mail API base of an accounts server, e.g. `https://mail.zoho.com/api`. */
export function mailApiBase(accountsServer: string) {
  const url = new URL(accountsServer);
  if (!url.hostname.startsWith("accounts.")) throw new Error("Not a Zoho accounts server");
  return `https://mail.${url.hostname.slice("accounts.".length)}/api`;
}
