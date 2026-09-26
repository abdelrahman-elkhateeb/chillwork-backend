import { Schema, model, Types } from "mongoose";
import { VISIT_STATUSES, WORK_TYPES, type VisitStatus, type WorkType } from "./visit.constants.js";

/**
 * One Visit covers many devices (`deviceIds` are the request's
 * `clientDeviceId`s — request devices are embedded and have no separate
 * id). `startAt`/`endAt` are UTC instants; `timezone` is the company's
 * IANA zone at booking time, kept so the visit can be presented in the
 * zone it was scheduled in even if the company later changes it.
 */
const visitSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    requestId: { type: Schema.Types.ObjectId, ref: "ServiceRequest", required: true },
    technicianId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    scheduledById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timezone: { type: String, required: true },
    deviceIds: { type: [String], required: true },
    workTypes: { type: [{ type: String, enum: WORK_TYPES }], required: true },
    status: { type: String, enum: VISIT_STATUSES, required: true },
  },
  { timestamps: true }
);

// Overlap/availability lookups: one technician's active visits in a window.
visitSchema.index({ companyId: 1, technicianId: 1, status: 1, startAt: 1, endAt: 1 });
visitSchema.index({ companyId: 1, requestId: 1, status: 1 });

export interface VisitDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  requestId: Types.ObjectId;
  technicianId: Types.ObjectId;
  scheduledById: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  timezone: string;
  deviceIds: string[];
  workTypes: WorkType[];
  status: VisitStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const Visit = model<VisitDocument>("Visit", visitSchema);
