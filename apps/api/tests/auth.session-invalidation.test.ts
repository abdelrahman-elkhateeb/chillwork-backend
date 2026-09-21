import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { revokeAllUserSessions } from "../src/modules/auth/auth.service.js";
import { Session } from "../src/modules/auth/session.model.js";
import { cookieHeader, createCompany, createUser, parseSetCookies, PASSWORD, sameOriginRequest } from "./helpers.js";

async function login(app: ReturnType<typeof createApp>, email: string) {
  const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password: PASSWORD });
  return parseSetCookies(res);
}

/**
 * FS02 spec: no password-reset feature exists yet in this repo, so this
 * covers the reusable invalidation primitive itself
 * (`revokeAllUserSessions`) that a future password-reset/security-event
 * feature is expected to call — see docs/api.md "Session invalidation".
 */
describe("revokeAllUserSessions", () => {
  it("revokes every active session for a user across all their devices", async () => {
    const app = createApp();
    const company = await createCompany();
    const user = await createUser(company._id, { email: "reset@example.com" });
    const deviceA = await login(app, "reset@example.com");
    const deviceB = await login(app, "reset@example.com");

    await revokeAllUserSessions(user._id, "password_reset");

    const sessions = await Session.find({ userId: user._id });
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.revokedAt).not.toBeNull();
      expect(session.revokedReason).toBe("password_reset");
    }

    const refreshA = await sameOriginRequest(app, "post", "/api/v1/auth/refresh").set("Cookie", cookieHeader(deviceA));
    const refreshB = await sameOriginRequest(app, "post", "/api/v1/auth/refresh").set("Cookie", cookieHeader(deviceB));
    expect(refreshA.status).toBe(401);
    expect(refreshB.status).toBe(401);
  });

  it("does not affect another user's sessions", async () => {
    const app = createApp();
    const company = await createCompany();
    const userA = await createUser(company._id, { email: "user-a@example.com" });
    await createUser(company._id, { email: "user-b@example.com" });
    await login(app, "user-a@example.com");
    const userBCookies = await login(app, "user-b@example.com");

    await revokeAllUserSessions(userA._id, "manual");

    const refreshB = await sameOriginRequest(app, "post", "/api/v1/auth/refresh").set(
      "Cookie",
      cookieHeader(userBCookies)
    );
    expect(refreshB.status).toBe(200);
  });
});
