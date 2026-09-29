import mongoose, { Types } from "mongoose";
import type { FieldErrors } from "../../lib/http-error.js";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { Invoice } from "../billing/invoice.model.js";
import { Part } from "../catalog/part.model.js";
import type { Currency } from "../companies/company-settings.constants.js";
import { requireBillingSettings } from "../companies/company-settings.service.js";
import { ScheduleLock } from "../visits/schedule-lock.model.js";
import { VisitEvent } from "../visits/visit-event.model.js";
import { Visit } from "../visits/visit.model.js";
import { ensureLocks } from "../visits/visit.service.js";
import { DeviceParts, type DevicePartsDocument, type SelectedPart } from "./device-parts.model.js";
import type { RecordPartDecisionsInput, SetDevicePartsInput } from "./device-parts.schemas.js";
import { findAssignedVisit, type TechnicianAuthContext } from "./technician-visit.service.js";
import { assertDeviceInVisitScope } from "./work-result.service.js";
import { WorkResult } from "./work-result.model.js";

export interface DevicePartsItemView {
  proposalId: string | null;
  partId: string;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  /** `null` for a legacy item that predates approval decisions — see device-parts.model.ts. */
  decision: string | null;
  decidedAt: string | null;
}

export interface DevicePartsView {
  clientDeviceId: string;
  items: DevicePartsItemView[];
  partsMinor: number;
  version: number;
}

export function lineTotalMinor(item: Pick<SelectedPart, "unitPriceMinor" | "quantity">): number {
  return item.unitPriceMinor * item.quantity;
}

function toDevicePartsView(clientDeviceId: string, selection: DevicePartsDocument | null | undefined): DevicePartsView {
  const items = (selection?.items ?? []).map((item) => ({
    proposalId: item.proposalId ? item.proposalId.toString() : null,
    partId: item.partId.toString(),
    name: item.name,
    unitPriceMinor: item.unitPriceMinor,
    quantity: item.quantity,
    lineTotalMinor: lineTotalMinor(item),
    decision: item.decision ?? null,
    decidedAt: item.decidedAt ? item.decidedAt.toISOString() : null,
  }));
  // A rejected item is no longer part of the technician's active
  // selection — it must not inflate this running total (it never
  // contributes to billing either, see billing/invoice.service.ts).
  // Legacy items (decision null) and PROPOSED items both still count,
  // exactly as every item did before decisions existed.
  const partsMinor = items
    .filter((item) => item.decision !== "REJECTED")
    .reduce((sum, item) => sum + item.lineTotalMinor, 0);
  return {
    clientDeviceId,
    items,
    partsMinor,
    version: selection?.version ?? 0,
  };
}

const partLockKey = (partId: string) => `part:${partId}`;

/**
 * How many of each part are already promised to *other* devices: picked
 * on a visit that is not CANCELLED, whose invoice has not been issued
 * (issuing moves the quantity from "promised" to "taken out of stock"),
 * whose device has not been recorded FAILED (a failed device's parts are
 * never fitted or billed), and whose proposal has not been REJECTED (a
 * rejected proposal will never be fitted either, so it releases its
 * reservation the same way a failed device's parts do). The device being
 * edited is excluded — its old list is being replaced.
 */
async function reservedElsewhere(
  auth: TechnicianAuthContext,
  partIds: string[],
  excludeSelectionId: DevicePartsDocument["_id"] | undefined,
  session: mongoose.ClientSession
): Promise<Map<string, number>> {
  const reserved = new Map<string, number>();
  if (partIds.length === 0) return reserved;

  const selections = await DeviceParts.find({
    companyId: auth.companyId,
    "items.partId": { $in: partIds },
    ...(excludeSelectionId ? { _id: { $ne: excludeSelectionId } } : {}),
  }).session(session);
  if (selections.length === 0) return reserved;

  const visitIds = [...new Set(selections.map((selection) => selection.visitId.toString()))];
  const liveVisits = await Visit.find({
    _id: { $in: visitIds },
    companyId: auth.companyId,
    status: { $in: ["SCHEDULED", "IN_PROGRESS", "COMPLETED"] },
  })
    .select("_id")
    .session(session);
  const invoiced = await Invoice.find({ companyId: auth.companyId, visitId: { $in: visitIds } })
    .select("visitId")
    .session(session);
  const failed = await WorkResult.find({ companyId: auth.companyId, visitId: { $in: visitIds }, result: "FAILED" })
    .select("visitId clientDeviceId")
    .session(session);

  const live = new Set(liveVisits.map((visit) => visit._id.toString()));
  const invoicedIds = new Set(invoiced.map((invoice) => invoice.visitId.toString()));
  const failedKeys = new Set(failed.map((r) => `${r.visitId.toString()}:${r.clientDeviceId}`));
  const wanted = new Set(partIds);

  for (const selection of selections) {
    const visitId = selection.visitId.toString();
    if (!live.has(visitId) || invoicedIds.has(visitId) || failedKeys.has(`${visitId}:${selection.clientDeviceId}`)) {
      continue;
    }
    for (const item of selection.items) {
      if (item.decision === "REJECTED") continue;
      const key = item.partId.toString();
      if (wanted.has(key)) reserved.set(key, (reserved.get(key) ?? 0) + item.quantity);
    }
  }
  return reserved;
}

