import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import { Company } from "../src/modules/companies/company.model.js";
import { User } from "../src/modules/users/user.model.js";
import { ensureDemoCompany, parseSetCookies, sameOriginRequest } from "./helpers.js";

const VALID_BODY = {
  name: "Jane Customer",
  email: "Jane.Customer@Example.COM",
  phone: "+1 (555) 000-1111",
  password: "correct-horse-battery-staple",
};

function registerWith(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return sameOriginRequest(app, "post", "/api/v1/auth/register").send(body);
}

describe("POST /api/v1/auth/register", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    app = createApp();
    await ensureDemoCompany();
  });

  describe("happy path", () => {
    it("returns 201 with a safe user DTO, creates exactly one CUSTOMER user in the demo company, and never creates a session", async () => {
      const res = await registerWith(app, VALID_BODY);

      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({
        name: "Jane Customer",
        email: "jane.customer@example.com",
        phone: "+15550001111",
        role: "CUSTOMER",
      });
      expect(res.body.data.user.id).toBeDefined();
      expect(res.body.data.user.companyId).toBeDefined();

      const users = await User.find({}).select("+passwordHash");
      expect(users).toHaveLength(1);
      expect(users[0]?.role).toBe("CUSTOMER");

      const demoCompany = await ensureDemoCompany();
      expect(users[0]?.companyId.toString()).toBe(demoCompany._id.toString());

      expect(users[0]?.passwordHash).not.toBe(VALID_BODY.password);
      expect(users[0]?.passwordHash).toMatch(/^scrypt:/);

      const sessions = await Session.find({});
      expect(sessions).toHaveLength(0);
    });

    it("returns a response with no set-cookie header at all", async () => {
      const res = await registerWith(app, VALID_BODY);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("never returns the password or password hash", async () => {
      const res = await registerWith(app, VALID_BODY);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(VALID_BODY.password);
      expect(body).not.toMatch(/passwordHash/i);
      expect(body).not.toMatch(/scrypt:/);
    });

    it("lets the newly registered user log in afterwards", async () => {
      await registerWith(app, VALID_BODY);

      const loginRes = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
        email: "jane.customer@example.com",
        password: VALID_BODY.password,
      });

      expect(loginRes.status).toBe(200);
      const cookies = parseSetCookies(loginRes);
      expect(cookies["access_token"]).toBeDefined();
      expect(cookies["refresh_token"]).toBeDefined();
    });
  });

  describe("validation", () => {
    it.each([
      ["missing name", { ...VALID_BODY, name: undefined }],
      ["whitespace-only name", { ...VALID_BODY, name: "   " }],
      ["missing email", { ...VALID_BODY, email: undefined }],
      ["invalid email", { ...VALID_BODY, email: "not-an-email" }],
      ["missing phone", { ...VALID_BODY, phone: undefined }],
      ["invalid phone (letters)", { ...VALID_BODY, phone: "call-me-maybe" }],
      ["invalid phone (too short)", { ...VALID_BODY, phone: "123" }],
      ["missing password", { ...VALID_BODY, password: undefined }],
      ["too-short password", { ...VALID_BODY, password: "short1" }],
    ])("rejects %s with a VALIDATION_ERROR and creates no user", async (_label, body) => {
      const res = await registerWith(app, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(await User.countDocuments({})).toBe(0);
    });

    it("normalizes email case consistently", async () => {
      const res = await registerWith(app, { ...VALID_BODY, email: "MiXeD.CaSe@EXAMPLE.com" });
      expect(res.status).toBe(201);
      expect(res.body.data.user.email).toBe("mixed.case@example.com");
    });
  });

  describe("authorization tampering", () => {
    it("ignores a role=ADMIN field and still creates a CUSTOMER", async () => {
      const res = await registerWith(app, { ...VALID_BODY, role: "ADMIN" });
      expect(res.status).toBe(201);
      expect(res.body.data.user.role).toBe("CUSTOMER");

      const user = await User.findOne({ email: "jane.customer@example.com" });
      expect(user?.role).toBe("CUSTOMER");
    });

    it("ignores a role=TECHNICIAN field and still creates a CUSTOMER", async () => {
      const res = await registerWith(app, { ...VALID_BODY, role: "TECHNICIAN" });
      expect(res.status).toBe(201);
      expect(res.body.data.user.role).toBe("CUSTOMER");
    });

    it("ignores an arbitrary companyId field and still assigns the server-resolved demo company", async () => {
      const demoCompany = await ensureDemoCompany();
      const fakeCompanyId = "64b000000000000000000abc";

      const res = await registerWith(app, { ...VALID_BODY, companyId: fakeCompanyId });
      expect(res.status).toBe(201);
      expect(res.body.data.user.companyId).toBe(demoCompany._id.toString());
      expect(res.body.data.user.companyId).not.toBe(fakeCompanyId);
    });

    it("ignores other unknown/privileged fields entirely", async () => {
      const res = await registerWith(app, {
        ...VALID_BODY,
        isAdmin: true,
        isTechnician: true,
        permissions: ["*"],
        userId: "64b000000000000000000abc",
        accessToken: "forged",
      });
      expect(res.status).toBe(201);
      expect(res.body.data.user.role).toBe("CUSTOMER");

      const user = await User.findOne({ email: "jane.customer@example.com" });
      expect(user?.role).toBe("CUSTOMER");
    });
  });

  describe("duplicate email", () => {
    it("rejects a second registration with the same email", async () => {
      const first = await registerWith(app, VALID_BODY);
      expect(first.status).toBe(201);

      const second = await registerWith(app, VALID_BODY);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("CONFLICT");

      expect(await User.countDocuments({})).toBe(1);
    });

    it("treats different email casing as the same duplicate account", async () => {
      await registerWith(app, { ...VALID_BODY, email: "jane.customer@example.com" });
      const second = await registerWith(app, { ...VALID_BODY, email: "JANE.CUSTOMER@EXAMPLE.COM" });

      expect(second.status).toBe(409);
      expect(await User.countDocuments({})).toBe(1);
    });

    it("creates exactly one user when two identical registrations race each other", async () => {
      const [resA, resB] = await Promise.all([registerWith(app, VALID_BODY), registerWith(app, VALID_BODY)]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      expect(await User.countDocuments({ email: "jane.customer@example.com" })).toBe(1);
    });
  });

  describe("demo company unavailable", () => {
    it("fails safely and creates no user when the demo company is inactive", async () => {
      await ensureDemoCompany({ isActive: false });

      const res = await registerWith(app, VALID_BODY);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("DEMO_COMPANY_UNAVAILABLE");
      expect(await User.countDocuments({})).toBe(0);
    });

    it("fails safely and creates no user when the demo company does not exist", async () => {
      await ensureDemoCompany();
      await Company.deleteMany({});

      const res = await registerWith(app, VALID_BODY);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("DEMO_COMPANY_UNAVAILABLE");
      expect(await User.countDocuments({})).toBe(0);
    });
  });

  describe("throttling", () => {
    it("rejects further registrations from the same IP once the limit is exceeded", async () => {
      let lastStatus = 0;
      let lastBody: unknown;
      for (let i = 0; i < 6; i += 1) {
        const res = await registerWith(app, { ...VALID_BODY, email: `throttle-${i}@example.com` });
        lastStatus = res.status;
        lastBody = res.body;
      }

      expect(lastStatus).toBe(429);
      expect((lastBody as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    });
  });

  describe("response envelope / request id", () => {
    it("includes X-Request-Id on both success and error responses", async () => {
      const success = await registerWith(app, VALID_BODY);
      expect(success.headers["x-request-id"]).toBeDefined();

      const failure = await registerWith(app, { ...VALID_BODY, email: "not-an-email" });
      expect(failure.headers["x-request-id"]).toBeDefined();
      expect(failure.body.error.requestId).toBe(failure.headers["x-request-id"]);
    });
  });
});
