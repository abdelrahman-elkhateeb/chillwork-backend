# fs-api

Backend API for the Field Service SaaS project. A standalone Express
application (not a monorepo/workspace) living in [apps/api/](apps/api/).

## Stack

- Node.js 24, TypeScript (ESM, NodeNext module resolution)
- Express 5
- Mongoose (MongoDB)
- Zod for env and request validation
- pnpm as package manager
- `tsx` for local development

## Project structure

```
apps/api/           the entire application (package.json, tsconfig, lockfile)
  src/
    app.ts           builds & exports the Express app (no listen())
    server.ts        imports app.ts and calls listen() for local dev
    config/          env validation
    db/              cached Mongoose connection
    middleware/      request id, 404, centralized error handler, require-db,
                      authenticate (server-side session validation), csrf-origin
    lib/             HttpError, response envelope, Idempotency-Key helpers
    modules/
      auth/          login/refresh/logout, Session model, JWT + refresh
                      token primitives, MongoDB-backed login throttling
      users/          User model, password hashing
      companies/      Company model; admin company settings + labor fee (FS10)
      catalog/        parts catalog, admin part management and stock
                       ledger (FS11)
      billing/        final invoice preview/issuance (FS25)
      ai/             Gemini device analysis service (analyzeDevices()) —
                       internal only, no HTTP route; see docs/api.md
      requests/       POST /requests — validated multi-device service
                       request creation, idempotency, FS14 integration;
                       admin request list/detail (FS17)
      staff/          admin technician management + link-based activation
                       (FS09)
      visits/         admin visit scheduling + technician availability,
                       lock-based conflict prevention (FS18)
      technician/     technician-only read access to own assigned visits
                      (FS19); on-site proposed-work/customer-agreement
                      model (FS22, DEPRECATED — see below); start/complete
                      visit lifecycle and per-device work results
                      (REPAIRED/FAILED) with optimistic concurrency,
                      gated by FS11 DeviceParts approval where one exists
                      (FS23); per-device part proposals + decisions
                      (FS11); allowedActions
      health/         liveness check
    scripts/          guarded demo seed/reset CLI (FS34)
  tests/             vitest + supertest + mongodb-memory-server
docs/                API and architecture documentation
```

See [docs/api.md](docs/api.md) for the response envelope, pagination, and
request-ID conventions all endpoints follow.

## Setup

```bash
cd apps/api
pnpm install
cp .env.example .env
# edit .env and set a real MONGODB_URI
```

## Environment variables

