import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import { IDEMPOTENCY_KEY_PATTERN } from "./request.constants.js";
import { createRequestSchema } from "./request.schemas.js";
import { checkRequestCreationThrottle, createServiceRequest } from "./request.service.js";
import type { ServiceRequestDocument } from "./request.model.js";

/**
 * Never the raw Mongoose document. Deliberately excludes `analysis`/
 * `analysisMetadata` — AI output is a staff-facing concern (see
 * docs/api.md "Customer-safe response"), not something this customer
 * creation endpoint returns.
 */
function toSafeServiceRequest(doc: ServiceRequestDocument) {
  return {
    requestId: doc._id.toString(),
    reference: doc.reference,
    status: doc.status,
    devices: doc.devices.map((device) => ({
      clientDeviceId: device.clientDeviceId,
      label: device.label,
      brand: device.brand,
      model: device.model,
      originalDescription: device.originalDescription,
    })),
  };
}

function extractIdempotencyKey(req: Request): string {
  const header = req.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;

  if (!value) {
    throw HttpError.missingIdempotencyKey();
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw HttpError.invalidIdempotencyKey();
  }
  return value;
}

/**
 * Authorization has already happened by the time this runs (`authenticate`
 * + `requireRole("CUSTOMER")` on the route) — company/customer identity
 * comes only from `req.auth`, never from the request body, which is why
 * `createRequestSchema` doesn't even have `companyId`/`customerId` fields
 * to strip.
 */
export async function postCreateRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createRequestSchema.parse(req.body);
    const idempotencyKey = extractIdempotencyKey(req);
    const auth = req.auth!;

    await checkRequestCreationThrottle(auth.userId);

    const { status, request } = await createServiceRequest(
      { userId: auth.userId, companyId: auth.companyId },
      input,
      idempotencyKey
    );

    res.status(status).json(success(toSafeServiceRequest(request)));
  } catch (error) {
    next(error);
  }
}
