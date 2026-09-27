import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import { User } from "../src/modules/users/user.model.js";
import { VisitEvent } from "../src/modules/visits/visit-event.model.js";
import { Visit } from "../src/modules/visits/visit.model.js";
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

function put(cookies: Record<string, string>, visitId: unknown, deviceId: string, body: Record<string, unknown>) {
  return request(app)
    .put(`/api/v1/technician/visits/${String(visitId)}/work-results/${deviceId}`)
    .set("Origin", "http://localhost:3000")
    .set("Host", "localhost:3000")
    .set("Cookie", cookieHeader(cookies))
    .send(body);
}

function getResults(cookies: Record<string, string>, visitId: unknown) {
  return request(app)
    .get(`/api/v1/technician/visits/${String(visitId)}/work-results`)
    .set("Cookie", cookieHeader(cookies));
}

function start(cookies: Record<string, string>, visitId: unknown) {
  return request(app)
    .post(`/api/v1/technician/visits/${String(visitId)}/start`)
    .set("Origin", "http://localhost:3000")
    .set("Host", "localhost:3000")
    .set("Cookie", cookieHeader(cookies));
}

function complete(cookies: Record<string, string>, visitId: unknown) {
  return request(app)
    .post(`/api/v1/technician/visits/${String(visitId)}/complete`)
    .set("Origin", "http://localhost:3000")
    .set("Host", "localhost:3000")
    .set("Cookie", cookieHeader(cookies));
}

const repaired = { result: "REPAIRED", version: 0 };
const failed = (reason = "PART_UNAVAILABLE") => ({ result: "FAILED", failureReason: reason, version: 0 });

describe("lifecycle transitions", () => {
  it("starts a SCHEDULED visit and records a VISIT_STARTED event", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "SCHEDULED" });

    const res = await start(w.techA.cookies, v._id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: String(v._id), status: "IN_PROGRESS" });

    const events = await VisitEvent.find({ visitId: v._id });
    expect(events.map((e) => e.type)).toEqual(["VISIT_STARTED"]);
  });

  it("rejects starting a visit that is not SCHEDULED", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await start(w.techA.cookies, v._id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VISIT_STATUS_CONFLICT");
  });

  it("completes an IN_PROGRESS visit once every device has a result", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1", "d2"] });
    await put(w.techA.cookies, v._id, "d1", repaired);
    await put(w.techA.cookies, v._id, "d2", failed());

    const res = await complete(w.techA.cookies, v._id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("COMPLETED");
    expect((await VisitEvent.find({ visitId: v._id, type: "VISIT_COMPLETED" })).length).toBe(1);
  });

  it("blocks completion while any assigned device has no recorded result", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1", "d2"] });
    await put(w.techA.cookies, v._id, "d1", repaired);

    const res = await complete(w.techA.cookies, v._id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WORK_RESULTS_INCOMPLETE");
    expect((await Visit.findById(v._id))?.status).toBe("IN_PROGRESS");
  });

  it("rejects completing a visit that is not IN_PROGRESS", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "SCHEDULED" });
    const res = await complete(w.techA.cookies, v._id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VISIT_STATUS_CONFLICT");
  });

  it.each(["SCHEDULED", "COMPLETED", "CANCELLED"])(
    "rejects recording a work result while the visit is %s",
    async (status) => {
      const w = await world();
      const v = await visitFor(w, w.techA.user._id, { status });
      const res = await put(w.techA.cookies, v._id, "d1", repaired);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VISIT_STATUS_CONFLICT");
      expect(await WorkResult.countDocuments({})).toBe(0);
    }
  );

  it("allows recording a work result while IN_PROGRESS", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "d1", repaired);
    expect(res.status).toBe(200);
  });
});

describe("authorization", () => {
  it("denies unauthenticated requests on every mutating and read route", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const noCookies = {};
    expect((await put(noCookies, v._id, "d1", repaired)).status).toBe(401);
    expect((await getResults(noCookies, v._id)).status).toBe(401);
    expect((await start(noCookies, v._id)).status).toBe(401);
  });

  it.each(["CUSTOMER", "ADMIN"] as const)("denies a %s with 403", async (role) => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const other = await member(w.company._id, role);
    expect((await put(other.cookies, v._id, "d1", repaired)).status).toBe(403);
    expect((await getResults(other.cookies, v._id)).status).toBe(403);
    expect((await start(other.cookies, v._id)).status).toBe(403);
  });

  it("denies a technician not assigned to the visit", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const techC = await member(w.company._id, "TECHNICIAN");
    const res = await put(techC.cookies, v._id, "d1", repaired);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("denies a technician from another company (uniform 404)", async () => {
    const w = await world();
    const other = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(other.techA.cookies, v._id, "d1", repaired);
    expect(res.status).toBe(404);
  });

  it("denies a deactivated technician", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    await User.updateOne({ _id: w.techA.user._id }, { $set: { isActive: false } });
    expect((await put(w.techA.cookies, v._id, "d1", repaired)).status).toBe(401);
  });

  it("denies a revoked session", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    await Session.updateMany({}, { $set: { revokedAt: new Date(), revokedReason: "manual" } });
    const res = await put(w.techA.cookies, v._id, "d1", repaired);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("denies a user whose role is no longer TECHNICIAN on the next request", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    await User.updateOne({ _id: w.techA.user._id }, { $set: { role: "CUSTOMER" } });
    expect((await put(w.techA.cookies, v._id, "d1", repaired)).status).toBe(403);
  });
});

