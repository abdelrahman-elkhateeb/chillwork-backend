import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Invoice } from "../src/modules/billing/invoice.model.js";
import { Part } from "../src/modules/catalog/part.model.js";
import { DeviceParts } from "../src/modules/technician/device-parts.model.js";
import { WorkResult } from "../src/modules/technician/work-result.model.js";
import { VisitEvent } from "../src/modules/visits/visit-event.model.js";
import { Visit } from "../src/modules/visits/visit.model.js";
import {
  configureBilling,
  cookieHeader,
  createCompany,
  createPart,
  createServiceRequest,
  createUser,
  createVisitDoc,
  loginAs,
  sameOriginRequest,
} from "./helpers.js";

const app = createApp();

async function member(companyId: unknown, role: "ADMIN" | "TECHNICIAN" | "CUSTOMER") {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await createUser(companyId, { email, role });
  const cookies = await loginAs(app, email);
  return { user, cookies };
}

async function world(options: { billing?: boolean } = {}) {
  const company = await createCompany();
  if (options.billing ?? true) await configureBilling(company._id, { currency: "EGP", laborFeeMinor: 15000 });
  const admin = await member(company._id, "ADMIN");
  const customer = await member(company._id, "CUSTOMER");
  const tech = await member(company._id, "TECHNICIAN");
  const req = await createServiceRequest(company._id, customer.user._id, [
    { clientDeviceId: "d1" },
    { clientDeviceId: "d2" },
    { clientDeviceId: "d3" },
  ]);
  const visit = await createVisitDoc({
    companyId: company._id,
    requestId: req._id,
    technicianId: tech.user._id,
    scheduledById: admin.user._id,
    deviceIds: ["d1", "d2"],
    status: "IN_PROGRESS",
  });
  const motor = await createPart(company._id, { name: "Fan Motor", unitPriceMinor: 45000, stockQuantity: 5 });
  const cap = await createPart(company._id, { name: "Capacitor", unitPriceMinor: 8000, stockQuantity: 2 });
  return { company, admin, customer, tech, req, visit, motor, cap };
}

function put(cookies: Record<string, string>, visitId: unknown, deviceId: string, body: Record<string, unknown>) {
  return sameOriginRequest(app, "put", `/api/v1/technician/visits/${String(visitId)}/devices/${deviceId}/parts`)
    .set("Cookie", cookieHeader(cookies))
    .send(body);
}

function getParts(cookies: Record<string, string>, visitId: unknown) {
  return request(app).get(`/api/v1/technician/visits/${String(visitId)}/parts`).set("Cookie", cookieHeader(cookies));
}

function decide(cookies: Record<string, string>, visitId: unknown, deviceId: string, body: Record<string, unknown>) {
  return sameOriginRequest(app, "post", `/api/v1/technician/visits/${String(visitId)}/devices/${deviceId}/parts/decisions`)
    .set("Cookie", cookieHeader(cookies))
    .send(body);
}

function putWorkResult(cookies: Record<string, string>, visitId: unknown, deviceId: string, body: Record<string, unknown>) {
  return sameOriginRequest(app, "put", `/api/v1/technician/visits/${String(visitId)}/work-results/${deviceId}`)
    .set("Cookie", cookieHeader(cookies))
    .send(body);
}

