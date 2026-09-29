import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { csrfOriginGuard } from "../../middleware/csrf-origin.js";
import { requireRole } from "../../middleware/require-role.js";
import { getInvoice, getInvoicePreview, postInvoice } from "./invoice.controller.js";

export const invoiceRouter = Router();

const technician = [authenticate, requireRole("TECHNICIAN")] as const;

invoiceRouter.get("/technician/visits/:id/invoice-preview", ...technician, getInvoicePreview);
invoiceRouter.get("/technician/visits/:id/invoice", ...technician, getInvoice);
invoiceRouter.post("/technician/visits/:id/invoice", csrfOriginGuard, ...technician, postInvoice);
