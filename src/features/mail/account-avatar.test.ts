import { describe, expect, it } from "vitest";
import { avatarHue, avatarLetter } from "@/features/mail/components/account-avatar";

describe("account avatar fallback", () => {
  it("uses the first letter of the name, else of the address", () => {
    expect(avatarLetter({ name: "홍길동", email: "staff@company.co.kr" })).toBe("홍");
    expect(avatarLetter({ name: "", email: "me@gmail.com" })).toBe("M");
  });

  it("gives each address a steady colour", () => {
    const hue = avatarHue("staff@company.co.kr");
    expect(hue).toBe(avatarHue("staff@company.co.kr"));
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});
