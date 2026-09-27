import { Schema, model, Types } from "mongoose";
import { COMPANY_SETTINGS_AUDIT_FIELDS, type AuditedSettingsField } from "./company-settings.constants.js";

/**
 * Append-only record of pricing-relevant settings changes (FS10: "audit
 * pricing changes"). One document per changed field per PATCH; values are
 * stored as strings so a currency code and a minor-unit amount share one
 * shape. No endpoint reads it yet — it exists for support/review.
 */
const companySettingsAuditSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  field: { type: String, enum: COMPANY_SETTINGS_AUDIT_FIELDS, required: true },
  previousValue: { type: String, default: null },
  newValue: { type: String, default: null },
  occurredAt: { type: Date, required: true },
});

companySettingsAuditSchema.index({ companyId: 1, occurredAt: 1 });

export interface CompanySettingsAuditDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  actorId: Types.ObjectId;
  field: AuditedSettingsField;
  previousValue: string | null;
  newValue: string | null;
  occurredAt: Date;
}

export const CompanySettingsAudit = model<CompanySettingsAuditDocument>(
  "CompanySettingsAudit",
  companySettingsAuditSchema
);
