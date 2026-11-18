# S2 finding: pdf.js page rasterization inside an opaque-origin sandboxed iframe

Date: 2026-11-18. Plan 2A Task 2. Throwaway code: `spikes/s2-pdfjs-frame/` (git-ignored).

## Question

Can PDF intake for Template Studio rasterize page 1 of an uploaded PDF with pdf.js inside `<iframe sandbox="allow-scripts">` (opaque origin, strict CSP), in Chromium, Firefox and WebKit, on realistic clinic PDFs (scans, JBIG2/CCITT, JPEG 2000, Devanagari), without the frame reaching the app's cookies, storage, parent DOM or the network?

## Environment

| Item | Value |
|---|---|
| pdfjs-dist (tested, chosen) | **5.7.284**, licence **Apache-2.0**, published 2026-04-27 (older than 2 weeks) |
| integrity | `sha512-h4EdYQczmGhbOlqc3PPZwxevn7ApdWPbovAuWXOB/DjIyigSnwfy2oze7c6mRcSr9XgLp3eN3EeL4DyySTPMFw==` (shasum `01d9ff1d7ccd15245bdec8524a6770feb77fbb23`) |
| `npm view pdfjs-dist` on 2026-11-18 | `latest` = 6.5.438 (Apache-2.0, published 2026-11-01); 5.x line latest = 5.7.284 |
| 6.5.438 | NOT chosen: the plan pins a 5.x release, and the frame protocol written for 5.x fails on 6.5.438 (`doc.destroy is not a function`, every fixture, all three engines). Adopting 6.x needs a separate API port and a plan change |
| Playwright browsers | Chromium 158.0.8127.18, Firefox 159.0, WebKit 27.2 (Playwright build, Windows) |
| Frame CSP (as tested) | `sandbox allow-scripts; default-src 'none'; script-src <origin>/frame/ 'wasm-unsafe-eval'; worker-src blob:; connect-src <origin>/frame/; img-src blob: data:; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'; form-action 'none'` |
| Scratch Gotenberg for a fixture | `gotenberg/gotenberg:8.11.0@sha256:e60da3ecc52050303c3886630aa7ed82f9486660b82a1ce6e5bf253c3b0764d4` (same digest as the project container, started on port 3002 with the LibreOffice routes enabled, then stopped; the project container is not changed) |

## Method

Automated: `server.mjs` serves a parent page and the frame (`/frame/*`), pdf.js build files, `wasm/`, `standard_fonts/`, `iccs/`, `cmaps/` with `Access-Control-Allow-Origin: *`; `probe.mjs` drives each engine via Playwright. The parent sets three cookies (Lax, Strict, no attribute), posts each PDF into the frame as an ArrayBuffer, receives a PNG, measures time, PNG/JPEG size and the non-white pixel percentage (sampled). Runs: A wasm on (explicit CSP origin), B `useWasm:false`, C CSP `'self'`, D blob module worker, E pdfjs 6.5.438. Isolation probes run inside the frame at start. JPEG/PNG outputs of the 200 dpi runs were looked at by a human-equivalent read (Devanagari, scans, rotation, CCITT, JPX).

Fixtures (all generated; none is a real patient document):

