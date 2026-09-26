import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireRole } from "../../middleware/require-role.js";
import { getTechnicianVisit, getTechnicianVisits } from "./technician-visit.controller.js";

export const technicianRouter = Router();

// Read-only (GET), so no CSRF guard. Any future mutating technician route
// must add csrfOriginGuard and re-run findAssignedVisit itself.
technicianRouter.get("/technician/visits", authenticate, requireRole("TECHNICIAN"), getTechnicianVisits);
technicianRouter.get("/technician/visits/:id", authenticate, requireRole("TECHNICIAN"), getTechnicianVisit);
