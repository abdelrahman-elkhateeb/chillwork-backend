/**
 * FS23 — technician work execution / work results.
 *
 * There is intentionally no "no result" state: a repair that did not
 * happen is a FAILED result with a structured reason, not an absence of
 * data — see docs/api.md "Technician work execution (FS23)".
 */
export const WORK_RESULTS = ["REPAIRED", "FAILED"] as const;
export type WorkResultValue = (typeof WORK_RESULTS)[number];

export const FAILURE_REASONS = [
  "PART_UNAVAILABLE",
  "CUSTOMER_REFUSED",
  "TOO_EXPENSIVE",
  "TECHNICAL_ISSUE",
  "OTHER",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const MAX_FAILURE_NOTE_LENGTH = 1000;

export const VISIT_OUTCOMES = ["FULLY_REPAIRED", "PARTIALLY_REPAIRED", "NO_REPAIR"] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];
