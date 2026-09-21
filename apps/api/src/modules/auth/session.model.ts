import { Schema, model, Types } from "mongoose";

export type SessionRevokedReason =
  | "logout"
  | "reuse_detected"
  | "user_deactivated"
  | "password_reset"
  | "manual";

/**
 * Server-side session state. This — not the JWT — is the authority for
 * whether a device is still logged in. See docs/api.md "Session
 * architecture" for the full validation/rotation story.
 *
 * Rotation model: a session tracks exactly one "current" refresh token
 * hash plus the immediately-previous one (kept only for a short grace
 * window) to distinguish a legitimate concurrent-refresh race from actual
 * token reuse. See `rotateRefreshToken` in auth.service.ts.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },

    currentTokenHash: { type: String, required: true },
    previousTokenHash: { type: String, default: null },
    previousTokenExpiresAt: { type: Date, default: null },

    // Original login time. Fixed for the lifetime of the session — the
    // absolute expiry is always derived from this, and this field itself
    // is never updated by rotation.
    loginAt: { type: Date, required: true },

    lastRefreshedAt: { type: Date, required: true },
    rollingExpiresAt: { type: Date, required: true },
    absoluteExpiresAt: { type: Date, required: true },

    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: ["logout", "reuse_detected", "user_deactivated", "password_reset", "manual"],
      default: null,
    },
  },
  { timestamps: true }
);

// Refresh lookups hash the presented token and search by it directly.
sessionSchema.index({ currentTokenHash: 1 });
sessionSchema.index({ previousTokenHash: 1 });
// revokeAllUserSessions / listing a user's active sessions.
sessionSchema.index({ userId: 1, revokedAt: 1 });
// Cleanup only (see docs/api.md) — never relied on for authorization.
sessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

export interface SessionDocument {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
  currentTokenHash: string;
  previousTokenHash: string | null;
  previousTokenExpiresAt: Date | null;
  loginAt: Date;
  lastRefreshedAt: Date;
  rollingExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
  createdAt: Date;
  updatedAt: Date;
}

export const Session = model<SessionDocument>("Session", sessionSchema);
