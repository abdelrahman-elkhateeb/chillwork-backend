import mongoose, { type Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { ServiceRequest } from "../requests/request.model.js";
import { VisitEvent } from "../visits/visit-event.model.js";
import { Visit, type VisitDocument } from "../visits/visit.model.js";
import { findAssignedVisit, type TechnicianAuthContext } from "./technician-visit.service.js";
import type { RecordWorkResultInput } from "./work-result.schemas.js";
import { WorkResult, type WorkResultDocument } from "./work-result.model.js";
import type { VisitOutcome } from "./work-result.constants.js";

/**
 * The device must be part of *this* visit's assigned scope, and it must
 * still exist on the underlying request (defense in depth — nothing in
 * this repository ever mutates `ServiceRequest.devices` after creation,
 * but this mutation never trusts a Visit fetched earlier without
 * re-verifying it). Both failures are the same uniform 404 as
 * `findAssignedVisit` — a device from another request/company/visit is
 * indistinguishable from a device that doesn't exist at all.
 */
export async function assertDeviceInVisitScope(auth: TechnicianAuthContext, visit: VisitDocument, deviceId: string) {
  if (!visit.deviceIds.includes(deviceId)) {
    throw HttpError.notFound("Device not found on this visit");
  }
  const request = await ServiceRequest.findOne({ _id: visit.requestId, companyId: auth.companyId }).select(
    "devices.clientDeviceId"
  );
  if (!request || !request.devices.some((device) => device.clientDeviceId === deviceId)) {
    throw HttpError.notFound("Device not found on this visit");
  }
}

/**
 * The Visit document is the natural serialization point: recording a
 * result, starting, and completing all read-or-write it, so a CAS write
 * here collides with a concurrent status change the same way FS18's
 * lock-first pattern collides two bookings — no separate lock collection
 * needed. Also re-verifies assignment/status atomically inside the
 * transaction (not just at the top of the request).
 */
async function touchAssignedInProgressVisit(
  auth: TechnicianAuthContext,
  visitId: Types.ObjectId,
  session: mongoose.ClientSession
): Promise<void> {
  const touched = await Visit.findOneAndUpdate(
    { _id: visitId, companyId: auth.companyId, technicianId: auth.userId, status: "IN_PROGRESS" },
    { $set: { updatedAt: new Date() } },
    { session, new: true }
  );
  if (touched) {
    return;
  }
  // Disambiguate why, without leaking anything: reassigned/deleted since
  // the initial read → 404 (no existence oracle); still assigned but the
  // wrong status → 409.
  const stillAssigned = await Visit.findOne({ _id: visitId, companyId: auth.companyId, technicianId: auth.userId })
    .select("_id")
    .session(session);
  if (!stillAssigned) {
    throw HttpError.notFound("Visit not found");
  }
  throw HttpError.visitStatusConflict("Work results can only be recorded while the visit is IN_PROGRESS");
}

/**
 * Create-or-update a device's work result under optimistic concurrency.
 * `version` is what the caller believes is current: 0 means "I don't
 * think a result exists yet", and every accepted write increments the
 * stored version by exactly 1 (0 -> 1 -> 2 -> ...). A mismatch — stale
 * version, or a nonzero version against a device with no result yet — is
 * always `409 VERSION_CONFLICT`, never a silent overwrite.
 *
 * REPAIRED/FAILED are the only outcomes (see work-result.constants.ts) —
 * an unattempted or undecided device simply has no WorkResult document
 * yet, which is exactly what `getVisitWorkResults` and
 * `deriveVisitOutcome` treat as "not yet known", not as a third result
 * value.
 */
export async function recordWorkResult(
  auth: TechnicianAuthContext,
  visitId: string,
  deviceId: string,
  input: RecordWorkResultInput
): Promise<WorkResultDocument> {
  const visit = await findAssignedVisit(auth, visitId);
  await assertDeviceInVisitScope(auth, visit, deviceId);

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      await touchAssignedInProgressVisit(auth, visit._id, session);

      const patch = {
        result: input.result,
        failureReason: input.result === "FAILED" ? input.failureReason : null,
        failureNote: input.result === "FAILED" ? (input.failureNote ?? null) : null,
        recordedById: auth.userId,
      };

      let saved: WorkResultDocument | null;
      let eventType: "WORK_RESULT_RECORDED" | "WORK_RESULT_UPDATED";

      if (input.version === 0) {
        // Optimistically assume no result exists yet. A duplicate-key
        // error means one already does (version is not actually 0), which
        // is itself a stale-version situation from the caller's point of
        // view — not a different error class.
        try {
          const [created] = await WorkResult.create(
            [
              {
                companyId: auth.companyId,
                visitId: visit._id,
                requestId: visit.requestId,
                clientDeviceId: deviceId,
                version: 1,
                ...patch,
              },
            ],
            { session }
          );
          saved = created!;
          eventType = "WORK_RESULT_RECORDED";
        } catch (error) {
          if (!isDuplicateKeyError(error)) {
            throw error;
          }
          throw HttpError.versionConflict();
        }
      } else {
        saved = await WorkResult.findOneAndUpdate(
          { companyId: auth.companyId, visitId: visit._id, clientDeviceId: deviceId, version: input.version },
          { $set: patch, $inc: { version: 1 } },
          { session, new: true }
        );
        if (!saved) {
          throw HttpError.versionConflict();
        }
        eventType = "WORK_RESULT_UPDATED";
      }

      await VisitEvent.create(
        [
          {
            companyId: auth.companyId,
            visitId: visit._id,
            requestId: visit.requestId,
            type: eventType,
            actorId: auth.userId,
            technicianId: auth.userId,
            occurredAt: new Date(),
            clientDeviceId: deviceId,
            result: input.result,
          },
        ],
        { session, ordered: true }
      );

      return saved;
    });
  } finally {
    await session.endSession();
  }
}

