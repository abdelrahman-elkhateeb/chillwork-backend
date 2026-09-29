import { z } from "zod";
import { SERVICE_REQUEST_STATUSES } from "./request.constants.js";

export const ADMIN_REQUESTS_DEFAULT_PAGE_SIZE = 20;
export const ADMIN_REQUESTS_MAX_PAGE_SIZE = 100;
export const ADMIN_REQUESTS_MAX_PAGE = 10_000;
export const MAX_ADMIN_REQUEST_SEARCH_LENGTH = 100;

/**
 * `.strict()`: unknown filters are a VALIDATION_ERROR (docs/api.md
 * "Pagination"). `search` matches a reference prefix or the customer's
 * name/email/phone — see admin-request.service.ts.
 */
export const adminRequestsQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(MAX_ADMIN_REQUEST_SEARCH_LENGTH).optional(),
    status: z.enum(SERVICE_REQUEST_STATUSES).optional(),
    page: z.coerce.number().int().min(1).max(ADMIN_REQUESTS_MAX_PAGE).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_REQUESTS_MAX_PAGE_SIZE)
      .default(ADMIN_REQUESTS_DEFAULT_PAGE_SIZE),
  })
  .strict();

export type AdminRequestsQuery = z.infer<typeof adminRequestsQuerySchema>;
