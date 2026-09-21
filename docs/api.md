# fs-api — API Conventions

This document describes the conventions all `fs-api` endpoints follow. It
covers the foundation shipped in FS-101/FS-301; feature endpoints built on
top of it must follow the same rules.

## Response envelopes

Every JSON response uses one of two shapes. There is no bare/unwrapped
response body anywhere in the API.

### Success

```json
{
  "data": { "...": "..." },
  "meta": { "...": "optional" }
}
```

- `data` is required and holds the actual payload (object, array, or
  primitive).
- `meta` is optional and used for things like pagination metadata. Omit it
  entirely when there is nothing to report — don't send `"meta": {}`.
- `requestId` never appears in a success body.

### Failure

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "fieldErrors": {
      "email": ["Invalid email address"]
    },
    "requestId": "b3b6c6b0-9c1a-4c9a-9c1a-4c9a9c1a4c9a"
  }
}
```

- `code` is a stable, machine-readable string (e.g. `NOT_FOUND`,
  `VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`,
  `CONFLICT`, `INTERNAL_ERROR`). Clients may branch on it; don't repurpose
  a code for a different meaning later.
- `message` is a human-readable summary, safe to display or log. Never
  put secrets, tokens, or user-supplied request bodies into it.
- `fieldErrors` is optional and only present for validation-style
  failures. It maps a field path (dot-notation, e.g. `address.city`) to an
  array of human-readable messages for that field.
- `requestId` is always present on error responses and matches the
  `X-Request-Id` response header, so a client/support engineer can
  correlate an error with server logs.

## Request ID (`X-Request-Id`)

- Every response, success or failure, includes an `X-Request-Id` header
  with a server-generated UUID (v4), unique per request.
- The ID also appears in the body of error responses (`error.requestId`)
  so it's visible even to clients that don't inspect headers. It is
  intentionally **not** included in success bodies to keep the happy-path
  payload minimal.
- Server-side logs for a request include this same ID, so support/debugging
  can go from "client reports X-Request-Id" straight to the matching log
  lines.

## Pagination

List endpoints (once added) will use bounded, offset-based pagination
via query parameters:

- `page` — 1-indexed page number. Defaults to `1`. Values below 1 are
  rejected with `VALIDATION_ERROR`.
- `pageSize` — items per page. Defaults to a per-endpoint value (typically
  `20`) and is capped at a per-endpoint maximum (typically `100`).
  Requests for a larger `pageSize` are rejected, not silently clamped,
  so clients get an explicit error instead of confusing partial results.
- Responses include pagination metadata under `meta`, e.g.:

  ```json
  {
    "data": [ /* items */ ],
    "meta": {
      "page": 1,
      "pageSize": 20,
      "total": 143
    }
  }
  ```

- Sorting and filtering only ever operate on an explicit allow-list of
  fields defined per endpoint (documented alongside that endpoint). An
  unrecognized `sort` or `filter` field is a `VALIDATION_ERROR`, not a
  silently ignored parameter — this also keeps every sortable/filterable
  field backed by an index decision instead of accidentally allowing an
  unindexed full-collection scan.

## Timestamps

All timestamps in requests and responses are ISO 8601 strings in UTC
(e.g. `2026-09-21T14:03:00.000Z`). Clients are responsible for converting
to local time for display.

## Authentication

There is no authentication in this foundation. Cookie-based session
authentication is planned for **FS-02** and will be documented here once
implemented. Until then, all routes are unauthenticated.

## Endpoints

### `GET /api/v1/health`

Liveness check. Does **not** require a database connection — it must
succeed even if MongoDB is unreachable, so orchestration/monitoring can
distinguish "process is up" from "process can reach its dependencies".

Request: no parameters, no body.

Response `200`:

```json
{
  "data": { "status": "ok" }
}
```

Every other route under `/api/v1` connects to the database before
handling the request (see `src/middleware/require-db.ts`), since this API
never opens a database connection per request outside of that shared,
cached connection.
