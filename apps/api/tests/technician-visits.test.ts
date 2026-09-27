import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import { Invoice } from "../src/modules/billing/invoice.model.js";
import { User } from "../src/modules/users/user.model.js";
import { VisitEvent } from "../src/modules/visits/visit-event.model.js";
import { Visit } from "../src/modules/visits/visit.model.js";
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

async function member(companyId: unknown, role: "ADMIN" | "TECHNICIAN" | "CUSTOMER", name?: string) {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await createUser(companyId, { email, role, name });
  const cookies = await loginAs(app, email);
  return { user, email, cookies };
}

/** One company with an admin, a customer, technician A and a request owned by that customer. */
async function world(devices?: TestRequestDevice[]) {
  const company = await createCompany();
  const admin = await member(company._id, "ADMIN");
  const customer = await member(company._id, "CUSTOMER", "Jane Customer");
  const techA = await member(company._id, "TECHNICIAN");
  const req = await createServiceRequest(company._id, customer.user._id, devices);
  return { company, admin, customer, techA, req };
}

function visitFor(w: Awaited<ReturnType<typeof world>>, technicianId: unknown, extra = {}) {
  return createVisitDoc({
    companyId: w.company._id,
    requestId: w.req._id,
    technicianId,
    scheduledById: w.admin.user._id,
    ...extra,
  });
}

function list(cookies: Record<string, string>, query: Record<string, string> = {}) {
  return request(app).get("/api/v1/technician/visits").query(query).set("Cookie", cookieHeader(cookies));
}

function detail(cookies: Record<string, string>, id: unknown) {
  return request(app).get(`/api/v1/technician/visits/${String(id)}`).set("Cookie", cookieHeader(cookies));
}

const day = (h: number) => new Date(Date.UTC(2030, 0, 15, h));

describe("authentication and role", () => {
  it("denies unauthenticated requests on both endpoints", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id);
    expect((await request(app).get("/api/v1/technician/visits")).status).toBe(401);
    expect((await request(app).get(`/api/v1/technician/visits/${v._id}`)).status).toBe(401);
  });

  it.each(["CUSTOMER", "ADMIN"] as const)("denies a %s with 403", async (role) => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id);
    const other = await member(w.company._id, role);
    expect((await list(other.cookies)).status).toBe(403);
    const res = await detail(other.cookies, v._id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("allows a TECHNICIAN", async () => {
    const w = await world();
    expect((await list(w.techA.cookies)).status).toBe(200);
  });
});

