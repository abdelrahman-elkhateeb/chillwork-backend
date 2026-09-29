import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { extractIdempotencyKey } from "../../lib/idempotency-key.js";
import { requireVisitIdParam } from "../technician/technician-visit.controller.js";
import type { InvoiceDocument } from "./invoice.model.js";
import { getIssuedInvoice, issueInvoice, previewInvoice, type InvoiceDraft } from "./invoice.service.js";

function toDeviceSections(devices: InvoiceDraft["devices"]) {
  return devices.map((device) => ({
    clientDeviceId: device.clientDeviceId,
    label: device.label,
    result: device.result,
    failureReason: device.failureReason,
    billable: device.billable,
    parts: device.parts.map((line) => ({
      partId: line.partId.toString(),
      name: line.name,
      unitPriceMinor: line.unitPriceMinor,
      quantity: line.quantity,
      lineTotalMinor: line.lineTotalMinor,
    })),
    partsMinor: device.partsMinor,
    laborMinor: device.laborMinor,
    totalMinor: device.totalMinor,
  }));
}

function toPreviewDto(draft: InvoiceDraft) {
  return {
    currency: draft.currency,
    laborFeeMinor: draft.laborFeeMinor,
    devices: toDeviceSections(draft.devices),
    subtotalMinor: draft.subtotalMinor,
    laborMinor: draft.laborMinor,
    totalMinor: draft.totalMinor,
  };
}

/** Never the raw document — no companyId/customerId/issuedById/idempotencyKey. */
function toInvoiceDto(invoice: InvoiceDocument) {
  return {
    id: invoice._id.toString(),
    reference: invoice.reference,
    visitId: invoice.visitId.toString(),
    ...toPreviewDto(invoice),
    status: invoice.status,
    paymentState: invoice.paymentState,
    issuedAt: invoice.issuedAt.toISOString(),
  };
}

function authOf(req: Request) {
  const auth = req.auth!;
  return { userId: auth.userId, companyId: auth.companyId };
}

export async function getInvoicePreview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.id as string | undefined);
    res.status(200).json(success(toPreviewDto(await previewInvoice(authOf(req), visitId))));
  } catch (error) {
    next(error);
  }
}

export async function postInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.id as string | undefined);
    const idempotencyKey = extractIdempotencyKey(req);
    const { status, invoice } = await issueInvoice(authOf(req), visitId, idempotencyKey);
    res.status(status).json(success(toInvoiceDto(invoice)));
  } catch (error) {
    next(error);
  }
}

export async function getInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.id as string | undefined);
    res.status(200).json(success(toInvoiceDto(await getIssuedInvoice(authOf(req), visitId))));
  } catch (error) {
    next(error);
  }
}
