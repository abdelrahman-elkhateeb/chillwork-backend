import { Schema, model, Types } from "mongoose";

/**
 * One activation token for one invited technician. `tokenHash` is the
 * SHA-256 of the raw token (the raw value is returned to the admin once
 * and never stored). A token is usable only while `usedAt` and
 * `revokedAt` are null and `expiresAt` is in the future; issuing a new
 * invitation revokes the previous unused one. Kept after use as a record
 * of who invited whom.
 */
const technicianInvitationSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

technicianInvitationSchema.index({ companyId: 1, userId: 1, usedAt: 1, revokedAt: 1 });

export interface TechnicianInvitationDocument {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdById: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export const TechnicianInvitation = model<TechnicianInvitationDocument>(
  "TechnicianInvitation",
  technicianInvitationSchema
);
