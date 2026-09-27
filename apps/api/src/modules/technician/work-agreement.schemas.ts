import { z } from "zod";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";
import {
  MAX_DECISIONS_PER_REQUEST,
  MAX_ITEM_DESCRIPTION_LENGTH,
  MAX_ITEMS_PER_PROPOSAL,
  MAX_PART_IDENTIFIER_LENGTH,
  MAX_QUANTITY,
  MAX_UNIT_PRICE_MINOR,
  WORK_ITEM_CATEGORIES,
} from "./work-agreement.constants.js";

export const visitIdParam = z.string().regex(OBJECT_ID_PATTERN, "Invalid id");

/**
 * Deliberately has no `decision` field at all — `.strict()` means a
 * client-supplied `decision`/`approved` would be a VALIDATION_ERROR, not a
 * silently-ignored extra key. Approval can only ever come from
 * `recordDecisionsSchema`, applied server-side by `recordDecisions` (see
 * work-agreement.service.ts). The server computes `estimatedTotalMinor` —
 * there is no `total`/`estimatedTotalMinor` input field to trust or not
 * trust; it doesn't exist on the wire.
 */
const proposedItemSchema = z
  .object({
    clientDeviceId: z.string().min(1).max(200).optional(),
    category: z.enum(WORK_ITEM_CATEGORIES),
    description: z.string().trim().min(1).max(MAX_ITEM_DESCRIPTION_LENGTH),
    partIdentifier: z.string().trim().min(1).max(MAX_PART_IDENTIFIER_LENGTH).optional(),
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
    unitPriceMinor: z.number().int().min(0).max(MAX_UNIT_PRICE_MINOR),
  })
  .strict();

/**
 * `version` follows WorkResult's convention: 0 means "I believe no
 * agreement exists yet for this visit" (creates it); otherwise it must be
 * the version last read. See docs/api.md "On-site work agreement (FS22)".
 */
export const proposeWorkItemsSchema = z
  .object({
    version: z.number().int().min(0),
    items: z.array(proposedItemSchema).min(1).max(MAX_ITEMS_PER_PROPOSAL),
  })
  .strict();

export type ProposeWorkItemsInput = z.infer<typeof proposeWorkItemsSchema>;

/**
 * `version` must be >= 1 here: you cannot decide on items of an agreement
 * that (by definition of version 0) does not exist yet.
 */
export const recordDecisionsSchema = z
  .object({
    version: z.number().int().min(1),
    decisions: z
      .array(
        z
          .object({
            itemId: z.string().regex(OBJECT_ID_PATTERN, "Invalid id"),
            decision: z.enum(["APPROVED", "REJECTED"]),
          })
          .strict()
      )
      .min(1)
      .max(MAX_DECISIONS_PER_REQUEST)
      .refine((decisions) => new Set(decisions.map((d) => d.itemId)).size === decisions.length, {
        message: "Each item can only be decided once per request",
      }),
  })
  .strict();

export type RecordDecisionsInput = z.infer<typeof recordDecisionsSchema>;