describe("PUT /technician/visits/:visitId/devices/:deviceId/parts", () => {
  it("snapshots catalog prices and returns line totals", async () => {
    const w = await world();

    const res = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [
        { partId: String(w.motor._id), quantity: 1 },
        { partId: String(w.cap._id), quantity: 2 },
      ],
      version: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      clientDeviceId: "d1",
      items: [
        { partId: String(w.motor._id), name: "Fan Motor", unitPriceMinor: 45000, quantity: 1, lineTotalMinor: 45000, decision: "PROPOSED", decidedAt: null },
        { partId: String(w.cap._id), name: "Capacitor", unitPriceMinor: 8000, quantity: 2, lineTotalMinor: 16000, decision: "PROPOSED", decidedAt: null },
      ],
      partsMinor: 61000,
      version: 1,
    });
    // Every new proposal gets its own stable, distinct identity.
    const [motorItem, capItem] = res.body.data.items;
    expect(motorItem.proposalId).toEqual(expect.any(String));
    expect(capItem.proposalId).toEqual(expect.any(String));
    expect(motorItem.proposalId).not.toBe(capItem.proposalId);
    expect((await VisitEvent.find({ visitId: w.visit._id })).map((e) => e.type)).toEqual(["DEVICE_PARTS_UPDATED"]);
  });

  it("keeps the agreed price for a part already selected when the catalog price changes", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.motor._id), quantity: 1 }], version: 0 });
    await Part.updateOne({ _id: w.motor._id }, { $set: { unitPriceMinor: 99999 } });
    await Part.updateOne({ _id: w.cap._id }, { $set: { unitPriceMinor: 7000 } });

    const res = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [
        { partId: String(w.motor._id), quantity: 2 },
        { partId: String(w.cap._id), quantity: 1 },
      ],
      version: 1,
    });

    expect(res.body.data.items.map((i: { unitPriceMinor: number }) => i.unitPriceMinor)).toEqual([45000, 7000]);
    expect(res.body.data.partsMinor).toBe(2 * 45000 + 7000);
  });

  it("ignores a client-supplied price", async () => {
    const w = await world();
    const res = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1, unitPriceMinor: 1 }],
      version: 0,
      partsMinor: 1,
    });
    expect(res.body.data.partsMinor).toBe(45000);
  });

  it("clears the selection with an empty list", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.motor._id), quantity: 1 }], version: 0 });
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [], version: 1 });
    expect(res.body.data).toMatchObject({ items: [], partsMinor: 0, version: 2 });
  });

  it("refuses more than the current stock and saves nothing", async () => {
    const w = await world();
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.cap._id), quantity: 3 }], version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(res.body.error.fieldErrors).toEqual({ "items.0.quantity": ["Only 2 available"] });
    expect(await DeviceParts.countDocuments({})).toBe(0);
  });

  it("counts units already picked for another device on the same visit", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 0 });
    const res = await put(w.tech.cookies, w.visit._id, "d2", { items: [{ partId: String(w.cap._id), quantity: 1 }], version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.fieldErrors).toEqual({ "items.0.quantity": ["Only 0 available"] });
  });

  it("does not count the device's own previous pick against it", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 0 });
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 1 });
    expect(res.status).toBe(200);
  });

  it("counts units picked on another technician's visit, but not once that pick is released", async () => {
    const w = await world();
    const other = await member(w.company._id, "TECHNICIAN");
    const req2 = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "x" }]);
    const visit2 = await createVisitDoc({
      companyId: w.company._id,
      requestId: req2._id,
      technicianId: other.user._id,
      scheduledById: w.admin.user._id,
      deviceIds: ["x"],
      status: "IN_PROGRESS",
    });
    await put(other.cookies, visit2._id, "x", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 0 });
    const pickOne = (version: number) =>
      put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.cap._id), quantity: 1 }], version });

    expect((await pickOne(0)).status).toBe(409);

    // The other device failed: its parts are never fitted, so they are released.
    await WorkResult.create({
      companyId: w.company._id,
      visitId: visit2._id,
      requestId: req2._id,
      clientDeviceId: "x",
      result: "FAILED",
      failureReason: "OTHER",
      version: 1,
      recordedById: other.user._id,
    });
    expect((await pickOne(0)).status).toBe(200);
  });

  it.each([
    ["the other visit was cancelled", { status: "CANCELLED" }],
    ["the other visit's invoice was issued (stock already taken)", { invoiced: true }],
  ])("releases a pick when %s", async (_label, change) => {
    const w = await world();
    const other = await member(w.company._id, "TECHNICIAN");
    const req2 = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "x" }]);
    const visit2 = await createVisitDoc({
      companyId: w.company._id,
      requestId: req2._id,
      technicianId: other.user._id,
      scheduledById: w.admin.user._id,
      deviceIds: ["x"],
      status: "IN_PROGRESS",
    });
    await put(other.cookies, visit2._id, "x", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 0 });
    if ("status" in change) await Visit.updateOne({ _id: visit2._id }, { $set: { status: change.status } });
    if ("invoiced" in change) {
      await Invoice.create({
        companyId: w.company._id,
        visitId: visit2._id,
        requestId: req2._id,
        customerId: w.customer.user._id,
        issuedById: other.user._id,
        reference: `INV-${randomUUID().slice(0, 8)}`,
        idempotencyKey: "k",
        currency: "EGP",
        laborFeeMinor: 0,
        devices: [],
        subtotalMinor: 0,
        laborMinor: 0,
        totalMinor: 0,
        status: "CLOSED",
        paymentState: "NOT_REQUIRED",
        issuedAt: new Date(),
      });
    }
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 0 });
    expect(res.status).toBe(200);
  });

  it("lets only one of two concurrent picks take the last units", async () => {
    const w = await world();
    const results = await Promise.all([
      put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 0 }),
      put(w.tech.cookies, w.visit._id, "d2", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 0 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("does not decrement stock (that happens at invoice issuance)", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.cap._id), quantity: 2 }], version: 0 });
    expect((await Part.findById(w.cap._id))?.stockQuantity).toBe(2);
  });

  it.each([
    ["an inactive part", async (companyId: unknown) => createPart(companyId, { isActive: false })],
    ["another company's part", async () => createPart((await createCompany())._id)],
  ])("rejects %s as unavailable", async (_label, makePart) => {
    const w = await world();
    const part = await makePart(w.company._id);
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(part._id), quantity: 1 }], version: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors).toEqual({ "items.0.partId": ["Part is not available"] });
  });

  it("keeps a part that was deactivated after it was selected", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.motor._id), quantity: 1 }], version: 0 });
    await Part.updateOne({ _id: w.motor._id }, { $set: { isActive: false } });
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.motor._id), quantity: 1 }], version: 1 });
    expect(res.status).toBe(200);
  });

  it.each([
    ["a duplicate part", (partId: string) => [{ partId, quantity: 1 }, { partId, quantity: 2 }]],
    ["a zero quantity", (partId: string) => [{ partId, quantity: 0 }]],
    ["a fractional quantity", (partId: string) => [{ partId, quantity: 1.5 }]],
  ])("rejects %s", async (_label, items) => {
    const w = await world();
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: items(String(w.motor._id)), version: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a stale version and a nonzero version with no selection yet", async () => {
    const w = await world();
    const item = { partId: String(w.motor._id), quantity: 1 };
    expect((await put(w.tech.cookies, w.visit._id, "d1", { items: [item], version: 3 })).body.error.code).toBe(
      "VERSION_CONFLICT"
    );
    await put(w.tech.cookies, w.visit._id, "d1", { items: [item], version: 0 });
    expect((await put(w.tech.cookies, w.visit._id, "d1", { items: [item], version: 0 })).body.error.code).toBe(
      "VERSION_CONFLICT"
    );
  });

  it("lets only one of two concurrent writes from the same version apply", async () => {
    const w = await world();
    const item = { partId: String(w.motor._id), quantity: 1 };
    const results = await Promise.all([
      put(w.tech.cookies, w.visit._id, "d1", { items: [item], version: 0 }),
      put(w.tech.cookies, w.visit._id, "d1", { items: [item], version: 0 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await DeviceParts.findOne({ clientDeviceId: "d1" }))?.version).toBe(1);
  });

  it.each(["SCHEDULED", "CANCELLED"] as const)("rejects changes while the visit is %s", async (status) => {
    const w = await world();
    await Visit.updateOne({ _id: w.visit._id }, { $set: { status } });
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [], version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VISIT_STATUS_CONFLICT");
  });

  it("stays editable after COMPLETED until the invoice is issued", async () => {
    const w = await world();
    await Visit.updateOne({ _id: w.visit._id }, { $set: { status: "COMPLETED" } });
    expect((await put(w.tech.cookies, w.visit._id, "d1", { items: [], version: 0 })).status).toBe(200);

    await Invoice.create({
      companyId: w.company._id,
      visitId: w.visit._id,
      requestId: w.req._id,
      customerId: w.customer.user._id,
      issuedById: w.tech.user._id,
      reference: `INV-${randomUUID().slice(0, 8)}`,
      idempotencyKey: "k",
      currency: "EGP",
      laborFeeMinor: 0,
      devices: [],
      subtotalMinor: 0,
      laborMinor: 0,
      totalMinor: 0,
      status: "CLOSED",
      paymentState: "NOT_REQUIRED",
      issuedAt: new Date(),
    });
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [], version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVOICE_ALREADY_ISSUED");
  });

  it("rejects a request device that is not part of this visit", async () => {
    const w = await world();
    const res = await put(w.tech.cookies, w.visit._id, "d3", { items: [], version: 0 });
    expect(res.status).toBe(404);
  });

  it("denies another technician (uniform 404) and non-technicians (403)", async () => {
    const w = await world();
    const other = await member(w.company._id, "TECHNICIAN");
    expect((await put(other.cookies, w.visit._id, "d1", { items: [], version: 0 })).status).toBe(404);
    expect((await put(w.admin.cookies, w.visit._id, "d1", { items: [], version: 0 })).status).toBe(403);
    expect((await put(w.customer.cookies, w.visit._id, "d1", { items: [], version: 0 })).status).toBe(403);
  });

  it("stops the old technician immediately after reassignment", async () => {
    const w = await world();
    const b = await member(w.company._id, "TECHNICIAN");
    await Visit.updateOne({ _id: w.visit._id }, { $set: { technicianId: b.user._id } });
    expect((await put(w.tech.cookies, w.visit._id, "d1", { items: [], version: 0 })).status).toBe(404);
    expect((await put(b.cookies, w.visit._id, "d1", { items: [], version: 0 })).status).toBe(200);
  });

  it("requires billing settings", async () => {
    const w = await world({ billing: false });
    const res = await put(w.tech.cookies, w.visit._id, "d1", { items: [], version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BILLING_NOT_CONFIGURED");
  });
});

describe("GET /technician/visits/:visitId/parts", () => {
  it("lists every device on the visit, including ones with nothing picked", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d2", { items: [{ partId: String(w.cap._id), quantity: 1 }], version: 0 });

    const res = await getParts(w.tech.cookies, w.visit._id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      visitId: String(w.visit._id),
      currency: "EGP",
      devices: [
        { clientDeviceId: "d1", items: [], partsMinor: 0, version: 0 },
        {
          clientDeviceId: "d2",
          items: [
            {
              partId: String(w.cap._id),
              name: "Capacitor",
              unitPriceMinor: 8000,
              quantity: 1,
              lineTotalMinor: 8000,
              decision: "PROPOSED",
              decidedAt: null,
            },
          ],
          partsMinor: 8000,
          version: 1,
        },
      ],
    });
    expect(res.body.data.devices[1].items[0].proposalId).toEqual(expect.any(String));
  });

  it("is readable after the visit is completed", async () => {
    const w = await world();
    await Visit.updateOne({ _id: w.visit._id }, { $set: { status: "COMPLETED" } });
    expect((await getParts(w.tech.cookies, w.visit._id)).status).toBe(200);
  });
});

