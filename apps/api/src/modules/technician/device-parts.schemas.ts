import { z } from "zod";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";
import { MAX_DECISIONS_PER_REQUEST } from "./device-parts.constants.js";

export const MAX_PARTS_PER_DEVICE = 20;
export const MAX_PART_QUANTITY = 100;

/**
 * The full desired list of *currently open* (proposed) items for the
 * device; `[]` clears every open proposal. This never touches an already
 * -decided proposal — see device-parts.service.ts's `resolveItems`. Only
 * part ids and quantities — prices always come from the catalog, and any
 * extra field (a client-supplied `decision`, price or total) is silently
 * stripped like any other unknown key, matching this endpoint's existing
 * convention. Approval can only ever come from `recordPartDecisionsSchema`,
 * applied server-side by `recordPartDecisions` — there is no way to reach
 * an APPROVED state through this schema at all.
 */
export const setDevicePartsSchema = z.object({
  items: z
    .array(
      z.object({
        partId: z.string().regex(OBJECT_ID_PATTERN, "Invalid part id"),
        quantity: z.number().int("quantity must be an integer").min(1).max(MAX_PART_QUANTITY),
      })
    )
    .max(MAX_PARTS_PER_DEVICE)
    .refine((items) => new Set(items.map((item) => item.partId)).size === items.length, "Each part may appear only once"),
  version: z.number().int().min(0),
});

export type SetDevicePartsInput = z.infer<typeof setDevicePartsSchema>;

/**
 * `version` must be >= 1: proposals must already exist (created via
 * `setDevicePartsSchema`) before any can be decided.
 */
export const recordPartDecisionsSchema = z
  .object({
    version: z.number().int().min(1),
    decisions: z
      .array(
        z
          .object({
            proposalId: z.string().regex(OBJECT_ID_PATTERN, "Invalid id"),
            decision: z.enum(["APPROVED", "REJECTED"]),
          })
          .strict()
      )
      .min(1)
      .max(MAX_DECISIONS_PER_REQUEST)
      .refine(
        (decisions) => new Set(decisions.map((d) => d.proposalId)).size === decisions.length,
        "Each proposal can only be decided once per request"
      ),
  })
  .strict();

export type RecordPartDecisionsInput = z.infer<typeof recordPartDecisionsSchema>;
