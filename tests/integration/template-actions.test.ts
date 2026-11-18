// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ requireSession: vi.fn(), getSessionContext: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requireSession } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { templates } from "@/server/db/schema";
import {
  assignTemplateAction,
  createTemplateAction,
  publishTemplateAction,
  rollbackTemplateAction,
  saveTemplateDraftAction,
} from "@/server/actions/templates";
import { insertBackgroundFile, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(requireSession);
let A: TestTenant;
let file = "";
const input = () => ({ name: "Action pad", fileId: file, paperSize: "A4", labels: "en", definition: structuredClone(MINIMAL_OVERLAY_DEFINITION) });

beforeAll(async () => {
  A = await createTestTenant("tpl-act");
  file = await insertBackgroundFile(A.tenantId, "act-file");
});
afterAll(async () => {
  await A.cleanup();
});
beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(A.as("owner"));
});

describe("template actions", () => {
  it("takes the identity from the session and returns typed states, never throwing", async () => {
    const created = await createTemplateAction(input());
    expect(created).toMatchObject({ ok: true });
    const templateId = created.templateId as string;
    expect(await saveTemplateDraftAction(templateId, { definition: input().definition, labels: "en", baseRevision: 5 })).toMatchObject({ error: expect.any(String), currentRevision: 0 });
    const refused = await publishTemplateAction(templateId, { identity: "bound", boundDoctorId: null, confirmLetterhead: false, baseRevision: 0 });
    expect(refused.error).toBeTruthy();
    expect(refused.issues?.length).toBeGreaterThan(0);
    expect(await publishTemplateAction(templateId, { identity: "dynamic", boundDoctorId: null, confirmLetterhead: false, baseRevision: 0 })).toEqual({ ok: true });
    expect(await rollbackTemplateAction(templateId, "not-a-uuid")).toMatchObject({ error: expect.any(String) });
    expect(await assignTemplateAction({ scope: "clinic", templateId })).toEqual({ ok: true });
  });

  it("answers a role without the permission with an error state, and a tenant id in the input changes nothing", async () => {
    session.mockResolvedValue(A.as("reception"));
    expect(await createTemplateAction(input())).toMatchObject({ error: expect.any(String) });
    session.mockResolvedValue(A.as("owner"));
    const forged = await createTemplateAction({ ...input(), tenantId: "11111111-1111-4111-8111-111111111111" } as ReturnType<typeof input>);
    expect(forged.ok).toBe(true);
    const [row] = await adminDb.select().from(templates).where(eq(templates.id, forged.templateId as string));
    expect(row.tenantId).toBe(A.tenantId);
  });

  it("turns an unexpected failure into a generic error state", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    session.mockResolvedValue({ tenantId: "not-a-uuid", userId: "x", role: "owner" });
    const result = await createTemplateAction(input());
    expect(result).toEqual({ error: "Something went wrong. Please try again." });
    expect(spy).toHaveBeenCalledWith("createTemplateAction failed", expect.any(String));
    spy.mockRestore();
  });
});
