import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare module "express-serve-static-core" {
  interface Locals {
    requestId: string;
  }
}

const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Assigns a unique request ID to every incoming request, stores it on
 * res.locals for downstream handlers (e.g. the error handler), and echoes
 * it back on every response via the X-Request-Id header.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
