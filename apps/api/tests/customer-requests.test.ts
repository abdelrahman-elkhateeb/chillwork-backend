import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Invoice } from "../src/modules/billing/invoice.model.js";
import { WorkResult } from "../src/modules/technician/work-result.model.js";
import { VisitEvent } from "../src/modules/visits/visit-event.model.js";
import { cookieHeader, createCompany, createServiceRequest, createUser, createVisitDoc, loginAs } from "./helpers.js";

const app = createApp();

async function member(companyId: unknown, role: "ADMIN" | "TECHNICIAN" | "CUSTOMER", name?: string) {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await createUser(companyId, { email, role, name });
  const cookies = await loginAs(app, email);
  return { user, cookies };
}

function get(cookies: Record<string, string>, path: string) {
  return request(app).get(path).set("Cookie", cookieHeader(cookies));
}

const ANALYSIS = { summary: "secret-ish", possibleCauses: ["x"], missingInformation: [], inspectionQuestions: [] };

async function world() {
  const company = await createCompany({ timezone: "Africa/Cairo" });
  const admin = await member(company._id, "ADMIN");
  const customer = await member(company._id, "CUSTOMER");
  const tech = await member(company._id, "TECHNICIAN", "Omar Tech");
  return { company, admin, customer, tech };
}

type World = Awaited<ReturnType<typeof world>>;

function visit(w: World, requestId: unknown, deviceIds: string[], status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED") {
  return createVisitDoc({
    companyId: w.company._id,
    requestId,
    technicianId: w.tech.user._id,
    scheduledById: w.admin.user._id,
    deviceIds,
    status,
  });
}

async function result(w: World, v: { _id: unknown; requestId: unknown }, deviceId: string, value: "REPAIRED" | "FAILED") {
  await WorkResult.create({
    companyId: w.company._id,
    visitId: v._id,
    requestId: v.requestId,
    clientDeviceId: deviceId,
    result: value,
    failureReason: value === "FAILED" ? "PART_UNAVAILABLE" : null,
    failureNote: value === "FAILED" ? "internal technician note" : null,
    version: 1,
    recordedById: w.tech.user._id,
  });
}

describe("GET /requests", () => {
  it("returns only the caller's own requests, newest first, with per-device progress", async () => {
    const w = await world();
    const neighbour = await member(w.company._id, "CUSTOMER");
    const mine = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "a" }, { clientDeviceId: "b" }]);
    await visit(w, mine._id, ["a"], "SCHEDULED");
    await createServiceRequest(w.company._id, neighbour.user._id);

    const res = await get(w.customer.cookies, "/api/v1/requests");

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(res.body.data).toEqual([
      {
        requestId: String(mine._id),
        reference: mine.reference,
        status: "SUBMITTED",
        progress: "SCHEDULED",
        outcome: null,
        createdAt: mine.createdAt.toISOString(),
        address: "1 Main St",
        deviceCount: 2,
        devices: [
          { clientDeviceId: "a", label: "a", progress: "SCHEDULED" },
          { clientDeviceId: "b", label: "b", progress: "AWAITING_SCHEDULE" },
        ],
      },
    ]);
  });

  it("rejects a customerId filter and forbids staff", async () => {
    const w = await world();
    expect((await get(w.customer.cookies, `/api/v1/requests?customerId=${String(w.admin.user._id)}`)).status).toBe(400);
    expect((await get(w.admin.cookies, "/api/v1/requests")).status).toBe(403);
    expect((await get(w.tech.cookies, "/api/v1/requests")).status).toBe(403);
  });
});

describe("request progress and outcome", () => {
  it("never calls a request resolved while one device failed", async () => {
    const w = await world();
    const req = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "a" }, { clientDeviceId: "b" }]);
    const v = await visit(w, req._id, ["a", "b"], "COMPLETED");
    await result(w, v, "a", "REPAIRED");
    await result(w, v, "b", "FAILED");

    const res = await get(w.customer.cookies, `/api/v1/requests/${String(req._id)}`);
    expect(res.body.data).toMatchObject({ progress: "COMPLETED", outcome: "PARTIALLY_REPAIRED" });
    expect(res.body.data.devices.map((d: { progress: string; failureReason: string | null }) => [d.progress, d.failureReason])).toEqual([
      ["REPAIRED", null],
      ["NOT_REPAIRED", "PART_UNAVAILABLE"],
    ]);
  });

  it("stays IN_PROGRESS (no result shown) while the visit is still running", async () => {
    const w = await world();
    const req = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "a" }]);
    const v = await visit(w, req._id, ["a"], "IN_PROGRESS");
    await result(w, v, "a", "REPAIRED");

    const res = await get(w.customer.cookies, `/api/v1/requests/${String(req._id)}`);
    expect(res.body.data).toMatchObject({ progress: "IN_PROGRESS", outcome: null });
    expect(res.body.data.devices[0].progress).toBe("IN_PROGRESS");
  });

  it("is not COMPLETED while another device still awaits a visit", async () => {
    const w = await world();
    const req = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "a" }, { clientDeviceId: "b" }]);
    const v = await visit(w, req._id, ["a"], "COMPLETED");
    await result(w, v, "a", "REPAIRED");

    const res = await get(w.customer.cookies, `/api/v1/requests/${String(req._id)}`);
    expect(res.body.data).toMatchObject({ progress: "SCHEDULED", outcome: null });
  });

  it("treats a device whose only visit was cancelled as awaiting a visit", async () => {
    const w = await world();
    const req = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "a" }]);
    await visit(w, req._id, ["a"], "CANCELLED");
    const res = await get(w.customer.cookies, `/api/v1/requests/${String(req._id)}`);
    expect(res.body.data).toMatchObject({ progress: "SUBMITTED", visits: [] });
    expect(res.body.data.devices[0]).toMatchObject({ progress: "AWAITING_SCHEDULE", visitId: null });
  });
});

