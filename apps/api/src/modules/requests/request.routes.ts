import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { requireRole } from "../../middleware/require-role.js";
import { getAdminRequestDetail, getAdminRequests } from "./admin-request.controller.js";
import { postCreateRequest } from "./request.controller.js";

export const requestsRouter = Router();

requestsRouter.post("/requests", csrfOriginGuard, authenticate, requireRole("CUSTOMER"), postCreateRequest);

// FS17 admin triage (read-only).
requestsRouter.get("/admin/requests", authenticate, requireRole("ADMIN"), getAdminRequests);
requestsRouter.get("/admin/requests/:id", authenticate, requireRole("ADMIN"), getAdminRequestDetail);
