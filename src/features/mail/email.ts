import { z } from "zod";

/**
 * Email addresses as browsers validate them (the HTML5 rule). Zod's default is
 * stricter and rejects valid addresses that Gmail handles, such as bounce
 * addresses with `=` (`…-name=gmail.com@bf05x.hubspotemail.net`). Whitespace
 * and line breaks are still rejected, so an address cannot inject headers.
 */
export const emailSchema = z.email({ pattern: z.regexes.html5Email });

export function isEmail(value: string) {
  return emailSchema.safeParse(value).success;
}
