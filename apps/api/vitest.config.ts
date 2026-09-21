import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup-file.ts"],
    // A single shared MongoMemoryServer/mongoose connection is simplest
    // and fast enough for this suite's size; running files in parallel
    // would mean juggling either multiple in-memory mongod processes or
    // fragile cross-worker env propagation for no real benefit here.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
