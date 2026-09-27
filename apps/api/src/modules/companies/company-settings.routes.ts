import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { requireRole } from "../../middleware/require-role.js";
import { getSettings, patchSettings } from "./company-settings.controller.js";

export const companySettingsRouter = Router();

companySettingsRouter.get("/admin/company-settings", authenticate, requireRole("ADMIN"), getSettings);
companySettingsRouter.patch(
  "/admin/company-settings",
  csrfOriginGuard,
  authenticate,
  requireRole("ADMIN"),
  patchSettings
);
