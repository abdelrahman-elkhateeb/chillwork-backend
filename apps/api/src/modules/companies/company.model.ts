import { Schema, model, type InferSchemaType } from "mongoose";

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
  },
  { timestamps: true }
);

export type CompanyDocument = InferSchemaType<typeof companySchema>;

export const Company = model("Company", companySchema);
