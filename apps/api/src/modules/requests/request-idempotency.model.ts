import { Schema, model, Types } from "mongoose";

export type IdempotencyStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED";

/**
 * Coordinates exactly-once request creation per (company, customer,
 * Idempotency-Key). Deliberately holds NO request content — no address,
 * no phone, no device descriptions, nothing Gemini-related — only a
 * fingerprint hash (for detecting a reused key with different data) and
 * enough metadata to reconcile a retry with its result. See
 * docs/api.md "Idempotency" for the full state-machine writeup.
 */
const requestIdempotencySchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
  customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  idempotencyKey: { type: String, required: true },
  // SHA-256 of a canonicalized request shape — equality-check only, never
  // exposed to the client, never reversible to the original content.
  fingerprint: { type: String, required: true },
  status: { type: String, enum: ["IN_PROGRESS", "COMPLETED", "FAILED"], required: true },
  requestId: { type: Schema.Types.ObjectId, ref: "ServiceRequest", default: null },
  // Absolute timestamp (not a relative TTL) — see auth-throttle.model.ts
  // for the same pattern. Its value changes with status: short while
  // IN_PROGRESS (self-heals an abandoned reservation), long once
  // COMPLETED (so a late retry still finds the result).
  expiresAt: { type: Date, required: true },
});

requestIdempotencySchema.index({ companyId: 1, customerId: 1, idempotencyKey: 1 }, { unique: true });
requestIdempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export interface RequestIdempotencyDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  customerId: Types.ObjectId;
  idempotencyKey: string;
  fingerprint: string;
  status: IdempotencyStatus;
  requestId: Types.ObjectId | null;
  expiresAt: Date;
}

export const RequestIdempotency = model<RequestIdempotencyDocument>(
  "RequestIdempotency",
  requestIdempotencySchema
);
