import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";

/**
 * Catches any request that didn't match a route and converts it into an
 * HttpError so it flows through the centralized error handler and gets
 * the standard error envelope.
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(HttpError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}
