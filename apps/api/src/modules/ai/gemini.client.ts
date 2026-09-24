import { env } from "../../config/env.js";
import { GEMINI_API_BASE_URL } from "./gemini.constants.js";
import { geminiWireEnvelopeSchema } from "./gemini.schemas.js";

/**
 * Stable, safe-to-log-and-branch-on failure reasons. Never wraps or
 * exposes the provider's own error message/body — those could contain
 * anything (including, in principle, request details echoed back), so
 * only this fixed code ever leaves the client.
 */
export type GeminiErrorCode =
  | "GEMINI_TIMEOUT"
  | "GEMINI_QUOTA_EXCEEDED"
  | "GEMINI_PROVIDER_UNAVAILABLE"
  | "GEMINI_AUTH_ERROR"
  | "GEMINI_INVALID_OUTPUT";

export type GeminiCallResult = { ok: true; rawText: string } | { ok: false; errorCode: GeminiErrorCode };

/**
 * Thin transport layer: builds the request, calls the Gemini "Interactions
 * API" (https://ai.google.dev/gemini-api/docs — verified 2026-09-24; see
 * docs/api.md "Gemini model selection"), bounds it with a timeout, and
 * normalizes every failure mode into a `GeminiErrorCode`. Contains no
 * business/persistence logic and knows nothing about devices, requests,
 * or MongoDB — gemini.service.ts owns all of that.
 */
export async function callGemini(prompt: string, responseJsonSchema: unknown): Promise<GeminiCallResult> {
  if (!env.GEMINI_API_KEY) {
    // Missing configuration is, from every caller's perspective, the same
    // as the provider refusing to authenticate us — and this is checked
    // before any network call, so a misconfigured deployment never even
    // attempts one.
    return { ok: false, errorCode: "GEMINI_AUTH_ERROR" };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), env.GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(`${GEMINI_API_BASE_URL}/interactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        model: env.GEMINI_MODEL,
        input: prompt,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: responseJsonSchema,
        },
      }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      return { ok: false, errorCode: "GEMINI_QUOTA_EXCEEDED" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, errorCode: "GEMINI_AUTH_ERROR" };
    }
    if (!response.ok) {
      return { ok: false, errorCode: "GEMINI_PROVIDER_UNAVAILABLE" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, errorCode: "GEMINI_INVALID_OUTPUT" };
    }

    const envelope = geminiWireEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      return { ok: false, errorCode: "GEMINI_INVALID_OUTPUT" };
    }

    return { ok: true, rawText: envelope.data.interaction.output_text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, errorCode: "GEMINI_TIMEOUT" };
    }
    return { ok: false, errorCode: "GEMINI_PROVIDER_UNAVAILABLE" };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
