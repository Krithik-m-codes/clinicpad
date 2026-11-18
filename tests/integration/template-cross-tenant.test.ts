// @vitest-environment node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, count, eq, inArray } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/pdf", async () => {
  const { sharedFakeEngine } = await import("../helpers/fake-pdf-engine");
  return { getPdfEngine: () => sharedFakeEngine };
});
vi.mock("@/server/scanning", async () => {
  const { sharedFakeScanner } = await import("../helpers/fake-scanner");
  return { getMalwareScanner: () => sharedFakeScanner };
});

import { getSessionContext, requireSession } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import {
  auditEvents,
  clinics,
  doctors,
  prescriptionOutputs,
  prescriptionShares,
  shareLinks,
  templateFiles,
  templates,
  templateVersions,
} from "@/server/db/schema";
import { newId } from "@/lib/domain/ids";
import * as actions from "@/server/actions/templates";
import * as access from "@/server/services/template-access";
import * as archive from "@/server/services/template-archive";
import * as assign from "@/server/services/template-assign";
import * as files from "@/server/services/template-files";
import * as preview from "@/server/services/template-preview";
import * as publish from "@/server/services/template-publish";
import * as resolution from "@/server/services/template-resolution";
import * as views from "@/server/services/template-views";
import * as templatesService from "@/server/services/templates";
import * as rxOutput from "@/server/services/rx-output";
import * as sharing from "@/server/services/sharing";
import { GET as getFile } from "@/app/(app)/templates/files/[fileId]/route";
import { GET as getPreview } from "@/app/(app)/templates/[id]/preview/route";
import { GET as getAlignment } from "@/app/(app)/templates/[id]/alignment/route";
import { GET as getDocument } from "@/app/(app)/prescriptions/[id]/document/route";
import { GET as getPdf } from "@/app/(app)/prescriptions/[id]/pdf/route";
import { createFakeEmailProvider } from "../helpers/fake-email";
import { sharedFakeEngine } from "../helpers/fake-pdf-engine";
import { finalized, newPatient } from "../helpers/rx-flow";
import { backgroundPng, insertBackgroundFile, insertPublishedOverlay, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const getSession = vi.mocked(getSessionContext);
const requireSessionMock = vi.mocked(requireSession);

let A: TestTenant;
let B: TestTenant;
let a: Awaited<ReturnType<typeof insertPublishedOverlay>>;
let b: Awaited<ReturnType<typeof insertPublishedOverlay>>;
let aDoctorId = "";
let aRx = "";
let bRx = "";
const owner = () => B.as("owner");

/** Tenant A's ids (what B's caller guesses or has leaked) and B's own (for the mixed cases). */
type Ids = { template: string; version: string; file: string; rx: string; doctor: string };
const foreign = (): Ids => ({ template: a.templateId, version: a.versionId, file: a.fileId, rx: aRx, doctor: aDoctorId });
/** The same shape with ids that exist nowhere: the answer for tenant A's ids must be identical to this one. */
const missing = (): Ids => ({ template: newId(), version: newId(), file: newId(), rx: newId(), doctor: newId() });

const definition = () => structuredClone(MINIMAL_OVERLAY_DEFINITION);
const publishInput = { identity: "dynamic", boundDoctorId: null, confirmLetterhead: false, baseRevision: 0 };
const saveInput = (extra: Record<string, unknown> = {}) => ({ definition: definition(), labels: "en", baseRevision: 0, ...extra });

type Case = { name: string; run: (ids: Ids) => Promise<unknown>; /** Answers ok with an empty aggregate (same as a missing id) instead of refusing. */ emptyOk?: true };

// ---------------------------------------------------------------------------------------------------------------
// The table. Every exported function of the template, output and share services, every server action and every
// template, prescription output route is either a case below or an entry in ALLOW_LIST with the reason it takes no id.
// ---------------------------------------------------------------------------------------------------------------

const SERVICE_CASES: Record<string, Case[]> = {
  // templates.ts (+ re-exports of template-archive and template-views)
  getTemplateEditor: [{ name: "getTemplateEditor", run: (i) => views.getTemplateEditor(owner(), i.template) }],
  listTemplates: [], // asserted separately: lists none of A's templates
  saveTemplateDraft: [
    { name: "saveTemplateDraft", run: (i) => templatesService.saveTemplateDraft(owner(), i.template, saveInput()) },
    { name: "saveTemplateDraft on B's draft with A's file", run: (i) => templatesService.saveTemplateDraft(owner(), bDraft.templateId, saveInput({ fileId: i.file })) },
  ],
  startTemplateDraft: [{ name: "startTemplateDraft", run: (i) => templatesService.startTemplateDraft(owner(), i.template) }],
  discardTemplateDraft: [{ name: "discardTemplateDraft", run: (i) => templatesService.discardTemplateDraft(owner(), i.template) }],
  createOverlayTemplate: [
    { name: "createOverlayTemplate with A's file", run: (i) => templatesService.createOverlayTemplate(owner(), { name: "X", fileId: i.file, paperSize: "A4", labels: "en", definition: definition() }) },
  ],
  archiveTemplate: [{ name: "archiveTemplate", run: (i) => archive.archiveTemplate(owner(), i.template) }],
  unarchiveTemplate: [{ name: "unarchiveTemplate", run: (i) => archive.unarchiveTemplate(owner(), i.template) }],
  // template-publish.ts
  publishTemplate: [{ name: "publishTemplate", run: (i) => publish.publishTemplate(owner(), i.template, publishInput) }],
  rollbackTemplate: [
    { name: "rollbackTemplate", run: (i) => publish.rollbackTemplate(owner(), i.template, i.version) },
    { name: "rollbackTemplate on B's pad to A's version", run: (i) => publish.rollbackTemplate(owner(), b.templateId, i.version) },
  ],
  // template-assign.ts
  assignTemplate: [
    { name: "assignTemplate (clinic) with A's template", run: (i) => assign.assignTemplate(owner(), { scope: "clinic", templateId: i.template }) },
    { name: "assignTemplate (doctor) with A's template", run: (i) => assign.assignTemplate(owner(), { scope: "doctor", doctorId: bDoctorId, templateId: i.template }) },
    { name: "assignTemplate (doctor) A's doctor with B's template", run: (i) => assign.assignTemplate(owner(), { scope: "doctor", doctorId: i.doctor, templateId: b.templateId }) },
  ],
  // template-files.ts
  getTemplateFile: [{ name: "getTemplateFile", run: (i) => files.getTemplateFile(owner(), i.file) }],
  // template-preview.ts
  renderTemplatePreview: [
    { name: "renderTemplatePreview (sample) of A's template", run: (i) => preview.renderTemplatePreview(owner(), i.template, { source: { kind: "sample", sample: "short" }, format: "html" }) },
    { name: "renderTemplatePreview (sample) of A's template as pdf", run: (i) => preview.renderTemplatePreview(owner(), i.template, { source: { kind: "sample", sample: "short" }, format: "pdf" }) },
    { name: "renderTemplatePreview of B's template with A's version", run: (i) => preview.renderTemplatePreview(owner(), b.templateId, { source: { kind: "sample", sample: "short" }, versionId: i.version, format: "html" }) },
    { name: "renderTemplatePreview of B's template with A's prescription", run: (i) => preview.renderTemplatePreview(owner(), b.templateId, { source: { kind: "patient", prescriptionId: i.rx }, format: "html" }) },
  ],
  renderTemplateAlignment: [{ name: "renderTemplateAlignment", run: (i) => preview.renderTemplateAlignment(owner(), i.template) }],
  // rx-output.ts (templates are drawn into these)
  renderPrescriptionHtml: [
    { name: "renderPrescriptionHtml (preview)", run: (i) => rxOutput.renderPrescriptionHtml(owner(), i.rx, "preview") },
    { name: "renderPrescriptionHtml (print)", run: (i) => rxOutput.renderPrescriptionHtml(owner(), i.rx, "print") },
  ],
  renderPrescriptionPdf: [
    { name: "renderPrescriptionPdf (download)", run: (i) => rxOutput.renderPrescriptionPdf(owner(), i.rx, sharedFakeEngine, undefined, undefined, "download") },
    { name: "renderPrescriptionPdf (print)", run: (i) => rxOutput.renderPrescriptionPdf(owner(), i.rx, sharedFakeEngine, undefined, undefined, "print") },
  ],
  listPrescriptionOutputs: [{ name: "listPrescriptionOutputs", emptyOk: true, run: (i) => rxOutput.listPrescriptionOutputs(owner(), i.rx) }],
  // sharing.ts
  shareByWhatsApp: [{ name: "shareByWhatsApp", run: (i) => sharing.shareByWhatsApp(owner(), { prescriptionId: i.rx, phone: "9876543210" }, { appUrl: "https://app.example.test" }) }],
  shareByEmail: [
    { name: "shareByEmail", run: (i) => sharing.shareByEmail(owner(), { prescriptionId: i.rx, email: "someone@example.com" }, { email: createFakeEmailProvider(), appUrl: "https://app.example.test" }) },
  ],
  getSharePanel: [{ name: "getSharePanel", run: (i) => sharing.getSharePanel(owner(), i.rx, { email: null }) }],
};

/** Functions that take no id of another tenant's, or that are not entry points. Every entry says why; add none without a reason. */
const ALLOW_LIST: Record<string, string> = {
  // template-access.ts: internal helpers that take a transaction already scoped by withTenant, or no database at all.
  myDoctorId: "helper: reads the caller's own doctor row inside the caller's transaction",
  lockTemplate: "helper: filters on the caller's tenant id (exercised through every service case above)",
  mayWriteTemplate: "pure: decides from the caller context and an already loaded row",
  withFileFkMapped: "helper: maps an FK violation to a message, takes no id",
  // template-files.ts
  lockTemplateQuota: "helper: advisory lock keyed by the caller's tenant",
  auditUploadRefusal: "audits the caller's own refused upload; takes no id",
  uploadBackground: "takes bytes, not an id; asserted separately below (B gets its own copy of identical bytes)",
  loadTemplateFileIn: "internal (tenant-filtered, asserted separately below with A's file id and B's transaction)",
  fileAsImageAsset: "pure: converts an already loaded file",
  // template-preview.ts
  listPreviewPrescriptions: "lists the caller's own tenant; asserted separately below",
  // template-resolution.ts
  builtinLayout: "pure: reads the caller's clinic row",
  resolveTemplateIn: "internal (tenant-filtered, asserted separately below with a clinic row naming A's pad)",
  loadOverlayIn: "internal (tenant-filtered, asserted separately below with a layout naming A's version)",
  // template-assign.ts
  listTemplateDoctors: "lists the caller's own tenant; asserted separately below",
  // template-views.ts
  // (listTemplates is asserted separately below)
  // rx-output.ts: pure or byte-estimating functions over an already loaded bundle
  htmlSha256: "pure: hashes a string",
  renderDocument: "pure: renders an already loaded bundle",
  outputTemplateColumns: "pure",
  estimateOverlayPdfBytes: "pure",
  estimatedPdfBytes: "pure",
  overlayPdfTooLarge: "pure",
  // actions are covered as ACTION_CASES
};
const SEPARATE: readonly string[] = ["listTemplates"];

const ACTION_CASES: Record<string, Case[]> = {
  createTemplateAction: [
    { name: "createTemplateAction with A's file", run: (i) => actions.createTemplateAction({ name: "X", fileId: i.file, paperSize: "A4", labels: "en", definition: definition() }) },
  ],
  saveTemplateDraftAction: [{ name: "saveTemplateDraftAction", run: (i) => actions.saveTemplateDraftAction(i.template, saveInput()) }],
  startTemplateDraftAction: [{ name: "startTemplateDraftAction", run: (i) => actions.startTemplateDraftAction(i.template) }],
  discardTemplateDraftAction: [{ name: "discardTemplateDraftAction", run: (i) => actions.discardTemplateDraftAction(i.template) }],
  publishTemplateAction: [{ name: "publishTemplateAction", run: (i) => actions.publishTemplateAction(i.template, publishInput) }],
  rollbackTemplateAction: [{ name: "rollbackTemplateAction", run: (i) => actions.rollbackTemplateAction(i.template, i.version) }],
  archiveTemplateAction: [{ name: "archiveTemplateAction", run: (i) => actions.archiveTemplateAction(i.template) }],
  unarchiveTemplateAction: [{ name: "unarchiveTemplateAction", run: (i) => actions.unarchiveTemplateAction(i.template) }],
  assignTemplateAction: [
    { name: "assignTemplateAction (clinic)", run: (i) => actions.assignTemplateAction({ scope: "clinic", templateId: i.template }) },
    { name: "assignTemplateAction (doctor)", run: (i) => actions.assignTemplateAction({ scope: "doctor", doctorId: bDoctorId, templateId: i.template }) },
  ],
};

type Req = (i: Ids) => Promise<Response>;
const ctxOf = (id: string) => ({ params: Promise.resolve({ id, fileId: id }) });
const ROUTE_CASES: Record<string, Array<{ name: string; run: Req }>> = {
  "templates/files/[fileId]/route.ts": [{ name: "GET /templates/files/<A's file>", run: (i) => getFile(new Request("http://localhost/x"), ctxOf(i.file)) }],
  "templates/[id]/preview/route.ts": [
    { name: "GET /templates/<A's template>/preview?sample", run: (i) => getPreview(new Request(`http://localhost/templates/${i.template}/preview?sample=short`), ctxOf(i.template)) },
    { name: "GET /templates/<A's template>/preview?format=pdf", run: (i) => getPreview(new Request(`http://localhost/templates/${i.template}/preview?sample=short&format=pdf`), ctxOf(i.template)) },
    { name: "GET /templates/<B's template>/preview?version=<A's>", run: (i) => getPreview(new Request(`http://localhost/templates/${b.templateId}/preview?sample=short&version=${i.version}`), ctxOf(b.templateId)) },
    { name: "GET /templates/<B's template>/preview?prescriptionId=<A's>", run: (i) => getPreview(new Request(`http://localhost/templates/${b.templateId}/preview?prescriptionId=${i.rx}`), ctxOf(b.templateId)) },
  ],
  "templates/[id]/alignment/route.ts": [{ name: "GET /templates/<A's template>/alignment", run: (i) => getAlignment(new Request("http://localhost/x"), ctxOf(i.template)) }],
  "prescriptions/[id]/document/route.ts": [
    { name: "GET /prescriptions/<A's rx>/document", run: (i) => getDocument(new Request(`http://localhost/prescriptions/${i.rx}/document`), ctxOf(i.rx)) },
    { name: "GET /prescriptions/<A's rx>/document?purpose=print", run: (i) => getDocument(new Request(`http://localhost/prescriptions/${i.rx}/document?purpose=print`), ctxOf(i.rx)) },
  ],
  "prescriptions/[id]/pdf/route.ts": [
    { name: "GET /prescriptions/<A's rx>/pdf", run: (i) => getPdf(new Request(`http://localhost/prescriptions/${i.rx}/pdf`), ctxOf(i.rx)) },
    { name: "GET /prescriptions/<A's rx>/pdf?purpose=print", run: (i) => getPdf(new Request(`http://localhost/prescriptions/${i.rx}/pdf?purpose=print`), ctxOf(i.rx)) },
  ],
};
/** Route files that take no id of another tenant's, with the reason. */
const ROUTE_ALLOW_LIST: Record<string, string> = {
  "templates/uploads/route.ts": "POST of bytes, no id; the stored file is B's own (asserted separately below)",
  "pdf-frame/[...asset]/route.ts": "static, cookieless pdf.js assets; no tenant data",
  "s/[token]/route.ts": "public share link: the hashed token alone selects the row (withShareToken); covered by the sharing and share-route tests",
};

let bDraft: { templateId: string; versionId: string; fileId: string };
let bDoctorId = "";

// ---------------------------------------------------------------------------------------------------------------
// Setup and the side-effect fingerprint
// ---------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  A = await createTestTenant("tpl-x-a");
  B = await createTestTenant("tpl-x-b");
  a = await insertPublishedOverlay(A.tenantId, { label: "tenant-a-background" });
  b = await insertPublishedOverlay(B.tenantId, { label: "tenant-b-background" });
  const [aDoc] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, A.tenantId)).limit(1);
  aDoctorId = aDoc.id;
  const [bDoc] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, B.tenantId)).limit(1);
  bDoctorId = bDoc.id;
  // A prints on its overlay pad, so A's prescription is the overlay case; B has a draft of its own for the mixed cases.
  await adminDb.update(clinics).set({ customTemplateId: a.templateId }).where(eq(clinics.tenantId, A.tenantId));
  aRx = await finalized(A.as("doctor"), await newPatient(A.as("reception"), "Tenant A Patient"));
  // One logged print for A's prescription, so an output-log leak to B would be visible.
  const printed = await rxOutput.renderPrescriptionHtml(A.as("doctor"), aRx, "print");
  if (!printed.ok) throw new Error(printed.message);
  bRx = await finalized(B.as("doctor"), await newPatient(B.as("reception"), "Tenant B Patient"));
  const draft = await templatesService.createOverlayTemplate(B.as("owner"), {
    name: "B draft",
    fileId: await insertBackgroundFile(B.tenantId, "b-draft-file"),
    paperSize: "A4",
    labels: "en",
    definition: definition(),
  });
  if (!draft.ok) throw new Error(draft.message);
  const [v] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, draft.value.versionId));
  bDraft = { templateId: draft.value.templateId, versionId: v.id, fileId: v.fileId };
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});
beforeEach(() => {
  getSession.mockResolvedValue(owner());
  requireSessionMock.mockResolvedValue(owner());
});

