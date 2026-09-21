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
    lib/             HttpError, response envelope helpers
    modules/
      auth/          login/refresh/logout, Session model, JWT + refresh
                      token primitives, MongoDB-backed login throttling
      users/          User model, password hashing
      companies/      Company model
      health/         liveness check
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
- `pnpm test` — run the vitest suite (spins up an in-memory MongoDB via
  `mongodb-memory-server`; no real database or `.env` needed)
- `pnpm start` — run the compiled build (`dist/server.js`)

## Notes

- Cookie-based session authentication (FS02) is implemented — see
  [docs/api.md](docs/api.md) for the full design (JWT/session split,
  refresh rotation, reuse detection, CSRF, throttling).
- There is no lint tooling configured in this repository yet (no ESLint
  config/script exists) — setting one up is out of scope for FS02.
- Logs never include secrets, tokens, cookies, or raw request bodies.
