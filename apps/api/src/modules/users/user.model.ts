import { Schema, model, Types } from "mongoose";

/**
 * FS02 assumption (OPEN DECISION resolved with a default — see docs/api.md):
 * one company per user. `companyId` is the trusted membership relationship
 * sessions are validated against; it is never taken from client input.
 */
export const USER_ROLES = ["CUSTOMER", "ADMIN", "TECHNICIAN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

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
    phone: { type: String, required: true, trim: true },
    // select: false keeps the hash out of default query results so it
    // can't accidentally leak into a response body.
    passwordHash: { type: String, required: true, select: false },
    // No schema default on purpose (FS04): every user-creation call site
    // must explicitly state the role rather than relying on an implicit
    // one — public registration always passes "CUSTOMER" itself, never
    // from request input. ADMIN/TECHNICIAN accounts have no creation path
    // yet (out of FS04 scope); the enum exists so authorization checks
    // elsewhere can rely on it.
    role: { type: String, enum: USER_ROLES, required: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true }
);

export interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  name: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
  companyId: Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const User = model<UserDocument>("User", userSchema);
