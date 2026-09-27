import { Schema, model, type InferSchemaType } from "mongoose";
import { isValidTimeZone } from "../../lib/timezone.js";
import { SUPPORTED_CURRENCIES } from "./company-settings.constants.js";

/**
 * Company record. FS02 only needed a company to exist as the membership
 * target sessions/users are validated against; FS18 added `timezone` and
 * FS10 adds contact and billing settings.
 */
const companySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, required: true, default: true },
    // IANA timezone the company schedules in (FS18). Instants are always
    // persisted as UTC; this is the zone used to present/interpret them.
    // Companies created before this field existed hydrate as "UTC".
    timezone: {
      type: String,
      required: true,
      default: "UTC",
      validate: { validator: isValidTimeZone, message: "timezone must be a valid IANA timezone" },
    },
    // FS10 settings. All nullable: a company exists before an admin has
    // configured billing, and pricing refuses to run (409
    // BILLING_NOT_CONFIGURED) rather than guess a currency or fee.
    contactPhone: { type: String, default: null },
    contactEmail: { type: String, default: null },
    // ISO 4217 code; every catalog price and fee is an integer amount of
    // this currency's minor unit. Locked once set (see
    // company-settings.service.ts).
    currency: { type: String, enum: [...SUPPORTED_CURRENCIES, null], default: null },
    // Fixed labor fee charged once per REPAIRED device, in minor units.
    laborFeeMinor: { type: Number, default: null, min: 0 },
  },
  { timestamps: true }
);

export type CompanyDocument = InferSchemaType<typeof companySchema>;

export const Company = model("Company", companySchema);
