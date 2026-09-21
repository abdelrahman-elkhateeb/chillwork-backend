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
    middleware/      request id, 404, centralized error handler, require-db
    lib/             HttpError, response envelope helpers
    modules/<name>/  feature code: routes, controller, service, schemas, models
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

Startup fails fast with a clear error message if required variables are
missing or invalid (see `src/config/env.ts`).

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
- `pnpm typecheck` — type-check without emitting output
- `pnpm start` — run the compiled build (`dist/server.js`)

## Notes

- Authentication is not implemented yet. Cookie-based auth is planned for
  FS-02.
- Logs never include secrets, tokens, cookies, or raw request bodies.
