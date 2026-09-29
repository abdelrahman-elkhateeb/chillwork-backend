import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Invoice } from "../src/modules/billing/invoice.model.js";
import { PartStockMovement } from "../src/modules/catalog/part-stock-movement.model.js";
import { Part } from "../src/modules/catalog/part.model.js";
import { Company } from "../src/modules/companies/company.model.js";
import { DeviceParts } from "../src/modules/technician/device-parts.model.js";
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
const FEE = 15000;

async function member(companyId: unknown, role: "ADMIN" | "TECHNICIAN" | "CUSTOMER") {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await createUser(companyId, { email, role });
  const cookies = await loginAs(app, email);
  return { user, cookies };
}

async function world(deviceIds = ["d1", "d2", "d3"]) {
  const company = await createCompany();
  await configureBilling(company._id, { currency: "EGP", laborFeeMinor: FEE });
  const admin = await member(company._id, "ADMIN");
  const customer = await member(company._id, "CUSTOMER");
  const tech = await member(company._id, "TECHNICIAN");
  const req = await createServiceRequest(
    company._id,
    customer.user._id,
    deviceIds.map((id) => ({ clientDeviceId: id, label: `AC ${id}` }))
  );
  const visit = await createVisitDoc({
    companyId: company._id,
    requestId: req._id,
    technicianId: tech.user._id,
    scheduledById: admin.user._id,
    deviceIds,
    status: "IN_PROGRESS",
  });
  const motor = await createPart(company._id, { name: "Fan Motor", unitPriceMinor: 45000, stockQuantity: 5 });
  const cap = await createPart(company._id, { name: "Capacitor", unitPriceMinor: 8000, stockQuantity: 5 });
  return { company, admin, customer, tech, req, visit, motor, cap };
}

type World = Awaited<ReturnType<typeof world>>;

function send(cookies: Record<string, string>, method: "post" | "put", path: string, body?: Record<string, unknown>) {
  return sameOriginRequest(app, method, path).set("Cookie", cookieHeader(cookies)).send(body);
}

async function pickParts(w: World, deviceId: string, items: Array<{ partId: unknown; quantity: number }>) {
  const res = await send(w.tech.cookies, "put", `/api/v1/technician/visits/${String(w.visit._id)}/devices/${deviceId}/parts`, {
    items: items.map((i) => ({ partId: String(i.partId), quantity: i.quantity })),
    version: 0,
  });
  expect(res.status).toBe(200);
  return res.body.data as { items: Array<{ proposalId: string; decision: string }>; version: number };
}

/** Decides every currently-PROPOSED proposal on the device the same way. */
async function decideOpenProposals(w: World, deviceId: string, decision: "APPROVED" | "REJECTED") {
  const current = await getParts(w.tech.cookies, w.visit._id);
  const device = current.body.data.devices.find((d: { clientDeviceId: string }) => d.clientDeviceId === deviceId);
  const open = device.items.filter((item: { decision: string }) => item.decision === "PROPOSED");
  if (open.length === 0) return;
  const res = await send(
    w.tech.cookies,
    "post",
    `/api/v1/technician/visits/${String(w.visit._id)}/devices/${deviceId}/parts/decisions`,
    {
      version: device.version,
      decisions: open.map((item: { proposalId: string }) => ({ proposalId: item.proposalId, decision })),
    }
  );
  expect(res.status).toBe(200);
}

function getParts(cookies: Record<string, string>, visitId: unknown) {
  return request(app).get(`/api/v1/technician/visits/${String(visitId)}/parts`).set("Cookie", cookieHeader(cookies));
}

async function record(w: World, deviceId: string, result: "REPAIRED" | "FAILED") {
  const body = result === "REPAIRED" ? { result, version: 0 } : { result, failureReason: "PART_UNAVAILABLE", version: 0 };
  const res = await send(w.tech.cookies, "put", `/api/v1/technician/visits/${String(w.visit._id)}/work-results/${deviceId}`, body);
  expect(res.status).toBe(200);
}

async function complete(w: World) {
  const res = await send(w.tech.cookies, "post", `/api/v1/technician/visits/${String(w.visit._id)}/complete`);
  expect(res.status).toBe(200);
}

