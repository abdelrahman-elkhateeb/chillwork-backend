import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";
import { customerRequestsQuerySchema } from "./customer-request.schemas.js";
import { getCustomerRequest, getCustomerRequestTimeline, listCustomerRequests } from "./customer-request.service.js";

/** A malformed id gets the same 404 as another customer's request. */
function requireRequestIdParam(value: string | undefined): string {
  if (!value || !OBJECT_ID_PATTERN.test(value)) {
    throw HttpError.notFound("Request not found");
  }
  return value;
}

function authOf(req: Request) {
  const auth = req.auth!;
  return { userId: auth.userId, companyId: auth.companyId };
}

export async function getMyRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = customerRequestsQuerySchema.parse(req.query);
    const { items, page, pageSize, total } = await listCustomerRequests(authOf(req), query);
    res.status(200).json(success(items, { page, pageSize, total }));
  } catch (error) {
    next(error);
  }
}

export async function getMyRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requestId = requireRequestIdParam(req.params.id as string | undefined);
    res.status(200).json(success(await getCustomerRequest(authOf(req), requestId)));
  } catch (error) {
    next(error);
  }
}

export async function getMyRequestTimeline(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requestId = requireRequestIdParam(req.params.id as string | undefined);
    res.status(200).json(success(await getCustomerRequestTimeline(authOf(req), requestId)));
  } catch (error) {
    next(error);
  }
}
