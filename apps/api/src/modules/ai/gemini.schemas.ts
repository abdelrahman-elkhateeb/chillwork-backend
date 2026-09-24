import { z } from "zod";
import {
  MAX_CLIENT_DEVICE_ID_LENGTH,
  MAX_DEVICES_PER_REQUEST,
  MAX_EQUIPMENT_FIELDS,
  MAX_EQUIPMENT_FIELD_KEY_LENGTH,
  MAX_EQUIPMENT_FIELD_VALUE_LENGTH,
  MAX_LIST_ITEMS,
  MAX_LIST_ITEM_LENGTH,
  MAX_ORIGINAL_DESCRIPTION_LENGTH,
  MAX_SUMMARY_LENGTH,
} from "./gemini.constants.js";

/**
 * No canonical Equipment domain model exists yet (FS03 hasn't been built
 * in this repo). Rather than invent one, this accepts a small, bounded,
 * flat key-value bag — just enough structure for the prompt to safely
 * serialize, without this service presuming field names a future FS03
 * model might not actually have.
 */
export const equipmentInputSchema = z
  .record(
    z.string().max(MAX_EQUIPMENT_FIELD_KEY_LENGTH),
    z.union([z.string().max(MAX_EQUIPMENT_FIELD_VALUE_LENGTH), z.number(), z.boolean(), z.null()])
  )
  .refine((obj) => Object.keys(obj).length <= MAX_EQUIPMENT_FIELDS, {
    message: `equipment may have at most ${MAX_EQUIPMENT_FIELDS} fields`,
  })
  .optional();

export type EquipmentInput = z.infer<typeof equipmentInputSchema>;

/**
 * `originalDescription` deliberately has NO `.trim()`/`.transform()` — any
 * such transform would change the value zod hands back, and this exact
 * string must remain available to the caller byte-for-byte (see
 * docs/api.md "Original description preservation"). Bounding its length
 * is a read-only check, not a mutation.
 */
export const deviceInputSchema = z.object({
  clientDeviceId: z.string().min(1, "clientDeviceId is required").max(MAX_CLIENT_DEVICE_ID_LENGTH),
  originalDescription: z
    .string()
    .max(MAX_ORIGINAL_DESCRIPTION_LENGTH, "originalDescription is too long")
    // .refine() only checks the value, it never transforms what's
    // returned — unlike .min(1), which would accept a whitespace-only
    // string as "non-empty", this actually rejects one, while the value
    // handed back to the caller remains byte-for-byte untouched.
    .refine((value) => value.trim().length > 0, "originalDescription is required"),
  equipment: equipmentInputSchema,
});

export type DeviceInput = z.infer<typeof deviceInputSchema>;

export const analyzeDevicesInputSchema = z.object({
  devices: z
    .array(deviceInputSchema)
    .min(1, "At least one device is required")
    .max(MAX_DEVICES_PER_REQUEST, `At most ${MAX_DEVICES_PER_REQUEST} devices per request`)
    .refine(
      (devices) => new Set(devices.map((d) => d.clientDeviceId)).size === devices.length,
      "clientDeviceId must be unique within a single request"
    ),
});

export type AnalyzeDevicesInput = z.infer<typeof analyzeDevicesInputSchema>;

// ---------------------------------------------------------------------------
// Untrusted provider output. Gemini's JSON is parsed and validated against
// this before anything from it is trusted — see docs/api.md "AI output
// validation". Every field is explicitly bounded; nothing here is
// effectively unlimited.
// ---------------------------------------------------------------------------

const boundedString = (max: number) => z.string().max(max);
const boundedList = (maxItems: number, maxItemLength: number) =>
  z.array(boundedString(maxItemLength)).max(maxItems);

export const deviceAnalysisSchema = z.object({
  summary: boundedString(MAX_SUMMARY_LENGTH),
  possibleCauses: boundedList(MAX_LIST_ITEMS, MAX_LIST_ITEM_LENGTH),
  missingInformation: boundedList(MAX_LIST_ITEMS, MAX_LIST_ITEM_LENGTH),
  inspectionQuestions: boundedList(MAX_LIST_ITEMS, MAX_LIST_ITEM_LENGTH),
});

export type DeviceAnalysis = z.infer<typeof deviceAnalysisSchema>;

/** One entry per device, self-identifying via the echoed `clientDeviceId`. */
export const geminiDeviceResultSchema = deviceAnalysisSchema.extend({
  clientDeviceId: z.string().min(1).max(MAX_CLIENT_DEVICE_ID_LENGTH),
});

export const geminiOutputSchema = z.object({
  devices: z.array(geminiDeviceResultSchema).max(MAX_DEVICES_PER_REQUEST),
});

export type GeminiOutput = z.infer<typeof geminiOutputSchema>;

/**
 * A hand-maintained JSON Schema mirror of `geminiOutputSchema`, sent to
 * Gemini's structured-output `response_format.schema` so the provider is
 * instructed to only ever produce this shape. Zod v3 has no built-in JSON
 * Schema export (adding `zod-to-json-schema` for one call site isn't
 * worth a new dependency), so this must be kept in sync by hand whenever
 * `geminiOutputSchema` changes. This is a *request hint* to the
 * provider, not a substitute for the server-side validation above — the
 * response is re-validated against `geminiOutputSchema` regardless of
 * whether the provider honored it.
 */
export const GEMINI_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    devices: {
      type: "array",
      maxItems: MAX_DEVICES_PER_REQUEST,
      items: {
        type: "object",
        properties: {
          clientDeviceId: { type: "string", maxLength: MAX_CLIENT_DEVICE_ID_LENGTH },
          summary: { type: "string", maxLength: MAX_SUMMARY_LENGTH },
          possibleCauses: {
            type: "array",
            maxItems: MAX_LIST_ITEMS,
            items: { type: "string", maxLength: MAX_LIST_ITEM_LENGTH },
          },
          missingInformation: {
            type: "array",
            maxItems: MAX_LIST_ITEMS,
            items: { type: "string", maxLength: MAX_LIST_ITEM_LENGTH },
          },
          inspectionQuestions: {
            type: "array",
            maxItems: MAX_LIST_ITEMS,
            items: { type: "string", maxLength: MAX_LIST_ITEM_LENGTH },
          },
        },
        required: ["clientDeviceId", "summary", "possibleCauses", "missingInformation", "inspectionQuestions"],
      },
    },
  },
  required: ["devices"],
} as const;

/** The outer HTTP response envelope for the Interactions API. */
export const geminiWireEnvelopeSchema = z.object({
  interaction: z.object({
    output_text: z.string(),
  }),
});
