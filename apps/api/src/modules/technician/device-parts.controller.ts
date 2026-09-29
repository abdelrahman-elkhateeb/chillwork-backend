import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { requireVisitIdParam } from "./technician-visit.controller.js";
import { recordPartDecisionsSchema, setDevicePartsSchema } from "./device-parts.schemas.js";
import { getVisitParts, recordPartDecisions, setDeviceParts } from "./device-parts.service.js";
import { requireDeviceIdParam } from "./work-result.controller.js";

export async function putDeviceParts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.visitId as string | undefined);
    const deviceId = requireDeviceIdParam(req.params.deviceId as string | undefined);
    const input = setDevicePartsSchema.parse(req.body);
    const auth = req.auth!;

    const view = await setDeviceParts({ userId: auth.userId, companyId: auth.companyId }, visitId, deviceId, input);

    res.status(200).json(success(view));
  } catch (error) {
    next(error);
  }
}

export async function postRecordPartDecisions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.visitId as string | undefined);
    const deviceId = requireDeviceIdParam(req.params.deviceId as string | undefined);
    const input = recordPartDecisionsSchema.parse(req.body);
    const auth = req.auth!;

    const view = await recordPartDecisions({ userId: auth.userId, companyId: auth.companyId }, visitId, deviceId, input);

    res.status(200).json(success(view));
  } catch (error) {
    next(error);
  }
}

export async function getParts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.visitId as string | undefined);
    const auth = req.auth!;

    const view = await getVisitParts({ userId: auth.userId, companyId: auth.companyId }, visitId);

    res.status(200).json(success(view));
  } catch (error) {
    next(error);
  }
}
