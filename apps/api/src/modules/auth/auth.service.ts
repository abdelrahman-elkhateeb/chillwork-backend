import { createHash } from "node:crypto";
import type { Types } from "mongoose";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { Company } from "../companies/company.model.js";
import { resolveDemoCompany } from "../companies/company.service.js";
import { hashPassword, verifyPassword } from "../users/password.js";
import { User, type UserDocument } from "../users/user.model.js";
import type { RegisterInput } from "./auth.schemas.js";
import { recordAttempt } from "./auth-throttle.model.js";
import { SESSION_ABSOLUTE_TTL_MS, SESSION_ROLLING_TTL_MS } from "./auth.constants.js";
import { generateRefreshToken, hashRefreshToken, signAccessToken } from "./auth.tokens.js";
import { Session, type SessionDocument, type SessionRevokedReason } from "./session.model.js";

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeMs: number;
  session: SessionDocument;
  user: UserDocument;
}

/**
 * Rolling expiry is always the earlier of "7 days from now" and the fixed
 * absolute expiry — the absolute expiry never moves, so a refresh near the
 * end of the 30-day window can only shorten the next rolling window, never
 * extend the session past day 30.
 */
function computeRollingExpiry(now: Date, absoluteExpiresAt: Date): Date {
  const rolling = new Date(now.getTime() + SESSION_ROLLING_TTL_MS);
  return rolling.getTime() < absoluteExpiresAt.getTime() ? rolling : absoluteExpiresAt;
}

function hashThrottleIdentifier(value: string): string {
  return createHash("sha256").update(value.toLowerCase().trim()).digest("hex");
}

/**
 * Two independent buckets, see docs/api.md "Throttling":
 *  - per-IP: a coarse ceiling against generic abuse from one source.
 *  - per-account+IP: a stricter ceiling scoped to (account, source) so a
 *    remote attacker spamming one victim's email can't lock that account
 *    out for the victim's own, different source IP.
 * Neither bucket is a lockout — both are bounded to the rolling window and
 * self-clear (see AuthThrottle's TTL index).
 */
export async function checkLoginThrottle(email: string, ip: string, now: Date = new Date()): Promise<void> {
  const perIpCount = await recordAttempt(`login:ip:${ip}`, env.AUTH_LOGIN_WINDOW_MS, now);
  if (perIpCount > env.AUTH_LOGIN_MAX_ATTEMPTS_PER_IP) {
    throw HttpError.rateLimited();
  }

  const perAccountCount = await recordAttempt(
    `login:account:${hashThrottleIdentifier(email)}:${ip}`,
    env.AUTH_LOGIN_WINDOW_MS,
    now
  );
  if (perAccountCount > env.AUTH_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT) {
    throw HttpError.rateLimited();
  }
}

// Computed once at module load so login() always performs a real scrypt
// hash comparison even when the account doesn't exist — this keeps the
// unknown-email and wrong-password paths close in timing so login can't be
// used to enumerate registered accounts.
const DUMMY_PASSWORD_HASH = await hashPassword("fs02-timing-safety-placeholder");

export async function login(email: string, password: string, now: Date = new Date()): Promise<AuthResult> {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await User.findOne({ email: normalizedEmail }).select("+passwordHash");

  const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user || !passwordOk || !user.isActive) {
    throw HttpError.invalidCredentials();
  }

  const company = await Company.findById(user.companyId);
  if (!company || !company.isActive) {
    throw HttpError.invalidCredentials();
  }

  return createSession(user, now);
}

async function createSession(user: UserDocument, now: Date): Promise<AuthResult> {
  const rawToken = generateRefreshToken();
  const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS);
  const rollingExpiresAt = computeRollingExpiry(now, absoluteExpiresAt);

  const session = await Session.create({
    userId: user._id,
    companyId: user.companyId,
    currentTokenHash: hashRefreshToken(rawToken),
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    loginAt: now,
    lastRefreshedAt: now,
    rollingExpiresAt,
    absoluteExpiresAt,
    revokedAt: null,
    revokedReason: null,
  });

  const accessToken = await signAccessToken({ sub: user._id.toString(), sid: session._id.toString() });

  return {
    accessToken,
    refreshToken: rawToken,
    refreshMaxAgeMs: rollingExpiresAt.getTime() - now.getTime(),
    session,
    user,
  };
}

