import { parseCookie, stringifySetCookie } from "cookie";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_COOKIE_PATH,
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_PATH,
} from "./auth.constants.js";

/**
 * No `domain` attribute is ever set on these cookies — FS01 explicitly
 * requires this so the same-origin proxy setup keeps working. Final
 * domain/CORS configuration is FS33's responsibility, not FS02's.
 */
function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAME_SITE,
  } as const;
}

export function setAuthCookies(
  res: Response,
  params: { accessToken: string; refreshToken: string; refreshMaxAgeMs: number }
): void {
  const accessCookie = stringifySetCookie({
    name: ACCESS_TOKEN_COOKIE,
    value: params.accessToken,
    ...baseCookieOptions(),
    path: ACCESS_TOKEN_COOKIE_PATH,
    maxAge: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  });

  const refreshCookie = stringifySetCookie({
    name: REFRESH_TOKEN_COOKIE,
    value: params.refreshToken,
    ...baseCookieOptions(),
    path: REFRESH_TOKEN_COOKIE_PATH,
    maxAge: Math.floor(params.refreshMaxAgeMs / 1000),
  });

  res.append("Set-Cookie", [accessCookie, refreshCookie]);
}

/**
 * Express doesn't parse cookies by default and this project doesn't run
 * the `cookie-parser` middleware (one small helper is enough for the two
 * cookies this API sets), so read them straight off the raw header.
 */
export function readAuthCookies(req: Request): { accessToken?: string; refreshToken?: string } {
  const header = req.headers.cookie;
  if (!header) {
    return {};
  }

  const parsed = parseCookie(header);
  return {
    accessToken: parsed[ACCESS_TOKEN_COOKIE],
    refreshToken: parsed[REFRESH_TOKEN_COOKIE],
  };
}

export function clearAuthCookies(res: Response): void {
  const clearedAccess = stringifySetCookie({
    name: ACCESS_TOKEN_COOKIE,
    value: "",
    ...baseCookieOptions(),
    path: ACCESS_TOKEN_COOKIE_PATH,
    maxAge: 0,
  });

  const clearedRefresh = stringifySetCookie({
    name: REFRESH_TOKEN_COOKIE,
    value: "",
    ...baseCookieOptions(),
    path: REFRESH_TOKEN_COOKIE_PATH,
    maxAge: 0,
  });

  res.append("Set-Cookie", [clearedAccess, clearedRefresh]);
}