describe("POST /technician/visits/:visitId/devices/:deviceId/parts/decisions", () => {
  it("moves a PROPOSED proposal to APPROVED", async () => {
    const w = await world();
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 0,
    });
    const proposalId = proposed.body.data.items[0].proposalId;

    const res = await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 1,
      decisions: [{ proposalId, decision: "APPROVED" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.items[0]).toMatchObject({ proposalId, decision: "APPROVED" });
    expect(res.body.data.items[0].decidedAt).not.toBeNull();
  });

  it("moves a PROPOSED proposal to REJECTED", async () => {
    const w = await world();
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 0,
    });
    const proposalId = proposed.body.data.items[0].proposalId;

    const res = await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 1,
      decisions: [{ proposalId, decision: "REJECTED" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].decision).toBe("REJECTED");
    // A rejected proposal drops out of the running total.
    expect(res.body.data.partsMinor).toBe(0);
  });

  it("rejects deciding a proposal that was already decided", async () => {
    const w = await world();
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 0,
    });
    const proposalId = proposed.body.data.items[0].proposalId;
    await decide(w.tech.cookies, w.visit._id, "d1", { version: 1, decisions: [{ proposalId, decision: "APPROVED" }] });

    const redecide = await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 2,
      decisions: [{ proposalId, decision: "REJECTED" }],
    });
    expect(redecide.status).toBe(400);
    expect(redecide.body.error.code).toBe("VALIDATION_ERROR");
    const stored = await DeviceParts.findOne({ visitId: w.visit._id, clientDeviceId: "d1" });
    expect(stored?.items[0]?.decision).toBe("APPROVED");
  });

  it("rejects a decision for an unknown proposalId", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.motor._id), quantity: 1 }], version: 0 });
    const res = await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 1,
      decisions: [{ proposalId: "0".repeat(24), decision: "APPROVED" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when nothing has been proposed for this device yet", async () => {
    const w = await world();
    const res = await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 1,
      decisions: [{ proposalId: "0".repeat(24), decision: "APPROVED" }],
    });
    expect(res.status).toBe(404);
  });

  it("rejects a stale version", async () => {
    const w = await world();
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 0,
    });
    const proposalId = proposed.body.data.items[0].proposalId;
    const res = await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 99,
      decisions: [{ proposalId, decision: "APPROVED" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
  });

  it("does not let two concurrent decisions from the same base version both apply", async () => {
    const w = await world();
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [
        { partId: String(w.motor._id), quantity: 1 },
        { partId: String(w.cap._id), quantity: 1 },
      ],
      version: 0,
    });
    const [motorProposalId, capProposalId] = proposed.body.data.items.map((i: { proposalId: string }) => i.proposalId);

    const [a, b] = await Promise.all([
      decide(w.tech.cookies, w.visit._id, "d1", { version: 1, decisions: [{ proposalId: motorProposalId, decision: "APPROVED" }] }),
      decide(w.tech.cookies, w.visit._id, "d1", { version: 1, decisions: [{ proposalId: capProposalId, decision: "REJECTED" }] }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("denies a technician from another company (uniform 404)", async () => {
    const w = await world();
    const otherCompany = await createCompany();
    const other = await member(otherCompany._id, "TECHNICIAN");
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.motor._id), quantity: 1 }], version: 0 });
    const res = await decide(other.cookies, w.visit._id, "d1", { version: 1, decisions: [{ proposalId: "0".repeat(24), decision: "APPROVED" }] });
    expect(res.status).toBe(404);
  });

  it.each(["ADMIN", "CUSTOMER"] as const)("denies a %s with 403", async (role) => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.motor._id), quantity: 1 }], version: 0 });
    const other = await member(w.company._id, role);
    const res = await decide(other.cookies, w.visit._id, "d1", { version: 1, decisions: [{ proposalId: "0".repeat(24), decision: "APPROVED" }] });
    expect(res.status).toBe(403);
  });

  it("stops the old technician immediately after reassignment and grants the new one", async () => {
    const w = await world();
    const b = await member(w.company._id, "TECHNICIAN");
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 0,
    });
    const proposalId = proposed.body.data.items[0].proposalId;

    await Visit.updateOne({ _id: w.visit._id }, { $set: { technicianId: b.user._id } });

    const aBlocked = await decide(w.tech.cookies, w.visit._id, "d1", { version: 1, decisions: [{ proposalId, decision: "APPROVED" }] });
    expect(aBlocked.status).toBe(404);

    const bAllowed = await decide(b.cookies, w.visit._id, "d1", { version: 1, decisions: [{ proposalId, decision: "APPROVED" }] });
    expect(bAllowed.status).toBe(200);
  });
});

