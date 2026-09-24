import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import type { UserDocument } from "../users/user.model.js";
import {
  checkLoginThrottle,
  checkRegisterThrottle,
  login,
  refresh,
  register,
  revokeCurrentSession,
  type AuthResult,
} from "./auth.service.js";
import { clearAuthCookies, readAuthCookies, setAuthCookies } from "./auth.cookies.js";
import { loginSchema, registerSchema } from "./auth.schemas.js";
import { hashRefreshToken } from "./auth.tokens.js";
import { Session } from "./session.model.js";

/**
 * Never the raw Mongoose document — used by both login and register so
 * there's exactly one place that decides which User fields are safe to
 * return (never passwordHash, never anything session-related).
 */
function toSafeUser(user: UserDocument) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    companyId: user.companyId.toString(),
  };
}

/**
 * Registration is intentionally separate from authentication: it creates
 * a User and nothing else — no Session, no tokens, no cookies. The
 * documented MVP flow is register (201) then a separate POST /auth/login
 * call. Throttling runs before anything expensive (company lookup,
 * uniqueness check, password hashing).
 */
export async function postRegister(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = registerSchema.parse(req.body);
    const ip = req.ip ?? "unknown";

    await checkRegisterThrottle(ip);

    const user = await register(input);

    res.status(201).json(success({ user: toSafeUser(user) }));
  } catch (error) {
    next(error);
  }
}

/**
 * Privacy-preserving correlation handle for logs — the same SHA-256
 * approach the login throttle buckets already key on (see
 * auth.service.ts's hashThrottleIdentifier), reused here so a raw email
 * address never lands in plaintext in server logs.
 */
function hashForLog(value: string): string {
  return createHash("sha256").update(value.toLowerCase().trim()).digest("hex");
}

type LoginLogEvent =
  | { outcome: "success"; requestId: string; ip: string; emailHash: string; userId: string; companyId: string }
  | { outcome: "failure"; requestId: string; ip: string; emailHash: string };

/**
 * Minimal structured login event (FS05) — deliberately not a general
 * audit-log subsystem. Only ever emitted around the actual
 * credential-verification call (never for request-validation or
 * throttling rejections, which aren't login attempts against a real
 * password), so `userId`/`companyId` are only ever included on success,
 * when they're genuinely known — a failed attempt never has a user
 * identity manufactured for it. Never logs the email itself, the
 * password, or any token.
 */
function logLoginEvent(event: LoginLogEvent): void {
  const log = event.outcome === "success" ? console.info : console.warn;
  log({ event: "auth.login", ...event });
}

export async function postLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = loginSchema.parse(req.body);
    const ip = req.ip ?? "unknown";
    const requestId = res.locals.requestId;
    const emailHash = hashForLog(input.email);

    await checkLoginThrottle(input.email, ip);

    let result: AuthResult;
    try {
      result = await login(input.email, input.password);
    } catch (error) {
      logLoginEvent({ outcome: "failure", requestId, ip, emailHash });
      throw error;
    }

    logLoginEvent({
      outcome: "success",
      requestId,
      ip,
      emailHash,
      userId: result.user._id.toString(),
      companyId: result.user.companyId.toString(),
    });

    setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshMaxAgeMs: result.refreshMaxAgeMs,
    });

    res.status(200).json(
      success({
        user: toSafeUser(result.user),
        session: {
          id: result.session._id.toString(),
          expiresAt: result.session.rollingExpiresAt.toISOString(),
        },
      })
    );
  } catch (error) {
    next(error);
  }
}

/**
 * Session restoration (FS05): the frontend calls this after a browser
 * refresh to re-derive "who is logged in" purely from the access/refresh
 * cookies, without ever storing a token itself. Identity comes entirely
 * from `req.auth`, set by the `authenticate` middleware after it
 * re-validates the session/user/company server-side — never from any
 * client-supplied id.
 */
export function getMe(req: Request, res: Response): void {
  res.status(200).json(success({ user: toSafeUser(req.auth!.user) }));
}

export async function postRefresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = readAuthCookies(req);
    if (!refreshToken) {
      throw HttpError.invalidRefreshToken("Missing refresh token");
    }

    const result = await refresh(refreshToken);

    setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshMaxAgeMs: result.refreshMaxAgeMs,
    });

    res.status(200).json(
      success({
        session: {
          id: result.session._id.toString(),
          expiresAt: result.session.rollingExpiresAt.toISOString(),
        },
      })
    );
  } catch (error) {
    next(error);
  }
}

/**
 * Identifies the session directly from the refresh cookie (rather than
 * requiring the `authenticate` middleware) so logout still works when the
 * access token has already expired — the common case where a user closes
 * a stale tab. This is also what keeps repeated logout calls idempotent:
 * a second call's token hash simply no longer matches any un-revoked
 * session, so there is nothing to revoke and nothing to error on.
 */
export async function postLogout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = readAuthCookies(req);

    if (refreshToken) {
      const tokenHash = hashRefreshToken(refreshToken);
      const session = await Session.findOne({
        $or: [{ currentTokenHash: tokenHash }, { previousTokenHash: tokenHash }],
      });

      if (session) {
        await revokeCurrentSession(session._id);
      }
    }

    clearAuthCookies(res);
    res.status(200).json(success({ loggedOut: true }));
  } catch (error) {
    next(error);
  }
}
