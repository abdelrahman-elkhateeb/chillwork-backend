import { Schema, model, Types } from "mongoose";

/**
 * FS02 assumption (OPEN DECISION resolved with a default — see docs/api.md):
 * one company per user. `companyId` is the trusted membership relationship
 * sessions are validated against; it is never taken from client input.
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    name: { type: String, required: true, trim: true },
    // select: false keeps the hash out of default query results so it
    // can't accidentally leak into a response body.
    passwordHash: { type: String, required: true, select: false },
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

export interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  companyId: Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const User = model<UserDocument>("User", userSchema);
