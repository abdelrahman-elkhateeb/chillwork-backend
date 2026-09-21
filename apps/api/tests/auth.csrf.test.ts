import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { TEST_HOST, TEST_ORIGIN } from "./helpers.js";

describe("CSRF / origin protection", () => {
  const app = createApp();

  it("rejects a state-changing request with no Origin or Referer header", async () => {
    const res = await request(app).post("/api/v1/auth/logout").set("Host", TEST_HOST);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_ORIGIN_REJECTED");
  });

  it("rejects a state-changing request from a disallowed origin", async () => {
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .set("Host", TEST_HOST)
      .set("Origin", "http://evil-attacker.example.com");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_ORIGIN_REJECTED");
  });

  it("accepts a state-changing request whose Origin matches the request's own host", async () => {
    const res = await request(app).post("/api/v1/auth/logout").set("Host", TEST_HOST).set("Origin", TEST_ORIGIN);
    // Passed the CSRF guard; reaches the (idempotent, no-cookie) logout
    // handler rather than being rejected at 403.
    expect(res.status).toBe(200);
  });

  it("accepts a state-changing request from an explicitly configured allowed origin", async () => {
    const res = await request(app)
      .post("/api/v1/auth/logout")
      .set("Host", TEST_HOST)
      .set("Origin", "http://allowed-origin.example.com");
    expect(res.status).toBe(200);
  });

  it("does not apply the origin check to safe GET requests", async () => {
    const res = await request(app).get("/api/v1/health").set("Host", TEST_HOST);
    expect(res.status).toBe(200);
  });
});
