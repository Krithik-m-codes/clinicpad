// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { contentDisposition, crossSiteRefusal, headNotAllowed, publicCode, publicMessage, statusForError } from "@/server/http/response";
import { createLimiter } from "@/server/pdf/limiter";

vi.mock("next-auth", () => ({ default: () => ({ auth: () => undefined }) }));
vi.mock("@/auth.config", () => ({ authConfig: {} }));

describe("contentDisposition", () => {
  it("quotes a plain name", () => {
    expect(contentDisposition("attachment", "Rx-12-v1.pdf")).toBe('attachment; filename="Rx-12-v1.pdf"');
    expect(contentDisposition("inline", "Rx-12-v1.html")).toBe('inline; filename="Rx-12-v1.html"');
  });

  it("strips CR, LF, quotes, backslashes, separators and semicolons (no header or parameter injection)", () => {
    const value = contentDisposition("attachment", 'a"b\r\nSet-Cookie: x=1;\\../c.pdf');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toBe('attachment; filename="abSet-Cookie: x=1..c.pdf"');
    expect(value.match(/"/g)).toHaveLength(2);
  });

  it("adds an RFC 5987 name for non-ASCII text and an ASCII fallback", () => {
    const value = contentDisposition("attachment", "आशा.pdf");
    expect(value).toBe("attachment; filename=\"___.pdf\"; filename*=UTF-8''%E0%A4%86%E0%A4%B6%E0%A4%BE.pdf");
    expect(contentDisposition("attachment", "it's (1) é.pdf")).toContain("filename*=UTF-8''it%27s%20%281%29%20%C3%A9.pdf");
    expect(contentDisposition("attachment", "100%.pdf")).toBe('attachment; filename="100_.pdf"; filename*=UTF-8\'\'100%25.pdf');
  });

  it("drops lone surrogates and Unicode format characters, and never throws", () => {
    // U+D800 lone high, U+DC00 lone low, U+202E right-to-left override, U+200B zero-width space, U+FEFF BOM
    const hostile = ["a", "\ud800", "b", "\udc00", "\u202e", "\u200b", "\ufeff", "c.pdf"].join("");
    expect(hostile.length).toBe(12);
    expect(() => contentDisposition("attachment", hostile)).not.toThrow();
    expect(contentDisposition("attachment", hostile)).toBe('attachment; filename="abc.pdf"');
    expect(contentDisposition("attachment", "\u202e\ud800")).toBe('attachment; filename="document"');
    // a valid surrogate pair (an emoji) is kept, as UTF-8 percent-encoding
    expect(contentDisposition("attachment", "\ud83d\ude00.pdf")).toContain("filename*=UTF-8''%F0%9F%98%80.pdf");
  });

  it("falls back to a fixed name for an empty one", () => {
    expect(contentDisposition("attachment", '\r\n"')).toBe('attachment; filename="document"');
  });
});

describe("error mapping", () => {
  it("maps codes to statuses and makes forbidden look like not found", () => {
    expect(statusForError("forbidden")).toBe(404);
    expect(statusForError("not_found")).toBe(404);
    expect(statusForError("conflict")).toBe(409);
    expect(statusForError("invalid")).toBe(422);
    expect(statusForError("unavailable")).toBe(503);
    expect(statusForError("timeout")).toBe(504);
    expect(publicCode("forbidden")).toBe("not_found");
    expect(publicMessage("forbidden", "You cannot view prescriptions.")).toBe("Prescription not found.");
    expect(publicMessage("conflict", "x")).toBe("x");
    expect(publicMessage("not_found", "Row 7 of table x is missing")).toBe("Prescription not found.");
  });
});

describe("crossSiteRefusal and headNotAllowed", () => {
  const req = (site?: string) => new Request("http://localhost/x", { headers: site ? { "sec-fetch-site": site } : {} });

  it("allows same-origin, direct navigation, and a missing header; refuses everything else with 403", async () => {
    expect(crossSiteRefusal(req())).toBeNull();
    expect(crossSiteRefusal(req("same-origin"))).toBeNull();
    expect(crossSiteRefusal(req("none"))).toBeNull();
    for (const site of ["cross-site", "same-site", "bogus"]) {
      const res = crossSiteRefusal(req(site));
      expect(res?.status).toBe(403);
      expect(await res?.json()).toEqual({ error: "forbidden", message: "This action must be started from ClinicPad." });
    }
  });

  it("answers HEAD with 405 and an Allow header", () => {
    const res = headNotAllowed();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("createLimiter", () => {
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }

  it("runs at most `concurrency` at once, queues up to `maxQueue`, and fails fast beyond that", async () => {
    const limiter = createLimiter({ concurrency: 2, maxQueue: 3 });
    const g = gate();
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await g.promise;
      running -= 1;
      return "done";
    };
    const results = Array.from({ length: 6 }, () => limiter.run(task));
    // 2 running + 3 queued + 1 over the cap
    const overflow = await results[5];
    expect(overflow).toEqual({ busy: true });
    expect(running).toBe(2);
    g.open();
    const rest = await Promise.all(results.slice(0, 5));
    expect(rest.every((r) => !r.busy && r.value === "done")).toBe(true);
    expect(peak).toBe(2);
  });

  it("frees the slot when a task throws, and rethrows to the caller", async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 0 });
    await expect(limiter.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await limiter.run(async () => 1)).toEqual({ busy: false, value: 1 });
  });

  it("accepts new work again after the queue drains", async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
    const g = gate();
    const first = limiter.run(() => g.promise);
    const second = limiter.run(async () => 2);
    expect(await limiter.run(async () => 3)).toEqual({ busy: true });
    g.open();
    await Promise.all([first, second]);
    expect(await limiter.run(async () => 4)).toEqual({ busy: false, value: 4 });
  });

  it("drops a queued task whose request was aborted: it never runs and frees its place in the queue", async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
    const g = gate();
    const first = limiter.run(() => g.promise);
    const controller = new AbortController();
    let ran = false;
    const queued = limiter.run(
      async () => {
        ran = true;
      },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await queued).toEqual({ busy: false, aborted: true });
    // The aborted task no longer holds the only queue place.
    const next = limiter.run(async () => "next");
    g.open();
    await first;
    expect(await next).toEqual({ busy: false, value: "next" });
    expect(ran).toBe(false);
  });

  it("answers aborted at once for an already aborted signal, without taking a slot", async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 0 });
    const controller = new AbortController();
    controller.abort();
    expect(await limiter.run(async () => 1, { signal: controller.signal })).toEqual({ busy: false, aborted: true });
    expect(await limiter.run(async () => 2)).toEqual({ busy: false, value: 2 });
  });

  it("hands the signal to a running task's owner and lets a second instance have its own limits", async () => {
    const strict = createLimiter({ concurrency: 1, maxQueue: 0 });
    const g = gate();
    const first = strict.run(() => g.promise);
    expect(await strict.run(async () => 1)).toEqual({ busy: true });
    expect(await createLimiter({ concurrency: 2, maxQueue: 0 }).run(async () => 1)).toEqual({ busy: false, value: 1 });
    g.open();
    await first;
  });
});

describe("middleware matcher", () => {
  it("guards the app pages including prescriptions, and leaves login and the API alone", async () => {
    const { config } = await import("@/middleware");
    expect(config.matcher).toEqual(["/dashboard/:path*", "/patients/:path*", "/prescriptions/:path*", "/settings/:path*"]);
    const patterns = config.matcher.map((m) => new RegExp(`^${m.replace("/:path*", "(?:/.*)?")}$`));
    const guarded = (path: string) => patterns.some((p) => p.test(path));
    expect(guarded("/prescriptions/abc/pdf")).toBe(true);
    expect(guarded("/patients/1")).toBe(true);
    expect(guarded("/login")).toBe(false);
    expect(guarded("/api/health/pdf")).toBe(false);
    expect(guarded("/api/auth/session")).toBe(false);
    expect(guarded("/api/catalogue/search")).toBe(false);
  });
});
