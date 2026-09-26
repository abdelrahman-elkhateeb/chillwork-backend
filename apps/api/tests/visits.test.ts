import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Company } from "../src/modules/companies/company.model.js";
import { ServiceRequest } from "../src/modules/requests/request.model.js";
import { ScheduleLock } from "../src/modules/visits/schedule-lock.model.js";
import { VisitEvent } from "../src/modules/visits/visit-event.model.js";
import { Visit } from "../src/modules/visits/visit.model.js";
import type { UserRole } from "../src/modules/users/user.model.js";
import { cookieHeader, createCompany, createUser, parseSetCookies, PASSWORD, sameOriginRequest } from "./helpers.js";

const app = createApp();

async function loginAs(email: string) {
  const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password: PASSWORD });
  return parseSetCookies(res);
}

async function setupAdmin(overrides: { timezone?: string } = {}) {
  const company = await createCompany(overrides);
  const email = `admin-${randomUUID()}@example.com`;
  const admin = await createUser(company._id, { email, role: "ADMIN" });
  const cookies = await loginAs(email);
  return { company, admin, cookies };
}

async function makeUser(companyId: unknown, role: UserRole, isActive = true) {
  return createUser(companyId, { email: `${role.toLowerCase()}-${randomUUID()}@example.com`, role, isActive });
}

async function makeRequest(companyId: unknown, customerId: unknown, deviceIds = ["d1", "d2", "d3"]) {
  return ServiceRequest.create({
    companyId,
    customerId,
    reference: `SR-${randomUUID().slice(0, 8)}`,
    status: "SUBMITTED",
    address: "1 Main St",
    contactPhone: "+15550001111",
    devices: deviceIds.map((clientDeviceId) => ({
      clientDeviceId,
      label: clientDeviceId,
      originalDescription: "broken",
      analysisMetadata: { status: "UNAVAILABLE", model: "m", promptVersion: "v1", processedAt: new Date() },
    })),
  });
}

/** Everything a booking test needs: an admin, a technician, a customer and a request, all in one company. */
async function setup(overrides: { timezone?: string; deviceIds?: string[] } = {}) {
  const ctx = await setupAdmin(overrides);
  const technician = await makeUser(ctx.company._id, "TECHNICIAN");
  const customer = await makeUser(ctx.company._id, "CUSTOMER");
  const req = await makeRequest(ctx.company._id, customer._id, overrides.deviceIds);
  return { ...ctx, technician, customer, req };
}

const T = (hhmm: string) => `2030-01-15T${hhmm}:00Z`;

function book(cookies: Record<string, string>, requestId: unknown, body: Record<string, unknown>) {
  return sameOriginRequest(app, "post", `/api/v1/admin/requests/${String(requestId)}/visits`)
    .set("Cookie", cookieHeader(cookies))
    .send(body);
}

function visitBody(technicianId: unknown, start: string, end: string, deviceIds = ["d1"], extra = {}) {
  return { technicianId: String(technicianId), startAt: start, endAt: end, deviceIds, ...extra };
}

function availability(cookies: Record<string, string>, technicianId: unknown, from: string, to: string) {
  return request(app)
    .get(`/api/v1/admin/technicians/${String(technicianId)}/availability`)
    .query({ from, to })
    .set("Cookie", cookieHeader(cookies));
}

describe("authorization", () => {
  it("rejects unauthenticated requests", async () => {
    const { req, technician } = await setup();
    const res = await sameOriginRequest(app, "post", `/api/v1/admin/requests/${req._id}/visits`).send(
      visitBody(technician._id, T("10:00"), T("11:00"))
    );
    expect(res.status).toBe(401);
    const av = await request(app).get(`/api/v1/admin/technicians/${technician._id}/availability`);
    expect(av.status).toBe(401);
  });

  it.each(["CUSTOMER", "TECHNICIAN"] as const)("rejects a %s on both endpoints", async (role) => {
    const { company, req, technician } = await setup();
    const email = `${role}-${randomUUID()}@example.com`;
    await createUser(company._id, { email, role });
    const cookies = await loginAs(email);

    const create = await book(cookies, req._id, visitBody(technician._id, T("10:00"), T("11:00")));
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe("FORBIDDEN");
    const av = await availability(cookies, technician._id, T("00:00"), T("23:00"));
    expect(av.status).toBe(403);
    expect(await Visit.countDocuments({})).toBe(0);
  });

  it("keeps CSRF/origin protection on the POST route", async () => {
    const { cookies, req, technician } = await setup();
    const res = await request(app)
      .post(`/api/v1/admin/requests/${req._id}/visits`)
      .set("Cookie", cookieHeader(cookies))
      .send(visitBody(technician._id, T("10:00"), T("11:00")));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_ORIGIN_REJECTED");
  });
});

