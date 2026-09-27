import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PartStockMovement } from "../src/modules/catalog/part-stock-movement.model.js";
import { Part } from "../src/modules/catalog/part.model.js";
import {
  configureBilling,
  cookieHeader,
  createCompany,
  createPart,
  createUser,
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

async function billedCompany() {
  const company = await createCompany();
  await configureBilling(company._id, { currency: "EGP", laborFeeMinor: 15000 });
  return company;
}

function get(cookies: Record<string, string>, path: string) {
  return request(app).get(path).set("Cookie", cookieHeader(cookies));
}

function send(cookies: Record<string, string>, method: "post" | "patch", path: string, body: Record<string, unknown>) {
  return sameOriginRequest(app, method, path).set("Cookie", cookieHeader(cookies)).send(body);
}

describe("GET /api/v1/catalog/parts", () => {
  it.each(["CUSTOMER", "TECHNICIAN", "ADMIN"] as const)("lets a %s read active parts with prices", async (role) => {
    const company = await billedCompany();
    const user = await member(company._id, role);
    const part = await createPart(company._id, { name: "Fan Motor", unitPriceMinor: 45000, stockQuantity: 3 });

    const res = await get(user.cookies, "/api/v1/catalog/parts");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        id: String(part._id),
        name: "Fan Motor",
        description: null,
        unitPriceMinor: 45000,
        currency: "EGP",
        inStock: true,
        isActive: true,
      },
    ]);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(res.body.data[0]).not.toHaveProperty("stockQuantity");
  });

  it("hides inactive parts and shows out-of-stock ones as unavailable", async () => {
    const company = await billedCompany();
    const customer = await member(company._id, "CUSTOMER");
    await createPart(company._id, { name: "Retired", isActive: false });
    await createPart(company._id, { name: "Empty", stockQuantity: 0 });

    const res = await get(customer.cookies, "/api/v1/catalog/parts");
    expect(res.body.data.map((p: { name: string; inStock: boolean }) => [p.name, p.inStock])).toEqual([["Empty", false]]);
  });

  it("filters by q and available", async () => {
    const company = await billedCompany();
    const tech = await member(company._id, "TECHNICIAN");
    await createPart(company._id, { name: "Fan Motor", stockQuantity: 2 });
    await createPart(company._id, { name: "Fan Blade", stockQuantity: 0 });
    await createPart(company._id, { name: "Capacitor", stockQuantity: 5 });

    const fan = await get(tech.cookies, "/api/v1/catalog/parts?q=fan");
    expect(fan.body.data.map((p: { name: string }) => p.name)).toEqual(["Fan Blade", "Fan Motor"]);

    const available = await get(tech.cookies, "/api/v1/catalog/parts?q=fan&available=true");
    expect(available.body.data.map((p: { name: string }) => p.name)).toEqual(["Fan Motor"]);
  });

  it("treats q as literal text, not a regex", async () => {
    const company = await billedCompany();
    const tech = await member(company._id, "TECHNICIAN");
    await createPart(company._id, { name: "Fan Motor" });
    const res = await get(tech.cookies, "/api/v1/catalog/parts?q=.*");
    expect(res.body.data).toEqual([]);
  });

  it("never shows another company's parts", async () => {
    const company = await billedCompany();
    const other = await billedCompany();
    const customer = await member(company._id, "CUSTOMER");
    await createPart(other._id, { name: "Foreign" });
    expect((await get(customer.cookies, "/api/v1/catalog/parts")).body.data).toEqual([]);
  });

  it("rejects unknown filters", async () => {
    const company = await billedCompany();
    const customer = await member(company._id, "CUSTOMER");
    const res = await get(customer.cookies, `/api/v1/catalog/parts?companyId=${String(company._id)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("answers BILLING_NOT_CONFIGURED before the company has a currency and fee", async () => {
    const company = await createCompany();
    const customer = await member(company._id, "CUSTOMER");
    const res = await get(customer.cookies, "/api/v1/catalog/parts");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BILLING_NOT_CONFIGURED");
  });

  it("requires authentication", async () => {
    expect((await request(app).get("/api/v1/catalog/parts")).status).toBe(401);
  });
});

describe("GET /api/v1/catalog/pricing", () => {
  it("returns the currency and labor fee", async () => {
    const company = await billedCompany();
    const customer = await member(company._id, "CUSTOMER");
    const res = await get(customer.cookies, "/api/v1/catalog/pricing");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ currency: "EGP", laborFeeMinor: 15000 });
  });
});

describe("admin parts management", () => {
  it("creates a part with initial stock and records it in the ledger", async () => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");

    const res = await send(admin.cookies, "post", "/api/v1/admin/parts", {
      name: "Compressor",
      description: "1.5HP rotary",
      unitPriceMinor: 350000,
      stockQuantity: 4,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "Compressor",
      description: "1.5HP rotary",
      unitPriceMinor: 350000,
      currency: "EGP",
      stockQuantity: 4,
      inStock: true,
      isActive: true,
    });
    const movements = await PartStockMovement.find({ partId: res.body.data.id });
    expect(movements.map((m) => [m.delta, m.quantityAfter, m.reason])).toEqual([[4, 4, "ADMIN_ADJUSTMENT"]]);
  });

  it("rejects a duplicate name in the same company, ignoring case and spacing", async () => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    await createPart(company._id, { name: "Fan Motor" });

    const res = await send(admin.cookies, "post", "/api/v1/admin/parts", { name: "fan   MOTOR", unitPriceMinor: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("allows the same name in different companies", async () => {
    const company = await billedCompany();
    const other = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    await createPart(other._id, { name: "Fan Motor" });
    const res = await send(admin.cookies, "post", "/api/v1/admin/parts", { name: "Fan Motor", unitPriceMinor: 1 });
    expect(res.status).toBe(201);
  });

  it.each([
    ["a fractional price", { name: "X", unitPriceMinor: 1.5 }],
    ["a negative price", { name: "X", unitPriceMinor: -1 }],
    ["a missing name", { unitPriceMinor: 1 }],
    ["negative stock", { name: "X", unitPriceMinor: 1, stockQuantity: -1 }],
  ])("rejects %s", async (_label, body) => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    const res = await send(admin.cookies, "post", "/api/v1/admin/parts", body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("updates name/price/active but ignores a stockQuantity in the PATCH body", async () => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    const part = await createPart(company._id, { name: "Old", unitPriceMinor: 100, stockQuantity: 7 });

    const res = await send(admin.cookies, "patch", `/api/v1/admin/parts/${String(part._id)}`, {
      name: "New",
      unitPriceMinor: 200,
      isActive: false,
      stockQuantity: 999,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: "New", unitPriceMinor: 200, isActive: false, stockQuantity: 7 });
  });

  it("returns 404 when patching another company's part", async () => {
    const company = await billedCompany();
    const other = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    const foreign = await createPart(other._id);
    const res = await send(admin.cookies, "patch", `/api/v1/admin/parts/${String(foreign._id)}`, { unitPriceMinor: 1 });
    expect(res.status).toBe(404);
    expect((await Part.findById(foreign._id))?.unitPriceMinor).toBe(5000);
  });

  it("lists every part with its stock, filterable by isActive", async () => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    await createPart(company._id, { name: "A", stockQuantity: 1 });
    await createPart(company._id, { name: "B", isActive: false, stockQuantity: 0 });

    const all = await get(admin.cookies, "/api/v1/admin/parts");
    expect(all.body.data.map((p: { name: string; stockQuantity: number }) => [p.name, p.stockQuantity])).toEqual([
      ["A", 1],
      ["B", 0],
    ]);
    const inactive = await get(admin.cookies, "/api/v1/admin/parts?isActive=false");
    expect(inactive.body.data.map((p: { name: string }) => p.name)).toEqual(["B"]);
  });

  it.each(["CUSTOMER", "TECHNICIAN"] as const)("forbids a %s from managing parts", async (role) => {
    const company = await billedCompany();
    const user = await member(company._id, role);
    const part = await createPart(company._id);
    expect((await get(user.cookies, "/api/v1/admin/parts")).status).toBe(403);
    expect((await send(user.cookies, "post", "/api/v1/admin/parts", { name: "X", unitPriceMinor: 1 })).status).toBe(403);
    expect(
      (await send(user.cookies, "post", `/api/v1/admin/parts/${String(part._id)}/stock-adjustments`, { delta: 1 })).status
    ).toBe(403);
  });
});

describe("POST /api/v1/admin/parts/:id/stock-adjustments", () => {
  it("applies a delta and records it", async () => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    const part = await createPart(company._id, { stockQuantity: 5 });

    const res = await send(admin.cookies, "post", `/api/v1/admin/parts/${String(part._id)}/stock-adjustments`, {
      delta: -2,
      note: "damaged in storage",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.stockQuantity).toBe(3);
    const [movement] = await PartStockMovement.find({ partId: part._id });
    expect(movement).toMatchObject({ delta: -2, quantityAfter: 3, note: "damaged in storage" });
    expect(String(movement!.actorId)).toBe(String(admin.user._id));
  });

  it("refuses to go below zero and changes nothing", async () => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    const part = await createPart(company._id, { stockQuantity: 1 });

    const res = await send(admin.cookies, "post", `/api/v1/admin/parts/${String(part._id)}/stock-adjustments`, { delta: -2 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect((await Part.findById(part._id))?.stockQuantity).toBe(1);
    expect(await PartStockMovement.countDocuments({ partId: part._id })).toBe(0);
  });

  it("never goes negative under concurrent decrements", async () => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    const part = await createPart(company._id, { stockQuantity: 3 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        send(admin.cookies, "post", `/api/v1/admin/parts/${String(part._id)}/stock-adjustments`, { delta: -1 })
      )
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await Part.findById(part._id))?.stockQuantity).toBe(0);
    expect(await PartStockMovement.countDocuments({ partId: part._id })).toBe(3);
  });

  it("rejects a zero delta", async () => {
    const company = await billedCompany();
    const admin = await member(company._id, "ADMIN");
    const part = await createPart(company._id);
    const res = await send(admin.cookies, "post", `/api/v1/admin/parts/${String(part._id)}/stock-adjustments`, { delta: 0 });
    expect(res.status).toBe(400);
  });
});