describe("GET /requests/:id", () => {
  it("includes visits with timezone, technician name and invoice link, and no staff-only data", async () => {
    const w = await world();
    const req = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "a", analysis: ANALYSIS }]);
    const v = await createVisitDoc({
      companyId: w.company._id,
      requestId: req._id,
      technicianId: w.tech.user._id,
      scheduledById: w.admin.user._id,
      deviceIds: ["a"],
      status: "COMPLETED",
    });
    await result(w, v, "a", "FAILED");
    const invoice = await Invoice.create({
      companyId: w.company._id,
      visitId: v._id,
      requestId: req._id,
      customerId: w.customer.user._id,
      issuedById: w.tech.user._id,
      reference: "INV-TESTREF2",
      idempotencyKey: "k",
      currency: "EGP",
      laborFeeMinor: 15000,
      devices: [],
      subtotalMinor: 0,
      laborMinor: 0,
      totalMinor: 0,
      status: "CLOSED",
      paymentState: "NOT_REQUIRED",
      issuedAt: new Date("2030-01-15T12:00:00Z"),
    });

    const res = await get(w.customer.cookies, `/api/v1/requests/${String(req._id)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.visits).toEqual([
      {
        visitId: String(v._id),
        startAt: "2030-01-15T10:00:00.000Z",
        endAt: "2030-01-15T11:00:00.000Z",
        timezone: "UTC",
        status: "COMPLETED",
        technicianName: "Omar Tech",
        deviceIds: ["a"],
        invoice: {
          id: String(invoice._id),
          reference: "INV-TESTREF2",
          currency: "EGP",
          totalMinor: 0,
          status: "CLOSED",
          paymentState: "NOT_REQUIRED",
          issuedAt: "2030-01-15T12:00:00.000Z",
        },
      },
    ]);
    const body = JSON.stringify(res.body.data);
    for (const banned of [
      "analysis",
      "secret-ish",
      "internal technician note",
      "technicianId",
      "scheduledById",
      "customerId",
      "companyId",
      "idempotencyKey",
    ]) {
      expect(body).not.toContain(banned);
    }
  });

  it("gives the same 404 for another customer's, missing and malformed ids", async () => {
    const w = await world();
    const neighbour = await member(w.company._id, "CUSTOMER");
    const theirs = await createServiceRequest(w.company._id, neighbour.user._id);
    for (const id of [String(theirs._id), "0".repeat(24), "nope"]) {
      for (const path of [`/api/v1/requests/${id}`, `/api/v1/requests/${id}/timeline`]) {
        const res = await get(w.customer.cookies, path);
        expect(res.status).toBe(404);
        expect(res.body.error.message).toBe("Request not found");
      }
    }
  });
});

describe("GET /requests/:id/timeline", () => {
  it("lists customer-visible events only, oldest first", async () => {
    const w = await world();
    const req = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "a" }]);
    const v = await visit(w, req._id, ["a"], "COMPLETED");
    const base = {
      companyId: w.company._id,
      visitId: v._id,
      requestId: req._id,
      actorId: w.tech.user._id,
      technicianId: w.tech.user._id,
    };
    const at = (m: number) => new Date(Date.UTC(2030, 0, 15, 9, m));
    await VisitEvent.create([
      { ...base, type: "VISIT_SCHEDULED", occurredAt: at(0) },
      { ...base, type: "TECHNICIAN_ASSIGNED", occurredAt: at(0) },
      { ...base, type: "VISIT_STARTED", occurredAt: at(10) },
      { ...base, type: "DEVICE_PARTS_UPDATED", occurredAt: at(11), clientDeviceId: "a" },
      { ...base, type: "WORK_RESULT_RECORDED", occurredAt: at(12), clientDeviceId: "a", result: "FAILED" },
      { ...base, type: "VISIT_COMPLETED", occurredAt: at(20) },
      { ...base, type: "INVOICE_ISSUED", occurredAt: at(21) },
    ]);

    const res = await get(w.customer.cookies, `/api/v1/requests/${String(req._id)}/timeline`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((e: { type: string }) => e.type)).toEqual([
      "REQUEST_SUBMITTED",
      "VISIT_SCHEDULED",
      "VISIT_STARTED",
      "VISIT_COMPLETED",
      "INVOICE_ISSUED",
    ]);
    expect(res.body.data[1]).toEqual({ type: "VISIT_SCHEDULED", occurredAt: at(0).toISOString(), visitId: String(v._id) });
    expect(JSON.stringify(res.body.data)).not.toMatch(/actorId|technicianId|FAILED/);
  });
});
