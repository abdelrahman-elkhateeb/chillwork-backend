/**
 * FS09 — technician management constants.
 *
 * There is no email service (FS07), so an invitation is delivered as a
 * one-time activation token the admin copies to the technician (e.g. as
 * a link). The token is 256 bits of randomness; only its SHA-256 hash is
 * stored, it expires, and it works once.
 */
export const ACTIVATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Per-IP throttle on POST /auth/activate-technician (unauthenticated).
export const ACTIVATION_MAX_ATTEMPTS_PER_IP = 10;
export const ACTIVATION_WINDOW_MS = 15 * 60 * 1000;

export const TECHNICIAN_STATUSES = ["ACTIVE", "INVITED", "INACTIVE"] as const;
export type TechnicianStatus = (typeof TECHNICIAN_STATUSES)[number];

export const TECHNICIANS_DEFAULT_PAGE_SIZE = 20;
export const TECHNICIANS_MAX_PAGE_SIZE = 100;
export const TECHNICIANS_MAX_PAGE = 10_000;
export const MAX_TECHNICIAN_SEARCH_LENGTH = 100;