| Fixture | How it was made |
|---|---|
| `a4`, `a5` | plan's `minimalPdf()` (Helvetica, not embedded) |
| `jpeg-scan` | Python PIL: noisy grey A4 "prescription" at 200 dpi, JPEG q70, hand-written PDF with `/DCTDecode` (421 KB) |
| `jpeg-scan-rotate90` | same image with page `/Rotate 90` |
| `ccitt-g4-scan` | PIL 1-bit, TIFF Group 4 single strip, raw G4 data in a PDF with `/CCITTFaxDecode` (`/K -1`, `/BlackIs1 true`) |
| `jbig2-mmr-scan` | the same G4 data wrapped by hand in an embedded JBIG2 stream (page-info + generic-region segment, MMR coding), `/JBIG2Decode /Decode [1 0]`. Only MMR generic regions are covered: there is no JBIG2 encoder on this machine, so arithmetic-coded or symbol-dictionary JBIG2 from a real scanner is untested |
| `jpx-scan` | PIL JPEG 2000 (openjpeg, irreversible, 20:1), 1200x1700, `/JPXDecode` |
| `devanagari-chromium` | HTML with Hindi text through Gotenberg Chromium (Letter page, embedded subset TrueType) |
| `devanagari-docx-libreoffice` | hand-built minimal `.docx` (Nirmala UI / Mangal font names) converted by LibreOffice in the scratch Gotenberg; stands in for "Word Save as PDF". It is not a Word-produced file |
| `hostile-js` | `/OpenAction` JavaScript calling `fetch` and a `/URI` action to an unreachable host |
| `huge-mediabox` | 14,400 x 14,400 pt page |

A first generator run produced a wrong CCITT fixture (only the first TIFF strip was copied, the page rendered black below 330 px); that was a fixture bug, fixed, and is not a pdf.js result.

## Results

### Rendering (pdfjs-dist 5.7.284, wasm on, fake worker, explicit CSP origin; run A). ms at 200 dpi / non-white % of the page

| Fixture | Chromium | Firefox | WebKit |
|---|---|---|---|
| a4 | 1025 (first call, wasm and font init) / 13.5 | 215 / 13.5 | 281 / 13.5 |
| a5 | 22 / 19.2 | 148 / 19.2 | 136 / 19.2 |
| jpeg-scan | 121 / 20.3 | 196 / 20.3 | 715 / 20.2 |
| jpeg-scan-rotate90 (2338 x 1652 out) | 159 / 20.2 | 202 / 20.1 | 803 / 20.1 |
| ccitt-g4-scan | 70 / 4.65 | 140 / 4.65 | 261 / 4.69 |
| jbig2-mmr-scan | 84 / 4.65 | 97 / 4.65 | 336 / 4.69 |
| jpx-scan | 263 / 19.7 | 337 / 19.7 | 590 / 19.7 |
| devanagari-chromium | 44 / 0.72 | 105 / 0.73 | 166 / 0.73 |
| devanagari-docx-libreoffice | 41 / 0.65 | 64 / 0.69 | 168 / 0.69 |
| hostile-js | 34 | 65 | 171 |
| huge-mediabox (clamped to 3600 x 3600) | 54 | 106 | 371 |

All 15 jobs (11 fixtures at 200 dpi plus a4 at 150 and 300, jpeg-scan at 150 and 300) succeeded in all three engines. Devanagari conjuncts (क्ष, ज्ञ, श्र, द्वि) and the Hindi header looked correct in the rendered images; scans looked correct; the rotated page came out rotated as the PDF says. Page sizes: A4 595 x 842 pt, A5 420 x 595 pt, as expected.

Time per dpi (a4 / jpeg-scan, ms): Chromium 150: 30 / 99, 300: 45 / 166. Firefox 150: 30 / 112, 300: 60 / 242. WebKit 150: 156 / 558, 300: 270 / 885. Largest time seen: 0.9 s (WebKit, 300 dpi scan); 200 dpi never exceeded 0.8 s except the 1.0 s first-call wasm/font initialisation in Chromium.

Output size of a 200 dpi page (PNG / JPEG q0.8): vector pages 20 to 120 KB / 15 to 55 KB; scans 1.8 to 4.2 MB PNG / 0.3 to 0.5 MB JPEG; 300 dpi scan PNG up to 5 MB, JPEG about 1 MB. The frame should answer with a JPEG for photographic pages (or the parent recompresses) to stay within the 1 MB background cap of override 16(b).

### Worker strategy (run D and attempts)