| Variable       | Required | Default       | Notes                                   |
| -------------- | -------- | ------------- | ---------------------------------------- |
| `NODE_ENV`     | no       | `development` | one of `development`, `test`, `production` |
| `PORT`         | no       | `3000`        | port the HTTP server listens on          |
| `MONGODB_URI`  | yes      | —             | MongoDB connection string (e.g. Atlas)   |
| `JWT_ACCESS_SECRET` | yes | —             | signs/verifies access JWTs, >= 32 chars  |
| `JWT_ISSUER`   | no       | `fs-api`      | access JWT `iss` claim                   |
| `JWT_AUDIENCE` | no       | `fs-api-clients` | access JWT `aud` claim                |
| `AUTH_COOKIE_SECURE` | no | `true` in production, else `false` | `Secure` flag on auth cookies |
| `AUTH_COOKIE_SAME_SITE` | no | `lax`      | `SameSite` flag on auth cookies          |
| `AUTH_ALLOWED_ORIGINS` | no | (empty)     | extra comma-separated origins allowed for CSRF/origin checks, beyond the request's own same-origin |
| `AUTH_REFRESH_GRACE_MS` | no | `10000`    | refresh-token rotation grace window, ms  |
| `AUTH_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT` | no | `5` | login throttle, per account+IP     |
| `AUTH_LOGIN_MAX_ATTEMPTS_PER_IP` | no | `20`     | login throttle, per IP                   |
| `AUTH_LOGIN_WINDOW_MS` | no | `900000`        | login throttle window, ms (15 min)       |
| `DEMO_COMPANY_ID` | no* | —          | the single company registration assigns users to; *registration (`POST /auth/register`) fails with 503 until this is set to a real, active Company `_id` |
| `AUTH_REGISTER_MAX_ATTEMPTS_PER_IP` | no | `10` | registration throttle, per IP            |
| `AUTH_REGISTER_WINDOW_MS` | no | `3600000` | registration throttle window, ms (1 hour) |
| `GEMINI_API_KEY` | no* | —          | *no analysis can succeed without it, but the app still starts and everything else still works if unset — see docs/api.md "AI device analysis (FS14)" |
| `GEMINI_MODEL` | no | `gemini-3.8-flash` | single fixed model, no fallback |
| `GEMINI_TIMEOUT_MS` | no | `15000` | bounded timeout for the Gemini call, ms |
| `GEMINI_RATE_LIMIT_MAX_ATTEMPTS` | no | `5` | Gemini throttle, single global bucket |
| `GEMINI_RATE_LIMIT_WINDOW_MS` | no | `60000` | Gemini throttle window, ms |
| `REQUEST_CREATE_MAX_ATTEMPTS_PER_USER` | no | `20` | `POST /requests` throttle, per customer |
| `REQUEST_CREATE_WINDOW_MS` | no | `3600000` | `POST /requests` throttle window, ms (1 hour) |
| `DEMO_SEED_DATABASE` | seed only | — | must equal the connected database name for `pnpm seed:demo` |
| `DEMO_SEED_PASSWORD` | seed only | — | password for every demo account, >= 12 chars |

Startup fails fast with a clear error message if required variables are
missing or invalid (see `src/config/env.ts`). See
[docs/api.md](docs/api.md) for the full authentication design.

## Running locally

```bash
cd apps/api
pnpm dev          # tsx watch, loads .env via --env-file
```

The health check does not require a database connection:

```bash
curl http://localhost:3000/api/v1/health
# {"data":{"status":"ok"}}
```

Every other route connects to the database before handling requests, using
a single cached connection (see `src/db/connect.ts`) rather than one
connection per request — important on MongoDB Atlas's free M0 tier, which
enforces low connection limits.

## Scripts

Run from `apps/api/`:

- `pnpm dev` — start the dev server with hot reload
- `pnpm build` — compile TypeScript to `dist/`
- `pnpm typecheck` — type-check `src/` and `tests/`
- `pnpm test` — run the vitest suite (spins up an in-memory MongoDB
  **replica set** via `mongodb-memory-server`, required for the real
  multi-document transaction `POST /requests` uses; no real database or
  `.env` needed)
- `pnpm start` — run the compiled build (`dist/server.js`)
- `pnpm seed:demo [--reset]` — seed (or wipe and re-seed) the synthetic demo
  company; guarded, see [docs/demo.md](docs/demo.md)

## Notes

- Cookie-based session authentication (FS02) is implemented — see
  [docs/api.md](docs/api.md) for the full design (JWT/session split,
  refresh rotation, reuse detection, CSRF, throttling).
- Public customer registration (FS04, `POST /auth/register`) is
  implemented — see [docs/api.md](docs/api.md). It creates a `CUSTOMER`
  user only, with no session/tokens; the user logs in separately
  afterwards. Requires `DEMO_COMPANY_ID` to be set to a real Company's
  `_id` or it fails safely with 503.
- `GET /api/v1/auth/me` (FS05) restores the authenticated user after a
  browser refresh, purely from cookies.
- Gemini device analysis (FS14, `analyzeDevices()` in
  `src/modules/ai/`) is implemented as an internal service, not an HTTP
  endpoint — see [docs/api.md](docs/api.md) "AI device analysis (FS14)".
