import mongoose, { Types } from "mongoose";
import type { FieldErrors } from "../../lib/http-error.js";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { ServiceRequest } from "../requests/request.model.js";
import { VisitEvent } from "../visits/visit-event.model.js";
import { Visit, type VisitDocument } from "../visits/visit.model.js";
import { findAssignedVisit, type TechnicianAuthContext } from "./technician-visit.service.js";
import type { ProposeWorkItemsInput, RecordDecisionsInput } from "./work-agreement.schemas.js";
import { DEFAULT_CURRENCY } from "./work-agreement.constants.js";
import { WorkAgreement, type WorkAgreementDocument, type WorkItemDocument } from "./work-agreement.model.js";

/**
 * Deliberately duplicated from work-result.service.ts rather than
 * imported: work-result.service.ts needs to call *into* this module (see
 * `assertDeviceWithinApprovedScope` below, used by work-result.service.ts)
 * to enforce the FS22 -> FS23 boundary, so this module cannot import back
 * from work-result.service.ts without a circular dependency between the
 * two service files. Both copies must stay in sync with the same
 * assigned-visit + device-scope rules; there is no third module to host a
 * shared version of this without a larger restructuring this task does
 * not call for.
 */
async function assertItemDeviceInVisitScope(auth: TechnicianAuthContext, visit: VisitDocument, deviceId: string) {
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

/** See the comment on `assertItemDeviceInVisitScope` above — same duplication reasoning. */
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
  const stillAssigned = await Visit.findOne({ _id: visitId, companyId: auth.companyId, technicianId: auth.userId })
    .select("_id")
    .session(session);
  if (!stillAssigned) {
    throw HttpError.notFound("Visit not found");
  }
  throw HttpError.visitStatusConflict("Work agreement changes can only be made while the visit is IN_PROGRESS");
}

export interface WorkItemView {
  itemId: string;
  clientDeviceId: string | null;
  category: string;
  description: string;
  partIdentifier: string | null;
  quantity: number;
  unitPriceMinor: number;
  estimatedTotalMinor: number;
  currency: string;
  decision: string;
  proposedAt: string;
  decidedAt: string | null;
}

export interface WorkAgreementView {
  visitId: string;
  version: number;
  currency: string;
  items: WorkItemView[];
  /** Server-computed convenience total for the items currently APPROVED — not an invoice, not persisted. */
  approvedTotalMinor: number;
}

function toWorkItemView(item: WorkItemDocument): WorkItemView {
  return {
    itemId: item._id.toString(),
    clientDeviceId: item.clientDeviceId,
    category: item.category,
    description: item.description,
    partIdentifier: item.partIdentifier,
    quantity: item.quantity,
    unitPriceMinor: item.unitPriceMinor,
    estimatedTotalMinor: item.estimatedTotalMinor,
    currency: item.currency,
    decision: item.decision,
    proposedAt: item.proposedAt.toISOString(),
    decidedAt: item.decidedAt ? item.decidedAt.toISOString() : null,
  };
}

function toWorkAgreementView(doc: WorkAgreementDocument): WorkAgreementView {
  const items = doc.items.map((item) => toWorkItemView(item));
  const approvedTotalMinor = items
    .filter((item) => item.decision === "APPROVED")
    .reduce((sum, item) => sum + item.estimatedTotalMinor, 0);
  return {
    visitId: doc.visitId.toString(),
    version: doc.version,
    currency: DEFAULT_CURRENCY,
    items,
    approvedTotalMinor,
  };
}

/**
 * Adds one or more proposed work items to this visit's agreement. Never
 * accepts a decision (see work-agreement.schemas.ts) — every new item
 * starts PROPOSED, and only `recordDecisions` can move it forward. Devices
 * named on an item are validated against the same visit/request scope
 * FS23 uses, so an item can never be proposed for a device this visit
 * does not cover.
 */