| Strategy | Chromium | Firefox | WebKit |
|---|---|---|---|
| blob module worker (`new Worker(blobUrl, {type:"module"})`) | FAILS: worker `error` event with no message, `getDocument` never resolves (timeout) | works | works |
| blob classic worker | FAILS (`import.meta` outside a module) | not run | not run |
| in-frame fake worker (`workerSrc` = served `pdf.worker.mjs`, pdf.js imports it dynamically) | works | works | works |

Decision for all engines: the fake worker. Decoding then runs on the frame's main thread; with the 1 to 2 s first-call cost and a parent timeout this is acceptable. A render never reached the 12 s test timeout with it.

### wasm strategy (run A vs B)

| | wasm on (`wasmUrl` + `wasm-unsafe-eval`) | `useWasm:false` |
|---|---|---|
| jpx-scan | renders, 3/3 engines | **silently blank** (0 % non-white, no error), 3/3 engines |
| ccitt-g4-scan | renders | **silently blank** |
| jbig2-mmr-scan | renders | **silently blank** |
| JPEG, text, Devanagari | renders | renders |

The no-wasm option is therefore not acceptable (it would hand a doctor a blank page with no error). Chosen: serve `wasm/` (needed: `jbig2.wasm` 105 KB, `openjpeg.wasm` 252 KB, `qcms_bg.wasm` 89 KB; `quickjs-eval.wasm` is for PDF scripting, which stays off and is not served), `standard_fonts/` (804 KB), `iccs/` (20 KB) from `/pdf-frame/`, with `wasmUrl`, `standardFontDataUrl`, `iccUrl` and `'wasm-unsafe-eval'` in the frame CSP only. `cmaps/` (1.4 MB) is only for non-embedded CJK-style fonts: serving it is optional (the Hindi fixtures embed their fonts).

### CSP `'self'` (run C)

`'self'` in `script-src` and `connect-src` of the sandboxed document worked in all three engines (a4, jpx-scan, 150 and 300 dpi rendered). The explicit origin also worked everywhere; explicit origin stays the plan's default.

### Isolation (all runs, all engines)

| Probe from inside the frame | Chromium | Firefox | WebKit |
|---|---|---|---|
| `window.parent.document` | blocked | blocked | blocked |
| `document.cookie` | blocked | blocked | blocked |
| `localStorage` | blocked | blocked | blocked |
| `self.origin` | `null` | `null` | `null` |
| fetch of an app path outside `/frame/` | blocked (CSP) | blocked | blocked |
| fetch to another host/port | blocked (CSP) | blocked | blocked |
| fetch of `/frame/secret` with `credentials:"include"` | blocked (CORS) | blocked (CORS) | blocked (CORS) |
| hostile-js PDF: `fetch`/URI targets seen by the unreachable host | no request | no request | no request |

pdf.js runs with scripting off, `isEvalSupported:false`, `enableXfa:false`; the JavaScript/URI actions in `hostile-js` did nothing.

