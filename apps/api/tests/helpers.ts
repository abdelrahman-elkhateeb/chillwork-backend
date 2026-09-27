import type { Express } from "express";
import { Types } from "mongoose";
import request, { type Response, type Test } from "supertest";
import { Part, partNameKey } from "../src/modules/catalog/part.model.js";
import { Company } from "../src/modules/companies/company.model.js";
import { ServiceRequest } from "../src/modules/requests/request.model.js";
import { hashPassword } from "../src/modules/users/password.js";
import { User, type UserRole } from "../src/modules/users/user.model.js";
import { Visit } from "../src/modules/visits/visit.model.js";

export const PASSWORD = "Sup3r-Secret-Passw0rd!";

// supertest binds the app to an ephemeral port per call, so there's no
// fixed real Origin/Host to assert against. Pinning both to the same
// fixed values (Express reads `req.protocol`/`req.get("host")` from the
// Host header, not the actual socket) gives the CSRF origin guard a
// stable same-origin request in tests, independent of that port.
export const TEST_ORIGIN = "http://localhost:3000";
export const TEST_HOST = "localhost:3000";

/** A same-origin POST/PUT/PATCH/DELETE request, pre-set to pass the CSRF origin guard. */
export function sameOriginRequest(app: Express, method: "post" | "put" | "patch" | "delete", path: string): Test {
  return request(app)[method](path).set("Origin", TEST_ORIGIN).set("Host", TEST_HOST);
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export async function createCompany(overrides: { name?: string; isActive?: boolean; timezone?: string } = {}) {
  return Company.create({
    name: overrides.name ?? unique("Acme"),
    isActive: overrides.isActive ?? true,
    ...(overrides.timezone ? { timezone: overrides.timezone } : {}),
  });
}

export async function createUser(
  companyId: unknown,
  overrides: {
    email?: string;
    name?: string;
    phone?: string;
    role?: UserRole;
    isActive?: boolean;
    password?: string;
  } = {}
) {
  const passwordHash = await hashPassword(overrides.password ?? PASSWORD);
  return User.create({
    email: overrides.email ?? `${unique("user")}@example.com`,
    name: overrides.name ?? "Test User",
    phone: overrides.phone ?? "+15550001111",
    passwordHash,
    role: overrides.role ?? "CUSTOMER",
    companyId,
    isActive: overrides.isActive ?? true,
  });
}

/**
 * FS04: registration resolves a single, ops-provisioned demo company via
 * DEMO_COMPANY_ID rather than creating one itself. Since `env` is loaded
 * once and frozen, tests can't change that id at runtime — instead this
 * (re)creates the actual Company document at the fixed id global-setup.ts
 * put in DEMO_COMPANY_ID, which setup-file.ts's afterEach wipes between
 * tests like every other collection.
 */
export async function ensureDemoCompany(overrides: { isActive?: boolean } = {}) {
  const demoCompanyId = process.env.DEMO_COMPANY_ID;
  if (!demoCompanyId) {
    throw new Error("DEMO_COMPANY_ID was not set by tests/global-setup.ts");
  }
  return Company.findOneAndUpdate(
    { _id: new Types.ObjectId(demoCompanyId) },
    { $set: { name: "Demo Company", isActive: overrides.isActive ?? true } },
    { upsert: true, new: true }
  );
}

/** Parses `Set-Cookie` response headers into a plain name -> value map. */
export function parseSetCookies(res: Response): Record<string, string> {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const map: Record<string, string> = {};
  if (!raw) {
    return map;
  }
  for (const line of raw) {
    const pair = line.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    map[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return map;
}

export function findRawSetCookie(res: Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return raw?.find((line) => line.startsWith(`${name}=`));
}

export function cookieHeader(cookies: Record<string, string | undefined>): string {
  return Object.entries(cookies)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/** Logs in and returns the auth cookies. */
export async function loginAs(app: Express, email: string): Promise<Record<string, string>> {
  const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password: PASSWORD });
  return parseSetCookies(res);
}

export interface TestRequestDevice {
  clientDeviceId: string;
  label?: string;
  brand?: string | null;
  model?: string | null;
  originalDescription?: string;
  analysis?: {
    summary: string;
    possibleCauses: string[];
    missingInformation: string[];
    inspectionQuestions: string[];
  } | null;
}

/** A persisted ServiceRequest (no Gemini/HTTP involved), with per-device AI analysis if given. */
export async function createServiceRequest(
  companyId: unknown,
  customerId: unknown,
  devices: TestRequestDevice[] = [{ clientDeviceId: "d1" }]
) {
  return ServiceRequest.create({
    companyId,
    customerId,
    reference: `SR-${unique("ref")}`.slice(0, 24),
    status: "SUBMITTED",
    address: "1 Main St",
    contactPhone: "+15550001111",
    devices: devices.map((device) => ({
      clientDeviceId: device.clientDeviceId,
      label: device.label ?? device.clientDeviceId,
      brand: device.brand ?? null,
      model: device.model ?? null,
      originalDescription: device.originalDescription ?? `broken ${device.clientDeviceId}`,
      analysis: device.analysis ?? null,
      analysisMetadata: {
        status: device.analysis ? "SUCCESS" : "UNAVAILABLE",
        model: "internal-model-name",
        promptVersion: "v-internal",
        processedAt: new Date(),
        errorCode: device.analysis ? null : "GEMINI_TIMEOUT",
      },
    })),
  });
}

/** Sets the FS10 billing settings directly (no admin/HTTP involved). */
export async function configureBilling(companyId: unknown, settings: { currency?: string; laborFeeMinor?: number } = {}) {
  return Company.findOneAndUpdate(
    { _id: companyId },
    { $set: { currency: settings.currency ?? "EGP", laborFeeMinor: settings.laborFeeMinor ?? 15000 } },
    { new: true }
  );
}

/** A persisted catalog Part inserted directly. */
export async function createPart(
  companyId: unknown,
  overrides: { name?: string; unitPriceMinor?: number; stockQuantity?: number; isActive?: boolean } = {}
) {
  const name = overrides.name ?? unique("Part");
  return Part.create({
    companyId,
    name,
    nameKey: partNameKey(name),
    unitPriceMinor: overrides.unitPriceMinor ?? 5000,
    stockQuantity: overrides.stockQuantity ?? 10,
    isActive: overrides.isActive ?? true,
  });
}

/** A persisted Visit inserted directly (bypasses scheduling), for read-side tests. */
export async function createVisitDoc(overrides: {
  companyId: unknown;
  requestId: unknown;
  technicianId: unknown;
  scheduledById: unknown;
  deviceIds?: string[];
  startAt?: Date;
  endAt?: Date;
  status?: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  workTypes?: Array<"INSPECTION" | "REPAIR">;
}) {
  const startAt = overrides.startAt ?? new Date("2030-01-15T10:00:00Z");
  return Visit.create({
    companyId: overrides.companyId,
    requestId: overrides.requestId,
    technicianId: overrides.technicianId,
    scheduledById: overrides.scheduledById,
    startAt,
    endAt: overrides.endAt ?? new Date(startAt.getTime() + 60 * 60 * 1000),
    timezone: "UTC",
    deviceIds: overrides.deviceIds ?? ["d1"],
    workTypes: overrides.workTypes ?? ["INSPECTION"],
    status: overrides.status ?? "SCHEDULED",
  });
}
