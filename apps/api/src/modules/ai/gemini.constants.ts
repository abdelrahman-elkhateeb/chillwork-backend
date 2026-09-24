/**
 * FS14 — Gemini device analysis constants.
 *
 * Model/timeout/rate-limit are configurable (see src/config/env.ts) since
 * they're operational knobs; everything here is either genuinely fixed
 * (the API shape, the prompt version) or a bound chosen for this MVP that
 * would need a deliberate code change — not an env var — to revisit.
 */

/**
 * The "Interactions API" — Google's current documented REST approach for
 * the Gemini API, verified against https://ai.google.dev/gemini-api/docs
 * (quickstart, structured-output, and models pages) on 2026-09-24. This
 * supersedes the older `models/{model}:generateContent` endpoint shape.
 */
export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Bumping this is how a deliberate prompt change is tracked in result
 * metadata — never derived from a timestamp, so two results only share a
 * promptVersion when they were actually produced by the same prompt text.
 */
export const PROMPT_VERSION = "v1";

/** Single shared bucket — see docs/api.md "Gemini rate limiting" for why. */
export const GEMINI_THROTTLE_KEY = "gemini:global";

// Input bounds (this service's own request validation) ---------------------
export const MAX_DEVICES_PER_REQUEST = 10;
export const MAX_CLIENT_DEVICE_ID_LENGTH = 200;
export const MAX_ORIGINAL_DESCRIPTION_LENGTH = 4000;
export const MAX_EQUIPMENT_FIELDS = 20;
export const MAX_EQUIPMENT_FIELD_KEY_LENGTH = 100;
export const MAX_EQUIPMENT_FIELD_VALUE_LENGTH = 1000;

// Output bounds (untrusted Gemini response validation) ----------------------
export const MAX_SUMMARY_LENGTH = 500;
export const MAX_LIST_ITEMS = 6;
export const MAX_LIST_ITEM_LENGTH = 200;

export const GEMINI_SYSTEM_INSTRUCTIONS = `You are assisting a field-service company by performing an initial analysis of customer-reported device issues, before a technician is dispatched.

For EACH device listed below, produce a structured analysis. Rules:
- Base your analysis only on the description and equipment details given. Do not invent facts, brand details, or history that were not stated.
- Clearly separate what is a plausible cause from what information is simply missing — do not present a guess as a confirmed diagnosis.
- "possibleCauses" lists plausible, non-definitive causes suggested by the description.
- "missingInformation" lists specific facts that would help diagnose the issue but were not provided (not causes).
- "inspectionQuestions" lists concrete questions/checks a technician should perform on-site — they must stay inspection-oriented, never a claim that the problem is already diagnosed.
- Never state or imply a confirmed diagnosis anywhere in your output.
- Return ONLY the structured JSON matching the provided schema — no prose outside it.
- Echo each device's "clientDeviceId" back exactly as given, so results can be matched to the correct device. Do not omit any device and do not invent extra devices.`;