describe("list isolation and filters", () => {
  it("returns only the caller's own visits", async () => {
    const w = await world();
    const techB = await member(w.company._id, "TECHNICIAN");
    const mine = await visitFor(w, w.techA.user._id, { startAt: day(9) });
    await visitFor(w, techB.user._id, { startAt: day(12), deviceIds: ["d1"] });

    const res = await list(w.techA.cookies);
    expect(res.status).toBe(200);
    expect(res.body.data.map((v: { id: string }) => v.id)).toEqual([String(mine._id)]);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
  });

  it("never returns another company's visits", async () => {
    const w = await world();
    const other = await world();
    await visitFor(other, other.techA.user._id);
    const res = await list(w.techA.cookies);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it("rejects a client-supplied technicianId/companyId (cannot influence scope)", async () => {
    const w = await world();
    const techB = await member(w.company._id, "TECHNICIAN");
    await visitFor(w, techB.user._id);
    const injected: Array<Record<string, string>> = [
      { technicianId: String(techB.user._id) },
      { companyId: String(w.company._id) },
    ];
    for (const query of injected) {
      const res = await list(w.techA.cookies, query);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(res.body)).not.toContain(String(techB.user._id));
    }
  });

  it("filters by status", async () => {
    const w = await world();
    await visitFor(w, w.techA.user._id, { startAt: day(9), status: "SCHEDULED" });
    await visitFor(w, w.techA.user._id, { startAt: day(11), status: "COMPLETED" });
    await visitFor(w, w.techA.user._id, { startAt: day(13), status: "CANCELLED" });

    expect((await list(w.techA.cookies)).body.meta.total).toBe(3);
    const done = await list(w.techA.cookies, { status: "COMPLETED" });
    expect(done.body.data).toHaveLength(1);
    expect(done.body.data[0].status).toBe("COMPLETED");
    expect((await list(w.techA.cookies, { status: "BOGUS" })).status).toBe(400);
  });

  it("filters by date range using half-open overlap, with offset timestamps", async () => {
    const w = await world();
    await visitFor(w, w.techA.user._id, { startAt: day(10), endAt: day(11) });
    await visitFor(w, w.techA.user._id, { startAt: day(12), endAt: day(13) });
    await visitFor(w, w.techA.user._id, { startAt: day(14), endAt: day(15) });
    const starts = (res: request.Response) => res.body.data.map((v: { startAt: string }) => v.startAt.slice(11, 13));

    // 14:30+03:00 == 11:30Z: the 10-11 visit has ended, 12-13 and 14-15 remain.
    expect(starts(await list(w.techA.cookies, { from: "2030-01-15T14:30:00+03:00" }))).toEqual(["12", "14"]);
    // A visit ending exactly at `from` is not in the window.
    expect(starts(await list(w.techA.cookies, { from: "2030-01-15T11:00:00Z" }))).toEqual(["12", "14"]);
    // A visit starting exactly at `to` is not in the window.
    expect(starts(await list(w.techA.cookies, { to: "2030-01-15T12:00:00Z" }))).toEqual(["10"]);
    expect(
      starts(await list(w.techA.cookies, { from: "2030-01-15T11:30:00Z", to: "2030-01-15T13:30:00Z" }))
    ).toEqual(["12"]);
  });

  it.each([
    ["offset-less from", { from: "2030-01-15T10:00:00" }],
    ["to before from", { from: "2030-01-16T00:00:00Z", to: "2030-01-15T00:00:00Z" }],
    ["pageSize over the cap", { pageSize: "101" }],
    ["page 0", { page: "0" }],
  ])("rejects %s", async (_l, query) => {
    const w = await world();
    const res = await list(w.techA.cookies, query);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("paginates in a deterministic time order with meta", async () => {
    const w = await world();
    for (const h of [9, 10, 11, 12, 13]) {
      await visitFor(w, w.techA.user._id, { startAt: day(h) });
    }
    const p2 = await list(w.techA.cookies, { page: "2", pageSize: "2" });
    expect(p2.body.meta).toEqual({ page: 2, pageSize: 2, total: 5 });
    expect(p2.body.data.map((v: { startAt: string }) => v.startAt.slice(11, 13))).toEqual(["11", "12"]);
    const p3 = await list(w.techA.cookies, { page: "3", pageSize: "2" });
    expect(p3.body.data).toHaveLength(1);
  });

  it("has an index serving the no-status technician query", async () => {
    await Visit.init();
    const keys = (await Visit.collection.indexes()).map((i) => Object.keys(i.key).join(","));
    expect(keys).toContain("companyId,technicianId,startAt");
  });
});

describe("detail isolation", () => {
  it("returns an assigned visit", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { workTypes: ["INSPECTION", "REPAIR"] });
    const res = await detail(w.techA.cookies, v._id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: String(v._id),
      status: "SCHEDULED",
      startAt: "2030-01-15T10:00:00.000Z",
      workTypes: ["INSPECTION", "REPAIR"],
      customer: { name: "Jane Customer", phone: "+15550001111" },
      address: "1 Main St",
      allowedActions: ["START_VISIT"],
    });
  });

  it("gives the identical 404 for unassigned, cross-company, nonexistent and malformed ids", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id);
    const techC = await member(w.company._id, "TECHNICIAN");
    const foreign = await world();

    const responses = [
      await detail(techC.cookies, v._id),
      await detail(foreign.techA.cookies, v._id),
      await detail(w.techA.cookies, "a".repeat(24)),
      await detail(w.techA.cookies, "not-an-id"),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(res.body.error.message).toBe("Visit not found");
    }
  });

  it("narrows devices to the visit's deviceIds and hides the rest of the request", async () => {
    const w = await world([
      { clientDeviceId: "d1", label: "Fridge", originalDescription: "fridge SECRET-ONE" },
      { clientDeviceId: "d2", label: "Washer", originalDescription: "washer SECRET-TWO" },
      { clientDeviceId: "d3", label: "Dryer", originalDescription: "dryer SECRET-THREE" },
    ]);
    const v = await visitFor(w, w.techA.user._id, { deviceIds: ["d3", "d1"] });

    const res = await detail(w.techA.cookies, v._id);
    expect(res.body.data.devices.map((d: { clientDeviceId: string }) => d.clientDeviceId)).toEqual(["d3", "d1"]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("SECRET-TWO");
    expect(raw).not.toContain("Washer");
  });

  it("does not leak another request of the same customer", async () => {
    const w = await world();
    await createServiceRequest(w.company._id, w.customer.user._id, [
      { clientDeviceId: "z9", label: "OtherRequestDevice", originalDescription: "OTHER-REQUEST-TEXT" },
    ]);
    const v = await visitFor(w, w.techA.user._id);
    const raw = JSON.stringify((await detail(w.techA.cookies, v._id)).body);
    expect(raw).not.toContain("OTHER-REQUEST-TEXT");
    expect(raw).not.toContain("OtherRequestDevice");
  });
});

describe("reassignment (simulated: no reassignment endpoint exists)", () => {
  it("removes A's access and grants B's immediately, regardless of historical events", async () => {
    const w = await world();
    const techB = await member(w.company._id, "TECHNICIAN");
    const v = await visitFor(w, w.techA.user._id);
    // History says A was assigned. It must never be used as authorization.
    await VisitEvent.create({
      companyId: w.company._id,
      visitId: v._id,
      requestId: w.req._id,
      type: "TECHNICIAN_ASSIGNED",
      actorId: w.admin.user._id,
      technicianId: w.techA.user._id,
      occurredAt: new Date(),
    });

    expect((await detail(w.techA.cookies, v._id)).status).toBe(200);
    expect((await detail(techB.cookies, v._id)).status).toBe(404);

    await Visit.updateOne({ _id: v._id }, { $set: { technicianId: techB.user._id } });

    expect((await detail(w.techA.cookies, v._id)).status).toBe(404);
    expect((await detail(techB.cookies, v._id)).status).toBe(200);
    expect((await list(w.techA.cookies)).body.data).toEqual([]);
    expect((await list(techB.cookies)).body.data).toHaveLength(1);
  });
});

