import { Schema, model, Types } from "mongoose";
import { FAILURE_REASONS, WORK_RESULTS, type FailureReason, type WorkResultValue } from "./work-result.constants.js";

/**
 * One document per (visit, device) — the durable record of what actually
 * happened, independent of what was proposed/approved. `version` is a
 * client-facing optimistic-concurrency counter (never Mongoose's internal
 * `__v`): it starts at 0 on creation and is incremented by exactly 1 on
 * every accepted write — see work-result.service.ts for the
 * compare-and-set update this backs.
 *
 * No cost/price/billable field: FS23 records outcomes only. A later
 * billing feature reads this collection; it is not written here.
 */
const workResultSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    visitId: { type: Schema.Types.ObjectId, ref: "Visit", required: true },
    requestId: { type: Schema.Types.ObjectId, ref: "ServiceRequest", required: true },
    clientDeviceId: { type: String, required: true },
    result: { type: String, enum: WORK_RESULTS, required: true },
    // Required when result === "FAILED", null when result === "REPAIRED"
    // — enforced by work-result.schemas.ts, not by the DB.
    failureReason: { type: String, enum: FAILURE_REASONS, default: null },
    failureNote: { type: String, default: null },
    version: { type: Number, required: true, default: 0 },
    recordedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// One result per device per visit; also the natural lookup for "all
// results for this visit" (company-scoped, matching every other index in
// this codebase).
workResultSchema.index({ companyId: 1, visitId: 1, clientDeviceId: 1 }, { unique: true });

export interface WorkResultDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  visitId: Types.ObjectId;
  requestId: Types.ObjectId;
  clientDeviceId: string;
  result: WorkResultValue;
  failureReason: FailureReason | null;
  failureNote: string | null;
  version: number;
  recordedById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const WorkResult = model<WorkResultDocument>("WorkResult", workResultSchema);
