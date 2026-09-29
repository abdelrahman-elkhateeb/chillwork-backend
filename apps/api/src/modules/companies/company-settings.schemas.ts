import { z } from "zod";
import { isValidTimeZone } from "../../lib/timezone.js";
import {
  MAX_COMPANY_NAME_LENGTH,
  MAX_CONTACT_EMAIL_LENGTH,
  MAX_MONEY_MINOR,
  SUPPORTED_CURRENCIES,
} from "./company-settings.constants.js";

// Same simplified E.164 rule as registration/requests (keep in sync by hand).
const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;

/**
 * Every field optional (PATCH semantics); at least one is required so an
 * empty body is an explicit error instead of a silent no-op. Unknown keys
 * (e.g. `companyId`) are stripped — the company is always `req.auth`'s.
 * `null` clears a contact field; it is not accepted for pricing fields,
 * which can be changed but never un-configured.
 */
export const updateCompanySettingsSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(MAX_COMPANY_NAME_LENGTH).optional(),
    contact: z
      .object({
        phone: z
          .string()
          .trim()
          .transform((value) => value.replace(/[\s\-()]/g, ""))
          .refine((value) => PHONE_REGEX.test(value), "Invalid phone number")
          .nullable()
          .optional(),
        email: z
          .string()
          .trim()
          .toLowerCase()
          .email("Invalid email address")
          .max(MAX_CONTACT_EMAIL_LENGTH)
          .nullable()
          .optional(),
      })
      .optional(),
    timezone: z.string().refine(isValidTimeZone, "timezone must be a valid IANA timezone").optional(),
    currency: z.enum(SUPPORTED_CURRENCIES).optional(),
    laborFeeMinor: z.number().int("laborFeeMinor must be an integer").min(0).max(MAX_MONEY_MINOR).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "At least one setting is required");

export type UpdateCompanySettingsInput = z.infer<typeof updateCompanySettingsSchema>;
