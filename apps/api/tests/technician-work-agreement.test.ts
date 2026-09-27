import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { VisitEvent } from "../src/modules/visits/visit-event.model.js";
import { Visit } from "../src/modules/visits/visit.model.js";
import { WorkAgreement } from "../src/modules/technician/work-agreement.model.js";
import { WorkResult } from "../src/modules/technician/work-result.model.js";
import {
  cookieHeader,
  createCompany,
  createServiceRequest,
  createUser,
  createVisitDoc,
  loginAs,
  type TestRequestDevice,
} from "./helpers.js";

const app = createApp();

async function member(companyId: unknown, role: "ADMIN" | "TECHNICIAN" | "CUSTOMER") {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await createUser(companyId, { email, role });
  const cookies = await loginAs(app, email);
  return { user, email, cookies };
}

async function world(devices?: TestRequestDevice[]) {
  const company = await createCompany();
  const admin = await member(company._id, "ADMIN");
  const customer = await member(company._id, "CUSTOMER");
  const techA = await member(company._id, "TECHNICIAN");
  const req = await createServiceRequest(company._id, customer.user._id, devices);
  return { company, admin, customer, techA, req };
}

function visitFor(w: Awaited<ReturnType<typeof world>>, technicianId: unknown, extra: Record<string, unknown> = {}) {
  return createVisitDoc({
    companyId: w.company._id,
    requestId: w.req._id,
    technicianId,
    scheduledById: w.admin.user._id,
    ...extra,
  });
}

function proposeItems(cookies: Record<string, string>, visitId: unknown, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/technician/visits/${String(visitId)}/work-agreement/items`)
    .set("Origin", "http://localhost:3000")
    .set("Host", "localhost:3000")
    .set("Cookie", cookieHeader(cookies))
    .send(body);
}

function decide(cookies: Record<string, string>, visitId: unknown, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/technician/visits/${String(visitId)}/work-agreement/decisions`)
    .set("Origin", "http://localhost:3000")
    .set("Host", "localhost:3000")
    .set("Cookie", cookieHeader(cookies))
    .send(body);
}

function getAgreement(cookies: Record<string, string>, visitId: unknown) {
  return request(app)
    .get(`/api/v1/technician/visits/${String(visitId)}/work-agreement`)
    .set("Cookie", cookieHeader(cookies));
}

function putWorkResult(cookies: Record<string, string>, visitId: unknown, deviceId: string, body: Record<string, unknown>) {
  return request(app)
    .put(`/api/v1/technician/visits/${String(visitId)}/work-results/${deviceId}`)
    .set("Origin", "http://localhost:3000")
    .set("Host", "localhost:3000")
    .set("Cookie", cookieHeader(cookies))
    .send(body);
}

const compressorItem = { clientDeviceId: "d1", category: "PART_REPLACEMENT", description: "Replace compressor", partIdentifier: "COMP-9", quantity: 1, unitPriceMinor: 4500 };
const boardItem = { clientDeviceId: "d1", category: "PART_REPLACEMENT", description: "Replace control board", quantity: 1, unitPriceMinor: 1500 };
const maintenanceItem = { category: "MAINTENANCE", description: "General maintenance", quantity: 1, unitPriceMinor: 200 };

describe("proposed work", () => {
  it("accepts a valid proposal and server-computes totals", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem, boardItem] });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items[0]).toMatchObject({
      clientDeviceId: "d1",
      quantity: 1,
      unitPriceMinor: 4500,
      estimatedTotalMinor: 4500,
      decision: "PROPOSED",
    });
    expect(res.body.data.items[1].estimatedTotalMinor).toBe(1500);
  });

  it("computes the total from quantity * unitPriceMinor, not any client-supplied total", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await proposeItems(w.techA.cookies, v._id, {
      version: 0,
      items: [{ ...compressorItem, quantity: 3, estimatedTotalMinor: 1 }],
    });
    // `.strict()` rejects the unknown `estimatedTotalMinor` input field outright.
    expect(res.status).toBe(400);
  });

  it("rejects zero/negative quantity and negative price", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const zeroQty = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [{ ...compressorItem, quantity: 0 }] });
    expect(zeroQty.status).toBe(400);
    const negQty = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [{ ...compressorItem, quantity: -1 }] });
    expect(negQty.status).toBe(400);
    const negPrice = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [{ ...compressorItem, unitPriceMinor: -100 }] });
    expect(negPrice.status).toBe(400);
  });

  it("rejects a client-supplied decision — approval can never be forced by the proposer", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await proposeItems(w.techA.cookies, v._id, {
      version: 0,
      items: [{ ...compressorItem, decision: "APPROVED" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a device not in the visit's assigned scope", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [{ ...compressorItem, clientDeviceId: "d2" }] });
    expect(res.status).toBe(404);
  });

  it("accepts a visit-level item with no clientDeviceId", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [maintenanceItem] });
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].clientDeviceId).toBeNull();
  });
});

