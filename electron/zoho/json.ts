/**
 * Zoho Mail ids (accounts, folders, messages) are 64-bit numbers such as
 * 900001000000002014, past what a JavaScript number holds exactly. Responses
 * are read with every integer too large for a number kept as its digits, and
 * ids are written back as bare JSON numbers from those digits.
 */

type ReviverContext = { source?: string };

/** JSON.parse, with unsafe integers kept as digit strings. */
export function parseZohoJson(text: string): unknown {
  return JSON.parse(text, function (_key, value: unknown, context?: ReviverContext) {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      context?.source !== undefined &&
      /^-?\d+$/.test(context.source)
    ) {
      return context.source;
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

const rawJSON = (JSON as unknown as { rawJSON: (text: string) => unknown }).rawJSON;

/** A Zoho id (digits) as a JSON number in a request body. */
export function zohoId(id: string): unknown {
  if (!/^\d{1,20}$/.test(id)) throw new Error("Not a Zoho id");
  return rawJSON(id);
}
