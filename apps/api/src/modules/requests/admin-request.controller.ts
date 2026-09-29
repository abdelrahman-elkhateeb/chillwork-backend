import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";
import { adminRequestsQuerySchema } from "./admin-request.schemas.js";
import { getAdminRequest, listAdminRequests } from "./admin-request.service.js";

/** Admin-only (see request.routes.ts). The company is always `req.auth.companyId`. */
export async function getAdminRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = adminRequestsQuerySchema.parse(req.query);
    const auth = req.auth!;
    const { items, page, pageSize, total } = await listAdminRequests(
      { userId: auth.userId, companyId: auth.companyId },
      query
    );
    res.status(200).json(success(items, { page, pageSize, total }));
  } catch (error) {
    next(error);
  }
}

export async function getAdminRequestDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requestId = req.params.id as string | undefined;
    if (!requestId || !OBJECT_ID_PATTERN.test(requestId)) {
      throw HttpError.notFound("Request not found");
    }
    const auth = req.auth!;
    const detail = await getAdminRequest({ userId: auth.userId, companyId: auth.companyId }, requestId);
    res.status(200).json(success(detail));
  } catch (error) {
    next(error);
  }
}
