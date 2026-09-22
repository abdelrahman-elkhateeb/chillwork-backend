import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/http-error.js";
import { Company } from "./company.model.js";

/**
 * MVP is single-tenant: every publicly-registered user belongs to this one
 * company. `DEMO_COMPANY_ID` is deliberately explicit, ops-provisioned
 * configuration rather than something this function creates itself —
 * registration must never have the side effect of silently minting a new
 * company. If it's unset, malformed, missing, or inactive, registration
 * fails safely instead (see docs/api.md "Company assignment").
 */
export async function resolveDemoCompany() {
  if (!env.DEMO_COMPANY_ID || !Types.ObjectId.isValid(env.DEMO_COMPANY_ID)) {
    throw HttpError.demoCompanyUnavailable();
  }

  const company = await Company.findById(env.DEMO_COMPANY_ID);
  if (!company || !company.isActive) {
    throw HttpError.demoCompanyUnavailable();
  }

  return company;
}
