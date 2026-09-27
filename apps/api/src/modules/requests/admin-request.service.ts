import type { FilterQuery, Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { Invoice } from "../billing/invoice.model.js";
import { deriveVisitOutcome } from "../technician/work-result.service.js";
import { WorkResult } from "../technician/work-result.model.js";
import { User } from "../users/user.model.js";
import { SCHEDULABLE_REQUEST_STATUSES } from "../visits/visit.constants.js";
import { Visit, type VisitDocument } from "../visits/visit.model.js";
import type { AdminRequestsQuery } from "./admin-request.schemas.js";
import { ServiceRequest, type ServiceRequestDocument } from "./request.model.js";

export interface AdminAuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
}

/** A device counts as scheduled once any visit that isn't CANCELLED covers it. */
const COVERING_VISIT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED"] as const;

/** Upper bound on customers a name/email/phone search can expand to. */
const MAX_SEARCH_CUSTOMERS = 500;

export const ADMIN_REQUEST_ACTIONS = ["SCHEDULE_VISIT"] as const;
export type AdminRequestAction = (typeof ADMIN_REQUEST_ACTIONS)[number];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function coveredDeviceIds(visits: readonly Pick<VisitDocument, "status" | "deviceIds">[]): Set<string> {
  const covered = new Set<string>();
  for (const visit of visits) {
    if ((COVERING_VISIT_STATUSES as readonly string[]).includes(visit.status)) {
      visit.deviceIds.forEach((id) => covered.add(id));
    }
  }
  return covered;
}

/**
 * Only scheduling exists as an admin action today: offered while the
 * request is in a schedulable status and some device has no covering
 * visit. Cancel/reschedule/reassign are FS20.
 */
function nextActionsFor(request: ServiceRequestDocument, unscheduledCount: number): AdminRequestAction[] {
  return SCHEDULABLE_REQUEST_STATUSES.includes(request.status) && unscheduledCount > 0 ? ["SCHEDULE_VISIT"] : [];
}

/**
 * `search` matches a reference prefix (case-insensitive, anchored so the
 * unique reference index serves it) or a customer of this company whose
 * name/email/phone contains it. Always literal text, never a regex.
 */
async function searchFilter(auth: AdminAuthContext, search: string): Promise<FilterQuery<ServiceRequestDocument>> {
  const literal = escapeRegex(search);
  const contains = { $regex: literal, $options: "i" };
  const customers = await User.find({
    companyId: auth.companyId,
    role: "CUSTOMER",
    $or: [{ name: contains }, { email: contains }, { phone: contains }],
  })
    .select("_id")
    .limit(MAX_SEARCH_CUSTOMERS);

  return {
    $or: [
      { reference: { $regex: `^${escapeRegex(search.toUpperCase())}` } },
      { customerId: { $in: customers.map((customer) => customer._id) } },
    ],
  };
}

