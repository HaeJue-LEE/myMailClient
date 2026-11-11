import { isEmail } from "@/features/mail/email";

/**
 * Parses a free-form recipient field. Separators are comma, semicolon, and
 * newline; `이름 <a@example.com>` is reduced to its address.
 */
export function parseAddresses(input: string) {
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const entry of input.split(/[,;\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const address = trimmed.match(/<([^<>]+)>$/)?.[1].trim() ?? trimmed;
    if (isEmail(address)) {
      valid.push(address);
    } else {
      invalid.push(trimmed);
    }
  }

  return { valid, invalid };
}
