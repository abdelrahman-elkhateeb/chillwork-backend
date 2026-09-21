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

## Authentication (FS02)

Session authentication is cookie-based. On every request, the JWT in
`access_token` is only ever a *pointer* to server-side state — it is
**never** sufficient on its own. Every protected request re-validates,
straight from MongoDB:

1. the JWT's signature and expiration,
2. that the session it names still exists and hasn't been revoked,
3. that the session's rolling and absolute expiry haven't passed,
4. that the user still exists and is active,
5. that the user still belongs to the session's company, and the company
   is active.

A valid, unexpired JWT whose session has been revoked is rejected with
`401 SESSION_REVOKED` — revocation always wins.

### Lifetimes

| Token / session       | Lifetime                                   |
| ---------------------- | ------------------------------------------- |
| Access JWT              | 15 minutes                                 |
| Session rolling expiry  | 7 days from the most recent refresh        |
| Session absolute expiry | 30 days from the original login, fixed     |

The rolling expiry is always `min(now + 7 days, absoluteExpiresAt)` —
`absoluteExpiresAt` is computed once at login and never moves, so no
sequence of refreshes can keep a session alive past 30 days from its
original login.

### Cookies

| Cookie          | Contents                          | Path              | Notes |
| ---------------- | ---------------------------------- | ------------------ | ----- |
| `access_token`   | JWT (`sub`, `sid`, `iat`, `exp`)   | `/`                | 15-minute `Max-Age` |
| `refresh_token`  | Opaque random token (never a JWT) | `/api/v1/auth`     | `Max-Age` matches the session's rolling expiry |

Both cookies are always `HttpOnly`; `Secure` is on in production and
configurable via `AUTH_COOKIE_SECURE`; `SameSite` defaults to `Lax`
(`AUTH_COOKIE_SAME_SITE`). **Neither cookie ever sets a `Domain`
attribute** — this is required for the same-origin proxy FS01 depends on.
Final CORS/domain configuration is FS33's responsibility, not FS02's.

The refresh token itself is 256 bits of `crypto.randomBytes`, base64url
-encoded. Only its SHA-256 hash is ever persisted — the raw value exists
solely in the cookie and the response that set it, and is never returned
in a JSON body.

### Endpoints

#### `POST /api/v1/auth/login`

