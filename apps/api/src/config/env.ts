import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

  // Auth (FS02) -----------------------------------------------------------
  // Secret used to sign/verify access JWTs. Never a default in any
  // environment: a missing/weak secret must fail startup, not silently
  // fall back to something guessable.
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().min(1).default("fs-api"),
  JWT_AUDIENCE: z.string().min(1).default("fs-api-clients"),

  // Cookies. AUTH_COOKIE_SECURE has no schema default here on purpose —
  // its effective default (see loadEnv) depends on NODE_ENV so that local
  // dev over plain HTTP still works without extra configuration.
  AUTH_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  AUTH_COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),

  // Comma-separated list of additional origins allowed to make
  // credentialed, state-changing requests (beyond the request's own
  // same-origin, which is always allowed). Intentionally has no hardcoded
  // production frontend domain here — that belongs to FS33.
  AUTH_ALLOWED_ORIGINS: z.string().optional(),

  // Bounded grace window (see docs/api.md "Concurrent refresh policy")
  // during which the immediately-previous refresh token is still accepted,
  // to absorb legitimate near-simultaneous browser/network races without
  // triggering reuse detection.
  AUTH_REFRESH_GRACE_MS: z.coerce.number().int().positive().default(10_000),

  // Login throttling (see docs/api.md "Throttling"). Two independent
  // buckets: a per-IP ceiling and a stricter per-account+IP ceiling, both
  // MongoDB-backed so they work across serverless instances.
  AUTH_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: z.coerce.number().int().positive().default(5),
  AUTH_LOGIN_MAX_ATTEMPTS_PER_IP: z.coerce.number().int().positive().default(20),
  AUTH_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
});

type RawEnv = z.infer<typeof envSchema>;

export type Env = Omit<RawEnv, "AUTH_COOKIE_SECURE" | "AUTH_ALLOWED_ORIGINS"> & {
  AUTH_COOKIE_SECURE: boolean;
  AUTH_ALLOWED_ORIGINS: string[];
};

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const raw = result.data;

  return {
    ...raw,
    AUTH_COOKIE_SECURE: raw.AUTH_COOKIE_SECURE
      ? raw.AUTH_COOKIE_SECURE === "true"
      : raw.NODE_ENV === "production",
    AUTH_ALLOWED_ORIGINS: raw.AUTH_ALLOWED_ORIGINS
      ? raw.AUTH_ALLOWED_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0)
      : [],
  };
}

export const env = loadEnv();