/** Everything a template, output or share path could write, for both tenants, without file bytes. */
async function fingerprint(): Promise<string> {
  const tenants = [A.tenantId, B.tenantId];
  const out: unknown[] = [];
  out.push(await adminDb.select().from(templates).where(inArray(templates.tenantId, tenants)).orderBy(templates.id));
  out.push(await adminDb.select().from(templateVersions).where(inArray(templateVersions.tenantId, tenants)).orderBy(templateVersions.id));
  out.push(
    await adminDb
      .select({ id: templateFiles.id, tenantId: templateFiles.tenantId, sha256: templateFiles.sha256, byteSize: templateFiles.byteSize })
      .from(templateFiles)
      .where(inArray(templateFiles.tenantId, tenants))
      .orderBy(templateFiles.id),
  );
  out.push(await adminDb.select({ id: clinics.id, t: clinics.customTemplateId }).from(clinics).where(inArray(clinics.tenantId, tenants)).orderBy(clinics.id));
  out.push(await adminDb.select({ id: doctors.id, t: doctors.templateId }).from(doctors).where(inArray(doctors.tenantId, tenants)).orderBy(doctors.id));
  for (const table of [prescriptionOutputs, shareLinks, prescriptionShares, auditEvents] as const) {
    out.push(await adminDb.select({ tenantId: table.tenantId, n: count() }).from(table).where(inArray(table.tenantId, tenants)).groupBy(table.tenantId).orderBy(table.tenantId));
  }
  return JSON.stringify(out);
}

