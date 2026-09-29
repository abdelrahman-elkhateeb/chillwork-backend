/**
 * FS18 — visit scheduling constants. These values don't come from a
 * parent spec; they are the smallest defensible defaults and live here
 * (not scattered) so they can be changed deliberately.
 */

export const VISIT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/**
 * Only these statuses occupy a technician's time. Conflict checks are
 * written as "status IN ACTIVE_VISIT_STATUSES" (an allow-list), never
 * "status != CANCELLED", so a future status can't silently start
 * blocking or stop blocking bookings.
 */
export const ACTIVE_VISIT_STATUSES: readonly VisitStatus[] = ["SCHEDULED", "IN_PROGRESS"];

/** Inspection and repair can share one visit (a visit is not inspection-only). */
export const WORK_TYPES = ["INSPECTION", "REPAIR"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export const DEFAULT_WORK_TYPES: readonly WorkType[] = ["INSPECTION"];

/** Requests in these statuses may be scheduled (only SUBMITTED exists today). */
export const SCHEDULABLE_REQUEST_STATUSES: readonly string[] = ["SUBMITTED"];

export const MIN_VISIT_DURATION_MS = 15 * 60 * 1000;
export const MAX_VISIT_DURATION_MS = 8 * 60 * 60 * 1000;
export const MAX_AVAILABILITY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

export const VISIT_EVENT_TYPES = [
  "VISIT_SCHEDULED",
  "TECHNICIAN_ASSIGNED",
  // FS23 (technician work execution):
  "VISIT_STARTED",
  "VISIT_COMPLETED",
  "WORK_RESULT_RECORDED",
  "WORK_RESULT_UPDATED",
  // FS22 (on-site work agreement / approved scope):
  "WORK_ITEM_PROPOSED",
  "WORK_ITEM_DECIDED",
  // Technician part selection and invoicing (FS11/FS25):
  "DEVICE_PARTS_UPDATED",
  "INVOICE_ISSUED",
] as const;
export type VisitEventType = (typeof VISIT_EVENT_TYPES)[number];

/**
 * ISO-8601 with a mandatory explicit offset ("Z" or "+03:00"). An
 * offset-less wall-clock time is ambiguous (and nonexistent/duplicated
 * across DST changes), so it is rejected rather than guessed at.
 */
export const ISO_INSTANT_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;
