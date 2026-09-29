import mongoose, { Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { Company } from "../companies/company.model.js";
import { ServiceRequest } from "../requests/request.model.js";
import { User } from "../users/user.model.js";
import { ACTIVE_VISIT_STATUSES, SCHEDULABLE_REQUEST_STATUSES } from "./visit.constants.js";
import { ScheduleLock } from "./schedule-lock.model.js";
import { VisitEvent } from "./visit-event.model.js";
import { Visit, type VisitDocument } from "./visit.model.js";
import type { AvailabilityQuery, CreateVisitInput } from "./visit.schemas.js";

export interface AdminAuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
}

/**
 * The technician must exist, belong to the authenticated company, hold
 * the TECHNICIAN role and be active — all in one scoped query, never a
 * bare id lookup. Every failure (missing, other company, wrong role,
 * inactive) yields the same result so a foreign technician's existence
 * can't be probed.
 */
async function findAssignableTechnician(auth: AdminAuthContext, technicianId: string) {
  return User.findOne({
    _id: technicianId,
    companyId: auth.companyId,
    role: "TECHNICIAN",
    isActive: true,
  });
}

async function companyTimezone(companyId: Types.ObjectId): Promise<string> {
  const company = await Company.findById(companyId);
  return company?.timezone ?? "UTC";
}

/**
 * Lock documents must exist before the transaction (an upsert inside it
 * could race on the unique index). Also used for `part:<id>` locks by
 * technician part selection.
 */
export async function ensureLocks(companyId: Types.ObjectId, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await ScheduleLock.updateOne({ companyId, key }, { $setOnInsert: { version: 0 } }, { upsert: true });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }
}

/**
 * Creates ONE visit covering the requested devices. Authorization and
 * business validation run first (all company-scoped); the conflict
 * guarantee then comes from the transaction below — see
 * schedule-lock.model.ts for why the lock write must be its first
 * operation and why a read-then-insert alone would not be safe.
 */
export async function createVisit(
  auth: AdminAuthContext,
  requestId: string,
  input: CreateVisitInput
): Promise<VisitDocument> {
  const request = await ServiceRequest.findOne({ _id: requestId, companyId: auth.companyId });
  if (!request) {
    throw HttpError.notFound("Request not found");
  }

  if (!SCHEDULABLE_REQUEST_STATUSES.includes(request.status)) {
    throw HttpError.requestNotSchedulable();
  }

  const technician = await findAssignableTechnician(auth, input.technicianId);
  if (!technician) {
    throw HttpError.validationFailed("Request validation failed", {
      technicianId: ["Technician is not available for assignment"],
    });
  }

  const requestDeviceIds = new Set(request.devices.map((device) => device.clientDeviceId));
  const unknownDevices = input.deviceIds.filter((id) => !requestDeviceIds.has(id));
  if (unknownDevices.length > 0) {
    throw HttpError.validationFailed("Request validation failed", {
      deviceIds: ["One or more devices do not belong to this request"],
    });
  }

  const timezone = await companyTimezone(auth.companyId);
  const technicianObjectId = technician._id;
  const lockKeys = [`request:${request._id.toString()}`, `technician:${technicianObjectId.toString()}`].sort();
  await ensureLocks(auth.companyId, lockKeys);

  const session = await mongoose.startSession();
  try {
    // withTransaction re-runs this callback when MongoDB aborts it with a
    // transient write-conflict (i.e. it lost a race for a lock document),
    // so nothing in here may have side effects outside the transaction.
    return await session.withTransaction(async () => {
      // MUST be the first operations: they pin this transaction's snapshot
      // and make concurrent bookings of the same resource collide.
      for (const key of lockKeys) {
        await ScheduleLock.updateOne({ companyId: auth.companyId, key }, { $inc: { version: 1 } }, { session });
      }

      // Half-open intervals [startAt, endAt): back-to-back visits do not conflict.
      const overlapping = await Visit.findOne({
        companyId: auth.companyId,
        technicianId: technicianObjectId,
        status: { $in: ACTIVE_VISIT_STATUSES },
        startAt: { $lt: input.endAt },
        endAt: { $gt: input.startAt },
      })
        .select("_id")
        .session(session);
      if (overlapping) {
        throw HttpError.scheduleConflict();
      }

      const deviceAlreadyBooked = await Visit.findOne({
        companyId: auth.companyId,
        requestId: request._id,
        status: { $in: ACTIVE_VISIT_STATUSES },
        deviceIds: { $in: input.deviceIds },
      })
        .select("_id")
        .session(session);
      if (deviceAlreadyBooked) {
        throw HttpError.deviceAlreadyScheduled();
      }

      const now = new Date();
      const [visit] = await Visit.create(
        [
          {
            companyId: auth.companyId,
            requestId: request._id,
            technicianId: technicianObjectId,
            scheduledById: auth.userId,
            startAt: input.startAt,
            endAt: input.endAt,
            timezone,
            deviceIds: input.deviceIds,
            workTypes: input.workTypes,
            status: "SCHEDULED",
          },
        ],
        { session }
      );

      const base = {
        companyId: auth.companyId,
        visitId: visit!._id,
        requestId: request._id,
        actorId: auth.userId,
        technicianId: technicianObjectId,
        occurredAt: now,
      };
      await VisitEvent.create(
        [
          { ...base, type: "VISIT_SCHEDULED" },
          { ...base, type: "TECHNICIAN_ASSIGNED" },
        ],
        { session, ordered: true }
      );

      return visit!;
    });
  } finally {
    await session.endSession();
  }
}

export interface TechnicianAvailability {
  technicianId: string;
  timezone: string;
  from: Date;
  to: Date;
  busy: Array<{ visitId: string; startAt: Date; endAt: Date }>;
}

/**
 * Busy intervals for one company technician. Only active visits count
 * (cancelled/completed are excluded). Returns nothing but times and the
 * visit id — no customer, request or device data.
 */
export async function getTechnicianAvailability(
  auth: AdminAuthContext,
  technicianId: string,
  query: AvailabilityQuery
): Promise<TechnicianAvailability> {
  const technician = await findAssignableTechnician(auth, technicianId);
  if (!technician) {
    throw HttpError.notFound("Technician not found");
  }

  const visits = await Visit.find({
    companyId: auth.companyId,
    technicianId: technician._id,
    status: { $in: ACTIVE_VISIT_STATUSES },
    startAt: { $lt: query.to },
    endAt: { $gt: query.from },
  })
    .sort({ startAt: 1 })
    .select("startAt endAt");

  return {
    technicianId: technician._id.toString(),
    timezone: await companyTimezone(auth.companyId),
    from: query.from,
    to: query.to,
    busy: visits.map((visit) => ({ visitId: visit._id.toString(), startAt: visit.startAt, endAt: visit.endAt })),
  };
}
