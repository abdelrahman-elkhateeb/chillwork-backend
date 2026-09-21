import type { Request, Response } from "express";
import { success } from "../../lib/envelope.js";
import { getHealthStatus } from "./health.service.js";

export function getHealth(_req: Request, res: Response): void {
  res.status(200).json(success(getHealthStatus()));
}
