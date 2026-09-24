import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import { cookieHeader, createCompany, createUser, parseSetCookies, PASSWORD, sameOriginRequest } from "./helpers.js";

async function login(app: ReturnType<typeof createApp>, email: string) {
  const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password: PASSWORD });
  return parseSetCookies(res);
}

function getMe(app: ReturnType<typeof createApp>, cookies: Record<string, string>) {
  return request(app).get("/api/v1/auth/me").set("Cookie", cookieHeader(cookies));
}

describe("GET /api/v1/auth/me", () => {
  const app = createApp();

  it("returns the authenticated user's safe DTO, with the server-side role and companyId", async () => {
    const company = await createCompany();
    const user = await createUser(company._id, { email: "me@example.com", role: "ADMIN" });
    const cookies = await login(app, "me@example.com");

    const res = await getMe(app, cookies);

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      id: user._id.toString(),
      name: user.name,
      role: "ADMIN",
      companyId: company._id.toString(),
    });
  });

  it("never returns password, passwordHash, or any session/token field", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "safe@example.com" });
    const cookies = await login(app, "safe@example.com");

    const res = await getMe(app, cookies);
    const body = JSON.stringify(res.body);

    expect(body).not.toMatch(/passwordHash/i);
    expect(body).not.toMatch(/refreshToken/i);
    expect(body).not.toMatch(/currentTokenHash/i);
    expect(body).not.toMatch(/revokedAt/i);
  });

  it("rejects an unauthenticated request (no cookies at all)", async () => {
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a request whose session has been revoked", async () => {
    const company = await createCompany();
    await createUser(company._id, { email: "revoked-me@example.com" });
    const cookies = await login(app, "revoked-me@example.com");

    await Session.updateMany({}, { $set: { revokedAt: new Date(), revokedReason: "manual" } });

    const res = await getMe(app, cookies);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("ignores any client-supplied identity fields — identity comes only from the session", async () => {
    const company = await createCompany();
    const user = await createUser(company._id, { email: "trusted@example.com", role: "CUSTOMER" });
    const cookies = await login(app, "trusted@example.com");

    // A client can't influence /me via query string or body — GET has no
    // body, but query params are the equivalent surface for a GET route.
    const res = await request(app)
      .get("/api/v1/auth/me?userId=000000000000000000000000&role=ADMIN&companyId=000000000000000000000000")
      .set("Cookie", cookieHeader(cookies));

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user._id.toString());
    expect(res.body.data.user.role).toBe("CUSTOMER");
    expect(res.body.data.user.companyId).toBe(company._id.toString());
  });

  describe("session restoration (login -> /me)", () => {
    it("restores the same authenticated identity /me would have returned right after login", async () => {
      const company = await createCompany();
      const user = await createUser(company._id, { email: "restore@example.com", role: "TECHNICIAN" });

      const cookies = await login(app, "restore@example.com");
      const meRes = await getMe(app, cookies);

      expect(meRes.status).toBe(200);
      expect(meRes.body.data.user).toMatchObject({
        id: user._id.toString(),
        role: "TECHNICIAN",
        companyId: company._id.toString(),
      });
    });

    it("keeps two devices' sessions independent through /me", async () => {
      const company = await createCompany();
      await createUser(company._id, { email: "two-device@example.com" });

      const deviceA = await login(app, "two-device@example.com");
      const deviceB = await login(app, "two-device@example.com");

      await sameOriginRequest(app, "post", "/api/v1/auth/logout").set("Cookie", cookieHeader(deviceA));

      const meA = await getMe(app, deviceA);
      const meB = await getMe(app, deviceB);

      expect(meA.status).toBe(401);
      expect(meB.status).toBe(200);
    });
  });
});
