import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import { TechnicianInvitation } from "../src/modules/staff/technician-invitation.model.js";
import { User } from "../src/modules/users/user.model.js";
import { Visit } from "../src/modules/visits/visit.model.js";
import {
  PASSWORD,
  cookieHeader,
  createCompany,
  createServiceRequest,
  createUser,
  createVisitDoc,
  loginAs,
  sameOriginRequest,
} from "./helpers.js";

const app = createApp();
const NEW_PASSWORD = "Tech-Own-Passw0rd!";

async function member(companyId: unknown, role: "ADMIN" | "TECHNICIAN" | "CUSTOMER", name?: string) {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await createUser(companyId, { email, role, name });
  const cookies = await loginAs(app, email);
  return { user, email, cookies };
}

function send(cookies: Record<string, string>, method: "post" | "patch", path: string, body?: Record<string, unknown>) {
  return sameOriginRequest(app, method, path).set("Cookie", cookieHeader(cookies)).send(body);
}

function list(cookies: Record<string, string>, query = "") {
  return request(app).get(`/api/v1/admin/technicians${query}`).set("Cookie", cookieHeader(cookies));
}

function activate(body: Record<string, unknown>) {
  return sameOriginRequest(app, "post", "/api/v1/auth/activate-technician").send(body);
}

function login(email: string, password: string) {
  return sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password });
}

async function invite(cookies: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return send(cookies, "post", "/api/v1/admin/technicians", {
    name: "New Tech",
    email: `new-tech-${randomUUID()}@example.com`,
    phone: "+20 100 000 0009",
    ...overrides,
  });
}

