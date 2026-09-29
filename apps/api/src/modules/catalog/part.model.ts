import { Schema, model, Types } from "mongoose";

/**
 * A company-scoped catalog part. Parts are never deleted — deactivating
 * (`isActive: false`) hides a part from the catalog and from new
 * selections, while historical selections/invoices keep resolving it
 * through their own snapshots (name and unit price are copied at
 * selection time, see technician/device-parts.model.ts).
 *
 * `unitPriceMinor` is in the company currency's minor unit (FS10); the
 * currency itself is not stored per part because it is locked per company.
 * `stockQuantity` only ever changes through an atomic `$inc` guarded by
 * `stockQuantity >= n` (see catalog.service.ts / billing), so concurrent
 * adjustments and invoices can never drive it negative.
 */
const partSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    name: { type: String, required: true },
    // Lowercased, whitespace-collapsed name: the uniqueness key, so "Fan
    // Motor" and "fan  motor" can't both exist in one company.
    nameKey: { type: String, required: true },
    description: { type: String, default: null },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    stockQuantity: { type: Number, required: true, min: 0 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

partSchema.index({ companyId: 1, nameKey: 1 }, { unique: true });

export interface PartDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  name: string;
  nameKey: string;
  description: string | null;
  unitPriceMinor: number;
  stockQuantity: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const Part = model<PartDocument>("Part", partSchema);

export function partNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}
