import { randomBytes } from "node:crypto";
import mongoose, { type FilterQuery, type Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { recordAttempt } from "../auth/auth-throttle.model.js";
import { revokeAllUserSessions } from "../auth/auth.service.js";
import { generateRefreshToken, hashRefreshToken } from "../auth/auth.tokens.js";
import { hashPassword } from "../users/password.js";
import { User, type UserDocument } from "../users/user.model.js";
import { ACTIVE_VISIT_STATUSES } from "../visits/visit.constants.js";
import { Visit } from "../visits/visit.model.js";
import {
  ACTIVATION_MAX_ATTEMPTS_PER_IP,
  ACTIVATION_TOKEN_TTL_MS,
  ACTIVATION_WINDOW_MS,
  type TechnicianStatus,
} from "./staff.constants.js";
import type {
  ActivateTechnicianInput,
  CreateTechnicianInput,
  TechniciansQuery,
  UpdateTechnicianInput,
} from "./technician-admin.schemas.js";
import { TechnicianInvitation } from "./technician-invitation.model.js";

export interface StaffAuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
}

export interface TechnicianDto {
  id: string;
  name: string;
  email: string;
  phone: string;
  status: TechnicianStatus;
  /** SCHEDULED/IN_PROGRESS visits still assigned — what needs reassigning after a deactivation. */
  activeVisitCount: number;
  createdAt: string;
}

export interface InvitationDto {
  /** Returned exactly once; only its hash is stored. */
  activationToken: string;
  expiresAt: string;
}

export function technicianStatus(user: Pick<UserDocument, "isActive" | "pendingActivation">): TechnicianStatus {
  if (user.pendingActivation) return "INVITED";
  return user.isActive ? "ACTIVE" : "INACTIVE";
}

function toTechnicianDto(user: UserDocument, activeVisitCount: number): TechnicianDto {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    phone: user.phone,
    status: technicianStatus(user),
    activeVisitCount,
    createdAt: user.createdAt.toISOString(),
  };
}

async function activeVisitCounts(companyId: Types.ObjectId, technicianIds: Types.ObjectId[]) {
  if (technicianIds.length === 0) return new Map<string, number>();
  const rows = await Visit.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { companyId, technicianId: { $in: technicianIds }, status: { $in: [...ACTIVE_VISIT_STATUSES] } } },
    { $group: { _id: "$technicianId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STATUS_FILTERS: Record<TechnicianStatus, FilterQuery<UserDocument>> = {
  ACTIVE: { pendingActivation: { $ne: true }, isActive: true },
  INVITED: { pendingActivation: true },
  INACTIVE: { pendingActivation: { $ne: true }, isActive: false },
};

export async function listTechnicians(auth: StaffAuthContext, query: TechniciansQuery) {
  const filter: FilterQuery<UserDocument> = { companyId: auth.companyId, role: "TECHNICIAN" };
  if (query.status) Object.assign(filter, STATUS_FILTERS[query.status]);
  if (query.search) {
    const pattern = { $regex: escapeRegex(query.search), $options: "i" };
    filter.$or = [{ name: pattern }, { email: pattern }];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ name: 1, _id: 1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize),
    User.countDocuments(filter),
  ]);
  const counts = await activeVisitCounts(auth.companyId, users.map((user) => user._id));

  return {
    items: users.map((user) => toTechnicianDto(user, counts.get(user._id.toString()) ?? 0)),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

async function findCompanyTechnician(auth: StaffAuthContext, technicianId: string, session?: mongoose.ClientSession) {
  const user = await User.findOne({ _id: technicianId, companyId: auth.companyId, role: "TECHNICIAN" }).session(
    session ?? null
  );
  if (!user) throw HttpError.notFound("Technician not found");
  return user;
}

/** Revokes any unused invitation for the user, then issues a fresh one. */
async function issueInvitation(
  auth: StaffAuthContext,
  userId: Types.ObjectId,
  session: mongoose.ClientSession,
  now: Date
): Promise<InvitationDto> {
  await TechnicianInvitation.updateMany(
    { companyId: auth.companyId, userId, usedAt: null, revokedAt: null },
    { $set: { revokedAt: now } },
    { session }
  );
  const activationToken = generateRefreshToken();
  const expiresAt = new Date(now.getTime() + ACTIVATION_TOKEN_TTL_MS);
  await TechnicianInvitation.create(
    [
      {
        companyId: auth.companyId,
        userId,
        tokenHash: hashRefreshToken(activationToken),
        expiresAt,
        createdById: auth.userId,
      },
    ],
    { session }
  );
  return { activationToken, expiresAt: expiresAt.toISOString() };
}

/**
 * Creates the technician as a pending (inactive, not yet activated)
 * account with an unusable random password, plus its first invitation.
 * They cannot log in or be scheduled until they activate.
 */
export async function createTechnician(auth: StaffAuthContext, input: CreateTechnicianInput) {
  if (await User.exists({ email: input.email })) {
    throw HttpError.conflict("An account with this email already exists");
  }
  const placeholderHash = await hashPassword(randomBytes(32).toString("base64url"));

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const now = new Date();
      const [user] = await User.create(
        [
          {
            email: input.email,
            name: input.name,
            phone: input.phone,
            passwordHash: placeholderHash,
            role: "TECHNICIAN",
            companyId: auth.companyId,
            isActive: false,
            pendingActivation: true,
          },
        ],
        { session }
      );
      const invitation = await issueInvitation(auth, user!._id, session, now);
      return { technician: toTechnicianDto(user!, 0), invitation };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) throw HttpError.conflict("An account with this email already exists");
    throw error;
  } finally {
    await session.endSession();
  }
}

