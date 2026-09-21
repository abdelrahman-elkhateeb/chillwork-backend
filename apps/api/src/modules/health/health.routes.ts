import { Router } from "express";
import { getHealth } from "./health.controller.js";

export const healthRouter = Router();

// No requireDb middleware here on purpose: health must respond without
// a database connection.
healthRouter.get("/health", getHealth);
