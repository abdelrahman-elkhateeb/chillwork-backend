import { Schema, model, Types } from "mongoose";
import type { AnalysisStatus, GeminiResultErrorCode } from "../ai/gemini.service.js";
import type { DeviceAnalysis } from "../ai/gemini.schemas.js";
import { SERVICE_REQUEST_STATUSES } from "./request.constants.js";

export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];

/**
 * Devices are embedded, not a separate collection: they're always
 * created/read together with their parent request, and nothing in this
 * feature needs to query a device independently of its request. That
 * makes "create the request with its devices" a single-document write,
 * which MongoDB already makes atomic — no transaction is needed for this
 * part on its own (a transaction *is* used, see request.service.ts, but
 * for coordinating this write with the idempotency-completion write in a
 * different collection, not for the request+devices shape itself).
 */
const serviceRequestDeviceSchema = new Schema(
  {
    clientDeviceId: { type: String, required: true },
    label: { type: String, required: true },
    brand: { type: String, default: null },
    model: { type: String, default: null },
    // Exactly what the customer submitted — never trimmed/rewritten here
    // or anywhere upstream (see request.schemas.ts).
    originalDescription: { type: String, required: true },
    analysis: {
      type: new Schema(
        {
          summary: { type: String, required: true },
          possibleCauses: { type: [String], required: true },
          missingInformation: { type: [String], required: true },
          inspectionQuestions: { type: [String], required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    analysisMetadata: {
      type: new Schema(
        {
          status: { type: String, required: true },
          model: { type: String, required: true },
          promptVersion: { type: String, required: true },
          processedAt: { type: Date, required: true },
          errorCode: { type: String, default: null },
        },
        { _id: false }
      ),
      required: true,
    },
  },
  { _id: false }
);

const serviceRequestSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reference: { type: String, required: true, unique: true },
    status: { type: String, enum: SERVICE_REQUEST_STATUSES, required: true },
    address: { type: String, required: true },
    contactPhone: { type: String, required: true },
    devices: { type: [serviceRequestDeviceSchema], required: true },
  },
  { timestamps: true }
);

// A customer's own requests within their own company — the same
// server-derived scope every query against this collection must use (see
// request.service.ts).
serviceRequestSchema.index({ companyId: 1, customerId: 1, createdAt: -1 });
// FS17 admin list: a company's requests, newest first (optionally by status).
serviceRequestSchema.index({ companyId: 1, createdAt: -1 });
serviceRequestSchema.index({ companyId: 1, status: 1, createdAt: -1 });

export interface ServiceRequestDeviceDocument {
  clientDeviceId: string;
  label: string;
  brand: string | null;
  model: string | null;
  originalDescription: string;
  analysis: DeviceAnalysis | null;
  analysisMetadata: {
    status: AnalysisStatus;
    model: string;
    promptVersion: string;
    processedAt: Date;
    errorCode: GeminiResultErrorCode | null;
  };
}

export interface ServiceRequestDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  customerId: Types.ObjectId;
  reference: string;
  status: ServiceRequestStatus;
  address: string;
  contactPhone: string;
  devices: ServiceRequestDeviceDocument[];
  createdAt: Date;
  updatedAt: Date;
}

export const ServiceRequest = model<ServiceRequestDocument>("ServiceRequest", serviceRequestSchema);