/** Runs one case with tenant A's ids and with ids that exist nowhere: same answer, and nothing written. */
async function answers(run: (i: Ids) => Promise<unknown>): Promise<{ foreign: unknown; missing: unknown }> {
  const before = await fingerprint();
  const f = await run(foreign());
  expect(await fingerprint(), "tenant A's ids changed something").toBe(before);
  const m = await run(missing());
  expect(await fingerprint(), "missing ids changed something").toBe(before);
  return { foreign: f, missing: m };
}

const UNIFORM_CODES = ["not_found", "forbidden"];

// ---------------------------------------------------------------------------------------------------------------
// The sweeps
// ---------------------------------------------------------------------------------------------------------------

describe("tenant B never reaches tenant A's templates (services)", () => {
  const cases = Object.values(SERVICE_CASES).flat();
  it.each(cases)("$name answers like a missing id and writes nothing", async ({ run, emptyOk }) => {
    const { foreign: f, missing: m } = await answers(run);
    if (emptyOk) {
      // A's prescription has logged outputs (see beforeAll): B must see none of them.
      expect(f).toMatchObject({ ok: true, value: { count: 0, lastAt: null } });
    } else {
      expect(f).toMatchObject({ ok: false });
      expect(UNIFORM_CODES).toContain((f as { code: string }).code);
    }
    expect(f).toEqual(m);
  });

  it("listTemplates lists none of A's templates, and never names A's pad", async () => {
    const listed = await views.listTemplates(owner());
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((t) => t.id)).not.toContain(a.templateId);
    expect(listed.value.map((t) => t.id)).toContain(b.templateId);
  });

  it("listPreviewPrescriptions and listTemplateDoctors show only the caller's clinic", async () => {
    const rxs = await preview.listPreviewPrescriptions(owner());
    expect(rxs.ok && rxs.value.map((r) => r.id)).not.toContain(aRx);
    const docs = await assign.listTemplateDoctors(owner());
    expect(docs.ok && docs.value.map((d) => d.id)).not.toContain(aDoctorId);
  });
});

