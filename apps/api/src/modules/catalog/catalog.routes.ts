import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { requireRole } from "../../middleware/require-role.js";
import {
  getAdminParts,
  getCatalogParts,
  getPricing,
  patchPart,
  postPart,
  postStockAdjustment,
} from "./catalog.controller.js";

export const catalogRouter = Router();

// Catalog reads: every role in the company (customers see prices up front,
// technicians pick from it). Company comes from req.auth only.
catalogRouter.get("/catalog/parts", authenticate, getCatalogParts);
catalogRouter.get("/catalog/pricing", authenticate, getPricing);

const admin = [authenticate, requireRole("ADMIN")] as const;

catalogRouter.get("/admin/parts", ...admin, getAdminParts);
catalogRouter.post("/admin/parts", csrfOriginGuard, ...admin, postPart);
catalogRouter.patch("/admin/parts/:id", csrfOriginGuard, ...admin, patchPart);
catalogRouter.post("/admin/parts/:id/stock-adjustments", csrfOriginGuard, ...admin, postStockAdjustment);