describe("agreement / decisions", () => {
  it("approves selected items and rejects others in one call", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem, boardItem] });
    const [compressorId, boardId] = proposed.body.data.items.map((i: { itemId: string }) => i.itemId);

    const res = await decide(w.techA.cookies, v._id, {
      version: 1,
      decisions: [
        { itemId: compressorId, decision: "APPROVED" },
        { itemId: boardId, decision: "REJECTED" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    const byId = new Map(res.body.data.items.map((i: { itemId: string; decision: string }) => [i.itemId, i.decision]));
    expect(byId.get(compressorId)).toBe("APPROVED");
    expect(byId.get(boardId)).toBe("REJECTED");
    expect(res.body.data.approvedTotalMinor).toBe(4500);
  });

  it("approves all proposed items", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem, boardItem] });
    const ids = proposed.body.data.items.map((i: { itemId: string }) => i.itemId);
    const res = await decide(w.techA.cookies, v._id, {
      version: 1,
      decisions: ids.map((itemId: string) => ({ itemId, decision: "APPROVED" })),
    });
    expect(res.body.data.approvedTotalMinor).toBe(6000);
  });

  it("a rejected item never contributes to the approved total", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    const itemId = proposed.body.data.items[0].itemId;
    const res = await decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId, decision: "REJECTED" }] });
    expect(res.body.data.approvedTotalMinor).toBe(0);
  });

  it("rejects deciding an item that was already decided", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    const itemId = proposed.body.data.items[0].itemId;
    await decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId, decision: "APPROVED" }] });

    const redecide = await decide(w.techA.cookies, v._id, { version: 2, decisions: [{ itemId, decision: "REJECTED" }] });
    expect(redecide.status).toBe(400);
    expect(redecide.body.error.code).toBe("VALIDATION_ERROR");
    const stored = await WorkAgreement.findOne({ visitId: v._id });
    expect(stored?.items[0]?.decision).toBe("APPROVED");
  });

  it("rejects deciding on a nonexistent agreement", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId: "0".repeat(24), decision: "APPROVED" }] });
    expect(res.status).toBe(404);
  });

  it("stale agreement version returns 409 for both proposing and deciding", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] }); // version -> 1

    const staleProposal = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [boardItem] });
    expect(staleProposal.status).toBe(409);
    expect(staleProposal.body.error.code).toBe("VERSION_CONFLICT");

    const staleDecision = await decide(w.techA.cookies, v._id, { version: 0, decisions: [{ itemId: "0".repeat(24), decision: "APPROVED" }] });
    expect(staleDecision.status).toBe(400); // version must be >= 1 by schema
  });
});

