import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, templateFiles } from "@/server/db/schema";
import { getTemplateFile, loadTemplateFileIn, TEMPLATE_UPLOAD_MESSAGES, uploadBackground } from "@/server/services/template-files";
import { SCAN_MESSAGES } from "@/server/scanning/scanner";
import { createFakeScanner, resetFakeScanner } from "../helpers/fake-scanner";
import { JPEG_EXIF_GPS, jpegWithSegments, makeJpegCustom, makePng } from "../helpers/images";
import { backgroundPng, insertBackgroundFile, insertTemplate } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
const scanner = createFakeScanner();
const owner = () => A.as("owner");

beforeAll(async () => {
  A = await createTestTenant("tpl-files-a");
  B = await createTestTenant("tpl-files-b");
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});
beforeEach(() => resetFakeScanner(scanner));

const filesOf = (tenantId: string) => adminDb.select().from(templateFiles).where(eq(templateFiles.tenantId, tenantId));
const events = (action: string) =>
  adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, action)));

describe("uploadBackground", () => {
  it("stores a scanned PNG with its hash and scan engine, and audits ids and numbers only", async () => {
    const bytes = backgroundPng("upload-1");
    const result = await uploadBackground(owner(), bytes, { scanner });
    expect(result).toMatchObject({ ok: true, value: { mime: "image/png", width: 780, height: 1103, reused: false } });
    if (!result.ok) return;
    const [row] = await adminDb.select().from(templateFiles).where(eq(templateFiles.id, result.value.id));
    expect(row).toMatchObject({ kind: "background_image", scanEngine: "fake-scanner 1.0", sha256: createHash("sha256").update(row.bytes).digest("hex") });
    const [event] = await events("template_file.uploaded");
    expect(event.after).toEqual({
      fileId: result.value.id,
      kind: "background_image",
      byteSize: row.byteSize,
      sha256: row.sha256,
      scanEngine: "fake-scanner 1.0",
      width: 780,
      height: 1103,
    });
  });

  it("strips metadata before hashing and storing", async () => {
    const jpeg = jpegWithSegments(makeJpegCustom(1240, 1754), [JPEG_EXIF_GPS]);
    const result = await uploadBackground(owner(), jpeg, { scanner });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await adminDb.select().from(templateFiles).where(eq(templateFiles.id, result.value.id));
    expect(row.bytes.toString("latin1")).not.toContain("GPSLatitude");
    expect(row.sha256).toBe(createHash("sha256").update(row.bytes).digest("hex"));
    expect(row.byteSize).toBe(row.bytes.length);
    expect(row.bytes.length).toBeLessThan(jpeg.length);
  });

  it("reuses the stored row for identical bytes, and for the same image with different metadata", async () => {
    const bytes = backgroundPng("upload-dup");
    const first = await uploadBackground(owner(), bytes, { scanner });
    const second = await uploadBackground(owner(), bytes, { scanner });
    expect(first.ok && second.ok && second.value.id === first.value.id && second.value.reused).toBe(true);
    const plain = makeJpegCustom(1240, 1755);
    const tagged = jpegWithSegments(plain, [JPEG_EXIF_GPS]);
    const a = await uploadBackground(owner(), plain, { scanner });
    const b = await uploadBackground(owner(), tagged, { scanner });
    expect(a.ok && b.ok && b.value.id === a.value.id).toBe(true);
  });

  it("does not dedupe across clinics", async () => {
    const bytes = backgroundPng("cross-tenant");
    const a = await uploadBackground(owner(), bytes, { scanner });
    const b = await uploadBackground(B.as("owner"), bytes, { scanner });
    expect(a.ok && b.ok && a.value.id !== b.value.id && !b.value.reused).toBe(true);
  });

  it("refuses roles without template.write before scanning", async () => {
    expect(await uploadBackground(A.as("reception"), backgroundPng("r"), { scanner })).toMatchObject({ ok: false, code: "forbidden" });
    expect(scanner.calls).toBe(0);
  });

  it("refuses non-images, oversized bodies and wrong proportions without scanning, and audits the refusal", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await uploadBackground(owner(), svg, { scanner })).toMatchObject({ ok: false, code: "invalid", field: "file" });
    expect(await uploadBackground(owner(), makePng(1200, 1200), { scanner })).toMatchObject({ ok: false, code: "invalid", field: "file" });
    expect(await uploadBackground(owner(), new Uint8Array(1024 * 1024 + 1), { scanner })).toMatchObject({ ok: false, code: "invalid", field: "file" });
    expect(scanner.calls).toBe(0);
    expect((await events("template_file.rejected")).map((e) => (e.after as { reasonCode: string }).reasonCode)).toContain("invalid_image");
  });

  it("refuses an infected file and a scanner that is down, storing nothing", async () => {
    const before = (await filesOf(A.tenantId)).length;
    scanner.next = { status: "infected", engine: "fake-scanner 1.0", signature: "Win.Test.EICAR_HDB-1" };
    expect(await uploadBackground(owner(), backgroundPng("infected"), { scanner })).toEqual({
      ok: false,
      code: "invalid",
      message: SCAN_MESSAGES.infected,
      field: "file",
    });
    scanner.next = { status: "unavailable", reason: "timeout" };
    expect(await uploadBackground(owner(), backgroundPng("down"), { scanner })).toMatchObject({ ok: false, code: "unavailable" });
    expect((await filesOf(A.tenantId)).length).toBe(before);
  });

  it("keeps the byte quota exact under concurrent uploads (one wins)", async () => {
    const C = await createTestTenant("tpl-files-quota");
    try {
      const one = backgroundPng("quota-1");
      const two = backgroundPng("quota-2");
      const quotaBytes = one.length + two.length - 1;
      const results = await Promise.all([
        uploadBackground(C.as("owner"), one, { scanner, quotaBytes }),
        uploadBackground(C.as("owner"), two, { scanner, quotaBytes }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: "invalid", message: TEMPLATE_UPLOAD_MESSAGES.quota });
      expect(await filesOf(C.tenantId)).toHaveLength(1);
    } finally {
      await C.cleanup();
    }
  });

  it("removes unused files older than 30 days at the next upload, and keeps used or younger ones", async () => {
    const day = 86_400_000;
    const oldUnused = await insertBackgroundFile(A.tenantId, "gc-old-unused", { createdAt: new Date(Date.now() - 31 * day) });
    const oldUsed = await insertBackgroundFile(A.tenantId, "gc-old-used", { createdAt: new Date(Date.now() - 31 * day) });
    await insertTemplate(A.tenantId, { fileId: oldUsed });
    const recent = await insertBackgroundFile(A.tenantId, "gc-recent", { createdAt: new Date(Date.now() - 10 * day) });
    expect((await uploadBackground(owner(), backgroundPng("gc-trigger"), { scanner })).ok).toBe(true);
    const ids = (await filesOf(A.tenantId)).map((f) => f.id);
    expect(ids).not.toContain(oldUnused);
    expect(ids).toEqual(expect.arrayContaining([oldUsed, recent]));
  });

  it("never collects another clinic's old unused files", async () => {
    const day = 86_400_000;
    const others = await insertBackgroundFile(B.tenantId, "gc-other-tenant", { createdAt: new Date(Date.now() - 40 * day) });
    expect((await uploadBackground(owner(), backgroundPng("gc-trigger-2"), { scanner })).ok).toBe(true);
    expect((await filesOf(B.tenantId)).map((f) => f.id)).toContain(others);
  });
});

describe("reading files back", () => {
  it("re-hashes the bytes and never crosses tenants", async () => {
    const id = await insertBackgroundFile(A.tenantId, "read-back");
    const loaded = await withTenant(A.tenantId, (tx) => loadTemplateFileIn(tx, A.tenantId, id));
    expect(loaded).toMatchObject({ id, mime: "image/png", width: 780, height: 1103 });
    expect(await withTenant(B.tenantId, (tx) => loadTemplateFileIn(tx, B.tenantId, id))).toBeNull();
    expect(await getTemplateFile(B.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getTemplateFile(A.as("reception"), id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getTemplateFile(A.as("owner"), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
  });
});
