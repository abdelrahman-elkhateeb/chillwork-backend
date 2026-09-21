import { MongoMemoryServer } from "mongodb-memory-server";

/**
 * Runs once, before any test file is loaded, in vitest's orchestrator
 * process. Env vars set here are inherited by the worker process(es)
 * vitest spawns afterwards — which matters because src/config/env.ts
 * validates and freezes `process.env` the moment it's first imported, so
 * MONGODB_URI/JWT_ACCESS_SECRET/etc. must already exist before any test
 * file's top-level `import`s run.
 */
export default async function globalSetup() {
  process.env.NODE_ENV = "test";
  process.env.JWT_ACCESS_SECRET = "vitest-fixture-secret-do-not-use-in-prod-0123456789";
  process.env.JWT_ISSUER = "fs-api-test";
  process.env.JWT_AUDIENCE = "fs-api-test-clients";
  process.env.AUTH_COOKIE_SAME_SITE = "lax";
  process.env.AUTH_COOKIE_SECURE = "false";
  process.env.AUTH_REFRESH_GRACE_MS = "10000";
  process.env.AUTH_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT = "5";
  process.env.AUTH_LOGIN_MAX_ATTEMPTS_PER_IP = "20";
  process.env.AUTH_LOGIN_WINDOW_MS = "900000";
  process.env.AUTH_ALLOWED_ORIGINS = "http://allowed-origin.example.com";

  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri("fs-api-test");

  return async () => {
    await mongo.stop();
  };
}
