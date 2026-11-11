import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isApiDisabled,
  isAuthFailure,
  isMissingScope,
  isRateLimit,
  toErrorCode,
  UnauthorizedError,
} from "./errors";

class Cancelled extends Error {}
const code = (error: unknown) =>
  toErrorCode(error, (e) => e instanceof Cancelled);

describe("toErrorCode", () => {
  it("treats a missing session, revoked grant, and Gmail 401 as unauthorized", () => {
    const invalidGrant = { response: { data: { error: "invalid_grant" } } };
    for (const error of [new UnauthorizedError(), invalidGrant, { status: 401 }]) {
      expect(isAuthFailure(error)).toBe(true);
      expect(code(error)).toBe("unauthorized");
    }
  });

  it("maps validation, cancellation, and upstream errors", () => {
    expect(code(z.string().safeParse(1).error)).toBe("invalid_request");
    expect(code(new Cancelled())).toBe("login_cancelled");
    expect(code({ status: 404 })).toBe("gmail_error");
  });

  it("recognizes short-term throttling but not daily quota", () => {
    const perMinute = {
      status: 403,
      message:
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
    };
    const byReason = { status: 403, errors: [{ reason: "userRateLimitExceeded" }] };
    const daily = { status: 403, errors: [{ reason: "dailyLimitExceeded" }] };

    for (const error of [{ status: 429 }, perMinute, byReason]) {
      expect(isRateLimit(error)).toBe(true);
      expect(code(error)).toBe("rate_limited");
    }
    expect(isRateLimit(daily)).toBe(false);
    expect(code(daily)).toBe("gmail_error");
    expect(isRateLimit({ status: 403 })).toBe(false);
  });

  it("tells a missing permission from a disabled API", () => {
    const missingScope = {
      status: 403,
      message: "Request had insufficient authentication scopes.",
    };
    const disabled = {
      status: 403,
      message:
        "People API has not been used in project 123 before or it is disabled. Enable it by visiting …",
    };
    expect(isMissingScope(missingScope)).toBe(true);
    expect(code(missingScope)).toBe("missing_scope");
    expect(isApiDisabled(disabled)).toBe(true);
    expect(code(disabled)).toBe("api_disabled");
    expect(isMissingScope({ status: 401, message: missingScope.message })).toBe(false);
  });

  it("hides anything unexpected", () => {
    expect(code(new Error("boom"))).toBe("internal_error");
    expect(code({ status: 500 })).toBe("internal_error");
  });
});

describe("mail server errors", () => {
  it("never count as a dead Google sign-in", async () => {
    const { MailServerError } = await import("./errors");
    const error = Object.assign(new MailServerError("auth_failed"), { status: 401 });
    expect(isAuthFailure(error)).toBe(false);
    expect(code(error)).toBe("auth_failed");
    expect(code(new MailServerError("smtp_connection_failed"))).toBe("smtp_connection_failed");
  });
});
