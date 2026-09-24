import { env } from "../../config/env.js";
// Reused as-is — this primitive is generic (key/window/count), not
// auth-specific despite its current location, and FS14 must not create a
// second MongoDB throttle collection. See docs/api.md "Gemini rate
// limiting" for the keying rationale.
import { recordAttempt } from "../auth/auth-throttle.model.js";
import { callGemini, type GeminiErrorCode } from "./gemini.client.js";
import { GEMINI_SYSTEM_INSTRUCTIONS, GEMINI_THROTTLE_KEY, PROMPT_VERSION } from "./gemini.constants.js";
import {
  analyzeDevicesInputSchema,
  geminiOutputSchema,
  GEMINI_RESPONSE_JSON_SCHEMA,
  type AnalyzeDevicesInput,
  type DeviceAnalysis,
  type DeviceInput,
} from "./gemini.schemas.js";

export type AnalysisStatus = "SUCCESS" | "FAILED" | "UNAVAILABLE";

/** Every client-facing failure reason, including ones that never reach the provider. */
export type GeminiResultErrorCode = GeminiErrorCode | "GEMINI_RATE_LIMITED";

export interface DeviceAnalysisMetadata {
  status: AnalysisStatus;
  model: string;
  promptVersion: string;
  /** ISO 8601 UTC timestamp. */
  processedAt: string;
  errorCode?: GeminiResultErrorCode;
}

export interface DeviceAnalysisResult {
  clientDeviceId: string;
  /** Byte-identical to the corresponding input device's originalDescription. */
  originalDescription: string;
  /** null whenever metadata.status !== "SUCCESS" — never invented content. */
  analysis: DeviceAnalysis | null;
  metadata: DeviceAnalysisMetadata;
}

export interface AnalyzeDevicesResult {
  devices: DeviceAnalysisResult[];
}

export interface AnalyzeDevicesContext {
  /** For log correlation only — never sent to Gemini (see docs/api.md). */
  requestId?: string;
}

/**
 * "Unavailable" = we couldn't get a usable response from the provider at
 * all (timeout, quota, 5xx, auth/config, our own rate limit) — retrying
 * later might help. "Failed" = the provider responded but what came back
 * wasn't usable (malformed JSON, schema violation) — a provider-side
 * content problem, not an infrastructure one. Kept as a fixed mapping
 * rather than letting callers pick, so the distinction stays meaningful.
 */
function statusForErrorCode(errorCode: GeminiResultErrorCode): Exclude<AnalysisStatus, "SUCCESS"> {
  return errorCode === "GEMINI_INVALID_OUTPUT" ? "FAILED" : "UNAVAILABLE";
}

async function isGeminiThrottled(now: Date): Promise<boolean> {
  const count = await recordAttempt(GEMINI_THROTTLE_KEY, env.GEMINI_RATE_LIMIT_WINDOW_MS, now);
  return count > env.GEMINI_RATE_LIMIT_MAX_ATTEMPTS;
}

function buildFailureResult(devices: readonly DeviceInput[], errorCode: GeminiResultErrorCode, now: Date): AnalyzeDevicesResult {
  const processedAt = now.toISOString();
  const status = statusForErrorCode(errorCode);
  return {
    devices: devices.map((device) => ({
      clientDeviceId: device.clientDeviceId,
      originalDescription: device.originalDescription,
      analysis: null,
      metadata: { status, model: env.GEMINI_MODEL, promptVersion: PROMPT_VERSION, processedAt, errorCode },
    })),
  };
}

/**
 * One provider call for the whole batch, not one per device: Free Tier
 * RPM is the binding constraint (typically single-digit-to-low-teens
 * requests/minute), so per-device calls would multiply provider-call
 * volume by the device count and exhaust it almost immediately for any
 * multi-device request. The tradeoff is failure isolation — a
 * whole-response provider/parse failure affects every device in the
 * batch — which is accepted here since a request's devices are already
 * one logical submission (see docs/api.md "Multiple devices per call").
 */
function buildPrompt(devices: readonly DeviceInput[]): string {
  const deviceBlocks = devices.map((device, index) => {
    const equipmentJson = device.equipment ? JSON.stringify(device.equipment) : "{}";
    return [
      `Device ${index + 1}:`,
      `clientDeviceId: ${device.clientDeviceId}`,
      `originalDescription: ${device.originalDescription}`,
      `equipment: ${equipmentJson}`,
    ].join("\n");
  });

  return [GEMINI_SYSTEM_INSTRUCTIONS, "", "Devices to analyze:", "", deviceBlocks.join("\n\n")].join("\n");
}

