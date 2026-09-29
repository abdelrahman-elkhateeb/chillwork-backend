import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CompanySettingsAudit } from "../src/modules/companies/company-settings-audit.model.js";
import { Company } from "../src/modules/companies/company.model.js";
import { cookieHeader, createCompany, createUser, loginAs, sameOriginRequest } from "./helpers.js";

const app = createApp();

async function member(companyId: unknown, role: "ADMIN" | "TECHNICIAN" | "CUSTOMER") {
  const email = `${role.toLowerCase()}-${randomUUID()}@example.com`;
  const user = await createUser(companyId, { email, role });
  const cookies = await loginAs(app, email);
  return { user, cookies };
}

function getSettings(cookies: Record<string, string>) {
  return request(app).get("/api/v1/admin/company-settings").set("Cookie", cookieHeader(cookies));
}

function patchSettings(cookies: Record<string, string>, body: Record<string, unknown>) {
  return sameOriginRequest(app, "patch", "/api/v1/admin/company-settings").set("Cookie", cookieHeader(cookies)).send(body);
}

describe("GET /api/v1/admin/company-settings", () => {
  it("returns unconfigured billing as nulls for a fresh company", async () => {
    const company = await createCompany({ name: "Cool Air", timezone: "Africa/Cairo" });
    const admin = await member(company._id, "ADMIN");

    const res = await getSettings(admin.cookies);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      name: "Cool Air",
      contact: { phone: null, email: null },
      timezone: "Africa/Cairo",
      currency: null,
      laborFeeMinor: null,
    });
  });

  it.each(["CUSTOMER", "TECHNICIAN"] as const)("forbids a %s", async (role) => {
    const company = await createCompany();
    const user = await member(company._id, role);
    expect((await getSettings(user.cookies)).status).toBe(403);
    expect((await patchSettings(user.cookies, { laborFeeMinor: 1 })).status).toBe(403);
  });

  it("requires authentication", async () => {
    expect((await request(app).get("/api/v1/admin/company-settings")).status).toBe(401);
  });
});

describe("PATCH /api/v1/admin/company-settings", () => {
  it("updates settings and audits pricing changes only", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");

    const res = await patchSettings(admin.cookies, {
      name: "Cool Air Ltd",
      contact: { phone: "+20 100 000 0000", email: "Ops@CoolAir.example" },
      timezone: "Africa/Cairo",
      currency: "EGP",
      laborFeeMinor: 15000,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      name: "Cool Air Ltd",
      contact: { phone: "+201000000000", email: "ops@coolair.example" },
      timezone: "Africa/Cairo",
      currency: "EGP",
      laborFeeMinor: 15000,
    });

    const audits = await CompanySettingsAudit.find({ companyId: company._id }).sort({ field: 1 });
    expect(audits.map((a) => [a.field, a.previousValue, a.newValue, String(a.actorId)])).toEqual([
      ["currency", null, "EGP", String(admin.user._id)],
      ["laborFeeMinor", null, "15000", String(admin.user._id)],
    ]);
  });

  it("does not audit a value that did not change", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    await patchSettings(admin.cookies, { currency: "EGP", laborFeeMinor: 100 });
    await patchSettings(admin.cookies, { currency: "EGP", laborFeeMinor: 100, name: "Renamed" });
    expect(await CompanySettingsAudit.countDocuments({ companyId: company._id })).toBe(2);
  });

  it("locks the currency once set", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    await patchSettings(admin.cookies, { currency: "EGP" });

    const res = await patchSettings(admin.cookies, { currency: "USD" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CURRENCY_LOCKED");
    expect((await Company.findById(company._id))?.currency).toBe("EGP");
  });

  it("clears a contact field with null", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    await patchSettings(admin.cookies, { contact: { phone: "+201000000000" } });
    const res = await patchSettings(admin.cookies, { contact: { phone: null } });
    expect(res.body.data.contact.phone).toBeNull();
  });

  it.each([
    ["an empty body", {}],
    ["a fractional fee", { laborFeeMinor: 10.5 }],
    ["a negative fee", { laborFeeMinor: -1 }],
    ["an unsupported currency", { currency: "XYZ" }],
    ["an invalid timezone", { timezone: "Mars/Olympus" }],
    ["a null fee", { laborFeeMinor: null }],
  ])("rejects %s", async (_label, body) => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const res = await patchSettings(admin.cookies, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("only ever changes the caller's own company", async () => {
    const companyA = await createCompany();
    const companyB = await createCompany();
    const admin = await member(companyA._id, "ADMIN");

    await patchSettings(admin.cookies, { companyId: String(companyB._id), laborFeeMinor: 999 });

    expect((await Company.findById(companyA._id))?.laborFeeMinor).toBe(999);
    expect((await Company.findById(companyB._id))?.laborFeeMinor).toBeNull();
  });

  it("is behind the CSRF origin guard", async () => {
    const company = await createCompany();
    const admin = await member(company._id, "ADMIN");
    const res = await request(app)
      .patch("/api/v1/admin/company-settings")
      .set("Origin", "http://evil.example.com")
      .set("Cookie", cookieHeader(admin.cookies))
      .send({ laborFeeMinor: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_ORIGIN_REJECTED");
  });
});
