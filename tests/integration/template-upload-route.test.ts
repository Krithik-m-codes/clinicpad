// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/scanning", async () => {
  const { sharedFakeScanner } = await import("../helpers/fake-scanner");
  return { getMalwareScanner: () => sharedFakeScanner };
});

import { getSessionContext } from "@/server/auth/session";
import { templateUploadLimiter } from "@/server/http/upload-limits";
import { GET as uploadsGet, POST as upload } from "@/app/(app)/templates/uploads/route";
import { GET as getFile } from "@/app/(app)/templates/files/[fileId]/route";
import { resetFakeScanner, sharedFakeScanner } from "../helpers/fake-scanner";
import { backgroundPng } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
let A: TestTenant;
let B: TestTenant;

beforeAll(async () => {
  A = await createTestTenant("tpl-route-a");
  B = await createTestTenant("tpl-route-b");
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});
beforeEach(() => {
  resetFakeScanner(sharedFakeScanner);
  templateUploadLimiter.reset();
  session.mockResolvedValue(A.as("owner"));
});

const post = (body: BodyInit | Buffer | null, headers: Record<string, string> = {}) =>
  upload(new Request("http://localhost/templates/uploads", { method: "POST", body: Buffer.isBuffer(body) ? new Uint8Array(body) : body, headers: { "content-type": "application/octet-stream", ...headers }, duplex: "half" } as RequestInit));

describe("POST /templates/uploads", () => {
  it("stores a background and answers 201 with ids and sizes only", async () => {
    const response = await post(backgroundPng("route-1"));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ fileId: expect.any(String), width: 780, height: 1103, byteSize: expect.any(Number), reused: false });
  });

  it("answers 401 without a session, 403 from another site, 404 for a role that cannot write templates", async () => {
    session.mockResolvedValueOnce(null);
    expect((await post(backgroundPng("x"))).status).toBe(401);
    expect((await post(backgroundPng("x"), { "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.mockResolvedValueOnce(A.as("reception"));
    expect((await post(backgroundPng("x"))).status).toBe(404);
    expect(sharedFakeScanner.calls).toBe(0);
  });

  it("checks the session before reading any of the body (the middleware does not guard this route)", async () => {
    session.mockResolvedValueOnce(null);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    expect((await post(body)).status).toBe(401);
    expect(pulled).toBeLessThan(3);
  });

  it("answers 413 for a declared length over 1 MB without reading or scanning", async () => {
    const response = await post(new Uint8Array(10), { "content-length": String(1024 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect(sharedFakeScanner.calls).toBe(0);
  });

  it("answers 413 for a streamed body over 1 MB with no length, and stops reading the stream early", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 200) return controller.close();
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    expect((await post(body)).status).toBe(413);
    expect(pulled).toBeLessThan(40);
    expect(sharedFakeScanner.calls).toBe(0);
  });

  it("answers 413 for a body longer than a lying Content-Length", async () => {
    const response = await post(new Uint8Array(1024 * 1024 + 5), { "content-length": "100" });
    expect(response.status).toBe(413);
  });

  it("answers 422 for an empty body and for a file that is not a pad image", async () => {
    expect((await post(new Uint8Array(0))).status).toBe(422);
    // The first bytes of a Windows executable renamed to .png.
    const response = await post(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid", field: "file" });
  });

  it("ignores hostile file names and declared types, and never echoes them", async () => {
    const hostile = '../../etc/passwd"; <script>alert(1)</script>.png';
    const response = await post(backgroundPng("hostile-name"), {
      "content-disposition": `attachment; filename="${hostile}"`,
      "x-file-name": hostile,
      "content-type": "text/html",
    });
    expect(response.status).toBe(201);
    expect(JSON.stringify(await response.json())).not.toContain("script");
  });

  it("answers 503 with Retry-After when the scanner is down", async () => {
    sharedFakeScanner.next = { status: "unavailable", reason: "timeout" };
    const response = await post(backgroundPng("down"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("limits each user to 30 uploads an hour", async () => {
    const bytes = backgroundPng("rate");
    for (let i = 0; i < 30; i += 1) expect((await post(bytes)).status).toBe(201);
    const limited = await post(bytes);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
  });

  it("refuses GET", () => {
    expect(uploadsGet().status).toBe(405);
  });
});

describe("GET /templates/files/<id>", () => {
  it("serves the clinic's own image with a locked-down content policy, and 404 otherwise", async () => {
    const created = await (await post(backgroundPng("serve"))).json();
    const params = { params: Promise.resolve({ fileId: created.fileId as string }) };
    const response = await getFile(new Request("http://localhost/x"), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    session.mockResolvedValueOnce(B.as("owner"));
    expect((await getFile(new Request("http://localhost/x"), params)).status).toBe(404);
    session.mockResolvedValueOnce(A.as("pharmacist"));
    expect((await getFile(new Request("http://localhost/x"), params)).status).toBe(404);
  });

  it("answers the same 404 for a missing id, a malformed id and another clinic's id", async () => {
    const created = await (await post(backgroundPng("serve-2"))).json();
    const ask = async (id: string) => {
      const r = await getFile(new Request("http://localhost/x"), { params: Promise.resolve({ fileId: id }) });
      return [r.status, r.headers.get("content-type"), await r.text()];
    };
    session.mockResolvedValueOnce(B.as("owner"));
    const crossTenant = await ask(created.fileId as string);
    expect(crossTenant).toEqual(await ask("00000000-0000-4000-8000-000000000000"));
    expect(crossTenant).toEqual(await ask("not-a-uuid"));
    expect(crossTenant[0]).toBe(404);
  });
});
