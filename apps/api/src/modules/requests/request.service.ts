import { createHash, randomBytes } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/http-error.js";
import { isDuplicateKeyError } from "../../lib/mongo-errors.js";
import { analyzeDevices, type AnalyzeDevicesResult } from "../ai/gemini.service.js";
import { recordAttempt } from "../auth/auth-throttle.model.js";
import {
  IDEMPOTENCY_COMPLETED_TTL_MS,
  IDEMPOTENCY_IN_PROGRESS_TTL_MS,
  REFERENCE_ALPHABET,
  REFERENCE_PREFIX,
  REFERENCE_RANDOM_LENGTH,
} from "./request.constants.js";
import { RequestIdempotency, type RequestIdempotencyDocument } from "./request-idempotency.model.js";
import { ServiceRequest, type ServiceRequestDocument } from "./request.model.js";
import type { CreateRequestInput, DeviceInput } from "./request.schemas.js";

export interface RequestAuthContext {
  userId: Types.ObjectId;
  companyId: Types.ObjectId;
}

/**
 * Per-customer submission throttle — separate from FS14's own Gemini
 * throttle. That one is a single *global* bucket protecting the shared
 * provider quota; without this, one customer submitting many distinct
 * (non-duplicate) requests could exhaust that shared quota for every
 * other customer before ever hitting a per-caller limit. Applied before
 * anything expensive, including the idempotency check.
 */
export async function checkRequestCreationThrottle(userId: Types.ObjectId, now: Date = new Date()): Promise<void> {
  const count = await recordAttempt(`requests:create:user:${userId.toString()}`, env.REQUEST_CREATE_WINDOW_MS, now);
  if (count > env.REQUEST_CREATE_MAX_ATTEMPTS_PER_USER) {
    throw HttpError.rateLimited();
  }
}

/**
 * FS13 (photo/upload) does not exist anywhere in this repository — no
 * model, no ownership contract, nothing to verify against. Accepting a
 * client-supplied photoId with no way to verify it belongs to this
 * customer/company would be exactly the "attach another customer's
 * photo by guessing an ID" hole FS15 is required to prevent, so the only
 * safe behavior until FS13 ships is to refuse the request outright
 * rather than silently accept unverified references. See docs/api.md
 * "Photo attachments" for the tracked blocker.
 */
function assertNoPhotosRequested(devices: readonly DeviceInput[]): void {
  const anyPhotos = devices.some((device) => device.photoIds.length > 0);
  if (anyPhotos) {
    throw HttpError.photoNotAvailable();
  }
}

/**
 * A cryptographic hash of a canonicalized request shape, used only for
 * equality-checking a retried Idempotency-Key against the payload it was
 * first used with — never exposed to the client, never reversible to
 * the original content. Devices (and each device's photoIds) are sorted
 * before hashing so re-serializing the same logical payload in a
 * different array order still fingerprints identically.
 */
function computeFingerprint(input: CreateRequestInput): string {
  const canonicalDevices = [...input.devices]
    .map((device) => ({
      clientDeviceId: device.clientDeviceId,
      label: device.label,
      brand: device.brand ?? null,
      model: device.model ?? null,
      originalDescription: device.originalDescription,
      photoIds: [...device.photoIds].sort(),
    }))
    .sort((a, b) => a.clientDeviceId.localeCompare(b.clientDeviceId));

  const canonical = JSON.stringify({
    address: input.address,
    contactPhone: input.contactPhone,
    devices: canonicalDevices,
  });

  return createHash("sha256").update(canonical).digest("hex");
}

function randomReference(): string {
  const bytes = randomBytes(REFERENCE_RANDOM_LENGTH);
  let suffix = "";
  for (let i = 0; i < REFERENCE_RANDOM_LENGTH; i += 1) {
    suffix += REFERENCE_ALPHABET[bytes[i]! % REFERENCE_ALPHABET.length];
  }
  return `${REFERENCE_PREFIX}${suffix}`;
}

type ReservationOutcome =
  | { owned: true; reservation: RequestIdempotencyDocument }
  | { owned: false; reservation: RequestIdempotencyDocument };

