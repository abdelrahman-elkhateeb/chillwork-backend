import { afterEach, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { resolveDemoCompany } from "../src/modules/companies/company.service.js";
import { ensureDemoCompany } from "./helpers.js";

describe("resolveDemoCompany", () => {
  const original = env.DEMO_COMPANY_ID;

  afterEach(() => {
    env.DEMO_COMPANY_ID = original;
  });

  it("resolves the active company at DEMO_COMPANY_ID", async () => {
    const demoCompany = await ensureDemoCompany();
    const resolved = await resolveDemoCompany();
    expect(resolved._id.toString()).toBe(demoCompany._id.toString());
  });

  it("fails safely (DEMO_COMPANY_UNAVAILABLE) when DEMO_COMPANY_ID is not configured", async () => {
    env.DEMO_COMPANY_ID = undefined;
    await expect(resolveDemoCompany()).rejects.toMatchObject({ code: "DEMO_COMPANY_UNAVAILABLE" });
  });

  it("fails safely when DEMO_COMPANY_ID is not a valid ObjectId", async () => {
    env.DEMO_COMPANY_ID = "not-an-object-id";
    await expect(resolveDemoCompany()).rejects.toMatchObject({ code: "DEMO_COMPANY_UNAVAILABLE" });
  });
});
