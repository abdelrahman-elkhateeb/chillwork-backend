import mongoose, { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { Invoice } from "../src/modules/billing/invoice.model.js";
import { Part } from "../src/modules/catalog/part.model.js";
import { Company } from "../src/modules/companies/company.model.js";
import { ServiceRequest } from "../src/modules/requests/request.model.js";
import { User } from "../src/modules/users/user.model.js";
import { Visit } from "../src/modules/visits/visit.model.js";
import {
  assertSafeDemoTarget,
  resetDemoData,
  SAMPLE_ANALYSIS_MODEL,
  SECOND_TENANT_ID,
  seedDemo,
} from "../src/scripts/demo-seed.js";
import { createCompany, createUser } from "./helpers.js";

const PASSWORD = "demo-password-for-tests";
const demoCompanyId = () => new Types.ObjectId(process.env.DEMO_COMPANY_ID!);

describe("assertSafeDemoTarget", () => {
  const ok = {
    nodeEnv: "development",
    connectedDatabase: "chillwork-demo",
    expectedDatabase: "chillwork-demo",
    demoCompanyId: new Types.ObjectId().toString(),
    password: PASSWORD,
  };

  it("accepts an explicitly named non-production target", () => {
    expect(() => assertSafeDemoTarget(ok)).not.toThrow();
  });

  it.each([
    ["production", { nodeEnv: "production" }],
    ["a missing database confirmation", { expectedDatabase: undefined }],
    ["a different database", { expectedDatabase: "chillwork-prod" }],
    ["a missing demo company id", { demoCompanyId: undefined }],
    ["a short password", { password: "short" }],
  ])("refuses %s", (_label, override) => {
    expect(() => assertSafeDemoTarget({ ...ok, ...override })).toThrow();
  });
});

describe("seedDemo", () => {
  it("seeds the documented walkthrough through the real services", async () => {
    const summary = await seedDemo(demoCompanyId(), PASSWORD);

    const company = await Company.findById(demoCompanyId());
    expect(company).toMatchObject({ currency: "EGP", laborFeeMinor: 15000, timezone: "Africa/Cairo" });
    expect(await User.countDocuments({ companyId: demoCompanyId() })).toBe(5);
    expect(await Part.countDocuments({ companyId: demoCompanyId() })).toBe(6);
    expect(await ServiceRequest.countDocuments({ companyId: demoCompanyId() })).toBe(5);

    const statuses = (await Visit.find({ companyId: demoCompanyId() })).map((v) => v.status).sort();
    expect(statuses).toEqual(["COMPLETED", "COMPLETED", "IN_PROGRESS", "SCHEDULED"]);

    const invoices = await Invoice.find({ companyId: demoCompanyId() }).sort({ totalMinor: -1 });
    expect(invoices.map((i) => [i.totalMinor, i.status, i.paymentState])).toEqual([
      [45000 + 8000 + 15000, "ISSUED", "UNPAID"],
      [0, "CLOSED", "NOT_REQUIRED"],
    ]);
    expect(summary.invoices).toHaveLength(2);

    // The invoice took stock for the fitted parts only.
    expect((await Part.findOne({ companyId: demoCompanyId(), name: "Indoor Fan Motor" }))?.stockQuantity).toBe(5);
  });

  it("labels every stored AI analysis as synthetic sample output", async () => {
    await seedDemo(demoCompanyId(), PASSWORD);
    const requests = await ServiceRequest.find({ companyId: { $in: [demoCompanyId(), SECOND_TENANT_ID] } });
    const models = new Set(requests.flatMap((r) => r.devices.map((d) => d.analysisMetadata.model)));
    expect([...models]).toEqual([SAMPLE_ANALYSIS_MODEL]);
  });

  it("refuses to seed on top of existing demo data", async () => {
    await seedDemo(demoCompanyId(), PASSWORD);
    await expect(seedDemo(demoCompanyId(), PASSWORD)).rejects.toThrow(/--reset/);
  });

  it("reset + seed reproduces the same data and leaves other companies alone", async () => {
    const bystander = await createCompany({ name: "Real Customer Co" });
    await createUser(bystander._id, { email: "keep-me@example.com" });

    const first = await seedDemo(demoCompanyId(), PASSWORD);
    await resetDemoData(demoCompanyId());

    expect(await Company.exists({ _id: demoCompanyId() })).toBeNull();
    const db = mongoose.connection.db!;
    for (const collection of await db.collections()) {
      expect(await collection.countDocuments({ companyId: { $in: [demoCompanyId(), SECOND_TENANT_ID] } })).toBe(0);
    }

    const second = await seedDemo(demoCompanyId(), PASSWORD);
    expect(second.accounts).toEqual(first.accounts);
    expect(second.requests).toBe(first.requests);
    expect(await User.countDocuments({ email: "keep-me@example.com" })).toBe(1);
    expect(await Company.exists({ _id: bystander._id })).not.toBeNull();
  });
});
