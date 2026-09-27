import mongoose, { type FilterQuery, type Types } from "mongoose";
import { HttpError } from "../../lib/http-error.js";
import { ServiceRequest } from "../requests/request.model.js";
import { User } from "../users/user.model.js";
import { VisitEvent } from "../visits/visit-event.model.js";
import { Visit, type VisitDocument } from "../visits/visit.model.js";
import { WorkResult } from "./work-result.model.js";
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

/**
 * FS23's smallest necessary lifecycle addition: work results may only be
 * recorded/edited while a visit is IN_PROGRESS (see work-result.service.ts),
 * and immutability requires COMPLETED to actually be reachable — but no
 * endpoint in this repository has ever transitioned a Visit out of
 * SCHEDULED. There is no admin/scheduling change here: both transitions
 * below are technician-initiated (the technician starting/finishing their
 * own assigned visit), scoped by `findAssignedVisit`, so a reassignment
 * still takes effect immediately.
 */
export async function startVisit(auth: TechnicianAuthContext, visitId: string): Promise<VisitDocument> {
  const visit = await findAssignedVisit(auth, visitId); // uniform 404 first

  const now = new Date();
  const started = await Visit.findOneAndUpdate(
    { _id: visit._id, companyId: auth.companyId, technicianId: auth.userId, status: "SCHEDULED" },
    { $set: { status: "IN_PROGRESS" } },
    { new: true }
  );
  if (!started) {
    // Assignment was fine (findAssignedVisit above proved that); the only
    // way this CAS can still fail is status !== SCHEDULED.
    throw HttpError.visitStatusConflict("Only a SCHEDULED visit can be started");
  }

  await VisitEvent.create({
    companyId: auth.companyId,
    visitId: started._id,
    requestId: started.requestId,
    type: "VISIT_STARTED",
    actorId: auth.userId,
    technicianId: auth.userId,
    occurredAt: now,
    clientDeviceId: null,
    result: null,
  });

  return started;
}

/**
 * Blocked until every device in `Visit.deviceIds` has a recorded work
 * result (REPAIRED or FAILED — either is a resolved outcome). This uses
 * `Visit.deviceIds` — the set an admin already assigned to this visit —
 * as the "required work" boundary. There is no Quote/Approval model in
 * this repository to derive a narrower "approved devices" set from; using
 * the already-established visit scope is the smallest choice that does
 * not invent a second approval mechanism. See docs/api.md "Technician
 * work execution (FS23)".
 */
export async function completeVisit(auth: TechnicianAuthContext, visitId: string): Promise<VisitDocument> {
  const visit = await findAssignedVisit(auth, visitId);
  // Checked up front so "wrong status" and "missing results" are never
  // conflated: a SCHEDULED/CANCELLED/already-COMPLETED visit is rejected
  // for its status regardless of what results happen to exist.
  if (visit.status !== "IN_PROGRESS") {
    throw HttpError.visitStatusConflict("Only an IN_PROGRESS visit can be completed");
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const results = await WorkResult.find({ companyId: auth.companyId, visitId: visit._id })
        .select("clientDeviceId")
        .session(session);
      const recorded = new Set(results.map((result) => result.clientDeviceId));
      const missing = visit.deviceIds.filter((deviceId) => !recorded.has(deviceId));
      if (missing.length > 0) {
        throw HttpError.workResultsIncomplete();
      }

      const now = new Date();
      const completed = await Visit.findOneAndUpdate(
        { _id: visit._id, companyId: auth.companyId, technicianId: auth.userId, status: "IN_PROGRESS" },
        { $set: { status: "COMPLETED" } },
        { session, new: true }
      );
      if (!completed) {
        throw HttpError.visitStatusConflict("Only an IN_PROGRESS visit can be completed");
      }

      await VisitEvent.create(
        [
          {
            companyId: auth.companyId,
            visitId: completed._id,
            requestId: completed.requestId,
            type: "VISIT_COMPLETED",
            actorId: auth.userId,
            technicianId: auth.userId,
            occurredAt: now,
            clientDeviceId: null,
            result: null,
          },
        ],
        { session, ordered: true }
      );

      return completed;
    });
  } finally {
    await session.endSession();
  }
}
