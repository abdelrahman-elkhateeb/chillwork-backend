import { z } from "zod";
import { SERVICE_REQUEST_STATUSES } from "./request.constants.js";

export const CUSTOMER_REQUESTS_DEFAULT_PAGE_SIZE = 20;
export const CUSTOMER_REQUESTS_MAX_PAGE_SIZE = 100;
export const CUSTOMER_REQUESTS_MAX_PAGE = 10_000;

/** `.strict()`: unknown filters (including customerId/companyId) are a VALIDATION_ERROR. */
export const customerRequestsQuerySchema = z
  .object({
    status: z.enum(SERVICE_REQUEST_STATUSES).optional(),
    page: z.coerce.number().int().min(1).max(CUSTOMER_REQUESTS_MAX_PAGE).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(CUSTOMER_REQUESTS_MAX_PAGE_SIZE)
      .default(CUSTOMER_REQUESTS_DEFAULT_PAGE_SIZE),
  })
  .strict();

export type CustomerRequestsQuery = z.infer<typeof customerRequestsQuerySchema>;
