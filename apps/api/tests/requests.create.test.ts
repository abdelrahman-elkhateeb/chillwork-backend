import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { RequestIdempotency } from "../src/modules/requests/request-idempotency.model.js";
import { ServiceRequest } from "../src/modules/requests/request.model.js";
import {
  cookieHeader,
  createCompany,
  createUser,
  PASSWORD,
  sameOriginRequest,
  parseSetCookies,
} from "./helpers.js";

async function loginAs(app: ReturnType<typeof createApp>, email: string) {
  const res = await sameOriginRequest(app, "post", "/api/v1/auth/login").send({ email, password: PASSWORD });
  return parseSetCookies(res);
}

interface DeviceOverrides {
  clientDeviceId?: string;
  label?: string;
  brand?: string;
  model?: string;
  originalDescription?: string;
  photoIds?: unknown[];
}

function device(overrides: DeviceOverrides = {}) {
  return {
    clientDeviceId: overrides.clientDeviceId ?? `device-${randomUUID()}`,
    label: "Refrigerator",
    originalDescription: "Not cooling properly and making a buzzing noise.",
    ...overrides,
  };
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    address: "123 Main St, Springfield",
    contactPhone: "+1 555 000 1111",
    devices: [device()],
    ...overrides,
  };
}

function postRequests(
  app: ReturnType<typeof createApp>,
  cookies: Record<string, string>,
  options: { idempotencyKey?: string | null } = {}
) {
  let req = sameOriginRequest(app, "post", "/api/v1/requests").set("Cookie", cookieHeader(cookies));
  const key = options.idempotencyKey === undefined ? randomUUID() : options.idempotencyKey;
  if (key !== null) {
    req = req.set("Idempotency-Key", key);
  }
  return req;
}

function geminiHttpResponse(outputText: string, status = 200): Response {
  return new Response(JSON.stringify({ interaction: { output_text: outputText } }), { status });
}

function validOutputFor(devices: Array<{ clientDeviceId: string }>) {
  return {
    devices: devices.map((d) => ({
      clientDeviceId: d.clientDeviceId,
      summary: `Summary for ${d.clientDeviceId}`,
      possibleCauses: ["Cause A"],
      missingInformation: ["Missing A"],
      inspectionQuestions: ["Question A"],
    })),
  };
}

