import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { requireVisitIdParam } from "./technician-visit.controller.js";
import { proposeWorkItemsSchema, recordDecisionsSchema } from "./work-agreement.schemas.js";
import { getWorkAgreement, proposeWorkItems, recordDecisions, type WorkAgreementView } from "./work-agreement.service.js";

/**
 * The view returned by the service is already an explicit allow-list (see
 * work-agreement.service.ts's `toWorkAgreementView`/`toWorkItemView`) — no
 * proposedById/decidedById, no companyId/requestId, no photo fields. This
 * just forwards it; there is no raw Mongoose document in this path.
 */
function toWorkAgreementDto(view: WorkAgreementView) {
  return view;
}

export async function postProposeWorkItems(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.visitId as string | undefined);
    const input = proposeWorkItemsSchema.parse(req.body);
    const auth = req.auth!;

    const view = await proposeWorkItems({ userId: auth.userId, companyId: auth.companyId }, visitId, input);

    res.status(200).json(success(toWorkAgreementDto(view)));
  } catch (error) {
    next(error);
  }
}

export async function postRecordDecisions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.visitId as string | undefined);
    const input = recordDecisionsSchema.parse(req.body);
    const auth = req.auth!;

    const view = await recordDecisions({ userId: auth.userId, companyId: auth.companyId }, visitId, input);

    res.status(200).json(success(toWorkAgreementDto(view)));
  } catch (error) {
    next(error);
  }
}

export async function getWorkAgreementHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.visitId as string | undefined);
    const auth = req.auth!;

    const view = await getWorkAgreement({ userId: auth.userId, companyId: auth.companyId }, visitId);

    res.status(200).json(success(toWorkAgreementDto(view)));
  } catch (error) {
    next(error);
  }
}
