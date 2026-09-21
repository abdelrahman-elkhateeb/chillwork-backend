import type { FieldErrors } from "./http-error.js";

export interface SuccessEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    fieldErrors?: FieldErrors;
    requestId: string;
  };
}

export function success<T>(data: T, meta?: Record<string, unknown>): SuccessEnvelope<T> {
  return meta ? { data, meta } : { data };
}

export function failure(
  code: string,
  message: string,
  requestId: string,
  fieldErrors?: FieldErrors
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
      ...(fieldErrors ? { fieldErrors } : {}),
    },
  };
}