describe("device scope", () => {
  it("accepts a device that is part of the visit", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    expect((await put(w.techA.cookies, v._id, "d1", repaired)).status).toBe(200);
  });

  it("rejects a request device that exists but was not included in this visit", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    const res = await put(w.techA.cookies, v._id, "d2", repaired);
    expect(res.status).toBe(404);
    expect(await WorkResult.countDocuments({})).toBe(0);
  });

  it("rejects a device id from a different request entirely", async () => {
    const w = await world([{ clientDeviceId: "d1" }]);
    const other = await createServiceRequest(w.company._id, w.customer.user._id, [{ clientDeviceId: "foreign-device" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    void other;
    const res = await put(w.techA.cookies, v._id, "foreign-device", repaired);
    expect(res.status).toBe(404);
  });

  it("rejects a cross-company device id even if it happens to match a visit's own device string", async () => {
    const w = await world([{ clientDeviceId: "shared-name" }]);
    const other = await world([{ clientDeviceId: "shared-name" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["shared-name"] });
    const res = await put(other.techA.cookies, v._id, "shared-name", repaired);
    // Wrong technician/company for the visit at all -> 404 before device scope is even reached.
    expect(res.status).toBe(404);
  });

  it("handles an oversized/malformed device id safely (no 500)", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "x".repeat(500), repaired);
    expect(res.status).toBe(404);
  });
});

describe("result values", () => {
  it("accepts REPAIRED with no failure fields", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "d1", repaired);
    expect(res.body.data).toEqual({ clientDeviceId: "d1", result: "REPAIRED", failureReason: null, failureNote: null, version: 1 });
  });

  it("accepts FAILED with a valid failureReason and optional failureNote", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "d1", {
      result: "FAILED",
      failureReason: "CUSTOMER_REFUSED",
      failureNote: "Declined after hearing the price.",
      version: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      result: "FAILED",
      failureReason: "CUSTOMER_REFUSED",
      failureNote: "Declined after hearing the price.",
    });
  });

  it("accepts FAILED without a failureNote", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "d1", failed());
    expect(res.body.data.failureNote).toBeNull();
  });

  it("rejects FAILED with no failureReason", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "d1", { result: "FAILED", version: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid/arbitrary failureReason", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "d1", failed("MADE_UP_REASON"));
    expect(res.status).toBe(400);
  });

  it("ignores failureReason/failureNote sent alongside REPAIRED", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "d1", { ...repaired, failureReason: "OTHER", failureNote: "ignored" });
    expect(res.status).toBe(200);
    expect(res.body.data.failureReason).toBeNull();
    expect(res.body.data.failureNote).toBeNull();
  });

  it.each([["NO_RESULT"], ["PENDING"], [null], [undefined]])("rejects a result value of %s", async (value) => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const res = await put(w.techA.cookies, v._id, "d1", { result: value, version: 0 });
    expect(res.status).toBe(400);
  });
});

