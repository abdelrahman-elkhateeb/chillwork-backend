import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import { User } from "../src/modules/users/user.model.js";
import { Company } from "../src/modules/companies/company.model.js";
import { createProtectedTestApp } from "./test-app.js";
import { cookieHeader, createCompany, createUser, parseSetCookies, PASSWORD, sameOriginRequest } from "./helpers.js";

async function loginAndGetCookies(app: ReturnType<typeof createApp>, email: string) {
  const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password: PASSWORD });
  return parseSetCookies(res);
}

describe("protected request server-side validation", () => {
  const app = createApp();
  const protectedApp = createProtectedTestApp();

  it("allows a request with a valid JWT and an active session", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "valid@example.com" });
    const cookies = await loginAndGetCookies(app, "valid@example.com");

    const res = await request(protectedApp)
      .get("/api/v1/_test/protected")
      .set("Cookie", cookieHeader(cookies));

    expect(res.status).toBe(200);
  });

  it("rejects a valid JWT whose session has been revoked (revocation beats JWT expiry)", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "revoked@example.com" });
    const cookies = await loginAndGetCookies(app, "revoked@example.com");

    await Session.updateMany({}, { $set: { revokedAt: new Date(), revokedReason: "manual" } });

    const res = await request(protectedApp)
      .get("/api/v1/_test/protected")
      .set("Cookie", cookieHeader(cookies));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("rejects a valid JWT once the rolling expiry has passed", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "rolling-expired@example.com" });
    const cookies = await loginAndGetCookies(app, "rolling-expired@example.com");

    await Session.updateMany({}, { $set: { rollingExpiresAt: new Date(Date.now() - 1000) } });

    const res = await request(protectedApp)
      .get("/api/v1/_test/protected")
      .set("Cookie", cookieHeader(cookies));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("rejects a valid JWT once the absolute expiry has passed", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "absolute-expired@example.com" });
    const cookies = await loginAndGetCookies(app, "absolute-expired@example.com");

    await Session.updateMany(
      {},
      { $set: { absoluteExpiresAt: new Date(Date.now() - 1000), rollingExpiresAt: new Date(Date.now() + 1000) } }
    );

    const res = await request(protectedApp)
      .get("/api/v1/_test/protected")
      .set("Cookie", cookieHeader(cookies));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("rejects a valid JWT for a now-inactive user", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "deactivated@example.com" });
    const cookies = await loginAndGetCookies(app, "deactivated@example.com");

    await User.updateMany({}, { $set: { isActive: false } });

    const res = await request(protectedApp)
      .get("/api/v1/_test/protected")
      .set("Cookie", cookieHeader(cookies));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a valid JWT once the user's company is no longer valid", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "company-invalid@example.com" });
    const cookies = await loginAndGetCookies(app, "company-invalid@example.com");

    await Company.updateMany({}, { $set: { isActive: false } });

    const res = await request(protectedApp)
      .get("/api/v1/_test/protected")
      .set("Cookie", cookieHeader(cookies));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects requests with no auth cookie at all", async () => {
    const res = await request(protectedApp).get("/api/v1/_test/protected");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});