/**
 * Registration's own, coarser throttle (see docs/api.md "Throttling") —
 * per-IP only, since there's no pre-existing account to scope a stricter
 * bucket to the way login's per-account+IP bucket does.
 */
export async function checkRegisterThrottle(ip: string, now: Date = new Date()): Promise<void> {
  const count = await recordAttempt(`register:ip:${ip}`, env.AUTH_REGISTER_WINDOW_MS, now);
  if (count > env.AUTH_REGISTER_MAX_ATTEMPTS_PER_IP) {
    throw HttpError.rateLimited();
  }
}

/**
 * Public customer registration. Deliberately does NOT create a Session or
 * issue any tokens — the documented MVP flow is register (201) then a
 * separate login call (see docs/api.md "Customer registration"). Role is
 * always "CUSTOMER" and the company is always the server-resolved demo
 * company; `input` only ever has name/email/phone/password (see
 * registerSchema) so there is nothing for a client to tamper with here.
 *
 * Order follows docs/api.md's documented registration flow: resolve the
 * company, check the normalized email, hash the password, then create —
 * with the schema-level unique index as the final concurrency guard
 * against two requests racing the findOne check.
 */
export async function register(input: RegisterInput): Promise<UserDocument> {
  const normalizedEmail = input.email.toLowerCase().trim();

  const company = await resolveDemoCompany();

  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    throw HttpError.conflict("An account with this email already exists");
  }

  const passwordHash = await hashPassword(input.password);

  try {
    return await User.create({
      email: normalizedEmail,
      name: input.name,
      phone: input.phone,
      passwordHash,
      role: "CUSTOMER",
      companyId: company._id,
      isActive: true,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw HttpError.conflict("An account with this email already exists");
    }
    throw error;
  }
}

export interface SessionContext {
  user: UserDocument;
}

/**
 * The authority check every protected request and every refresh must run:
 * revocation, rolling/absolute expiry, user active state, and company
 * membership — all re-derived from the database, never trusted from the
 * JWT. A valid, unexpired JWT alone must never be sufficient.
 */
export async function validateSessionContext(session: SessionDocument, now: Date): Promise<SessionContext> {
  if (session.revokedAt) {
    throw HttpError.sessionRevoked();
  }

  if (now.getTime() >= session.absoluteExpiresAt.getTime() || now.getTime() >= session.rollingExpiresAt.getTime()) {
    throw HttpError.sessionExpired();
  }

  const user = await User.findById(session.userId);
  if (!user || !user.isActive) {
    throw HttpError.unauthorized("User is not active");
  }

  if (!user.companyId.equals(session.companyId)) {
    throw HttpError.unauthorized("Company membership is no longer valid");
  }

  const company = await Company.findById(session.companyId);
  if (!company || !company.isActive) {
    throw HttpError.unauthorized("Company membership is no longer valid");
  }

  return { user };
}

const MAX_ROTATE_RETRIES = 3;

/**
 * Refresh token rotation with reuse detection. See docs/api.md
 * "Concurrent refresh policy" for the full write-up; summary:
 *
 *  - The presented token must hash-match either the session's current
 *    token (normal case) or its immediately-previous token, and only
 *    while that previous token's short grace window hasn't elapsed
 *    (absorbs a legitimate near-simultaneous double-refresh without
 *    logging the user out).
 *  - Rotation is a compare-and-swap on `currentTokenHash`, so only one
 *    concurrent writer can advance the chain per generation; a loser
 *    re-reads and retries against the now-current state, which is exactly
 *    the "grace window" path above.
 *  - A token that matches neither field, or matches the previous token
 *    after its grace window has elapsed, is treated as genuine reuse: the
 *    session (this device only — sessions are already per-device) is
 *    revoked and REFRESH_TOKEN_REUSED is returned.
 */