describe("re-proposal after rejection", () => {
  it("re-proposing the same part after rejection creates a new proposalId and never mutates the old one", async () => {
    const w = await world();
    const first = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 0,
    });
    const firstProposalId = first.body.data.items[0].proposalId;
    await decide(w.tech.cookies, w.visit._id, "d1", { version: 1, decisions: [{ proposalId: firstProposalId, decision: "REJECTED" }] });

    // Re-propose the same catalog part.
    const second = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 2,
    });
    expect(second.status).toBe(200);
    expect(second.body.data.items).toHaveLength(2);

    const rejected = second.body.data.items.find((i: { proposalId: string }) => i.proposalId === firstProposalId);
    const newProposal = second.body.data.items.find((i: { proposalId: string }) => i.proposalId !== firstProposalId);

    expect(rejected).toMatchObject({ decision: "REJECTED" });
    expect(newProposal).toMatchObject({ decision: "PROPOSED", partId: String(w.motor._id) });
    expect(newProposal.proposalId).not.toBe(firstProposalId);

    // The new proposal can now be independently approved without touching the old one.
    const approved = await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 3,
      decisions: [{ proposalId: newProposal.proposalId, decision: "APPROVED" }],
    });
    expect(approved.status).toBe(200);
    const stillRejected = approved.body.data.items.find((i: { proposalId: string }) => i.proposalId === firstProposalId);
    expect(stillRejected.decision).toBe("REJECTED");
  });
});

