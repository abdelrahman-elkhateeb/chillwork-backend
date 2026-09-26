import { z } from "zod";
import { VISIT_STATUSES } from "../visits/visit.constants.js";
import { instant } from "../visits/visit.schemas.js";

export const TECHNICIAN_VISITS_DEFAULT_PAGE_SIZE = 20;
export const TECHNICIAN_VISITS_MAX_PAGE_SIZE = 100;
export const TECHNICIAN_VISITS_MAX_PAGE = 10_000;

/**
 * `.strict()` on purpose: docs/api.md requires unrecognized filter
 * parameters to be a VALIDATION_ERROR rather than silently ignored. That
 * also means a client-supplied `technicianId`/`companyId` is rejected
 * outright — the technician's identity comes only from `req.auth`.
 *
 * `from`/`to` reuse FS18's explicit-offset ISO-8601 parser (offset-less
 * local times are rejected) and are compared as UTC instants.
 */
export const technicianVisitsQuerySchema = z
  .object({
    from: instant.optional(),
    to: instant.optional(),
    status: z.enum(VISIT_STATUSES).optional(),
    page: z.coerce.number().int().min(1).max(TECHNICIAN_VISITS_MAX_PAGE).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(TECHNICIAN_VISITS_MAX_PAGE_SIZE)
      .default(TECHNICIAN_VISITS_DEFAULT_PAGE_SIZE),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.to.getTime() <= value.from.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be after from" });
    }
  });

export type TechnicianVisitsQuery = z.infer<typeof technicianVisitsQuerySchema>;
