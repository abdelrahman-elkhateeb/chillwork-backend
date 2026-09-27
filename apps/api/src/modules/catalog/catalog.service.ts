import mongoose, { type FilterQuery, type Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { requireBillingSettings } from "../companies/company-settings.service.js";
import type { Currency } from "../companies/company-settings.constants.js";
import type {
  AdminPartsQuery,
  CatalogQuery,
  CreatePartInput,
  StockAdjustmentInput,
  UpdatePartInput,
} from "./catalog.schemas.js";
import { PartStockMovement } from "./part-stock-movement.model.js";
import { Part, partNameKey, type PartDocument } from "./part.model.js";

export interface CatalogAuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
}

/** FS11 Part DTO — safe for every role. No stock count, only the derived flag. */
export interface CatalogPartDto {
  id: string;
  name: string;
  description: string | null;
  unitPriceMinor: number;
  currency: Currency;
  inStock: boolean;
  isActive: boolean;
}

/** Admin view: the catalog DTO plus the actual count. */
export interface AdminPartDto extends CatalogPartDto {
  stockQuantity: number;
}

export function toCatalogPart(part: PartDocument, currency: Currency): CatalogPartDto {
  return {
    id: part._id.toString(),
    name: part.name,
    description: part.description,
    unitPriceMinor: part.unitPriceMinor,
    currency,
    inStock: part.stockQuantity > 0,
    isActive: part.isActive,
  };
}

function toAdminPart(part: PartDocument, currency: Currency): AdminPartDto {
  return { ...toCatalogPart(part, currency), stockQuantity: part.stockQuantity };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function partFilter(
  companyId: Types.ObjectId,
  query: { q?: string; available?: boolean; isActive?: boolean }
): FilterQuery<PartDocument> {
  const filter: FilterQuery<PartDocument> = { companyId };
  if (query.isActive !== undefined) filter.isActive = query.isActive;
  if (query.available !== undefined) filter.stockQuantity = query.available ? { $gt: 0 } : 0;
  if (query.q) filter.nameKey = { $regex: escapeRegex(partNameKey(query.q)) };
  return filter;
}

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

async function pageOfParts(filter: FilterQuery<PartDocument>, page: number, pageSize: number) {
  return Promise.all([
    Part.find(filter)
      .sort({ nameKey: 1, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
    Part.countDocuments(filter),
  ]);
}

/** Any authenticated role. Inactive parts are hidden; out-of-stock ones stay visible as `inStock: false`. */
export async function listCatalogParts(auth: CatalogAuthContext, query: CatalogQuery): Promise<Page<CatalogPartDto>> {
  const { currency } = await requireBillingSettings(auth.companyId);
  const [parts, total] = await pageOfParts(
    partFilter(auth.companyId, { ...query, isActive: true }),
    query.page,
    query.pageSize
  );
  return { items: parts.map((part) => toCatalogPart(part, currency)), page: query.page, pageSize: query.pageSize, total };
}

/** The customer/technician-safe pricing facts: what a repaired device costs in labor. */
export async function getCatalogPricing(auth: CatalogAuthContext) {
  const { currency, laborFeeMinor } = await requireBillingSettings(auth.companyId);
  return { currency, laborFeeMinor };
}

export async function listAdminParts(auth: CatalogAuthContext, query: AdminPartsQuery): Promise<Page<AdminPartDto>> {
  const { currency } = await requireBillingSettings(auth.companyId);
  const [parts, total] = await pageOfParts(partFilter(auth.companyId, query), query.page, query.pageSize);
  return { items: parts.map((part) => toAdminPart(part, currency)), page: query.page, pageSize: query.pageSize, total };
}

function duplicateName(): HttpError {
  return HttpError.conflict("A part with this name already exists");
}

export async function createPart(auth: CatalogAuthContext, input: CreatePartInput): Promise<AdminPartDto> {
  const { currency } = await requireBillingSettings(auth.companyId);

  const session = await mongoose.startSession();
  try {
    const part = await session.withTransaction(async () => {
      const [created] = await Part.create(
        [
          {
            companyId: auth.companyId,
            name: input.name,
            nameKey: partNameKey(input.name),
            description: input.description ?? null,
            unitPriceMinor: input.unitPriceMinor,
            stockQuantity: input.stockQuantity,
            isActive: input.isActive,
          },
        ],
        { session }
      );
      if (input.stockQuantity > 0) {
        await PartStockMovement.create(
          [
            {
              companyId: auth.companyId,
              partId: created!._id,
              delta: input.stockQuantity,
              quantityAfter: input.stockQuantity,
              reason: "ADMIN_ADJUSTMENT",
              note: "Initial stock",
              actorId: auth.userId,
              occurredAt: new Date(),
            },
          ],
          { session }
        );
      }
      return created!;
    });
    return toAdminPart(part, currency);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw duplicateName();
    throw error;
  } finally {
    await session.endSession();
  }
}

/**
 * Name/description/price/active only. A price change affects future
 * selections only — existing selections and invoices hold their own
 * snapshots. Another company's part is a plain 404.
 */
export async function updatePart(auth: CatalogAuthContext, partId: string, input: UpdatePartInput): Promise<AdminPartDto> {
  const { currency } = await requireBillingSettings(auth.companyId);

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) {
    set.name = input.name;
    set.nameKey = partNameKey(input.name);
  }
  if (input.description !== undefined) set.description = input.description;
  if (input.unitPriceMinor !== undefined) set.unitPriceMinor = input.unitPriceMinor;
  if (input.isActive !== undefined) set.isActive = input.isActive;

  try {
    const part = await Part.findOneAndUpdate({ _id: partId, companyId: auth.companyId }, { $set: set }, { new: true });
    if (!part) throw HttpError.notFound("Part not found");
    return toAdminPart(part, currency);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw duplicateName();
    throw error;
  }
}

/**
 * Atomic delta: a decrement is guarded by `stockQuantity >= -delta` in the
 * same update, so it can never go negative even against a concurrent
 * invoice. The ledger entry is written in the same transaction.
 */
export async function adjustStock(
  auth: CatalogAuthContext,
  partId: string,
  input: StockAdjustmentInput
): Promise<AdminPartDto> {
  const { currency } = await requireBillingSettings(auth.companyId);

  const session = await mongoose.startSession();
  try {
    const part = await session.withTransaction(async () => {
      const filter: FilterQuery<PartDocument> = { _id: partId, companyId: auth.companyId };
      if (input.delta < 0) filter.stockQuantity = { $gte: -input.delta };

      const updated = await Part.findOneAndUpdate(filter, { $inc: { stockQuantity: input.delta } }, { session, new: true });
      if (!updated) {
        const exists = await Part.exists({ _id: partId, companyId: auth.companyId }).session(session);
        if (!exists) throw HttpError.notFound("Part not found");
        throw HttpError.insufficientStock("Stock cannot go below zero");
      }

      await PartStockMovement.create(
        [
          {
            companyId: auth.companyId,
            partId: updated._id,
            delta: input.delta,
            quantityAfter: updated.stockQuantity,
            reason: "ADMIN_ADJUSTMENT",
            note: input.note ?? null,
            actorId: auth.userId,
            occurredAt: new Date(),
          },
        ],
        { session }
      );
      return updated;
    });
    return toAdminPart(part, currency);
  } finally {
    await session.endSession();
  }
}