describe("POST /admin/technicians", () => {
  it("creates a pending technician with a one-time activation token", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");

    const res = await invite(admin.cookies, { email: "Omar@Example.com" });

    expect(res.status).toBe(201);
    expect(res.body.data.technician).toMatchObject({
      name: "New Tech",
      email: "omar@example.com",
      phone: "+201000000009",
      status: "INVITED",
      activeVisitCount: 0,
    });
    expect(res.body.data.invitation.activationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await TechnicianInvitation.findOne({});
    expect(stored?.tokenHash).not.toBe(res.body.data.invitation.activationToken);

    const user = await User.findOne({ email: "omar@example.com" });
    expect(user).toMatchObject({ role: "TECHNICIAN", isActive: false, pendingActivation: true, activatedAt: null });
    expect(String(user!.companyId)).toBe(String(company._id));
  });

  it("ignores a client-supplied role or company", async () => {
    const company = await createCompany();
    const other = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const res = await invite(admin.cookies, { role: "ADMIN", companyId: String(other._id), isActive: true });
    const user = await User.findById(res.body.data.technician.id);
    expect(user).toMatchObject({ role: "TECHNICIAN", isActive: false });
    expect(String(user!.companyId)).toBe(String(company._id));
  });

  it("rejects an email that already has an account", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const res = await invite(admin.cookies, { email: admin.email });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it.each(["CUSTOMER", "TECHNICIAN"] as const)("forbids a %s", async (role) => {
    const company = await createCompany();
    const user = await member(company._id, role);
    expect((await invite(user.cookies)).status).toBe(403);
    expect((await list(user.cookies)).status).toBe(403);
  });
});

describe("POST /auth/activate-technician", () => {
  it("activates once, then the technician logs in with their own password", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const created = await invite(admin.cookies);
    const { email } = created.body.data.technician;
    const token = created.body.data.invitation.activationToken;

    expect((await login(email, NEW_PASSWORD)).status).toBe(401);

    const res = await activate({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ email });
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);

    const again = await activate({ token, password: "Another-Passw0rd!" });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_ACTIVATION_TOKEN");
    expect((await login(email, NEW_PASSWORD)).status).toBe(200);
  });

  it("rejects unknown, expired and superseded tokens with the same error", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const created = await invite(admin.cookies);
    const first = created.body.data.invitation.activationToken;
    const reissued = await send(admin.cookies, "post", `/api/v1/admin/technicians/${created.body.data.technician.id}/invitation`);
    expect(reissued.status).toBe(201);

    const unknown = await activate({ token: "not-a-real-token", password: NEW_PASSWORD });
    const superseded = await activate({ token: first, password: NEW_PASSWORD });
    await TechnicianInvitation.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await activate({ token: reissued.body.data.activationToken, password: NEW_PASSWORD });

    for (const res of [unknown, superseded, expired]) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_ACTIVATION_TOKEN");
    }
  });

  it("lets only one of two concurrent activations win", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const token = (await invite(admin.cookies)).body.data.invitation.activationToken;
    const results = await Promise.all([
      activate({ token, password: NEW_PASSWORD }),
      activate({ token, password: "Second-Passw0rd!" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it("rejects a short password without consuming the token", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const token = (await invite(admin.cookies)).body.data.invitation.activationToken;
    expect((await activate({ token, password: "short" })).status).toBe(400);
    expect((await activate({ token, password: NEW_PASSWORD })).status).toBe(200);
  });
});

describe("POST /admin/technicians/:id/invitation", () => {
  it("refuses once the technician has activated", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const tech = await member(company._id, "TECHNICIAN");
    const res = await send(admin.cookies, "post", `/api/v1/admin/technicians/${String(tech.user._id)}/invitation`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TECHNICIAN_ALREADY_ACTIVATED");
  });

  it("returns 404 for another company's technician", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const foreign = await createUser((await createCompany())._id, { role: "TECHNICIAN", isActive: false });
    const res = await send(admin.cookies, "post", `/api/v1/admin/technicians/${String(foreign._id)}/invitation`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin/technicians/:id", () => {
  it("deactivates: revokes sessions immediately, blocks login and scheduling, keeps history", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const customer = await member(company._id, "CUSTOMER");
    const tech = await member(company._id, "TECHNICIAN");
    const req = await createServiceRequest(company._id, customer.user._id, [{ clientDeviceId: "d1" }, { clientDeviceId: "d2" }]);
    const visit = await createVisitDoc({
      companyId: company._id,
      requestId: req._id,
      technicianId: tech.user._id,
      scheduledById: admin.user._id,
      deviceIds: ["d1"],
    });

    const res = await send(admin.cookies, "patch", `/api/v1/admin/technicians/${String(tech.user._id)}`, { isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "INACTIVE", activeVisitCount: 1 });
    expect(await Session.countDocuments({ userId: tech.user._id, revokedAt: null })).toBe(0);
    const techCall = await request(app).get("/api/v1/technician/visits").set("Cookie", cookieHeader(tech.cookies));
    expect(techCall.status).toBe(401);
    expect((await login(tech.email, PASSWORD)).status).toBe(401);

    const booking = await send(admin.cookies, "post", `/api/v1/admin/requests/${String(req._id)}/visits`, {
      technicianId: String(tech.user._id),
      startAt: "2030-02-01T10:00:00Z",
      endAt: "2030-02-01T11:00:00Z",
      deviceIds: ["d2"],
    });
    expect(booking.status).toBe(400);

    expect(String((await Visit.findById(visit._id))?.technicianId)).toBe(String(tech.user._id));
  });

  it("reactivates a deactivated technician, including one created before FS09", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const tech = await createUser(company._id, { role: "TECHNICIAN" });
    await User.collection.updateOne({ _id: tech._id }, { $set: { isActive: false }, $unset: { pendingActivation: "" } });

    const res = await send(admin.cookies, "patch", `/api/v1/admin/technicians/${String(tech._id)}`, { isActive: true });
    expect(res.body.data.status).toBe("ACTIVE");
  });

  it("refuses to switch on a technician who never activated", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const created = await invite(admin.cookies);
    const res = await send(admin.cookies, "patch", `/api/v1/admin/technicians/${created.body.data.technician.id}`, {
      isActive: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TECHNICIAN_NOT_ACTIVATED");
  });

  it("revokes a pending invitation when deactivated", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const created = await invite(admin.cookies);
    await send(admin.cookies, "patch", `/api/v1/admin/technicians/${created.body.data.technician.id}`, { isActive: false });
    const res = await activate({ token: created.body.data.invitation.activationToken, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("cannot edit a customer or an admin through this endpoint", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const customer = await createUser(company._id, { role: "CUSTOMER" });
    const res = await send(admin.cookies, "patch", `/api/v1/admin/technicians/${String(customer._id)}`, { isActive: false });
    expect(res.status).toBe(404);
    expect((await User.findById(customer._id))?.isActive).toBe(true);
  });
});

describe("GET /admin/technicians", () => {
  it("lists this company's technicians with status, filterable and searchable", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    await createUser(company._id, { role: "TECHNICIAN", name: "Amr Active", email: "amr@example.com" });
    await invite(admin.cookies, { name: "Bassem Invited" });
    const inactive = await createUser(company._id, { role: "TECHNICIAN", name: "Cyril Inactive" });
    await User.updateOne({ _id: inactive._id }, { $set: { isActive: false, activatedAt: new Date() } });
    await createUser((await createCompany())._id, { role: "TECHNICIAN", name: "Foreign Tech" });
    await createUser(company._id, { role: "CUSTOMER", name: "Not A Tech" });

    const all = await list(admin.cookies);
    expect(all.body.data.map((t: { name: string; status: string }) => [t.name, t.status])).toEqual([
      ["Amr Active", "ACTIVE"],
      ["Bassem Invited", "INVITED"],
      ["Cyril Inactive", "INACTIVE"],
    ]);
    expect(all.body.meta).toEqual({ page: 1, pageSize: 20, total: 3 });

    const invited = await list(admin.cookies, "?status=INVITED");
    expect(invited.body.data.map((t: { name: string }) => t.name)).toEqual(["Bassem Invited"]);

    const search = await list(admin.cookies, "?search=AMR@");
    expect(search.body.data.map((t: { name: string }) => t.name)).toEqual(["Amr Active"]);
  });

  it("rejects unknown filters", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    expect((await list(admin.cookies, "?companyId=x")).status).toBe(400);
  });
});