describe("creating a visit", () => {
  it("creates ONE visit covering several devices, and records events", async () => {
    const { cookies, req, technician, admin, company } = await setup();
    const res = await book(cookies, req._id, visitBody(technician._id, T("10:00"), T("11:00"), ["d1", "d2", "d3"]));

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      requestId: String(req._id),
      technicianId: String(technician._id),
      deviceIds: ["d1", "d2", "d3"],
      status: "SCHEDULED",
      startAt: "2030-01-15T10:00:00.000Z",
      endAt: "2030-01-15T11:00:00.000Z",
    });
    expect(await Visit.countDocuments({})).toBe(1);

    const events = await VisitEvent.find({}).sort({ _id: 1 });
    expect(events.map((e) => e.type).sort()).toEqual(["TECHNICIAN_ASSIGNED", "VISIT_SCHEDULED"]);
    expect(String(events[0]?.actorId)).toBe(String(admin._id));
    expect(String(events[0]?.companyId)).toBe(String(company._id));
  });

  it("supports inspection plus repair in the same visit, defaulting to inspection", async () => {
    const { cookies, req, technician } = await setup();
    const both = await book(cookies, req._id, visitBody(technician._id, T("10:00"), T("11:00"), ["d1"], { workTypes: ["INSPECTION", "REPAIR"] }));
    expect(both.status).toBe(201);
    expect(both.body.data.workTypes).toEqual(["INSPECTION", "REPAIR"]);

    const plain = await book(cookies, req._id, visitBody(technician._id, T("12:00"), T("13:00"), ["d2"]));
    expect(plain.body.data.workTypes).toEqual(["INSPECTION"]);
    expect(await Visit.countDocuments({})).toBe(2);
  });

  it("persists an offset timestamp as the same UTC instant and snapshots the company timezone", async () => {
    const { cookies, req, technician } = await setup({ timezone: "Africa/Cairo" });
    const res = await book(cookies, req._id, visitBody(technician._id, "2030-01-15T10:00:00+03:00", "2030-01-15T11:00:00+03:00"));

    expect(res.status).toBe(201);
    expect(res.body.data.startAt).toBe("2030-01-15T07:00:00.000Z");
    expect(res.body.data.timezone).toBe("Africa/Cairo");
    const stored = await Visit.findOne({});
    expect(stored?.startAt.toISOString()).toBe("2030-01-15T07:00:00.000Z");
  });

  it("rejects an offset-less (ambiguous) timestamp instead of guessing", async () => {
    const { cookies, req, technician } = await setup();
    const res = await book(cookies, req._id, visitBody(technician._id, "2030-01-15T10:00:00", "2030-01-15T11:00:00"));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("company timezone is validated and defaults to UTC", async () => {
    const plain = await createCompany();
    expect(plain.timezone).toBe("UTC");
    await expect(Company.create({ name: "x", timezone: "Not/AZone" })).rejects.toThrow();
  });
});

describe("validation", () => {
  it.each([
    ["start equals end", T("10:00"), T("10:00")],
    ["end before start", T("11:00"), T("10:00")],
    ["shorter than the minimum", T("10:00"), T("10:05")],
    ["longer than the maximum", T("08:00"), T("20:00")],
  ])("rejects a visit where %s", async (_l, start, end) => {
    const { cookies, req, technician } = await setup();
    const res = await book(cookies, req._id, visitBody(technician._id, start, end));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await Visit.countDocuments({})).toBe(0);
  });

  it.each([
    ["no devices", []],
    ["duplicate devices", ["d1", "d1"]],
    ["too many devices", Array.from({ length: 11 }, (_, i) => `x${i}`)],
  ])("rejects %s", async (_l, deviceIds) => {
    const { cookies, req, technician } = await setup();
    const res = await book(cookies, req._id, visitBody(technician._id, T("10:00"), T("11:00"), deviceIds as string[]));
    expect(res.status).toBe(400);
  });

  it("rejects devices that are not on the request", async () => {
    const { cookies, req, technician } = await setup();
    const res = await book(cookies, req._id, visitBody(technician._id, T("10:00"), T("11:00"), ["d1", "nope"]));
    expect(res.status).toBe(400);
    expect(res.body.error.fieldErrors.deviceIds).toBeDefined();
  });

  it("rejects a malformed technicianId, and 404s a malformed request id", async () => {
    const { cookies, req } = await setup();
    expect((await book(cookies, req._id, visitBody("not-an-id", T("10:00"), T("11:00")))).status).toBe(400);
    const bad = await sameOriginRequest(app, "post", "/api/v1/admin/requests/not-an-id/visits")
      .set("Cookie", cookieHeader(cookies))
      .send(visitBody("a".repeat(24), T("10:00"), T("11:00")));
    expect(bad.status).toBe(404);
  });
});

