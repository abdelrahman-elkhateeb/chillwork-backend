import { z } from "zod";
import { MAX_CLIENT_DEVICE_ID_LENGTH, MAX_DEVICES_PER_REQUEST } from "../ai/gemini.constants.js";
import {
  DEFAULT_WORK_TYPES,
  ISO_INSTANT_WITH_OFFSET,
  MAX_AVAILABILITY_WINDOW_MS,
  MAX_VISIT_DURATION_MS,
  MIN_VISIT_DURATION_MS,
  OBJECT_ID_PATTERN,
  WORK_TYPES,
} from "./visit.constants.js";

/** Explicit-offset ISO-8601 string -> the corresponding UTC `Date`. */
const instant = z
  .string()
  .regex(
    ISO_INSTANT_WITH_OFFSET,
    "Must be an ISO-8601 timestamp with an explicit offset (e.g. 2026-09-27T10:00:00+03:00 or ...Z)"
  )
  .transform((value, ctx) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Not a valid date/time" });
      return z.NEVER;
    }
    return date;
  });

export const objectIdParam = z.string().regex(OBJECT_ID_PATTERN, "Invalid id");

export const createVisitSchema = z
  .object({
    technicianId: objectIdParam,
    startAt: instant,
    endAt: instant,
    deviceIds: z
      .array(z.string().min(1).max(MAX_CLIENT_DEVICE_ID_LENGTH))
      .min(1, "At least one device is required")
      .max(MAX_DEVICES_PER_REQUEST)
      .refine((ids) => new Set(ids).size === ids.length, "deviceIds must be unique"),
    workTypes: z
      .array(z.enum(WORK_TYPES))
      .min(1)
      .max(WORK_TYPES.length)
      .refine((types) => new Set(types).size === types.length, "workTypes must be unique")
      .default([...DEFAULT_WORK_TYPES]),
  })
  .superRefine((value, ctx) => {
    const duration = value.endAt.getTime() - value.startAt.getTime();
    if (duration <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "endAt must be after startAt" });
    } else if (duration < MIN_VISIT_DURATION_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "Visit is shorter than the minimum duration" });
    } else if (duration > MAX_VISIT_DURATION_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endAt"], message: "Visit is longer than the maximum duration" });
    }
  });

export type CreateVisitInput = z.infer<typeof createVisitSchema>;

export const availabilityQuerySchema = z
  .object({ from: instant, to: instant })
  .superRefine((value, ctx) => {
    const window = value.to.getTime() - value.from.getTime();
    if (window <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be after from" });
    } else if (window > MAX_AVAILABILITY_WINDOW_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Requested window is too large" });
    }
  });

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
