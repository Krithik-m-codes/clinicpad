# Spike S1: overlay print mechanics (Chromium, Gotenberg, Firefox, WebKit; PDF size; footer strip; page numbers)

Date: 2026-11-18. Plan: `docs/superpowers/plans/2026-11-18-phase-2a-overlay-templates.md`, Task 1. Spike code (not committed): `spikes/s1-overlay-print/`.

## Question

Does the overlay mechanism of Task 12 (fixed full-page background `<img>`, `every_page` boxes `position:fixed`, `first_page` boxes `position:absolute`, a flow region built as a `thead`/`tfoot`-spaced table) print correctly, page after page, in Playwright Chromium and in Gotenberg? What does it cost in PDF bytes and HTML characters with realistic (noisy JPEG) backgrounds? Do `@page` margin boxes give "Page x of y", and does a background strip in Gotenberg's footer template work? What do Firefox and Safari do (human check)?

## Environment

| Item | Value |
|---|---|
| Playwright Chromium | 158.0.8127.18 (`@playwright/test` in the root `node_modules`) |
| Playwright Firefox | 159.0 (installed with `npx playwright install firefox webkit`) |
| Playwright WebKit | 27.2 (playwright webkit v2388) |
| Gotenberg | `gotenberg/gotenberg:8.11.0@sha256:e60da3ecc52050303c3886630aa7ed82f9486660b82a1ce6e5bf253c3b0764d4` (from `docker-compose.yml`), container `clinicpad-gotenberg` |
| Gotenberg's Chromium | Google Chrome 129.0.6668.70 (`docker exec clinicpad-gotenberg chromium --version`); also in the image: qpdf, pdftk, exiftool |
| pdf.js for analysis (spike folder only) | `pdfjs-dist@5.7.284` (resolved from `pdfjs-dist@5`; not an app dependency) |
| Host | Windows 11, Node 22 |

Paper: A4 210 x 297 mm and A5 148 x 210 mm, `@page` margin 0 (bottom band 0 or 8 mm), background rendered at 200 dpi (A4 1654 x 2339 px).

## Method

Automated (no human):

1. `probe.mjs`: the plan's page variants (`one-page`, `three-pages`, `band-8mm`, `margin-boxes`) for A4 and A5, printed by Playwright Chromium (`page.pdf`, `preferCSSPageSize`, `printBackground`) and by Gotenberg (`/forms/chromium/convert/html`, margins 0 except the bottom band). Each PDF was parsed with pdf.js: markers per page, text positions of the medicine rows (mm from the top), painted images per page. The background was a lossless PNG (a plain letterhead drawing, which compresses to about 70 KB).
2. Spike-only follow-ups written because the plan's own variant failed on A5: spacer-height sweeps on A4 and A5 (`a5.mjs`, `thr.mjs`, `tf.mjs`).
3. Override 7: `probe-jpeg.mjs` generates noisy JPEG backgrounds (block noise, quality tuned by binary search): 590,522 bytes (the "600 KB" case) and 1,992,626 bytes (the "2 MB" case), A4 1654 x 2339, and prints 1, 3 and 10 pages in Chromium and Gotenberg. Image objects were counted in the PDF bytes (`/Subtype /Image`, `/DCTDecode`). Then the HTML length for a 2 MB background + 512 KB logo + 512 KB signature was measured and compared with `MAX_DOCUMENT_CHARS` (4,194,304) and `maxPdfBytes` (15 MiB = 15,728,640).
4. Firefox and WebKit cannot write PDFs from Playwright. Only first-page geometry under print media emulation was measured (`.box` and `.box-first` positions) and screenshots were taken.
5. Alternative encodings of the background in Gotenberg (CSS `background` on a div; no header/footer files), `alt.mjs`.

Human (Step 7): not done, see Human checks.

## Results

### 1. Fixed-position mechanism and flow region, per page (A4 and A5, Chromium and Gotenberg)