- `POST /api/v1/requests` (FS15) — customer-only, idempotent, multi-device
  service request creation, calling FS14 before persisting — see
  [docs/api.md](docs/api.md) "Service requests (FS15)". Photo attachments
  (FS12/FS13) were cancelled for the MVP; there is no `photoIds` field.
- Admin visit scheduling (FS18) - see [docs/api.md](docs/api.md) "Visit
  scheduling (FS18)". FS09/FS17 do not exist in this repo, so it adds only
  what it needs (`Company.timezone`, visit models) and documents its assumptions.
- Technician visit read access (FS19, `GET /technician/visits[/:id]`) - see
  [docs/api.md](docs/api.md). Photos/evidence are out of scope (FS13 was cancelled
  for the MVP).
- On-site work agreement (FS22) is **deprecated** — see [docs/api.md](docs/api.md)
  "On-site work agreement (FS22)". Its routes remain mounted for backward
  compatibility but have no effect on FS23 or FS25. The decision workflow it
  pioneered (`PROPOSED` -> `APPROVED`/`REJECTED`, one-way, immutable once
  decided) now lives directly on FS11's `DeviceParts` (below), which is
  catalog-backed and already wired into stock and invoicing.
- Device part proposals and decisions (FS11,
  `PUT /technician/visits/:visitId/devices/:deviceId/parts`,
  `POST /technician/visits/:visitId/devices/:deviceId/parts/decisions`,
  `GET /technician/visits/:visitId/parts`) - see [docs/api.md](docs/api.md)
  "Device part proposals and decisions". Each proposal has its own stable
  `proposalId` (never just the catalog `partId`, since the same part can be
  re-proposed after a rejection); a client can never submit a decision
  directly; a decided proposal is immutable. Legacy proposals from before this
  decision field existed (no `decision` at all) remain billable/editable
  exactly as before — a permanent compatibility fallback, not a migration step.
- Technician work execution (FS23, `POST /technician/visits/:id/start`,
  `POST /technician/visits/:id/complete`,
  `PUT /technician/visits/:visitId/work-results/:deviceId`,
  `GET /technician/visits/:visitId/work-results`) - see [docs/api.md](docs/api.md).
  Recording `REPAIRED`/`FAILED` is gated by FS11 `DeviceParts` decisions wherever
  any exist for a device (`409 WORK_NOT_APPROVED` otherwise); a device with no
  decision-tracked proposals falls back to the original interim boundary
  (`Visit.deviceIds`, the admin-assigned scope from FS18) — a permanent
  compatibility fallback for legacy data, not full enforcement. Visit
  completion still requires every device in `Visit.deviceIds` to have a result.
  Payment, invoicing, and reassignment endpoints remain out of scope for FS23
  itself.
- Billing (FS10 company settings/labor fee, FS11 parts catalog with stock and
  approval decisions, FS25 invoices) — see [docs/api.md](docs/api.md). FS11
  deliberately tracks stock counts (a product decision that departs from the
  ticket's availability flag); issuing an invoice decrements stock. Billing is
  computed from `DeviceParts` + `WorkResult`: a `REPAIRED` device's parts are
  only billed when their own proposal is `APPROVED` — a `PROPOSED`/`REJECTED`
  proposal on that device is never billed, even when another proposal on the
  same device is approved. Payments (FS26) and the customer invoice view
  (FS27) are not implemented.
- Synthetic demo data (FS34, `pnpm seed:demo`) — see [docs/demo.md](docs/demo.md).
- Technician accounts (FS09): admins create them and get a one-time activation
  token to share (there is no email service yet, FS07); the technician sets their
  own password via `POST /auth/activate-technician`. Admin request triage (FS17) is
  read-only — see [docs/api.md](docs/api.md).
- There is no lint tooling configured in this repository yet (no ESLint
  config/script exists) — setting one up is out of scope for FS02/FS04/FS14/FS15/FS18/FS22/FS23.
- Logs never include secrets, tokens, cookies, or raw request bodies.
