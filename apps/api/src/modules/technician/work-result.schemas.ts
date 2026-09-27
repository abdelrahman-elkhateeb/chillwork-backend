import { z } from "zod";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";
import { FAILURE_REASONS, MAX_FAILURE_NOTE_LENGTH } from "./work-result.constants.js";

export const visitIdParam = z.string().regex(OBJECT_ID_PATTERN, "Invalid id");

/**
 * A discriminated union, not one object with optional fields: REPAIRED
 * can never carry a failureReason/failureNote (zod strips them, matching
 * this repo's default-strip convention rather than silently accepting
 * and ignoring them), and FAILED must have a `failureReason` from the
 * fixed enum — never an arbitrary string. There is deliberately no
 * "no result" branch (see work-result.constants.ts).
 *
 * `version` is required on every write: 0 means "I believe no result
 * exists yet for this device"; otherwise it's the version the caller last
 * saw. See docs/api.md "Technician work execution (FS23)" for the exact
 * compare-and-set semantics.
 */
export const recordWorkResultSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("REPAIRED"),
    version: z.number().int().min(0),
  }),
  z.object({
    result: z.literal("FAILED"),
    failureReason: z.enum(FAILURE_REASONS),
    failureNote: z.string().trim().max(MAX_FAILURE_NOTE_LENGTH).optional(),
    version: z.number().int().min(0),
  }),
]);

export type RecordWorkResultInput = z.infer<typeof recordWorkResultSchema>;
