import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { Session } from "../src/modules/auth/session.model.js";
import { User } from "../src/modules/users/user.model.js";
import { cookieHeader, createCompany, createUser, parseSetCookies, PASSWORD, sameOriginRequest } from "./helpers.js";

async function login(app: ReturnType<typeof createApp>, email: string) {
  const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password: PASSWORD });
  return parseSetCookies(res);
}

function refreshWith(app: ReturnType<typeof createApp>, cookies: Record<string, string>) {
  return sameOriginRequest(app, "post", "/api/v1/auth/refresh").set("Cookie", cookieHeader(cookies));
}

describe("POST /api/v1/auth/refresh", () => {
  it("rotates the refresh token on a valid request", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "rotate@example.com" });
    const cookies = await login(app, "rotate@example.com");

    const res = await refreshWith(app, cookies);
    expect(res.status).toBe(200);

    const newCookies = parseSetCookies(res);
    expect(newCookies["refresh_token"]).toBeDefined();
    expect(newCookies["refresh_token"]).not.toBe(cookies["refresh_token"]);

    const session = await Session.findOne({});
    expect(session?.previousTokenHash).not.toBeNull();
  });

  it("rejects the old token once it's outside the grace window (normal sequential reuse)", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "old-token@example.com" });
    const cookies = await login(app, "old-token@example.com");

    await refreshWith(app, cookies); // rotates away from `cookies`
    await Session.updateMany({}, { $set: { previousTokenExpiresAt: new Date(Date.now() - 1000) } });

    const res = await refreshWith(app, cookies);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    const session = await Session.findOne({});
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.revokedReason).toBe("reuse_detected");
  });

  it("rejects an unknown/malformed refresh token", async () => {
    const app = createApp();
    const res = await refreshWith(app, { refresh_token: "not-a-real-token" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejects refresh with no refresh cookie", async () => {
    const app = createApp();
    const res = await sameOriginRequest(app, "post", "/api/v1/auth/refresh");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejects refresh once the session has been revoked", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "revoked-refresh@example.com" });
    const cookies = await login(app, "revoked-refresh@example.com");

    await Session.updateMany({}, { $set: { revokedAt: new Date(), revokedReason: "manual" } });

    const res = await refreshWith(app, cookies);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_REVOKED");
  });

  it("rejects refresh once the session has expired", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "expired-refresh@example.com" });
    const cookies = await login(app, "expired-refresh@example.com");

    await Session.updateMany({}, { $set: { rollingExpiresAt: new Date(Date.now() - 1000) } });

    const res = await refreshWith(app, cookies);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("rejects refresh for a now-inactive user", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "inactive-refresh@example.com" });
    const cookies = await login(app, "inactive-refresh@example.com");

    await User.updateMany({}, { $set: { isActive: false } });

    const res = await refreshWith(app, cookies);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("absolute expiry boundary (login=day0, refresh=day29)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps the new rolling expiry at day 30, never extending past the absolute expiry", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "boundary@example.com" });
    const cookies = await login(app, "boundary@example.com");

    const session = await Session.findOne({});
    expect(session).not.toBeNull();
    const loginAt = session!.loginAt;
    const absoluteExpiresAt = session!.absoluteExpiresAt;
    expect(absoluteExpiresAt.getTime() - loginAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);

    // A session kept alive by periodic refreshes would have its rolling
    // window sitting a bit ahead of "now" by day 29; simulate that (the
    // original 7-day window from day 0 would otherwise have already
    // lapsed by day 7, long before this test's day-29 refresh).
    const day29 = new Date(loginAt.getTime() + 29 * 24 * 60 * 60 * 1000);
    await Session.updateOne({ _id: session!._id }, { $set: { rollingExpiresAt: new Date(day29.getTime() + 60_000) } });

    // Actually advance the clock to day 29 (only Date is faked — timers
    // driving the MongoDB driver stay real) so refresh()'s `now` reflects
    // it, not just the session's stored fields.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(day29);

    const res = await refreshWith(app, cookies);
    expect(res.status).toBe(200);

    const rotated = await Session.findOne({});
    // day 29 + 7 rolling days = day 36, which is past the day-30 absolute
    // cutoff, so the new rolling expiry must equal the absolute expiry,
    // not day 36.
    expect(rotated!.rollingExpiresAt.getTime()).toBe(absoluteExpiresAt.getTime());
  });

  it("rejects refresh once the absolute 30-day expiry has actually passed", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "past-absolute@example.com" });
    const cookies = await login(app, "past-absolute@example.com");

    await Session.updateMany(
      {},
      {
        $set: {
          absoluteExpiresAt: new Date(Date.now() - 1000),
          rollingExpiresAt: new Date(Date.now() + 1000),
        },
      }
    );

    const res = await refreshWith(app, cookies);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_EXPIRED");
  });
});