describe("tenant B never reaches tenant A's templates (server actions)", () => {
  const cases = Object.values(ACTION_CASES).flat();
  it.each(cases)("$name answers like a missing id and writes nothing", async ({ run }) => {
    const { foreign: f, missing: m } = await answers(run);
    expect(f).toMatchObject({ error: expect.any(String) });
    expect((f as { ok?: true }).ok).toBeUndefined();
    expect(f).toEqual(m);
  });
});

describe("tenant B never reaches tenant A's templates (routes)", () => {
  const cases = Object.values(ROUTE_CASES).flat();
  it.each(cases)("$name answers 404 like a missing id and writes nothing", async ({ run }) => {
    const before = await fingerprint();
    const f = await run(foreign());
    const m = await run(missing());
    expect(f.status).toBe(404);
    expect(m.status).toBe(404);
    expect(await f.text()).toBe(await m.text());
    expect(await fingerprint()).toBe(before);
  });
});

describe("internal template readers refuse another tenant's rows", () => {
  it("loadTemplateFileIn, loadOverlayIn and resolveTemplateIn never return A's pad inside B's transaction", async () => {
    const { withTenant } = await import("@/server/db/tenant");
    await withTenant(B.tenantId, async (tx) => {
      expect(await files.loadTemplateFileIn(tx, B.tenantId, a.fileId)).toBeNull();
      expect(await files.loadTemplateFileIn(tx, A.tenantId, a.fileId)).toBeNull(); // RLS alone also hides it
      const layout = { template: { kind: "overlay" as const, templateVersionId: a.versionId, contentSha256: a.contentSha256 }, paperSize: "A4" as const, labels: "en" as const };
      expect(await resolution.loadOverlayIn(tx, B.tenantId, layout)).toBeNull();
      expect(await resolution.loadOverlayIn(tx, A.tenantId, layout)).toBeNull();
      const [clinicB] = await tx.select().from(clinics).where(eq(clinics.tenantId, B.tenantId));
      const resolved = await resolution.resolveTemplateIn(tx, B.tenantId, { ...clinicB, customTemplateId: a.templateId }, null);
      // A's pad id on B's clinic row is ignored: B falls back to a built-in pad.
      expect(resolved).toMatchObject({ ok: true, value: { template: { kind: "builtin" } } });
    });
  });

  it("the database refuses to point B's clinic or doctor at A's template", async () => {
    await expect(adminDb.update(clinics).set({ customTemplateId: a.templateId }).where(eq(clinics.tenantId, B.tenantId))).rejects.toThrow();
    await expect(adminDb.update(doctors).set({ templateId: a.templateId }).where(and(eq(doctors.tenantId, B.tenantId)))).rejects.toThrow();
  });
});