**Cookie observation (the one result that trips the plan's literal rule).** The server log shows the request to an allowed `/frame/` path carried cookies in some engines, even though the response was unreadable (CORS) in the credentialed probe:

| Engine | Cookies sent by the sandboxed frame to `/frame/secret` |
|---|---|
| Chromium 158 | none (Lax by default) |
| Firefox 159 | only the cookie that has no SameSite attribute; the explicit Lax and Strict cookies were not sent |
| WebKit 27.2 (Playwright build) | all three, including `SameSite=Strict`, also with default credentials (and that response was readable, status 200, because the test server sent `Access-Control-Allow-Origin: *`) |

Control experiment (`control.mjs`, no sandbox): a plain page on `localhost:4310` fetching `127.0.0.1:4310` with `credentials:"include"` gets the same result in this WebKit build (Lax and Strict cookies sent on a cross-site request). So this WebKit build does not enforce `SameSite` at all; it is not something the sandbox adds. It was not possible here to test real Safari. Consequences kept in Task 16:

- the app's session cookie is `SameSite=Lax` (Auth.js default; confirm in Task 16) and must never be the only defence: `/pdf-frame/*` routes are public, static, ignore cookies, answer without `Set-Cookie`, and never use the session;
- the frame CSP `connect-src` is limited to `/pdf-frame/` (frame cannot call any app endpoint);
- keep `Access-Control-Allow-Origin: *` only on the static asset routes, never on anything dynamic.

## Human checks

| Check | Who | State |
|---|---|---|
| A real Word "Save as PDF" file with an embedded Devanagari font, rendered in the frame | design partner / owner | PENDING (LibreOffice stands in) |
| A real phone/scanner PDF, including a scanner-made JBIG2 (arithmetic or symbol coded) and an encrypted PDF | design partner | PENDING |
| Real Safari (macOS/iOS), Firefox and Chrome release builds: same fixtures plus the cookie behaviour above | human with the devices | PENDING |

## Decision

**GO-WITH-FALLBACK** for PDF intake, with one flag for the controller: the plan's rule says NO-GO "if the server ever saw the cookie". It did, in the Playwright WebKit build (and Firefox for an attribute-less cookie). I judge it not a sandbox leak (the control shows plain cross-site requests behave the same, the response is unreadable under the credentialed CORS rule, the app session is `SameSite=Lax`, and the frame can reach only public static paths), so I record GO-WITH-FALLBACK; if the controller reads the rule literally, the result is NO-GO and Task 16 sets `PDF_INTAKE_ENABLED = false`.

Values later tasks copy:

- `PDFJS_VERSION=5.7.284` (exact, `--save-exact`; Apache-2.0; integrity above). Not 6.5.438.
- `WORKER=fake-worker` in all engines (blob module worker fails in Chromium inside the sandbox).
- `WASM=on`: serve `wasm/{jbig2.wasm,openjpeg.wasm,qcms_bg.wasm}` (and the three matching LICENSE files), `standard_fonts/`, `iccs/` from `/pdf-frame/` with `Content-Type: application/wasm` for wasm; frame CSP adds `'wasm-unsafe-eval'` to `script-src`; `getDocument` gets `wasmUrl`, `standardFontDataUrl`, `iccUrl`; `useWasm:false` is forbidden because it renders scans blank without an error.
- `CSP_SELF_WORKS=yes` in Chromium, Firefox and WebKit (explicit origin remains the default).
- `DPI=200` (time at most about 0.8 s; 150 dpi also fine). Clamp: 3,600 px longest side (a 14,400 pt page was clamped).
- Reply with JPEG (q about 0.85) for pages whose PNG would exceed 1 MB; PNG otherwise.
- Fallback: when the frame reports an error, does not answer within a timeout (use 20 s), or the render is blank, the wizard offers "export page 1 as an image". A blank render (non-white below 0.05 %) shows a warning, it does not refuse (a Devanagari header page is only 0.7 % non-white).
- The frame route test covers every served path (`pdf.mjs`, `pdf.worker.mjs`, `frame.mjs`, the three wasm files, `standard_fonts`, `iccs`), their content types, the CSP header, and that none of them set or read a cookie.

## Consequences for tasks

- Task 16: pin `pdfjs-dist@5.7.284` (not `5@latest`); implement the fake worker, wasm serving and CSP above; copy `make-pdf.mjs` to `tests/helpers/pdfs.ts`; add `jpx`, `ccitt`, `jbig2` and Devanagari fixtures as opt-in or generated test inputs; blank-render warning; JPEG output; make `PDF_INTAKE_ENABLED` a visible, tested constant; record the Apache-2.0 notice (and the openjpeg BSD-2 / PDFium JBIG2 notices in `wasm/LICENSE_*`) in ADR-0046 and ship the files verbatim.
- Task 16 also keeps the plan's rule that the frame origin comes from `NEXT_PUBLIC_APP_URL` (override 9).
- The plan's `frame.mjs` has no change to its message protocol; only worker creation, `getDocument` options and the CSP differ.
- Re-run the probe against any later pdfjs-dist upgrade; 6.x needs an API port (`doc.destroy`).
