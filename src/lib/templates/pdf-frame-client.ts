import { z } from "zod";
import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import { PDF_INTAKE_LIMITS } from "./pdf-intake";

export type RasterFailure = "too_large" | "too_many_pages" | "encrypted" | "unreadable" | "timeout";

export type RasterResult =
  | { ok: true; image: Blob; width: number; height: number; pageCount: number; pageSizePt: [number, number]; nonWhitePercent: number }
  | { ok: false; code: RasterFailure };

/**
 * The frame is invisible but must stay "on screen" in the browser's eyes: a cross-origin frame that is scrolled out of
 * view gets its animation frames throttled in Chromium and WebKit, and pdf.js then never finishes rendering. Fixed in a
 * corner at 0 x 0 renders in all three engines (the e2e fixture spec uses these same styles).
 */
export const FRAME_STYLE = { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" } as const;

/** The largest JPEG page the parent will take from the frame (the frame aims under 1 MB; the parent recompresses anyway). */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

const replySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z
    .object({
      type: z.literal("image"),
      bytes: z.instanceof(ArrayBuffer).refine((b) => b.byteLength > 3 && b.byteLength <= MAX_REPLY_BYTES),
      width: z.number().int().min(1).max(BACKGROUND_LIMITS.maxLongSide),
      height: z.number().int().min(1).max(BACKGROUND_LIMITS.maxLongSide),
      pageCount: z.number().int().min(1).max(PDF_INTAKE_LIMITS.maxPages),
      pageSizePt: z.tuple([z.number().positive().max(14400), z.number().positive().max(14400)]),
      nonWhitePercent: z.number().min(0).max(100),
    })
    .strict(),
  z.object({ type: z.literal("error"), code: z.enum(["too_many_pages", "encrypted", "unreadable"]) }).strict(),
]);

export type FrameReply = z.infer<typeof replySchema>;

/** A reply is untrusted bytes from an opaque-origin frame: exact shape, sane numbers, and a real JPEG signature. */
export function parseFrameReply(data: unknown): FrameReply | null {
  const parsed = replySchema.safeParse(data);
  if (!parsed.success) return null;
  const reply = parsed.data;
  if (reply.type === "image") {
    const head = new Uint8Array(reply.bytes, 0, 3);
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return null;
  }
  return reply;
}

/**
 * Renders one page of a PDF to a JPEG inside a fresh sandboxed frame (opaque origin) and removes the frame. Only
 * messages from that frame's window, from the opaque origin "null", and of the exact shapes above are accepted; the
 * frame is `sandbox="allow-scripts"` without allow-same-origin, so it has no cookies, storage or access to this page.
 * Browser only.
 */
export function rasterizePdfPage(pdf: ArrayBuffer, opts: { page: number; dpi: number; timeoutMs?: number; readyTimeoutMs?: number }): Promise<RasterResult> {
  if (pdf.byteLength === 0 || pdf.byteLength > PDF_INTAKE_LIMITS.maxBytes) return Promise.resolve({ ok: false, code: "too_large" });
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.tabIndex = -1;
    frame.title = "PDF reader";
    Object.assign(frame.style, FRAME_STYLE);
    let settled = false;
    let renderSent = false;
    const finish = (result: RasterResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(readyTimer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), opts.timeoutMs ?? PDF_INTAKE_LIMITS.timeoutMs);
    // A frame that never says "ready" (blocked by a proxy, a broken build) fails fast instead of after the full render timeout.
    const readyTimer = setTimeout(() => finish({ ok: false, code: "timeout" }), opts.readyTimeoutMs ?? PDF_INTAKE_LIMITS.readyTimeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== "null") return;
      const message = parseFrameReply(event.data);
      if (!message) return finish({ ok: false, code: "unreadable" });
      if (message.type === "ready") {
        if (renderSent) return; // the frame says it once; a repeat is ignored (the PDF is posted once)
        renderSent = true;
        clearTimeout(readyTimer);
        const copy = pdf.slice(0);
        frame.contentWindow?.postMessage({ type: "render", bytes: copy, page: opts.page, dpi: opts.dpi }, "*", [copy]);
        return;
      }
      if (!renderSent) return finish({ ok: false, code: "unreadable" }); // an answer to a request that was never sent
      if (message.type === "error") return finish({ ok: false, code: message.code });
      finish({
        ok: true,
        image: new Blob([message.bytes], { type: "image/jpeg" }),
        width: message.width,
        height: message.height,
        pageCount: message.pageCount,
        pageSizePt: message.pageSizePt,
        nonWhitePercent: message.nonWhitePercent,
      });
    };
    window.addEventListener("message", onMessage);
    frame.src = "/pdf-frame/frame.html";
    document.body.appendChild(frame);
  });
}
