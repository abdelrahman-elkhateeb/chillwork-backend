import mongoose, { Types } from "mongoose";
import { issueInvoice } from "../modules/billing/invoice.service.js";
import { Part, partNameKey } from "../modules/catalog/part.model.js";
import { PartStockMovement } from "../modules/catalog/part-stock-movement.model.js";
import { Company } from "../modules/companies/company.model.js";
import { ServiceRequest } from "../modules/requests/request.model.js";
import { recordPartDecisions, setDeviceParts } from "../modules/technician/device-parts.service.js";
import { completeVisit, startVisit } from "../modules/technician/technician-visit.service.js";
import { recordWorkResult } from "../modules/technician/work-result.service.js";
import { hashPassword } from "../modules/users/password.js";
import { User, type UserRole } from "../modules/users/user.model.js";
import { createVisit } from "../modules/visits/visit.service.js";

/**
 * FS34 — synthetic demo data. Everything here is invented: names, phones,
 * addresses, descriptions and the AI analyses (stored with
 * `model: "synthetic-demo-sample"`, `promptVersion: "demo-seed"`, so no
 * record ever claims Gemini produced it). Visits, part selections, work
 * results and invoices are created through the real services, so the demo
 * exercises the same rules (stock, pricing, events) as production.
 *
 * Only ever touches documents whose companyId is the demo company or the
 * test-only second tenant; see seed-demo.ts for the CLI guards.
 */

/** Fixed id ("demo-tenant2" as 12 bytes) for the isolation-only second company. */
export const SECOND_TENANT_ID = new Types.ObjectId("64656d6f2d74656e616e7432");

export const DEMO_EMAIL_DOMAIN = "demo.chillwork.test";
export const SAMPLE_ANALYSIS_MODEL = "synthetic-demo-sample";
export const SAMPLE_PROMPT_VERSION = "demo-seed";

export interface DemoTargetCheck {
  nodeEnv: string;
  connectedDatabase: string;
  expectedDatabase: string | undefined;
  demoCompanyId: string | undefined;
  password: string | undefined;
}

/**
 * Refuses anything but an explicitly named, non-production demo database.
 * Returns the validated demo company id and password.
 */
export function assertSafeDemoTarget(check: DemoTargetCheck): { demoCompanyId: Types.ObjectId; password: string } {
  if (check.nodeEnv === "production") {
    throw new Error("Refusing to seed demo data with NODE_ENV=production");
  }
  if (!check.expectedDatabase || check.expectedDatabase !== check.connectedDatabase) {
    throw new Error(
      `DEMO_SEED_DATABASE must name the connected database exactly (connected to "${check.connectedDatabase}")`
    );
  }
  if (!check.demoCompanyId || !Types.ObjectId.isValid(check.demoCompanyId)) {
    throw new Error("DEMO_COMPANY_ID must be set to the demo company's ObjectId");
  }
  if (!check.password || check.password.length < 12) {
    throw new Error("DEMO_SEED_PASSWORD must be set (at least 12 characters)");
  }
  return { demoCompanyId: new Types.ObjectId(check.demoCompanyId), password: check.password };
}

/** Deletes every document belonging to the demo company or the second tenant, in every collection. */
export async function resetDemoData(demoCompanyId: Types.ObjectId): Promise<void> {
  const companyIds = [demoCompanyId, SECOND_TENANT_ID];
  const db = mongoose.connection.db;
  if (!db) throw new Error("Not connected to MongoDB");
  for (const collection of await db.collections()) {
    await collection.deleteMany({ companyId: { $in: companyIds } });
  }
  await Company.deleteMany({ _id: { $in: companyIds } });
}

interface SeedUser {
  key: string;
  name: string;
  role: UserRole;
  phone: string;
}

const DEMO_USERS: SeedUser[] = [
  { key: "admin", name: "Nour Admin", role: "ADMIN", phone: "+201000000001" },
  { key: "tech.omar", name: "Omar Technician", role: "TECHNICIAN", phone: "+201000000002" },
  { key: "tech.sara", name: "Sara Technician", role: "TECHNICIAN", phone: "+201000000003" },
  { key: "customer.mona", name: "Mona Customer", role: "CUSTOMER", phone: "+201000000004" },
  { key: "customer.karim", name: "Karim Customer", role: "CUSTOMER", phone: "+201000000005" },
];

