import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import type { UserRole } from "../modules/users/user.model.js";

/**
 * FS15 is the first feature that needs role-gating, so this is the
 * smallest reusable mechanism for it — not a general RBAC framework.
 * Must run after `authenticate` (it reads `req.auth`, set there).
 * Role comes from the authenticated user document, never from the
 * request itself, so it can't be influenced by a client-supplied field.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return function requireRoleMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (!req.auth) {
      next(HttpError.unauthorized());
      return;
    }

    if (!allowedRoles.includes(req.auth.user.role)) {
      next(HttpError.forbidden());
      return;
    }

    next();
  };
}
