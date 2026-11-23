// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { getSessionContext } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { auditEvents } from "@/server/db/schema";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { newId } from "@/lib/domain/ids";
import { GET, HEAD } from "@/app/(app)/templates/[id]/alignment/route";
import { insertPublishedOverlay, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
let A: TestTenant;
let B: TestTenant;
let templateId = "";
let offsetTemplateId = "";

const align = (id: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/templates/${id}/alignment`, { headers }), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  A = await createTestTenant("tpl-align-a");
  B = await createTestTenant("tpl-align-b");
  templateId = (await insertPublishedOverlay(A.tenantId)).templateId;
  offsetTemplateId = (await insertPublishedOverlay(A.tenantId, { definition: { ...MINIMAL_OVERLAY_DEFINITION, background: { printMode: "pdf_only" }, printOffsetMm: { x: 2, y: -1.5 } } })).templateId;
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});
beforeEach(() => session.mockResolvedValue(A.as("owner")));

describe("GET /templates/<id>/alignment", () => {
  it("serves a self-contained alignment page with no image and the printer offset applied, and logs nothing", async () => {
    const response = await align(offsetTemplateId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const html = await response.text();
    expect(checkSelfContained(html)).toEqual({ ok: true });
    expect(html).not.toContain("<img");
    expect(html).toContain("Prescription body");
    expect(html).toMatch(/\.box-0\{left:[\d.]+mm;top:[\d.]+mm;/);
    const events = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.entityType, "template")));
    expect(events.filter((e) => e.action.includes("align"))).toHaveLength(0);
  });

  it("is allowed for a designer (template.read) and refused for another clinic, a bad id, a cross-site request and no session", async () => {
    session.mockResolvedValue({ tenantId: A.tenantId, userId: newId(), role: "designer" });
    expect((await align(templateId)).status).toBe(200);
    session.mockResolvedValue(B.as("owner"));
    expect((await align(templateId)).status).toBe(404);
    session.mockResolvedValue(A.as("owner"));
    expect((await align("not-a-uuid")).status).toBe(404);
    expect((await align(templateId, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.mockResolvedValue(null);
    expect((await align(templateId)).status).toBe(303);
    expect(HEAD().status).toBe(405);
  });
});
