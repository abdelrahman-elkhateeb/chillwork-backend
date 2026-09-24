import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { requireRole } from "../../middleware/require-role.js";
import { postCreateRequest } from "./request.controller.js";

export const requestsRouter = Router();

requestsRouter.post("/requests", csrfOriginGuard, authenticate, requireRole("CUSTOMER"), postCreateRequest);