describe("legacy DeviceParts compatibility", () => {
  it("a legacy item (no decision field at all) is distinguishable from a new PROPOSED item and keeps working", async () => {
    const w = await world();
    await DeviceParts.create({
      companyId: w.company._id,
      visitId: w.visit._id,
      requestId: w.req._id,
      clientDeviceId: "d1",
      currency: "EGP",
      items: [{ partId: w.motor._id, name: "Fan Motor", unitPriceMinor: 45000, quantity: 1 }],
      version: 1,
      updatedById: w.tech.user._id,
    });

    const res = await getParts(w.tech.cookies, w.visit._id);
    const legacyItem = res.body.data.devices.find((d: { clientDeviceId: string }) => d.clientDeviceId === "d1").items[0];
    expect(legacyItem.decision).toBeNull();
    expect(legacyItem.proposalId).toBeNull();

    // Touching the device with an unrelated new pick doesn't retroactively
    // tag the legacy item — but leaving its partId out of a full replace
    // still drops it, matching this endpoint's original full-replace
    // behavior for anything that was never decided.
    const cleared = await put(w.tech.cookies, w.visit._id, "d1", { items: [], version: 1 });
    expect(cleared.body.data.items).toEqual([]);
  });
});

describe("FS23 -> FS11 boundary", () => {
  it("approved parts allow REPAIRED", async () => {
    const w = await world();
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 0,
    });
    await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 1,
      decisions: [{ proposalId: proposed.body.data.items[0].proposalId, decision: "APPROVED" }],
    });

    const res = await putWorkResult(w.tech.cookies, w.visit._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(200);
  });

  it("a rejected-only proposal blocks REPAIRED but allows FAILED/CUSTOMER_REFUSED", async () => {
    const w = await world();
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [{ partId: String(w.motor._id), quantity: 1 }],
      version: 0,
    });
    await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 1,
      decisions: [{ proposalId: proposed.body.data.items[0].proposalId, decision: "REJECTED" }],
    });

    const repaired = await putWorkResult(w.tech.cookies, w.visit._id, "d1", { result: "REPAIRED", version: 0 });
    expect(repaired.status).toBe(409);
    expect(repaired.body.error.code).toBe("WORK_NOT_APPROVED");
    expect(await WorkResult.countDocuments({})).toBe(0);

    const failed = await putWorkResult(w.tech.cookies, w.visit._id, "d1", {
      result: "FAILED",
      failureReason: "CUSTOMER_REFUSED",
      version: 0,
    });
    expect(failed.status).toBe(200);
  });

  it("a still-undecided proposal blocks any work result", async () => {
    const w = await world();
    await put(w.tech.cookies, w.visit._id, "d1", { items: [{ partId: String(w.motor._id), quantity: 1 }], version: 0 });
    const res = await putWorkResult(w.tech.cookies, w.visit._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WORK_NOT_APPROVED");
  });

  it("mixed approved/rejected proposals on the same device: REPAIRED is allowed (device has an approved item)", async () => {
    const w = await world();
    const proposed = await put(w.tech.cookies, w.visit._id, "d1", {
      items: [
        { partId: String(w.motor._id), quantity: 1 },
        { partId: String(w.cap._id), quantity: 1 },
      ],
      version: 0,
    });
    const [motorItem, capItem] = proposed.body.data.items;
    await decide(w.tech.cookies, w.visit._id, "d1", {
      version: 1,
      decisions: [
        { proposalId: motorItem.proposalId, decision: "APPROVED" },
        { proposalId: capItem.proposalId, decision: "REJECTED" },
      ],
    });

    // The device-level gate only asks "is anything approved" — the
    // per-part correctness (rejected capacitor never billed) is enforced
    // separately, in billing/invoice.service.ts, and is covered by
    // tests/invoices.test.ts's "mixed proposals on one device" test.
    const res = await putWorkResult(w.tech.cookies, w.visit._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(200);
  });

  it("falls back to the FS18 device-scope-only boundary when no DeviceParts exist for the device at all", async () => {
    const w = await world();
    const res = await putWorkResult(w.tech.cookies, w.visit._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(200);
  });
});
