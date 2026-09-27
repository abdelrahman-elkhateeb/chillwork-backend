import { randomBytes } from "node:crypto";
import mongoose, { type Types } from "mongoose";
import { HttpError, type FieldErrors } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { PartStockMovement } from "../catalog/part-stock-movement.model.js";
import { Part } from "../catalog/part.model.js";
import type { Currency } from "../companies/company-settings.constants.js";
import { requireBillingSettings } from "../companies/company-settings.service.js";
import { REFERENCE_ALPHABET, REFERENCE_RANDOM_LENGTH } from "../requests/request.constants.js";
import { ServiceRequest } from "../requests/request.model.js";
import { DeviceParts } from "../technician/device-parts.model.js";
import { lineTotalMinor } from "../technician/device-parts.service.js";
import { findAssignedVisit, type TechnicianAuthContext } from "../technician/technician-visit.service.js";
import type { FailureReason, WorkResultValue } from "../technician/work-result.constants.js";
import { WorkResult } from "../technician/work-result.model.js";
import { VisitEvent } from "../visits/visit-event.model.js";
import { Visit, type VisitDocument } from "../visits/visit.model.js";
import { INVOICE_REFERENCE_PREFIX, type InvoiceStatus, type PaymentState } from "./invoice.constants.js";
import { Invoice, type InvoiceDevice, type InvoiceDocument } from "./invoice.model.js";

/** A device section of a preview: `result` may still be null before every device is resolved. */
export interface DraftDevice extends Omit<InvoiceDevice, "result"> {
  result: WorkResultValue | null;
}

export interface InvoiceDraft {
  currency: Currency;
  laborFeeMinor: number;
  devices: DraftDevice[];
  subtotalMinor: number;
  laborMinor: number;
  totalMinor: number;
}

interface DraftInputs {
  visit: VisitDocument;
  labels: ReadonlyMap<string, string>;
  results: ReadonlyMap<string, { result: WorkResultValue; failureReason: FailureReason | null }>;
  selections: ReadonlyMap<string, Array<{ partId: Types.ObjectId; name: string; unitPriceMinor: number; quantity: number }>>;
  currency: Currency;
  laborFeeMinor: number;
}

/**
 * The whole pricing rule, as a pure function. Only a REPAIRED device is
 * billable: its picked parts (at their snapshotted prices) plus one labor
 * fee. A FAILED or not-yet-resolved device contributes zero and lists no
 * parts, since nothing was fitted/billed for it. Integer minor units
 * throughout — sums and integer products only, so there is no rounding.
 */
export function buildInvoiceDraft(inputs: DraftInputs): InvoiceDraft {
  const devices = inputs.visit.deviceIds.map((deviceId): DraftDevice => {
    const outcome = inputs.results.get(deviceId);
    const billable = outcome?.result === "REPAIRED";
    const parts = billable
      ? (inputs.selections.get(deviceId) ?? []).map((item) => ({
          partId: item.partId,
          name: item.name,
          unitPriceMinor: item.unitPriceMinor,
          quantity: item.quantity,
          lineTotalMinor: lineTotalMinor(item),
        }))
      : [];
    const partsMinor = parts.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    const laborMinor = billable ? inputs.laborFeeMinor : 0;
    return {
      clientDeviceId: deviceId,
      label: inputs.labels.get(deviceId) ?? deviceId,
      result: outcome?.result ?? null,
      failureReason: outcome?.failureReason ?? null,
      billable,
      parts,
      partsMinor,
      laborMinor,
      totalMinor: partsMinor + laborMinor,
    };
  });

  const subtotalMinor = devices.reduce((sum, device) => sum + device.partsMinor, 0);
  const laborMinor = devices.reduce((sum, device) => sum + device.laborMinor, 0);
  return {
    currency: inputs.currency,
    laborFeeMinor: inputs.laborFeeMinor,
    devices,
    subtotalMinor,
    laborMinor,
    totalMinor: subtotalMinor + laborMinor,
  };
}

