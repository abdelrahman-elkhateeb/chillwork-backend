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

  static invalidCredentials(message = "Invalid email or password"): HttpError {
    return new HttpError(401, "INVALID_CREDENTIALS", message);
  }

  static sessionExpired(message = "Session has expired"): HttpError {
    return new HttpError(401, "SESSION_EXPIRED", message);
  }

  static sessionRevoked(message = "Session has been revoked"): HttpError {
    return new HttpError(401, "SESSION_REVOKED", message);
  }

  static invalidRefreshToken(message = "Refresh token is invalid"): HttpError {
    return new HttpError(401, "INVALID_REFRESH_TOKEN", message);
  }

  static refreshTokenReused(message = "Refresh token has already been used"): HttpError {
    return new HttpError(401, "REFRESH_TOKEN_REUSED", message);
  }

  static rateLimited(message = "Too many requests, please try again later"): HttpError {
    return new HttpError(429, "RATE_LIMITED", message);
  }

  static csrfOriginRejected(message = "Request origin is not allowed"): HttpError {
    return new HttpError(403, "CSRF_ORIGIN_REJECTED", message);
  }

  static demoCompanyUnavailable(message = "Registration is temporarily unavailable"): HttpError {
    return new HttpError(503, "DEMO_COMPANY_UNAVAILABLE", message);
  }

  static missingIdempotencyKey(message = "Idempotency-Key header is required"): HttpError {
    return new HttpError(400, "MISSING_IDEMPOTENCY_KEY", message);
  }

  static invalidIdempotencyKey(message = "Idempotency-Key header is invalid"): HttpError {
    return new HttpError(400, "INVALID_IDEMPOTENCY_KEY", message);
  }

  static idempotencyInProgress(message = "This submission is already being processed"): HttpError {
    return new HttpError(409, "IDEMPOTENCY_IN_PROGRESS", message);
  }

  static idempotencyConflict(message = "This Idempotency-Key was already used with different request data"): HttpError {
    return new HttpError(409, "IDEMPOTENCY_CONFLICT", message);
  }

  static requestCreationFailed(message = "Unable to create the request, please try again"): HttpError {
    return new HttpError(500, "REQUEST_CREATION_FAILED", message);
  }

  static validationFailed(message: string, fieldErrors: FieldErrors): HttpError {
    return new HttpError(400, "VALIDATION_ERROR", message, fieldErrors);
  }

  static scheduleConflict(message = "The technician already has a visit overlapping this time"): HttpError {
    return new HttpError(409, "SCHEDULE_CONFLICT", message);
  }

  static requestNotSchedulable(message = "This request cannot be scheduled in its current state"): HttpError {
    return new HttpError(409, "REQUEST_NOT_SCHEDULABLE", message);
  }

  static deviceAlreadyScheduled(message = "One or more devices are already part of an active visit"): HttpError {
    return new HttpError(409, "DEVICE_ALREADY_SCHEDULED", message);
  }

  static visitStatusConflict(message = "The visit is not in a state that allows this action"): HttpError {
    return new HttpError(409, "VISIT_STATUS_CONFLICT", message);
  }

  static versionConflict(message = "This work result was changed by another update, please refresh and retry"): HttpError {
    return new HttpError(409, "VERSION_CONFLICT", message);
  }

  static workResultsIncomplete(message = "Every device on this visit needs a recorded result before it can be completed"): HttpError {
    return new HttpError(409, "WORK_RESULTS_INCOMPLETE", message);
  }

  static billingNotConfigured(message = "Billing settings (currency and labor fee) are not configured"): HttpError {
    return new HttpError(409, "BILLING_NOT_CONFIGURED", message);
  }

  static currencyLocked(message = "The company currency cannot be changed once it is set"): HttpError {
    return new HttpError(409, "CURRENCY_LOCKED", message);
  }

  static insufficientStock(message = "Not enough stock for one or more parts", fieldErrors?: FieldErrors): HttpError {
    return new HttpError(409, "INSUFFICIENT_STOCK", message, fieldErrors);
  }
}