export async function proposeWorkItems(
  auth: TechnicianAuthContext,
  visitId: string,
  input: ProposeWorkItemsInput
): Promise<WorkAgreementView> {
  const visit = await findAssignedVisit(auth, visitId);

  for (const item of input.items) {
    if (item.clientDeviceId) {
      await assertItemDeviceInVisitScope(auth, visit, item.clientDeviceId);
    }
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      await touchAssignedInProgressVisit(auth, visit._id, session);

      const now = new Date();
      const newItems = input.items.map((item) => ({
        _id: new Types.ObjectId(),
        clientDeviceId: item.clientDeviceId ?? null,
        category: item.category,
        description: item.description,
        partIdentifier: item.partIdentifier ?? null,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        // Server-computed. There is no client-supplied total anywhere on
        // the wire — see work-agreement.schemas.ts.
        estimatedTotalMinor: item.quantity * item.unitPriceMinor,
        currency: DEFAULT_CURRENCY,
        decision: "PROPOSED" as const,
        proposedAt: now,
        proposedById: auth.userId,
        decidedAt: null,
        decidedById: null,
      }));

      let doc: WorkAgreementDocument;
      if (input.version === 0) {
        try {
          const [created] = await WorkAgreement.create(
            [
              {
                companyId: auth.companyId,
                visitId: visit._id,
                requestId: visit.requestId,
                version: 1,
                items: newItems,
              },
            ],
            { session }
          );
          doc = created!;
        } catch (error) {
          if (!isDuplicateKeyError(error)) {
            throw error;
          }
          throw HttpError.versionConflict(
            "This work agreement was changed by another update, please refresh and retry"
          );
        }
      } else {
        const updated = await WorkAgreement.findOneAndUpdate(
          { companyId: auth.companyId, visitId: visit._id, version: input.version },
          { $push: { items: { $each: newItems } }, $inc: { version: 1 } },
          { session, new: true }
        );
        if (!updated) {
          throw HttpError.versionConflict(
            "This work agreement was changed by another update, please refresh and retry"
          );
        }
        doc = updated;
      }

      const events = newItems.map((item) => ({
        companyId: auth.companyId,
        visitId: visit._id,
        requestId: visit.requestId,
        type: "WORK_ITEM_PROPOSED" as const,
        actorId: auth.userId,
        technicianId: auth.userId,
        occurredAt: now,
        clientDeviceId: item.clientDeviceId,
        workItemId: item._id.toString(),
        result: null,
      }));
      await VisitEvent.create(events, { session, ordered: true });

      return toWorkAgreementView(doc);
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Records the customer's on-site decision for one or more currently
 * PROPOSED items. A decision is one-way: once an item is APPROVED or
 * REJECTED it can never be re-decided (see docs/api.md "Scope changes") —
 * additional or changed work is always a new proposed item via
 * `proposeWorkItems`, never a mutation of an old one. This is what keeps
 * "old approved items remain intact" true even after later scope changes.
 */
export async function recordDecisions(
  auth: TechnicianAuthContext,
  visitId: string,
  input: RecordDecisionsInput
): Promise<WorkAgreementView> {
  const visit = await findAssignedVisit(auth, visitId);

  const existing = await WorkAgreement.findOne({ companyId: auth.companyId, visitId: visit._id });
  if (!existing) {
    throw HttpError.notFound("No proposed work exists for this visit yet");
  }

  const itemById = new Map(existing.items.map((item) => [item._id.toString(), item]));
  const fieldErrors: FieldErrors = {};
  input.decisions.forEach((decision, index) => {
    const item = itemById.get(decision.itemId);
    if (!item) {
      fieldErrors[`decisions.${index}.itemId`] = ["Work item not found on this agreement"];
    } else if (item.decision !== "PROPOSED") {
      fieldErrors[`decisions.${index}.itemId`] = ["This item has already been decided and cannot be changed"];
    }
  });
  if (Object.keys(fieldErrors).length > 0) {
    throw HttpError.validationFailed("Request validation failed", fieldErrors);
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      await touchAssignedInProgressVisit(auth, visit._id, session);

      const now = new Date();
      const arrayFilters = input.decisions.map((decision, index) => ({
        [`elem${index}._id`]: new Types.ObjectId(decision.itemId),
      }));
      const setOps: Record<string, unknown> = {};
      input.decisions.forEach((decision, index) => {
        setOps[`items.$[elem${index}].decision`] = decision.decision;
        setOps[`items.$[elem${index}].decidedAt`] = now;
        setOps[`items.$[elem${index}].decidedById`] = auth.userId;
      });

      // The version filter is the sole concurrency guard: if anything
      // about this agreement changed since `input.version` was read
      // (including another request deciding one of these same items
      // first), this simply matches nothing and returns null -> 409. The
      // pre-check above (all targets currently PROPOSED) is therefore
      // never stale by the time this write lands.
      const updated = await WorkAgreement.findOneAndUpdate(
        { companyId: auth.companyId, visitId: visit._id, version: input.version },
        { $set: setOps, $inc: { version: 1 } },
        { session, new: true, arrayFilters }
      );
      if (!updated) {
        throw HttpError.versionConflict(
          "This work agreement was changed by another update, please refresh and retry"
        );
      }

      const events = input.decisions.map((decision) => {
        const item = itemById.get(decision.itemId)!;
        return {
          companyId: auth.companyId,
          visitId: visit._id,
          requestId: visit.requestId,
          type: "WORK_ITEM_DECIDED" as const,
          actorId: auth.userId,
          technicianId: auth.userId,
          occurredAt: now,
          clientDeviceId: item.clientDeviceId,
          workItemId: decision.itemId,
          // Reusing VisitEvent's generic `result` string field to carry
          // the decision (APPROVED/REJECTED) rather than adding a second,
          // near-identical column — see visit-event.model.ts.
          result: decision.decision,
        };
      });
      await VisitEvent.create(events, { session, ordered: true });

      return toWorkAgreementView(updated);
    });
  } finally {
    await session.endSession();
  }
}

