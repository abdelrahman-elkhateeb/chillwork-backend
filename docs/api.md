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

### User roles

Every `User` has one of three roles (`User.role`, required, no schema
default): `CUSTOMER`, `ADMIN`, `TECHNICIAN`. `role` is returned by both
`POST /auth/login` and `GET /auth/me` so the frontend can select the
correct workspace — but it is always read from the database, never from
the client. Public registration (FS04) is currently the only path that
creates users, and it always assigns `CUSTOMER`; there is no public or
authenticated path yet that can create an `ADMIN` or `TECHNICIAN`
account (out of scope until that's explicitly built).

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

#### `POST /api/v1/auth/register`

Public customer self-registration (FS04). Subject to its own
[throttling](#throttling) bucket and the
[CSRF/origin guard](#csrforigin-protection). **Does not create a session**
— registration and authentication are deliberately separate. The
documented flow is:

```
POST /auth/register → 201 Created → POST /auth/login → authenticated session
```

Request body:

```json
{
  "name": "Jane Customer",
  "email": "jane@example.com",
  "phone": "+1 555 000 1111",
  "password": "correct-horse-battery-staple"
}
```

| Field | Rule |
| ----- | ---- |
| `name` | required, trimmed, 2–100 characters |
| `email` | required, valid email, normalized to lowercase (case-insensitive uniqueness) |
| `phone` | required; spaces/dashes/parentheses stripped, then must match `^\+?[1-9]\d{6,14}$` (optional leading `+`, 7–15 digits, no leading zero — a simplified E.164 shape; no prior phone convention existed in this repo, so this is FS04's documented MVP rule) |
| `password` | required, minimum 8 characters (no additional complexity rule) |

Any other field in the request body (`role`, `companyId`, `userId`,
`isAdmin`, access/refresh tokens, etc.) is **silently dropped** by the
request schema before the service layer ever sees it — this, not a
runtime permission check, is what makes role/company tampering
impossible: the code creating the user is never given those fields to
read in the first place.

Response `201`:

```json
{
  "data": {
    "user": {
      "id": "...",
      "email": "jane@example.com",
      "name": "Jane Customer",
      "phone": "+15550001111",
      "role": "CUSTOMER",
      "companyId": "..."
    }
  }
}
```

`role` is always `"CUSTOMER"` — hardcoded server-side, never read from the
request. There is currently no public registration path to `ADMIN` or
`TECHNICIAN` at all. `companyId` is always the server-resolved [demo
company](#company-assignment), never client-supplied.

Errors: `VALIDATION_ERROR` (400), `CONFLICT` (409 — email already
registered, checked at the application level and enforced again by
`User.email`'s unique index so two concurrent registrations for the same
address can't both succeed), `DEMO_COMPANY_UNAVAILABLE` (503 — see
[Company assignment](#company-assignment)), `RATE_LIMITED` (429),
`CSRF_ORIGIN_REJECTED` (403).

##### Company assignment

The MVP is single-tenant: every publicly-registered user is assigned to
one pre-existing Company, configured via `DEMO_COMPANY_ID` (its
MongoDB `_id`). This is deliberately **not** auto-created by the
application — registration must never have the side effect of silently
minting a new company — so an operator provisions the Company document
once (e.g. via `mongosh`) and sets `DEMO_COMPANY_ID`. If it's unset,
malformed, points at a missing company, or the company is inactive,
registration fails with `503 DEMO_COMPANY_UNAVAILABLE` and creates no
user, rather than guessing or creating one.

##### Email uniqueness & concurrent registration

Registration checks for an existing user with the normalized email
first (a clean, fast user-facing `CONFLICT`), then relies on
`User.email`'s unique index as the actual concurrency guard: two
requests racing the same email can both pass the initial check, but only
one `User.create` can win — the loser's insert fails with a MongoDB
duplicate-key error, which is caught and converted to the same
`CONFLICT` response rather than a raw database error. Exactly one
account is ever created for a given normalized email.

##### Password handling

Reuses FS02's existing scrypt implementation
(`src/modules/users/password.js`) unchanged — no bcrypt, no second
hashing mechanism. The plaintext password is hashed before the user is
created and is never stored, logged, or returned; `passwordHash` stays
`select: false` on the `User` model, so it never accidentally appears in
a query result used to build a response.

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
    "user": {
      "id": "...",
      "email": "...",
      "name": "...",
      "phone": "...",
      "role": "CUSTOMER",
      "companyId": "..."
    },
    "session": { "id": "...", "expiresAt": "2026-09-29T00:00:00.000Z" }
  }
}
```

`role` is always the server-side value from the `User` document (see
[User roles](#user-roles)) — the frontend uses it to pick the correct
workspace, but the backend never trusts a role from the client.

Errors: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401 — returned
identically for an unknown email, a wrong password, or a deactivated
user/company, so login can't be used to enumerate accounts),
`RATE_LIMITED` (429), `CSRF_ORIGIN_REJECTED` (403).

A minimal structured event is logged for every credential check (not for
request-validation or throttling rejections, which never reach a real
password comparison): `{ event: "auth.login", outcome: "success" |
"failure", requestId, ip, emailHash, userId?, companyId? }`. `emailHash`
is a SHA-256 hash of the normalized email — the same technique the
throttle buckets already use — so a raw address never appears in
plaintext in server logs. `userId`/`companyId` are only ever attached on
success, when they're genuinely known; a failed attempt never has an
identity manufactured for it, whether or not the email belongs to a real
account. The password, hashes, and tokens are never logged.

#### `GET /api/v1/auth/me`

Requires authentication (the existing `authenticate` middleware — same
server-side session/user/company revalidation as every other protected
request, see [Session architecture](#session-architecture)). This is what
lets the frontend restore its authenticated state after a browser
refresh, without ever storing a token itself:

```
POST /auth/login → cookies set
        ⋮ (browser refresh — in-memory frontend state is gone)
GET /auth/me → cookies sent automatically → same user restored
```

Response `200`:

```json
{
  "data": {
    "user": {
      "id": "...",
      "email": "...",
      "name": "...",
      "phone": "...",
      "role": "CUSTOMER",
      "companyId": "..."
    }
  }
}
```

The identity returned is always `req.auth.user` as established by the
`authenticate` middleware from the verified session — never from a query
parameter, request body, or any other client-supplied value. There is no
authenticated identity for `/me` to trust other than the one the cookie
chain proves.

Errors: `UNAUTHORIZED` (401 — missing/invalid JWT, inactive user, or
invalid company membership), `SESSION_REVOKED` (401), `SESSION_EXPIRED`
(401) — the same set `authenticate` produces for any protected route.

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
| Login, per-IP | `login:ip:<ip>` | 20 | 15 minutes |
| Login, per-account + IP | `login:account:<sha256(email)>:<ip>` | 5 | 15 minutes |
| Register, per-IP | `register:ip:<ip>` | 10 | 1 hour |

Scoping login's stricter bucket to *(account, source IP)* rather than the
account alone is deliberate: a remote attacker spamming one victim's
email can't lock that account out for the victim's own, different,
source IP — this repo does **not** implement a pure failed-attempt
account lockout, since that would let an attacker lock out an arbitrary
victim. Registration has no pre-existing account to scope a stricter
bucket to, so it's per-IP only, with its own configurable limit/window
(`AUTH_REGISTER_MAX_ATTEMPTS_PER_IP`, `AUTH_REGISTER_WINDOW_MS`) rather
than reusing login's — abuse patterns (scripted mass account creation vs.
credential guessing) are different enough to warrant separate knobs. All
limits are configurable and self-clear via a TTL index — there is no
manual unlock step. The registration throttle check runs before company
resolution, the uniqueness check, and password hashing, so an
over-the-limit request is rejected as cheaply as possible. Exceeding any
bucket returns `429 RATE_LIMITED`.

### Error codes introduced by FS02 / FS04 / FS15

`INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `SESSION_REVOKED`,
`INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED`, `RATE_LIMITED`,
`CSRF_ORIGIN_REJECTED` (FS02), `CONFLICT`, `DEMO_COMPANY_UNAVAILABLE`
(FS04), `MISSING_IDEMPOTENCY_KEY`, `INVALID_IDEMPOTENCY_KEY`,
`IDEMPOTENCY_IN_PROGRESS`, `IDEMPOTENCY_CONFLICT`, `PHOTO_NOT_AVAILABLE`,
`REQUEST_CREATION_FAILED` (FS15), `SCHEDULE_CONFLICT`,
`REQUEST_NOT_SCHEDULABLE`, `DEVICE_ALREADY_SCHEDULED` (FS18) — all follow the
standard error envelope above.

### Assumptions (OPEN DECISIONs resolved with a default)

FS01 doesn't define a `User`/`Company` relationship — FS02 adds a minimal
one: **one company per user** (`User.companyId`, required). This is a
simple, explicit default rather than a silent guess at a multi-company
membership model; if a user needs to belong to multiple companies later,
that's a schema change for whichever feature introduces it, not a FS02
concern.

FS01/FS02 also never defined a role field — FS04 adds `User.role`
(`CUSTOMER | ADMIN | TECHNICIAN`, required, no schema default so every
creation path must state it explicitly). Public registration is the only
role-assigning path that exists today, and it always writes `CUSTOMER`.
There is no creation path for `ADMIN`/`TECHNICIAN` accounts yet — that's
out of FS04's scope, not an oversight.

## AI device analysis (FS14)

**This is not an HTTP endpoint.** `analyzeDevices()` is an internal,
server-only service function — `src/modules/ai/gemini.service.ts` — for
another backend feature (FS15, `POST /requests`, not yet implemented) to
call before persisting a service request. There is no public `/ai/*`
route and none should be added; a user never triggers a Gemini call
directly.

Purpose: given a customer's per-device description and equipment
details, produce a structured, bounded AI analysis (summary, possible
causes, missing information, inspection questions) *before* the request
record is persisted, so the persisted record always has both the
customer's original text and (when available) the analysis together —
never the analysis in place of the original text.

### Internal contract

```ts
analyzeDevices(
  { devices: [{ clientDeviceId, originalDescription, equipment }] },
  { requestId? } // optional, log correlation only
): Promise<{
  devices: [{
    clientDeviceId,
    originalDescription,   // byte-identical to the input
    analysis: { summary, possibleCauses, missingInformation, inspectionQuestions } | null,
    metadata: { status, model, promptVersion, processedAt, errorCode? }
  }]
}>
```

- `clientDeviceId` is how a result is matched to its device — always by
  this key, never by array position (the provider may return devices in
  a different order, or omit one).
- `originalDescription` is returned exactly as submitted. It is never
  trimmed, normalized, or replaced by AI-generated text — validation
  checks it without transforming the value it hands back.
- `analysis` is `null` whenever `metadata.status !== "SUCCESS"` — a
  failed/unavailable analysis never contains invented content.
- Calling this with structurally invalid input (e.g. no devices) throws
  — that's a caller/integration bug, not a provider failure. A *provider*
  failure never throws; it always resolves with a controlled
  `FAILED`/`UNAVAILABLE` result per device instead.

### Gemini model selection

**Model:** `gemini-3.8-flash` (`GEMINI_MODEL`, overridable).
**Free-tier verification:** confirmed via `https://ai.google.dev/gemini-api/docs/pricing`
and `https://ai.google.dev/gemini-api/docs/models` (fetched 2026-09-24),
both listing `gemini-3.8-flash` as free-of-charge and as the current
recommended general-purpose Flash model. Exact free-tier RPM/RPD figures
are account-specific and shown live in Google AI Studio, not published
as a static table — this is why the internal throttle default below is
deliberately conservative rather than tuned to a specific published
number.

**Wire contract:** Google's "Interactions API"
(`POST https://generativelanguage.googleapis.com/v1beta/interactions`,
`x-goog-api-key` header, structured JSON output via
`response_format.mime_type: "application/json"` + a JSON Schema), also
verified against the same official docs on 2026-09-24. This superseded
the older `models/{model}:generateContent` contract at some point after
this repository's dependencies were last reviewed.

**No fallback:** there is exactly one configured model. A failure of
that model produces a `FAILED`/`UNAVAILABLE` result — it never triggers
a second call, a different (e.g. paid) model, or a retry. See
`tests/gemini.service.test.ts` ("no paid-model fallback") for the test
proving exactly one provider attempt is ever made.

**Provider client:** direct `fetch` (Node 24's built-in global), not the
Google GenAI SDK — this repo already prefers small, dependency-free
solutions where `fetch` is sufficient (see FS02's choice of `node:crypto`
scrypt over bcrypt), and the Interactions API's request/response shape is
simple enough that an SDK wouldn't meaningfully simplify it. No new
dependency was added for FS14.

### Configuration

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `GEMINI_API_KEY` | no* | — | *no analysis can succeed without it, but the app still starts and every other feature still works if it's unset; `analyzeDevices()` returns a controlled `GEMINI_AUTH_ERROR` result instead |
| `GEMINI_MODEL` | no | `gemini-3.8-flash` | single fixed model, no fallback list |
| `GEMINI_TIMEOUT_MS` | no | `15000` | bounded via `AbortController`; a timeout becomes `GEMINI_TIMEOUT` |
| `GEMINI_RATE_LIMIT_MAX_ATTEMPTS` | no | `5` | see "Rate limiting" below |
| `GEMINI_RATE_LIMIT_WINDOW_MS` | no | `60000` | |

The API key is never logged, never returned in any result, and never
appears in a thrown/returned error — see `tests/gemini.service.test.ts`
"secret and log safety".

### Rate limiting

Reuses FS02's existing MongoDB-backed `recordAttempt()` primitive
(`src/modules/auth/auth-throttle.model.ts`) — no second rate-limit
system, no Redis, no process memory. The bucket is a single **global**
key (`gemini:global`), not per-user/company/IP: the thing actually being
protected is the one shared free-tier quota behind `GEMINI_API_KEY`,
which is a single resource regardless of how many callers/companies
exist, so a global bucket is what actually models the constraint. The
check runs before the provider is called (and before the prompt is even
built) — exceeding it means Gemini is never invoked for that call.

### Prompt version

Fixed string constant (`PROMPT_VERSION = "v1"` in `gemini.constants.ts`),
never a timestamp — it only changes when the prompt text is deliberately
changed, so two results only share a `promptVersion` when they came from
the same prompt. The prompt itself is never logged or persisted.

### Failure semantics

| errorCode | status | Meaning |
| --------- | ------ | ------- |
| `GEMINI_TIMEOUT` | `UNAVAILABLE` | call exceeded `GEMINI_TIMEOUT_MS` |
| `GEMINI_QUOTA_EXCEEDED` | `UNAVAILABLE` | provider returned 429 |
| `GEMINI_PROVIDER_UNAVAILABLE` | `UNAVAILABLE` | provider 5xx or network failure |
| `GEMINI_AUTH_ERROR` | `UNAVAILABLE` | missing/rejected API key |
| `GEMINI_RATE_LIMITED` | `UNAVAILABLE` | FS14's own throttle tripped before any provider call |
| `GEMINI_INVALID_OUTPUT` | `FAILED` | provider responded, but the JSON was malformed or failed schema validation (missing fields, wrong types, or exceeded a bound) |

`UNAVAILABLE` broadly means "we couldn't get a usable response from the
provider" (worth retrying later); `FAILED` means "the provider responded
but what it returned wasn't trustworthy." Neither ever produces invented
analysis content, and neither is a reason to discard the original
request data — persisting the request despite a failed/unavailable
analysis is FS15's responsibility, not FS14's.

### FS15 boundary

FS14 owns `analyzeDevices()` and nothing else. It never touches a
Service Request/Device persistence model, never persists a prompt or
provider response, and never introduces an idempotency reservation.
`POST /api/v1/requests` (see "Service requests (FS15)" below) owns
validation, auth/company ownership, calling `analyzeDevices()` at the
right point, persistence, idempotency, and the HTTP response.

## Service requests (FS15)

### `POST /api/v1/requests`

Requires authentication and the `CUSTOMER` role — `ADMIN`/`TECHNICIAN`
get `403 FORBIDDEN`. Subject to the [CSRF/origin
guard](#csrforigin-protection) and its own per-customer throttle (see
"Rate limiting" below).

Request:

```http
POST /api/v1/requests
Cookie: access_token=...; refresh_token=...
Idempotency-Key: <client-generated key>
Content-Type: application/json
```

```json
{
  "address": "123 Main St, Springfield",
  "contactPhone": "+1 555 000 1111",
  "devices": [
    {
      "clientDeviceId": "device-1",
      "label": "Refrigerator",
      "brand": "Acme",
      "model": "X100",
      "originalDescription": "Not cooling properly and making a buzzing noise.",
      "photoIds": []
    }
  ]
}
```

`devices` requires 1–10 entries with unique `clientDeviceId`s (the same
bound FS14 enforces — this endpoint can never send FS14 more devices
than FS14 itself accepts). `originalDescription` is stored exactly as
submitted — never trimmed, normalized, or rewritten. Any other field in
the body (`companyId`, `customerId`, etc.) is silently stripped, the
same way `POST /auth/register` handles it: the service layer only ever
reads `req.auth.companyId`/`req.auth.userId` for identity, never
anything from the request body.

Response `201` (first successful creation) or `200` (idempotent replay
of an already-completed submission — see "Idempotency" below):

```json
{
  "data": {
    "requestId": "...",
    "reference": "SR-7K9XQAB2",
    "status": "SUBMITTED",
    "devices": [
      {
        "clientDeviceId": "device-1",
        "label": "Refrigerator",
        "brand": "Acme",
        "model": "X100",
        "originalDescription": "Not cooling properly and making a buzzing noise."
      }
    ]
  }
}
```

**The response never includes AI analysis, analysis metadata, or any
other internal field.** That data is persisted (see "Gemini
integration" below) but is a staff-facing concern for a future,
separately-authorized detail endpoint — not something this customer
creation endpoint, or any endpoint in this task, exposes. `reference`
is a random, server-generated, human-readable code (never client-
supplied, never a sequential/predictable counter).

Errors: `VALIDATION_ERROR` (400), `MISSING_IDEMPOTENCY_KEY` /
`INVALID_IDEMPOTENCY_KEY` (400 — header absent or outside
`[A-Za-z0-9_-]{1,200}`), `FORBIDDEN` (403 — authenticated but not a
`CUSTOMER`), `PHOTO_NOT_AVAILABLE` (503 — see "Photo attachments"
below), `IDEMPOTENCY_IN_PROGRESS` / `IDEMPOTENCY_CONFLICT` (409 — see
"Idempotency"), `RATE_LIMITED` (429), `CSRF_ORIGIN_REJECTED` (403),
`REQUEST_CREATION_FAILED` (500 — persistence failed after a successful
Gemini call; safe to retry with the same Idempotency-Key).

### Photo attachments — blocked pending FS13

FS13 (photo/upload) **does not exist anywhere in this repository** —
no model, no ownership contract, nothing to verify a `photoId` against.
Accepting one anyway would mean trusting a client-supplied identifier
with no way to confirm it belongs to this customer/company — exactly
the "attach another customer's photo by guessing an ID" hole this
endpoint is required to prevent. So rather than invent a photo/ownership
architecture or silently accept unverified IDs, **any device with a
non-empty `photoIds` array is rejected with `503
PHOTO_NOT_AVAILABLE`, and nothing is created.** `photoIds: []` (or
omitted) works today. When FS13 ships, this becomes a real ownership
check (`photo.companyId`/`photo.customerId` cross-checked against
`req.auth`, the same pattern used everywhere else in this codebase) —
not a redesign.

### Gemini integration (FS14)

`analyzeDevices()` is called exactly once per new submission (never on
an idempotent replay — see below), after the photo check and the
idempotency reservation, before the database transaction. The mapping
is `clientDeviceId`/`originalDescription` straight through, with
`label`/`brand`/`model` combined into FS14's `equipment` input. A
Gemini failure (timeout, quota, provider error, malformed output) never
prevents the request from being saved — the affected device's stored
`analysisMetadata.status` becomes `FAILED`/`UNAVAILABLE` with its
`errorCode`, and `analysis` is `null`. There is no retry and no fallback
model here either — this endpoint just consumes FS14's own guarantee of
that.

### Idempotency

Every submission requires an `Idempotency-Key` header. The reservation
identifying "one submission" is scoped to **(companyId, customerId,
Idempotency-Key)** — never the key alone — so two different customers
(even in the same company) can use the identical key value
independently, and reusing a key later with the exact same payload from
the exact same customer returns the original result instead of creating
a duplicate.

- **Same key, same payload** → `200` with the original request, no
  second Gemini call, no second document created. "Same payload" is
  checked via a SHA-256 fingerprint of a canonicalized request shape
  (devices sorted by `clientDeviceId`, each device's `photoIds` sorted)
  — the fingerprint is stored, the raw request content never is.
- **Same key, different payload** → `409 IDEMPOTENCY_CONFLICT`. Nothing
  is created.
- **Same key, request still in flight** (a genuinely concurrent
  duplicate) → `409 IDEMPOTENCY_IN_PROGRESS`. Only one concurrent
  request ever becomes the owner and calls Gemini; the loser never does.
- **Lost response** (the first attempt actually succeeded but the
  client never saw the `201`) — a retry with the same key/payload finds
  the completed reservation and returns `200` with the already-created
  request, exactly like the "same key, same payload" case above.

The reservation record itself never holds request content — no address,
phone, description, or Gemini prompt/response, only the fingerprint hash
and enough metadata to reconcile a retry. An abandoned reservation (the
process crashed between reserving and completing) self-heals: a
definitively `FAILED` reservation (persistence failed after Gemini ran)
is immediately reclaimable by the next retry, and a reservation stuck
`IN_PROGRESS` (the process crashed before even reaching that point)
becomes reclaimable after a bounded cleanup window. A completed
reservation is kept substantially longer so a legitimately slow retry
still finds its result.

Creating the request and completing its idempotency reservation happen
in a single MongoDB transaction — both commit together or neither does,
which is what makes "crashed between creating the request and marking
the reservation complete" recoverable without ever risking a duplicate
request on retry, rather than merely best-effort.

### Rate limiting

A per-customer submission throttle, reusing the same MongoDB-backed
primitive as everything else (`recordAttempt()`), keyed on
`requests:create:user:<userId>` — separate from FS14's own **global**
Gemini throttle. The two exist for different reasons: FS14's protects
the one shared provider quota from being exhausted by anyone; this one
stops a single customer from being the one who exhausts it. Checked
before the idempotency reservation, so a throttled call never reserves
a key or reaches Gemini.

## Visit scheduling (FS18)

Admin-only (`ADMIN` role; `CUSTOMER`/`TECHNICIAN` get `403 FORBIDDEN`). Company and
acting user come only from `req.auth`; a `companyId` in a body is ignored.

> **Dependency note:** FS09 and FS17 do not exist in this repository (no visit
> model, no request lifecycle beyond `SUBMITTED`, no company timezone). FS18
> therefore adds only the minimum it needs and does not invent a lifecycle;
> the assumptions are listed at the end of this section.

### `POST /api/v1/admin/requests/:id/visits`

```json
{
  "technicianId": "64b0...",
  "startAt": "2026-09-27T10:00:00+03:00",
  "endAt": "2026-09-27T11:30:00+03:00",
  "deviceIds": ["device-1", "device-2"],
  "workTypes": ["INSPECTION", "REPAIR"]
}
```

`workTypes` is optional (default `["INSPECTION"]`); one visit may carry both
inspection and repair. `deviceIds` are the request's `clientDeviceId`s (request
devices are embedded and have no other id) - 1 to 10, unique, all on this request.
**One visit covers all listed devices.** A device may be in only one active visit.

`201` returns the visit in the standard envelope:

```json
{ "data": { "visitId": "...", "requestId": "...", "technicianId": "...",
  "startAt": "2026-09-27T07:00:00.000Z", "endAt": "2026-09-27T08:30:00.000Z",
  "timezone": "Africa/Cairo", "deviceIds": ["device-1","device-2"],
  "workTypes": ["INSPECTION","REPAIR"], "status": "SCHEDULED" } }
```

Errors: `VALIDATION_ERROR` 400 (bad times/devices; an unavailable technician gets one
uniform `fieldErrors.technicianId` whether it is missing, in another company,
inactive, or not a `TECHNICIAN`), `NOT_FOUND` 404 (request missing or in another
company), `REQUEST_NOT_SCHEDULABLE` 409, `DEVICE_ALREADY_SCHEDULED` 409,
`SCHEDULE_CONFLICT` 409.

### `GET /api/v1/admin/technicians/:id/availability?from=&to=`

Returns the technician's **busy** intervals (active visits only) intersecting the
window: `{ technicianId, timezone, from, to, busy: [{ visitId, startAt, endAt }] }`.
Only times are returned - no customer, request or device data. The technician must
be an active `TECHNICIAN` of the caller's company; anything else is `404`. `to` must
be after `from` and the window at most 31 days.

### Time handling

Timestamps must be ISO-8601 **with an explicit offset** (`Z` or `+03:00`); an
offset-less local time is rejected as ambiguous rather than guessed. They are stored
as UTC instants and returned as UTC ISO strings. `Company.timezone` (IANA name,
default `UTC`, validated) is snapshotted onto each visit and returned so clients can
render in the company's zone. Duration must be 15 minutes - 8 hours (constants in
`visit.constants.ts`).

### Overlap rules

Intervals are half-open `[startAt, endAt)`: 10:00-11:00 and 11:00-12:00 do not
conflict; 10:00-11:00 and 10:59-12:00 do. Only `SCHEDULED`/`IN_PROGRESS` visits
count (an allow-list, not "not cancelled"), so a `CANCELLED` visit frees the time.

### Scheduling concurrency

MongoDB has no range-exclusion constraint, and a transaction that reads for
overlap and then inserts does **not** stop two concurrent bookings: under snapshot
isolation both read "no conflict" and both commit (verified: with the lock below
removed, six concurrent overlapping bookings all returned `201`).

Instead, each booking's transaction first `$inc`s a lock document per resource it
touches - `technician:<id>` and `request:<id>` (`ScheduleLock`, unique per
company+key). Two bookings for the same technician therefore write the same
document; MongoDB aborts one with a transient write conflict, the driver retries it
on a fresh snapshot, and its overlap check then sees the winner's committed visit
and answers `409 SCHEDULE_CONFLICT`. This preserves arbitrary start/end times (no
fixed slots), holds across processes and serverless instances, and uses no
process memory. Non-overlapping concurrent bookings still all succeed. Trade-off:
bookings for one technician (or request) are serialized.

The visit and its two events (`VISIT_SCHEDULED`, `TECHNICIAN_ASSIGNED`, recorded in
`VisitEvent` with the acting admin) are written in the same transaction.

### Assumptions (no FS09/FS17 to defer to)

- Only `SUBMITTED` requests are schedulable; scheduling does not change request status.
- Visit statuses `SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED` exist; only `SCHEDULED`
  is created today. There is no cancel/complete endpoint yet - a future one only
  needs to set the status (the conflict check is status-based).
- No business-hours, past-date, or lookahead rules were specified, so none are enforced.

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