export async function listAdminRequests(auth: AdminAuthContext, query: AdminRequestsQuery) {
  const filter: FilterQuery<ServiceRequestDocument> = { companyId: auth.companyId };
  if (query.status) filter.status = query.status;
  if (query.search) Object.assign(filter, await searchFilter(auth, query.search));

  const [requests, total] = await Promise.all([
    ServiceRequest.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .select("reference status address contactPhone customerId devices.clientDeviceId createdAt"),
    ServiceRequest.countDocuments(filter),
  ]);

  const requestIds = requests.map((request) => request._id);
  const customerIds = [...new Set(requests.map((request) => request.customerId.toString()))];
  const [visits, customers] = await Promise.all([
    requestIds.length
      ? Visit.find({ companyId: auth.companyId, requestId: { $in: requestIds } }).select("requestId status deviceIds")
      : [],
    customerIds.length ? User.find({ _id: { $in: customerIds }, companyId: auth.companyId }).select("name") : [],
  ]);
  const visitsByRequest = new Map<string, VisitDocument[]>();
  for (const visit of visits) {
    const key = visit.requestId.toString();
    visitsByRequest.set(key, [...(visitsByRequest.get(key) ?? []), visit]);
  }
  const customerName = new Map(customers.map((customer) => [customer._id.toString(), customer.name]));

  return {
    items: requests.map((request) => {
      const requestVisits = visitsByRequest.get(request._id.toString()) ?? [];
      const covered = coveredDeviceIds(requestVisits);
      const unscheduledDeviceCount = request.devices.filter((device) => !covered.has(device.clientDeviceId)).length;
      return {
        requestId: request._id.toString(),
        reference: request.reference,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
        address: request.address,
        customer: {
          id: request.customerId.toString(),
          name: customerName.get(request.customerId.toString()) ?? null,
          phone: request.contactPhone,
        },
        deviceCount: request.devices.length,
        unscheduledDeviceCount,
        visitCount: requestVisits.length,
        nextActions: nextActionsFor(request, unscheduledDeviceCount),
      };
    }),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

/**
 * Everything an admin needs to triage and follow one request, including
 * when the AI analysis failed: the customer's original text and the AI
 * output are separate fields, and `aiAnalysis.analysis` is null (never
 * invented) unless the analysis succeeded. Another company's request is a
 * plain 404.
 */
export async function getAdminRequest(auth: AdminAuthContext, requestId: string) {
  const request = await ServiceRequest.findOne({ _id: requestId, companyId: auth.companyId });
  if (!request) throw HttpError.notFound("Request not found");

  const visits = await Visit.find({ companyId: auth.companyId, requestId: request._id }).sort({ startAt: 1, _id: 1 });
  const visitIds = visits.map((visit) => visit._id);
  const technicianIds = [...new Set(visits.map((visit) => visit.technicianId.toString()))];

  const [customer, technicians, results, invoices] = await Promise.all([
    User.findOne({ _id: request.customerId, companyId: auth.companyId }).select("name email phone"),
    technicianIds.length ? User.find({ _id: { $in: technicianIds }, companyId: auth.companyId }).select("name") : [],
    visitIds.length ? WorkResult.find({ companyId: auth.companyId, visitId: { $in: visitIds } }) : [],
    visitIds.length ? Invoice.find({ companyId: auth.companyId, visitId: { $in: visitIds } }) : [],
  ]);
  const technicianName = new Map(technicians.map((technician) => [technician._id.toString(), technician.name]));
  const invoiceByVisit = new Map(invoices.map((invoice) => [invoice.visitId.toString(), invoice]));

  // The device's current visit: the latest non-cancelled one covering it.
  const visitByDevice = new Map<string, string>();
  for (const visit of visits) {
    if ((COVERING_VISIT_STATUSES as readonly string[]).includes(visit.status)) {
      visit.deviceIds.forEach((deviceId) => visitByDevice.set(deviceId, visit._id.toString()));
    }
  }
  const unscheduledDeviceCount = request.devices.filter((device) => !visitByDevice.has(device.clientDeviceId)).length;

  return {
    requestId: request._id.toString(),
    reference: request.reference,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    address: request.address,
    contactPhone: request.contactPhone,
    customer: customer
      ? { id: customer._id.toString(), name: customer.name, email: customer.email, phone: customer.phone }
      : null,
    devices: request.devices.map((device) => ({
      clientDeviceId: device.clientDeviceId,
      label: device.label,
      brand: device.brand,
      model: device.model,
      originalDescription: device.originalDescription,
      aiAnalysis: {
        status: device.analysisMetadata.status,
        errorCode: device.analysisMetadata.errorCode ?? null,
        analysis: device.analysis
          ? {
              summary: device.analysis.summary,
              possibleCauses: [...device.analysis.possibleCauses],
              missingInformation: [...device.analysis.missingInformation],
              inspectionQuestions: [...device.analysis.inspectionQuestions],
            }
          : null,
      },
      visitId: visitByDevice.get(device.clientDeviceId) ?? null,
    })),
    visits: visits.map((visit) => {
      const visitResults = new Map(
        results
          .filter((result) => result.visitId.equals(visit._id))
          .map((result) => [result.clientDeviceId, result.result] as const)
      );
      const invoice = invoiceByVisit.get(visit._id.toString());
      return {
        visitId: visit._id.toString(),
        technician: {
          id: visit.technicianId.toString(),
          name: technicianName.get(visit.technicianId.toString()) ?? null,
        },
        startAt: visit.startAt.toISOString(),
        endAt: visit.endAt.toISOString(),
        timezone: visit.timezone,
        status: visit.status,
        deviceIds: [...visit.deviceIds],
        workTypes: [...visit.workTypes],
        outcome: deriveVisitOutcome(visit.deviceIds, visitResults),
        invoice: invoice
          ? {
              id: invoice._id.toString(),
              reference: invoice.reference,
              currency: invoice.currency,
              totalMinor: invoice.totalMinor,
              status: invoice.status,
              paymentState: invoice.paymentState,
            }
          : null,
      };
    }),
    unscheduledDeviceCount,
    nextActions: nextActionsFor(request, unscheduledDeviceCount),
  };
}
