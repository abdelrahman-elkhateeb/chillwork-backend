import { Schema, model, Types } from "mongoose";
import { SUPPORTED_CURRENCIES, type Currency } from "../companies/company-settings.constants.js";
import { FAILURE_REASONS, WORK_RESULTS, type FailureReason, type WorkResultValue } from "../technician/work-result.constants.js";
import { INVOICE_STATUSES, PAYMENT_STATES, type InvoiceStatus, type PaymentState } from "./invoice.constants.js";

/**
 * An issued invoice is an immutable snapshot: every name, unit price, fee
 * and total is copied in at issuance, so later catalog or settings changes
 * can never alter it. Exactly one invoice per visit (unique index).
 */
const invoiceLineSchema = new Schema(
  {
    partId: { type: Schema.Types.ObjectId, ref: "Part", required: true },
    name: { type: String, required: true },
    unitPriceMinor: { type: Number, required: true },
    quantity: { type: Number, required: true },
    lineTotalMinor: { type: Number, required: true },
  },
  { _id: false }
);

const invoiceDeviceSchema = new Schema(
  {
    clientDeviceId: { type: String, required: true },
    label: { type: String, required: true },
    result: { type: String, enum: WORK_RESULTS, required: true },
    failureReason: { type: String, enum: FAILURE_REASONS, default: null },
    billable: { type: Boolean, required: true },
    parts: { type: [invoiceLineSchema], required: true },
    partsMinor: { type: Number, required: true },
    laborMinor: { type: Number, required: true },
    totalMinor: { type: Number, required: true },
  },
  { _id: false }
);

const invoiceSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    visitId: { type: Schema.Types.ObjectId, ref: "Visit", required: true },
    requestId: { type: Schema.Types.ObjectId, ref: "ServiceRequest", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    issuedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reference: { type: String, required: true, unique: true },
    // The key the invoice was issued with: a retry with the same key gets
    // this invoice back; any other key gets 409 INVOICE_ALREADY_ISSUED.
    idempotencyKey: { type: String, required: true },
    currency: { type: String, enum: SUPPORTED_CURRENCIES, required: true },
    laborFeeMinor: { type: Number, required: true },
    devices: { type: [invoiceDeviceSchema], required: true },
    subtotalMinor: { type: Number, required: true },
    laborMinor: { type: Number, required: true },
    totalMinor: { type: Number, required: true },
    status: { type: String, enum: INVOICE_STATUSES, required: true },
    paymentState: { type: String, enum: PAYMENT_STATES, required: true },
    issuedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

invoiceSchema.index({ companyId: 1, visitId: 1 }, { unique: true });

export interface InvoiceLine {
  partId: Types.ObjectId;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface InvoiceDevice {
  clientDeviceId: string;
  label: string;
  result: WorkResultValue;
  failureReason: FailureReason | null;
  billable: boolean;
  parts: InvoiceLine[];
  partsMinor: number;
  laborMinor: number;
  totalMinor: number;
}

export interface InvoiceDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  visitId: Types.ObjectId;
  requestId: Types.ObjectId;
  customerId: Types.ObjectId;
  issuedById: Types.ObjectId;
  reference: string;
  idempotencyKey: string;
  currency: Currency;
  laborFeeMinor: number;
  devices: InvoiceDevice[];
  subtotalMinor: number;
  laborMinor: number;
  totalMinor: number;
  status: InvoiceStatus;
  paymentState: PaymentState;
  issuedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const Invoice = model<InvoiceDocument>("Invoice", invoiceSchema);
