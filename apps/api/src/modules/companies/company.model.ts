import { Schema, model, type InferSchemaType } from "mongoose";
import { isValidTimeZone } from "../../lib/timezone.js";

/**
 * Minimal company record. FS02 only needs a company to exist as the
 * membership target sessions/users are validated against — richer company
 * fields (billing, settings, etc.) belong to whichever feature introduces
 * them.
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
  },
  { timestamps: true }
);

export type CompanyDocument = InferSchemaType<typeof companySchema>;

export const Company = model("Company", companySchema);