Public. Subject to [throttling](#throttling) and the
[CSRF/origin guard](#csrforigin-protection).

Request body:

```json
{ "email": "user@example.com", "password": "..." }
```

Response `200` sets `access_token`/`refresh_token` cookies and returns:

```json
{
  "data": {
    "user": { "id": "...", "email": "...", "name": "...", "companyId": "..." },
    "session": { "id": "...", "expiresAt": "2026-09-29T00:00:00.000Z" }
  }
}
```

Errors: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401 — returned
identically for an unknown email, a wrong password, or a deactivated
user/company, so login can't be used to enumerate accounts),
`RATE_LIMITED` (429), `CSRF_ORIGIN_REJECTED` (403).

#### `POST /api/v1/auth/refresh`

Requires the `refresh_token` cookie. Subject to the CSRF/origin guard.
Rotates the refresh token (see [Concurrent refresh
policy](#concurrent-refresh-policy--reuse-detection)) and issues a new
15-minute access JWT.

Response `200` sets fresh cookies and returns:

```json
{ "data": { "session": { "id": "...", "expiresAt": "..." } } }
```

Errors: `INVALID_REFRESH_TOKEN` (401 — missing, malformed, or a token this
API has no record of), `REFRESH_TOKEN_REUSED` (401 — a detected replay;
the session is revoked), `SESSION_REVOKED` (401), `SESSION_EXPIRED` (401
— rolling or absolute), `UNAUTHORIZED` (401 — user inactive or company
membership no longer valid), `CSRF_ORIGIN_REJECTED` (403).

#### `POST /api/v1/auth/logout`

Identifies the session from the `refresh_token` cookie (not the access
JWT, so logout still works if the access token already expired) and
revokes only that session. Always clears both cookies and always returns
`200`, whether or not a session was found — this is what keeps repeated
logout calls safe.

```json
{ "data": { "loggedOut": true } }
```

### Session architecture

Every login creates a brand-new, independent `Session` document — logging
in on a second device never touches the first device's session, and
revoking one never affects the other. There is no cross-session/device
grouping beyond "same user, same company".

### Concurrent refresh policy & reuse detection

Each session tracks exactly **one current** refresh token hash and **one
immediately-previous** token hash (with its own short grace expiry) — not
a full history. Rotation is a MongoDB compare-and-swap on the current
token hash, so only one writer can ever advance a given generation.

On `POST /api/v1/auth/refresh`, the presented token is classified as:

- **current** — the normal case; rotates immediately.
- **previous, within its grace window** (`AUTH_REFRESH_GRACE_MS`, default
  10 seconds) — treated as a legitimate near-simultaneous race (e.g. two
  tabs, or a proactive-refresh timer racing a reactive one) and rotated
  again from whatever is now current. Both racing requests succeed and
  each gets a valid (different) new token; since browsers keep only the
  last `Set-Cookie` they receive for a given cookie name, this is
  invisible to the client — whichever response lands last is simply the
  one that's used next.
- **previous, past its grace window** — genuine reuse. The session is
  revoked (`revokedReason: "reuse_detected"`) and `REFRESH_TOKEN_REUSED`
  is returned. Only this device's session is revoked; other sessions for
  the same user are untouched.
- **neither current nor previous** (i.e. a token from two or more
  rotations ago) — treated as **unknown**, not reuse: since this design
  only remembers one generation of history, an older token can no longer
  be distinguished from "never issued". It is still safely rejected
  (`INVALID_REFRESH_TOKEN`), just without triggering session revocation.
  A single legitimate client always ends up presenting only the most
  recent token it was given (see above), so this path is not expected to
  fire for real traffic — it exists as a documented boundary, not a gap
  a normal client can hit.

**Accepted tradeoff:** the grace window that absorbs legitimate races is,
by construction, also a window in which a stolen-but-not-yet-used token
could be replayed without triggering detection. This window is kept short
specifically to bound that exposure, and it only matters if a refresh
token was already exfiltrated despite `HttpOnly`/`Secure` cookies (i.e.
XSS can't reach it; this covers e.g. a TLS-terminating proxy compromise).
This is a deliberate, documented choice, not an oversight.

**Absolute-expiry interaction:** every rotation — including the
grace-window path — still runs the full `validateSessionContext` check
(revocation, rolling/absolute expiry, user/company state) before issuing
new tokens. A session past its absolute expiry cannot be refreshed via
any of these paths, grace window or not.

### Session invalidation

`src/modules/auth/auth.service.ts` exports three reusable primitives on
top of the same revocation write:

- `revokeCurrentSession(sessionId)` — used by logout.
- `revokeSessionById(sessionId, reason)`
- `revokeAllUserSessions(userId, reason)` — revokes every active session
  for a user across all devices.

No password-reset feature exists yet in this repository (FS02 spec
explicitly scopes that out). When one is built, it should call
`revokeAllUserSessions(userId, "password_reset")` after a successful
reset rather than reimplementing invalidation; the same call with
`"manual"` is the right tool for an admin-initiated deactivation.

### CSRF/origin protection

`POST`/`PUT`/`PATCH`/`DELETE` requests require an `Origin` header (falling
back to `Referer`) matching either the request's own origin (always
allowed — this is what keeps the same-origin proxy setup working with no
configuration) or an entry in `AUTH_ALLOWED_ORIGINS` (comma-separated,
empty by default). A missing or mismatched origin is rejected with `403
CSRF_ORIGIN_REJECTED`. `GET`/`HEAD`/`OPTIONS` are never checked. This is
defense-in-depth on top of `SameSite` cookies, not a replacement for it —
`AUTH_ALLOWED_ORIGINS` intentionally has no hardcoded production frontend
domain; that's FS33's call.

### Throttling

Login attempts are throttled through a MongoDB-backed fixed-window
counter (`src/modules/auth/auth-throttle.model.ts`) — never process
memory, since this API runs as multiple concurrent Vercel instances that
share nothing but the database. Two independent buckets apply per login
attempt, either of which can trip first:

| Bucket | Key | Default limit | Default window |
| ------ | --- | -------------- | ---------------- |
| Per-IP | `login:ip:<ip>` | 20 | 15 minutes |
| Per-account + IP | `login:account:<sha256(email)>:<ip>` | 5 | 15 minutes |

Scoping the stricter bucket to *(account, source IP)* rather than the
account alone is deliberate: a remote attacker spamming one victim's
email can't lock that account out for the victim's own, different,
source IP — this repo does **not** implement a pure failed-attempt
account lockout, since that would let an attacker lock out an arbitrary
victim. Both limits are configurable
(`AUTH_LOGIN_MAX_ATTEMPTS_PER_IP`, `AUTH_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT`,
`AUTH_LOGIN_WINDOW_MS`) and self-clear via a TTL index — there is no
manual unlock step. Exceeding either returns `429 RATE_LIMITED`.

### Error codes introduced by FS02

`INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `SESSION_REVOKED`,
`INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED`, `RATE_LIMITED`,
`CSRF_ORIGIN_REJECTED` — all follow the standard error envelope above.

### Assumption (OPEN DECISION resolved with a default)

FS01 doesn't define a `User`/`Company` relationship — FS02 adds a minimal
one: **one company per user** (`User.companyId`, required). This is a
simple, explicit default rather than a silent guess at a multi-company
membership model; if a user needs to belong to multiple companies later,
that's a schema change for whichever feature introduces it, not a FS02
concern.

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
