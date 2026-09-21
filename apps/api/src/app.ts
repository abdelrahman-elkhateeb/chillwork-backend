import express, { type Express } from "express";
import { errorHandler } from "./middleware/error-handler.js";
import { notFoundHandler } from "./middleware/not-found.js";
import { requestId } from "./middleware/request-id.js";
import { healthRouter } from "./modules/health/health.routes.js";

/**
 * Builds and returns the Express application. Never calls listen() here —
 * that's server.ts's job — so the app can be imported and exercised
 * directly (tests, serverless handlers) without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());
  app.use(requestId);

  app.use("/api/v1", healthRouter);

  // Future feature routers that need the database are mounted here, each
  // guarded by the requireDb middleware, e.g.:
  // app.use("/api/v1/jobs", requireDb, jobsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

const app = createApp();

export default app;
