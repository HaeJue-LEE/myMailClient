import { ZodError } from "zod";
import type { MailErrorCode } from "@/features/mail/bridge";

export class UnauthorizedError extends Error {}

/** A well-formed request the app still refuses, e.g. an unverified From address. */
export class InvalidRequestError extends Error {}

/**
 * A failure talking to an IMAP or SMTP server, already reduced to a code the
 * renderer may see. Unlike a dead Google grant, it never signs anything out:
 * a wrong password is fixed in the account's settings.
 */
export class MailServerError extends Error {
  constructor(
    readonly code:
      | "auth_failed"
      | "connection_failed"
      | "smtp_auth_failed"
      | "smtp_connection_failed"
      | "server_error",
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function upstreamStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const { status } = error as { status?: unknown };
  return typeof status === "number" ? status : undefined;
}

function isInvalidGrant(error: unknown) {
  const data = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data;
  return data?.error === "invalid_grant";
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/**
 * True for Gmail's short-term throttling (429, or 403 "Units per minute per
 * user"), which clears within a minute. Daily quota errors are not included.
 */
export function isRateLimit(error: unknown) {
  const status = upstreamStatus(error);
  if (status === 429) return true;
  if (status !== 403) return false;
  const { errors, message } = error as {
    errors?: { reason?: unknown }[];
    message?: unknown;
  };
  const reason = errors?.[0]?.reason;
  return (
    (typeof reason === "string" && RATE_LIMIT_REASONS.has(reason)) ||
    (typeof message === "string" && /per minute|rate limit/i.test(message))
  );
}

function forbiddenMessage(error: unknown) {
  if (upstreamStatus(error) !== 403) return null;
  const { message } = error as { message?: unknown };
  return typeof message === "string" ? message : "";
}

/** 403 because the sign-in predates a scope (e.g. contacts); signing in again fixes it. */
export function isMissingScope(error: unknown) {
  return /insufficient authentication scopes/i.test(forbiddenMessage(error) ?? "");
}

/** 403 because the API (e.g. People) is not enabled in the Cloud project. */
export function isApiDisabled(error: unknown) {
  return /has not been used in project|is disabled|SERVICE_DISABLED/i.test(
    forbiddenMessage(error) ?? "",
  );
}

/** True when the stored grant is dead and the user has to sign in again. */
export function isAuthFailure(error: unknown) {
  if (error instanceof MailServerError) return false;
  return (
    error instanceof UnauthorizedError ||
    isInvalidGrant(error) ||
    upstreamStatus(error) === 401
  );
}

/** Maps an error to a code that is safe to hand to the renderer. */
export function toErrorCode(
  error: unknown,
  isLoginCancelled: (error: unknown) => boolean,
): MailErrorCode {
  if (error instanceof MailServerError) return error.code;
  if (isAuthFailure(error)) return "unauthorized";
  if (isLoginCancelled(error)) return "login_cancelled";
  if (error instanceof ZodError || error instanceof InvalidRequestError) {
    return "invalid_request";
  }
  if (isRateLimit(error)) return "rate_limited";
  if (isMissingScope(error)) return "missing_scope";
  if (isApiDisabled(error)) return "api_disabled";
  const status = upstreamStatus(error);
  if (status === 403 || status === 404 || status === 429) return "gmail_error";
  return "internal_error";
}
