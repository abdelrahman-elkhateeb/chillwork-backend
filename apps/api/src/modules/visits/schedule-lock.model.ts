import { Schema, model, Types } from "mongoose";

/**
 * MongoDB has no range-exclusion constraint, and a transaction that just
 * "reads for overlap then inserts" does NOT serialize two bookings: under
 * snapshot isolation both can read "no conflict" and both commit. So
 * every booking first writes (`$inc`) the lock document of each resource
 * it touches — one per technician, one per request — as the very first
 * operation of its transaction. Two transactions touching the same
 * resource therefore write the same document, MongoDB aborts one with a
 * transient write-conflict, and the driver retries it on a fresh
 * snapshot where the overlap check sees the winner's committed visit.
 * Arbitrary start/end times are preserved (no slot discretization). See
 * docs/api.md "Scheduling concurrency".
 */
const scheduleLockSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
  key: { type: String, required: true },
  version: { type: Number, required: true, default: 0 },
});

scheduleLockSchema.index({ companyId: 1, key: 1 }, { unique: true });

export interface ScheduleLockDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  key: string;
  version: number;
}

export const ScheduleLock = model<ScheduleLockDocument>("ScheduleLock", scheduleLockSchema);
