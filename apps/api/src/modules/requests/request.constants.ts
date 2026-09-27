/**
 * FS15 — service request creation constants.
 */

// Idempotency-Key header: format and parsing live in lib/idempotency-key.ts
// (shared with FS25 invoice issuance).

/**
 * How long an abandoned (crashed-before-completing) reservation blocks its
 * key before a retry can reclaim it. Short on purpose — this is a
 * self-healing backstop, not the primary recovery path (a definitively
 * FAILED reservation can be reclaimed immediately, see request.service.ts).
 */
export const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 5 * 60 * 1000;

/**
 * How long a COMPLETED reservation is kept so a late retry (slow network,
 * client-side timeout before the response arrived) still finds the
 * original result instead of being treated as a new submission.
 */
export const IDEMPOTENCY_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;

// Request/device input bounds ------------------------------------------------
export const MAX_ADDRESS_LENGTH = 500;
// Duplicated from auth.schemas.ts's phone rule rather than importing it —
// keeping FS04's already-shipped module untouched. Keep in sync by hand.
export const CONTACT_PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;
export const MAX_DEVICE_LABEL_LENGTH = 100;
export const MAX_DEVICE_BRAND_LENGTH = 100;
export const MAX_DEVICE_MODEL_LENGTH = 100;

// Reference generation --------------------------------------------------------
// Excludes 0/O/1/I to avoid human transcription ambiguity.
export const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const REFERENCE_RANDOM_LENGTH = 8;
export const REFERENCE_PREFIX = "SR-";

export const SERVICE_REQUEST_STATUSES = ["SUBMITTED"] as const;
