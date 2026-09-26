import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import { OBJECT_ID_PATTERN } from "./visit.constants.js";
import type { VisitDocument } from "./visit.model.js";
import { availabilityQuerySchema, createVisitSchema } from "./visit.schemas.js";
import { createVisit, getTechnicianAvailability } from "./visit.service.js";

/** Explicit allow-list mapper — never the raw document. All instants are UTC ISO-8601. */
function toVisitDto(visit: VisitDocument) {
  return {
    visitId: visit._id.toString(),
    requestId: visit.requestId.toString(),
    technicianId: visit.technicianId.toString(),
    startAt: visit.startAt.toISOString(),
    endAt: visit.endAt.toISOString(),
    timezone: visit.timezone,
    deviceIds: visit.deviceIds,
    workTypes: visit.workTypes,
    status: visit.status,
  };
}

function requireObjectIdParam(value: string | undefined, what: string): string {
  if (!value || !OBJECT_ID_PATTERN.test(value)) {
    throw HttpError.notFound(`${what} not found`);
  }
  return value;
}

/** Identity comes only from `req.auth` (set by authenticate, gated by requireRole("ADMIN")). */
export async function postCreateVisit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requestId = requireObjectIdParam(req.params.id as string | undefined, "Request");
    const input = createVisitSchema.parse(req.body);
    const auth = req.auth!;

    const visit = await createVisit({ userId: auth.userId, companyId: auth.companyId }, requestId, input);

    res.status(201).json(success(toVisitDto(visit)));
  } catch (error) {
    next(error);
  }
}

export async function getAvailability(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const technicianId = requireObjectIdParam(req.params.id as string | undefined, "Technician");
    const query = availabilityQuerySchema.parse(req.query);
    const auth = req.auth!;

    const availability = await getTechnicianAvailability(
      { userId: auth.userId, companyId: auth.companyId },
      technicianId,
      query
    );

    res.status(200).json(
      success({
        technicianId: availability.technicianId,
        timezone: availability.timezone,
        from: availability.from.toISOString(),
        to: availability.to.toISOString(),
        busy: availability.busy.map((interval) => ({
          visitId: interval.visitId,
          startAt: interval.startAt.toISOString(),
          endAt: interval.endAt.toISOString(),
        })),
      })
    );
  } catch (error) {
    next(error);
  }
}
