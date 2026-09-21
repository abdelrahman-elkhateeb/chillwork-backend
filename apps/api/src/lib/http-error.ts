export type FieldErrors = Record<string, string[]>;

/**
 * Thrown by services/controllers to signal an HTTP-relevant failure.
 * The centralized error handler translates instances of this class
 * into the standard error envelope.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: FieldErrors;

  constructor(status: number, code: string, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  static badRequest(message: string, fieldErrors?: FieldErrors): HttpError {
    return new HttpError(400, "BAD_REQUEST", message, fieldErrors);
  }

  static notFound(message = "Resource not found"): HttpError {
    return new HttpError(404, "NOT_FOUND", message);
  }

  static unauthorized(message = "Authentication required"): HttpError {
    return new HttpError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "Not allowed to perform this action"): HttpError {
    return new HttpError(403, "FORBIDDEN", message);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, "CONFLICT", message);
  }

  static internal(message = "Internal server error"): HttpError {
    return new HttpError(500, "INTERNAL_ERROR", message);
  }
}
