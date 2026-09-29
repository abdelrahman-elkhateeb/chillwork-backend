import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";
import {
  activateTechnicianSchema,
  createTechnicianSchema,
  techniciansQuerySchema,
  updateTechnicianSchema,
} from "./technician-admin.schemas.js";
import {
  activateTechnician,
  checkActivationThrottle,
  createTechnician,
  listTechnicians,
  reissueInvitation,
  updateTechnician,
} from "./technician-admin.service.js";

function requireTechnicianIdParam(value: string | undefined): string {
  if (!value || !OBJECT_ID_PATTERN.test(value)) {
    throw HttpError.notFound("Technician not found");
  }
  return value;
}

function authOf(req: Request) {
  const auth = req.auth!;
  return { userId: auth.userId, companyId: auth.companyId };
}

export async function getTechnicians(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = techniciansQuerySchema.parse(req.query);
    const { items, page, pageSize, total } = await listTechnicians(authOf(req), query);
    res.status(200).json(success(items, { page, pageSize, total }));
  } catch (error) {
    next(error);
  }
}

export async function postTechnician(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createTechnicianSchema.parse(req.body);
    res.status(201).json(success(await createTechnician(authOf(req), input)));
  } catch (error) {
    next(error);
  }
}

export async function patchTechnician(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const technicianId = requireTechnicianIdParam(req.params.id as string | undefined);
    const input = updateTechnicianSchema.parse(req.body);
    res.status(200).json(success(await updateTechnician(authOf(req), technicianId, input)));
  } catch (error) {
    next(error);
  }
}

export async function postInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const technicianId = requireTechnicianIdParam(req.params.id as string | undefined);
    res.status(201).json(success(await reissueInvitation(authOf(req), technicianId)));
  } catch (error) {
    next(error);
  }
}

export async function postActivateTechnician(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = activateTechnicianSchema.parse(req.body);
    await checkActivationThrottle(req.ip ?? "unknown");
    res.status(200).json(success(await activateTechnician(input)));
  } catch (error) {
    next(error);
  }
}
