# ChillWork — Backend API

**Job management for AC, refrigeration and appliance repair companies.**

This is the API behind ChillWork. It runs a repair job from the customer's first
message to the final invoice: intake, AI triage, conflict-free scheduling,
on-site part approval, per-unit results and billing. The customer site and the
admin/technician dashboard live in
[chillwork-frontend](https://github.com/abdelrahman-elkhateeb/chillwork-frontend).

---

## What it does

### Three roles, enforced on the server

| Role | Can |
| --- | --- |
| **Customer** | Register, submit a request covering several units, follow its progress and timeline, and see the invoice summary. |
| **Admin** | Triage requests (with the AI reading), book visits, invite and manage technicians, manage the parts catalog and stock, and set the currency and labor fee. |
| **Technician** | See only the visits assigned to them, start and complete a visit, propose parts per unit, record the customer's decisions and each unit's result, and issue the invoice. |

Every record belongs to a company, and every query is scoped to the signed-in
user's company and role. Another company's record looks exactly like a missing one (`404`).

### The job, step by step

1. **Request.** A customer submits one request for several units, each described
   in their own words. Submitting is idempotent: a retried request never
   creates a duplicate.
2. **AI triage.** Before the request is stored, Google Gemini reads each unit and
   returns a short summary, possible causes, missing information and questions
   to ask on site. The customer's original text is never changed or replaced. If
   the AI fails or times out, the request is still saved. The analysis is
   visible to staff only, never to customers.
3. **Scheduling.** The admin books a visit for a technician. Overlapping visits
   are refused, even when two admins book at the same moment.
4. **Part approval.** The technician proposes catalog parts per unit. The customer
   approves or rejects each proposal. A decision is final, and a rejected part
   can only come back as a new proposal.
5. **Results.** Each unit is marked `REPAIRED`, or `FAILED` with a structured
   reason (part unavailable, customer refused, too expensive, technical issue,
   other). A visit can't be completed until every unit has a result.
6. **Invoice.** It's built from what was actually done and approved.

### Billing rules

- **No fix, no fee:** a repaired unit costs its approved parts plus one labor
  fee. A failed unit costs zero.
- Part prices are snapshotted when proposed, so later catalog changes never
  rewrite an open job.
- The company currency locks once set. Changes to the labor fee and currency
  are audited.
- Issuing an invoice decrements stock, and every stock movement (initial,
  adjustment, invoice) is written to a ledger with who did it and why.
- All money is stored as integer minor units. Nothing is ever rounded.

### Security

- Cookie-based sessions: short-lived access JWTs and rotating refresh tokens,
  all `HttpOnly`. If a stolen refresh token is replayed, the session is revoked.
- CSRF/origin checks on every state-changing route.
- Login, registration, request creation and the AI call are rate limited.
- Technicians activate their accounts with a one-time, 7-day invite link and
  choose their own password. Admins never see it.
- Logs never include secrets, tokens, cookies or request bodies.

---

## Tech stack

- Node.js 24, TypeScript (ESM)
- Express 5
- MongoDB with Mongoose (multi-document transactions)
- Zod for environment and request validation
- Google Gemini for device analysis
- Vitest + Supertest + mongodb-memory-server for tests

```
apps/api/
  src/
    app.ts          builds the Express app (no listen(), so it can run serverless)
    server.ts       local entry point
    config/         environment validation
    middleware/     request id, auth, CSRF/origin guard, errors
    modules/
      auth/         login, refresh, logout, sessions, throttling
      users/        users and password hashing
      companies/    company settings, currency and labor fee
      requests/     customer requests, admin triage, timeline
      ai/           Gemini analysis (internal service, no public route)
      visits/       scheduling and technician availability
      technician/   assigned visits, part proposals, work results
      catalog/      parts catalog, stock and stock ledger
      billing/      invoice preview and issuance
      staff/        technician management and activation
      health/       liveness check
    scripts/        demo seed/reset
  tests/
docs/
  api.md            full API reference
  demo.md           demo data and walkthrough
```

---

## Running it locally

Requires **Node 24+** and a MongoDB database. A MongoDB Atlas free cluster
works.

```bash
cd apps/api
npm install
cp .env.example .env    # then fill in MONGODB_URI and JWT_ACCESS_SECRET
npm run dev
```

Check it's up:

```bash
curl http://localhost:3000/api/v1/health
# {"data":{"status":"ok"}}
```

### Environment variables

The app refuses to start if a required variable is missing or invalid. The
full list with comments is in [`apps/api/.env.example`](apps/api/.env.example).

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | yes | MongoDB connection string |
| `JWT_ACCESS_SECRET` | yes | Signs access tokens, 32+ characters |
| `PORT` | no | Defaults to `3000` |
| `DEMO_COMPANY_ID` | for sign-up | The company new customers join. Registration returns `503` until it's set. |
| `GEMINI_API_KEY` | for AI | Without it, everything else still works and requests are triaged by hand. |
| `AUTH_ALLOWED_ORIGINS` | in production | Comma-separated frontend URLs allowed to make signed-in requests |
| `AUTH_COOKIE_SECURE`, `AUTH_COOKIE_SAME_SITE` | no | Cookie flags. `Secure` is on by default in production. |
| `AUTH_*`, `REQUEST_CREATE_*`, `GEMINI_*` limits | no | Rate-limit and timeout tuning, with safe defaults |
| `DEMO_SEED_DATABASE`, `DEMO_SEED_PASSWORD` | seed only | Guards for the demo seed script |

### Scripts

Run from `apps/api/`:

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | Type-check source and tests |
| `npm test` | Run the test suite against an in-memory MongoDB replica set (no `.env` needed) |
| `npm run seed:demo [-- --reset]` | Create, or wipe and recreate, the demo company |

### Demo data

`npm run seed:demo` creates a synthetic company with an admin, two technicians,
two customers, a parts catalog and jobs at every stage: completed and invoiced,
in progress, scheduled and unscheduled. It refuses to run in production or
against the wrong database. See [docs/demo.md](docs/demo.md) for the accounts and
a suggested walkthrough.

---

## API

All routes are under `/api/v1` and share one response envelope, pagination
style and error format. The full reference is in [docs/api.md](docs/api.md).

| Area | Examples |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me`, `POST /auth/activate-technician` |
| Customer | `POST /requests`, `GET /requests`, `GET /requests/:id`, `GET /requests/:id/timeline` |
| Admin | `GET /admin/requests`, `POST /admin/requests/:id/visits`, `/admin/technicians`, `/admin/parts`, `/admin/company-settings` |
| Technician | `GET /technician/visits`, `POST /technician/visits/:id/start` and `/complete`, part proposals and decisions, work results, `invoice-preview`, `invoice` |
| Catalog | `GET /catalog/parts`, `GET /catalog/pricing` |

---

## Not in this version

These are planned but not built yet: photo uploads, service reports, recording
payments, rescheduling and cancelling visits, and email (technician invites are
shared as a link). The early on-site "work agreement" endpoints are deprecated
and replaced by per-part approval.
