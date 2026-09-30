import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { MAX_LIST_ITEMS, MAX_SUMMARY_LENGTH } from "../src/modules/ai/gemini.constants.js";
import { analyzeDevices } from "../src/modules/ai/gemini.service.js";
import type { DeviceInput } from "../src/modules/ai/gemini.schemas.js";

// Mirrors the real Interactions API wire shape, including a `thought`
// step the client must ignore.
function geminiHttpResponse(outputText: string, status = 200): Response {
  const body = {
    status: "completed",
    steps: [
      { type: "thought", content: [{ type: "text", text: "not the answer" }] },
      { type: "model_output", content: [{ type: "text", text: outputText }] },
    ],
  };
  return new Response(JSON.stringify(body), { status });
}

function validOutputFor(devices: Pick<DeviceInput, "clientDeviceId">[]) {
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

function mockFetchResolving(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("analyzeDevices — successful analysis", () => {
  it("calls Gemini once, validates output, and returns a SUCCESS result", async () => {
    const devices: DeviceInput[] = [
      { clientDeviceId: "dev-1", originalDescription: "Fridge is not cooling", equipment: { type: "fridge" } },
    ];
    const fetchMock = mockFetchResolving(geminiHttpResponse(JSON.stringify(validOutputFor(devices))));

    const result = await analyzeDevices({ devices });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.devices).toHaveLength(1);
    const [device] = result.devices;
    expect(device?.clientDeviceId).toBe("dev-1");
    expect(device?.metadata).toMatchObject({ status: "SUCCESS", model: env.GEMINI_MODEL, promptVersion: "v1" });
    expect(device?.metadata.processedAt).toEqual(expect.any(String));
    expect(device?.metadata.errorCode).toBeUndefined();
    expect(device?.analysis).toMatchObject({
      summary: expect.any(String),
      possibleCauses: expect.any(Array),
      missingInformation: expect.any(Array),
      inspectionQuestions: expect.any(Array),
    });
  });
});

describe("analyzeDevices — multiple devices", () => {
  it("associates results by clientDeviceId, not array/response position", async () => {
    const devices: DeviceInput[] = [
      { clientDeviceId: "A", originalDescription: "desc A" },
      { clientDeviceId: "B", originalDescription: "desc B" },
      { clientDeviceId: "C", originalDescription: "desc C" },
    ];
    // Provider intentionally returns devices out of request order.
    const outOfOrder = {
      devices: [
        { clientDeviceId: "C", summary: "S-C", possibleCauses: [], missingInformation: [], inspectionQuestions: [] },
        { clientDeviceId: "A", summary: "S-A", possibleCauses: [], missingInformation: [], inspectionQuestions: [] },
        { clientDeviceId: "B", summary: "S-B", possibleCauses: [], missingInformation: [], inspectionQuestions: [] },
      ],
    };
    mockFetchResolving(geminiHttpResponse(JSON.stringify(outOfOrder)));

    const result = await analyzeDevices({ devices });

    expect(result.devices.map((d) => d.clientDeviceId)).toEqual(["A", "B", "C"]);
    expect(result.devices.find((d) => d.clientDeviceId === "A")?.analysis?.summary).toBe("S-A");
    expect(result.devices.find((d) => d.clientDeviceId === "B")?.analysis?.summary).toBe("S-B");
    expect(result.devices.find((d) => d.clientDeviceId === "C")?.analysis?.summary).toBe("S-C");
  });

  it("marks a device FAILED individually if the provider response omits it, without affecting the others", async () => {
    const devices: DeviceInput[] = [
      { clientDeviceId: "A", originalDescription: "desc A" },
      { clientDeviceId: "B", originalDescription: "desc B" },
    ];
    const partialOutput = {
      devices: [{ clientDeviceId: "A", summary: "S-A", possibleCauses: [], missingInformation: [], inspectionQuestions: [] }],
    };
    mockFetchResolving(geminiHttpResponse(JSON.stringify(partialOutput)));

    const result = await analyzeDevices({ devices });

    expect(result.devices.find((d) => d.clientDeviceId === "A")?.metadata.status).toBe("SUCCESS");
    const missing = result.devices.find((d) => d.clientDeviceId === "B");
    expect(missing?.metadata.status).toBe("FAILED");
    expect(missing?.metadata.errorCode).toBe("GEMINI_INVALID_OUTPUT");
    expect(missing?.analysis).toBeNull();
  });
});

describe("analyzeDevices — original description preservation", () => {
  it("returns originalDescription byte-for-byte, never trimmed or rewritten", async () => {
    const weirdDescription = "  Fridge \n won't turn on!!   \t";
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: weirdDescription }];
    mockFetchResolving(geminiHttpResponse(JSON.stringify(validOutputFor(devices))));

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.originalDescription).toBe(weirdDescription);
  });
});