/**
 * Resolves the requested items against the catalog inside the write's
 * transaction, and carries forward every already-decided proposal
 * untouched (see the big comment below). Every item must fit in the
 * stock that is not already promised to another device (see
 * `reservedElsewhere`), so two picks can never both claim the last unit
 * and leave a completed visit with an invoice that can never be issued.
 * Stock itself is only decremented at invoice issuance.
 */
async function resolveItems(
  auth: TechnicianAuthContext,
  input: SetDevicePartsInput,
  existing: DevicePartsDocument | null,
  actorId: Types.ObjectId,
  now: Date,
  session: mongoose.ClientSession
): Promise<SelectedPart[]> {
  const partIds = input.items.map((item) => item.partId);
  // Serialize every selection touching these parts: two concurrent picks
  // write the same lock documents, so one retries on a snapshot that sees
  // the other's reservation (same pattern as FS18 scheduling).
  for (const partId of [...partIds].sort()) {
    await ScheduleLock.updateOne(
      { companyId: auth.companyId, key: partLockKey(partId) },
      { $inc: { version: 1 } },
      { session }
    );
  }

  const parts = partIds.length
    ? await Part.find({ _id: { $in: partIds }, companyId: auth.companyId }).session(session)
    : [];
  const partById = new Map(parts.map((part) => [part._id.toString(), part]));
  // The most recent item for each partId — items are only ever appended
  // (see below), so the last match in array order is the latest proposal
  // for that part.
  const latestByPartId = new Map<string, SelectedPart>();
  for (const item of existing?.items ?? []) {
    latestByPartId.set(item.partId.toString(), item);
  }
  const reserved = await reservedElsewhere(auth, partIds, existing?._id, session);

  const invalid: FieldErrors = {};
  const shortStock: FieldErrors = {};
  const resolved: SelectedPart[] = [];

  input.items.forEach((item, index) => {
    const part = partById.get(item.partId);
    const latest = latestByPartId.get(item.partId);
    // Reusable = an in-place quantity edit of a proposal that has not
    // been decided yet. This is true both for a genuine "PROPOSED" item
    // and for a legacy item (decision undefined, predates this concept
    // entirely) — a legacy item was always freely re-editable, and
    // touching it must not retroactively tag it with new-style fields
    // (see the resolved.push below). A DECIDED item (APPROVED/REJECTED)
    // is never reusable: resending its partId creates a brand-new
    // proposal instead (see docs/api.md "Device part proposals").
    const reusable = latest && latest.decision !== "APPROVED" && latest.decision !== "REJECTED" ? latest : null;
    // A part only needs to still be active for a genuinely first-time
    // pick — one already known to this device (decided or not) keeps
    // working even if it's deactivated later (see
    // "keeps a part that was deactivated after it was selected").
    if (!part || (!latest && !part.isActive)) {
      invalid[`items.${index}.partId`] = ["Part is not available"];
      return;
    }
    const available = part.stockQuantity - (reserved.get(item.partId) ?? 0);
    if (available < item.quantity) {
      shortStock[`items.${index}.quantity`] = [`Only ${Math.max(available, 0)} available`];
      return;
    }
    resolved.push({
      // A legacy reusable item has no proposalId of its own — keep it
      // exactly as legacy (undefined), don't invent one just because the
      // quantity changed.
      proposalId: reusable ? reusable.proposalId : new Types.ObjectId(),
      partId: part._id,
      name: reusable ? reusable.name : part.name,
      unitPriceMinor: reusable ? reusable.unitPriceMinor : part.unitPriceMinor,
      quantity: item.quantity,
      decision: reusable ? reusable.decision : "PROPOSED",
      proposedAt: reusable ? reusable.proposedAt : now,
      proposedById: reusable ? reusable.proposedById : actorId,
      decidedAt: null,
      decidedById: null,
    });
  });

  if (Object.keys(invalid).length > 0) {
    throw HttpError.validationFailed("Request validation failed", invalid);
  }
  if (Object.keys(shortStock).length > 0) {
    throw HttpError.insufficientStock(undefined, shortStock);
  }

  // Decided proposals are permanent history: this write only ever manages
  // the set of currently-open (PROPOSED) proposals (`resolved`, built
  // from what the client sent) — it never removes or rewrites a customer
  // decision, whether or not this request still names that part. A
  // legacy item (decision undefined) has no such protection: it behaves
  // exactly as before, so if its partId isn't resent here it is dropped,
  // the same "full replace" behavior this endpoint always had.
  const decidedCarryForward = (existing?.items ?? []).filter(
    (item) => item.decision === "APPROVED" || item.decision === "REJECTED"
  );

  return [...decidedCarryForward, ...resolved];
}