describe("tenant A's bytes never appear in tenant B's output", () => {
  it("stores B's own copy of identical bytes, and B's pads print B's background only", async () => {
    const [aFile] = await adminDb.select().from(templateFiles).where(eq(templateFiles.id, a.fileId));
    const uploaded = await files.uploadBackground(owner(), aFile.bytes);
    expect(uploaded.ok && uploaded.value.id !== a.fileId).toBe(true);
    if (uploaded.ok) {
      const [mine] = await adminDb.select({ tenantId: templateFiles.tenantId }).from(templateFiles).where(eq(templateFiles.id, uploaded.value.id));
      expect(mine.tenantId).toBe(B.tenantId);
    }
    await adminDb.update(clinics).set({ customTemplateId: b.templateId }).where(eq(clinics.tenantId, B.tenantId));
    try {
      const rx = await finalized(B.as("doctor"), await newPatient(B.as("reception"), "Tenant B Overlay Patient"));
      const printed = await rxOutput.renderPrescriptionHtml(B.as("doctor"), rx, "preview");
      expect(printed.ok).toBe(true);
      if (!printed.ok) return;
      expect(printed.value.html).toContain(backgroundPng("tenant-b-background").toString("base64"));
      expect(printed.value.html).not.toContain(backgroundPng("tenant-a-background").toString("base64"));
      // A's finalized prescription reprints A's own pad for A, never touched by what B did.
      const aPrinted = await rxOutput.renderPrescriptionHtml(A.as("doctor"), aRx, "preview");
      expect(aPrinted.ok && aPrinted.value.html.includes(backgroundPng("tenant-a-background").toString("base64"))).toBe(true);
    } finally {
      await adminDb.update(clinics).set({ customTemplateId: null }).where(eq(clinics.tenantId, B.tenantId));
    }
    expect(bRx).not.toBe("");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The guard: a new exported function or route with no case here fails the build
// ---------------------------------------------------------------------------------------------------------------

function functionNames(module: Record<string, unknown>): string[] {
  return Object.entries(module)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k);
}

describe("the table is complete", () => {
  const modules: Record<string, Record<string, unknown>> = {
    "server/actions/templates": actions,
    "services/template-access": access,
    "services/template-archive": archive,
    "services/template-assign": assign,
    "services/template-files": files,
    "services/template-preview": preview,
    "services/template-publish": publish,
    "services/template-resolution": resolution,
    "services/template-views": views,
    "services/templates": templatesService,
    "services/rx-output": rxOutput,
    "services/sharing": sharing,
  };

  it("every exported function is a case, a separate assertion, or an allow-listed non-id function", () => {
    const covered = new Set([...Object.keys(SERVICE_CASES), ...Object.keys(ACTION_CASES), ...SEPARATE, ...Object.keys(ALLOW_LIST)]);
    const uncovered: string[] = [];
    for (const [moduleName, module] of Object.entries(modules)) {
      for (const name of functionNames(module)) if (!covered.has(name)) uncovered.push(`${moduleName}.${name}`);
    }
    expect(uncovered, "add a cross-tenant case (or an allow-list entry with a reason) for each of these").toEqual([]);
  });

  it("no table entry names a function that no longer exists, and every entry has cases", () => {
    const all = new Set(Object.values(modules).flatMap(functionNames));
    const stale = [...Object.keys(SERVICE_CASES), ...Object.keys(ACTION_CASES), ...SEPARATE, ...Object.keys(ALLOW_LIST)].filter((n) => !all.has(n));
    expect(stale).toEqual([]);
    for (const [name, cases] of [...Object.entries(SERVICE_CASES), ...Object.entries(ACTION_CASES)]) {
      if (!SEPARATE.includes(name)) expect(cases.length, name).toBeGreaterThan(0);
    }
    for (const [name, reason] of Object.entries(ALLOW_LIST)) expect(reason.length, name).toBeGreaterThan(3);
  });

  it("every template, prescription output, upload and pdf-frame route is a case or allow-listed", () => {
    const root = join(process.cwd(), "src", "app");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name === "route.ts") found.push(path.slice(root.length + 1).replaceAll("\\", "/"));
      }
    };
    walk(root);
    const relevant = found
      .map((p) => p.replace(/^\(app\)\//, ""))
      .filter((p) => /^(templates|prescriptions|pdf-frame|s)\//.test(p));
    const known = new Set([...Object.keys(ROUTE_CASES), ...Object.keys(ROUTE_ALLOW_LIST)]);
    expect(relevant.filter((p) => !known.has(p)), "add a cross-tenant route case or an allow-list entry").toEqual([]);
    expect([...known].filter((p) => !relevant.includes(p)), "stale route entries").toEqual([]);
  });
});
