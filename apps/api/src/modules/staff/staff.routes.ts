import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { requireRole } from "../../middleware/require-role.js";
import {
  getTechnicians,
  patchTechnician,
  postActivateTechnician,
  postInvitation,
  postTechnician,
} from "./technician-admin.controller.js";

export const staffRouter = Router();

const admin = [authenticate, requireRole("ADMIN")] as const;

staffRouter.get("/admin/technicians", ...admin, getTechnicians);
staffRouter.post("/admin/technicians", csrfOriginGuard, ...admin, postTechnician);
staffRouter.patch("/admin/technicians/:id", csrfOriginGuard, ...admin, patchTechnician);
staffRouter.post("/admin/technicians/:id/invitation", csrfOriginGuard, ...admin, postInvitation);

// Public (the technician has no session yet); CSRF-guarded and throttled per IP.
staffRouter.post("/auth/activate-technician", csrfOriginGuard, postActivateTechnician);
