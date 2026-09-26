import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";
import { technicianVisitsQuerySchema } from "./technician-visit.schemas.js";
import { getAssignedVisitDetail, listAssignedVisits } from "./technician-visit.service.js";

/**
 * Both handlers run behind `authenticate` + `requireRole("TECHNICIAN")`.
 * The technician is `req.auth.userId` in `req.auth.companyId`; the client
 * only ever names the visit.
 */
export async function getTechnicianVisits(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = technicianVisitsQuerySchema.parse(req.query);
    const auth = req.auth!;

    const { items, page, pageSize, total } = await listAssignedVisits(
      { userId: auth.userId, companyId: auth.companyId },
      query
    );

    res.status(200).json(success(items, { page, pageSize, total }));
  } catch (error) {
    next(error);
  }
}

export async function getTechnicianVisit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = req.params.id as string | undefined;
    // A malformed id gets the same 404 as any other visit the caller can't see.
    if (!visitId || !OBJECT_ID_PATTERN.test(visitId)) {
      throw HttpError.notFound("Visit not found");
    }
    const auth = req.auth!;

    const detail = await getAssignedVisitDetail({ userId: auth.userId, companyId: auth.companyId }, visitId);

    res.status(200).json(success(detail));
  } catch (error) {
    next(error);
  }
}