describe("analyzeDevices — invalid provider output", () => {
  it("returns a controlled FAILED result for malformed JSON, with no invented analysis", async () => {
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];
    mockFetchResolving(geminiHttpResponse("{not valid json"));

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("FAILED");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_INVALID_OUTPUT");
    expect(result.devices[0]?.analysis).toBeNull();
  });

  it("returns FAILED when the response has no model_output step", async () => {
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];
    const body = { status: "completed", steps: [{ type: "thought", content: [{ type: "text", text: "{}" }] }] };
    mockFetchResolving(new Response(JSON.stringify(body), { status: 200 }));

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("FAILED");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_INVALID_OUTPUT");
    expect(result.devices[0]?.analysis).toBeNull();
  });

  it("returns FAILED when JSON is syntactically valid but violates the output schema (missing fields)", async () => {
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];
    const missingFields = { devices: [{ clientDeviceId: "dev-1", summary: "ok" }] };
    mockFetchResolving(geminiHttpResponse(JSON.stringify(missingFields)));

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("FAILED");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_INVALID_OUTPUT");
    expect(result.devices[0]?.analysis).toBeNull();
  });

  it("rejects output with an excessive summary length", async () => {
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];
    const tooLong = {
      devices: [
        {
          clientDeviceId: "dev-1",
          summary: "x".repeat(MAX_SUMMARY_LENGTH + 1),
          possibleCauses: [],
          missingInformation: [],
          inspectionQuestions: [],
        },
      ],
    };
    mockFetchResolving(geminiHttpResponse(JSON.stringify(tooLong)));

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("FAILED");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_INVALID_OUTPUT");
  });

  it("rejects output with an excessive number of array items", async () => {
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];
    const tooManyCauses = {
      devices: [
        {
          clientDeviceId: "dev-1",
          summary: "ok",
          possibleCauses: Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `cause ${i}`),
          missingInformation: [],
          inspectionQuestions: [],
        },
      ],
    };
    mockFetchResolving(geminiHttpResponse(JSON.stringify(tooManyCauses)));

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("FAILED");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_INVALID_OUTPUT");
  });
});

describe("analyzeDevices — provider failure handling", () => {
  it("returns GEMINI_TIMEOUT (UNAVAILABLE) when the call exceeds the configured timeout, with no uncaught exception", async () => {
    const originalTimeout = env.GEMINI_TIMEOUT_MS;
    env.GEMINI_TIMEOUT_MS = 20;
    try {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const abortError = new Error("The operation was aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];
      const result = await analyzeDevices({ devices });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.devices[0]?.metadata.status).toBe("UNAVAILABLE");
      expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_TIMEOUT");
      expect(result.devices[0]?.analysis).toBeNull();
    } finally {
      env.GEMINI_TIMEOUT_MS = originalTimeout;
    }
  });

  it("returns GEMINI_QUOTA_EXCEEDED on a provider 429 response", async () => {
    mockFetchResolving(new Response(JSON.stringify({ error: "quota" }), { status: 429 }));
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("UNAVAILABLE");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_QUOTA_EXCEEDED");
  });

  it("returns GEMINI_PROVIDER_UNAVAILABLE on a provider 5xx response", async () => {
    mockFetchResolving(new Response("internal error", { status: 503 }));
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("UNAVAILABLE");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_PROVIDER_UNAVAILABLE");
  });

  it("returns GEMINI_PROVIDER_UNAVAILABLE on a network-level failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("UNAVAILABLE");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_PROVIDER_UNAVAILABLE");
  });

  it("returns GEMINI_AUTH_ERROR on a provider 401/403 response", async () => {
    mockFetchResolving(new Response("unauthorized", { status: 401 }));
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.metadata.status).toBe("UNAVAILABLE");
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_AUTH_ERROR");
  });

  it("original request data remains available even when analysis is unavailable — nothing is invented", async () => {
    mockFetchResolving(new Response("internal error", { status: 503 }));
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "the exact original text" }];

    const result = await analyzeDevices({ devices });

    expect(result.devices[0]?.clientDeviceId).toBe("dev-1");
    expect(result.devices[0]?.originalDescription).toBe("the exact original text");
    expect(result.devices[0]?.analysis).toBeNull();
  });
});