async function loadDraft(
  auth: TechnicianAuthContext,
  visit: VisitDocument,
  session?: mongoose.ClientSession
): Promise<InvoiceDraft & { customerId: Types.ObjectId }> {
  const { currency, laborFeeMinor } = await requireBillingSettings(auth.companyId, session);
  const scope = { companyId: auth.companyId, visitId: visit._id };
  // Sequential on purpose: operations sharing one transaction session must
  // not run in parallel.
  const request = await ServiceRequest.findOne({ _id: visit.requestId, companyId: auth.companyId })
    .select("customerId devices.clientDeviceId devices.label")
    .session(session ?? null);
  const results = await WorkResult.find(scope).session(session ?? null);
  const selections = await DeviceParts.find(scope).session(session ?? null);
  if (!request) {
    throw HttpError.notFound("Visit not found");
  }

  const draft = buildInvoiceDraft({
    visit,
    labels: new Map(request.devices.map((device) => [device.clientDeviceId, device.label])),
    results: new Map(results.map((r) => [r.clientDeviceId, { result: r.result, failureReason: r.failureReason }])),
    selections: new Map(selections.map((s) => [s.clientDeviceId, s.items])),
    currency,
    laborFeeMinor,
  });
  return { ...draft, customerId: request.customerId };
}

/**
 * Itemized calculation from current data, without issuing anything.
 * Allowed while the visit is IN_PROGRESS (to show the customer before
 * finishing) or COMPLETED.
 */
export async function previewInvoice(auth: TechnicianAuthContext, visitId: string): Promise<InvoiceDraft> {
  const visit = await findAssignedVisit(auth, visitId);
  if (visit.status !== "IN_PROGRESS" && visit.status !== "COMPLETED") {
    throw HttpError.visitStatusConflict("An invoice preview is only available for an IN_PROGRESS or COMPLETED visit");
  }
  const { customerId: _customerId, ...draft } = await loadDraft(auth, visit);
  return draft;
}

export async function getIssuedInvoice(auth: TechnicianAuthContext, visitId: string): Promise<InvoiceDocument> {
  const visit = await findAssignedVisit(auth, visitId);
  const invoice = await Invoice.findOne({ companyId: auth.companyId, visitId: visit._id });
  if (!invoice) {
    throw HttpError.notFound("Invoice not found");
  }
  return invoice;
}

function randomInvoiceReference(): string {
  const bytes = randomBytes(REFERENCE_RANDOM_LENGTH);
  let suffix = "";
  for (let i = 0; i < REFERENCE_RANDOM_LENGTH; i += 1) {
    suffix += REFERENCE_ALPHABET[bytes[i]! % REFERENCE_ALPHABET.length];
  }
  return `${INVOICE_REFERENCE_PREFIX}${suffix}`;
}

/** Same key → the existing invoice (a retry); any other key → 409. */
function replayOrConflict(existing: InvoiceDocument, idempotencyKey: string): IssueInvoiceOutcome {
  if (existing.idempotencyKey !== idempotencyKey) {
    throw HttpError.invoiceAlreadyIssued();
  }
  return { status: 200, invoice: existing };
}

/**
 * Takes the stock for every part fitted on a repaired device. Each
 * decrement is one guarded `$inc` (`stockQuantity >= n`), so two invoices
 * racing for the last unit can't both win; any shortfall aborts the whole
 * transaction (nothing issued, no stock taken).
 */
async function consumeStock(
  auth: TechnicianAuthContext,
  draft: InvoiceDraft,
  invoiceId: Types.ObjectId,
  session: mongoose.ClientSession,
  now: Date
): Promise<void> {
  const needed = new Map<string, { partId: Types.ObjectId; name: string; quantity: number }>();
  for (const device of draft.devices) {
    for (const line of device.parts) {
      const key = line.partId.toString();
      const entry = needed.get(key) ?? { partId: line.partId, name: line.name, quantity: 0 };
      entry.quantity += line.quantity;
      needed.set(key, entry);
    }
  }

  const shortages: FieldErrors = {};
  const movements = [];
  for (const [key, entry] of needed) {
    const updated = await Part.findOneAndUpdate(
      { _id: entry.partId, companyId: auth.companyId, stockQuantity: { $gte: entry.quantity } },
      { $inc: { stockQuantity: -entry.quantity } },
      { session, new: true }
    );
    if (!updated) {
      shortages[`parts.${key}`] = [`Not enough stock for ${entry.name}`];
      continue;
    }
    movements.push({
      companyId: auth.companyId,
      partId: entry.partId,
      delta: -entry.quantity,
      quantityAfter: updated.stockQuantity,
      reason: "INVOICE_ISSUED" as const,
      invoiceId,
      actorId: auth.userId,
      occurredAt: now,
    });
  }

  if (Object.keys(shortages).length > 0) {
    throw HttpError.insufficientStock(undefined, shortages);
  }
  if (movements.length > 0) {
    await PartStockMovement.create(movements, { session, ordered: true });
  }
}

