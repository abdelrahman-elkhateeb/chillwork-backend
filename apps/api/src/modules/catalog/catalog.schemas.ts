import { z } from "zod";
import { MAX_MONEY_MINOR } from "../companies/company-settings.constants.js";
import {
  CATALOG_DEFAULT_PAGE_SIZE,
  CATALOG_MAX_PAGE,
  CATALOG_MAX_PAGE_SIZE,
  MAX_CATALOG_QUERY_LENGTH,
  MAX_PART_DESCRIPTION_LENGTH,
  MAX_PART_NAME_LENGTH,
  MAX_STOCK_ADJUSTMENT_NOTE_LENGTH,
  MAX_STOCK_QUANTITY,
} from "./catalog.constants.js";

const name = z.string().trim().min(1, "name is required").max(MAX_PART_NAME_LENGTH);
const description = z.string().trim().max(MAX_PART_DESCRIPTION_LENGTH).nullable();
const unitPriceMinor = z.number().int("unitPriceMinor must be an integer").min(0).max(MAX_MONEY_MINOR);

/** "true"/"false" only — query strings are never truthy-coerced ("0" is not false). */
const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

const paging = {
  page: z.coerce.number().int().min(1).max(CATALOG_MAX_PAGE).default(1),
  pageSize: z.coerce.number().int().min(1).max(CATALOG_MAX_PAGE_SIZE).default(CATALOG_DEFAULT_PAGE_SIZE),
};

/**
 * `stockQuantity` is only settable at creation. Afterwards stock changes
 * go through stock adjustments (a delta, applied atomically), so an admin
 * editing a part can never overwrite a decrement an invoice made a moment
 * earlier.
 */
export const createPartSchema = z.object({
  name,
  description: description.optional(),
  unitPriceMinor,
  stockQuantity: z.number().int().min(0).max(MAX_STOCK_QUANTITY).default(0),
  isActive: z.boolean().default(true),
});
export type CreatePartInput = z.infer<typeof createPartSchema>;

export const updatePartSchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
    unitPriceMinor: unitPriceMinor.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "At least one field is required");
export type UpdatePartInput = z.infer<typeof updatePartSchema>;

export const stockAdjustmentSchema = z.object({
  delta: z
    .number()
    .int("delta must be an integer")
    .min(-MAX_STOCK_QUANTITY)
    .max(MAX_STOCK_QUANTITY)
    .refine((value) => value !== 0, "delta must not be zero"),
  note: z.string().trim().max(MAX_STOCK_ADJUSTMENT_NOTE_LENGTH).optional(),
});
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

/** `.strict()`: unrecognized filters are a VALIDATION_ERROR (docs/api.md "Pagination"). */
export const catalogQuerySchema = z
  .object({ q: z.string().trim().max(MAX_CATALOG_QUERY_LENGTH).optional(), available: booleanQuery.optional(), ...paging })
  .strict();
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

export const adminPartsQuerySchema = z
  .object({
    q: z.string().trim().max(MAX_CATALOG_QUERY_LENGTH).optional(),
    available: booleanQuery.optional(),
    isActive: booleanQuery.optional(),
    ...paging,
  })
  .strict();
export type AdminPartsQuery = z.infer<typeof adminPartsQuerySchema>;
