import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { getMe, postLogin, postLogout, postRefresh, postRegister } from "./auth.controller.js";

export const authRouter = Router();

authRouter.post("/auth/register", csrfOriginGuard, postRegister);
authRouter.post("/auth/login", csrfOriginGuard, postLogin);
authRouter.get("/auth/me", authenticate, getMe);
authRouter.post("/auth/refresh", csrfOriginGuard, postRefresh);
authRouter.post("/auth/logout", csrfOriginGuard, postLogout);
