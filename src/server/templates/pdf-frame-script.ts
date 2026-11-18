import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import { PDF_INTAKE_LIMITS } from "@/lib/templates/pdf-intake";

/** Pixels pdf.js may decode for one embedded image (about 100 MP; the default is unlimited). A decompression-bomb guard. */
export const FRAME_MAX_IMAGE_PIXELS = 100_000_000;

/**
 * The frame's own script (ADR-0046): one message in ({ type: "render", bytes, page, dpi }), one message out (a JPEG page
 * or an error). It runs only inside <iframe sandbox="allow-scripts"> (opaque origin). pdf.js runs with eval and XFA
 * off and a fake in-frame worker (a blob module worker fails in Chromium under this sandbox, S2). PDF JavaScript never
 * runs: the bare getDocument API has no scripting option in pdfjs-dist 6 (that is a viewer option) and the quickjs
 * engine is never served (see the route test). The wasm
 * decoders (JBIG2, JPEG 2000, colour profiles) are required: without them scans render blank without an error, so
 * `useWasm: false` is forbidden. Spike S2 and its addendum: pdfjs-dist 6.5.438, where teardown lives on the loading task.
 *
 * Plain JavaScript in a string (the browser loads it as a module); keep it free of backticks and dollar-brace.
 */
export const FRAME_SCRIPT = `import * as pdfjs from "./pdf.mjs";
const MIN_SIDE = ${BACKGROUND_LIMITS.minLongSide};
const MAX_SIDE = ${BACKGROUND_LIMITS.maxLongSide};
const MAX_PAGES = ${PDF_INTAKE_LIMITS.maxPages};
const MAX_JPEG_BYTES = ${BACKGROUND_LIMITS.maxBytes};
const QUALITIES = [0.85, 0.75, 0.65, 0.5];
const base = new URL("./", import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.mjs", import.meta.url).href;

function nonWhitePercent(canvas) {
  const probe = document.createElement("canvas");
  probe.width = 100;
  probe.height = 140;
  const ctx = probe.getContext("2d");
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
  const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) ink += 1;
  return (ink / (probe.width * probe.height)) * 100;
}

async function toJpeg(canvas) {
  let best = null;
  for (const quality of QUALITIES) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) continue;
    if (!best || blob.size < best.size) best = blob;
    if (blob.size <= MAX_JPEG_BYTES) return blob;
  }
  return best;
}

async function render(bytes, pageNumber, dpi) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    enableXfa: false,
    maxImageSize: ${FRAME_MAX_IMAGE_PIXELS},
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    useSystemFonts: false,
    wasmUrl: base + "wasm/",
    standardFontDataUrl: base + "standard_fonts/",
    iccUrl: base + "iccs/",
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > MAX_PAGES) return { type: "error", code: "too_many_pages" };
    const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
    const base1 = page.getViewport({ scale: 1 });
    const longSide = Math.max(base1.width, base1.height);
    const scale = Math.min(MAX_SIDE / longSide, Math.max(dpi / 72, MIN_SIDE / longSide));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const blob = await toJpeg(canvas);
    if (!blob) return { type: "error", code: "unreadable" };
    return { type: "image", bytes: await blob.arrayBuffer(), width: canvas.width, height: canvas.height, pageCount: doc.numPages, pageSizePt: [base1.width, base1.height], nonWhitePercent: nonWhitePercent(canvas) };
  } finally {
    await task.destroy();
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== window.parent) return;
  const m = event.data;
  if (!m || m.type !== "render" || !(m.bytes instanceof ArrayBuffer)) return;
  let reply;
  try {
    reply = await render(m.bytes, Number(m.page) || 1, Math.min(Math.max(Number(m.dpi) || 200, 72), 300));
  } catch (error) {
    reply = { type: "error", code: error && error.name === "PasswordException" ? "encrypted" : "unreadable" };
  }
  window.parent.postMessage(reply, "*", reply.bytes ? [reply.bytes] : []);
});

window.parent.postMessage({ type: "ready" }, "*");
`;
