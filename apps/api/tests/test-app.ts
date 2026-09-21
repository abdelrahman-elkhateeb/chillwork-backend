import express, { type Express } from "express";
import { authenticate } from "../src/middleware/authenticate.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { notFoundHandler } from "../src/middleware/not-found.js";
import { requestId } from "../src/middleware/request-id.js";
import { requireDb } from "../src/middleware/require-db.js";
import { success } from "../src/lib/envelope.js";

/**
 * A minimal app exposing one protected route behind the real
 * `authenticate` middleware, so tests can exercise server-side session
 * validation without app.ts needing a speculative feature route of its
 * own just for FS02's test suite.
 */
export function createProtectedTestApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(requestId);

  app.get("/api/v1/_test/protected", requireDb, authenticate, (req, res) => {
    res.json(
      success({
        userId: req.auth?.userId.toString(),
        sessionId: req.auth?.sessionId.toString(),
        companyId: req.auth?.companyId.toString(),
      })
    );
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