/** A new link for a technician who has not activated yet (e.g. the first one expired or was lost). */
export async function reissueInvitation(auth: StaffAuthContext, technicianId: string): Promise<InvitationDto> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const user = await findCompanyTechnician(auth, technicianId, session);
      if (technicianStatus(user) !== "INVITED") {
        throw HttpError.technicianAlreadyActivated();
      }
      return issueInvitation(auth, user._id, session, new Date());
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Edits name/phone and activates/deactivates. Deactivating revokes every
 * session at once (the next request is 401 even with a valid JWT) and any
 * pending invitation; it never touches visits — historical assignments
 * stay attributed, and `activeVisitCount` tells the admin what still
 * needs reassigning (FS20). A technician who never activated cannot be
 * switched on here: they have no password of their own yet.
 */
export async function updateTechnician(auth: StaffAuthContext, technicianId: string, input: UpdateTechnicianInput) {
  const user = await findCompanyTechnician(auth, technicianId);
  if (input.isActive === true && user.pendingActivation) {
    throw HttpError.technicianNotActivated();
  }

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.phone !== undefined) set.phone = input.phone;
  if (input.isActive !== undefined) set.isActive = input.isActive;

  const updated = await User.findOneAndUpdate(
    { _id: user._id, companyId: auth.companyId, role: "TECHNICIAN" },
    { $set: set },
    { new: true }
  );
  if (!updated) throw HttpError.notFound("Technician not found");

  if (input.isActive === false) {
    const now = new Date();
    await revokeAllUserSessions(updated._id, "user_deactivated", now);
    await TechnicianInvitation.updateMany(
      { companyId: auth.companyId, userId: updated._id, usedAt: null, revokedAt: null },
      { $set: { revokedAt: now } }
    );
  }

  const counts = await activeVisitCounts(auth.companyId, [updated._id]);
  return toTechnicianDto(updated, counts.get(updated._id.toString()) ?? 0);
}

export async function checkActivationThrottle(ip: string, now: Date = new Date()): Promise<void> {
  const count = await recordAttempt(`activate-technician:ip:${ip}`, ACTIVATION_WINDOW_MS, now);
  if (count > ACTIVATION_MAX_ATTEMPTS_PER_IP) {
    throw HttpError.rateLimited();
  }
}

/**
 * Consumes the token (single use, atomically) and sets the technician's
 * own password. Every failure — unknown, expired, used, revoked, or the
 * account changed underneath — is the same 400, so the endpoint reveals
 * nothing about which tokens exist. Does not log in: the technician then
 * signs in normally, like after registration.
 */
export async function activateTechnician(input: ActivateTechnicianInput): Promise<{ email: string }> {
  const passwordHash = await hashPassword(input.password);
  const tokenHash = hashRefreshToken(input.token);

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const now = new Date();
      const invitation = await TechnicianInvitation.findOneAndUpdate(
        { tokenHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
        { session, new: true }
      );
      if (!invitation) throw HttpError.invalidActivationToken();

      const user = await User.findOneAndUpdate(
        {
          _id: invitation.userId,
          companyId: invitation.companyId,
          role: "TECHNICIAN",
          pendingActivation: true,
        },
        { $set: { passwordHash, isActive: true, pendingActivation: false, activatedAt: now } },
        { session, new: true }
      );
      if (!user) throw HttpError.invalidActivationToken();

      return { email: user.email };
    });
  } finally {
    await session.endSession();
  }
}