describe("analyzeDevices — Gemini-specific throttle", () => {
  it("does not call the provider once the shared Gemini throttle is exceeded", async () => {
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];
    // A fresh Response per call — a Response body can only be read once,
    // and this test calls analyzeDevices() (and therefore fetch) several
    // times, unlike every other test here.
    const fetchMock = vi.fn().mockImplementation(() => geminiHttpResponse(JSON.stringify(validOutputFor(devices))));
    vi.stubGlobal("fetch", fetchMock);

    // env.GEMINI_RATE_LIMIT_MAX_ATTEMPTS is 3 in the test fixture env.
    for (let i = 0; i < env.GEMINI_RATE_LIMIT_MAX_ATTEMPTS; i += 1) {
      const res = await analyzeDevices({ devices });
      expect(res.devices[0]?.metadata.status).toBe("SUCCESS");
    }
    fetchMock.mockClear();

    const throttled = await analyzeDevices({ devices });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(throttled.devices[0]?.metadata.status).toBe("UNAVAILABLE");
    expect(throttled.devices[0]?.metadata.errorCode).toBe("GEMINI_RATE_LIMITED");
  });
});

describe("analyzeDevices — no paid-model fallback", () => {
  it("makes exactly one provider attempt on failure, always for the single configured model", async () => {
    const fetchMock = mockFetchResolving(new Response("internal error", { status: 500 }));
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];

    await analyzeDevices({ devices });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(requestInit.body as string) as { model: string };
    expect(requestBody.model).toBe(env.GEMINI_MODEL);
  });
});

describe("analyzeDevices — secret and log safety", () => {
  it("never logs the API key, the prompt/originalDescription, or the raw provider response", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sensitiveMarker = "SENSITIVE-DESCRIPTION-MARKER-0xDEADBEEF";
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: sensitiveMarker }];
    mockFetchResolving(geminiHttpResponse(JSON.stringify(validOutputFor(devices))));

    await analyzeDevices({ devices });

    const logged = [...infoSpy.mock.calls, ...warnSpy.mock.calls].map((call) => JSON.stringify(call)).join(" ");
    expect(logged).not.toContain(env.GEMINI_API_KEY);
    expect(logged).not.toContain(sensitiveMarker);
    expect(logged).not.toMatch(/possibleCauses|inspectionQuestions/);
  });

  it("never includes the API key anywhere in the returned result, even on an auth failure", async () => {
    mockFetchResolving(new Response("unauthorized", { status: 401 }));
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];

    const result = await analyzeDevices({ devices });

    expect(JSON.stringify(result)).not.toContain(env.GEMINI_API_KEY);
    expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_AUTH_ERROR");
  });

  it("returns a controlled GEMINI_AUTH_ERROR — and never calls the provider — when GEMINI_API_KEY is unconfigured", async () => {
    const originalKey = env.GEMINI_API_KEY;
    env.GEMINI_API_KEY = undefined;
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];

      const result = await analyzeDevices({ devices });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.devices[0]?.metadata.status).toBe("UNAVAILABLE");
      expect(result.devices[0]?.metadata.errorCode).toBe("GEMINI_AUTH_ERROR");
    } finally {
      env.GEMINI_API_KEY = originalKey;
    }
  });
});

describe("analyzeDevices — no Service Request persistence", () => {
  it("writes to no request/device collection — only the shared throttle state changes", async () => {
    const devices: DeviceInput[] = [{ clientDeviceId: "dev-1", originalDescription: "desc" }];
    mockFetchResolving(geminiHttpResponse(JSON.stringify(validOutputFor(devices))));

    // Document *counts*, not collection existence: FS15 legitimately owns
    // a `servicerequests` collection now, so the only thing that still
    // proves FS14 itself persists nothing is that calling it never adds
    // documents to any request/device-shaped collection.
    const collections = await mongoose.connection.db!.listCollections().toArray();
    const relevant = collections.map((c) => c.name).filter((name) => /request|device/i.test(name));
    const countsBefore = await Promise.all(
      relevant.map((name) => mongoose.connection.db!.collection(name).countDocuments())
    );

    await analyzeDevices({ devices });

    const countsAfter = await Promise.all(
      relevant.map((name) => mongoose.connection.db!.collection(name).countDocuments())
    );
    expect(countsAfter).toEqual(countsBefore);
  });
});

describe("analyzeDevices — input contract", () => {
  it("rejects a call with no devices", async () => {
    await expect(analyzeDevices({ devices: [] })).rejects.toThrow();
  });

  it("rejects a call with duplicate clientDeviceIds", async () => {
    await expect(
      analyzeDevices({
        devices: [
          { clientDeviceId: "dup", originalDescription: "a" },
          { clientDeviceId: "dup", originalDescription: "b" },
        ],
      })
    ).rejects.toThrow();
  });
});