/**
 * Serialization point shared with invoice issuance: re-checks assignment
 * and status on the Visit document inside the transaction. Parts stay
 * editable after COMPLETED until the invoice exists, so a technician can
 * still correct the list (e.g. when stock ran out) before issuing it.
 */
async function touchEditableVisit(
  auth: TechnicianAuthContext,
  visitId: DevicePartsDocument["visitId"],
  session: mongoose.ClientSession
): Promise<void> {
  const touched = await Visit.findOneAndUpdate(
    {
      _id: visitId,
      companyId: auth.companyId,
      technicianId: auth.userId,
      status: { $in: ["IN_PROGRESS", "COMPLETED"] },
    },
    { $set: { updatedAt: new Date() } },
    { session, new: true }
  );
  if (!touched) {
    const stillAssigned = await Visit.exists({
      _id: visitId,
      companyId: auth.companyId,
      technicianId: auth.userId,
    }).session(session);
    if (!stillAssigned) throw HttpError.notFound("Visit not found");
    throw HttpError.visitStatusConflict("Parts can only be selected while the visit is IN_PROGRESS or COMPLETED");
  }
  if (await Invoice.exists({ companyId: auth.companyId, visitId }).session(session)) {
    throw HttpError.invoiceAlreadyIssued("Parts can no longer change: the invoice has been issued");
  }
}

/**
 * Sets the device's currently-open (PROPOSED) part proposals under the
 * same rules as a work result: current assignment, device in the visit's
 * scope, visit IN_PROGRESS or COMPLETED-but-not-invoiced (re-checked on
 * the Visit document inside the transaction), and the `version` compare-
 * and-set (409 VERSION_CONFLICT on mismatch). Every new line starts
 * `PROPOSED` — this endpoint can never create an APPROVED line; only
 * `recordPartDecisions` can move one forward.
 */
export async function setDeviceParts(
  auth: TechnicianAuthContext,
  visitId: string,
  deviceId: string,
  input: SetDevicePartsInput
): Promise<DevicePartsView> {
  const visit = await findAssignedVisit(auth, visitId);
  await assertDeviceInVisitScope(auth, visit, deviceId);
  const { currency } = await requireBillingSettings(auth.companyId);
  await ensureLocks(auth.companyId, input.items.map((item) => partLockKey(item.partId)));

  const session = await mongoose.startSession();
  try {
    const saved = await session.withTransaction(async () => {
      await touchEditableVisit(auth, visit._id, session);

      const scope = { companyId: auth.companyId, visitId: visit._id, clientDeviceId: deviceId };
      const existing = await DeviceParts.findOne(scope).session(session);
      if ((existing?.version ?? 0) !== input.version) {
        throw HttpError.versionConflict("This part selection was changed by another update, please refresh and retry");
      }

      const now = new Date();
      const items = await resolveItems(auth, input, existing, auth.userId, now, session);

      let result: DevicePartsDocument | null;
      if (!existing) {
        try {
          const [created] = await DeviceParts.create(
            [{ ...scope, requestId: visit.requestId, currency, items, version: 1, updatedById: auth.userId }],
            { session }
          );
          result = created!;
        } catch (error) {
          if (isDuplicateKeyError(error)) throw HttpError.versionConflict();
          throw error;
        }
      } else {
        result = await DeviceParts.findOneAndUpdate(
          { ...scope, version: input.version },
          { $set: { items, updatedById: auth.userId }, $inc: { version: 1 } },
          { session, new: true }
        );
        if (!result) throw HttpError.versionConflict();
      }

      await VisitEvent.create(
        [
          {
            companyId: auth.companyId,
            visitId: visit._id,
            requestId: visit.requestId,
            type: "DEVICE_PARTS_UPDATED",
            actorId: auth.userId,
            technicianId: auth.userId,
            occurredAt: now,
            clientDeviceId: deviceId,
            result: null,
          },
        ],
        { session, ordered: true }
      );

      return result;
    });
    return toDevicePartsView(deviceId, saved);
  } finally {
    await session.endSession();
  }
}