interface GeminiLogEvent {
  status: AnalysisStatus;
  errorCode?: GeminiResultErrorCode;
  deviceCount: number;
  durationMs?: number;
  requestId?: string;
}

/**
 * Safe operational metadata only — see docs/api.md "Logging safety". No
 * prompt, no originalDescription, no clientDeviceId, no raw provider
 * response, no API key ever passes through this function's parameters.
 */
function logGeminiEvent(event: GeminiLogEvent): void {
  const log = event.status === "SUCCESS" ? console.info : console.warn;
  log({ event: "ai.gemini.analyze", model: env.GEMINI_MODEL, promptVersion: PROMPT_VERSION, ...event });
}

/**
 * FS14's entire surface. Validates its own input (a thrown ZodError here
 * means the caller — FS15 — built an invalid call; that's a programming
 * error, not a provider failure, so unlike every failure mode below it is
 * NOT turned into a FAILED/UNAVAILABLE result), applies the shared
 * Gemini-specific throttle, calls the provider exactly once, and never
 * trusts the response until it passes `geminiOutputSchema`. Persists
 * nothing — see docs/api.md "No persistence in FS14".
 */
export async function analyzeDevices(
  input: AnalyzeDevicesInput,
  context: AnalyzeDevicesContext = {}
): Promise<AnalyzeDevicesResult> {
  const { devices } = analyzeDevicesInputSchema.parse(input);
  const now = new Date();

  if (await isGeminiThrottled(now)) {
    logGeminiEvent({
      status: "UNAVAILABLE",
      errorCode: "GEMINI_RATE_LIMITED",
      deviceCount: devices.length,
      requestId: context.requestId,
    });
    return buildFailureResult(devices, "GEMINI_RATE_LIMITED", now);
  }

  const prompt = buildPrompt(devices);
  const startedAt = Date.now();
  const callResult = await callGemini(prompt, GEMINI_RESPONSE_JSON_SCHEMA);
  const durationMs = Date.now() - startedAt;

  if (!callResult.ok) {
    logGeminiEvent({
      status: statusForErrorCode(callResult.errorCode),
      errorCode: callResult.errorCode,
      deviceCount: devices.length,
      durationMs,
      requestId: context.requestId,
    });
    return buildFailureResult(devices, callResult.errorCode, now);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(callResult.rawText);
  } catch {
    logGeminiEvent({
      status: "FAILED",
      errorCode: "GEMINI_INVALID_OUTPUT",
      deviceCount: devices.length,
      durationMs,
      requestId: context.requestId,
    });
    return buildFailureResult(devices, "GEMINI_INVALID_OUTPUT", now);
  }

  const validated = geminiOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    logGeminiEvent({
      status: "FAILED",
      errorCode: "GEMINI_INVALID_OUTPUT",
      deviceCount: devices.length,
      durationMs,
      requestId: context.requestId,
    });
    return buildFailureResult(devices, "GEMINI_INVALID_OUTPUT", now);
  }

  // Correlate deterministically by clientDeviceId — never by array
  // position (see docs/api.md "Stable device association"). A device the
  // provider omitted from its response fails individually rather than
  // silently borrowing another device's result.
  const resultByDeviceId = new Map(validated.data.devices.map((device) => [device.clientDeviceId, device]));
  const processedAt = now.toISOString();

  const resultDevices: DeviceAnalysisResult[] = devices.map((device) => {
    const match = resultByDeviceId.get(device.clientDeviceId);

    if (!match) {
      return {
        clientDeviceId: device.clientDeviceId,
        originalDescription: device.originalDescription,
        analysis: null,
        metadata: {
          status: "FAILED",
          model: env.GEMINI_MODEL,
          promptVersion: PROMPT_VERSION,
          processedAt,
          errorCode: "GEMINI_INVALID_OUTPUT",
        },
      };
    }

    return {
      clientDeviceId: device.clientDeviceId,
      originalDescription: device.originalDescription,
      analysis: {
        summary: match.summary,
        possibleCauses: match.possibleCauses,
        missingInformation: match.missingInformation,
        inspectionQuestions: match.inspectionQuestions,
      },
      metadata: {
        status: "SUCCESS",
        model: env.GEMINI_MODEL,
        promptVersion: PROMPT_VERSION,
        processedAt,
      },
    };
  });

  logGeminiEvent({ status: "SUCCESS", deviceCount: devices.length, durationMs, requestId: context.requestId });

  return { devices: resultDevices };
}
