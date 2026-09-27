import type { Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { Invoice, type InvoiceDocument } from "../billing/invoice.model.js";
import type { FailureReason, VisitOutcome, WorkResultValue } from "../technician/work-result.constants.js";
import { WorkResult } from "../technician/work-result.model.js";
import { deriveVisitOutcome } from "../technician/work-result.service.js";
import { User } from "../users/user.model.js";
import { VisitEvent } from "../visits/visit-event.model.js";
import { Visit, type VisitDocument } from "../visits/visit.model.js";
import type { CustomerRequestsQuery } from "./customer-request.schemas.js";
import { ServiceRequest, type ServiceRequestDocument } from "./request.model.js";

/**
 * FS16 — the customer's own view of their requests. Everything is scoped
 * to (companyId, customerId = req.auth.userId); another customer's request
 * is a plain 404. Never returned: AI analysis, technician free-text notes
 * (failureNote), staff/actor ids, part-selection edits, prices before an
 * invoice exists.
 */
export interface CustomerAuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
}

export const DEVICE_PROGRESS = [
  "AWAITING_SCHEDULE",
  "SCHEDULED",
  "IN_PROGRESS",
  "REPAIRED",
  "NOT_REPAIRED",
] as const;
export type DeviceProgress = (typeof DEVICE_PROGRESS)[number];

export const REQUEST_PROGRESS = ["SUBMITTED", "SCHEDULED", "IN_PROGRESS", "COMPLETED"] as const;
export type RequestProgress = (typeof REQUEST_PROGRESS)[number];

const COVERING_VISIT_STATUSES: readonly string[] = ["SCHEDULED", "IN_PROGRESS", "COMPLETED"];

interface DeviceState {
  progress: DeviceProgress;
  visitId: string | null;
  failureReason: FailureReason | null;
}

/**
 * Per-device state from the device's latest non-cancelled visit. A result
 * only counts once that visit is COMPLETED: while the technician is still
 * working, results can change, so the device is just IN_PROGRESS.
 */
function deviceStates(
  request: ServiceRequestDocument,
  visits: readonly VisitDocument[],
  results: ReadonlyMap<string, { result: WorkResultValue; failureReason: FailureReason | null }>
): Map<string, DeviceState> {
  const latestVisit = new Map<string, VisitDocument>();
  for (const visit of visits) {
    if (COVERING_VISIT_STATUSES.includes(visit.status)) {
      visit.deviceIds.forEach((deviceId) => latestVisit.set(deviceId, visit));
    }
  }

  const states = new Map<string, DeviceState>();
  for (const device of request.devices) {
    const visit = latestVisit.get(device.clientDeviceId);
    let state: DeviceState = { progress: "AWAITING_SCHEDULE", visitId: null, failureReason: null };
    if (visit) {
      const visitId = visit._id.toString();
      if (visit.status === "SCHEDULED") state = { progress: "SCHEDULED", visitId, failureReason: null };
      else if (visit.status === "IN_PROGRESS") state = { progress: "IN_PROGRESS", visitId, failureReason: null };
      else {
        const outcome = results.get(`${visitId}:${device.clientDeviceId}`);
        state =
          outcome?.result === "REPAIRED"
            ? { progress: "REPAIRED", visitId, failureReason: null }
            : { progress: "NOT_REPAIRED", visitId, failureReason: outcome?.failureReason ?? null };
      }
    }
    states.set(device.clientDeviceId, state);
  }
  return states;
}

/**
 * Request-level summary that never overstates: COMPLETED (with an
 * outcome) only when every device has a final result, and FULLY_REPAIRED
 * only when every one of them was repaired — a single failed device makes
 * it PARTIALLY_REPAIRED or NO_REPAIR.
 */
function summarize(states: ReadonlyMap<string, DeviceState>): {
  progress: RequestProgress;
  outcome: VisitOutcome | null;
} {
  const values = [...states.values()];
  const finals = new Map<string, WorkResultValue>();
  for (const [deviceId, state] of states) {
    if (state.progress === "REPAIRED") finals.set(deviceId, "REPAIRED");
    if (state.progress === "NOT_REPAIRED") finals.set(deviceId, "FAILED");
  }
  const outcome = deriveVisitOutcome([...states.keys()], finals);
  if (outcome) return { progress: "COMPLETED", outcome };
  if (values.some((state) => state.progress === "IN_PROGRESS")) return { progress: "IN_PROGRESS", outcome: null };
  if (values.some((state) => state.progress !== "AWAITING_SCHEDULE")) return { progress: "SCHEDULED", outcome: null };
  return { progress: "SUBMITTED", outcome: null };
}

async function loadState(auth: CustomerAuthContext, requests: readonly ServiceRequestDocument[]) {
  const requestIds = requests.map((request) => request._id);
  const visits = requestIds.length
    ? await Visit.find({ companyId: auth.companyId, requestId: { $in: requestIds } }).sort({ startAt: 1, _id: 1 })
    : [];
  const completedIds = visits.filter((visit) => visit.status === "COMPLETED").map((visit) => visit._id);
  const results = completedIds.length
    ? await WorkResult.find({ companyId: auth.companyId, visitId: { $in: completedIds } }).select(
        "visitId clientDeviceId result failureReason"
      )
    : [];
  const resultByKey = new Map(
    results.map((r) => [
      `${r.visitId.toString()}:${r.clientDeviceId}`,
      { result: r.result, failureReason: r.failureReason },
    ])
  );
  const visitsByRequest = new Map<string, VisitDocument[]>();
  for (const visit of visits) {
    const key = visit.requestId.toString();
    visitsByRequest.set(key, [...(visitsByRequest.get(key) ?? []), visit]);
  }
  return { visits, visitsByRequest, resultByKey };
}