describe("account and session state", () => {
  it("denies a technician who has been deactivated", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id);
    expect((await detail(w.techA.cookies, v._id)).status).toBe(200);
    await User.updateOne({ _id: w.techA.user._id }, { $set: { isActive: false } });
    expect((await detail(w.techA.cookies, v._id)).status).toBe(401);
    expect((await list(w.techA.cookies)).status).toBe(401);
    const stored = await Visit.findById(v._id);
    expect(String(stored?.technicianId)).toBe(String(w.techA.user._id));
  });

  it("denies a revoked session", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id);
    await Session.updateMany({}, { $set: { revokedAt: new Date(), revokedReason: "manual" } });
    const res = await detail(w.techA.cookies, v._id);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("denies a user whose role is no longer TECHNICIAN on the next request", async () => {
    const w = await world();
    await visitFor(w, w.techA.user._id);
    await User.updateOne({ _id: w.techA.user._id }, { $set: { role: "CUSTOMER" } });
    expect((await list(w.techA.cookies)).status).toBe(403);
  });
});

describe("DTO safety and AI analysis", () => {
  const analysis = {
    summary: "Compressor likely failing",
    possibleCauses: ["Capacitor", "Compressor"],
    missingInformation: ["Model age"],
    inspectionQuestions: ["Is it humming?"],
  };

  it("returns original descriptions and analysis, keeps null analysis null, and hides provider metadata", async () => {
    const w = await world([
      { clientDeviceId: "d1", label: "Fridge", brand: "Acme", model: "X1", originalDescription: "  not cooling  ", analysis },
      { clientDeviceId: "d2", label: "Washer", originalDescription: "won't spin", analysis: null },
    ]);
    const v = await visitFor(w, w.techA.user._id, { deviceIds: ["d1", "d2"] });

    const res = await detail(w.techA.cookies, v._id);
    const [d1, d2] = res.body.data.devices;
    expect(d1).toEqual({
      clientDeviceId: "d1",
      label: "Fridge",
      brand: "Acme",
      model: "X1",
      originalDescription: "  not cooling  ",
      analysis,
      analysisStatus: "SUCCESS",
    });
    expect(d2.analysis).toBeNull();
    expect(d2.analysisStatus).toBe("UNAVAILABLE");
    expect(d2.originalDescription).toBe("won't spin");

    const raw = JSON.stringify(res.body);
    for (const forbidden of ["internal-model-name", "v-internal", "GEMINI_TIMEOUT", "analysisMetadata", "processedAt"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("never exposes identifiers, customer email, financial, lock or idempotency data (list or detail)", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id);
    const bodies = [(await list(w.techA.cookies)).body, (await detail(w.techA.cookies, v._id)).body];

    for (const body of bodies) {
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(w.customer.email);
      for (const id of [w.company._id, w.customer.user._id, w.techA.user._id, w.admin.user._id, w.req._id]) {
        expect(raw).not.toContain(String(id));
      }
      const keys = [...raw.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]);
      for (const banned of [
        "email", "customerId", "companyId", "technicianId", "scheduledById", "requestId",
        "analysisMetadata", "promptVersion", "errorCode", "price", "quote", "quoteTotal", "totalPrice", "amount",
        "payment", "invoice", "version", "fingerprint", "idempotencyKey",
      ]) {
        expect(keys).not.toContain(banned);
      }
    }
  });

  it.each([
    ["SCHEDULED", ["START_VISIT"]],
    ["IN_PROGRESS", ["SELECT_PARTS", "RECORD_WORK_RESULT", "COMPLETE_VISIT"]],
    ["COMPLETED", ["ISSUE_INVOICE"]],
    ["CANCELLED", []],
  ] as const)("derives allowedActions for a %s visit", async (status, expected) => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status });
    expect((await list(w.techA.cookies)).body.data[0].allowedActions).toEqual(expected);
    expect((await detail(w.techA.cookies, v._id)).body.data.allowedActions).toEqual(expected);
  });

  it("drops ISSUE_INVOICE once the visit's invoice exists", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "COMPLETED" });
    await Invoice.create({
      companyId: w.company._id,
      visitId: v._id,
      requestId: w.req._id,
      customerId: w.customer.user._id,
      issuedById: w.techA.user._id,
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
    expect((await list(w.techA.cookies)).body.data[0].allowedActions).toEqual([]);
    expect((await detail(w.techA.cookies, v._id)).body.data.allowedActions).toEqual([]);
  });
});

// Photo/evidence access is not covered: photo attachments (FS12/FS13) were
// cancelled for the MVP, so no photo model or endpoint exists.
