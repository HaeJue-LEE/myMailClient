import { describe, expect, it } from "vitest";
import { parseAddresses } from "@/features/mail/addresses";
import { isEmail } from "@/features/mail/email";

describe("parseAddresses", () => {
  it("returns nothing for blank input", () => {
    expect(parseAddresses("  , ;\n")).toEqual({ valid: [], invalid: [] });
  });

  it("splits on commas, semicolons, and newlines", () => {
    expect(parseAddresses("a@example.com, b@example.com;c@example.com\nd@example.com").valid).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
    ]);
  });

  it("reduces display-name addresses to the address", () => {
    expect(parseAddresses('"홍길동" <hong@example.com>')).toEqual({
      valid: ["hong@example.com"],
      invalid: [],
    });
  });

  it("accepts addresses Gmail handles but Zod's default rejects, like bounce addresses with =", () => {
    const bounce =
      "1axco6ydwzvmbk8gzctiifhgz1bwvwca5uff71-me=gmail.com@bf05x.hubspotemail.net";
    expect(parseAddresses(`HubSpot <${bounce}>, o'brien+x@example.com`).valid).toEqual([
      bounce,
      "o'brien+x@example.com",
    ]);
  });

  it("rejects whitespace and line breaks inside an address", () => {
    expect(parseAddresses("a b@x.com").invalid).toEqual(["a b@x.com"]);
    expect(isEmail("a@x.com\r\nBcc: evil@x.com")).toBe(false);
  });

  it("reports invalid entries as typed", () => {
    expect(parseAddresses("a@example.com, 홍길동 <nope>, foo")).toEqual({
      valid: ["a@example.com"],
      invalid: ["홍길동 <nope>", "foo"],
    });
  });
});
