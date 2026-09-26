import type { FilterQuery, Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { ServiceRequest } from "../requests/request.model.js";
import { User } from "../users/user.model.js";
import { Visit, type VisitDocument } from "../visits/visit.model.js";
import {
  toTechnicianVisitDetail,
  toTechnicianVisitListItem,
  type TechnicianVisitDetail,
  type TechnicianVisitListItem,
} from "./technician-visit.dto.js";
import type { TechnicianVisitsQuery } from "./technician-visit.schemas.js";

/** Identity is exclusively `req.auth` — never anything from the request. */
export interface TechnicianAuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
}

/**
 * THE current-assignment authorization check. Company and technician are
 * both part of the database lookup itself (never `findById` followed by a
 * later comparison), and `Visit.technicianId` — the single, current
 * assignment — is the only authority. `VisitEvent` is historical audit
 * data and is deliberately never consulted. A missing visit, a visit in
 * another company and a visit assigned to another technician are
 * indistinguishable (all the same 404), so there is no existence oracle.
 *
 * Every future technician action (edit, upload, collect, complete...) must
 * call this — or, for a write, put the same filter in the write itself —
 * instead of trusting a visit fetched earlier. See docs/api.md.
 */
export async function findAssignedVisit(auth: TechnicianAuthContext, visitId: string): Promise<VisitDocument> {
  const visit = await Visit.findOne({
    _id: visitId,
    companyId: auth.companyId,
    technicianId: auth.userId,
  });

  if (!visit) {
    throw HttpError.notFound("Visit not found");
  }
  return visit;
}

export interface TechnicianVisitPage {
  items: TechnicianVisitListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export async function listAssignedVisits(
  auth: TechnicianAuthContext,
  query: TechnicianVisitsQuery
): Promise<TechnicianVisitPage> {
  const filter: FilterQuery<VisitDocument> = {
    companyId: auth.companyId,
    technicianId: auth.userId,
  };
  if (query.status) {
    filter.status = query.status;
  }
  // Same half-open overlap semantics as FS18: a visit is in the window if
  // it ends after `from` and starts before `to`. Bounds are UTC instants.
  if (query.from) {
    filter.endAt = { $gt: query.from };
  }
  if (query.to) {
    filter.startAt = { $lt: query.to };
  }

  const [visits, total] = await Promise.all([
    Visit.find(filter)
      .sort({ startAt: 1, _id: 1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize),
    Visit.countDocuments(filter),
  ]);

  // Batch-load related data (two queries total, not one per visit), still
  // company-scoped.
  const requestIds = [...new Set(visits.map((visit) => visit.requestId.toString()))];
  const requests = requestIds.length
    ? await ServiceRequest.find({ _id: { $in: requestIds }, companyId: auth.companyId }).select(
        "reference address contactPhone customerId devices.clientDeviceId devices.label devices.brand devices.model"
      )
    : [];
  const requestById = new Map(requests.map((request) => [request._id.toString(), request]));

  const customerIds = [...new Set(requests.map((request) => request.customerId.toString()))];
  const customers = customerIds.length
    ? await User.find({ _id: { $in: customerIds }, companyId: auth.companyId }).select("name")
    : [];
  const customerNameById = new Map(customers.map((customer) => [customer._id.toString(), customer.name]));

  return {
    items: visits.map((visit) => {
      const request = requestById.get(visit.requestId.toString()) ?? null;
      const customerName = request ? (customerNameById.get(request.customerId.toString()) ?? null) : null;
      return toTechnicianVisitListItem(visit, request, customerName);
    }),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

/**
 * Everything returned is derived from the authorized visit: the request
 * comes from `visit.requestId` (company-scoped) and only the devices in
 * `visit.deviceIds` are included, matched by `clientDeviceId`.
 */
export async function getAssignedVisitDetail(
  auth: TechnicianAuthContext,
  visitId: string
): Promise<TechnicianVisitDetail> {
  const visit = await findAssignedVisit(auth, visitId);

  const request = await ServiceRequest.findOne({ _id: visit.requestId, companyId: auth.companyId });
  const customer = request
    ? await User.findOne({ _id: request.customerId, companyId: auth.companyId }).select("name")
    : null;

  return toTechnicianVisitDetail(visit, request, customer?.name ?? null);
}
