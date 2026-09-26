import { Schema, model, Types } from "mongoose";
import { VISIT_EVENT_TYPES, type VisitEventType } from "./visit.constants.js";

/** Append-only record of scheduling/assignment actions. No customer data. */
const visitEventSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
  visitId: { type: Schema.Types.ObjectId, ref: "Visit", required: true },
  requestId: { type: Schema.Types.ObjectId, ref: "ServiceRequest", required: true },
  type: { type: String, enum: VISIT_EVENT_TYPES, required: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  technicianId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  occurredAt: { type: Date, required: true },
});

visitEventSchema.index({ companyId: 1, visitId: 1, occurredAt: 1 });

export interface VisitEventDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  visitId: Types.ObjectId;
  requestId: Types.ObjectId;
  type: VisitEventType;
  actorId: Types.ObjectId;
  technicianId: Types.ObjectId;
  occurredAt: Date;
}

export const VisitEvent = model<VisitEventDocument>("VisitEvent", visitEventSchema);
