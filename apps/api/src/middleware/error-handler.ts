import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { failure } from "../lib/envelope.js";
import { HttpError, type FieldErrors } from "../lib/http-error.js";

function fieldErrorsFromZod(error: ZodError): FieldErrors {
  const fieldErrors: FieldErrors = {};

  for (const issue of error.issues) {
    const path = issue.path.join(".") || "(root)";
    fieldErrors[path] = [...(fieldErrors[path] ?? []), issue.message];
  }

  return fieldErrors;
}

/**
 * Centralized error handler. Must be registered last, after all routes.
 * Never logs secrets, tokens, cookies, or request bodies — only method,
 * path, requestId and the error's own message/stack.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = res.locals.requestId ?? "unknown";

  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Internal server error";
  let fieldErrors: FieldErrors | undefined;

  if (err instanceof HttpError) {
    status = err.status;
    code = err.code;
    message = err.message;
    fieldErrors = err.fieldErrors;
  } else if (err instanceof ZodError) {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "Request validation failed";
    fieldErrors = fieldErrorsFromZod(err);
  }

  console.error({
    requestId,
    method: req.method,
    path: req.originalUrl,
    status,
    code,
    message: err instanceof Error ? err.message : message,
  });

  res.status(status).json(failure(code, message, requestId, fieldErrors));
}