export interface VisitWorkResultsView {
  visitId: string;
  outcome: VisitOutcome | null;
  devices: Array<{
    clientDeviceId: string;
    result: "REPAIRED" | "FAILED" | null;
    failureReason: string | null;
    failureNote: string | null;
    version: number;
  }>;
}

/**
 * FULLY_REPAIRED / PARTIALLY_REPAIRED / NO_REPAIR only once every device
 * in the visit's scope has a recorded result — otherwise `null`. This
 * deliberately never claims an aggregate from partial information (e.g.
 * one REPAIRED out of three devices is not "FULLY_REPAIRED"), and never
 * invents a result for a device that hasn't been attempted yet.
 */
export function deriveVisitOutcome(
  deviceIds: readonly string[],
  resultByDevice: ReadonlyMap<string, "REPAIRED" | "FAILED">
): VisitOutcome | null {
  if (deviceIds.length === 0 || !deviceIds.every((id) => resultByDevice.has(id))) {
    return null;
  }
  const values = deviceIds.map((id) => resultByDevice.get(id));
  const hasRepaired = values.includes("REPAIRED");
  const hasFailed = values.includes("FAILED");
  if (hasRepaired && hasFailed) return "PARTIALLY_REPAIRED";
  return hasRepaired ? "FULLY_REPAIRED" : "NO_REPAIR";
}

export async function getVisitWorkResults(auth: TechnicianAuthContext, visitId: string): Promise<VisitWorkResultsView> {
  const visit = await findAssignedVisit(auth, visitId);

  const results = await WorkResult.find({ companyId: auth.companyId, visitId: visit._id });
  const byDevice = new Map(results.map((result) => [result.clientDeviceId, result]));
  const resultOnly = new Map(
    [...byDevice.entries()].map(([deviceId, result]) => [deviceId, result.result] as const)
  );

  return {
    visitId: visit._id.toString(),
    outcome: deriveVisitOutcome(visit.deviceIds, resultOnly),
    devices: visit.deviceIds.map((deviceId) => {
      const found = byDevice.get(deviceId);
      return {
        clientDeviceId: deviceId,
        result: found?.result ?? null,
        failureReason: found?.failureReason ?? null,
        failureNote: found?.failureNote ?? null,
        version: found?.version ?? 0,
      };
    }),
  };
}
