import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { requireRole } from "../../middleware/require-role.js";
import {
  getTechnicianVisit,
  getTechnicianVisits,
  postCompleteVisit,
  postStartVisit,
} from "./technician-visit.controller.js";
import { getParts, putDeviceParts } from "./device-parts.controller.js";
import { getWorkResults, putWorkResult } from "./work-result.controller.js";

export const technicianRouter = Router();

const technician = [authenticate, requireRole("TECHNICIAN")] as const;

// Reads: no CSRF guard (GET is always safe/side-effect-free).
technicianRouter.get("/technician/visits", ...technician, getTechnicianVisits);
technicianRouter.get("/technician/visits/:id", ...technician, getTechnicianVisit);
technicianRouter.get("/technician/visits/:visitId/work-results", ...technician, getWorkResults);
technicianRouter.get("/technician/visits/:visitId/parts", ...technician, getParts);

// Mutations (FS23): csrfOriginGuard first (cheap, no DB), then the same
// authenticate/role chain. Every one of these re-runs the current
// company+technician+status scope itself — none of them trust a visit
// fetched by an earlier request.
technicianRouter.post("/technician/visits/:id/start", csrfOriginGuard, ...technician, postStartVisit);
technicianRouter.post("/technician/visits/:id/complete", csrfOriginGuard, ...technician, postCompleteVisit);
technicianRouter.put("/technician/visits/:visitId/work-results/:deviceId", csrfOriginGuard, ...technician, putWorkResult);
technicianRouter.put(
  "/technician/visits/:visitId/devices/:deviceId/parts",
  csrfOriginGuard,
  ...technician,
  putDeviceParts
);