/**
 * Records the customer's on-site decision for one or more currently
 * PROPOSED proposals on this device. A decision is one-way: once a
 * proposal is APPROVED or REJECTED it can never be re-decided — proposing
 * the same catalog part again after a rejection is always a new call to
 * `setDeviceParts`, which creates a brand-new `proposalId` (see
 * `resolveItems`). This is what keeps "a rejected proposal never becomes
 * billable" true even after later scope changes.
 *
 * This endpoint only decides existing proposals — it can never create,
 * price, or re-price a part.
 */
export async function recordPartDecisions(
  auth: TechnicianAuthContext,
  visitId: string,
  deviceId: string,
  input: RecordPartDecisionsInput
): Promise<DevicePartsView> {
  const visit = await findAssignedVisit(auth, visitId);
  await assertDeviceInVisitScope(auth, visit, deviceId);

  const scope = { companyId: auth.companyId, visitId: visit._id, clientDeviceId: deviceId };
  const existing = await DeviceParts.findOne(scope);
  if (!existing) {
    throw HttpError.notFound("No parts have been proposed for this device yet");
  }

  const byProposalId = new Map(
    existing.items.filter((item) => item.proposalId).map((item) => [item.proposalId!.toString(), item])
  );
  const fieldErrors: FieldErrors = {};
  input.decisions.forEach((decision, index) => {
    const item = byProposalId.get(decision.proposalId);
    if (!item) {
      fieldErrors[`decisions.${index}.proposalId`] = ["Proposal not found on this device"];
    } else if (item.decision !== "PROPOSED") {
      fieldErrors[`decisions.${index}.proposalId`] = ["This proposal has already been decided and cannot be changed"];
    }
  });
  if (Object.keys(fieldErrors).length > 0) {
    throw HttpError.validationFailed("Request validation failed", fieldErrors);
  }

  const session = await mongoose.startSession();
  try {
    const saved = await session.withTransaction(async () => {
      await touchEditableVisit(auth, visit._id, session);

      const now = new Date();
      const arrayFilters = input.decisions.map((decision, index) => ({
        [`elem${index}.proposalId`]: new mongoose.Types.ObjectId(decision.proposalId),
      }));
      const setOps: Record<string, unknown> = {};
      input.decisions.forEach((decision, index) => {
        setOps[`items.$[elem${index}].decision`] = decision.decision;
        setOps[`items.$[elem${index}].decidedAt`] = now;
        setOps[`items.$[elem${index}].decidedById`] = auth.userId;
      });

      // The version filter is the sole concurrency guard: if anything
      // about this selection changed since `input.version` was read
      // (including another request deciding one of these same proposals
      // first), this simply matches nothing and returns null -> 409. The
      // pre-check above (all targets currently PROPOSED) is therefore
      // never stale by the time this write lands.
      const updated = await DeviceParts.findOneAndUpdate(
        { ...scope, version: input.version },
        { $set: setOps, $inc: { version: 1 } },
        { session, new: true, arrayFilters }
      );
      if (!updated) {
        throw HttpError.versionConflict("This part selection was changed by another update, please refresh and retry");
      }

      const events = input.decisions.map((decision) => ({
        companyId: auth.companyId,
        visitId: visit._id,
        requestId: visit.requestId,
        type: "DEVICE_PARTS_DECIDED" as const,
        actorId: auth.userId,
        technicianId: auth.userId,
        occurredAt: now,
        clientDeviceId: deviceId,
        workItemId: decision.proposalId,
        result: decision.decision,
      }));
      await VisitEvent.create(events, { session, ordered: true });

      return updated;
    });
    return toDevicePartsView(deviceId, saved);
  } finally {
    await session.endSession();
  }
}

export interface VisitPartsView {
  visitId: string;
  currency: Currency;
  devices: DevicePartsView[];
}

/** One entry per device in the visit's scope, including devices with nothing picked yet. */
export async function getVisitParts(auth: TechnicianAuthContext, visitId: string): Promise<VisitPartsView> {
  const visit = await findAssignedVisit(auth, visitId);
  const { currency } = await requireBillingSettings(auth.companyId);
  const selections = await DeviceParts.find({ companyId: auth.companyId, visitId: visit._id });
  const byDevice = new Map(selections.map((selection) => [selection.clientDeviceId, selection]));

  return {
    visitId: visit._id.toString(),
    currency,
    devices: visit.deviceIds.map((deviceId) => toDevicePartsView(deviceId, byDevice.get(deviceId))),
  };
}