describe("company scope and technician/request eligibility", () => {
  it("does not let an admin schedule another company's request (404, nothing created)", async () => {
    const mine = await setup();
    const other = await setup();
    const res = await book(mine.cookies, other.req._id, visitBody(mine.technician._id, T("10:00"), T("11:00")));
    expect(res.status).toBe(404);
    expect(await Visit.countDocuments({})).toBe(0);
  });

  it("gives the same answer for a foreign, inactive, non-technician and unknown technician", async () => {
    const ctx = await setup();
    const other = await setup();
    const inactive = await makeUser(ctx.company._id, "TECHNICIAN", false);
    const notTech = await makeUser(ctx.company._id, "CUSTOMER");
    const bodies = [other.technician._id, inactive._id, notTech._id, ctx.admin._id, "b".repeat(24)];

    for (const id of bodies) {
      const res = await book(ctx.cookies, ctx.req._id, visitBody(id, T("10:00"), T("11:00")));
      expect(res.status).toBe(400);
      expect(res.body.error.fieldErrors.technicianId).toEqual(["Technician is not available for assignment"]);
    }
    expect(await Visit.countDocuments({})).toBe(0);
  });

  it("ignores a client-supplied companyId", async () => {
    const { cookies, req, technician, company } = await setup();
    const res = await book(cookies, req._id, visitBody(technician._id, T("10:00"), T("11:00"), ["d1"], { companyId: "c".repeat(24) }));
    expect(res.status).toBe(201);
    expect(String((await Visit.findOne({}))?.companyId)).toBe(String(company._id));
  });

  it("rejects a request that is not in a schedulable state", async () => {
    const { cookies, req, technician } = await setup();
    await ServiceRequest.collection.updateOne({ _id: req._id }, { $set: { status: "CANCELLED" } });
    const res = await book(cookies, req._id, visitBody(technician._id, T("10:00"), T("11:00")));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REQUEST_NOT_SCHEDULABLE");
  });
});

describe("overlap semantics", () => {
  async function bookedTech() {
    const ctx = await setup();
    const first = await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("10:00"), T("11:00"), ["d1"]));
    expect(first.status).toBe(201);
    return ctx;
  }

  it("allows back-to-back visits ([start,end) is half-open)", async () => {
    const ctx = await bookedTech();
    const res = await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("11:00"), T("12:00"), ["d2"]));
    expect(res.status).toBe(201);
    const before = await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("09:00"), T("10:00"), ["d3"]));
    expect(before.status).toBe(201);
  });

  it.each([
    ["starts inside", "10:59", "12:00"],
    ["ends inside", "09:30", "10:15"],
    ["contains it", "09:00", "12:00"],
    ["is contained by it", "10:15", "10:45"],
    ["is identical", "10:00", "11:00"],
  ])("rejects a visit that %s an existing one with SCHEDULE_CONFLICT", async (_l, s, e) => {
    const ctx = await bookedTech();
    const res = await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T(s), T(e), ["d2"]));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "SCHEDULE_CONFLICT", requestId: expect.any(String) });
    expect(await Visit.countDocuments({})).toBe(1);
  });

  it("does not block a different technician at the same time", async () => {
    const ctx = await bookedTech();
    const other = await makeUser(ctx.company._id, "TECHNICIAN");
    const res = await book(ctx.cookies, ctx.req._id, visitBody(other._id, T("10:00"), T("11:00"), ["d2"]));
    expect(res.status).toBe(201);
  });

  it("does not let a cancelled visit block a new booking", async () => {
    const ctx = await bookedTech();
    await Visit.updateMany({}, { $set: { status: "CANCELLED" } });
    const res = await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("10:00"), T("11:00"), ["d1"]));
    expect(res.status).toBe(201);
  });

  it("refuses to put one device in two active visits", async () => {
    const ctx = await bookedTech();
    const other = await makeUser(ctx.company._id, "TECHNICIAN");
    const res = await book(ctx.cookies, ctx.req._id, visitBody(other._id, T("14:00"), T("15:00"), ["d1", "d2"]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEVICE_ALREADY_SCHEDULED");
  });
});

