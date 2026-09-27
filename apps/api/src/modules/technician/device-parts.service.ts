import mongoose from "mongoose";
import type { FieldErrors } from "../../lib/http-error.js";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { Part } from "../catalog/part.model.js";
import type { Currency } from "../companies/company-settings.constants.js";
import { requireBillingSettings } from "../companies/company-settings.service.js";
import { VisitEvent } from "../visits/visit-event.model.js";
import { DeviceParts, type DevicePartsDocument, type SelectedPart } from "./device-parts.model.js";
import type { SetDevicePartsInput } from "./device-parts.schemas.js";
import { findAssignedVisit, type TechnicianAuthContext } from "./technician-visit.service.js";
import { assertDeviceInVisitScope, touchAssignedInProgressVisit } from "./work-result.service.js";

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

/**
 * Resolves the requested items against the catalog inside the write's
 * transaction. Parts already on this device keep their original name/price
 * snapshot (the price the customer agreed to); newly added parts must be
 * active and are snapshotted at today's catalog price. Every item needs
 * enough stock *now* — stock is only decremented at invoice issuance, where
 * it is checked again atomically, but picking a part the shelf doesn't have
 * is refused up front.
 */
async function resolveItems(
  auth: TechnicianAuthContext,
  input: SetDevicePartsInput,
  existing: DevicePartsDocument | null,
  session: mongoose.ClientSession
): Promise<SelectedPart[]> {
  const parts = input.items.length
    ? await Part.find({ _id: { $in: input.items.map((item) => item.partId) }, companyId: auth.companyId }).session(session)
    : [];
  const partById = new Map(parts.map((part) => [part._id.toString(), part]));
  const snapshotByPartId = new Map((existing?.items ?? []).map((item) => [item.partId.toString(), item]));

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
    if (part.stockQuantity < item.quantity) {
      shortStock[`items.${index}.quantity`] = [`Only ${part.stockQuantity} in stock`];
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
 * Replaces the device's part list under the same rules as a work result:
 * current assignment, device in the visit's scope, visit IN_PROGRESS
 * (re-checked on the Visit document inside the transaction), and the
 * `version` compare-and-set (409 VERSION_CONFLICT on mismatch).
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

  const session = await mongoose.startSession();
  try {
    const saved = await session.withTransaction(async () => {
      await touchAssignedInProgressVisit(
        auth,
        visit._id,
        session,
        "Parts can only be selected while the visit is IN_PROGRESS"
      );

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
