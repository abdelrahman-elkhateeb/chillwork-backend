import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originFromReferer(referer: string): string | null {
  try {
    const url = new URL(referer);
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * CSRF/origin protection for cookie-authenticated state-changing requests.
 * Cookies alone (SameSite=Lax/Strict) already block most cross-site
 * submission, but this adds an explicit, defense-in-depth Origin check —
 * modern browsers attach `Origin` to every POST/PUT/PATCH/DELETE request
 * (same-origin included), so a forged cross-site form/fetch can't spoof
 * it. GET/HEAD/OPTIONS are left alone; they must stay side-effect-free.
 *
 * The request's own origin is always implicitly allowed (no configuration
 * needed for the same-origin proxy setup FS01 documents). Additional
 * origins come from `AUTH_ALLOWED_ORIGINS` — deliberately empty by
 * default rather than hardcoding a production frontend domain, which is
 * FS33's responsibility.
 */
export function csrfOriginGuard(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.headers.origin ?? (req.headers.referer ? originFromReferer(req.headers.referer) : null);

  if (!origin) {
    next(HttpError.csrfOriginRejected("Missing Origin/Referer header"));
    return;
  }

  const selfOrigin = `${req.protocol}://${req.get("host") ?? ""}`;
  const allowedOrigins = new Set([selfOrigin, ...env.AUTH_ALLOWED_ORIGINS]);

  if (!allowedOrigins.has(origin)) {
    next(HttpError.csrfOriginRejected());
    return;
  }

  next();
}