describe("concurrency (the point of FS18)", () => {
  it("lets exactly one of many concurrent overlapping bookings for one technician succeed", async () => {
    const ctx = await setup({ deviceIds: ["a", "b", "c", "d", "e", "f"] });
    const starts = ["10:00", "10:10", "10:20", "10:30", "10:40", "10:50"];

    const responses = await Promise.all(
      starts.map((s, i) =>
        book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T(s), `2030-01-15T${String(11 + (i % 2)).padStart(2, "0")}:30:00Z`, [["a", "b", "c", "d", "e", "f"][i]!]))
      )
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(starts.length - 1);
    for (const r of responses.filter((x) => x.status === 409)) {
      expect(r.body.error.code).toBe("SCHEDULE_CONFLICT");
    }
    expect(await Visit.countDocuments({ technicianId: ctx.technician._id })).toBe(1);
    expect(await VisitEvent.countDocuments({})).toBe(2);
  });

  it("lets every concurrent NON-overlapping booking through (lost races are retried, not failed)", async () => {
    const ctx = await setup({ deviceIds: ["a", "b", "c", "d"] });
    const slots = [["09:00", "10:00"], ["10:00", "11:00"], ["11:00", "12:00"], ["12:00", "13:00"]];

    const responses = await Promise.all(
      slots.map(([s, e], i) => book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T(s!), T(e!), [["a", "b", "c", "d"][i]!])))
    );

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(await Visit.countDocuments({})).toBe(4);
  });

  it("does not double-book one request's device across two different technicians concurrently", async () => {
    const ctx = await setup();
    const other = await makeUser(ctx.company._id, "TECHNICIAN");

    const responses = await Promise.all([
      book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("10:00"), T("11:00"), ["d1"])),
      book(ctx.cookies, ctx.req._id, visitBody(other._id, T("10:00"), T("11:00"), ["d1"])),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await Visit.countDocuments({})).toBe(1);
  });

  it("uses lock documents as the serialization point", async () => {
    const ctx = await setup();
    await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("10:00"), T("11:00")));
    const locks = await ScheduleLock.find({});
    expect(locks.map((l) => l.key).sort()).toEqual([`request:${ctx.req._id}`, `technician:${ctx.technician._id}`].sort());
    expect(locks.every((l) => l.version >= 1)).toBe(true);
  });
});

describe("availability", () => {
  it("returns busy intervals in UTC, excluding cancelled visits and out-of-window ones", async () => {
    const ctx = await setup({ timezone: "Africa/Cairo" });
    await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("10:00"), T("11:00"), ["d1"]));
    await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("13:00"), T("14:00"), ["d2"]));
    await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, "2030-02-20T10:00:00Z", "2030-02-20T11:00:00Z", ["d3"]));
    await Visit.updateOne({ startAt: new Date(T("13:00")) }, { $set: { status: "CANCELLED" } });

    const res = await availability(ctx.cookies, ctx.technician._id, T("00:00"), "2030-01-16T00:00:00Z");
    expect(res.status).toBe(200);
    expect(res.body.data.timezone).toBe("Africa/Cairo");
    expect(res.body.data.busy).toHaveLength(1);
    expect(res.body.data.busy[0]).toMatchObject({ startAt: "2030-01-15T10:00:00.000Z", endAt: "2030-01-15T11:00:00.000Z" });
  });

  it("shows only times, never customer/request/device data", async () => {
    const ctx = await setup();
    await book(ctx.cookies, ctx.req._id, visitBody(ctx.technician._id, T("10:00"), T("11:00")));
    const res = await availability(ctx.cookies, ctx.technician._id, T("00:00"), "2030-01-16T00:00:00Z");
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/address|contactPhone|customer|deviceIds|requestId|1 Main St/i);
  });

  it("treats a foreign, inactive or non-technician id as 404 (no cross-company reveal)", async () => {
    const ctx = await setup();
    const other = await setup();
    await book(other.cookies, other.req._id, visitBody(other.technician._id, T("10:00"), T("11:00")));
    const inactive = await makeUser(ctx.company._id, "TECHNICIAN", false);

    for (const id of [other.technician._id, inactive._id, ctx.admin._id, "d".repeat(24)]) {
      const res = await availability(ctx.cookies, id, T("00:00"), "2030-01-16T00:00:00Z");
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("2030-01-15T10:00");
    }
  });

  it.each([
    ["missing params", {}],
    ["offset-less", { from: "2030-01-15T00:00:00", to: "2030-01-16T00:00:00" }],
    ["to before from", { from: "2030-01-16T00:00:00Z", to: "2030-01-15T00:00:00Z" }],
    ["to equals from", { from: "2030-01-15T00:00:00Z", to: "2030-01-15T00:00:00Z" }],
    ["window too large", { from: "2030-01-01T00:00:00Z", to: "2030-06-01T00:00:00Z" }],
  ])("rejects %s", async (_l, query) => {
    const ctx = await setup();
    const res = await request(app)
      .get(`/api/v1/admin/technicians/${ctx.technician._id}/availability`)
      .query(query)
      .set("Cookie", cookieHeader(ctx.cookies));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