export interface IssueInvoiceOutcome {
  status: 201 | 200;
  invoice: InvoiceDocument;
}

/**
 * Issues the visit's one invoice, atomically: re-check assignment and
 * COMPLETED on the Visit document (the same serialization point as FS23),
 * price from the stored results/selections and current fee, take the
 * stock, write the invoice + ledger + VisitEvent — all or nothing. A
 * zero-total invoice (every device failed) is CLOSED with paymentState
 * NOT_REQUIRED and no payment record of any kind.
 */
export async function issueInvoice(
  auth: TechnicianAuthContext,
  visitId: string,
  idempotencyKey: string
): Promise<IssueInvoiceOutcome> {
  const visit = await findAssignedVisit(auth, visitId);

  const existing = await Invoice.findOne({ companyId: auth.companyId, visitId: visit._id });
  if (existing) {
    return replayOrConflict(existing, idempotencyKey);
  }
  if (visit.status !== "COMPLETED") {
    throw HttpError.visitStatusConflict("An invoice can only be issued for a COMPLETED visit");
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const touched = await Visit.findOneAndUpdate(
        { _id: visit._id, companyId: auth.companyId, technicianId: auth.userId, status: "COMPLETED" },
        { $set: { updatedAt: new Date() } },
        { session, new: true }
      );
      if (!touched) {
        // Reassigned since the first read (the only way a COMPLETED visit
        // stops matching) — same uniform 404 as any unassigned visit.
        throw HttpError.notFound("Visit not found");
      }

      const raced = await Invoice.findOne({ companyId: auth.companyId, visitId: visit._id }).session(session);
      if (raced) {
        return replayOrConflict(raced, idempotencyKey);
      }

      const { customerId, ...draft } = await loadDraft(auth, touched, session);
      if (draft.devices.some((device) => device.result === null)) {
        throw HttpError.workResultsIncomplete();
      }

      const now = new Date();
      const invoiceId = new mongoose.Types.ObjectId();
      await consumeStock(auth, draft, invoiceId, session, now);

      const zero = draft.totalMinor === 0;
      const status: InvoiceStatus = zero ? "CLOSED" : "ISSUED";
      const paymentState: PaymentState = zero ? "NOT_REQUIRED" : "UNPAID";

      const [invoice] = await Invoice.create(
        [
          {
            _id: invoiceId,
            companyId: auth.companyId,
            visitId: visit._id,
            requestId: visit.requestId,
            customerId,
            issuedById: auth.userId,
            reference: randomInvoiceReference(),
            idempotencyKey,
            ...draft,
            devices: draft.devices as InvoiceDevice[],
            status,
            paymentState,
            issuedAt: now,
          },
        ],
        { session }
      );

      await VisitEvent.create(
        [
          {
            companyId: auth.companyId,
            visitId: visit._id,
            requestId: visit.requestId,
            type: "INVOICE_ISSUED",
            actorId: auth.userId,
            technicianId: auth.userId,
            occurredAt: now,
            clientDeviceId: null,
            result: null,
          },
        ],
        { session, ordered: true }
      );

      return { status: 201 as const, invoice: invoice! };
    });
  } catch (error) {
    // A concurrent issuance committed first (unique companyId+visitId).
    if (isDuplicateKeyError(error)) {
      const winner = await Invoice.findOne({ companyId: auth.companyId, visitId: visit._id });
      if (winner) return replayOrConflict(winner, idempotencyKey);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}
