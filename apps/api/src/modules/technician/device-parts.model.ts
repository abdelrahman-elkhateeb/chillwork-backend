import { Schema, model, Types } from "mongoose";
import { SUPPORTED_CURRENCIES, type Currency } from "../companies/company-settings.constants.js";
import { DEVICE_PART_DECISIONS, type DevicePartDecision } from "./device-parts.constants.js";

/**
 * The parts a technician picked for one device on one visit. `name` and
 * `unitPriceMinor` are snapshots taken when the proposal was created, so a
 * later catalog price change never changes an accepted price. Stock is
 * not reserved here; it is decremented when the invoice is issued
 * (billing/invoice.service.ts).
 *
 * `proposalId` is this item's own stable identity — deliberately separate
 * from `partId` (the catalog part), because the same catalog part can be
 * proposed again after a rejection: a decided item is never mutated into
 * a different proposal (see device-parts.service.ts), so a re-proposal is
 * a brand-new array entry with a brand-new `proposalId`, not a rewrite of
 * the old one.
 *
 * `decision`/`proposedAt`/`proposedById`/`decidedAt`/`decidedById` did
 * not exist before this reconciliation. A **legacy item** — created
 * before these fields existed — has `proposalId`/`decision` genuinely
 * absent (`undefined`, not `null`): it predates the approval concept
 * entirely and is treated as always-editable/always-billable, exactly as
 * before (see device-parts.service.ts and billing/invoice.service.ts). A
 * **new item** always has `decision: "PROPOSED"` explicitly set at
 * creation — never left undefined. Do not confuse the two: `undefined`
 * means "legacy, concept doesn't apply"; `"PROPOSED"` means "new,
 * decision pending."
 */
const selectedPartSchema = new Schema(
  {
    proposalId: { type: Schema.Types.ObjectId, default: undefined },
    partId: { type: Schema.Types.ObjectId, ref: "Part", required: true },
    name: { type: String, required: true },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    decision: { type: String, enum: DEVICE_PART_DECISIONS, default: undefined },
    proposedAt: { type: Date, default: undefined },
    proposedById: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
    decidedAt: { type: Date, default: undefined },
    decidedById: { type: Schema.Types.ObjectId, ref: "User", default: undefined },
  },
  { _id: false }
);

const devicePartsSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    visitId: { type: Schema.Types.ObjectId, ref: "Visit", required: true },
    requestId: { type: Schema.Types.ObjectId, ref: "ServiceRequest", required: true },
    clientDeviceId: { type: String, required: true },
    currency: { type: String, enum: SUPPORTED_CURRENCIES, required: true },
    items: { type: [selectedPartSchema], required: true },
    version: { type: Number, required: true, default: 0 },
    updatedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

devicePartsSchema.index({ companyId: 1, visitId: 1, clientDeviceId: 1 }, { unique: true });

export interface SelectedPart {
  proposalId?: Types.ObjectId;
  partId: Types.ObjectId;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  decision?: DevicePartDecision;
  proposedAt?: Date;
  proposedById?: Types.ObjectId;
  decidedAt?: Date | null;
  decidedById?: Types.ObjectId | null;
}

export interface DevicePartsDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  visitId: Types.ObjectId;
  requestId: Types.ObjectId;
  clientDeviceId: string;
  currency: Currency;
  items: SelectedPart[];
  version: number;
  updatedById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const DeviceParts = model<DevicePartsDocument>("DeviceParts", devicePartsSchema);
