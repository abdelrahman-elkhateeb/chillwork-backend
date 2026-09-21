/**
 * Fixed lifetimes from the FS02 spec. These are business-mandated exact
 * values (15m / 7d / 30d), not tunables, so they're constants rather than
 * environment variables.
 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_ROLLING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const ACCESS_TOKEN_COOKIE = "access_token";
export const REFRESH_TOKEN_COOKIE = "refresh_token";

/** Refresh cookie is only ever sent to the auth endpoints that need it. */
export const REFRESH_TOKEN_COOKIE_PATH = "/api/v1/auth";
export const ACCESS_TOKEN_COOKIE_PATH = "/";
