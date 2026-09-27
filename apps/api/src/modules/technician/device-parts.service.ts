import mongoose from "mongoose";
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
import type { SetDevicePartsInput } from "./device-parts.schemas.js";
import { findAssignedVisit, type TechnicianAuthContext } from "./technician-visit.service.js";
import { assertDeviceInVisitScope } from "./work-result.service.js";
import { WorkResult } from "./work-result.model.js";

export interface DevicePartsView {
  clientDeviceId: string;
  items: Array<{ partId: string; name: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number }>;
  partsMinor: number;
  version: number;
}

export function lineTotalMinor(item: Pick<SelectedPart, "unitPriceMinor" | "quantity">): number {
  return item.unitPriceMinor * item.quantity;
}

function toDevicePartsView(clientDeviceId: string, selection: DevicePartsDocument | null | undefined): DevicePartsView {
  const items = (selection?.items ?? []).map((item) => ({
    partId: item.partId.toString(),
    name: item.name,
    unitPriceMinor: item.unitPriceMinor,
    quantity: item.quantity,
    lineTotalMinor: lineTotalMinor(item),
  }));
  return {
    clientDeviceId,
    items,
    partsMinor: items.reduce((sum, item) => sum + item.lineTotalMinor, 0),
    version: selection?.version ?? 0,
  };
}

const partLockKey = (partId: string) => `part:${partId}`;

/**
 * How many of each part are already promised to *other* devices: picked
 * on a visit that is not CANCELLED, whose invoice has not been issued
 * (issuing moves the quantity from "promised" to "taken out of stock"),
 * and whose device has not been recorded FAILED (a failed device's parts
 * are never fitted or billed). The device being edited is excluded — its
 * old list is being replaced.
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
      const key = item.partId.toString();
      if (wanted.has(key)) reserved.set(key, (reserved.get(key) ?? 0) + item.quantity);
    }
  }
  return reserved;
}

/**
 * Resolves the requested items against the catalog inside the write's
 * transaction. Parts already on this device keep their original name/price
 * snapshot (the price the customer agreed to); newly added parts must be
 * active and are snapshotted at today's catalog price. Every item must fit
 * in the stock that is not already promised to another device (see
 * `reservedElsewhere`), so two picks can never both claim the last unit
 * and leave a completed visit with an invoice that can never be issued.
 * Stock itself is only decremented at invoice issuance.
 */
async function resolveItems(
  auth: TechnicianAuthContext,
  input: SetDevicePartsInput,
  existing: DevicePartsDocument | null,
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
  const snapshotByPartId = new Map((existing?.items ?? []).map((item) => [item.partId.toString(), item]));
  const reserved = await reservedElsewhere(auth, partIds, existing?._id, session);

  const invalid: FieldErrors = {};
  const shortStock: FieldErrors = {};
  const resolved: SelectedPart[] = [];

  input.items.forEach((item, index) => {
    const part = partById.get(item.partId);
    const snapshot = snapshotByPartId.get(item.partId);
    if (!part || (!snapshot && !part.isActive)) {
      invalid[`items.${index}.partId`] = ["Part is not available"];
      return;
    }
    const available = part.stockQuantity - (reserved.get(item.partId) ?? 0);
    if (available < item.quantity) {
      shortStock[`items.${index}.quantity`] = [`Only ${Math.max(available, 0)} available`];
      return;
    }
    resolved.push({
      partId: part._id,
      name: snapshot?.name ?? part.name,
      unitPriceMinor: snapshot?.unitPriceMinor ?? part.unitPriceMinor,
      quantity: item.quantity,
    });
  });

  if (Object.keys(invalid).length > 0) {
    throw HttpError.validationFailed("Request validation failed", invalid);
  }
  if (Object.keys(shortStock).length > 0) {
    throw HttpError.insufficientStock(undefined, shortStock);
  }
  return resolved;
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
 * Replaces the device's part list under the same rules as a work result:
 * current assignment, device in the visit's scope, visit IN_PROGRESS or
 * COMPLETED-but-not-invoiced (re-checked on the Visit document inside the
 * transaction), and the `version` compare-and-set (409 VERSION_CONFLICT on
 * mismatch).
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

      const items = await resolveItems(auth, input, existing, session);

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
            occurredAt: new Date(),
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