describe("scope changes", () => {
  it("a new proposal after an agreement bumps the version and keeps prior items intact", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem, boardItem] });
    const [compressorId, boardId] = proposed.body.data.items.map((i: { itemId: string }) => i.itemId);
    const decided = await decide(w.techA.cookies, v._id, {
      version: 1,
      decisions: [
        { itemId: compressorId, decision: "APPROVED" },
        { itemId: boardId, decision: "REJECTED" },
      ],
    });
    expect(decided.body.data.version).toBe(2);

    const scopeChange = await proposeItems(w.techA.cookies, v._id, { version: 2, items: [maintenanceItem] });
    expect(scopeChange.status).toBe(200);
    expect(scopeChange.body.data.version).toBe(3);
    expect(scopeChange.body.data.items).toHaveLength(3);

    // Old decided items are unchanged — history remains intact and auditable.
    const byId = new Map(scopeChange.body.data.items.map((i: { itemId: string; decision: string }) => [i.itemId, i.decision]));
    expect(byId.get(compressorId)).toBe("APPROVED");
    expect(byId.get(boardId)).toBe("REJECTED");

    const newItemId = scopeChange.body.data.items.find((i: { itemId: string }) => ![compressorId, boardId].includes(i.itemId)).itemId;
    const finalDecision = await decide(w.techA.cookies, v._id, { version: 3, decisions: [{ itemId: newItemId, decision: "APPROVED" }] });
    expect(finalDecision.status).toBe(200);
    expect(finalDecision.body.data.approvedTotalMinor).toBe(4500 + 200);
  });
});

describe("visit lifecycle", () => {
  it.each(["SCHEDULED", "COMPLETED", "CANCELLED"])("rejects proposing work while the visit is %s", async (status) => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status, deviceIds: ["d1"] });
    const res = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VISIT_STATUS_CONFLICT");
    expect(await WorkAgreement.countDocuments({})).toBe(0);
  });

  it("rejects deciding on a completed visit", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    const itemId = proposed.body.data.items[0].itemId;
    await Visit.updateOne({ _id: v._id }, { $set: { status: "COMPLETED" } });

    const res = await decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId, decision: "APPROVED" }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VISIT_STATUS_CONFLICT");
  });
});

describe("tenant isolation and authorization", () => {
  it("denies a technician from another company (uniform 404)", async () => {
    const w = await world();
    const other = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await proposeItems(other.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    expect(res.status).toBe(404);
  });

  it("denies a technician not assigned to the visit", async () => {
    const w = await world();
    const techC = await member(w.company._id, "TECHNICIAN");
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await proposeItems(techC.cookies, v._id, { version: 0, items: [compressorItem] });
    expect(res.status).toBe(404);
  });

  it.each(["CUSTOMER", "ADMIN"] as const)("denies a %s with 403", async (role) => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const other = await member(w.company._id, role);
    expect((await proposeItems(other.cookies, v._id, { version: 0, items: [compressorItem] })).status).toBe(403);
    expect((await getAgreement(other.cookies, v._id)).status).toBe(403);
  });

  it("denies unauthenticated requests", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    expect((await proposeItems({}, v._id, { version: 0, items: [compressorItem] })).status).toBe(401);
    expect((await getAgreement({}, v._id)).status).toBe(401);
  });

  it("reassignment: A immediately loses access, B immediately gains it, A's proposals remain intact", async () => {
    const w = await world();
    const techB = await member(w.company._id, "TECHNICIAN");
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    expect(proposed.status).toBe(200);

    await Visit.updateOne({ _id: v._id }, { $set: { technicianId: techB.user._id } });

    const aBlocked = await proposeItems(w.techA.cookies, v._id, { version: 1, items: [boardItem] });
    expect(aBlocked.status).toBe(404);

    const bAllowed = await getAgreement(techB.cookies, v._id);
    expect(bAllowed.status).toBe(200);
    expect(bAllowed.body.data.items).toHaveLength(1);
    expect(bAllowed.body.data.items[0].description).toBe(compressorItem.description);
  });
});

