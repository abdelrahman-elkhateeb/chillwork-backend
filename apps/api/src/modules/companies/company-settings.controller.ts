import type { NextFunction, Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { updateCompanySettingsSchema } from "./company-settings.schemas.js";
import { getCompanySettings, updateCompanySettings } from "./company-settings.service.js";

/** Admin-only (see company-settings.routes.ts). The company is always `req.auth.companyId`. */
export async function getSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = req.auth!;
    const settings = await getCompanySettings({ userId: auth.userId, companyId: auth.companyId });
    res.status(200).json(success(settings));
  } catch (error) {
    next(error);
  }
}

export async function patchSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateCompanySettingsSchema.parse(req.body);
    const auth = req.auth!;
    const settings = await updateCompanySettings({ userId: auth.userId, companyId: auth.companyId }, input);
    res.status(200).json(success(settings));
  } catch (error) {
    next(error);
  }
}