export async function listCustomerRequests(auth: CustomerAuthContext, query: CustomerRequestsQuery) {
  const filter: Record<string, unknown> = { companyId: auth.companyId, customerId: auth.userId };
  if (query.status) filter.status = query.status;

  const [requests, total] = await Promise.all([
    ServiceRequest.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .select("reference status address devices.clientDeviceId devices.label createdAt"),
    ServiceRequest.countDocuments(filter),
  ]);
  const { visitsByRequest, resultByKey } = await loadState(auth, requests);

  return {
    items: requests.map((request) => {
      const states = deviceStates(request, visitsByRequest.get(request._id.toString()) ?? [], resultByKey);
      const { progress, outcome } = summarize(states);
      return {
        requestId: request._id.toString(),
        reference: request.reference,
        status: request.status,
        progress,
        outcome,
        createdAt: request.createdAt.toISOString(),
        address: request.address,
        deviceCount: request.devices.length,
        devices: request.devices.map((device) => ({
          clientDeviceId: device.clientDeviceId,
          label: device.label,
          progress: states.get(device.clientDeviceId)!.progress,
        })),
      };
    }),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

async function findOwnRequest(auth: CustomerAuthContext, requestId: string) {
  const request = await ServiceRequest.findOne({ _id: requestId, companyId: auth.companyId, customerId: auth.userId });
  if (!request) throw HttpError.notFound("Request not found");
  return request;
}

function toInvoiceSummary(invoice: InvoiceDocument | undefined) {
  return invoice
    ? {
        id: invoice._id.toString(),
        reference: invoice.reference,
        currency: invoice.currency,
        totalMinor: invoice.totalMinor,
        status: invoice.status,
        paymentState: invoice.paymentState,
        issuedAt: invoice.issuedAt.toISOString(),
      }
    : null;
}

export async function getCustomerRequest(auth: CustomerAuthContext, requestId: string) {
  const request = await findOwnRequest(auth, requestId);
  const { visits, resultByKey } = await loadState(auth, [request]);
  const states = deviceStates(request, visits, resultByKey);
  const { progress, outcome } = summarize(states);

  const visible = visits.filter((visit) => visit.status !== "CANCELLED");
  const technicianIds = [...new Set(visible.map((visit) => visit.technicianId.toString()))];
  const [technicians, invoices] = await Promise.all([
    technicianIds.length ? User.find({ _id: { $in: technicianIds }, companyId: auth.companyId }).select("name") : [],
    visible.length
      ? Invoice.find({ companyId: auth.companyId, visitId: { $in: visible.map((visit) => visit._id) } })
      : [],
  ]);
  const technicianName = new Map(technicians.map((technician) => [technician._id.toString(), technician.name]));
  const invoiceByVisit = new Map(invoices.map((invoice) => [invoice.visitId.toString(), invoice]));

  return {
    requestId: request._id.toString(),
    reference: request.reference,
    status: request.status,
    progress,
    outcome,
    createdAt: request.createdAt.toISOString(),
    address: request.address,
    contactPhone: request.contactPhone,
    devices: request.devices.map((device) => {
      const state = states.get(device.clientDeviceId)!;
      return {
        clientDeviceId: device.clientDeviceId,
        label: device.label,
        brand: device.brand,
        model: device.model,
        originalDescription: device.originalDescription,
        progress: state.progress,
        failureReason: state.failureReason,
        visitId: state.visitId,
      };
    }),
    visits: visible.map((visit) => ({
      visitId: visit._id.toString(),
      startAt: visit.startAt.toISOString(),
      endAt: visit.endAt.toISOString(),
      timezone: visit.timezone,
      status: visit.status,
      technicianName: technicianName.get(visit.technicianId.toString()) ?? null,
      deviceIds: [...visit.deviceIds],
      invoice: toInvoiceSummary(invoiceByVisit.get(visit._id.toString())),
    })),
  };
}

/** Customer-visible event types; everything else in VisitEvent is internal. */
const VISIBLE_VISIT_EVENTS = {
  VISIT_SCHEDULED: "VISIT_SCHEDULED",
  VISIT_STARTED: "VISIT_STARTED",
  VISIT_COMPLETED: "VISIT_COMPLETED",
  INVOICE_ISSUED: "INVOICE_ISSUED",
} as const;
const MAX_TIMELINE_EVENTS = 500;

/**
 * Built from the audited VisitEvent log plus the request's own creation.
 * Assignment details, work-result edits and part-selection edits are
 * internal and left out; events carry no actor ids or notes.
 */
export async function getCustomerRequestTimeline(auth: CustomerAuthContext, requestId: string) {
  const request = await findOwnRequest(auth, requestId);
  const events = await VisitEvent.find({
    companyId: auth.companyId,
    requestId: request._id,
    type: { $in: Object.keys(VISIBLE_VISIT_EVENTS) },
  })
    .sort({ occurredAt: 1, _id: 1 })
    .limit(MAX_TIMELINE_EVENTS);

  return [
    { type: "REQUEST_SUBMITTED", occurredAt: request.createdAt.toISOString(), visitId: null },
    ...events.map((event) => ({
      type: VISIBLE_VISIT_EVENTS[event.type as keyof typeof VISIBLE_VISIT_EVENTS],
      occurredAt: event.occurredAt.toISOString(),
      visitId: event.visitId.toString(),
    })),
  ];
}
