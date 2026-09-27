import { Schema, model, Types } from "mongoose";
import { SUPPORTED_CURRENCIES, type Currency } from "../companies/company-settings.constants.js";

/**
 * The parts a technician picked for one device on one visit — what the
 * customer was quoted and what gets billed if the device is REPAIRED.
 * `name` and `unitPriceMinor` are snapshots taken when the part was first
 * added, so a later catalog price change never changes an agreed price.
 * Stock is not reserved here; it is decremented when the invoice is
 * issued (billing/invoice.service.ts).
 *
 * `version` is the same client-facing optimistic-concurrency counter as
 * WorkResult.version (0 = no selection yet, +1 per accepted write).
 */
const selectedPartSchema = new Schema(
  {
    partId: { type: Schema.Types.ObjectId, ref: "Part", required: true },
    name: { type: String, required: true },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
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
  partId: Types.ObjectId;
  name: string;
  unitPriceMinor: number;
  quantity: number;
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