const DEMO_PARTS = [
  { key: "motor", name: "Indoor Fan Motor", unitPriceMinor: 45000, stockQuantity: 6, isActive: true },
  { key: "capacitor", name: "Run Capacitor 35uF", unitPriceMinor: 8000, stockQuantity: 20, isActive: true },
  { key: "compressor", name: "Rotary Compressor 1.5HP", unitPriceMinor: 350000, stockQuantity: 2, isActive: true },
  { key: "gas", name: "Refrigerant R410A (1 kg)", unitPriceMinor: 60000, stockQuantity: 10, isActive: true },
  { key: "pcb", name: "Indoor PCB Control Board", unitPriceMinor: 120000, stockQuantity: 0, isActive: true },
  { key: "remote", name: "Universal Remote (discontinued)", unitPriceMinor: 15000, stockQuantity: 3, isActive: false },
] as const;
type PartKey = (typeof DEMO_PARTS)[number]["key"];

function sampleAnalysis(summary: string, causes: string[], questions: string[]) {
  return {
    analysis: { summary, possibleCauses: causes, missingInformation: ["Unit age"], inspectionQuestions: questions },
    analysisMetadata: {
      status: "SUCCESS",
      model: SAMPLE_ANALYSIS_MODEL,
      promptVersion: SAMPLE_PROMPT_VERSION,
      processedAt: new Date("2026-01-01T00:00:00Z"),
      errorCode: null,
    },
  };
}

function device(clientDeviceId: string, label: string, description: string, analysis: ReturnType<typeof sampleAnalysis>) {
  return { clientDeviceId, label, brand: "Sample Brand", model: null, originalDescription: description, ...analysis };
}

const NOT_COOLING = sampleAnalysis(
  "The unit runs but does not cool; a failed fan motor or low refrigerant are likely.",
  ["Failed indoor fan motor", "Low refrigerant charge"],
  ["Does the indoor fan spin?", "Is there ice on the pipes?"]
);
const NOISY = sampleAnalysis(
  "A humming noise without the compressor starting often points at the capacitor.",
  ["Weak run capacitor", "Seized compressor"],
  ["Does the outdoor unit hum and then stop?"]
);
const DEAD = sampleAnalysis(
  "No power at the indoor unit suggests a control board or supply fault.",
  ["Control board failure", "Tripped breaker"],
  ["Is the breaker on?", "Does the display light up?"]
);

let referenceCounter = 0;
function demoReference(): string {
  referenceCounter += 1;
  return `SR-DEMO${String(referenceCounter).padStart(4, "0")}`;
}

