import { env } from "./config/env.js";
import app from "./app.js";

const server = app.listen(env.PORT, () => {
  console.log(`fs-api listening on port ${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
