import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { requireRole } from "../../middleware/require-role.js";
import { getAvailability, postCreateVisit } from "./visit.controller.js";

export const visitsRouter = Router();

visitsRouter.post("/admin/requests/:id/visits", csrfOriginGuard, authenticate, requireRole("ADMIN"), postCreateVisit);
visitsRouter.get("/admin/technicians/:id/availability", authenticate, requireRole("ADMIN"), getAvailability);
