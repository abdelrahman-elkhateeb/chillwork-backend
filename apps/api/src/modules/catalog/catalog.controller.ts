import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { HttpError } from "../../lib/http-error.js";
import { OBJECT_ID_PATTERN } from "../visits/visit.constants.js";
import {
  adminPartsQuerySchema,
  catalogQuerySchema,
  createPartSchema,
  stockAdjustmentSchema,
  updatePartSchema,
} from "./catalog.schemas.js";
import {
  adjustStock,
  createPart,
  getCatalogPricing,
  listAdminParts,
  listCatalogParts,
  updatePart,
} from "./catalog.service.js";

/** A malformed id gets the same 404 as a part in another company. */
function requirePartIdParam(value: string | undefined): string {
  if (!value || !OBJECT_ID_PATTERN.test(value)) {
    throw HttpError.notFound("Part not found");
  }
  return value;
}

function authOf(req: Request) {
  const auth = req.auth!;
  return { userId: auth.userId, companyId: auth.companyId };
}

export async function getCatalogParts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = catalogQuerySchema.parse(req.query);
    const { items, page, pageSize, total } = await listCatalogParts(authOf(req), query);
    res.status(200).json(success(items, { page, pageSize, total }));
  } catch (error) {
    next(error);
  }
}

export async function getPricing(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(success(await getCatalogPricing(authOf(req))));
  } catch (error) {
    next(error);
  }
}

export async function getAdminParts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = adminPartsQuerySchema.parse(req.query);
    const { items, page, pageSize, total } = await listAdminParts(authOf(req), query);
    res.status(200).json(success(items, { page, pageSize, total }));
  } catch (error) {
    next(error);
  }
}

export async function postPart(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createPartSchema.parse(req.body);
    res.status(201).json(success(await createPart(authOf(req), input)));
  } catch (error) {
    next(error);
  }
}

export async function patchPart(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partId = requirePartIdParam(req.params.id as string | undefined);
    const input = updatePartSchema.parse(req.body);
    res.status(200).json(success(await updatePart(authOf(req), partId, input)));
  } catch (error) {
    next(error);
  }
}

export async function postStockAdjustment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const partId = requirePartIdParam(req.params.id as string | undefined);
    const input = stockAdjustmentSchema.parse(req.body);
    res.status(200).json(success(await adjustStock(authOf(req), partId, input)));
  } catch (error) {
    next(error);
  }
}
