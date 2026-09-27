import { Schema, model, Types } from "mongoose";
import {
  DEFAULT_CURRENCY,
  WORK_ITEM_CATEGORIES,
  WORK_ITEM_DECISIONS,
  type WorkItemCategory,
  type WorkItemDecision,
} from "./work-agreement.constants.js";

/**
 * One item ever proposed for this visit. Items are never deleted and a
 * decided item's `decision`/`decidedAt`/`decidedById` are never rewritten
 * (enforced in work-agreement.service.ts, not by the DB) — that is what
 * keeps the whole document an auditable history rather than a mutable
 * "current state" blob. `clientDeviceId` is null for a visit-level item
 * (e.g. a general call-out fee) that is not about one specific device.
 *
 * `estimatedTotalMinor` is always `quantity * unitPriceMinor`, computed
 * server-side at proposal time — never trusted from the client.
 */
const workItemSchema = new Schema(
  {
    clientDeviceId: { type: String, default: null },
    category: { type: String, enum: WORK_ITEM_CATEGORIES, required: true },
    description: { type: String, required: true },
    partIdentifier: { type: String, default: null },
    quantity: { type: Number, required: true },
    unitPriceMinor: { type: Number, required: true },
    estimatedTotalMinor: { type: Number, required: true },
    currency: { type: String, required: true, default: DEFAULT_CURRENCY },
    decision: { type: String, enum: WORK_ITEM_DECISIONS, required: true, default: "PROPOSED" },
    proposedAt: { type: Date, required: true },
    proposedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    decidedAt: { type: Date, default: null },
    decidedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: true }
);

export interface WorkItemDocument {
  _id: Types.ObjectId;
  clientDeviceId: string | null;
  category: WorkItemCategory;
  description: string;
  partIdentifier: string | null;
  quantity: number;
  unitPriceMinor: number;
  estimatedTotalMinor: number;
  currency: string;
  decision: WorkItemDecision;
  proposedAt: Date;
  proposedById: Types.ObjectId;
  decidedAt: Date | null;
  decidedById: Types.ObjectId | null;
}

/**
 * One document per visit — the full proposed/approved scope for that
 * visit's on-site agreement. `version` is a client-facing optimistic-
 * concurrency counter (never Mongoose's internal `__v`), following the
 * same convention as WorkResult.version: it starts at 0 (no agreement
 * exists yet), and every accepted write — proposing new items or
 * recording decisions — increments it by exactly 1. This single counter
 * is what the business "Agreement v1 / v2 / ..." language maps to: each
 * version is a snapshot of the whole document after one accepted change.
 *
 * There is deliberately one WorkAgreement per visit, not per device: the
 * customer agrees to a batch of items together, on-site, in one
 * conversation — splitting this per device would not match how the
 * agreement actually happens.
 */
const workAgreementSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    visitId: { type: Schema.Types.ObjectId, ref: "Visit", required: true },
    requestId: { type: Schema.Types.ObjectId, ref: "ServiceRequest", required: true },
    version: { type: Number, required: true, default: 0 },
    items: { type: [workItemSchema], required: true, default: [] },
  },
  { timestamps: true }
);

// One agreement per visit; also the natural lookup for "this visit's
// current scope" (company-scoped, matching every other index in this
// codebase).
workAgreementSchema.index({ companyId: 1, visitId: 1 }, { unique: true });

export interface WorkAgreementDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  visitId: Types.ObjectId;
  requestId: Types.ObjectId;
  version: number;
  items: Types.DocumentArray<WorkItemDocument>;
  createdAt: Date;
  updatedAt: Date;
}

export const WorkAgreement = model<WorkAgreementDocument>("WorkAgreement", workAgreementSchema);
