/**
 * FS22 — on-site work agreement / approved scope.
 *
 * There is no online customer approval page and no Quote/Invoice model in
 * this repository: the customer's decision is recorded on-site, by the
 * technician, during the visit (see docs/api.md "On-site work agreement
 * (FS22)"). This module produces the "approved scope" that FS23 (actual
 * work) and, later, FS25 (invoice) consume — it never itself bills or
 * pays anything.
 */

/** What kind of item a proposal is. Kept small on purpose — this is not a parts catalog (FS11 does not exist). */
export const WORK_ITEM_CATEGORIES = ["PART_REPLACEMENT", "LABOR", "MAINTENANCE", "OTHER"] as const;
export type WorkItemCategory = (typeof WORK_ITEM_CATEGORIES)[number];

/**
 * PROPOSED is the only state the server ever assigns at creation; a client
 * can never submit `decision` directly on a proposal (see
 * work-agreement.schemas.ts) — only `recordDecisions` can move an item to
 * APPROVED or REJECTED, and only once, from PROPOSED (see
 * work-agreement.service.ts). There is no fourth state and no reversal:
 * additional/changed work is always a *new* proposed item, never a mutated
 * old one (see docs/api.md "Scope changes").
 */
export const WORK_ITEM_DECISIONS = ["PROPOSED", "APPROVED", "REJECTED"] as const;
export type WorkItemDecision = (typeof WORK_ITEM_DECISIONS)[number];

export const MAX_ITEMS_PER_PROPOSAL = 20;
export const MAX_DECISIONS_PER_REQUEST = 20;
export const MAX_ITEM_DESCRIPTION_LENGTH = 500;
export const MAX_PART_IDENTIFIER_LENGTH = 200;
export const MAX_QUANTITY = 1000;
// Integer minor units (e.g. piastres), never floating point. 100,000,000
// minor units is 1,000,000.00 in major units — comfortably above any
// plausible single line item, while still bounding abuse/overflow.
export const MAX_UNIT_PRICE_MINOR = 100_000_000;

/**
 * No Company.currency field exists yet (FS10 — company settings — does
 * not exist in this repository). Every agreement uses this fixed default
 * until FS10 introduces a real per-company currency; it is never
 * client-settable. See docs/api.md "Money" for this documented limitation.
 */
export const DEFAULT_CURRENCY = "EGP";
