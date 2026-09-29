import mongoose, { type Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { CompanySettingsAudit } from "./company-settings-audit.model.js";
import type { AuditedSettingsField, Currency } from "./company-settings.constants.js";
import type { UpdateCompanySettingsInput } from "./company-settings.schemas.js";
import { Company } from "./company.model.js";

export interface CompanySettingsAuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
}

export interface CompanySettings {
  name: string;
  contact: { phone: string | null; email: string | null };
  timezone: string;
  currency: Currency | null;
  laborFeeMinor: number | null;
}

interface CompanySettingsSource {
  name: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
  timezone: string;
  currency?: string | null;
  laborFeeMinor?: number | null;
}

/** Explicit allow-list mapper — never the raw document. */
export function toCompanySettings(company: CompanySettingsSource): CompanySettings {
  return {
    name: company.name,
    contact: { phone: company.contactPhone ?? null, email: company.contactEmail ?? null },
    timezone: company.timezone,
    currency: (company.currency ?? null) as Currency | null,
    laborFeeMinor: company.laborFeeMinor ?? null,
  };
}

async function loadCompany(companyId: Types.ObjectId, session?: mongoose.ClientSession) {
  const company = await Company.findById(companyId).session(session ?? null);
  if (!company) {
    // authenticate already proved membership of an active company, so this
    // only happens if the company was deleted mid-request.
    throw HttpError.notFound("Company not found");
  }
  return company;
}

export async function getCompanySettings(auth: CompanySettingsAuthContext): Promise<CompanySettings> {
  return toCompanySettings(await loadCompany(auth.companyId));
}

/**
 * The effective billing configuration, or `409 BILLING_NOT_CONFIGURED`.
 * Every flow that prices anything (catalog, part selection, invoicing)
 * goes through this, so none of them ever guesses a currency or fee.
 */
export async function requireBillingSettings(
  companyId: Types.ObjectId,
  session?: mongoose.ClientSession
): Promise<{ currency: Currency; laborFeeMinor: number }> {
  const company = await loadCompany(companyId, session);
  if (!company.currency || company.laborFeeMinor === null || company.laborFeeMinor === undefined) {
    throw HttpError.billingNotConfigured();
  }
  return { currency: company.currency as Currency, laborFeeMinor: company.laborFeeMinor };
}

function auditValue(value: string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Applies a PATCH and records one audit entry per changed pricing field,
 * in one transaction. The currency is locked once set: every catalog
 * price and stored snapshot is an amount of that currency's minor unit,
 * so switching it would silently reinterpret all of them. Changing the
 * labor fee is fine — invoices snapshot the fee at issuance, so existing
 * invoices never change.
 */
export async function updateCompanySettings(
  auth: CompanySettingsAuthContext,
  input: UpdateCompanySettingsInput
): Promise<CompanySettings> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const company = await loadCompany(auth.companyId, session);

      if (input.currency !== undefined && company.currency && company.currency !== input.currency) {
        throw HttpError.currencyLocked();
      }

      const audits: Array<{ field: AuditedSettingsField; previousValue: string | null; newValue: string | null }> = [];
      if (input.currency !== undefined && input.currency !== company.currency) {
        audits.push({ field: "currency", previousValue: auditValue(company.currency), newValue: input.currency });
      }
      if (input.laborFeeMinor !== undefined && input.laborFeeMinor !== company.laborFeeMinor) {
        audits.push({
          field: "laborFeeMinor",
          previousValue: auditValue(company.laborFeeMinor),
          newValue: auditValue(input.laborFeeMinor),
        });
      }

      const set: Record<string, unknown> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.timezone !== undefined) set.timezone = input.timezone;
      if (input.currency !== undefined) set.currency = input.currency;
      if (input.laborFeeMinor !== undefined) set.laborFeeMinor = input.laborFeeMinor;
      if (input.contact?.phone !== undefined) set.contactPhone = input.contact.phone;
      if (input.contact?.email !== undefined) set.contactEmail = input.contact.email;

      const updated = await Company.findOneAndUpdate(
        { _id: auth.companyId },
        { $set: set },
        { session, new: true, runValidators: true }
      );
      if (!updated) {
        throw HttpError.notFound("Company not found");
      }

      if (audits.length > 0) {
        const occurredAt = new Date();
        await CompanySettingsAudit.create(
          audits.map((audit) => ({ ...audit, companyId: auth.companyId, actorId: auth.userId, occurredAt })),
          { session, ordered: true }
        );
      }

      return toCompanySettings(updated);
    });
  } finally {
    await session.endSession();
  }
}
