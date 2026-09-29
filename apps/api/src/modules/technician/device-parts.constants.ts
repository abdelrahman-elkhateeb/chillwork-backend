/**
 * FS22/FS11 reconciliation — device-part proposal decisions.
 *
 * DeviceParts is now the single source of truth for catalog-part
 * proposals, customer decisions and accepted price snapshots (see
 * device-parts.model.ts). `WorkAgreement` (technician/work-agreement.*)
 * is deprecated: it is no longer consulted by FS23 or FS25.
 *
 * PROPOSED is the only state a new proposal is ever created in — a
 * client can never submit `decision` directly (see
 * device-parts.schemas.ts). Only `recordPartDecisions` can move a
 * proposal to APPROVED or REJECTED, once, from PROPOSED. There is no
 * reversal: additional or changed work is always a *new* proposal (a new
 * `proposalId`), never a mutated old one — see device-parts.service.ts.
 */
export const DEVICE_PART_DECISIONS = ["PROPOSED", "APPROVED", "REJECTED"] as const;
export type DevicePartDecision = (typeof DEVICE_PART_DECISIONS)[number];

export const MAX_DECISIONS_PER_REQUEST = 20;
