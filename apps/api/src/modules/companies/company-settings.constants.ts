/**
 * FS10 — company settings constants.
 *
 * Every supported currency has a 2-digit minor unit (100 minor = 1 major),
 * so all money in this API is an integer count of minor units and no
 * rounding ever happens: totals are only ever sums and integer multiples
 * of stored minor amounts. Adding a currency with a different exponent
 * would need that rule revisited first.
 */
export const SUPPORTED_CURRENCIES = ["EGP", "SAR", "AED", "USD", "EUR"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Upper bound for any single minor-unit amount (fee or unit price): 10,000,000.00. */
export const MAX_MONEY_MINOR = 1_000_000_000;

export const MAX_COMPANY_NAME_LENGTH = 120;
export const MAX_CONTACT_EMAIL_LENGTH = 254;

export const COMPANY_SETTINGS_AUDIT_FIELDS = ["currency", "laborFeeMinor"] as const;
export type AuditedSettingsField = (typeof COMPANY_SETTINGS_AUDIT_FIELDS)[number];
