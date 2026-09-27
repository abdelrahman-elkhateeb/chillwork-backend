import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import { requireVisitIdParam } from "./technician-visit.controller.js";
import { recordWorkResultSchema } from "./work-result.schemas.js";
import { getVisitWorkResults, recordWorkResult, type VisitWorkResultsView } from "./work-result.service.js";
import type { WorkResultDocument } from "./work-result.model.js";

const MAX_DEVICE_ID_LENGTH = 200;

/** Same shape as the ai/requests modules' clientDeviceId bound — this is that same id. */
function requireDeviceIdParam(value: string | undefined): string {
  if (!value || value.length === 0 || value.length > MAX_DEVICE_ID_LENGTH) {
    throw HttpError.notFound("Device not found on this visit");
  }
  return value;
}

/** Never the raw Mongoose document — no companyId/visitId/requestId/recordedById. */
function toWorkResultDto(workResult: WorkResultDocument) {
  return {
    clientDeviceId: workResult.clientDeviceId,
    result: workResult.result,
    failureReason: workResult.failureReason,
    failureNote: workResult.failureNote,
    version: workResult.version,
  };
}

function toWorkResultsViewDto(view: VisitWorkResultsView) {
  return { visitId: view.visitId, outcome: view.outcome, devices: view.devices };
}

export async function putWorkResult(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.visitId as string | undefined);
    const deviceId = requireDeviceIdParam(req.params.deviceId as string | undefined);
    const input = recordWorkResultSchema.parse(req.body);
    const auth = req.auth!;

    const workResult = await recordWorkResult({ userId: auth.userId, companyId: auth.companyId }, visitId, deviceId, input);

    res.status(200).json(success(toWorkResultDto(workResult)));
  } catch (error) {
    next(error);
  }
}

export async function getWorkResults(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visitId = requireVisitIdParam(req.params.visitId as string | undefined);
    const auth = req.auth!;

    const view = await getVisitWorkResults({ userId: auth.userId, companyId: auth.companyId }, visitId);

    res.status(200).json(success(toWorkResultsViewDto(view)));
  } catch (error) {
    next(error);
  }
}
