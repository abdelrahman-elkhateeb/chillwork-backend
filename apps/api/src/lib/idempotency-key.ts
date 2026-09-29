import type { Request } from "express";
import { HttpError } from "./http-error.js";

// Alphanumeric plus -/_ only — this becomes part of a MongoDB query value
// and, indirectly, of logged metadata; restricting the charset avoids any
// ambiguity, not because a wider charset would be unsafe on its own.
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** The required `Idempotency-Key` header (FS15 request creation, FS25 invoice issuance). */
export function extractIdempotencyKey(req: Request): string {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;

  if (!value) {
    throw HttpError.missingIdempotencyKey();
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw HttpError.invalidIdempotencyKey();
  }
  return value;
}
