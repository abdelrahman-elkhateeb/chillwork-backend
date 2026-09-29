import { Schema, model, Types } from "mongoose";
import { STOCK_MOVEMENT_REASONS, type StockMovementReason } from "./catalog.constants.js";

/**
 * Append-only stock ledger: every change to `Part.stockQuantity` writes one
 * of these in the same transaction, so the current quantity can always be
 * explained. `quantityAfter` is the value the guarded `$inc` produced.
 */
const partStockMovementSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
  partId: { type: Schema.Types.ObjectId, ref: "Part", required: true },
  delta: { type: Number, required: true },
  quantityAfter: { type: Number, required: true },
  reason: { type: String, enum: STOCK_MOVEMENT_REASONS, required: true },
  note: { type: String, default: null },
  invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", default: null },
  actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  occurredAt: { type: Date, required: true },
});

partStockMovementSchema.index({ companyId: 1, partId: 1, occurredAt: 1 });

export interface PartStockMovementDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  partId: Types.ObjectId;
  delta: number;
  quantityAfter: number;
  reason: StockMovementReason;
  note: string | null;
  invoiceId: Types.ObjectId | null;
  actorId: Types.ObjectId;
  occurredAt: Date;
}

export const PartStockMovement = model<PartStockMovementDocument>("PartStockMovement", partStockMovementSchema);
