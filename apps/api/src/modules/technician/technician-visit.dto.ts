import type { VisitDocument } from "../visits/visit.model.js";

/**
 * Technician-facing DTOs: explicit allow-lists, never a serialized
 * document. Deliberately absent: customer email/id, company/technician/
 * scheduler ids, request id, AI provider metadata (model, prompt version,
 * timestamps, error codes), locks, idempotency data, and anything
 * financial (none exists yet). `allowedActions` is an empty list until
 * technician actions exist — no action names are invented here.
 */

export interface RequestSummarySource {
  reference: string;
  address: string;
  contactPhone: string;
  devices: Array<{ clientDeviceId: string; label: string; brand: string | null; model: string | null }>;
}

export interface TechnicianDeviceSummary {
  clientDeviceId: string;
  label: string;
  brand: string | null;
  model: string | null;
}

export interface TechnicianVisitListItem {
  id: string;
  requestReference: string | null;
  startAt: string;
  endAt: string;
  timezone: string;
  status: string;
  workTypes: string[];
  customer: { name: string | null; phone: string | null };
  address: string | null;
  devices: TechnicianDeviceSummary[];
  allowedActions: string[];
}

/** Only the devices attached to the visit, in the visit's order — never the whole request. */
function visitDevices(visit: VisitDocument, request: RequestSummarySource | null): TechnicianDeviceSummary[] {
  if (!request) {
    return [];
  }
  const byId = new Map(request.devices.map((device) => [device.clientDeviceId, device]));
  const result: TechnicianDeviceSummary[] = [];
  for (const deviceId of visit.deviceIds) {
    const device = byId.get(deviceId);
    if (device) {
      result.push({
        clientDeviceId: device.clientDeviceId,
        label: device.label,
        brand: device.brand,
        model: device.model,
      });
    }
  }
  return result;
}

export function toTechnicianVisitListItem(
  visit: VisitDocument,
  request: RequestSummarySource | null,
  customerName: string | null
): TechnicianVisitListItem {
  return {
    id: visit._id.toString(),
    requestReference: request?.reference ?? null,
    startAt: visit.startAt.toISOString(),
    endAt: visit.endAt.toISOString(),
    timezone: visit.timezone,
    status: visit.status,
    workTypes: [...visit.workTypes],
    // The phone is the number the customer gave for *this* request, not
    // their account phone.
    customer: { name: customerName, phone: request?.contactPhone ?? null },
    address: request?.address ?? null,
    devices: visitDevices(visit, request),
    allowedActions: [],
  };
}

export interface RequestDetailSource extends RequestSummarySource {
  devices: Array<{
    clientDeviceId: string;
    label: string;
    brand: string | null;
    model: string | null;
    originalDescription: string;
    analysis: {
      summary: string;
      possibleCauses: string[];
      missingInformation: string[];
      inspectionQuestions: string[];
    } | null;
    analysisMetadata: { status: string };
  }>;
}

export interface TechnicianVisitDetail extends Omit<TechnicianVisitListItem, "devices"> {
  devices: Array<
    TechnicianDeviceSummary & {
      originalDescription: string;
      /** null (never invented) when analysis is unavailable. */
      analysis: {
        summary: string;
        possibleCauses: string[];
        missingInformation: string[];
        inspectionQuestions: string[];
      } | null;
      /** The minimum safe status only — no model, prompt version or error code. */
      analysisStatus: string;
    }
  >;
}

export function toTechnicianVisitDetail(
  visit: VisitDocument,
  request: RequestDetailSource | null,
  customerName: string | null
): TechnicianVisitDetail {
  const base = toTechnicianVisitListItem(visit, request, customerName);
  const byId = new Map((request?.devices ?? []).map((device) => [device.clientDeviceId, device]));

  const devices = base.devices.flatMap((summary) => {
    const source = byId.get(summary.clientDeviceId);
    if (!source) {
      return [];
    }
    return [
      {
        ...summary,
        originalDescription: source.originalDescription,
        analysis: source.analysis
          ? {
              summary: source.analysis.summary,
              possibleCauses: [...source.analysis.possibleCauses],
              missingInformation: [...source.analysis.missingInformation],
              inspectionQuestions: [...source.analysis.inspectionQuestions],
            }
          : null,
        analysisStatus: source.analysisMetadata.status,
      },
    ];
  });

  return { ...base, devices };
}