describe("versioning / concurrency", () => {
  it("starts new results at version 1 and increments on each accepted update", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const created = await put(w.techA.cookies, v._id, "d1", repaired);
    expect(created.body.data.version).toBe(1);

    const updated = await put(w.techA.cookies, v._id, "d1", { ...failed("TECHNICAL_ISSUE"), version: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.version).toBe(2);
  });

  it("updates using the correct current version and rejects a stale one", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    await put(w.techA.cookies, v._id, "d1", repaired); // version -> 1

    const staleRetry = await put(w.techA.cookies, v._id, "d1", { result: "FAILED", failureReason: "OTHER", version: 0 });
    expect(staleRetry.status).toBe(409);
    expect(staleRetry.body.error.code).toBe("VERSION_CONFLICT");

    const correct = await put(w.techA.cookies, v._id, "d1", { result: "FAILED", failureReason: "OTHER", version: 1 });
    expect(correct.status).toBe(200);
    expect(correct.body.data.version).toBe(2);

    const nowStale = await put(w.techA.cookies, v._id, "d1", { ...repaired, version: 1 });
    expect(nowStale.status).toBe(409);
  });

  it("does not let two concurrent creates for the same device both succeed", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const [a, b] = await Promise.all([put(w.techA.cookies, v._id, "d1", repaired), put(w.techA.cookies, v._id, "d1", failed())]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await WorkResult.countDocuments({ visitId: v._id, clientDeviceId: "d1" })).toBe(1);
  });

  it("does not let two concurrent updates from the same base version both apply", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    await put(w.techA.cookies, v._id, "d1", repaired); // version 1

    const [a, b] = await Promise.all([
      put(w.techA.cookies, v._id, "d1", { result: "FAILED", failureReason: "OTHER", version: 1 }),
      put(w.techA.cookies, v._id, "d1", { result: "FAILED", failureReason: "TOO_EXPENSIVE", version: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const stored = await WorkResult.findOne({ visitId: v._id, clientDeviceId: "d1" });
    expect(stored?.version).toBe(2);
  });
});

describe("reassignment", () => {
  it("removes A's mutation access and grants B's immediately; A's historical result is preserved", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const techB = await member(w.company._id, "TECHNICIAN");
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1", "d2"] });

    const recorded = await put(w.techA.cookies, v._id, "d1", repaired);
    expect(recorded.status).toBe(200);

    await Visit.updateOne({ _id: v._id }, { $set: { technicianId: techB.user._id } });

    const aBlocked = await put(w.techA.cookies, v._id, "d2", repaired);
    expect(aBlocked.status).toBe(404);
    const aBlockedComplete = await complete(w.techA.cookies, v._id);
    expect(aBlockedComplete.status).toBe(404);

    const bAllowed = await put(techB.cookies, v._id, "d2", failed());
    expect(bAllowed.status).toBe(200);

    const preserved = await WorkResult.findOne({ visitId: v._id, clientDeviceId: "d1" });
    expect(preserved?.result).toBe("REPAIRED");
    expect(String(preserved?.recordedById)).toBe(String(w.techA.user._id));
  });
});

describe("aggregate outcome", () => {
  it("is null until every device on the visit has a result", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1", "d2"] });
    expect((await getResults(w.techA.cookies, v._id)).body.data.outcome).toBeNull();
    await put(w.techA.cookies, v._id, "d1", repaired);
    expect((await getResults(w.techA.cookies, v._id)).body.data.outcome).toBeNull();
  });

  it("is FULLY_REPAIRED when every device was repaired", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1", "d2"] });
    await put(w.techA.cookies, v._id, "d1", repaired);
    await put(w.techA.cookies, v._id, "d2", repaired);
    expect((await getResults(w.techA.cookies, v._id)).body.data.outcome).toBe("FULLY_REPAIRED");
  });

  it("is PARTIALLY_REPAIRED with two repaired and one failed", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }, { clientDeviceId: "d3" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1", "d2", "d3"] });
    await put(w.techA.cookies, v._id, "d1", repaired);
    await put(w.techA.cookies, v._id, "d2", repaired);
    await put(w.techA.cookies, v._id, "d3", failed());
    const res = await getResults(w.techA.cookies, v._id);
    expect(res.body.data.outcome).toBe("PARTIALLY_REPAIRED");
  });

  it("is NO_REPAIR when every attempted device failed", async () => {
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1", "d2"] });
    await put(w.techA.cookies, v._id, "d1", failed("TOO_EXPENSIVE"));
    await put(w.techA.cookies, v._id, "d2", failed("TECHNICAL_ISSUE"));
    expect((await getResults(w.techA.cookies, v._id)).body.data.outcome).toBe("NO_REPAIR");
  });

  it("does not treat a device outside the visit's scope as missing", async () => {
    // Request has 3 devices; only 1 is actually part of this visit.
    const w = await world([{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }, { clientDeviceId: "d3" }]);
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS", deviceIds: ["d1"] });
    await put(w.techA.cookies, v._id, "d1", repaired);
    const res = await getResults(w.techA.cookies, v._id);
    expect(res.body.data.outcome).toBe("FULLY_REPAIRED");
    expect(res.body.data.devices).toHaveLength(1);
  });
});

describe("DTO safety", () => {
  it("never exposes internal ids, other users, or unrelated fields", async () => {
    const w = await world();
    const v = await visitFor(w, w.techA.user._id, { status: "IN_PROGRESS" });
    const putRes = await put(w.techA.cookies, v._id, "d1", repaired);
    const getRes = await getResults(w.techA.cookies, v._id);

    for (const body of [putRes.body, getRes.body]) {
      const raw = JSON.stringify(body);
      for (const id of [w.company._id, w.req._id, w.techA.user._id, w.admin.user._id, w.customer.user._id]) {
        expect(raw).not.toContain(String(id));
      }
      const keys = [...raw.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]);
      for (const banned of [
        "companyId", "requestId", "recordedById", "technicianId", "customerId",
        "email", "password", "token", "session", "price", "amount", "payment", "invoice",
      ]) {
        expect(keys).not.toContain(banned);
      }
    }
  });
});