export async function getWorkAgreement(auth: TechnicianAuthContext, visitId: string): Promise<WorkAgreementView> {
  const visit = await findAssignedVisit(auth, visitId);
  const doc = await WorkAgreement.findOne({ companyId: auth.companyId, visitId: visit._id });
  if (!doc) {
    return { visitId: visit._id.toString(), version: 0, currency: DEFAULT_CURRENCY, items: [], approvedTotalMinor: 0 };
  }
  return toWorkAgreementView(doc);
}

/**
 * The FS22 -> FS23 boundary. Called from work-result.service.ts before a
 * work result is recorded (see the comment there for why this lives here
 * rather than being imported the other way around).
 *
 * - No WorkAgreement exists for this visit, or none of its items name
 *   this device: FS22 has not been used for this device yet. Falls back
 *   to FS23's original interim boundary (Visit.deviceIds + request scope
 *   only) rather than blocking every visit that predates FS22 — see
 *   docs/api.md "On-site work agreement (FS22)" for why this fallback
 *   exists and what it does not guarantee.
 * - At least one item exists for this device but none has been decided
 *   yet: nothing can be recorded — the customer has not agreed to
 *   anything for this device yet.
 * - Recording REPAIRED requires at least one APPROVED item for this
 *   device (you cannot claim to have repaired something nothing was ever
 *   approved for).
 * - Recording FAILED only requires the device to have been decided at
 *   all — a REJECTED-only device can still get FAILED/CUSTOMER_REFUSED,
 *   because refusal is what a rejection *is* (see docs/api.md "Visit
 *   lifecycle").
 */
export async function assertDeviceWithinApprovedScope(
  auth: TechnicianAuthContext,
  visitId: Types.ObjectId,
  deviceId: string,
  result: "REPAIRED" | "FAILED"
): Promise<void> {
  const agreement = await WorkAgreement.findOne({ companyId: auth.companyId, visitId }).select("items");
  if (!agreement) {
    return;
  }
  const itemsForDevice = agreement.items.filter((item) => item.clientDeviceId === deviceId);
  if (itemsForDevice.length === 0) {
    return;
  }
  const decided = itemsForDevice.filter((item) => item.decision !== "PROPOSED");
  if (decided.length === 0) {
    throw HttpError.workNotApproved("This device's proposed work is still awaiting the customer's decision");
  }
  if (result === "REPAIRED" && !decided.some((item) => item.decision === "APPROVED")) {
    throw HttpError.workNotApproved("No approved work exists for this device");
  }
}
