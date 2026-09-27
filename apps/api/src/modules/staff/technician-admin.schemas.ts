import { z } from "zod";
import {
  MAX_TECHNICIAN_SEARCH_LENGTH,
  TECHNICIAN_STATUSES,
  TECHNICIANS_DEFAULT_PAGE_SIZE,
  TECHNICIANS_MAX_PAGE,
  TECHNICIANS_MAX_PAGE_SIZE,
} from "./staff.constants.js";

// Same rules as registration (auth.schemas.ts) — keep in sync by hand.
const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;
const name = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(100, "Name must be at most 100 characters");
const phone = z
  .string()
  .trim()
  .min(1, "Phone is required")
  .transform((value) => value.replace(/[\s\-()]/g, ""))
  .refine((value) => PHONE_REGEX.test(value), "Invalid phone number");

/** Role and company are never accepted — always TECHNICIAN in the admin's own company. */
export const createTechnicianSchema = z.object({
  name,
  email: z.string().trim().toLowerCase().min(1, "Email is required").email("Invalid email address"),
  phone,
});
export type CreateTechnicianInput = z.infer<typeof createTechnicianSchema>;

/** The email is the login identity and is not editable here. */
export const updateTechnicianSchema = z
  .object({ name: name.optional(), phone: phone.optional(), isActive: z.boolean().optional() })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "At least one field is required");
export type UpdateTechnicianInput = z.infer<typeof updateTechnicianSchema>;

export const techniciansQuerySchema = z
  .object({
    status: z.enum(TECHNICIAN_STATUSES).optional(),
    search: z.string().trim().max(MAX_TECHNICIAN_SEARCH_LENGTH).optional(),
    page: z.coerce.number().int().min(1).max(TECHNICIANS_MAX_PAGE).default(1),
    pageSize: z.coerce.number().int().min(1).max(TECHNICIANS_MAX_PAGE_SIZE).default(TECHNICIANS_DEFAULT_PAGE_SIZE),
  })
  .strict();
export type TechniciansQuery = z.infer<typeof techniciansQuerySchema>;

export const activateTechnicianSchema = z.object({
  token: z.string().min(1, "token is required").max(200),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
export type ActivateTechnicianInput = z.infer<typeof activateTechnicianSchema>;