Every variant below printed: background painted on every page (1 image paint per page), `EVERYPAGE-MARK` and `WATERMARK` on every page, `FIRSTPAGE-MARK` only on page 1, and `MEDHEAD` (inner medicine-table header) on every page that has rows. Rows listed as "first row mm / last row mm" are the smallest and largest text positions of `ROW-nn` on each page (limits: first row >= 60 + the row's own offset, last row <= paper height - 25).

| Engine | Variant | Pages | First row mm per page | Last row mm per page | Verdict |
|---|---|---|---|---|---|
| Chromium | A4 one-page | 1 | 71 | 83 | OK |
| Chromium | A4 three-pages (60 rows) | 2 | 71, 71 | 270, 233 | OK |
| Chromium | A4 band-8mm | 2 | 71, 71 | 257, 245 | OK |
| Chromium | A4 margin-boxes | 2 | 71, 71 | 257, 245 | OK |
| Chromium | A5 one-page | 1 | 71 | 83 | OK |
| Chromium | A5 three-pages | 3 | 71, **11, 11** | 183, 179, 85 | **FAIL: pages 2 and 3 have no top spacer** |
| Chromium | A5 band-8mm | 3 | 71, **11, 11** | 170, 173, 104 | **FAIL (same)** |
| Chromium | A5 margin-boxes | 3 | 71, **11, 11** | 170, 173, 104 | **FAIL (same)** |
| Gotenberg | A4 one-page | 1 | 71 | 83 | OK |
| Gotenberg | A4 three-pages | 2 | 71, 71 | 270, 233 | OK |
| Gotenberg | A4 band-8mm | 2 | 71, 71 | 257, 245 | OK |
| Gotenberg | A4 margin-boxes | 2 | 71, 71 | 257, 245 | OK (no page label, see 4) |
| Gotenberg | A5 one-page | 1 | 71 | 83 | OK |
| Gotenberg | A5 three-pages | 3 | 71, **11, 11** | 183, 179, 85 | **FAIL (same as Chromium)** |
| Gotenberg | A5 band-8mm | 3 | 71, **11, 11** | 170, 173, 104 | **FAIL** |
| Gotenberg | A5 margin-boxes | 3 | 71, **11, 11** | 170, 173, 104 | **FAIL** |

The A5 failure is not a Gotenberg-only problem: Playwright Chromium 158 and Gotenberg's Chrome 129 behave identically. The fixed boxes, the background and the watermark were fine everywhere; only the repeated `thead` spacer (60 mm) was dropped on continuation pages, so medicine rows print at 11 mm from the top, over the letterhead.

### 2. Root cause: Chromium repeats a table header or footer only when it is at most about 25 % of the page height

Sweeps (the spacer is the `thead` or `tfoot` row of the outer flow table; first row mm per page):

| Paper (height) | Top spacer | Chromium | Gotenberg |
|---|---|---|---|
| A4 (297) | 60, 70, 74 mm | repeats on every page | repeats on every page |
| A4 | 75, 80, 100 mm | page 2 starts at 11 mm (no repeat) | same |
| A5 (210) | 50, 52 mm | repeats on every page | repeats on every page |
| A5 | 53, 54, 55, 60 mm | page 2 and 3 start at 11 mm (no repeat) | same |

The cut-off is 25 % of the paper height: 74.25 mm on A4 and 52.5 mm on A5. The footer behaves the same way: bottom spacer 60 and 74 mm repeat on A4 (last row 230 and 217 mm), 75 mm and above do not (last row 292 mm, inside the bottom band); on A5 the same flip happens between 52 and 53 mm. The two spacers do not add up against the limit: A5 with top 50 and bottom 25 repeats both (75 mm = 36 % of the page).

### 3. PDF size and the image being written once (override 7)

Noisy JPEG backgrounds, A4, `@page` margin 0, 1 / 3 / 10 pages. "Image objects" = `/Subtype /Image` count in the PDF file (= `/DCTDecode` count, all JPEG).

| Background | Pages | Chromium PDF bytes | Chromium image objects | Gotenberg PDF bytes | Gotenberg image objects |
|---|---|---|---|---|---|
| 590,522 B | 1 | 631,312 | 1 | 632,517 | 1 |
| 590,522 B | 3 | 637,823 | 1 | 1,919,097 | 3 |
| 590,522 B | 10 | 655,183 | 1 | 6,393,925 | 10 |
| 1,992,626 B | 1 | 2,033,418 | 1 | 2,034,623 | 1 |
| 1,992,626 B | 3 | 2,039,929 | 1 | 6,125,412 | 3 |
| 1,992,626 B | 10 | 2,057,289 | 1 | 20,414,976 | 10 |

- **Playwright Chromium 158 writes the image once** (growth about 2.7 KB per extra page). The page content only references it.
- **Gotenberg (Chrome 129) writes the full image once per page**: growth per extra page is about 640 KB (590 KB background) and about 2.04 MB (2 MB background), i.e. the file size of the background. With the earlier lossless PNG the growth was about 70 KB per page (A4 two pages: 101,501 to 243,716 bytes; A5 three pages 73,171 to 219,876 bytes), above the plan's 150 KB threshold for the 2 MB case and below it for the PNG sketch only.
- A 2 MB background therefore breaks the 15 MiB PDF cap (`maxPdfBytes` in `src/server/pdf/engine.ts`) at 8 pages (10 pages: 20,414,976 bytes). A 590 KB background reaches the cap after about 24 pages.
- Using a CSS `background` on a div instead of an `<img>` is far worse in Gotenberg (3 pages, 2 MB JPEG: 31,891,326 bytes, no DCT stream: the image is re-encoded losslessly). Omitting Gotenberg's `header.html` and `footer.html` files changes nothing (6,125,412 bytes both ways). Keep the `<img>`.
- Gotenberg took 0.3 to 1.9 s for these documents (10 pages with a 2 MB image: 1.9 s).

### 4. Margin boxes (page numbers) and the footer strip

- `@page{@bottom-center{content:"Page " counter(page) " of " counter(pages)}}`: **Playwright Chromium 158 prints "Page x of y"** (A4 margin-boxes: "Page 1 of 2", "Page 2 of 2"; A5: "Page 1 of 3" and so on). **Gotenberg's Chrome 129 does not** (no `pageLabel` on any page of any variant). Task 12 therefore uses Gotenberg's footer template for page numbers (as the plan already says); margin boxes are a browser-print-only follow-up.
- Footer strip (a bottom background strip drawn inside Gotenberg's footer template, 8 mm band): works. It paints one more image per page (2 instead of 1) and adds about 1.5 KB for the PNG strip (A4 two pages 243,129 to 244,684 bytes; A5 three pages 218,556 to 220,395 bytes). The body rows were still inside the band (last row 257 and 245 mm on A4).

### 5. HTML length against the caps (override 7)

Spike overlay page (A4, 280 rows of medicines, one logo box and one signature box) with a 2 MiB-class background:

| Case | Bytes | HTML characters | Cap | Margin |
|---|---|---|---|---|
| Measured files: background 2,041,321 B, logo 520,219 B, signature 520,219 B | 3,081,759 | **4,131,354** | 4,194,304 | 62,950 under |
| Theoretical limits: 2,097,152 + 524,288 + 524,288 | 3,145,728 | base64 alone **4,194,308** | 4,194,304 | **already 4 over, before any HTML, CSS or font** |
| Estimated whole page at the exact limits (measured + base64 of the missing 85,292 chars) | n/a | about 4,216,646 | 4,194,304 | **about 22,000 over** |
| Background 590,522 B (600 KB) | n/a | 789,250 to 811,200 | 4,194,304 | about 3.4 M under |
| Background 1.5 MB (1,572,864) + logo + signature at 512 KB (base64 only) | n/a | 3,495,256 + HTML | 4,194,304 | about 700 K for the HTML, CSS and any fonts |

The built-in pads embed WOFF2 fonts as base64 as well; the shipped files are 5 KB to 40 KB each, so fonts and markup together need well under 300 KB, but they must be added to the budget. Rendering the 2 MB + logo + signature page in Gotenberg (9 pages) produced a **23,507,298-byte PDF (cap 15,728,640)** because the logo and signature (fixed boxes) are repeated per page as well (18 image objects); the same page in Chromium is 4,666,191 bytes (3 image objects).

### 6. Firefox 159 and WebKit 27.2 (automated part only)

Under print media emulation both put `.box` (fixed) at 20.0 mm / 45.0 mm and `.box-first` at 140.0 mm from the left (expected 20, 45, 140): the CSS geometry matches. This says nothing about the printed output; a real print needs a person (Human checks).

## Human checks

PENDING (nobody has done them; no result may be inferred from the automated geometry above). Who: a person with Firefox on Windows, and a person with Safari on macOS (and iOS Safari if available).

Open `spikes/s1-overlay-print/out/html/A4-three-pages.html` and `A5-three-pages.html` (regenerate with `node probe.mjs`) in Firefox and Safari, Print, preview at 100 %, headers and footers off, "print backgrounds" on. For each page note: background visible; `EVERYPAGE-MARK` visible; `FIRSTPAGE-MARK` only on page 1; `MEDHEAD` repeated; any row cut in half; rows overlapping the top 60 mm or the bottom 25 mm. Because of finding 2, also open `A5-three-pages.html` at a 45 mm top spacer variant (edit `.top{height:60mm}` to `.top{height:45mm}`) to see whether Firefox and Safari repeat the spacer at all. Also open two of the Gotenberg PDFs (`out/*-gotenberg.pdf`) in Adobe Reader and in a phone PDF viewer and confirm they look like the Chromium ones.

| Check | Result |
|---|---|
| Firefox, A4 three pages | PENDING |
| Firefox, A5 three pages | PENDING |
| Safari (macOS), A4 / A5 | PENDING |
| iOS Safari | PENDING |
| Gotenberg PDFs in Adobe Reader / phone viewer | PENDING |

## Decision

**GO-WITH-FALLBACK** for the fixed-position mechanism, with four binding constraints; it is **NO-GO as the plan literally wrote it** (a flow table with spacers of any height, a 2 MB background at any page count), so Tasks 11, 12, 15, 16 and 19 must absorb the constraints below before Task 12 starts. The controller decides whether these constraints are acceptable (override 15: S1 must be GO before Task 12).

Values later tasks copy:

1. **Spacer limit (hard).** Chromium (Playwright 158 and Gotenberg's Chrome 129) repeats the `thead` and `tfoot` spacers only if each is at most 25 % of the paper height. The flow region's top gap (region top y) and bottom gap (paper height - region bottom y) must each be **at most 24 % of the paper height: A4 at most 71.0 mm, A5 at most 50.0 mm** (rounded down from 71.28 and 50.4). Publish refuses a region outside this (with an explanation); Task 11's geometry rules gain it. Do not rely on a design where the gap is larger: the alternative (boxes inside the repeated header cell, or one overlay page per Rx page) is not measured here.
2. **Mechanism otherwise confirmed in both engines:** `position:fixed` background `<img>`, `position:fixed` every-page boxes, `position:absolute` first-page boxes, repeated inner medicine `thead`, no row inside a spacer (when constraint 1 holds).
3. **Background weight in Gotenberg:** the image (and every fixed logo or signature image) is written once per page; PDF size is about (background + fixed images) x pages. With the 15 MiB cap: a 2 MB background fits 7 pages, a 600 KB background about 24 pages. Task 12 keeps the background JPEG at the client's 600 KB target; Task 16 warns above 600 KB (the plan's rule for growth above 150 KB per page); the hard cap and a page limit (or a pre-check that estimates `pages x (background + fixed images)` against 15 MiB, failing with a clear message instead of a generic PDF error) belong to Tasks 12 and 15. Chromium browser print is unaffected.
4. **HTML cap (override 3 / C2):** 2 MiB background + two 512 KiB images cannot fit 4,194,304 characters (base64 alone is 4,194,308). Pick one (override 3): lower the background cap to **1.5 MB** (base64 3,495,256 with logo and signature at the maximum, leaving about 700 K for markup, CSS and fonts), or keep 2 MB and refuse to publish unless the sum fits with a 300 K margin. Task 12's worst-case test must use the real numbers above.

Other recorded values:

- PDF growth per page (Gotenberg): about 70 KB for the lossless PNG sketch, **about 640 KB** (590 KB JPEG) and **about 2.04 MB** (2 MB JPEG) per extra page; Chromium about 2.7 KB per page (image written once).
- Margin boxes: Chromium prints "Page x of y": **yes (Playwright Chromium 158.0.8127.18)**; **no (Gotenberg Chrome 129.0.6668.70)**. Task 12 uses Gotenberg's footer template for page numbers.
- Footer strip in Gotenberg's footer template: works, one more image per page (about +1.5 KB per extra page for the PNG strip sketch).
- `OVERLAY_BROWSER_PRINT` for Task 19: `chromium: true` (Playwright Chromium passed for A4 and for A5 inside the 24 % spacer limit), `firefox: false`, `webkit: false` (the human check is PENDING, so both stay false; Task 19 copies these three booleans).

## Consequences for tasks

- **Task 11 (definition schema and geometry rules):** add the 24 % spacer rule (flow region top gap and bottom gap each at most 24 % of paper height; A4 71.0 mm, A5 50.0 mm) as part of the frozen v1 geometry rules, with tests at 70.9 / 71.1 mm on A4 and 49.9 / 50.1 mm on A5.
- **Task 12 (renderer):** keep the plan's mechanism; the visual and PDF tests must use a background JPEG of about 600 KB; add the worst-case test from override 3 with real caps; Gotenberg page numbers via the footer template, never margin boxes; assert in an integration test with Gotenberg that no row prints inside a spacer on A5 three pages at a 45 mm spacer. Before relying on the image weight, estimate `pages x (background + fixed images)` against 15 MiB.
- **Task 15 / Task 16 (publish, upload warnings):** warn above 600 KB; apply override 3 (1.5 MB cap or sum check); refuse a region that breaks the 24 % rule at publish.
- **Task 19 (print modes):** `OVERLAY_BROWSER_PRINT = { chromium: true, firefox: false, webkit: false }` until the human checks above are filled in.
- **Task 17 / S5 (Gotenberg upgrade):** the per-page image duplication is a property of Gotenberg 8.11.0's Chrome 129 (Playwright's Chrome 158 writes the image once). When S5 evaluates a newer Gotenberg, re-run `probe-jpeg.mjs` and record whether the image is written once; if it is, the page and size limits above relax.
