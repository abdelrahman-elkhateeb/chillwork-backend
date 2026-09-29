import express, { type Express } from "express";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { requestId } from "./middleware/request-id.js";
import { requireDb } from "./middleware/require-db.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { invoiceRouter } from "./modules/billing/invoice.routes.js";
import { catalogRouter } from "./modules/catalog/catalog.routes.js";
import { companySettingsRouter } from "./modules/companies/company-settings.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { requestsRouter } from "./modules/requests/request.routes.js";
import { staffRouter } from "./modules/staff/staff.routes.js";
import { technicianRouter } from "./modules/technician/technician-visit.routes.js";
import { visitsRouter } from "./modules/visits/visit.routes.js";

/**
 * Builds and returns the Express application. Never calls listen() here —
 * that's server.ts's job — so the app can be imported and exercised
 * directly (tests, serverless handlers) without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  // Behind Vercel's edge proxy, the real client IP/protocol come from
  // X-Forwarded-*; trusting the first hop is what makes req.ip (used for
  // login throttling) and req.protocol (used for the CSRF self-origin
  // check) reflect the actual client instead of the proxy.
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(requestId);

  app.use("/api/v1", healthRouter);
  app.use("/api/v1", requireDb, authRouter);
  app.use("/api/v1", requireDb, requestsRouter);
  app.use("/api/v1", requireDb, visitsRouter);
  app.use("/api/v1", requireDb, technicianRouter);
  app.use("/api/v1", requireDb, companySettingsRouter);
  app.use("/api/v1", requireDb, catalogRouter);
  app.use("/api/v1", requireDb, invoiceRouter);
  app.use("/api/v1", requireDb, staffRouter);

  // Future feature routers that need the database are mounted here, each
  // guarded by the requireDb middleware, e.g.:
  // app.use("/api/v1/jobs", requireDb, authenticate, jobsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();

export default app;
