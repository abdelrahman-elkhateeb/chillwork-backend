import { z } from "zod";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";

export const MAX_PARTS_PER_DEVICE = 20;
export const MAX_PART_QUANTITY = 100;

/**
 * The full desired list for the device (PUT replaces it); `[]` clears it.
 * Only part ids and quantities — prices always come from the catalog, a
 * client-supplied price or total is stripped like any unknown key.
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
