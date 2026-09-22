import type { Express } from "express";
import { Types } from "mongoose";
import request, { type Response, type Test } from "supertest";
import { Company } from "../src/modules/companies/company.model.js";
import { hashPassword } from "../src/modules/users/password.js";
import { User, type UserRole } from "../src/modules/users/user.model.js";

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

export async function createCompany(overrides: { name?: string; isActive?: boolean } = {}) {
  return Company.create({
    name: overrides.name ?? unique("Acme"),
    isActive: overrides.isActive ?? true,
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
