import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Invoice } from "../src/modules/billing/invoice.model.js";
import { ServiceRequest } from "../src/modules/requests/request.model.js";
import { WorkResult } from "../src/modules/technician/work-result.model.js";
import { cookieHeader, createCompany, createServiceRequest, createUser, createVisitDoc, loginAs } from "./helpers.js";

const app = createApp();

async function member(companyId: unknown, role: "ADMIN" | "TECHNICIAN" | "CUSTOMER", name?: string, email?: string) {
  const address = email ?? `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await createUser(companyId, { email: address, role, name });
  const cookies = await loginAs(app, address);
  return { user, cookies };
}

function get(cookies: Record<string, string>, path: string) {
  return request(app).get(path).set("Cookie", cookieHeader(cookies));
}

const ANALYSIS = { summary: "Fan motor likely", possibleCauses: ["Motor"], missingInformation: [], inspectionQuestions: ["Spins?"] };

describe("GET /admin/requests", () => {
  it("lists the company's requests newest first with scheduling counts", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const customer = await member(company._id, "CUSTOMER", "Mona Customer");
    const tech = await member(company._id, "TECHNICIAN");
    const older = await createServiceRequest(company._id, customer.user._id, [{ clientDeviceId: "a" }, { clientDeviceId: "b" }]);
    await ServiceRequest.updateOne({ _id: older._id }, { $set: { createdAt: new Date("2030-01-01T00:00:00Z") } });
    const newer = await createServiceRequest(company._id, customer.user._id, [{ clientDeviceId: "c" }]);
    await createVisitDoc({
      companyId: company._id,
      requestId: older._id,
      technicianId: tech.user._id,
      scheduledById: admin.user._id,
      deviceIds: ["a"],
    });
    await createServiceRequest((await createCompany())._id, customer.user._id); // another company

    const res = await get(admin.cookies, "/api/v1/admin/requests");

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 2 });
    expect(res.body.data.map((r: { requestId: string }) => r.requestId)).toEqual([String(newer._id), String(older._id)]);
    expect(res.body.data[1]).toMatchObject({
      reference: older.reference,
      status: "SUBMITTED",
      customer: { id: String(customer.user._id), name: "Mona Customer", phone: "+15550001111" },
      deviceCount: 2,
      unscheduledDeviceCount: 1,
      visitCount: 1,
      nextActions: ["SCHEDULE_VISIT"],
    });
  });

  it("does not count a CANCELLED visit as scheduling a device", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const customer = await member(company._id, "CUSTOMER");
    const tech = await member(company._id, "TECHNICIAN");
    const req = await createServiceRequest(company._id, customer.user._id, [{ clientDeviceId: "a" }]);
    await createVisitDoc({
      companyId: company._id,
      requestId: req._id,
      technicianId: tech.user._id,
      scheduledById: admin.user._id,
      deviceIds: ["a"],
      status: "CANCELLED",
    });
    const res = await get(admin.cookies, "/api/v1/admin/requests");
    expect(res.body.data[0]).toMatchObject({ unscheduledDeviceCount: 1, nextActions: ["SCHEDULE_VISIT"] });
  });

  it("offers no action once every device is covered", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const customer = await member(company._id, "CUSTOMER");
    const tech = await member(company._id, "TECHNICIAN");
    const req = await createServiceRequest(company._id, customer.user._id, [{ clientDeviceId: "a" }]);
    await createVisitDoc({
      companyId: company._id,
      requestId: req._id,
      technicianId: tech.user._id,
      scheduledById: admin.user._id,
      deviceIds: ["a"],
      status: "COMPLETED",
    });
    const res = await get(admin.cookies, "/api/v1/admin/requests");
    expect(res.body.data[0]).toMatchObject({ unscheduledDeviceCount: 0, nextActions: [] });
  });

  it("searches by reference prefix and by customer name/email/phone, as literal text", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const mona = await member(company._id, "CUSTOMER", "Mona Customer", `mona-${randomUUID()}@example.com`);
    const karim = await member(company._id, "CUSTOMER", "Karim Customer");
    const monaReq = await createServiceRequest(company._id, mona.user._id);
    const karimReq = await createServiceRequest(company._id, karim.user._id);
    await ServiceRequest.updateOne({ _id: karimReq._id }, { $set: { reference: "SR-K9XQAB27" } });

    const byName = await get(admin.cookies, "/api/v1/admin/requests?search=mona");
    expect(byName.body.data.map((r: { requestId: string }) => r.requestId)).toEqual([String(monaReq._id)]);

    const byRef = await get(admin.cookies, "/api/v1/admin/requests?search=sr-k9x");
    expect(byRef.body.data.map((r: { requestId: string }) => r.requestId)).toEqual([String(karimReq._id)]);

    const regex = await get(admin.cookies, "/api/v1/admin/requests?search=.*");
    expect(regex.body.data).toEqual([]);
  });

  it("never matches another company's customers in a search", async () => {
    const company = await createCompany();
    const other = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const foreign = await createUser(other._id, { role: "CUSTOMER", name: "Foreign Mona" });
    await createServiceRequest(other._id, foreign._id);
    const res = await get(admin.cookies, "/api/v1/admin/requests?search=Foreign");
    expect(res.body.data).toEqual([]);
  });

  it("rejects unknown filters and oversized pages", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    expect((await get(admin.cookies, "/api/v1/admin/requests?companyId=x")).status).toBe(400);
    expect((await get(admin.cookies, "/api/v1/admin/requests?pageSize=101")).status).toBe(400);
  });

  it.each(["CUSTOMER", "TECHNICIAN"] as const)("forbids a %s", async (role) => {
    const company = await createCompany();
    const user = await member(company._id, role);
    expect((await get(user.cookies, "/api/v1/admin/requests")).status).toBe(403);
  });
});

describe("GET /admin/requests/:id", () => {
  it("returns original text and AI output separately, visits with outcome and invoice", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const customer = await member(company._id, "CUSTOMER", "Mona Customer");
    const tech = await member(company._id, "TECHNICIAN", "Omar Tech");
    const req = await createServiceRequest(company._id, customer.user._id, [
      { clientDeviceId: "a", originalDescription: "  warm air, exactly as typed ", analysis: ANALYSIS },
      { clientDeviceId: "b", analysis: null },
      { clientDeviceId: "c" },
    ]);
    const visit = await createVisitDoc({
      companyId: company._id,
      requestId: req._id,
      technicianId: tech.user._id,
      scheduledById: admin.user._id,
      deviceIds: ["a", "b"],
      status: "COMPLETED",
    });
    for (const [deviceId, result] of [["a", "REPAIRED"], ["b", "FAILED"]] as const) {
      await WorkResult.create({
        companyId: company._id,
        visitId: visit._id,
        requestId: req._id,
        clientDeviceId: deviceId,
        result,
        failureReason: result === "FAILED" ? "OTHER" : null,
        version: 1,
        recordedById: tech.user._id,
      });
    }
    const invoice = await Invoice.create({
      companyId: company._id,
      visitId: visit._id,
      requestId: req._id,
      customerId: customer.user._id,
      issuedById: tech.user._id,
      reference: "INV-TESTREF1",
      idempotencyKey: "k",
      currency: "EGP",
      laborFeeMinor: 15000,
      devices: [],
      subtotalMinor: 0,
      laborMinor: 15000,
      totalMinor: 15000,
      status: "ISSUED",
      paymentState: "UNPAID",
      issuedAt: new Date(),
    });

    const res = await get(admin.cookies, `/api/v1/admin/requests/${String(req._id)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.customer).toEqual({
      id: String(customer.user._id),
      name: "Mona Customer",
      email: customer.user.email,
      phone: customer.user.phone,
    });
    expect(res.body.data.devices[0]).toEqual({
      clientDeviceId: "a",
      label: "a",
      brand: null,
      model: null,
      originalDescription: "  warm air, exactly as typed ",
      aiAnalysis: { status: "SUCCESS", errorCode: null, analysis: ANALYSIS },
      visitId: String(visit._id),
    });
    expect(res.body.data.devices[1].aiAnalysis).toEqual({ status: "UNAVAILABLE", errorCode: "GEMINI_TIMEOUT", analysis: null });
    expect(res.body.data.devices[2].visitId).toBeNull();
    expect(res.body.data.visits).toEqual([
      expect.objectContaining({
        visitId: String(visit._id),
        technician: { id: String(tech.user._id), name: "Omar Tech" },
        status: "COMPLETED",
        deviceIds: ["a", "b"],
        outcome: "PARTIALLY_REPAIRED",
        invoice: {
          id: String(invoice._id),
          reference: "INV-TESTREF1",
          currency: "EGP",
          totalMinor: 15000,
          status: "ISSUED",
          paymentState: "UNPAID",
        },
      }),
    ]);
    expect(res.body.data).toMatchObject({ unscheduledDeviceCount: 1, nextActions: ["SCHEDULE_VISIT"] });
    expect(JSON.stringify(res.body.data)).not.toMatch(/promptVersion|internal-model-name|idempotencyKey/);
  });

  it("gives the same 404 for another company's, missing and malformed ids", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const foreignCustomer = await createUser((await createCompany())._id, { role: "CUSTOMER" });
    const foreign = await createServiceRequest(foreignCustomer.companyId, foreignCustomer._id);

    for (const id of [String(foreign._id), "0".repeat(24), "not-an-id"]) {
      const res = await get(admin.cookies, `/api/v1/admin/requests/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.message).toBe("Request not found");
    }
  });
});
