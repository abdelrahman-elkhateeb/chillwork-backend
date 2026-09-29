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
import { getParts, postRecordPartDecisions, putDeviceParts } from "./device-parts.controller.js";
import { getWorkResults, putWorkResult } from "./work-result.controller.js";
import { getWorkAgreementHandler, postProposeWorkItems, postRecordDecisions } from "./work-agreement.controller.js";

export const technicianRouter = Router();

const technician = [authenticate, requireRole("TECHNICIAN")] as const;

// Reads: no CSRF guard (GET is always safe/side-effect-free).
technicianRouter.get("/technician/visits", ...technician, getTechnicianVisits);
technicianRouter.get("/technician/visits/:id", ...technician, getTechnicianVisit);
technicianRouter.get("/technician/visits/:visitId/work-results", ...technician, getWorkResults);
// DEPRECATED (see work-agreement.service.ts): kept mounted for backward
// compatibility with any existing caller, but no longer consulted by
// FS23 or FS25 — DeviceParts (below) is now the sole approval/pricing
// source. See docs/api.md "Device part proposals and decisions".
technicianRouter.get("/technician/visits/:visitId/work-agreement", ...technician, getWorkAgreementHandler);
technicianRouter.get("/technician/visits/:visitId/parts", ...technician, getParts);

// Mutations (FS23): csrfOriginGuard first (cheap, no DB), then the same
// authenticate/role chain. Every one of these re-runs the current
// company+technician+status scope itself — none of them trust a visit
// fetched by an earlier request.
technicianRouter.post("/technician/visits/:id/start", csrfOriginGuard, ...technician, postStartVisit);
technicianRouter.post("/technician/visits/:id/complete", csrfOriginGuard, ...technician, postCompleteVisit);
technicianRouter.put("/technician/visits/:visitId/work-results/:deviceId", csrfOriginGuard, ...technician, putWorkResult);

// DEPRECATED mutations (see the GET note above) — same reasoning.
technicianRouter.post(
  "/technician/visits/:visitId/work-agreement/items",
  csrfOriginGuard,
  ...technician,
  postProposeWorkItems
);
technicianRouter.post(
  "/technician/visits/:visitId/work-agreement/decisions",
  csrfOriginGuard,
  ...technician,
  postRecordDecisions
);

// DeviceParts (FS11): the active proposal + customer-decision source that
// FS23 (assertDeviceApprovedForActualWork) and FS25 (buildInvoiceDraft)
// both validate against. See device-parts.service.ts.
technicianRouter.put(
  "/technician/visits/:visitId/devices/:deviceId/parts",
  csrfOriginGuard,
  ...technician,
  putDeviceParts
);
technicianRouter.post(
  "/technician/visits/:visitId/devices/:deviceId/parts/decisions",
  csrfOriginGuard,
  ...technician,
  postRecordPartDecisions
);
