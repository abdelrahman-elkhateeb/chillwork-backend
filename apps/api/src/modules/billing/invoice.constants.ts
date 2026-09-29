/**
 * FS25 — invoice constants.
 *
 * No-fix-no-fee: a REPAIRED device costs its fitted parts plus one labor
 * fee; a FAILED device costs nothing, even if parts were picked or work
 * was attempted.
 */
export const INVOICE_STATUSES = ["ISSUED", "CLOSED"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * UNPAID until FS26 records a payment; NOT_REQUIRED for a zero-total
 * invoice (every device failed), which is closed immediately with no
 * payment transaction of any kind.
 */
export const PAYMENT_STATES = ["UNPAID", "NOT_REQUIRED"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const INVOICE_REFERENCE_PREFIX = "INV-";