/** A fresh Response per call — a Response body can only be read once. */
function mockGeminiSuccess(devices: Array<{ clientDeviceId: string }>) {
  const fetchMock = vi.fn().mockImplementation(() => geminiHttpResponse(JSON.stringify(validOutputFor(devices))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockGeminiResponse(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setupCustomer(app: ReturnType<typeof createApp>, overrides: { email?: string } = {}) {
  const company = await createCompany();
  const email = overrides.email ?? `customer-${randomUUID()}@example.com`;
  await createUser(company._id, { email, role: "CUSTOMER" });
  const cookies = await loginAs(app, email);
  return { company, cookies, email };
}

describe("POST /api/v1/requests — authentication & role", () => {
  const app = createApp();

  it("rejects an unauthenticated request", async () => {
    const res = await postRequests(app, {}).send(requestBody());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("allows an authenticated CUSTOMER", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    mockGeminiSuccess(body.devices);

    const res = await postRequests(app, cookies).send(body);

    expect(res.status).toBe(201);
  });

  it("rejects an ADMIN (customer-only endpoint)", async () => {
    const company = await createCompany();
    const email = `admin-${randomUUID()}@example.com`;
    await createUser(company._id, { email, role: "ADMIN" });
    const cookies = await loginAs(app, email);

    const res = await postRequests(app, cookies).send(requestBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects a TECHNICIAN (customer-only endpoint)", async () => {
    const company = await createCompany();
    const email = `tech-${randomUUID()}@example.com`;
    await createUser(company._id, { email, role: "TECHNICIAN" });
    const cookies = await loginAs(app, email);

    const res = await postRequests(app, cookies).send(requestBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("preserves CSRF/origin protection on this route", async () => {
    const { cookies } = await setupCustomer(app);

    const res = await request(app)
      .post("/api/v1/requests")
      .set("Cookie", cookieHeader(cookies))
      .set("Idempotency-Key", randomUUID())
      .send(requestBody());

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_ORIGIN_REJECTED");
  });
});

describe("POST /api/v1/requests — validation", () => {
  const app = createApp();

  it.each([
    ["missing address", requestBody({ address: undefined })],
    ["invalid contactPhone", requestBody({ contactPhone: "not-a-phone" })],
    ["zero devices", requestBody({ devices: [] })],
    ["too many devices", requestBody({ devices: Array.from({ length: 11 }, () => device()) })],
    ["missing clientDeviceId", requestBody({ devices: [device({ clientDeviceId: undefined })] })],
    [
      "duplicate clientDeviceId",
      requestBody({ devices: [device({ clientDeviceId: "dup" }), device({ clientDeviceId: "dup" })] }),
    ],
    ["oversized description", requestBody({ devices: [device({ originalDescription: "x".repeat(4001) })] })],
  ])("rejects %s with VALIDATION_ERROR and creates no request", async (_label, body) => {
    const { cookies } = await setupCustomer(app);
    const res = await postRequests(app, cookies).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await ServiceRequest.countDocuments({})).toBe(0);
  });

  it("silently strips unknown fields rather than erroring", async () => {
    const { cookies } = await setupCustomer(app);
    const body = { ...requestBody(), isAdmin: true, priority: "URGENT" };
    mockGeminiSuccess(body.devices as Array<{ clientDeviceId: string }>);

    const res = await postRequests(app, cookies).send(body);
    expect(res.status).toBe(201);
  });
});

describe("POST /api/v1/requests — Idempotency-Key header", () => {
  const app = createApp();

  it("rejects a missing Idempotency-Key header", async () => {
    const { cookies } = await setupCustomer(app);
    const res = await postRequests(app, cookies, { idempotencyKey: null }).send(requestBody());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("rejects an invalid Idempotency-Key header", async () => {
    const { cookies } = await setupCustomer(app);
    const res = await postRequests(app, cookies, { idempotencyKey: "has a space" }).send(requestBody());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
  });
});

describe("POST /api/v1/requests — photo attachments (cancelled for the MVP)", () => {
  const app = createApp();

  it("strips a legacy photoIds field instead of rejecting the request", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody({ devices: [device({ photoIds: ["photo-1"] })] });
    mockGeminiSuccess(body.devices as Array<{ clientDeviceId: string }>);

    const res = await postRequests(app, cookies).send(body);

    expect(res.status).toBe(201);
    const stored = await ServiceRequest.findOne({}).lean();
    expect(stored?.devices[0]).not.toHaveProperty("photoIds");
  });
});

describe("POST /api/v1/requests — authorization / tenant scope", () => {
  const app = createApp();

  it("ignores a client-supplied companyId/customerId and uses the authenticated identity", async () => {
    const { cookies, company } = await setupCustomer(app);
    const body = {
      ...requestBody(),
      companyId: "000000000000000000000000",
      customerId: "000000000000000000000000",
    };
    mockGeminiSuccess(body.devices);

    const res = await postRequests(app, cookies).send(body);
    expect(res.status).toBe(201);

    const stored = await ServiceRequest.findOne({});
    expect(stored?.companyId.toString()).toBe(company._id.toString());
    expect(stored?.companyId.toString()).not.toBe("000000000000000000000000");
  });
});

describe("POST /api/v1/requests — Gemini integration (FS14)", () => {
  const app = createApp();

  it("persists a successful analysis per device", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    mockGeminiSuccess(body.devices);

    const res = await postRequests(app, cookies).send(body);
    expect(res.status).toBe(201);

    const stored = await ServiceRequest.findOne({});
    const storedDevice = stored?.devices[0];
    expect(storedDevice?.analysisMetadata.status).toBe("SUCCESS");
    expect(storedDevice?.analysis?.summary).toBeDefined();
  });

  it("correlates multiple devices by clientDeviceId regardless of provider response order", async () => {
    const { cookies } = await setupCustomer(app);
    const devices = [device({ clientDeviceId: "A" }), device({ clientDeviceId: "B" }), device({ clientDeviceId: "C" })];
    const outOfOrder = {
      devices: [
        { clientDeviceId: "C", summary: "S-C", possibleCauses: [], missingInformation: [], inspectionQuestions: [] },
        { clientDeviceId: "A", summary: "S-A", possibleCauses: [], missingInformation: [], inspectionQuestions: [] },
        { clientDeviceId: "B", summary: "S-B", possibleCauses: [], missingInformation: [], inspectionQuestions: [] },
      ],
    };
    mockGeminiResponse(geminiHttpResponse(JSON.stringify(outOfOrder)));

    const res = await postRequests(app, cookies).send(requestBody({ devices }));
    expect(res.status).toBe(201);

    const stored = await ServiceRequest.findOne({});
    expect(stored?.devices.find((d) => d.clientDeviceId === "A")?.analysis?.summary).toBe("S-A");
    expect(stored?.devices.find((d) => d.clientDeviceId === "B")?.analysis?.summary).toBe("S-B");
    expect(stored?.devices.find((d) => d.clientDeviceId === "C")?.analysis?.summary).toBe("S-C");
  });

  it("keeps original descriptions byte-for-byte unchanged", async () => {
    const { cookies } = await setupCustomer(app);
    const weird = "  Fridge \n won't turn on!!   \t";
    const body = requestBody({ devices: [device({ originalDescription: weird })] });
    mockGeminiSuccess(body.devices);

    const res = await postRequests(app, cookies).send(body);
    expect(res.status).toBe(201);

    const stored = await ServiceRequest.findOne({});
    expect(stored?.devices[0]?.originalDescription).toBe(weird);
  });

  it("still creates the request when Gemini times out", async () => {
    const { cookies } = await setupCustomer(app);
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { env } = await import("../src/config/env.js");
    const originalTimeout = env.GEMINI_TIMEOUT_MS;
    env.GEMINI_TIMEOUT_MS = 20;
    try {
      const res = await postRequests(app, cookies).send(requestBody());
      expect(res.status).toBe(201);

      const stored = await ServiceRequest.findOne({});
      expect(stored?.devices[0]?.analysisMetadata.status).toBe("UNAVAILABLE");
      expect(stored?.devices[0]?.analysisMetadata.errorCode).toBe("GEMINI_TIMEOUT");
      expect(stored?.devices[0]?.analysis).toBeNull();
      expect(stored?.address).toBe("123 Main St, Springfield");
    } finally {
      env.GEMINI_TIMEOUT_MS = originalTimeout;
    }
  });

  it("still creates the request when Gemini returns 429", async () => {
    const { cookies } = await setupCustomer(app);
    mockGeminiResponse(new Response("quota", { status: 429 }));

    const res = await postRequests(app, cookies).send(requestBody());
    expect(res.status).toBe(201);

    const stored = await ServiceRequest.findOne({});
    expect(stored?.devices[0]?.analysisMetadata.status).toBe("UNAVAILABLE");
    expect(stored?.devices[0]?.analysisMetadata.errorCode).toBe("GEMINI_QUOTA_EXCEEDED");
  });

  it("still creates the request when Gemini returns malformed output", async () => {
    const { cookies } = await setupCustomer(app);
    mockGeminiResponse(geminiHttpResponse("{not valid json"));

    const res = await postRequests(app, cookies).send(requestBody());
    expect(res.status).toBe(201);

    const stored = await ServiceRequest.findOne({});
    expect(stored?.devices[0]?.analysisMetadata.status).toBe("FAILED");
    expect(stored?.devices[0]?.analysisMetadata.errorCode).toBe("GEMINI_INVALID_OUTPUT");
    expect(stored?.devices[0]?.analysis).toBeNull();
  });

  it("calls the Gemini provider exactly once for one successful submission", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    const fetchMock = mockGeminiSuccess(body.devices);

    await postRequests(app, cookies).send(body);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/v1/requests — idempotency", () => {
  const app = createApp();

  it("creates exactly one request for a first submission", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    mockGeminiSuccess(body.devices);

    const res = await postRequests(app, cookies).send(body);
    expect(res.status).toBe(201);
    expect(await ServiceRequest.countDocuments({})).toBe(1);
  });

  it("returns the existing request for the same key + same payload, without calling Gemini again", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    const key = randomUUID();
    const fetchMock = mockGeminiSuccess(body.devices);

    const first = await postRequests(app, cookies, { idempotencyKey: key }).send(body);
    expect(first.status).toBe(201);

    const second = await postRequests(app, cookies, { idempotencyKey: key }).send(body);
    expect(second.status).toBe(200);
    expect(second.body.data.requestId).toBe(first.body.data.requestId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ServiceRequest.countDocuments({})).toBe(1);
  });

  it("simulates a lost response — retrying after a successful-but-unseen creation returns the same request", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    const key = randomUUID();
    mockGeminiSuccess(body.devices);

    const created = await postRequests(app, cookies, { idempotencyKey: key }).send(body);
    expect(created.status).toBe(201);
    // Simulates the client never having seen `created`'s response and retrying.
    const retried = await postRequests(app, cookies, { idempotencyKey: key }).send(body);

    expect(retried.status).toBe(200);
    expect(retried.body.data.requestId).toBe(created.body.data.requestId);
    expect(await ServiceRequest.countDocuments({})).toBe(1);
  });

  it("isolates the same Idempotency-Key across different customers", async () => {
    const key = randomUUID();
    const customerA = await setupCustomer(app);
    const customerB = await setupCustomer(app);
    const bodyA = requestBody();
    const bodyB = requestBody();

    mockGeminiSuccess(bodyA.devices);
    const resA = await postRequests(app, customerA.cookies, { idempotencyKey: key }).send(bodyA);
    expect(resA.status).toBe(201);

    mockGeminiSuccess(bodyB.devices);
    const resB = await postRequests(app, customerB.cookies, { idempotencyKey: key }).send(bodyB);
    expect(resB.status).toBe(201);

    expect(resA.body.data.requestId).not.toBe(resB.body.data.requestId);
    expect(await ServiceRequest.countDocuments({})).toBe(2);
  });

  it("rejects the same key reused with a different payload", async () => {
    const { cookies } = await setupCustomer(app);
    const key = randomUUID();
    const bodyA = requestBody({ address: "111 First St" });
    mockGeminiSuccess(bodyA.devices);
    const first = await postRequests(app, cookies, { idempotencyKey: key }).send(bodyA);
    expect(first.status).toBe(201);

    const bodyB = requestBody({ address: "222 Second St" });
    const second = await postRequests(app, cookies, { idempotencyKey: key }).send(bodyB);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await ServiceRequest.countDocuments({})).toBe(1);
  });

  it("handles two near-simultaneous requests with the same key: exactly one created, Gemini called once", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    const key = randomUUID();
    const fetchMock = mockGeminiSuccess(body.devices);

    const [resA, resB] = await Promise.all([
      postRequests(app, cookies, { idempotencyKey: key }).send(body),
      postRequests(app, cookies, { idempotencyKey: key }).send(body),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // The loser is either an idempotent hit (200) or genuinely raced ahead
    // of the winner's commit (409 IDEMPOTENCY_IN_PROGRESS) — both are
    // acceptable outcomes; what must always hold is exactly one winner
    // and exactly one created request.
    expect(statuses[0] === 201 || statuses[1] === 201).toBe(true);
    expect(statuses).not.toEqual([201, 201]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ServiceRequest.countDocuments({})).toBe(1);

    const stored = await ServiceRequest.findOne({});
    expect(stored?.devices).toHaveLength(body.devices.length);
  });
});

describe("POST /api/v1/requests — persistence", () => {
  const app = createApp();

  it("creates exactly one request with three correctly linked devices", async () => {
    const { cookies } = await setupCustomer(app);
    const devices = [
      device({ clientDeviceId: "d1", label: "Fridge" }),
      device({ clientDeviceId: "d2", label: "Washer" }),
      device({ clientDeviceId: "d3", label: "Dryer" }),
    ];
    mockGeminiSuccess(devices);

    const res = await postRequests(app, cookies).send(requestBody({ devices }));
    expect(res.status).toBe(201);

    expect(await ServiceRequest.countDocuments({})).toBe(1);
    const stored = await ServiceRequest.findOne({});
    expect(stored?.devices).toHaveLength(3);
    expect(stored?.devices.map((d) => d.clientDeviceId).sort()).toEqual(["d1", "d2", "d3"]);
    for (const d of stored?.devices ?? []) {
      expect(d.originalDescription).toBeDefined();
      expect(d.analysisMetadata.status).toBe("SUCCESS");
    }
  });

  it("leaves no partial state when the domain transaction fails", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    mockGeminiSuccess(body.devices);

    const createSpy = vi
      .spyOn(ServiceRequest, "create")
      .mockRejectedValueOnce(new Error("simulated transaction failure"));

    const res = await postRequests(app, cookies).send(body);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("REQUEST_CREATION_FAILED");
    expect(await ServiceRequest.countDocuments({})).toBe(0);

    createSpy.mockRestore();
  });
});

describe("POST /api/v1/requests — response security", () => {
  const app = createApp();

  it("never exposes AI analysis or internal metadata to the customer", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    mockGeminiSuccess(body.devices);

    const res = await postRequests(app, cookies).send(body);
    expect(res.status).toBe(201);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/possibleCauses|inspectionQuestions|missingInformation|analysisMetadata|promptVersion/);
    expect(res.body.data).toMatchObject({
      requestId: expect.any(String),
      reference: expect.any(String),
      status: "SUBMITTED",
      devices: expect.any(Array),
    });
  });

  it("does not leak the idempotency fingerprint or internal ids", async () => {
    const { cookies } = await setupCustomer(app);
    const body = requestBody();
    mockGeminiSuccess(body.devices);

    const res = await postRequests(app, cookies).send(body);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/fingerprint/i);

    const reservation = await RequestIdempotency.findOne({});
    expect(raw).not.toContain(reservation?.fingerprint);
  });

  it("errors use the standard envelope with a requestId", async () => {
    const { cookies } = await setupCustomer(app);
    const res = await postRequests(app, cookies).send(requestBody({ address: undefined }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", requestId: expect.any(String) });
    expect(res.headers["x-request-id"]).toBe(res.body.error.requestId);
  });
});

describe("POST /api/v1/requests — log safety", () => {
  const app = createApp();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never logs the address, phone, or device descriptions", async () => {
    const { cookies } = await setupCustomer(app);
    const sensitiveAddress = "999 Secret Ave, Nowhere";
    const sensitivePhone = "+15559998888";
    const sensitiveDescription = "SENSITIVE-DESCRIPTION-MARKER-abc123";
    const body = requestBody({
      address: sensitiveAddress,
      contactPhone: sensitivePhone,
      devices: [device({ originalDescription: sensitiveDescription })],
    });
    mockGeminiSuccess(body.devices);

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const res = await postRequests(app, cookies).send(body);
    expect(res.status).toBe(201);

    const logged = [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((call) => JSON.stringify(call)).join(" ");
    expect(logged).not.toContain(sensitiveAddress);
    expect(logged).not.toContain(sensitivePhone);
    expect(logged).not.toContain(sensitiveDescription);
  });
});
