import mongoose from "mongoose";
import { env } from "../config/env.js";
import { connectDb } from "../db/connect.js";
import { assertSafeDemoTarget, resetDemoData, seedDemo } from "./demo-seed.js";

/**
 * FS34 demo seed CLI:  pnpm seed:demo [--reset]
 *
 * Guards (all required): NODE_ENV is not production, DEMO_SEED_DATABASE
 * names the connected database exactly, DEMO_COMPANY_ID is set, and
 * DEMO_SEED_PASSWORD (shared by every demo account) is at least 12
 * characters. `--reset` first deletes everything belonging to the demo
 * company and the second tenant. There is deliberately no HTTP endpoint
 * for any of this.
 */
async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");
  await connectDb();

  const { demoCompanyId, password } = assertSafeDemoTarget({
    nodeEnv: env.NODE_ENV,
    connectedDatabase: mongoose.connection.db?.databaseName ?? "",
    expectedDatabase: process.env.DEMO_SEED_DATABASE,
    demoCompanyId: env.DEMO_COMPANY_ID,
    password: process.env.DEMO_SEED_PASSWORD,
  });

  if (reset) {
    await resetDemoData(demoCompanyId);
    console.info("Demo data removed.");
  }

  const summary = await seedDemo(demoCompanyId, password);
  console.info("Demo data seeded:");
  console.info(`  company:  ${summary.companyId}`);
  console.info(`  parts:    ${summary.parts}`);
  console.info(`  requests: ${summary.requests}, visits: ${summary.visits}`);
  console.info(`  invoices: ${summary.invoices.join(", ")}`);
  console.info("  accounts (password = DEMO_SEED_PASSWORD):");
  for (const account of summary.accounts) {
    console.info(`    ${account.role.padEnd(10)} ${account.email}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