/**
 * Atomically claims ownership of (companyId, customerId, idempotencyKey)
 * for this submission, or determines that someone else already has.
 * Never persists request content — only a fingerprint for mismatch
 * detection (see docs/api.md "Idempotency").
 */
async function reserveIdempotency(
  auth: RequestAuthContext,
  idempotencyKey: string,
  fingerprint: string,
  now: Date
): Promise<ReservationOutcome> {
  try {
    const reservation = await RequestIdempotency.create({
      companyId: auth.companyId,
      customerId: auth.userId,
      idempotencyKey,
      fingerprint,
      status: "IN_PROGRESS",
      requestId: null,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_IN_PROGRESS_TTL_MS),
    });
    return { owned: true, reservation };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }

  const existing = await RequestIdempotency.findOne({
    companyId: auth.companyId,
    customerId: auth.userId,
    idempotencyKey,
  });

  if (!existing) {
    // Lost a race with the reservation's own TTL cleanup between the
    // failed insert and this read — vanishingly rare. Safe to ask the
    // client to retry rather than looping internally.
    throw HttpError.requestCreationFailed();
  }

  if (existing.fingerprint !== fingerprint) {
    throw HttpError.idempotencyConflict();
  }

  if (existing.status === "COMPLETED") {
    return { owned: false, reservation: existing };
  }

  if (existing.status === "IN_PROGRESS") {
    throw HttpError.idempotencyInProgress();
  }

  // status === "FAILED": the previous attempt never completed, so this
  // retry may legitimately take over and try again (which may mean
  // calling Gemini again — correct here, since nothing ever succeeded).
  const reclaimed = await RequestIdempotency.findOneAndUpdate(
    { _id: existing._id, status: "FAILED" },
    { $set: { status: "IN_PROGRESS", expiresAt: new Date(now.getTime() + IDEMPOTENCY_IN_PROGRESS_TTL_MS) } },
    { new: true }
  );

  if (!reclaimed) {
    // Another concurrent retry reclaimed it first.
    throw HttpError.idempotencyInProgress();
  }

  return { owned: true, reservation: reclaimed };
}

async function markReservationFailed(reservationId: Types.ObjectId): Promise<void> {
  await RequestIdempotency.updateOne(
    { _id: reservationId, status: "IN_PROGRESS" },
    { $set: { status: "FAILED", expiresAt: new Date(Date.now() + IDEMPOTENCY_IN_PROGRESS_TTL_MS) } }
  );
}

interface RequestLogEvent {
  outcome: "created" | "idempotent_hit" | "failed";
  requestId?: string;
  userId: string;
  companyId: string;
  deviceCount: number;
  durationMs?: number;
}

/** Safe operational metadata only — never address/phone/description/photoIds. */
function logRequestCreationEvent(event: RequestLogEvent): void {
  const log = event.outcome === "failed" ? console.warn : console.info;
  log({ event: "requests.create", ...event });
}

export interface CreateServiceRequestOutcome {
  status: 201 | 200;
  request: ServiceRequestDocument;
}

/**
 * FS15's core flow:
 *   photo blocker check -> idempotency reserve/lookup -> FS14
 *   analyzeDevices() (skipped entirely on an idempotent hit) -> a single
 *   short transaction creating the request and completing the
 *   reservation together.
 *
 * The transaction is what actually closes the "created the request but
 * crashed before marking idempotency complete" gap: both writes commit
 * together or neither does, so a retry after a mid-flight crash finds a
 * cleanly reclaimable FAILED reservation and no orphaned request — never
 * a duplicate.
 */
