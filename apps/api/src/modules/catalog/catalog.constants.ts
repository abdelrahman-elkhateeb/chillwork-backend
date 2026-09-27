/**
 * FS11 — parts catalog constants.
 *
 * Deviation from the FS11 ticket (decided 2026-09-27): the ticket asked
 * for a plain availability flag, but the product owner chose real stock
 * counts that are decremented when an invoice is issued. `inStock` in
 * every DTO is derived (`stockQuantity > 0`), never stored.
 */
export const MAX_PART_NAME_LENGTH = 120;
export const MAX_PART_DESCRIPTION_LENGTH = 500;
export const MAX_STOCK_QUANTITY = 1_000_000;
export const MAX_STOCK_ADJUSTMENT_NOTE_LENGTH = 300;
export const MAX_CATALOG_QUERY_LENGTH = 100;

export const CATALOG_DEFAULT_PAGE_SIZE = 20;
export const CATALOG_MAX_PAGE_SIZE = 100;
export const CATALOG_MAX_PAGE = 10_000;

export const STOCK_MOVEMENT_REASONS = ["ADMIN_ADJUSTMENT", "INVOICE_ISSUED"] as const;
export type StockMovementReason = (typeof STOCK_MOVEMENT_REASONS)[number];
