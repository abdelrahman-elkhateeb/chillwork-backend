import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { env } from "../../config/env.js";
import { ACCESS_TOKEN_TTL_MS } from "./auth.constants.js";

const accessTokenSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessTokenClaims {
  sub: string;
  sid: string;
}

/**
 * Minimal access JWT: just enough to identify the session to load
 * server-side (`sub` = userId, `sid` = sessionId). No company, no roles,
 * no refresh material — everything else is re-derived from the
 * authoritative Session/User documents on every request (see
 * middleware/authenticate.ts).
 */
export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + ACCESS_TOKEN_TTL_MS) / 1000))
    .sign(accessTokenSecret);
}

export type AccessTokenVerifyResult =
  | { valid: true; claims: AccessTokenClaims }
  | { valid: false };

export async function verifyAccessToken(token: string): Promise<AccessTokenVerifyResult> {
  try {
    const { payload } = await jwtVerify(token, accessTokenSecret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });

    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      return { valid: false };
    }

    return { valid: true, claims: { sub: payload.sub, sid: payload.sid } };
  } catch (error) {
    if (error instanceof joseErrors.JOSEError) {
      return { valid: false };
    }
    throw error;
  }
}

const REFRESH_TOKEN_BYTES = 32;

/** Opaque, high-entropy refresh token. Never a JWT, never persisted raw. */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

/**
 * The token itself already has 256 bits of entropy, so a plain
 * cryptographic hash (not a slow password KDF) is the right tool here —
 * it exists to keep a raw, replayable secret out of the database, not to
 * resist brute force against low-entropy input.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
