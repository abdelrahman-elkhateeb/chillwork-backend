import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import { cookieHeader, createCompany, createUser, parseSetCookies, PASSWORD, sameOriginRequest } from "./helpers.js";

async function login(app: ReturnType<typeof createApp>, email: string) {
  const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password: PASSWORD });
  return parseSetCookies(res);
}

describe("POST /api/v1/auth/logout", () => {
  it("revokes only the current session", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "logout@example.com" });
    const cookies = await login(app, "logout@example.com");

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/logout").set("Cookie", cookieHeader(cookies));

    expect(res.status).toBe(200);
    expect(res.body.data.loggedOut).toBe(true);

    const session = await Session.findOne({});
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.revokedReason).toBe("logout");
  });

  it("is idempotent — calling it twice does not error", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "logout-twice@example.com" });
    const cookies = await login(app, "logout-twice@example.com");

    const first = await sameOriginRequest(app, "post", "/api/v1/auth/logout").set("Cookie", cookieHeader(cookies));
    const second = await sameOriginRequest(app, "post", "/api/v1/auth/logout").set("Cookie", cookieHeader(cookies));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("succeeds even with no auth cookies at all", async () => {
    const app = createApp();
    const res = await sameOriginRequest(app, "post", "/api/v1/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body.data.loggedOut).toBe(true);
  });

  it("clears both auth cookies", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "logout-cookies@example.com" });
    const cookies = await login(app, "logout-cookies@example.com");

    const res = await sameOriginRequest(app, "post", "/api/v1/auth/logout").set("Cookie", cookieHeader(cookies));
    const cleared = parseSetCookies(res);
    expect(cleared["access_token"]).toBe("");
    expect(cleared["refresh_token"]).toBe("");
  });

  it("leaves another device's session untouched", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "logout-multi@example.com" });
    const deviceA = await login(app, "logout-multi@example.com");
    const deviceB = await login(app, "logout-multi@example.com");

    await sameOriginRequest(app, "post", "/api/v1/auth/logout").set("Cookie", cookieHeader(deviceA));

    const refreshB = await sameOriginRequest(app, "post", "/api/v1/auth/refresh").set("Cookie", cookieHeader(deviceB));
    expect(refreshB.status).toBe(200);
  });
});
