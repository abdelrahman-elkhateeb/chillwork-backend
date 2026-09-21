import { describe, expect, it } from "vitest";
import { AuthThrottle, recordAttempt } from "../src/modules/auth/auth-throttle.model.js";

describe("recordAttempt (shared MongoDB-backed throttle)", () => {
  it("increments a strictly increasing count within one window", async () => {
    const now = new Date();
    const key = `test:${now.getTime()}`;

    expect(await recordAttempt(key, 60_000, now)).toBe(1);
    expect(await recordAttempt(key, 60_000, now)).toBe(2);
    expect(await recordAttempt(key, 60_000, now)).toBe(3);
  });

  it("produces a correct total under concurrent calls (no lost updates)", async () => {
    const now = new Date();
    const key = `concurrent:${now.getTime()}`;

    const results = await Promise.all(Array.from({ length: 20 }, () => recordAttempt(key, 60_000, now)));

    expect(new Set(results).size).toBe(20); // every call got a distinct, strictly-increasing count
    expect(Math.max(...results)).toBe(20);

    const doc = await AuthThrottle.findOne({ key });
    expect(doc?.count).toBe(20);
  });

  it("starts a fresh count in a new time window", async () => {
    const key = `window:${Date.now()}`;
    const windowMs = 1000;
    const windowA = new Date(0);
    const windowB = new Date(windowMs * 5);

    expect(await recordAttempt(key, windowMs, windowA)).toBe(1);
    expect(await recordAttempt(key, windowMs, windowB)).toBe(1);
  });
});