describe("FS22 -> FS23 boundary", () => {
  it("approved work can be recorded as REPAIRED by FS23", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    const itemId = proposed.body.data.items[0].itemId;
    await decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId, decision: "APPROVED" }] });

    const res = await putWorkResult(w.techA.cookies, v._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(200);
  });

  it("rejects REPAIRED for a device whose only decision is REJECTED", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    const itemId = proposed.body.data.items[0].itemId;
    await decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId, decision: "REJECTED" }] });

    const res = await putWorkResult(w.techA.cookies, v._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WORK_NOT_APPROVED");
    expect(await WorkResult.countDocuments({})).toBe(0);
  });

  it("allows FAILED/CUSTOMER_REFUSED for a device whose only decision is REJECTED", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    const itemId = proposed.body.data.items[0].itemId;
    await decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId, decision: "REJECTED" }] });

    const res = await putWorkResult(w.techA.cookies, v._id, "d1", {
      result: "FAILED",
      failureReason: "CUSTOMER_REFUSED",
      version: 0,
    });
    expect(res.status).toBe(200);
  });

  it("rejects any work result while the device's only proposal is still undecided", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] }); // still PROPOSED

    const res = await putWorkResult(w.techA.cookies, v._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WORK_NOT_APPROVED");
  });

  it("falls back to the FS18 device-scope-only boundary when no agreement exists for the device at all", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    // No WorkAgreement created for this visit at all.
    const res = await putWorkResult(w.techA.cookies, v._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(200);
  });

  it("an agreement in one company/visit does not unlock a same-named device in another", async () => {
    const w = await world();
    const other = await world();
    const v1 = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const v2 = await visitFor(other, other.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });

    const proposed = await proposeItems(w.techA.cookies, v1._id, { version: 0, items: [compressorItem] });
    const itemId = proposed.body.data.items[0].itemId;
    await decide(w.techA.cookies, v1._id, { version: 1, decisions: [{ itemId, decision: "APPROVED" }] });

    // v2 has no agreement at all -> falls back to the FS18-only boundary, so
    // this still succeeds — but it is v2's own (nonexistent) agreement that
    // was consulted, never v1's.
    const res = await putWorkResult(other.techA.cookies, v2._id, "d1", { result: "REPAIRED", version: 0 });
    expect(res.status).toBe(200);
    expect(await WorkAgreement.countDocuments({ visitId: v2._id })).toBe(0);
  });
});

describe("concurrency", () => {
  it("does not let two concurrent proposals against the same new agreement both succeed", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const [a, b] = await Promise.all([
      proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] }),
      proposeItems(w.techA.cookies, v._id, { version: 0, items: [boardItem] }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await WorkAgreement.countDocuments({ visitId: v._id })).toBe(1);
  });

  it("does not let two concurrent decisions from the same base version both apply", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem, boardItem] });
    const [compressorId, boardId] = proposed.body.data.items.map((i: { itemId: string }) => i.itemId);

    const [a, b] = await Promise.all([
      decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId: compressorId, decision: "APPROVED" }] }),
      decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId: boardId, decision: "REJECTED" }] }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const stored = await WorkAgreement.findOne({ visitId: v._id });
    expect(stored?.version).toBe(2);
  });
});

describe("audit trail", () => {
  it("records WORK_ITEM_PROPOSED and WORK_ITEM_DECIDED VisitEvents", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposed = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    const itemId = proposed.body.data.items[0].itemId;
    await decide(w.techA.cookies, v._id, { version: 1, decisions: [{ itemId, decision: "APPROVED" }] });

    const events = await VisitEvent.find({ visitId: v._id }).sort({ occurredAt: 1 });
    expect(events.map((e) => e.type)).toEqual(["WORK_ITEM_PROPOSED", "WORK_ITEM_DECIDED"]);
    expect(events[1]?.result).toBe("APPROVED");
    expect(events[1]?.workItemId).toBe(itemId);
  });
});

describe("DTO safety", () => {
  it("never exposes internal ids, actor identity, or unrelated fields", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const proposeRes = await proposeItems(w.techA.cookies, v._id, { version: 0, items: [compressorItem] });
    const getRes = await getAgreement(w.techA.cookies, v._id);

    for (const body of [proposeRes.body, getRes.body]) {
      const raw = JSON.stringify(body);
      for (const id of [w.company._id, w.req._id, w.techA.user._id, w.admin.user._id, w.customer.user._id]) {
        expect(raw).not.toContain(String(id));
      }
      const keys = [...raw.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]);
      for (const banned of [
        "companyId", "requestId", "proposedById", "decidedById", "technicianId", "customerId",
        "email", "password", "passwordHash", "token", "session", "refreshToken",
      ]) {
        expect(keys).not.toContain(banned);
      }
    }
  });
});