export async function refresh(rawToken: string, now: Date = new Date()): Promise<AuthResult> {
  const presentedHash = hashRefreshToken(rawToken);

  const session = await Session.findOne({
    $or: [{ currentTokenHash: presentedHash }, { previousTokenHash: presentedHash }],
  });

  if (!session) {
    throw HttpError.invalidRefreshToken();
  }

  if (session.revokedAt) {
    throw HttpError.sessionRevoked();
  }

  return rotate(session, presentedHash, now, 0);
}

async function rotate(
  session: SessionDocument,
  presentedHash: string,
  now: Date,
  attempt: number
): Promise<AuthResult> {
  const isCurrent = presentedHash === session.currentTokenHash;
  const isPrevious = !isCurrent && presentedHash === session.previousTokenHash;

  if (!isCurrent && !isPrevious) {
    await markReuseDetected(session._id, now);
    throw HttpError.refreshTokenReused();
  }

  if (isPrevious) {
    const withinGrace =
      session.previousTokenExpiresAt !== null && now.getTime() <= session.previousTokenExpiresAt.getTime();
    if (!withinGrace) {
      await markReuseDetected(session._id, now);
      throw HttpError.refreshTokenReused();
    }
  }

  const { user } = await validateSessionContext(session, now);

  const newRawToken = generateRefreshToken();
  const newHash = hashRefreshToken(newRawToken);
  const rollingExpiresAt = computeRollingExpiry(now, session.absoluteExpiresAt);
  const previousTokenExpiresAt = new Date(now.getTime() + env.AUTH_REFRESH_GRACE_MS);

  const updated = await Session.findOneAndUpdate(
    { _id: session._id, currentTokenHash: session.currentTokenHash, revokedAt: null },
    {
      $set: {
        currentTokenHash: newHash,
        previousTokenHash: session.currentTokenHash,
        previousTokenExpiresAt,
        lastRefreshedAt: now,
        rollingExpiresAt,
      },
    },
    { new: true }
  );

  if (!updated) {
    // Lost the compare-and-swap to a concurrent refresh. Re-read the
    // now-current state and retry the same presented token against it —
    // if this was a legitimate race, the token we hold is that winner's
    // `previousTokenHash` and still within its grace window.
    if (attempt >= MAX_ROTATE_RETRIES) {
      throw HttpError.invalidRefreshToken("Refresh conflict, please retry");
    }
    const fresh = await Session.findById(session._id);
    if (!fresh) {
      throw HttpError.invalidRefreshToken();
    }
    if (fresh.revokedAt) {
      throw HttpError.sessionRevoked();
    }
    return rotate(fresh, presentedHash, now, attempt + 1);
  }

  const accessToken = await signAccessToken({ sub: user._id.toString(), sid: updated._id.toString() });

  return {
    accessToken,
    refreshToken: newRawToken,
    refreshMaxAgeMs: rollingExpiresAt.getTime() - now.getTime(),
    session: updated,
    user,
  };
}

async function markReuseDetected(sessionId: Types.ObjectId, now: Date): Promise<void> {
  await Session.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: now, revokedReason: "reuse_detected" satisfies SessionRevokedReason } }
  );
}

/**
 * Reusable session invalidation primitives (FS02 spec section 31). Future
 * password-reset/security-event features should call
 * `revokeAllUserSessions(userId, "password_reset")` (or `"manual"` for an
 * admin-initiated deactivation) rather than duplicating this logic.
 */
export async function revokeSessionById(
  sessionId: Types.ObjectId | string,
  reason: SessionRevokedReason,
  now: Date = new Date()
): Promise<void> {
  await Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: now, revokedReason: reason } });
}

export async function revokeAllUserSessions(
  userId: Types.ObjectId | string,
  reason: SessionRevokedReason,
  now: Date = new Date()
): Promise<void> {
  await Session.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now, revokedReason: reason } });
}

export async function revokeCurrentSession(sessionId: Types.ObjectId | string, now: Date = new Date()): Promise<void> {
  await revokeSessionById(sessionId, "logout", now);
}