describe("concurrent refresh policy", () => {
  it("lets two near-simultaneous refreshes with the same token both succeed without logging the user out", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "concurrent@example.com" });
    const cookies = await login(app, "concurrent@example.com");

    const [resA, resB] = await Promise.all([refreshWith(app, cookies), refreshWith(app, cookies)]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const session = await Session.findOne({});
    expect(session?.revokedAt).toBeNull();

    // Whichever response's cookie the browser ends up keeping, it must
    // still work for the next refresh.
    const latestCookies = parseSetCookies(resB);
    const followUp = await refreshWith(app, latestCookies);
    expect(followUp.status).toBe(200);
  });

  it("detects genuine reuse of the immediately-prior token once its grace window has elapsed", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "reuse@example.com" });
    const originalCookies = await login(app, "reuse@example.com");

    const firstRefresh = await refreshWith(app, originalCookies);
    expect(firstRefresh.status).toBe(200);
    const rotatedCookies = parseSetCookies(firstRefresh);

    // Force the grace window on the now-superseded original token to have
    // elapsed, then replay it.
    await Session.updateMany({}, { $set: { previousTokenExpiresAt: new Date(Date.now() - 1000) } });

    const replay = await refreshWith(app, originalCookies);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    const session = await Session.findOne({});
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.revokedReason).toBe("reuse_detected");

    // The device that legitimately holds the latest (rotated) token is
    // also now locked out, since reuse revokes the whole session — that's
    // the documented, deliberate tradeoff (see docs/api.md).
    const afterRevocation = await refreshWith(app, rotatedCookies);
    expect(afterRevocation.status).toBe(401);
  });

  it("treats a token from two or more rotations ago as unknown rather than authenticating it", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "stale-token@example.com" });
    const originalCookies = await login(app, "stale-token@example.com");

    const firstRefresh = await refreshWith(app, originalCookies);
    const rotatedCookies = parseSetCookies(firstRefresh);
    const secondRefresh = await refreshWith(app, rotatedCookies);
    expect(secondRefresh.status).toBe(200);

    // `originalCookies` is now two generations stale — no longer stored as
    // either the current or the previous token, so it can't be recognized
    // as this session's history at all. It must still be rejected, just
    // without the extra reuse-triggered revocation (see docs/api.md
    // "Concurrent refresh policy" for the documented depth-1 bound).
    const replay = await refreshWith(app, originalCookies);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("INVALID_REFRESH_TOKEN");

    const session = await Session.findOne({});
    expect(session?.revokedAt).toBeNull();
  });

  it("does not revoke an unrelated session on a different device when one is reused", async () => {
    const app = createApp();
    const company = await createCompany();
    await createUser(company._id, { email: "multi-device-reuse@example.com" });
    const deviceACookies = await login(app, "multi-device-reuse@example.com");
    const deviceBCookies = await login(app, "multi-device-reuse@example.com");

    await refreshWith(app, deviceACookies);
    const sessions = await Session.find({});
    // Device A has refreshed once (previousTokenHash set); device B hasn't.
    const deviceASession = sessions.find((s) => s.previousTokenHash !== null);

    // Force device A's grace window to elapse, then replay its original
    // (now stale) token.
    await Session.updateOne({ _id: deviceASession!._id }, { $set: { previousTokenExpiresAt: new Date(Date.now() - 1000) } });
    const replay = await refreshWith(app, deviceACookies);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    // Device B must be completely unaffected.
    const deviceBRefresh = await refreshWith(app, deviceBCookies);
    expect(deviceBRefresh.status).toBe(200);
  });
});