function issue(cookies: Record<string, string>, visitId: unknown, key: string | null = randomUUID()) {
  let req = sameOriginRequest(app, "post", `/api/v1/technician/visits/${String(visitId)}/invoice`).set(
    "Cookie",
    cookieHeader(cookies)
  );
  if (key !== null) req = req.set("Idempotency-Key", key);
  return req.send();
}

function preview(cookies: Record<string, string>, visitId: unknown) {
  return request(app)
    .get(`/api/v1/technician/visits/${String(visitId)}/invoice-preview`)
    .set("Cookie", cookieHeader(cookies));
}

/** Two repaired devices (d1 with parts, d2 labor only) and one failed device (d3, parts picked). */
async function twoOfThreeRepaired(w: World) {
  await pickParts(w, "d1", [
    { partId: w.motor._id, quantity: 1 },
    { partId: w.cap._id, quantity: 2 },
  ]);
  await decideOpenProposals(w, "d1", "APPROVED");
  await pickParts(w, "d3", [{ partId: w.motor._id, quantity: 1 }]);
  await decideOpenProposals(w, "d3", "APPROVED");
  await record(w, "d1", "REPAIRED");
  await record(w, "d2", "REPAIRED");
  await record(w, "d3", "FAILED");
  await complete(w);
}

describe("POST /technician/visits/:id/invoice", () => {
  it("bills only repaired devices: their parts plus one labor fee each", async () => {
    const w = await world();
    await twoOfThreeRepaired(w);

    const res = await issue(w.tech.cookies, w.visit._id);

    expect(res.status).toBe(201);
    const d1Parts = 45000 + 2 * 8000;
    expect(res.body.data).toMatchObject({
      visitId: String(w.visit._id),
      currency: "EGP",
      laborFeeMinor: FEE,
      subtotalMinor: d1Parts,
      laborMinor: 2 * FEE,
      totalMinor: d1Parts + 2 * FEE,
      status: "ISSUED",
      paymentState: "UNPAID",
    });
    expect(res.body.data.reference).toMatch(/^INV-[2-9A-HJ-NP-Z]{8}$/);
    expect(res.body.data.devices).toEqual([
      {
        clientDeviceId: "d1",
        label: "AC d1",
        result: "REPAIRED",
        failureReason: null,
        billable: true,
        parts: [
          { partId: String(w.motor._id), name: "Fan Motor", unitPriceMinor: 45000, quantity: 1, lineTotalMinor: 45000 },
          { partId: String(w.cap._id), name: "Capacitor", unitPriceMinor: 8000, quantity: 2, lineTotalMinor: 16000 },
        ],
        partsMinor: d1Parts,
        laborMinor: FEE,
        totalMinor: d1Parts + FEE,
      },
      {
        clientDeviceId: "d2",
        label: "AC d2",
        result: "REPAIRED",
        failureReason: null,
        billable: true,
        parts: [],
        partsMinor: 0,
        laborMinor: FEE,
        totalMinor: FEE,
      },
      {
        clientDeviceId: "d3",
        label: "AC d3",
        result: "FAILED",
        failureReason: "PART_UNAVAILABLE",
        billable: false,
        parts: [],
        partsMinor: 0,
        laborMinor: 0,
        totalMinor: 0,
      },
    ]);
    expect(res.body.data).not.toHaveProperty("idempotencyKey");
    expect(res.body.data).not.toHaveProperty("customerId");
  });

  it("takes stock only for parts fitted on repaired devices and records the ledger", async () => {
    const w = await world();
    await twoOfThreeRepaired(w);

    const res = await issue(w.tech.cookies, w.visit._id);

    expect((await Part.findById(w.motor._id))?.stockQuantity).toBe(4); // d3's motor was never fitted
    expect((await Part.findById(w.cap._id))?.stockQuantity).toBe(3);
    const movements = await PartStockMovement.find({ reason: "INVOICE_ISSUED" }).sort({ delta: 1 });
    expect(movements.map((m) => [String(m.partId), m.delta, m.quantityAfter, String(m.invoiceId)])).toEqual([
      [String(w.cap._id), -2, 3, res.body.data.id],
      [String(w.motor._id), -1, 4, res.body.data.id],
    ]);
    expect((await VisitEvent.find({ visitId: w.visit._id, type: "INVOICE_ISSUED" })).length).toBe(1);
  });

  it("closes an all-failed visit at zero with no payment required", async () => {
    const w = await world(["d1", "d2"]);
    await pickParts(w, "d1", [{ partId: w.motor._id, quantity: 1 }]);
    await decideOpenProposals(w, "d1", "REJECTED");
    await record(w, "d1", "FAILED");
    await record(w, "d2", "FAILED");
    await complete(w);

    const res = await issue(w.tech.cookies, w.visit._id);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ totalMinor: 0, laborMinor: 0, status: "CLOSED", paymentState: "NOT_REQUIRED" });
    expect((await Part.findById(w.motor._id))?.stockQuantity).toBe(5);
  });

  it("returns the same invoice for a retry with the same key and refuses a second invoice", async () => {
    const w = await world();
    await twoOfThreeRepaired(w);
    const key = randomUUID();

    const first = await issue(w.tech.cookies, w.visit._id, key);
    const retry = await issue(w.tech.cookies, w.visit._id, key);
    const other = await issue(w.tech.cookies, w.visit._id, randomUUID());

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("INVOICE_ALREADY_ISSUED");
    expect(await Invoice.countDocuments({})).toBe(1);
    expect((await Part.findById(w.cap._id))?.stockQuantity).toBe(3); // stock taken once
  });

  it("creates exactly one invoice under concurrent issuance", async () => {
    const w = await world();
    await twoOfThreeRepaired(w);
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 4 }, () => issue(w.tech.cookies, w.visit._id, key)));

    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(await Invoice.countDocuments({})).toBe(1);
    expect((await Part.findById(w.cap._id))?.stockQuantity).toBe(3);
  });

  it("is not changed by later price or fee changes", async () => {
    const w = await world();
    await twoOfThreeRepaired(w);
    const issued = await issue(w.tech.cookies, w.visit._id);

    await Part.updateMany({}, { $set: { unitPriceMinor: 1 } });
    await Company.updateOne({ _id: w.company._id }, { $set: { laborFeeMinor: 1 } });

    const again = await request(app)
      .get(`/api/v1/technician/visits/${String(w.visit._id)}/invoice`)
      .set("Cookie", cookieHeader(w.tech.cookies));
    expect(again.status).toBe(200);
    expect(again.body.data.totalMinor).toBe(issued.body.data.totalMinor);
  });

  it("refuses when stock ran out since the parts were picked, and changes nothing", async () => {
    const w = await world();
    await twoOfThreeRepaired(w);
    await Part.updateOne({ _id: w.cap._id }, { $set: { stockQuantity: 1 } });

    const res = await issue(w.tech.cookies, w.visit._id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(res.body.error.fieldErrors).toEqual({ [`parts.${String(w.cap._id)}`]: ["Not enough stock for Capacitor"] });
    expect(await Invoice.countDocuments({})).toBe(0);
    expect((await Part.findById(w.motor._id))?.stockQuantity).toBe(5); // motor decrement rolled back
    expect(await PartStockMovement.countDocuments({})).toBe(0);
  });

  it("requires a COMPLETED visit", async () => {
    const w = await world(["d1"]);
    await record(w, "d1", "REPAIRED");
    const res = await issue(w.tech.cookies, w.visit._id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VISIT_STATUS_CONFLICT");
  });

  it("requires an Idempotency-Key", async () => {
    const w = await world(["d1"]);
    await record(w, "d1", "REPAIRED");
    await complete(w);
    const res = await issue(w.tech.cookies, w.visit._id, null);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("denies another technician (uniform 404), a reassigned one, and non-technicians", async () => {
    const w = await world(["d1"]);
    await record(w, "d1", "REPAIRED");
    await complete(w);
    const other = await member(w.company._id, "TECHNICIAN");

    expect((await issue(other.cookies, w.visit._id)).status).toBe(404);
    expect((await issue(w.admin.cookies, w.visit._id)).status).toBe(403);
    expect((await issue(w.customer.cookies, w.visit._id)).status).toBe(403);

    await Visit.updateOne({ _id: w.visit._id }, { $set: { technicianId: other.user._id } });
    expect((await issue(w.tech.cookies, w.visit._id)).status).toBe(404);
    expect(await Invoice.countDocuments({})).toBe(0);
  });
});

describe("billing eligibility by device-part decision", () => {
  it("bills an APPROVED proposal on a repaired device", async () => {
    const w = await world(["d1"]);
    await pickParts(w, "d1", [{ partId: w.motor._id, quantity: 1 }]);
    await decideOpenProposals(w, "d1", "APPROVED");
    await record(w, "d1", "REPAIRED");
    await complete(w);

    const res = await issue(w.tech.cookies, w.visit._id);
    expect(res.status).toBe(201);
    expect(res.body.data.totalMinor).toBe(45000 + FEE);
  });

  it("mixed proposals on one device: rejected part is never billed even though another part on the same device is approved", async () => {
    const w = await world(["d1"]);
    const picked = await pickParts(w, "d1", [
      { partId: w.motor._id, quantity: 1 },
      { partId: w.cap._id, quantity: 1 },
    ]);
    const [motorItem, capItem] = picked.items;
    const decideRes = await send(
      w.tech.cookies,
      "post",
      `/api/v1/technician/visits/${String(w.visit._id)}/devices/d1/parts/decisions`,
      {
        version: picked.version,
        decisions: [
          { proposalId: motorItem!.proposalId, decision: "APPROVED" },
          { proposalId: capItem!.proposalId, decision: "REJECTED" },
        ],
      }
    );
    expect(decideRes.status).toBe(200);

    await record(w, "d1", "REPAIRED");
    await complete(w);

    const res = await issue(w.tech.cookies, w.visit._id);
    expect(res.status).toBe(201);
    // Only the approved motor is billed; the rejected capacitor contributes nothing,
    // even though it sits on the same REPAIRED device.
    expect(res.body.data.devices[0].parts.map((p: { name: string }) => p.name)).toEqual(["Fan Motor"]);
    expect(res.body.data.subtotalMinor).toBe(45000);
    expect(res.body.data.totalMinor).toBe(45000 + FEE);
  });

  it("a still-PROPOSED (undecided) proposal blocks recording REPAIRED at all", async () => {
    const w = await world(["d1"]);
    await pickParts(w, "d1", [{ partId: w.motor._id, quantity: 1 }]);
    const res = await send(w.tech.cookies, "put", `/api/v1/technician/visits/${String(w.visit._id)}/work-results/d1`, {
      result: "REPAIRED",
      version: 0,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WORK_NOT_APPROVED");
  });

  it("legacy DeviceParts documents with no decision field remain billable exactly as before", async () => {
    const w = await world(["d1"]);
    // Bypass the API to simulate a document created before decisions existed:
    // no `decision`/`proposalId` on its items at all (not even null).
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

    const res = await send(w.tech.cookies, "put", `/api/v1/technician/visits/${String(w.visit._id)}/work-results/d1`, {
      result: "REPAIRED",
      version: 0,
    });
    expect(res.status).toBe(200); // no decision-bearing item exists yet -> falls back to unrestricted
    await complete(w);

    const issued = await issue(w.tech.cookies, w.visit._id);
    expect(issued.status).toBe(201);
    expect(issued.body.data.totalMinor).toBe(45000 + FEE);
  });
});

describe("GET /technician/visits/:id/invoice-preview", () => {
  it("prices the current state while IN_PROGRESS, leaving unresolved devices at zero", async () => {
    const w = await world(["d1", "d2"]);
    await pickParts(w, "d1", [{ partId: w.cap._id, quantity: 1 }]);
    await decideOpenProposals(w, "d1", "APPROVED");
    await record(w, "d1", "REPAIRED");

    const res = await preview(w.tech.cookies, w.visit._id);

    expect(res.status).toBe(200);
    expect(res.body.data.totalMinor).toBe(8000 + FEE);
    expect(res.body.data.devices[1]).toMatchObject({ clientDeviceId: "d2", result: null, billable: false, totalMinor: 0 });
    expect(await Invoice.countDocuments({})).toBe(0);
    expect((await Part.findById(w.cap._id))?.stockQuantity).toBe(5);
  });

  it("is refused for a SCHEDULED visit", async () => {
    const w = await world(["d1"]);
    await Visit.updateOne({ _id: w.visit._id }, { $set: { status: "SCHEDULED" } });
    const res = await preview(w.tech.cookies, w.visit._id);
    expect(res.status).toBe(409);
  });
});

describe("GET /technician/visits/:id/invoice", () => {
  it("is 404 before issuance", async () => {
    const w = await world(["d1"]);
    const res = await request(app)
      .get(`/api/v1/technician/visits/${String(w.visit._id)}/invoice`)
      .set("Cookie", cookieHeader(w.tech.cookies));
    expect(res.status).toBe(404);
  });
});