/** An instant `days` from now at `hour`:00 UTC — keeps the walkthrough "current" whenever it is reset. */
function at(days: number, hour: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

export interface DemoSeedSummary {
  companyId: string;
  accounts: Array<{ email: string; role: UserRole }>;
  parts: number;
  requests: number;
  visits: number;
  invoices: string[];
}

/**
 * Seeds the demo company (and the isolation tenant) from scratch. Refuses
 * to run on top of existing demo data — call `resetDemoData` first — so a
 * reset + seed always reproduces the same walkthrough.
 */
export async function seedDemo(demoCompanyId: Types.ObjectId, password: string): Promise<DemoSeedSummary> {
  if (await Company.exists({ _id: { $in: [demoCompanyId, SECOND_TENANT_ID] } })) {
    throw new Error("Demo data already exists; run with --reset to recreate it");
  }
  referenceCounter = 0;
  const passwordHash = await hashPassword(password);

  await Company.create({
    _id: demoCompanyId,
    name: "Chillwork Demo Co.",
    timezone: "Africa/Cairo",
    contactPhone: "+201000000000",
    contactEmail: `ops@${DEMO_EMAIL_DOMAIN}`,
    currency: "EGP",
    laborFeeMinor: 15000,
  });

  const users = new Map<string, Types.ObjectId>();
  for (const user of DEMO_USERS) {
    const created = await User.create({
      email: `${user.key}@${DEMO_EMAIL_DOMAIN}`,
      name: user.name,
      phone: user.phone,
      passwordHash,
      role: user.role,
      companyId: demoCompanyId,
    });
    users.set(user.key, created._id);
  }
  const userId = (key: string) => users.get(key)!;

  const parts = new Map<PartKey, Types.ObjectId>();
  for (const part of DEMO_PARTS) {
    const created = await Part.create({
      companyId: demoCompanyId,
      name: part.name,
      nameKey: partNameKey(part.name),
      unitPriceMinor: part.unitPriceMinor,
      stockQuantity: part.stockQuantity,
      isActive: part.isActive,
    });
    parts.set(part.key, created._id);
    if (part.stockQuantity > 0) {
      await PartStockMovement.create({
        companyId: demoCompanyId,
        partId: created._id,
        delta: part.stockQuantity,
        quantityAfter: part.stockQuantity,
        reason: "ADMIN_ADJUSTMENT",
        note: "Demo seed initial stock",
        actorId: userId("admin"),
        occurredAt: new Date(),
      });
    }
  }
  const partId = (key: PartKey) => String(parts.get(key)!);

  const newRequest = (customerKey: string, address: string, devices: ReturnType<typeof device>[]) =>
    ServiceRequest.create({
      companyId: demoCompanyId,
      customerId: userId(customerKey),
      reference: demoReference(),
      status: "SUBMITTED",
      address,
      contactPhone: DEMO_USERS.find((u) => u.key === customerKey)!.phone,
      devices,
    });

  const monaHome = await newRequest("customer.mona", "12 Nile Street, Cairo", [
    device("living-room", "Living room AC", "It runs but blows warm air since yesterday.", NOT_COOLING),
    device("bedroom", "Bedroom AC", "Outdoor unit hums loudly and nothing starts.", NOISY),
  ]);
  const karimOffice = await newRequest("customer.karim", "5 Tahrir Square, Cairo", [
    device("office", "Office AC", "Completely dead, no lights on the display.", DEAD),
  ]);
  const monaStudio = await newRequest("customer.mona", "12 Nile Street, Cairo (studio)", [
    device("studio", "Studio AC", "Weak airflow and some water dripping.", NOT_COOLING),
  ]);
  const karimHome = await newRequest("customer.karim", "40 Zamalek Road, Cairo", [
    device("hall", "Hall AC", "Not cooling well in the afternoon.", NOT_COOLING),
    device("kids-room", "Kids room AC", "Makes a clicking sound when starting.", NOISY),
  ]);
  await newRequest("customer.mona", "12 Nile Street, Cairo", [
    device("kitchen", "Kitchen AC", "Smells of burning plastic when switched on.", DEAD),
  ]);

  const admin = { userId: userId("admin"), companyId: demoCompanyId };
  const omar = { userId: userId("tech.omar"), companyId: demoCompanyId };
  const sara = { userId: userId("tech.sara"), companyId: demoCompanyId };

  const schedule = (requestId: Types.ObjectId, technicianId: Types.ObjectId, deviceIds: string[], day: number, hour: number) =>
    createVisit(admin, String(requestId), {
      technicianId: String(technicianId),
      startAt: new Date(at(day, hour)),
      endAt: new Date(at(day, hour + 2)),
      deviceIds,
      workTypes: ["INSPECTION", "REPAIR"],
    });

  // 1. Completed yesterday, partially repaired, invoiced (parts + labor for one device).
  const partial = await schedule(monaHome._id, omar.userId, ["living-room", "bedroom"], -1, 7);
  await startVisit(omar, String(partial._id));
  const livingRoomParts = await setDeviceParts(omar, String(partial._id), "living-room", {
    items: [
      { partId: partId("motor"), quantity: 1 },
      { partId: partId("capacitor"), quantity: 1 },
    ],
    version: 0,
  });
  // Approve the picked parts — a REPAIRED device now requires at least one
  // approved DeviceParts proposal (see work-result.service.ts).
  await recordPartDecisions(omar, String(partial._id), "living-room", {
    version: livingRoomParts.version,
    decisions: livingRoomParts.items.map((item) => ({ proposalId: item.proposalId!, decision: "APPROVED" })),
  });
  await recordWorkResult(omar, String(partial._id), "living-room", { result: "REPAIRED", version: 0 });
  await recordWorkResult(omar, String(partial._id), "bedroom", {
    result: "FAILED",
    failureReason: "PART_UNAVAILABLE",
    failureNote: "Compressor replacement needed; customer will decide later.",
    version: 0,
  });
  await completeVisit(omar, String(partial._id));
  const partialInvoice = await issueInvoice(omar, String(partial._id), "demo-seed-partial");

  // 2. Completed yesterday, nothing repaired: zero-charge CLOSED invoice.
  const failed = await schedule(karimOffice._id, sara.userId, ["office"], -1, 10);
  await startVisit(sara, String(failed._id));
  await recordWorkResult(sara, String(failed._id), "office", {
    result: "FAILED",
    failureReason: "PART_UNAVAILABLE",
    failureNote: "Control board out of stock.",
    version: 0,
  });
  await completeVisit(sara, String(failed._id));
  const zeroInvoice = await issueInvoice(sara, String(failed._id), "demo-seed-zero");

  // 3. In progress today: parts picked, result not recorded yet.
  const inProgress = await schedule(monaStudio._id, sara.userId, ["studio"], 0, 6);
  await startVisit(sara, String(inProgress._id));
  await setDeviceParts(sara, String(inProgress._id), "studio", {
    items: [{ partId: partId("gas"), quantity: 1 }],
    version: 0,
  });

  // 4. Scheduled for tomorrow.
  await schedule(karimHome._id, omar.userId, ["hall", "kids-room"], 1, 8);

  // 5. The kitchen request stays SUBMITTED and unscheduled for the admin to book.

  // Test-only second tenant: proves nothing crosses company boundaries.
  await Company.create({
    _id: SECOND_TENANT_ID,
    name: "Other Tenant (isolation test data)",
    timezone: "UTC",
    currency: "USD",
    laborFeeMinor: 5000,
  });
  const otherCustomer = await User.create({
    email: `other.customer@${DEMO_EMAIL_DOMAIN}`,
    name: "Other Tenant Customer",
    phone: "+15550009999",
    passwordHash,
    role: "CUSTOMER",
    companyId: SECOND_TENANT_ID,
  });
  await User.create({
    email: `other.admin@${DEMO_EMAIL_DOMAIN}`,
    name: "Other Tenant Admin",
    phone: "+15550009998",
    passwordHash,
    role: "ADMIN",
    companyId: SECOND_TENANT_ID,
  });
  await Part.create({
    companyId: SECOND_TENANT_ID,
    name: "Other Tenant Part",
    nameKey: partNameKey("Other Tenant Part"),
    unitPriceMinor: 1000,
    stockQuantity: 1,
  });
  await ServiceRequest.create({
    companyId: SECOND_TENANT_ID,
    customerId: otherCustomer._id,
    reference: demoReference(),
    status: "SUBMITTED",
    address: "1 Elsewhere Ave",
    contactPhone: "+15550009999",
    devices: [device("other", "Other AC", "Isolation test request.", DEAD)],
  });

  const accounts = await User.find({ companyId: { $in: [demoCompanyId, SECOND_TENANT_ID] } })
    .sort({ email: 1 })
    .select("email role");

  return {
    companyId: String(demoCompanyId),
    accounts: accounts.map((account) => ({ email: account.email, role: account.role })),
    parts: DEMO_PARTS.length,
    requests: await ServiceRequest.countDocuments({ companyId: demoCompanyId }),
    visits: 4,
    invoices: [partialInvoice.invoice.reference, zeroInvoice.invoice.reference],
  };
}
