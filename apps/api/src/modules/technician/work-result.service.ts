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
// FS11 -> FS23 boundary. Only the DeviceParts *model* is imported here,
// never device-parts.service.ts: that service already imports
// `assertDeviceInVisitScope` from this file, so importing its service
// back here would be a circular dependency between the two service
// files. (This replaces the old WorkAgreement-based check — see
// work-agreement.service.ts, now deprecated.)
import { DeviceParts } from "./device-parts.model.js";

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
 * The FS11 -> FS23 boundary: a device's actual-work outcome must be
 * backed by an approved DeviceParts proposal.
 *
 * - No `DeviceParts` document exists for this visit/device, or none of
 *   its items have ever been through a decision (only legacy items with
 *   no `decision` field at all): DeviceParts has not been used for this
 *   device — falls back to the original FS18-only boundary (Visit scope
 *   only), preserving every visit/device that predates this feature.
 * - At least one tracked (decision-bearing) item exists but none has
 *   been decided yet (all still `PROPOSED`): every write is rejected —
 *   nothing can be recorded while the customer's decision is pending.
 * - Recording `REPAIRED` requires at least one `APPROVED` item for that
 *   device, else rejected — a technician can never execute/bill work
 *   nothing was ever approved for. This is necessarily device-level (a
 *   `WorkResult` cannot represent partial per-part outcomes — see
 *   docs/api.md); the *specific* per-part correctness (a rejected item
 *   never gets invoiced even when the device has another approved item)
 *   is enforced separately, per line, in billing/invoice.service.ts.
 * - Recording `FAILED` only requires the device to have been decided at
 *   all — a device whose only tracked item was `REJECTED` can still get
 *   `FAILED`/`CUSTOMER_REFUSED`, because that rejection *is* the refusal
 *   FS23 documents.
 */
async function assertDeviceApprovedForActualWork(
  auth: TechnicianAuthContext,
  visitId: Types.ObjectId,
  deviceId: string,
  result: "REPAIRED" | "FAILED"
): Promise<void> {
  const deviceParts = await DeviceParts.findOne({ companyId: auth.companyId, visitId, clientDeviceId: deviceId }).select(
    "items"
  );
  if (!deviceParts) {
    return;
  }
  const tracked = deviceParts.items.filter((item) => item.decision != null);
  if (tracked.length === 0) {
    return;
  }
  const decided = tracked.filter((item) => item.decision === "APPROVED" || item.decision === "REJECTED");
  if (decided.length === 0) {
    throw HttpError.workNotApproved("This device's proposed parts are still awaiting the customer's decision");
  }
  if (result === "REPAIRED" && !decided.some((item) => item.decision === "APPROVED")) {
    throw HttpError.workNotApproved("No approved parts exist for this device");
  }
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
  await assertDeviceApprovedForActualWork(auth, visit._id, deviceId, input.result);

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
