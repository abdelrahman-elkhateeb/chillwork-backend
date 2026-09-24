import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import {
  createCompany,
  createUser,
  findRawSetCookie,
  parseSetCookies,
  PASSWORD,
  sameOriginRequest,
} from "./helpers.js";

describe("POST /api/v1/auth/login", () => {
  const app = createApp();

  it("creates an independent server-side session and returns safe user info", async () => {
    const company = await createCompany();
    const user = await createUser(company._id, { email: "alice@example.com" });

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "alice@example.com",
      password: PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: user._id.toString(), email: "alice@example.com" });
    expect(res.body.data.session.id).toBeDefined();

    const sessions = await Session.find({ userId: user._id });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.revokedAt).toBeNull();
  });

  it("rejects an unknown email and a wrong password identically, and creates no session", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "bob@example.com" });

    const unknown = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "nobody@example.com",
      password: "whatever",
    });
    const wrongPassword = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "bob@example.com",
      password: "wrong-password",
    });

    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");

    expect(await Session.countDocuments({})).toBe(0);
    expect(JSON.stringify(unknown.body)).not.toMatch(/passwordHash|scrypt:/i);
    expect(JSON.stringify(wrongPassword.body)).not.toMatch(/passwordHash|scrypt:/i);
  });

  it("rejects login for an inactive user without revealing why, and creates no session", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "inactive@example.com", isActive: false });

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "inactive@example.com",
      password: PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(await Session.countDocuments({})).toBe(0);
  });

  it("rejects login for a user in an inactive company without revealing why, and creates no session", async () => {
    const company = await createCompany({ isActive: false });
    await createUser(company._id, { email: "inactive-company@example.com" });

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "inactive-company@example.com",
      password: PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(await Session.countDocuments({})).toBe(0);
  });

  it.each(["CUSTOMER", "ADMIN", "TECHNICIAN"] as const)("lets a %s user log in and returns their server-side role", async (role) => {
    const company = await createCompany();
    await createUser(company._id, { email: `${role.toLowerCase()}@example.com`, role });

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: `${role.toLowerCase()}@example.com`,
      password: PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe(role);
  });

  it("sets HttpOnly cookies and never returns the refresh token in JSON", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "carol@example.com" });

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "carol@example.com",
      password: PASSWORD,
    });

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/refresh/i);
    expect(body).not.toContain("passwordHash");

    const refreshCookie = findRawSetCookie(res, "refresh_token");
    const accessCookie = findRawSetCookie(res, "access_token");
    expect(refreshCookie).toBeDefined();
    expect(accessCookie).toBeDefined();
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(accessCookie).toMatch(/HttpOnly/i);
    // FS01 requires no Domain attribute on auth cookies.
    expect(refreshCookie).not.toMatch(/domain=/i);
    expect(accessCookie).not.toMatch(/domain=/i);
    expect(refreshCookie).toMatch(/path=\/api\/v1\/auth/i);
  });

  it("persists only a hash of the refresh token, never the raw value", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "dave@example.com" });

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "dave@example.com",
      password: PASSWORD,
    });

    const cookies = parseSetCookies(res);
    const rawRefreshToken = decodeURIComponent(cookies["refresh_token"] ?? "");
    expect(rawRefreshToken.length).toBeGreaterThan(20);

    const session = await Session.findOne({});
    expect(session).not.toBeNull();
    expect(session?.currentTokenHash).not.toBe(rawRefreshToken);
    expect(session?.currentTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("gives each login its own independent session (multi-device)", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "erin@example.com" });

    const loginA = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "erin@example.com",
      password: PASSWORD,
    });
    const loginB = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "erin@example.com",
      password: PASSWORD,
    });

    expect(loginA.body.data.session.id).not.toBe(loginB.body.data.session.id);

    const sessions = await Session.find({});
    expect(sessions).toHaveLength(2);
  });
});

describe("login throttling", () => {
  it("rejects further attempts once the per-account+IP limit is exceeded", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "throttled@example.com" });

    let lastStatus = 0;
    let lastBody: unknown;
    for (let i = 0; i < 6; i += 1) {
      const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
        email: "throttled@example.com",
        password: "wrong-password",
      });
      lastStatus = res.status;
      lastBody = res.body;
    }

    expect(lastStatus).toBe(429);
    expect((lastBody as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });
});

describe("login event logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a safe success event with no credentials, tokens, or raw email", async () => {
    const app = createApp();
    const company = await createCompany();
    const user = await createUser(company._id, { email: "logged-success@example.com" });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "logged-success@example.com",
      password: PASSWORD,
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [event] = infoSpy.mock.calls[0] as [Record<string, unknown>];
    expect(event).toMatchObject({ event: "auth.login", outcome: "success", userId: user._id.toString() });

    const logged = JSON.stringify(event);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain("logged-success@example.com");
    expect(logged).not.toMatch(/passwordHash|scrypt:|refresh_token|access_token/i);
  });

  it("logs a safe failure event with no credentials, tokens, raw email, or manufactured identity", async () => {
    const app = createApp();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await sameOriginRequest(app, "post", "/api/v1/auth/login").send({
      email: "never-registered@example.com",
      password: "whatever-they-typed",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [event] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(event).toMatchObject({ event: "auth.login", outcome: "failure" });
    expect(event).not.toHaveProperty("userId");
    expect(event).not.toHaveProperty("companyId");

    const logged = JSON.stringify(event);
    expect(logged).not.toContain("whatever-they-typed");
    expect(logged).not.toContain("never-registered@example.com");
  });

  it("does not log a login event for a request-validation failure (no credential check ran)", async () => {
    const app = createApp();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