export async function createServiceRequest(
  auth: RequestAuthContext,
  input: CreateRequestInput,
  idempotencyKey: string
): Promise<CreateServiceRequestOutcome> {
  assertNoPhotosRequested(input.devices);

  const now = new Date();
  const fingerprint = computeFingerprint(input);
  const reservationOutcome = await reserveIdempotency(auth, idempotencyKey, fingerprint, now);

  if (!reservationOutcome.owned) {
    const existingRequest = await ServiceRequest.findOne({
      _id: reservationOutcome.reservation.requestId,
      companyId: auth.companyId,
      customerId: auth.userId,
    });

    if (!existingRequest) {
      throw HttpError.requestCreationFailed();
    }

    logRequestCreationEvent({
      outcome: "idempotent_hit",
      requestId: existingRequest._id.toString(),
      userId: auth.userId.toString(),
      companyId: auth.companyId.toString(),
      deviceCount: existingRequest.devices.length,
    });

    return { status: 200, request: existingRequest };
  }

  const reservation = reservationOutcome.reservation;
  const startedAt = Date.now();

  let analysis: AnalyzeDevicesResult;
  try {
    analysis = await analyzeDevices({
      devices: input.devices.map((device) => ({
        clientDeviceId: device.clientDeviceId,
        originalDescription: device.originalDescription,
        equipment: buildEquipmentInput(device),
      })),
    });
  } catch (error) {
    // analyzeDevices() only ever throws for an invalid *call* (a
    // programming error on this service's part) — provider failures
    // always resolve as a controlled result, never a throw. Either way,
    // release the reservation so a retry isn't stuck until the TTL.
    await markReservationFailed(reservation._id);
    throw error;
  }

  const analysisByDeviceId = new Map(analysis.devices.map((device) => [device.clientDeviceId, device]));
  const reference = randomReference();

  const session = await mongoose.startSession();
  let created: ServiceRequestDocument;
  try {
    created = await session.withTransaction(async () => {
      const deviceSubdocuments = input.devices.map((device) => {
        const deviceAnalysis = analysisByDeviceId.get(device.clientDeviceId);
        return {
          clientDeviceId: device.clientDeviceId,
          label: device.label,
          brand: device.brand ?? null,
          model: device.model ?? null,
          originalDescription: device.originalDescription,
          photoIds: [] as string[],
          analysis: deviceAnalysis?.analysis ?? null,
          analysisMetadata: deviceAnalysis?.metadata
            ? {
                status: deviceAnalysis.metadata.status,
                model: deviceAnalysis.metadata.model,
                promptVersion: deviceAnalysis.metadata.promptVersion,
                processedAt: new Date(deviceAnalysis.metadata.processedAt),
                errorCode: deviceAnalysis.metadata.errorCode ?? null,
              }
            : {
                status: "UNAVAILABLE" as const,
                model: env.GEMINI_MODEL,
                promptVersion: "unknown",
                processedAt: now,
                errorCode: "GEMINI_INVALID_OUTPUT" as const,
              },
        };
      });

      const [requestDoc] = await ServiceRequest.create(
        [
          {
            companyId: auth.companyId,
            customerId: auth.userId,
            reference,
            status: "SUBMITTED",
            address: input.address,
            contactPhone: input.contactPhone,
            devices: deviceSubdocuments,
          },
        ],
        { session }
      );

      await RequestIdempotency.updateOne(
        { _id: reservation._id },
        {
          $set: {
            status: "COMPLETED",
            requestId: requestDoc!._id,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_COMPLETED_TTL_MS),
          },
        },
        { session }
      );

      return requestDoc!;
    });
  } catch (error) {
    await markReservationFailed(reservation._id).catch(() => {
      // Best-effort: if this also fails, the TTL still reclaims it
      // eventually — never let a logging/cleanup failure mask the
      // original persistence error.
    });
    logRequestCreationEvent({
      outcome: "failed",
      userId: auth.userId.toString(),
      companyId: auth.companyId.toString(),
      deviceCount: input.devices.length,
      durationMs: Date.now() - startedAt,
    });
    throw HttpError.requestCreationFailed();
  } finally {
    await session.endSession();
  }

  logRequestCreationEvent({
    outcome: "created",
    requestId: created._id.toString(),
    userId: auth.userId.toString(),
    companyId: auth.companyId.toString(),
    deviceCount: created.devices.length,
    durationMs: Date.now() - startedAt,
  });

  return { status: 201, request: created };
}

function buildEquipmentInput(device: DeviceInput): Record<string, string> {
  const equipment: Record<string, string> = { label: device.label };
  if (device.brand) equipment.brand = device.brand;
  if (device.model) equipment.model = device.model;
  return equipment;
}
