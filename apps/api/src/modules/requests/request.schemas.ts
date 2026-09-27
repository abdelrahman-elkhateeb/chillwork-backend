import { z } from "zod";
import {
  MAX_CLIENT_DEVICE_ID_LENGTH,
  MAX_DEVICES_PER_REQUEST,
  MAX_ORIGINAL_DESCRIPTION_LENGTH,
} from "../ai/gemini.constants.js";
import {
  CONTACT_PHONE_REGEX,
  MAX_ADDRESS_LENGTH,
  MAX_DEVICE_BRAND_LENGTH,
  MAX_DEVICE_LABEL_LENGTH,
  MAX_DEVICE_MODEL_LENGTH,
} from "./request.constants.js";

/**
 * Bounds are deliberately shared with FS14 (`MAX_DEVICES_PER_REQUEST`,
 * `MAX_ORIGINAL_DESCRIPTION_LENGTH`, `MAX_CLIENT_DEVICE_ID_LENGTH`)
 * rather than redefined here — FS15 must never accept something FS14's
 * own schema would then reject, and vice versa.
 */
export const deviceInputSchema = z.object({
  clientDeviceId: z.string().min(1, "clientDeviceId is required").max(MAX_CLIENT_DEVICE_ID_LENGTH),
  label: z.string().trim().min(1, "label is required").max(MAX_DEVICE_LABEL_LENGTH),
  brand: z.string().trim().max(MAX_DEVICE_BRAND_LENGTH).optional(),
  model: z.string().trim().max(MAX_DEVICE_MODEL_LENGTH).optional(),
  // No .trim()/.transform() — must remain byte-for-byte what the
  // customer submitted (see docs/api.md "Original description
  // preservation"). Same non-mutating "required" check FS14 uses.
  originalDescription: z
    .string()
    .max(MAX_ORIGINAL_DESCRIPTION_LENGTH, "originalDescription is too long")
    .refine((value) => value.trim().length > 0, "originalDescription is required"),
  // No photoIds: photo attachments (FS12/FS13) were cancelled for the MVP.
  // A client that still sends one has it stripped like any unknown key.
});

export type DeviceInput = z.infer<typeof deviceInputSchema>;

export const createRequestSchema = z.object({
  address: z.string().trim().min(1, "address is required").max(MAX_ADDRESS_LENGTH),
  contactPhone: z
    .string()
    .trim()
    .min(1, "contactPhone is required")
    .transform((value) => value.replace(/[\s\-()]/g, ""))
    .refine((value) => CONTACT_PHONE_REGEX.test(value), "Invalid phone number"),
  devices: z
    .array(deviceInputSchema)
    .min(1, "At least one device is required")
    .max(MAX_DEVICES_PER_REQUEST, `At most ${MAX_DEVICES_PER_REQUEST} devices per request`)
    .refine(
      (devices) => new Set(devices.map((d) => d.clientDeviceId)).size === devices.length,
      "clientDeviceId must be unique within a single request"
    ),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
