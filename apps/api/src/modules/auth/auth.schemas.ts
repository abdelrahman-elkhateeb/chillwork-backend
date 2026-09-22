import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;

// No pre-existing phone convention anywhere else in the repo (FS04 is the
// first field that needs one). MVP rule, documented in docs/api.md:
// optional leading "+", 7-15 digits, no leading zero — a simplified E.164
// shape. Spaces/dashes/parentheses are stripped during normalization
// rather than rejected outright, so common human-typed formats
// ("+1 555-000-1111") still work.
const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;

/**
 * Deliberately just { name, email, phone, password } — no `.passthrough()`
 * anywhere, so zod's default "strip unknown keys" behavior silently drops
 * anything else a client sends (role, companyId, isAdmin, ...). The
 * service layer never even sees those fields, let alone reads them, which
 * is what actually keeps a tampered request from influencing the created
 * user's authorization (see docs/api.md "Customer role & company
 * assignment").
 */
export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters"),
  email: z.string().trim().toLowerCase().min(1, "Email is required").email("Invalid email address"),
  phone: z
    .string()
    .trim()
    .min(1, "Phone is required")
    .transform((value) => value.replace(/[\s\-()]/g, ""))
    .refine((value) => PHONE_REGEX.test(value), "Invalid phone number"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
