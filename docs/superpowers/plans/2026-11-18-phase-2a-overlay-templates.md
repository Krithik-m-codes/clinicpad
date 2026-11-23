# ClinicPad Phase 2A — Overlay Templates ("bring your own pad", overlay slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clinic owner uploads a photo, scan, or PDF of the pad they already use, places the patient, date, and Rx-number boxes and the body region on it in Template Studio, publishes it, assigns it to the clinic or to a doctor, and from then on every prescription finalized by that doctor prints, downloads, and shares on that pad (or on their pre-printed stationery), frozen by version and hash so a reprint in five years looks exactly like the original.

**Architecture:** A pad template is an *overlay*: a background image (stored once, scanned by ClamAV, stripped of metadata, in a new Postgres table `template_files`) plus a validated JSON definition of field boxes and one flow region (in `template_versions.definition`). Published versions are frozen by database triggers. At finalize, `finalizePrescription` resolves the signer's template (doctor assignment, then clinic default, then the built-in pad), writes `prescriptions.template_version_id`, and freezes `{ kind: "overlay", templateVersionId, contentSha256 }` in render snapshot v2. A new pure renderer `renderOverlay` draws the same self-contained HTML document the built-in pads use (fixed background and boxes, a `thead`/`tfoot`-spaced flow region that reuses the built-in section and medicine renderers), so browser print, Gotenberg PDF, the share route, `checkSelfContained()`, and the output log all keep working unchanged. PDFs are never sent to the server: the browser rasterizes the chosen page with pdf.js inside an opaque-origin sandboxed iframe and uploads an image.

**Tech Stack:** Next.js 15.5.29 (App Router, route handlers, server actions), React 19.1, TypeScript strict, Drizzle ORM 0.45 + drizzle-kit 0.31, Postgres 16 with forced RLS, Zod 4, Vitest 5 (+ Testing Library, jsdom), Playwright 1.65, Gotenberg 8 (Chromium route), ClamAV `clamd` (new container), `pdfjs-dist` 5.x (new, browser-only, exact pin).

**Spec:** `docs/superpowers/specs/2026-11-18-phase-2-template-studio-design.md` (approved by the human on 2026-11-18 with "Sure" for its recommendations: start 2A overlay-first now; DOCX (2B) waits for pilot evidence; template files in Postgres with per-tenant quotas through 2A/2B; docxtemplater core only; ClamAV in a no-network container). This plan implements the spec's sub-plan 2A: sections 4.3–4.4, 5 (template model, snapshot v2, field catalogue), 6 (overlay kind), 8 (hostile uploads), 9 (rendering pipeline), 10.1 and 10.3 (wizard), 12 (testing, overlay parts), 15.1 (task list), 17 (ADR-0043 to ADR-0048). Read with `AGENTS.md` §3 (invariants) and §10 (things that bite), `docs/DECISIONS.md` ADR-0019 to ADR-0042, and Plans 1C and 1D (`docs/superpowers/plans/2026-11-17-phase-1c-templates-pdf-print.md`, `docs/superpowers/plans/2026-11-17-phase-1d-sharing-import-hardening.md`), whose patterns this plan reuses. It was written against the **code** at HEAD `32ff673` (branch `phase-1-prescription-mvp`); where the code and the spec differ, the code wins and this plan says so.

## Prerequisites

Phase 1 (Plans 1A–1D) is merged on `phase-1-prescription-mvp` (HEAD `32ff673` or later). From PowerShell:

```powershell
Set-Location E:\projects\clinicpad; git log --oneline -1
Set-Location E:\projects\clinicpad; Get-ChildItem drizzle -Filter *.sql | Select-Object -Last 2 -ExpandProperty Name
Set-Location E:\projects\clinicpad; Test-Path src/lib/rx-render/render.ts, src/lib/rx-render/snapshot.ts, src/lib/rx-render/self-contained.ts, src/lib/domain/image.ts, src/server/services/assets.ts, src/server/services/rx-documents.ts, src/server/services/rx-output.ts, src/server/services/share-open.ts, src/server/services/render-snapshot.ts, src/server/pdf/gotenberg.ts, src/server/http/rate-limit.ts, tests/helpers/images.ts, tests/helpers/tenant.ts, tests/fixtures/rx-documents.ts
Set-Location E:\projects\clinicpad; docker compose up -d postgres gotenberg
Set-Location E:\projects\clinicpad; npm run test
```

Expected: HEAD `32ff673` (or a later commit on top of it); the last migrations are `0022_phase1d_sharing_security.sql` and `0023_phase1d_sharing_integrity.sql`, so **this plan's migrations are 0024 to 0027**; fourteen `True` lines; `npm run test` reports **70 files, 1,604 passed + 1 skipped** (the Plan 1D gate of 2026-11-17, `AGENTS.md` §2). Write down the counts you see: they are the baseline for Task 20. The e2e suite has 49 tests (41 run, 8 opt-in screenshot tests skipped). If Postgres is not running, start Docker Desktop from `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`, then rerun the compose command.

What the code at HEAD looks like, and what this plan relies on (checked file by file):

- **Renderer** (`src/lib/rx-render/`): `renderPrescription(doc, assets)` in `render.ts` (446 lines) switches on `doc.snapshot.layout.template.kind` with no `default` (a new kind fails to compile until drawn) and calls the private `renderBuiltin`. `TemplateRef` is `{ kind: "builtin"; key: BuiltinTemplateKey }` (`types.ts` line 18); `RenderedDocument` is `{ format: "html"; html; footerHtml; paper: PaperSpec; title }`; `RenderAssets` is `{ logo; signature; fontCss }`. `RENDERER_VERSION = "1"` is logged per output (`prescription_outputs.renderer_version`). `DOCUMENT_CSP` and `footerTemplate(doc, paper)` are exported from `render.ts` and imported by the document route and tests. `documentCss(def, paper)` (`styles.ts`) builds CSS only from fixed strings, the template definition and the paper spec; `.watermark` is already `position:fixed`. `PAPER` (`paper.ts`) holds A4 (210 × 297 mm, margins 12/12/14/12) and A5 (148 × 210 mm, margins 9/9/12/9). `TEMPLATE_DEFINITIONS` (`templates.ts`) has `general`, `paediatric`, `derma` with `sections: SectionKey[]`, `vitals: VitalKey[]`, `medicineLayout`, `accent`. HTML is built only with `html`, `raw`, `userText` (`html.ts`); `checkSelfContained()` (`self-contained.ts`) is deny-by-default (allowed tags, no CSS comments or escapes, `url()` and `src` only for embedded PNG/JPEG/WOFF2, 4 M characters).
- **Snapshot** (`snapshot.ts`): `renderSnapshotSchema` is version 1 with `layout.template: { kind: literal("builtin"), key }`; `parseRenderSnapshot(value)` never throws. `compose()` in `src/server/services/render-snapshot.ts` writes `v: 1`. `buildFinalSnapshot(tx, sources)` (Result) is called only by `finalizePrescription`; `buildRenderSnapshot(tx, sources)` (plain) only by `loadRxDocumentIn` and `tests/integration/render-snapshot.test.ts`.
- **Finalize** (`src/server/services/prescriptions.ts` `finalizePrescription`): locks the prescription `FOR UPDATE`, checks the revision and items, reads the visit, builds the snapshot with plain reads **before** allocating the Rx number, then one `UPDATE … set({ status: "finalized", rxNo, finalizedAt, finalizedBy, renderSnapshot })`. `prescriptions.template_version_id` exists with the composite key `prescriptions_template_version_fk` (`ON DELETE SET NULL (template_version_id)`, migration 0010) and is never written. `AMEND_PRESCRIPTION_COLUMNS.templateVersionId` is `"copy"` and `REPEAT_PRESCRIPTION_COLUMNS.templateVersionId` is `"reset"` (`src/server/services/rx-mapping.ts` lines 108, 128). `getPrescription` builds `PrescriptionView` in `readSnapshot` (no template field today).
- **Template tables** (`src/server/db/schema/clinical.ts` lines 240–284): `templates` (`name`, `kind` default `'html'`, `status` default `'draft'`, `unique templates_tenant_id_uq`) and `template_versions` (`version`, `file_key`, `mapping`, `published_at`, `unique template_versions_tenant_id_uq`, `template_versions_template_fk` cascade) with forced RLS and the `tenant_isolation` FOR ALL policy from 0002. No code writes them; only `tests/integration/tenant-fk.test.ts` (`seedPhase0`, `phase0Relations`) and `tests/integration/clinical-references.test.ts` (`world`) insert rows.
- **Clinic images** (`src/server/services/assets.ts`): `storeImageAsset(tx, ctx, kind, bytes)` inspects (`inspectImage`), strips metadata (`stripImageMetadata`), de-duplicates by SHA-256 and caps per kind; called inside `withTenant` by `setClinicLogo` / `setDoctorSignature` (`src/server/services/pad-settings.ts`), which the settings actions call with `{ bytes }`. `IMAGE_LIMITS` is `{ maxBytes: 512 KB, minSide: 16, maxSide: 2000 }` and `inspectImage(bytes)` reads it directly. There is no malware scan (ADR-0035). `bytea` is a private `customType` in `src/server/db/schema/tenancy.ts`.
- **Output path**: `renderDocument(bundle)` (`src/server/services/rx-output.ts`) renders and runs `checkSelfContained` on both parts; `recordOutput` writes `prescription_outputs` (`templateKey: bundle.document.snapshot.layout.template.key`, `htmlSha256`, `rendererVersion: RENDERER_VERSION`) plus an audit event; `renderPrescriptionHtml(ctx, id, purpose, signal)`, `renderPrescriptionPdf(ctx, id, engine, limiter, signal)`. `src/server/services/share-open.ts` `render()` writes its own output row with the same `template.key` read. `rx_outputs_template_key_check` is `template_key in ('general', 'paediatric', 'derma')` (0015, mirrored in Drizzle). `enforce_rx_output_target()` (0015) is the current version of the output trigger.
- **PDF engine** (`src/server/pdf/`): `PdfEngine.render(doc, { signal })` never throws; `gotenbergForm(doc)` sends `doc.paper.marginMm` as the page margins; a private `readCapped(response, maxBytes)` in `gotenberg.ts` counts body bytes. `renderLimiter` is 2 running / 5 queued; `publicPdfLimiter` (share route) 1 / 2. Gotenberg is `8.11.0@sha256:e60da3ec…` in `docker-compose.yml`, `.github/workflows/ci.yml`, and the `IMAGE` constant of `tests/integration/gotenberg-smoke.test.ts`.
- **HTTP** (`src/server/http/`): `crossSiteRefusal(request)` (allows absent, `same-origin`, `none`), `statusForError` (forbidden reads as 404), `publicCode`, `headNotAllowed`, `contentDisposition`; `createRateLimiter({ windowMs, max })` in `rate-limit.ts`. Route files may export only route handlers and route config (Next type-checks this at build), so shared state such as a limiter lives in `src/server/http/*`.
- **Roles** (`src/lib/domain/permissions.ts`): the last entry is `"settings.profile"`; `tests/unit/permissions.test.ts` asserts behaviour per action (add cases for each new action). `member_role` is a Postgres enum (`owner, doctor, reception, nurse, accountant, pharmacist`; `src/server/db/schema/enums.ts`). `getActiveMembership(userId)` (`src/server/auth/credentials.ts`, admin connection) is re-read by the JWT callback on every request (`src/auth.ts`).
- **Desktop and routing**: `scripts/build-desktop.mjs` `SERVER_ONLY` stashes `src/app/(app)` (so everything under `src/app/(app)/templates/` is stashed automatically), auth, API routes and `src/app/s`. The middleware matcher is `["/dashboard/:path*", "/patients/:path*", "/prescriptions/:path*", "/settings/:path*"]`. `next.config.ts` traces the font files into `/prescriptions/**` and `/s/**`.
- **Tests**: `createTestTenant(label)` (`tests/helpers/tenant.ts`) creates a tenant, a user with a doctor profile and an owner membership, and a clinic; `as(role)` gives owner and doctor the same user and every other role a fresh random user id. `tests/helpers/images.ts` has `makePng(width, height, rgb)`, `makeJpegHeader`, `pngWithChunks`, `jpegWithSegments`. `tests/fixtures/rx-documents.ts` has `snapshot()` (writes `v: 1`), `documentFixture()`, `item()`, `manyItems()`, `visit()`, `HOSTILE`, `DEVANAGARI`, `TINY_PNG`. `tests/helpers/fake-pdf-engine.ts` has `createFakePdfEngine`, `sharedFakeEngine`. Route tests mock `@/server/auth/session` and `@/auth` (see `tests/integration/rx-output-routes.test.ts`). Playwright runs only the `chromium` project (`playwright.config.ts`); only Chromium browsers are installed on this machine (`%LOCALAPPDATA%\ms-playwright`).
- **Guards that catch a forgotten rule automatically**: `tests/integration/rls-guard.test.ts` (forced RLS and a session-scoped policy on every table with `tenant_id`; no TRUNCATE grants), `tests/integration/tenant-fk.test.ts` ("has no single-column key into a tenant-owned table"), `tests/integration/schema-checks.test.ts` (every CHECK in the database is declared in Drizzle).
- **Migrations run in ONE transaction**: drizzle's migrator applies every pending migration inside a single transaction, so a value added to an enum (`ALTER TYPE … ADD VALUE`) cannot be *used* as an enum literal by a later statement of the same run ("unsafe use of new value"). Task 15 compares `role::text` instead.

## Where this plan sits in Phase 2

| Sub-plan | Scope | Status |
|---|---|---|
| **2A (this plan)** | Spikes S1–S5, template model, upload pipeline with ClamAV, field catalogue, snapshot v2 and resolution at finalize, overlay renderer, Template Studio (upload, crop, boxes, preview, publish, assign), pre-printed paper mode, per-browser print, visuals, cross-tenant sweep, ADR-0043 to ADR-0048 | this plan |
| 2B | DOCX: sanitizer, office engine container, placeholders, docxtemplater core, DOCX print path, mapping UI, golden DOCX suite | waits for pilot evidence (spec §4.4) and its own plan; Task 5's S3 finding is an input |
| 2C | Gallery, concierge tooling (designer invite flow), object storage, job queue, document tools, PDF→DOCX/OCR | own plan |

Out of scope here (do not build): DOCX upload or rendering, LibreOffice, docxtemplater in the app, PDF→DOCX, OCR, perspective correction of photos, object storage, a job queue, a designer invite UI, branch-level assignment, a template diff view, `{{qr}}`, stored "as issued" PDFs, Letter paper.

## Decisions made in this plan

Each line: decision — reason — cost if wrong. Task 20 records the durable ones as ADR-0043 to ADR-0048 (re-check that ADR-0043 is still the next free number before writing them).

1. **Overlay first; DOCX waits** (approved, spec D1/§4.2) — reuses Plan 1C's renderer, checker, fonts, print and PDF path; covers photo, scan, printer's PDF, and Word via "Save as PDF" — the doctor's own Word table styling is not used inside the body region.
2. **Spikes S1–S5 run first and write findings to `docs/spikes/`**; S1, S2, S4, S5 gate later tasks; S3 (docxtemplater) gates nothing in 2A and only feeds 2B planning — the risky browser and container facts are measured before code depends on them — a spike day per unknown.
3. **Template files live in Postgres (`template_files.bytes`, bytea)** with `storage = 'pg'` as the seam; every read goes through `loadTemplateFileIn()` (approved, spec D3) — same guarantees as `clinic_assets` (RLS, composite keys, immutability, one transaction with the version row, India region) — database growth; revisit above 5 GB or when patient documents arrive (2C).
4. **The server only ever receives PNG or JPEG.** PDFs are rasterized in the browser by pdf.js (`isEvalSupported: false`) inside `<iframe sandbox="allow-scripts">` (opaque origin) loaded from the public, static, server-only route `/pdf-frame/*`; the parent validates every message (spec D2) — a hostile PDF never reaches the server, and an exploited pdf.js cannot ride the session — if S2 finds a browser where the frame cannot run, that browser gets "export page 1 as an image" instead (automatic, Task 16).
5. **ClamAV `clamd` scans every upload synchronously over `INSTREAM`, before anything is stored; scanner down, slow (15 s), or confused means refused** (fail closed, no quarantine table: nothing unscanned is ever stored). Logo and signature uploads get the same scan (closes ADR-0035's note). `CLAMAV_HOST`/`CLAMAV_PORT` are mandatory in production; `CLAMAV_DISABLED_FOR_DEVELOPMENT=1` exists for local development only and makes the scanner *refuse everything* when `NODE_ENV=production` (approved, spec D4) — about 1.5–2 GB of container memory.
6. **Background limits:** PNG or JPEG detected from bytes, ≤ 2 MB, long side 1,100–3,600 px, aspect within 0.0425 of √2 (A-series ±3 %), nothing after the end marker, metadata stripped before hashing; the original bytes and the file name are never stored or logged. Logo/signature limits (`IMAGE_LIMITS`) are unchanged — a background is embedded into every printed document, so size is bounded — a 600 KB target is suggested by the client, 2 MB is the hard cap.
7. **Quotas per tenant, exact under one advisory lock** (`pg_advisory_xact_lock(hashtextextended('clinicpad:template-quota:' || tenant, 0))`, taken before any row lock): 20 active templates, 100 versions, 50 MB of template files. Unused files older than 30 days are deleted lazily at the next upload; the database refuses deleting a file that a version uses (foreign key) or that is younger than a day (trigger) — no scheduler needed — two code constants if plans differ later.
8. **Template model:** `templates.kind = 'overlay'` (2B adds `docx`), `status active | archived`, `identity dynamic | bound` (+ `bound_doctor_id`), `current_version_id`. `template_versions` are born as drafts (trigger), a draft is a working copy edited in place with `draft_revision` (optimistic concurrency, like prescriptions, ADR-0029), a published version is frozen by trigger on every connection (no UPDATE, no DELETE unless the tenant is erased). At most one draft per template, enforced by the services under the template row lock (no partial unique index: the Phase 0 key tests move draft rows between templates). Rollback publishes a copy of an older version as a new number; history is linear.
9. **Assignment columns** `clinics.custom_template_id` and `doctors.template_id` (composite keys, `NO ACTION`). **Resolution order at finalize:** the finalizer's doctor template, then the clinic default, then the built-in `clinics.rx_template`; a template must be `active` with a published current version; a `bound` template is used only for its own doctor and is skipped (never used) for anyone else; a bound template cannot be the clinic default (refused at assignment and at publish) — R12, a prescription on another doctor's letterhead — strict default for an open human decision (see below).
10. **Snapshot v2:** `layout.template` is `{ kind: "builtin", key } | { kind: "overlay", templateVersionId, contentSha256 }`; for overlays `paperSize` and `labels` come from the version. `parseRenderSnapshot` keeps the v1 parser and normalises v1 to v2 in memory (no backfill). `contentSha256 = sha256(canonicalJson({ v: 1, kind, paperSize, labels, definition, fileSha256 }))` of the *parsed* definition. Finalize writes `prescriptions.template_version_id` in the same UPDATE as the snapshot; a CHECK ties the column to the snapshot and a trigger refuses a non-published version. Reprint reloads the version and file by id inside `withTenant`, re-hashes the file bytes and the definition, and **fails closed** on any mismatch (spec D10, §5.4).
11. **Amendments re-resolve at their own finalize:** `AMEND_PRESCRIPTION_COLUMNS.templateVersionId` becomes `"reset"` (spec §5.3, Q15 recommendation) — an amendment is a new record — Q15's alternative is a one-line rule change.
12. **Overlay rendering inside the HTML pipeline** (spec §6.2): `@page` margin 0 (or a bottom page-number band); background `<img>` in a `position:fixed` frame; `every_page` boxes `position:fixed`, `first_page` boxes `position:absolute`; the flow region is a table whose `thead`/`tfoot` spacers repeat on every page and whose body reuses the built-in sections, medicine tables, allergies, signature and markers; box values are `userText()`, overflow is visible, never clipped. CSS positions come only from numbers of a parsed definition (rounded to 0.1 mm), never from strings. Three render targets: `screen` (preview), `print` (paper: applies the printer offset, omits the background when `printMode = "pdf_only"`), `pdf` (digital copy: background always, no offset).
13. **Renderer versions per kind:** built-in stays `"1"` (golden files unchanged), overlay is `"overlay-1"`; output rows also record `template_version_id` and `engine` (`chromium` for Gotenberg, `browser` for HTML handed to a print dialog). `input_sha256` (spec §5.2) waits for 2B: for HTML outputs it would equal `html_sha256`.
14. **Previews:** sample previews (short, long with 12 medicines and Hindi text, blank) use the clinic's own clinic and doctor details with fake patient content and a "SAMPLE · NOT A PRESCRIPTION" watermark, and are not logged; a real-patient preview needs `rx.read`, is always rendered as a draft (watermark, no Rx number, no signature), and is audited (`template.previewed_with_patient`, ids only).
15. **Roles:** `template.read` (owner, doctor, designer), `template.write` (owner, designer; a doctor only for templates bound to their own profile, and a doctor's new template is bound to them), `template.publish` (owner), `template.assign` (owner; a doctor only for their own profile). A new `designer` role (templates only: no patient, prescription, catalogue or settings action) requires `memberships.expires_at`, and `getActiveMembership` ignores expired memberships; there is no invite UI (2C) (spec D13, Q10 recommendation).
16. **Per-browser print for overlay pads:** Chromium-based browsers (Chrome, Edge) print the overlay HTML through the existing hidden iframe; Firefox and Safari open the Gotenberg PDF rendered for paper (`target: "print"`) in a new tab until S1's human check confirms their print of fixed elements, at which point one constant flips (`OVERLAY_BROWSER_PRINT` in `src/lib/templates/print-support.ts`). Built-in pads are unchanged.
17. **Gotenberg upgrade** to the newest pinned 8.x if S5 says go (spec D14); otherwise 2A stays on 8.11 (overlay does not need the upgrade) and the finding says why.
18. **Field catalogue v1** (`TEMPLATE_FIELDS`, `src/lib/rx-render/fields.ts`) with the spec §5.5 names (`doctor.reg_no`, `visit.rx_no`, `follow_up.date`, …) and `toTemplateData(doc, lang)` built from the same `format.ts`/`labels.ts` helpers as the built-in pads. Overlay boxes accept only text and image fields; `patient.phone` is absent (Q14) and `qr` is reserved. Lists and flags exist for 2B and are unit-tested now.
19. **Publish preconditions** (PRODUCT_SPEC §7.7): boxes for `patient.name` and `visit.date`; the flow region contains `medicines`; a `dynamic` template prints `doctor.name` and `doctor.reg_no` (boxes, or the end-of-content signature block, which prints both); a `bound` template names its doctor and the publisher confirms the letterhead shows that doctor's name and registration number (recorded in the audit event). The publisher must choose dynamic or bound explicitly (no preselected answer).
20. **Lock rules:** take the template-quota advisory lock (when needed) before any row lock; lock the template row before writing anything about it or its versions — `FOR UPDATE` for publish, new draft, save, discard, rollback, archive, unarchive, delete; `FOR SHARE` for assign. `finalizePrescription` takes **no** template lock (plain reads; published versions never change; the foreign key takes a KEY SHARE lock), so ADR-0023's two lock orders are untouched.
21. **Desktop:** every Template Studio page and route lives under `src/app/(app)/templates/` (stashed automatically); the one public route `src/app/pdf-frame/` is added to `SERVER_ONLY`.
22. **Visual tolerance (provisional, human decision Q9):** overlay screenshot regression uses `maxDiffPixelRatio: 0.001` (the spec's proposed 0.1 % regression value); the 2 % fidelity tolerance applies to DOCX only (2B) and is not used here.

## Human decisions this plan does not make (and the safe default meanwhile)

| Decision | Owner | Safe default in code |
|---|---|---|
| Hosting region and host for the document engines and ClamAV (Q4; Fly.io `bom` vs AWS `ap-south-1`, egress blocking) | founder / ops | Nothing is deployed by this plan. `GOTENBERG_URL` and `CLAMAV_HOST`/`CLAMAV_PORT` are mandatory in production and nothing assumes a host; the compose services bind to `127.0.0.1` only. |
| Locking templates to a doctor (Q6: bound vs dynamic letterheads) | founder / clinical | The strict rule is implemented (decision 9): bound templates print only for their doctor and are skipped otherwise; the publisher must choose dynamic or bound explicitly. If the human decides against binding, every template is published `dynamic` and nothing else changes (the column and checks stay). |
| May an owner without a doctor profile finalize (open since Plan 1A) | founder / clinical | Unchanged: allowed, prints no doctor block (ADR-0032). Resolution then uses only the clinic default, and only if it is `dynamic`. |
| Licences for pdf2docx/PyMuPDF and Ghostscript (Q7) | founder / legal | None of them is installed. docxtemplater appears only in Task 5's throwaway spike folder (git-ignored), never in `package.json`. |
| PDF→DOCX exit criterion (Q8) | founder | Not built. |
| Visual tolerance (Q9) | founder | Provisional `maxDiffPixelRatio: 0.001` for overlay screenshot regression (decision 22); human PDF review stays mandatory. |
| Safari and Firefox print of fixed elements (S1 human check) | founder with a Mac/iPhone and Firefox | Firefox and Safari print overlay pads from the Gotenberg PDF (decision 16) until the check passes. |
| Data minimisation: who may preview a template with a real patient (Q14) | founder / legal | Only roles with `rx.read` and `template.read` (owner, doctor); the designer never; audited. `patient.phone` is not a field. |
| Native-speaker review of new Hindi strings (field labels, the SAMPLE watermark, studio copy) | native speaker | Marked `NEEDS NATIVE-SPEAKER REVIEW` in `fields.ts` and `labels.ts`; the studio UI is English. |
| Staging (Phase 0 carry-over) and the "10 clinics, median setup < 10 minutes" criterion | founder / ops | Gate 2A records automated evidence and a scripted wizard timing only; the funnel query is documented for when staging exists. |
| Free tier gating of own-pad templates (Q21) | founder | Not gated: every plan can upload and print. |
| Phone photos (Q20) | founder | Crop and rotate only (approved recommendation). |
| As-issued PDFs (Q16) | founder / legal | Not stored; reprints regenerate from frozen inputs (ADR-0033). |

## Global Constraints

Copied from Plans 1A–1D (still binding):

- Node.js 22+; npm only (commit `package-lock.json` when it changes).
- TypeScript strict; no `any`; no `@ts-ignore`.
- Every business table has `tenant_id UUID NOT NULL`; RLS is enabled **and forced** on all of them (new tables included).
- `tenant_id`, `user_id`, and `role` come from the session (`requireSession()` / `getSessionContext()`), never from request input or form fields.
- Feature code reaches tenant data only through `withTenant()`. `adminDb` is for auth, sign-up, seed, scripts, and tests. The one session-less query path stays `withShareToken()`.
- Finalized prescriptions are never overwritten; amendments create a new version with a reason (AGENTS.md invariant 3).
- Creating, amending, finalizing, printing, downloading, sharing, **uploading, rejecting, publishing, assigning, archiving and restoring a template, and previewing a template with a real patient** write an append-only audit event (invariant 2). Audit payloads carry ids, counts, hashes, codes, and field **names** — never file names, template names, patient names, or clinical text.
- Dates: store UTC; render in the clinic timezone (default `Asia/Kolkata`).
- IDs are UUIDv7 (`newId()` / schema `$defaultFn`).
- Every service returns `Result<T>` (`src/lib/result.ts`); no thrown strings.
- Use existing shadcn/ui primitives (`src/components/ui/*`) and native form elements; no new UI kit.
- All user free text is validated through `cleanInput` / `cleanOptionalText(max)` / `cleanRequiredText(max, message)` and `hasNoNul` + `NUL_MESSAGE` (`src/server/validation/text.ts`): a NUL is refused, never stripped.
- Migrations never run data backfill `UPDATE`s on `visits`, `prescriptions`, or `prescription_items`.
- **Lock order (ADR-0023):** lock the prescription row `FOR UPDATE` before touching its items or its visit; finalizing an amendment locks the child, then flips the parent. This plan adds no prescription lock and no template lock inside finalize.
- Client components fetch data through GET route handlers or receive it from server components; server actions are for mutations. Route handlers catch unexpected errors and answer a typed 500 with `Cache-Control: private, no-store`, logging the error class only (`error instanceof Error ? error.name : typeof error`).
- Keep components and modules under ~250 lines; domain logic lives in `src/lib/` or `src/server/`, not in components.
- Conventional commits; one logical change per commit; `git add` names explicit file paths (never a bare directory or `-A`).
- **Windows:** run every vitest and Playwright command from PowerShell with the working directory `E:\projects\clinicpad` (UPPERCASE drive letter); start **every** command with `Set-Location E:\projects\clinicpad;`. PowerShell 5.1 has no `&&`; chain with `; if ($?) { ... }`.
- Before every commit run `Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }` and keep the output.
- **Playwright:** `getByRole("alert")` also matches Next's route announcer; labels overlap, so use `{ exact: true }` and scoping; wait for the clinical editor with `waitForEditor(page)`. No new link on the Patients page or dashboard may contain the word "patients".
- Reviewers skip `drizzle/meta/*_snapshot.json` (generated).
- **Commit command:** `git commit -m "<subject>" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"`, where `<model>` is the model that actually wrote the commit (for example `Sonnet 5.5`).
- **Invisible or non-printing characters in tests** are written as `\uXXXX` escapes (or byte arrays), never pasted, and each such test asserts the code point it relies on. After writing such a file, check it with `Select-String -Path <file> -Pattern '[\u0000-\u0008\u200B-\u200F\u202A-\u202E\u2028\u2029\uFEFF]'` (no output expected).
- **Tests never require Gotenberg or ClamAV.** Code takes a `PdfEngine` / `MalwareScanner`; tests use `tests/helpers/fake-pdf-engine.ts` and `tests/helpers/fake-scanner.ts`. Real-service tests (`tests/integration/gotenberg-smoke.test.ts`, `tests/integration/clamav-smoke.test.ts`) check health first and skip cleanly unless `GOTENBERG_REQUIRED=1` / `CLAMAV_REQUIRED=1` or `CI=true`.
- Test files that use `Request`, `Response`, `FormData`, `File`, `Blob` bytes, `node:net`, or `fetch` against Node APIs start with `// @vitest-environment node`.
- **Every CHECK constraint is declared in the Drizzle schema too** (guard test); RLS policies, grants and triggers live in custom SQL migrations.

New in Plan 2A:

- **The renderer (`src/lib/rx-render/*`) stays pure:** no database, no `fs`, no `process.env`, no `node:crypto`, no `Date.now()` / argument-less `new Date()`. The same input gives byte-identical HTML. Overlay CSS is built only from numbers of a definition that `overlayDefinitionSchema` accepted, formatted by the renderer; a non-finite number throws. Field values reach HTML only through `userText()`.
- **Every rendered document — overlay, alignment check and preview included — passes `checkSelfContained()`** before it is served or sent to Gotenberg (ADR-0034). `self-contained.ts` is not changed by this plan.
- **A finalized prescription prints from its `render_snapshot` and, for an overlay, from the exact template version and file it names, verified by hash.** Never render a finalized prescription from a template's *current* version.
- **Uploads:** `POST` route handlers under `src/app/(app)/templates/` with a streamed byte cap (`readCapped`), session + permission, `crossSiteRefusal`, a per-user limit (30 per hour); type from bytes only; scan before store; metadata stripped; the file name is never read, stored or logged.
- **Migrations 0024 to 0027 are created in task order (Tasks 7 and 15). Tasks that create migrations never run in parallel with each other.** After each migration, `npx drizzle-kit generate` must answer "No schema changes".
- **New npm dependency: only `pdfjs-dist`**, installed with `--save-exact` at a 5.x release (≥ 4.2.67, the CVE-2024-4367 fix), loaded only inside the sandboxed frame, never imported by app code. Run `npm audit --omit=dev` before and after adding it and record both counts in the Task 16 commit message body. Spike folders (`spikes/`) are git-ignored and have their own `package.json`; nothing installed there reaches the app.
- **Container images are pinned by digest** in `docker-compose.yml`, `.github/workflows/ci.yml`, and the smoke tests; `tests/unit/engine-pins.test.ts` (Task 6, extended in Task 8) fails when the three copies differ.
- **Never commit the EICAR test string** (Windows Defender quarantines files that contain it): tests and spikes import `tests/helpers/eicar.ts`, which joins fragments at run time; neither the string nor its base64 may appear in any tracked file (grep before committing).

## Review Focus

The five input classes or failure modes most likely to hurt a real clinic that no happy-path test would catch. Each is pinned to a test in the owning task.

1. **Reprinting an old overlay prescription after the template changed:** the owner published v2, rolled back to v1 as v3, archived the template, reassigned the clinic default, or the doctor moved to another pad; a database row was tampered with outside the app. Expected: the reprint is byte-identical (same `html_sha256`) to the first print, and any hash mismatch refuses to print with a support message instead of printing something else. → Task 13 (`template-resolution.test.ts`), Task 14 (`overlay-output.test.ts`).
2. **A prescription signed by Dr B in a clinic whose pads carry Dr A's letterhead:** Dr A's bound template assigned to Dr A, a clinic default that is bound (refused), Dr B with no assignment, an owner without a doctor profile, a template archived between drafting and finalizing. Expected: Dr B's prescription never prints on Dr A's letterhead; it falls back to the clinic's dynamic default or the built-in pad; nothing fails silently. → Task 13 (`template-resolution.test.ts`), Task 15 (`template-services.test.ts`).
3. **Hostile or odd uploads:** an SVG, an executable renamed `.png`, a PNG with bytes after `IEND`, a truncated JPEG, a 1 × 10,000 strip, a square phone photo, US Letter proportions, a 3,700-px scan, a 0-byte body, a body bigger than the cap sent chunked without `Content-Length` or with a lying one, EICAR, the scanner down or hanging. Expected: refused with a message that says what to do, nothing stored, an audit event for refusals, the upload handler reads at most the 1 MB cap from the stream (readCapped cancels beyond it); /templates/uploads is excluded from the middleware matcher because Next buffers middleware request bodies up to 10 MB, so the handler checks the session itself before reading. → Task 8 (`clamd.test.ts`), Task 9 (`template-files.test.ts`, `template-upload-route.test.ts`, `image.test.ts`).
4. **Long, missing, and hostile values in fixed boxes:** a 120-character patient name in a 60 mm box, a 2,000-character word, a Devanagari name, `<script>` or U+202E in a name, an empty registration number, 30 medicines flowing to page 3 with the boxes and patient strip repeated, a draft with no signer. Expected: nothing executes or fetches, text overflows visibly instead of being cut, blanks print as nothing (never `undefined`), drafts never show a signature or Rx number. → Task 12 (`rx-overlay.test.ts`), Task 20 (`rx-visual.spec.ts` overlay cases).
5. **Concurrent template work:** a double-click on Publish, two tabs saving the same draft, an assignment racing an archive, two uploads that would each fit the 50 MB quota but not both, a publish while a doctor finalizes. Expected: exactly one publish, the second save gets a revision conflict, an archived template is never assigned, the quota is never exceeded, the finalize uses whichever published version was current when it read. → Task 9 (`template-files.test.ts` quota race), Task 15 (`template-services.test.ts`).

---

## File Structure

**Create**
- `docs/spikes/2026-11-18-s1-overlay-print.md`, `…-s2-pdfjs-frame.md`, `…-s4-clamav.md`, `…-s5-gotenberg-upgrade.md`, `…-s3-docxtemplater.md` — spike findings (Tasks 1–5). Throwaway spike code lives in `spikes/` (git-ignored).
- `tests/unit/engine-pins.test.ts` (Task 6).
- `src/server/db/schema/columns.ts` (`bytea`), `src/server/db/schema/templates.ts` (`templateFiles`, `templates`, `templateVersions`) (Task 7).
- `drizzle/0024_phase2a_template_cleanup.sql` (generated + guard), `drizzle/0025_phase2a_templates.sql` (generated, hand-edited), `drizzle/0026_phase2a_templates_security.sql` (custom) (Task 7); `drizzle/0027_phase2a_designer_role.sql` (generated, hand-edited) (Task 15); each with its `drizzle/meta/00NN_snapshot.json` and `_journal.json` entry.
- `tests/fixtures/overlay-definitions.ts` (`MINIMAL_OVERLAY_DEFINITION`, database-free), `tests/helpers/templates.ts` (Task 7, extended in Task 13), `tests/integration/template-schema.test.ts` (Task 7).
- `src/server/scanning/scanner.ts`, `src/server/scanning/clamd.ts`, `src/server/scanning/index.ts`, `src/server/scanning/uploads.ts`; `tests/helpers/fake-scanner.ts`, `tests/helpers/eicar.ts`; `tests/unit/{clamd,scanner-config}.test.ts`; `tests/integration/{clamav-smoke,upload-scanning}.test.ts` (Task 8).
- `src/server/http/read-capped.ts`, `src/server/http/upload-limits.ts`, `src/server/services/template-files.ts`, `src/app/(app)/templates/uploads/route.ts`, `src/app/(app)/templates/files/[fileId]/route.ts`; `tests/unit/read-capped.test.ts`, `tests/integration/{template-files,template-upload-route}.test.ts` (Task 9).
- `src/lib/rx-render/{common,marks,vitals,sections,medicines,builtin}.ts` (split of `render.ts`), `src/lib/rx-render/fields.ts`, `src/lib/rx-render/template-data.ts`, `src/lib/rx-render/samples.ts`; `tests/unit/{template-fields,template-samples}.test.ts` (Task 10).
- `src/lib/rx-render/overlay-definition.ts`, `src/lib/rx-render/canonical-json.ts`, `src/lib/templates/publish-rules.ts`; `tests/unit/{overlay-definition,publish-rules,canonical-json}.test.ts` (Task 11).
- `src/lib/rx-render/overlay-css.ts`, `src/lib/rx-render/overlay.ts`, `tests/fixtures/overlay-documents.ts`; `tests/unit/rx-overlay.test.ts`, golden files `tests/unit/__golden__/overlay-*.html` (Task 12).
- `src/server/templates/content-hash.ts`, `src/server/services/template-resolution.ts`; `tests/helpers/rx-flow.ts`; `tests/unit/snapshot-v2.test.ts`, `tests/integration/template-resolution.test.ts` (Task 13).
- `tests/integration/overlay-output.test.ts` (Task 14).
- `drizzle/0027_…` (above); `src/server/services/template-access.ts`, `src/server/services/templates.ts`, `src/server/services/template-publish.ts`, `src/server/services/template-assign.ts`, `src/server/validation/templates.ts`, `src/server/actions/templates.ts`; `tests/integration/{template-services,designer-role}.test.ts` (Task 15).
- `src/server/templates/pdf-frame-assets.ts`, `src/app/pdf-frame/[asset]/route.ts`, `src/lib/templates/{image-geometry,auto-layout,pdf-intake,pdf-frame-client,canvas}.ts`, `src/app/(app)/templates/page.tsx`, `src/app/(app)/templates/new/page.tsx`, `src/components/templates/{template-list,template-row-actions,new-template-wizard,source-step,file-step,fit-step}.tsx`; `tests/unit/{image-geometry,auto-layout,pdf-frame-route}.test.ts`, `tests/unit/new-template-wizard.test.tsx`, `tests/helpers/pdfs.ts` (Task 16).
- `src/lib/templates/editor-state.ts`, `src/app/(app)/templates/[id]/page.tsx`, `src/components/templates/{template-editor,box-canvas,box-inspector,flow-inspector}.tsx`, `src/components/templates/use-overflow-warnings.ts`; `tests/unit/editor-state.test.ts`, `tests/unit/template-editor.test.tsx` (Task 17).
- `src/server/services/template-preview.ts`, `src/app/(app)/templates/[id]/preview/route.ts`, `src/components/templates/{preview-panel,publish-panel,assign-panel,version-history}.tsx`; `tests/integration/template-preview-route.test.ts`, `tests/unit/{publish-panel,assign-panel}.test.tsx` (Task 18).
- `src/lib/rx-render/overlay-alignment.ts`, `src/app/(app)/templates/[id]/alignment/route.ts`, `src/components/templates/print-inspector.tsx`, `src/lib/templates/print-support.ts`; `tests/unit/{overlay-alignment,print-support}.test.ts` (Task 19).
- `tests/integration/template-cross-tenant.test.ts`, `tests/e2e/templates.spec.ts` (Task 20).

**Modify**
- `.gitignore`, `tsconfig.json`, `eslint.config.mjs` — `spikes/` ignored (Task 1).
- `docker-compose.yml`, `.github/workflows/ci.yml`, `tests/integration/gotenberg-smoke.test.ts`, `docs/SETUP.md` — Gotenberg pin (Task 6); ClamAV service (Task 8).
- `src/server/db/schema/{clinical,tenancy,index}.ts` (Task 7); `src/server/db/schema/{enums,tenancy}.ts` (Task 15).
- `tests/integration/{tenant-fk,clinical-references,rls-guard}.test.ts` (Task 7).
- `src/server/services/pad-settings.ts`, `tests/integration/{pad-settings,settings-actions}.test.ts`, `.env.example` (Task 8).
- `src/lib/domain/image.ts`, `src/lib/domain/permissions.ts` + `tests/unit/permissions.test.ts` (owner/doctor rows), `src/server/pdf/gotenberg.ts`, `src/middleware.ts`, `next.config.ts`, `tests/unit/image.test.ts` (Task 9).
- `src/lib/rx-render/{render,labels}.ts` (Task 10 split, `pickLabel`); `src/lib/rx-render/{types,labels}.ts` (Task 12); `src/lib/rx-render/{snapshot,types,render}.ts`, `src/server/services/{render-snapshot,prescriptions,rx-mapping,rx-output,share-open}.ts`, `tests/fixtures/{rx-documents,overlay-documents}.ts`, `tests/unit/rx-column-rules.test.ts`, `tests/integration/render-snapshot.test.ts` (Task 13).
- `src/server/services/{rx-documents,rx-output,share-open}.ts`, `src/app/(app)/prescriptions/[id]/pdf/route.ts`, `tests/integration/rx-output-routes.test.ts` (Task 14).
- `src/lib/domain/permissions.ts` + `tests/unit/permissions.test.ts` (designer), `src/server/auth/credentials.ts`, `src/components/app-shell/sidebar.tsx`, `tests/unit/sidebar.test.tsx`, `src/app/(app)/dashboard/page.tsx`, `tests/e2e/helpers.ts` (Task 15).
- `scripts/build-desktop.mjs`, `package.json`, `package-lock.json` (Task 16).
- `src/lib/rx-render/samples.ts` (`SAMPLE_LETTERHEAD`) (Task 17).
- `src/server/services/template-preview.ts`, `src/components/templates/template-editor.tsx`, `src/components/rx/output-actions.tsx`, `src/components/rx/rx-output-panel.tsx`, `src/app/(app)/prescriptions/[id]/page.tsx`, `src/server/services/patient-history.ts`, `src/components/patients/prescription-history.tsx`, `tests/unit/{output-actions,prescription-page,prescription-history}.test.tsx` (Task 19).
- `tests/e2e/{rx-visual.spec.ts,rx-output.spec.ts,helpers.ts}`, `tests/helpers/images.ts`, `docs/DECISIONS.md`, `docs/PROGRESS.md`, `docs/SETUP.md`, `AGENTS.md` (Task 20).

## Task order, parallelism, and reviewers

```
T1 ∥ T2 ∥ T3 ∥ T4  (∥ T5, any time, gates nothing in 2A)
      → T6 (only if S5 = GO)
      → T7 → T8 → T9
      → T10 (may run in parallel with T7–T9: disjoint files)
      → T11 → T12                  (after T7 and T10: they import tests/fixtures/overlay-definitions.ts and the split modules)
      → T13 (needs T7, T11, T12) → T14 → T15 (creates 0027)
      → T16 (needs T9, T15, S2) → T17 → T18 → T19 (needs S1) → T20
```

- **Migrations:** Task 7 creates 0024–0026; Task 15 creates 0027. Never run Tasks 7 and 15 in parallel, and never run either in parallel with another task that runs `drizzle-kit`.
- **Shared files** (must be sequential, in this order): `src/lib/rx-render/render.ts` (T10 split → T13 overlay dispatch); `src/lib/rx-render/types.ts` (T12 → T13); `src/lib/rx-render/labels.ts` (T10 → T12); `src/lib/rx-render/samples.ts` (T10 → T17); `src/server/services/rx-output.ts` and `share-open.ts` (T13 interim line → T14); `src/server/services/rx-documents.ts` (T14 only); `src/lib/domain/permissions.ts` and `tests/unit/permissions.test.ts` (T9 → T15); `docker-compose.yml` and `.github/workflows/ci.yml` (T6 → T8); `tests/unit/engine-pins.test.ts` (T6 → T8); `next.config.ts` (T9 → T16); `tests/helpers/templates.ts` (T7 → T13); `tests/fixtures/rx-documents.ts` (T13 only; T12 adds its own overlay fixture file); `tests/fixtures/overlay-documents.ts` (T12 → T13); `src/server/services/template-preview.ts` and `src/components/templates/template-editor.tsx` (T17/T18 → T19); `src/app/(app)/templates/[id]/page.tsx` (T17 → T18); `tests/e2e/helpers.ts` (T15 → T20).
- **Gates:** T6 starts only after the S5 finding says GO; T8 only after S4 says GO (or GO-with-fallback); T12's mechanism is confirmed by S1 (a NO-GO stops the plan and returns it to the planner); T16's PDF path is enabled per S2.

| Task | Title | Size | Reviewer |
|---|---|---|---|
| 1 | Spike S1 — overlay print mechanics | M | sonnet |
| 2 | Spike S2 — pdf.js in an opaque-origin sandboxed iframe | M | opus (security of the frame) |
| 3 | Spike S4 — ClamAV footprint and protocol | S | sonnet |
| 4 | Spike S5 — Gotenberg 8.11 → latest 8.x | S | sonnet |
| 5 | Spike S3 — docxtemplater readiness for 2B (non-gating) | S | sonnet |
| 6 | Gotenberg upgrade and engine pins | M | opus |
| 7 | Template schema, migrations 0024–0026, database guarantees | L | opus |
| 8 | Malware scanner: interface, clamd adapter, fake, container, logo/signature retrofit | L | opus |
| 9 | Upload pipeline: background limits, quotas, GC, upload and file routes | L | opus |
| 10 | Split `render.ts` (goldens unchanged); field catalogue, template data, samples (pure) | M | opus (renderer refactor) |
| 11 | Overlay definition schema, publish rules, canonical JSON (pure) | M | opus (the schema is a security boundary) |
| 12 | Overlay renderer and goldens (pure) | L | opus |
| 13 | Snapshot v2, resolution at finalize, frozen template versions | L | opus |
| 14 | Render dispatch and output plumbing (loader, outputs, share, print-PDF) | M | opus |
| 15 | Roles (`template.*`, designer, 0027) and template services/actions | L | opus |
| 16 | Template Studio UI 1: list, wizard, sandboxed PDF frame, crop, auto-layout | L | sonnet (opus for the frame route) |
| 17 | Template Studio UI 2: box editor, keyboard, fonts, overflow warnings | L | sonnet |
| 18 | Previews (sample, long, blank, real patient), publish, assign, history | M | opus (real-patient preview) |
| 19 | Print modes: pre-printed paper, alignment check, offset, per-browser print | M | sonnet |
| 20 | Cross-tenant sweep, visuals, e2e, desktop, ADRs, docs, Gate 2A | M | opus (final whole-branch review) |

---

## Spikes (Tasks 1–5): how they work

Spikes answer questions; they do not ship code. Each spike:
- writes throwaway code only under `spikes/<name>/` (git-ignored by Task 1; its own `package.json`, so nothing reaches the app's lockfile);
- writes exactly one committed file, its **finding**, `docs/spikes/2026-11-18-<id>-<topic>.md`, with these sections in this order: `Question`, `Environment` (exact versions, image digests, browser versions), `Method` (what was automated, what a human did), `Results` (tables with the numbers), `Human checks` (filled or marked PENDING with who must do them), `Decision` (one of **GO**, **GO-WITH-FALLBACK**, **NO-GO**, plus the exact values later tasks copy), `Consequences for tasks`;
- ends with a commit of the finding only (`docs:` commit).

A **NO-GO** stops the tasks it gates; the controller returns the plan to the planner with the finding. **PENDING** human checks never block automated tasks: the plan's safe defaults stay in force until a human fills them in (decision 16).

## Task 1: Spike S1 — overlay print mechanics (Chromium, Gotenberg, Firefox, WebKit; PDF size; footer strip; page numbers)

**Files:**
- Modify: `.gitignore`, `tsconfig.json`, `eslint.config.mjs` (ignore `spikes/`)
- Create (throwaway, ignored): `spikes/s1-overlay-print/{png.mjs,variants.mjs,analyze.mjs,probe.mjs}`
- Create (committed): `docs/spikes/2026-11-18-s1-overlay-print.md`

**Interfaces:**
- Consumes: Playwright (`@playwright/test` in the root `node_modules`, resolved from `spikes/` by Node's parent-directory lookup); a running Gotenberg (`docker compose up -d gotenberg`, `http://localhost:3001`).
- Produces (in the finding, consumed by Tasks 12 and 19): GO/NO-GO for the fixed-position mechanism; the measured PDF size growth per page with a repeated background; whether Chromium `@page` margin boxes print "Page x of y" in Playwright Chromium and in Gotenberg; whether a background strip in Gotenberg's footer template works; the Firefox/Safari human-check results that set `OVERLAY_BROWSER_PRINT` (Task 19).

- [ ] **Step 1: Ignore spike folders everywhere**

Append to `.gitignore`:

```
# Throwaway spike code (Plan 2A); only findings in docs/spikes/ are committed
/spikes/
```

In `tsconfig.json`, change `"exclude": ["node_modules"]` to:

```json
  "exclude": [
    "node_modules",
    "spikes"
  ]
```

In `eslint.config.mjs`, add `"spikes/**",` to the `ignores` array right after `"next-env.d.ts",`.

Run: `Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }`
Expected: both pass (nothing else changed).

- [ ] **Step 2: Write the background generator**

`spikes/s1-overlay-print/png.mjs`:

```js
import { deflateSync } from "node:zlib";

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A letterhead-like RGB PNG: blue header band (0-40 mm), green footer band (last 15 mm), a 10 mm grey grid. */
export function letterheadPng(width, height, paperHeightMm) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pxPerMm = height / paperHeightMm;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    const mm = y / pxPerMm;
    const band = mm < 40 ? [30, 64, 175] : mm > paperHeightMm - 15 ? [15, 118, 110] : null;
    for (let x = 0; x < width; x += 1) {
      const grid = Math.floor(x / pxPerMm) % 10 === 0 || Math.floor(mm) % 10 === 0;
      const rgb = band ?? (grid ? [220, 220, 220] : [255, 255, 255]);
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
```

- [ ] **Step 3: Write the page variants (the mechanism Task 12 will generate)**

`spikes/s1-overlay-print/variants.mjs`:

```js
export const PAPERS = { A4: { w: 210, h: 297, px: [1654, 2339] }, A5: { w: 148, h: 210, px: [1165, 1654] } };

/** One overlay page exactly as Plan 2A Task 12 will build it, with marker strings the analyzer looks for. */
export function overlayHtml({ paper, bgBase64, rows, band = 0, marginBoxes = false }) {
  const { w, h } = PAPERS[paper];
  const pageBox = marginBoxes
    ? `@page{size:${paper} portrait;margin:0 0 8mm 0;@bottom-center{content:"Page " counter(page) " of " counter(pages);font-size:8pt}}`
    : `@page{size:${paper} portrait;margin:0 0 ${band}mm 0}`;
  const css = [
    pageBox,
    "html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-family:sans-serif;font-size:10pt}",
    `.bg{position:fixed;left:0;top:0;width:${w}mm;height:${h - (marginBoxes ? 8 : band)}mm;z-index:0;overflow:hidden}`,
    ".bg img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}",
    ".box{position:fixed;z-index:1;left:20mm;top:45mm;width:60mm;height:7mm;font-weight:700}",
    `.box-first{position:absolute;z-index:1;left:${w - 70}mm;top:45mm;width:60mm;height:7mm}`,
    ".wm{position:fixed;top:45%;left:0;right:0;text-align:center;transform:rotate(-30deg);font-size:28pt;color:rgba(185,28,28,.14);z-index:2}",
    ".flow{position:relative;z-index:1;width:100%;border-collapse:collapse}",
    ".flow>thead{display:table-header-group}.flow>tfoot{display:table-footer-group}",
    ".flow>thead>tr>td,.flow>tfoot>tr>td{padding:0}.top{height:60mm}.bottom{height:25mm}.body{padding:0 15mm;vertical-align:top}",
    ".meds{width:100%;border-collapse:collapse}.meds>thead{display:table-header-group}",
    ".meds th,.meds td{border:1px solid #333;padding:1mm}.meds tr{break-inside:avoid}",
  ].join("\n");
  const body = Array.from({ length: rows }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return `<tr><td>ROW-${n} Paracetamol 650 mg</td><td>1-0-1</td><td>5 days</td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="bg"><img src="data:image/png;base64,${bgBase64}" alt=""></div>
<div class="wm">WATERMARK</div>
<div class="box">EVERYPAGE-MARK</div>
<div class="box-first">FIRSTPAGE-MARK</div>
<table class="flow"><thead><tr><td><div class="top"></div></td></tr></thead>
<tfoot><tr><td><div class="bottom"></div></td></tr></tfoot>
<tbody><tr><td class="body"><table class="meds"><thead><tr><th>MEDHEAD</th><th>Dose</th><th>Days</th></tr></thead><tbody>${body}</tbody></table>
<p>END-OF-CONTENT</p></td></tr></tbody></table></body></html>`;
}

/** Gotenberg footer with the bottom strip of the background drawn inside it (the "footer strip" idea). */
export function footerWithStrip(stripBase64) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%}img{display:block;width:100%;height:8mm}</style></head><body><img src="data:image/png;base64,${stripBase64}"></body></html>`;
}
```

- [ ] **Step 4: Write the PDF analyzer**

`spikes/s1-overlay-print/analyze.mjs`:

```js
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const MM = 25.4 / 72;

/** Per page: which markers print, where the medicine rows sit (mm from the top), how many images are painted. */
export async function analyzePdf(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const heightPt = page.view[3];
    const items = (await page.getTextContent()).items.filter((i) => "str" in i);
    const all = items.map((i) => i.str).join(" ");
    const rowTops = items.filter((i) => /^ROW-\d+/.test(i.str)).map((i) => (heightPt - i.transform[5]) * MM);
    const ops = await page.getOperatorList();
    pages.push({
      page: n,
      every: all.includes("EVERYPAGE-MARK"),
      first: all.includes("FIRSTPAGE-MARK"),
      watermark: all.includes("WATERMARK"),
      medHead: all.includes("MEDHEAD"),
      rows: rowTops.length,
      firstRowMm: rowTops.length ? Math.round(Math.min(...rowTops)) : null,
      lastRowMm: rowTops.length ? Math.round(Math.max(...rowTops)) : null,
      images: ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length,
      pageLabel: /Page \d+ of \d+/.exec(all)?.[0] ?? null,
    });
  }
  return { pageCount: doc.numPages, byteSize: bytes.byteLength, pages };
}
```

- [ ] **Step 5: Write the probe**

`spikes/s1-overlay-print/probe.mjs`:

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";
import { letterheadPng } from "./png.mjs";
import { footerWithStrip, overlayHtml, PAPERS } from "./variants.mjs";
import { analyzePdf } from "./analyze.mjs";

const OUT = new URL("./out/", import.meta.url);
mkdirSync(new URL("html/", OUT), { recursive: true });
const GOTENBERG = process.env.GOTENBERG_URL ?? "http://localhost:3001";
const EMPTY = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
const inches = (mm) => (mm / 25.4).toFixed(3);

async function gotenberg(html, paper, bandMm, footer = EMPTY) {
  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");
  form.append("files", new Blob([EMPTY], { type: "text/html" }), "header.html");
  form.append("files", new Blob([footer], { type: "text/html" }), "footer.html");
  form.append("paperWidth", inches(PAPERS[paper].w));
  form.append("paperHeight", inches(PAPERS[paper].h));
  for (const side of ["marginTop", "marginLeft", "marginRight"]) form.append(side, "0");
  form.append("marginBottom", inches(bandMm));
  form.append("preferCssPageSize", "true");
  form.append("printBackground", "true");
  form.append("emulatedMediaType", "print");
  const response = await fetch(`${GOTENBERG}/forms/chromium/convert/html`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`gotenberg ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const summary = { chromium: {}, gotenberg: {}, firefox: {}, webkit: {} };
const browser = await chromium.launch();
summary.chromiumVersion = browser.version();
for (const paper of ["A4", "A5"]) {
  const [pw, ph] = PAPERS[paper].px;
  const bg = letterheadPng(pw, ph, PAPERS[paper].h).toString("base64");
  const strip = letterheadPng(pw, 100, 8).toString("base64");
  for (const [name, options] of [
    ["one-page", { rows: 3 }],
    ["three-pages", { rows: 60 }],
    ["band-8mm", { rows: 60, band: 8 }],
    ["margin-boxes", { rows: 60, marginBoxes: true }],
  ]) {
    const key = `${paper}-${name}`;
    const html = overlayHtml({ paper, bgBase64: bg, ...options });
    writeFileSync(new URL(`html/${key}.html`, OUT), html);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const chromePdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    await page.close();
    writeFileSync(new URL(`${key}-chromium.pdf`, OUT), chromePdf);
    summary.chromium[key] = await analyzePdf(chromePdf);
    const band = options.marginBoxes ? 8 : (options.band ?? 0);
    const gPdf = await gotenberg(html, paper, band);
    writeFileSync(new URL(`${key}-gotenberg.pdf`, OUT), gPdf);
    summary.gotenberg[key] = await analyzePdf(gPdf);
    if (name === "band-8mm") {
      const stripped = await gotenberg(html, paper, 8, footerWithStrip(strip));
      writeFileSync(new URL(`${key}-gotenberg-footer-strip.pdf`, OUT), stripped);
      summary.gotenberg[`${key}-footer-strip`] = await analyzePdf(stripped);
    }
  }
}
await browser.close();

// Firefox and WebKit cannot print to PDF from Playwright: measure first-page geometry under print media only.
for (const [name, type] of [["firefox", firefox], ["webkit", webkit]]) {
  try {
    const other = await type.launch();
    summary[`${name}Version`] = other.version();
    const page = await other.newPage();
    const html = overlayHtml({ paper: "A4", bgBase64: letterheadPng(1654, 2339, 297).toString("base64"), rows: 60 });
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    const rect = await page.evaluate(() => {
      const r = document.querySelector(".box").getBoundingClientRect();
      const first = document.querySelector(".box-first").getBoundingClientRect();
      return { x: r.x, y: r.y, firstX: first.x };
    });
    const pxPerMm = 96 / 25.4;
    summary[name] = { boxLeftMm: +(rect.x / pxPerMm).toFixed(1), boxTopMm: +(rect.y / pxPerMm).toFixed(1), firstLeftMm: +(rect.firstX / pxPerMm).toFixed(1) };
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-a4-print-media.png`, OUT)), fullPage: true });
    await other.close();
  } catch (error) {
    summary[name] = { error: String(error?.message ?? error).slice(0, 300) };
  }
}
writeFileSync(new URL("summary.json", OUT), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
```

- [ ] **Step 6: Install the spike's own dependency and the extra browsers, then run it**

```powershell
Set-Location E:\projects\clinicpad; New-Item -ItemType Directory -Force spikes\s1-overlay-print | Out-Null
Set-Location E:\projects\clinicpad\spikes\s1-overlay-print; npm init -y | Out-Null; npm install --save-exact pdfjs-dist@5
Set-Location E:\projects\clinicpad; npx playwright install firefox webkit
Set-Location E:\projects\clinicpad; docker compose up -d gotenberg
Set-Location E:\projects\clinicpad\spikes\s1-overlay-print; node probe.mjs
```

Expected: `out/summary.json` and 16 PDFs plus 2 PNG screenshots under `spikes/s1-overlay-print/out/`. If `npx playwright install firefox webkit` fails (no network, unsupported OS), record that in the finding and skip those two rows; the plan's default (decision 16) does not depend on them.

- [ ] **Step 7: Human checks (record PENDING if nobody can do them now)**

Open each `spikes/s1-overlay-print/out/html/A4-three-pages.html` and `A5-three-pages.html` in **Firefox** (Windows) and in **Safari** (macOS, and iOS Safari if available) → Print → print preview, scale 100 %, headers and footers off, "print backgrounds" on. For each page note: background visible (Y/N), `EVERYPAGE-MARK` visible (Y/N), `FIRSTPAGE-MARK` only on page 1 (Y/N), `MEDHEAD` repeated (Y/N), any row cut in half (Y/N), rows overlapping the top 60 mm or the bottom 25 mm (Y/N). Also open two of the Gotenberg PDFs in Adobe Reader or a phone PDF viewer and confirm they look like the Chromium ones.

- [ ] **Step 8: Write the finding**

`docs/spikes/2026-11-18-s1-overlay-print.md` with the standard sections. `Results` must contain, for Chromium and Gotenberg, a table per variant: pages, `every` on every page, `first` only on page 1, `watermark` on every page, `medHead` on every page with rows, smallest `firstRowMm` across pages (must be ≥ 60) and largest `lastRowMm` (must be ≤ paper height − 25), images painted per page, PDF bytes for `one-page` vs `three-pages` (growth per extra page), `pageLabel` for `margin-boxes`, and whether the footer-strip PDF paints one more image per page. `Decision` rules:

- **GO** for Task 12's mechanism when, in BOTH Chromium and Gotenberg, the background and `EVERYPAGE-MARK` print on every page, `FIRSTPAGE-MARK` only on page 1, `MEDHEAD` repeats, and no row prints inside the top or bottom spacer.
- **NO-GO** when Gotenberg fails any of those: stop; the planner must redesign Task 12 (candidate: boxes inside the repeated `thead` cell).
- Record `PDF growth per page` (KB). If it exceeds 150 KB per page, add to `Consequences`: "Task 12 keeps the background JPEG at the client's 600 KB target; Task 16 warns above 600 KB".
- Record `margin boxes`: "Chromium prints Page x of y: yes/no (Playwright Chromium <version>, Gotenberg Chromium <version>)". Task 12 uses Gotenberg's footer template for page numbers either way; margin boxes are a follow-up for browser print only.
- Record `OVERLAY_BROWSER_PRINT`: `chromium: true` when Playwright Chromium passed; `firefox` and `webkit` are `true` only when the human check in Step 7 passed on every page, otherwise `false` (Task 19 copies these three booleans).

- [ ] **Step 9: Commit**

```powershell
Set-Location E:\projects\clinicpad; git add .gitignore tsconfig.json eslint.config.mjs docs/spikes/2026-11-18-s1-overlay-print.md; git commit -m "docs(spike): S1 overlay print mechanics finding" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 2: Spike S2 — pdf.js page rasterization inside an opaque-origin sandboxed iframe

**Files:**
- Create (throwaway, ignored): `spikes/s2-pdfjs-frame/{make-pdf.mjs,frame.mjs,server.mjs,probe.mjs}`
- Create (committed): `docs/spikes/2026-11-18-s2-pdfjs-frame.md`

**Interfaces:**
- Consumes: Playwright Chromium, Firefox, WebKit (installed in Task 1 Step 6); `pdfjs-dist@5` installed in the spike folder.
- Produces (in the finding, consumed by Task 16): the exact pdfjs-dist version to pin; which worker strategy works per engine (blob module worker, blob classic worker, or in-frame fake worker); whether CSP `'self'` in a sandboxed document matches the server origin per engine (else Task 16 writes the explicit origin, which is its default); isolation results; time and size per dpi; GO / GO-WITH-FALLBACK / NO-GO for PDF intake.

- [ ] **Step 1: Write the fixture PDF builder (Task 16 copies it into `tests/helpers/pdfs.ts`)**

`spikes/s2-pdfjs-frame/make-pdf.mjs`:

```js
/** A valid one-page PDF (correct xref offsets) with a blue header band, a line, and Helvetica text. */
export function minimalPdf(widthPt, heightPt, label) {
  const content = [
    "0.12 0.25 0.69 rg",
    `0 ${heightPt - 113} ${widthPt} 113 re f`,
    `BT /F1 24 Tf 40 ${heightPt - 70} Td (${label}) Tj ET`,
    `0 0 0 RG 40 ${heightPt - 200} m ${widthPt - 40} ${heightPt - 200} l S`,
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.7\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
```

- [ ] **Step 2: Write the frame script (the same protocol Task 16 ships)**

`spikes/s2-pdfjs-frame/frame.mjs`:

```js
import * as pdfjs from "./pdf.mjs";

const MAX_SIDE = 3600;
const MAX_PAGES = 50;
let workerMode = "none";

async function attachWorker() {
  const source = await (await fetch(new URL("./pdf.worker.mjs", import.meta.url))).text();
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url, { type: "module" });
    workerMode = "blob-module";
  } catch {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.mjs", import.meta.url).href;
    workerMode = "fake-worker";
  }
}

async function isolation() {
  const out = {};
  try { void window.parent.document.title; out.parentDocument = "READABLE"; } catch { out.parentDocument = "blocked"; }
  try { void document.cookie; out.cookie = "READABLE"; } catch { out.cookie = "blocked"; }
  try { void window.localStorage; out.localStorage = "READABLE"; } catch { out.localStorage = "blocked"; }
  try { const r = await fetch("/secret", { credentials: "include" }); out.secretFetch = `status ${r.status}`; } catch { out.secretFetch = "blocked"; }
  out.origin = String(self.origin);
  return out;
}

async function render(bytes, pageNumber, dpi) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, disableRange: true, disableStream: true, disableAutoFetch: true }).promise;
  try {
    if (doc.numPages > MAX_PAGES) return { type: "error", code: "too_many_pages" };
    const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(dpi / 72, MAX_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const out = await blob.arrayBuffer();
    return { type: "image", bytes: out, width: canvas.width, height: canvas.height, pageCount: doc.numPages, pageSizePt: [base.width, base.height], workerMode };
  } finally {
    await doc.destroy();
  }
}

window.addEventListener("message", async (event) => {
  if (event.source !== window.parent) return;
  const m = event.data;
  if (!m || m.type !== "render" || !(m.bytes instanceof ArrayBuffer)) return;
  let reply;
  try {
    reply = await render(m.bytes, Number(m.page) || 1, Number(m.dpi) || 200);
  } catch (error) {
    reply = { type: "error", code: error?.name === "PasswordException" ? "encrypted" : "unreadable" };
  }
  window.parent.postMessage(reply, "*", reply.bytes ? [reply.bytes] : []);
});

await attachWorker();
window.parent.postMessage({ type: "ready", isolation: await isolation(), workerMode }, "*");
```

- [ ] **Step 3: Write the server and the parent page**

`spikes/s2-pdfjs-frame/server.mjs`:

```js
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { minimalPdf } from "./make-pdf.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PORT = 4310;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const pdfjsBuild = (name) => readFileSync(here(`./node_modules/pdfjs-dist/build/${name}`));
const log = { secretCookie: [] };

const PARENT = `<!doctype html><meta charset="utf-8"><title>S2</title><body><script type="module">
document.cookie = "s2session=secret; SameSite=Lax; path=/";
const frame = document.createElement("iframe");
frame.setAttribute("sandbox", "allow-scripts");
frame.src = "/frame/frame.html" + location.search;
document.body.append(frame);
const next = (types) => new Promise((resolve) => {
  const on = (e) => { if (e.source === frame.contentWindow && types.includes(e.data?.type)) { removeEventListener("message", on); resolve(e.data); } };
  addEventListener("message", on);
});
const ready = await next(["ready"]);
const results = { isolation: ready.isolation, workerMode: ready.workerMode, renders: [] };
for (const [fixture, dpi] of [["a4", 150], ["a4", 200], ["a4", 300], ["a5", 200]]) {
  const bytes = await (await fetch("/fixtures/" + fixture + ".pdf")).arrayBuffer();
  const t0 = performance.now();
  const wait = next(["image", "error"]);
  frame.contentWindow.postMessage({ type: "render", bytes, page: 1, dpi }, "*", [bytes]);
  const reply = await wait;
  const ms = Math.round(performance.now() - t0);
  if (reply.type === "error") { results.renders.push({ fixture, dpi, ms, error: reply.code }); continue; }
  const bitmap = await createImageBitmap(new Blob([reply.bytes], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const jpeg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.8));
  results.renders.push({ fixture, dpi, ms, width: reply.width, height: reply.height, pageSizePt: reply.pageSizePt, pngBytes: reply.bytes.byteLength, jpegBytes: jpeg.size, workerMode: reply.workerMode });
}
window.results = results;
</script>`;

function frameCsp(mode) {
  const self = mode === "self" ? "'self'" : `${ORIGIN}/frame/`;
  return `sandbox allow-scripts; default-src 'none'; script-src ${self}; worker-src blob:; connect-src ${self}; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
}

createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const js = { "Content-Type": "text/javascript; charset=utf-8", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
  if (url.pathname === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end(PARENT);
  if (url.pathname === "/frame/frame.html") {
    return res
      .writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": frameCsp(url.searchParams.get("csp")) })
      .end('<!doctype html><meta charset="utf-8"><script type="module" src="/frame/frame.mjs"></script>');
  }
  if (url.pathname === "/frame/frame.mjs") return res.writeHead(200, js).end(readFileSync(here("./frame.mjs")));
  if (url.pathname === "/frame/pdf.mjs") return res.writeHead(200, js).end(pdfjsBuild("pdf.min.mjs"));
  if (url.pathname === "/frame/pdf.worker.mjs") return res.writeHead(200, js).end(pdfjsBuild("pdf.worker.min.mjs"));
  if (url.pathname === "/fixtures/a4.pdf") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(minimalPdf(595, 842, "S2 A4 LETTERHEAD"));
  if (url.pathname === "/fixtures/a5.pdf") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(minimalPdf(420, 595, "S2 A5 LETTERHEAD"));
  if (url.pathname === "/secret") {
    log.secretCookie.push(req.headers.cookie ? "cookie" : "none");
    return res.writeHead(200, { "Content-Type": "text/plain" }).end("secret");
  }
  if (url.pathname === "/log") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(log));
  res.writeHead(404).end();
}).listen(PORT, "127.0.0.1", () => console.log(`S2 server on ${ORIGIN}`));
```

- [ ] **Step 4: Write the probe**

`spikes/s2-pdfjs-frame/probe.mjs`:

```js
import { writeFileSync } from "node:fs";
import { chromium, firefox, webkit } from "@playwright/test";

const out = {};
for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  for (const csp of ["explicit", "self"]) {
    const key = `${name}-${csp}`;
    try {
      const browser = await type.launch();
      const page = await browser.newPage();
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
      await page.goto(`http://127.0.0.1:4310/?csp=${csp}`);
      await page.waitForFunction(() => window.results, null, { timeout: 30_000 });
      out[key] = { version: browser.version(), ...(await page.evaluate(() => window.results)), consoleErrors: errors };
      await browser.close();
    } catch (error) {
      out[key] = { error: String(error?.message ?? error).slice(0, 300) };
    }
  }
}
out.serverLog = await (await fetch("http://127.0.0.1:4310/log")).json();
writeFileSync(new URL("./summary.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
```

- [ ] **Step 5: Run it**

```powershell
Set-Location E:\projects\clinicpad; New-Item -ItemType Directory -Force spikes\s2-pdfjs-frame | Out-Null
Set-Location E:\projects\clinicpad\spikes\s2-pdfjs-frame; npm init -y | Out-Null; npm install --save-exact pdfjs-dist@5
Set-Location E:\projects\clinicpad\spikes\s2-pdfjs-frame; Start-Process node -ArgumentList server.mjs -PassThru | Select-Object -ExpandProperty Id | Set-Content server.pid
Set-Location E:\projects\clinicpad\spikes\s2-pdfjs-frame; node probe.mjs
Set-Location E:\projects\clinicpad\spikes\s2-pdfjs-frame; Stop-Process -Id (Get-Content server.pid)
```

Expected: `summary.json` with six keys. Record the pdfjs-dist version from `spikes/s2-pdfjs-frame/package.json`.

- [ ] **Step 6: Write the finding**

`docs/spikes/2026-11-18-s2-pdfjs-frame.md`. `Results` per engine and CSP mode: renders succeeded (count of 4), worker mode, isolation (`parentDocument`, `cookie`, `localStorage` must be `blocked`; `secretFetch` must be `blocked`, and `serverLog.secretCookie` must never contain `cookie`), `origin` (must be `null`), timing per dpi, PNG and JPEG sizes per dpi, page size points (A4 ≈ 595 × 842, A5 ≈ 420 × 595). `Decision`:

- **GO** when all three engines render all four fixtures in the `explicit` mode with every isolation probe `blocked`. Record: `PDFJS_VERSION=<exact>`, `WORKER=blob-module` (or whatever every engine used), `CSP_SELF_WORKS=<yes|no per engine>`, `DPI=200` unless 200 dpi took more than 5 s on any engine (then 150).
- **GO-WITH-FALLBACK** when Chromium passes but Firefox or WebKit does not: Task 16 keeps PDF intake (the wizard falls back to "export page 1 as an image" automatically when the frame reports an error or times out). Name the failing engine and error.
- **NO-GO** when Chromium fails, or any isolation probe is `READABLE`, or the server ever saw the cookie: Task 16 sets `PDF_INTAKE_ENABLED = false` (images only) and the finding says why.

- [ ] **Step 7: Commit**

```powershell
Set-Location E:\projects\clinicpad; git add docs/spikes/2026-11-18-s2-pdfjs-frame.md; git commit -m "docs(spike): S2 pdf.js sandboxed frame finding" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 3: Spike S4 — ClamAV footprint, hardening, and the clamd protocol from Node

**Files:**
- Create (throwaway, ignored): `spikes/s4-clamav/probe.mjs`
- Create (committed): `docs/spikes/2026-11-18-s4-clamav.md`

**Interfaces:**
- Produces (consumed by Task 8): the image tag and digest to pin; the container options that work (`cap_drop`, added capabilities, `no-new-privileges`, read-only root, memory limit); idle and peak memory; start-up time until `PING` answers `PONG`; the exact `VERSION` reply format; which test payloads are detected; the reply text for an over-size stream; scan latency for a 2 MB image.

- [ ] **Step 1: Start a spike container (not the compose service; another port)**

```powershell
Set-Location E:\projects\clinicpad; docker pull clamav/clamav:1.4
Set-Location E:\projects\clinicpad; docker image inspect clamav/clamav:1.4 --format "{{index .RepoDigests 0}}"
Set-Location E:\projects\clinicpad; docker run -d --name clinicpad-clamav-spike -p 127.0.0.1:3311:3310 --memory 3g --security-opt no-new-privileges:true clamav/clamav:1.4
```

Wait until the log shows clamd listening (first start downloads signatures; record how long): `docker logs -f clinicpad-clamav-spike` (Ctrl+C when `clamd` reports it is listening). Record `docker stats --no-stream clinicpad-clamav-spike` (idle memory).

- [ ] **Step 2: Write the probe (EICAR is decoded at run time, never written to disk)**

`spikes/s4-clamav/probe.mjs`:

```js
import { connect } from "node:net";
import { deflateSync } from "node:zlib";

const PORT = Number(process.env.CLAMD_PORT ?? 3311);
// The EICAR anti-virus test file, assembled at run time from fragments (see tests/helpers/eicar.ts) so no file contains it.
const EICAR = Buffer.from(["X5O!P%@AP[4", "\PZX54(P^)7CC)7}", "$EICAR-STANDARD-", "ANTIVIRUS-TEST-FILE!", "$H+H*"].join(""), "ascii");

function talk(write) {
  return new Promise((resolve) => {
    const socket = connect({ port: PORT, host: "127.0.0.1" });
    const chunks = [];
    const t0 = Date.now();
    socket.on("connect", () => write(socket));
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", (e) => resolve({ error: e.code ?? e.message, ms: Date.now() - t0 }));
    socket.on("close", () => resolve({ reply: Buffer.concat(chunks).toString("utf8").replace(/\0+$/, ""), ms: Date.now() - t0 }));
  });
}

function instream(bytes) {
  return talk((s) => {
    s.write("zINSTREAM\0");
    for (let at = 0; at < bytes.length; at += 65536) {
      const part = bytes.subarray(at, at + 65536);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(part.length);
      s.write(head);
      s.write(part);
    }
    s.end(Buffer.alloc(4));
  });
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A one-entry stored (uncompressed) ZIP. */
function storedZip(name, data) {
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  const centralStart = 30 + n.length + data.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12); end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

function noisePng(width, height) {
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body)); return Buffer.concat([l, body, c]); };
  const h = Buffer.alloc(13); h.writeUInt32BE(width, 0); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 2;
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) >>> 24;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", h), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

const png = noisePng(1000, 700);
const results = {
  ping: await talk((s) => s.end("zPING\0")),
  version: await talk((s) => s.end("zVERSION\0")),
  eicarPlain: await instream(EICAR),
  eicarZipped: await instream(storedZip("readme.txt", EICAR)),
  eicarAfterPngEnd: await instream(Buffer.concat([png, EICAR])),
  cleanPng: { bytes: png.length, ...(await instream(png)) },
  oversize30MB: await instream(Buffer.alloc(30 * 1024 * 1024, 7)),
};
console.log(JSON.stringify(results, null, 2));
```

- [ ] **Step 3: Run it, then measure peak memory and the hardened variants**

```powershell
Set-Location E:\projects\clinicpad; New-Item -ItemType Directory -Force spikes\s4-clamav | Out-Null
Set-Location E:\projects\clinicpad\spikes\s4-clamav; node probe.mjs
Set-Location E:\projects\clinicpad; docker stats --no-stream clinicpad-clamav-spike
```

Then try, one at a time, removing the container and starting it with stricter options; record whether clamd reaches `PONG` and how long it takes:
1. `--cap-drop ALL`
2. `--cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE`
3. variant 2 plus `--read-only --tmpfs /tmp --tmpfs /run/clamav` and a named volume for `/var/lib/clamav`
4. variant 3 plus `-e CLAMAV_NO_FRESHCLAMD=true` (no signature updates: clamd alone, no egress needed)

For each: `docker rm -f clinicpad-clamav-spike`, `docker run -d --name clinicpad-clamav-spike -p 127.0.0.1:3311:3310 --memory 3g --security-opt no-new-privileges:true <options> clamav/clamav:1.4`, wait, `node probe.mjs`. Finally run `docker stats` while the 30 MB probe runs to record peak memory. Remove the container at the end: `docker rm -f clinicpad-clamav-spike`.

- [ ] **Step 4: Write the finding**

`docs/spikes/2026-11-18-s4-clamav.md`. `Results`: digest, start-up time (first and warm start), idle and peak memory, each probe's reply and time, the `VERSION` reply verbatim (for example `ClamAV 1.4.x/27xxx/<date>`), the over-size reply verbatim, the strictest option set that works. `Decision`:

- **GO** when `PING` → `PONG`, EICAR plain and zipped are `… FOUND`, the clean PNG is `stream: OK` in under 2 s, and peak memory is under 3 GB. Record `CLAMAV_IMAGE=clamav/clamav:<tag>@sha256:<digest>`, `CLAMAV_OPTIONS=<strictest working set>`, `CLAMAV_MEM_LIMIT=<peak rounded up to 0.5 GB, minimum 2g>`, `CLAMAV_START_SECONDS=<warm start>`.
- `eicarAfterPngEnd` is informational (ClamAV's EICAR signature may only match a whole file); the upload pipeline refuses trailing bytes anyway (`inspectImage`).
- **GO-WITH-FALLBACK** when only the hardened options fail: Task 8 uses the strictest working set and lists the missing hardening as an ops follow-up.
- **NO-GO** when detection fails or memory exceeds 3 GB: Task 8 still ships the scanner interface and the fail-closed adapter, but the finding must propose a replacement before production (uploads stay refused in production until resolved).

- [ ] **Step 5: Commit**

```powershell
Set-Location E:\projects\clinicpad; git add docs/spikes/2026-11-18-s4-clamav.md; git commit -m "docs(spike): S4 ClamAV footprint and protocol finding" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 4: Spike S5 — Gotenberg 8.11 → the latest pinned 8.x

**Files:**
- Create (throwaway, ignored): `spikes/s5-gotenberg/compare.mjs`, `spikes/s5-gotenberg/old/`, `spikes/s5-gotenberg/new/`
- Create (committed): `docs/spikes/2026-11-18-s5-gotenberg-upgrade.md`

**Interfaces:**
- Consumes: `tests/e2e/rx-visual.spec.ts` (writes real Gotenberg PDFs to `test-results/rx-visual-pdf/` when `RX_VISUAL=1`), `tests/integration/gotenberg-smoke.test.ts` (deny-list probe, config drift); Task 1's `spikes/s1-overlay-print/analyze.mjs` approach.
- Produces (consumed by Task 6): `GOTENBERG_IMAGE=gotenberg/gotenberg:<version>@sha256:<digest>`, the verified flag list (each of the seven flags present in `gotenberg --help` of the new image, or its replacement), the Chromium version inside the image, whether the LibreOffice URL deny-list flags exist (for 2B), page-count and text equality per visual case, GO/NO-GO.

- [ ] **Step 1: Identify the newest 8.x and its digest**

```powershell
Set-Location E:\projects\clinicpad; docker pull gotenberg/gotenberg:8
Set-Location E:\projects\clinicpad; docker image inspect gotenberg/gotenberg:8 --format "{{index .Config.Labels \"org.opencontainers.image.version\"}}"
```

Pull that exact version tag (for example `docker pull gotenberg/gotenberg:8.32.0`), then `docker image inspect gotenberg/gotenberg:<version> --format "{{index .RepoDigests 0}}"` and `docker run --rm gotenberg/gotenberg:<version> gotenberg --help > spikes\s5-gotenberg\help.txt`. Check every flag of `docker-compose.yml` against `help.txt`: `--api-timeout`, `--api-disable-download-from`, `--webhook-disable`, `--libreoffice-disable-routes`, `--pdfengines-disable-routes`, `--chromium-disable-javascript`, `--chromium-deny-list`, `--log-level`; also look for `--libreoffice-*` URL allow/deny-list flags (record their names for 2B).

- [ ] **Step 2: Render the visual suite on both versions**

```powershell
Set-Location E:\projects\clinicpad; New-Item -ItemType Directory -Force spikes\s5-gotenberg\old, spikes\s5-gotenberg\new | Out-Null
Set-Location E:\projects\clinicpad; docker compose up -d gotenberg; $env:RX_VISUAL="1"; npx playwright test tests/e2e/rx-visual.spec.ts; Copy-Item test-results\rx-visual-pdf\*.pdf spikes\s5-gotenberg\old\
Set-Location E:\projects\clinicpad; docker compose stop gotenberg
Set-Location E:\projects\clinicpad; docker run -d --name gotenberg -p 127.0.0.1:3001:3000 --add-host=host.docker.internal:host-gateway --cap-drop ALL --security-opt no-new-privileges:true --memory 1g --pids-limit 512 gotenberg/gotenberg:<version> gotenberg --api-timeout=30s --api-disable-download-from --webhook-disable --libreoffice-disable-routes --pdfengines-disable-routes --chromium-disable-javascript=true "--chromium-deny-list=^(?!file:///tmp/|data:|about:|blob:).*" --log-level=warn
Set-Location E:\projects\clinicpad; $env:RX_VISUAL="1"; npx playwright test tests/e2e/rx-visual.spec.ts; Copy-Item test-results\rx-visual-pdf\*.pdf spikes\s5-gotenberg\new\
Set-Location E:\projects\clinicpad; $env:GOTENBERG_REQUIRED="1"; npx vitest run tests/integration/gotenberg-smoke.test.ts
```

(The smoke test's config-drift step inspects the container named `gotenberg`, so it checks the new image's flags. Use the flag replacements from Step 1 if a flag was renamed.) Then put the default back: `docker rm -f gotenberg; docker compose up -d gotenberg`.

- [ ] **Step 3: Compare the PDFs**

`spikes/s5-gotenberg/compare.mjs` (install `pdfjs-dist@5` in this folder as in Task 1 Step 6):

```js
import { readdirSync, readFileSync } from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

async function pages(path) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), isEvalSupported: false }).promise;
  const texts = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    texts.push((await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("").replace(/\s+/g, ""));
  }
  return texts;
}

const rows = [];
for (const file of readdirSync(new URL("./old/", import.meta.url))) {
  const before = await pages(new URL(`./old/${file}`, import.meta.url));
  const after = await pages(new URL(`./new/${file}`, import.meta.url));
  rows.push({ file, pagesOld: before.length, pagesNew: after.length, sameText: before.join("|") === after.join("|") });
}
console.table(rows);
```

Run: `Set-Location E:\projects\clinicpad\spikes\s5-gotenberg; npm init -y | Out-Null; npm install --save-exact pdfjs-dist@5; node compare.mjs`

Then a human opens each old/new pair side by side and notes any visible difference (fonts, spacing, page breaks, footers).

- [ ] **Step 4: Write the finding**

`docs/spikes/2026-11-18-s5-gotenberg-upgrade.md`. `Decision`:
- **GO** when every case has the same page count and the same text, the smoke test passes (deny-list zero hits, drift clean), and the human saw no regression. Record `GOTENBERG_IMAGE=gotenberg/gotenberg:<version>@sha256:<digest>`, `FLAGS=<the exact command list>`, `CHROMIUM=<version>`, `LIBREOFFICE_URL_FLAGS=<names or none>`.
- **NO-GO** otherwise: Task 6 is skipped; 2A stays on 8.11 (the overlay renderer does not need the upgrade); list what failed.

- [ ] **Step 5: Commit**

```powershell
Set-Location E:\projects\clinicpad; git add docs/spikes/2026-11-18-s5-gotenberg-upgrade.md; git commit -m "docs(spike): S5 Gotenberg upgrade finding" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 5: Spike S3 — docxtemplater core readiness for 2B (non-gating)

**This task gates nothing in 2A.** Run it at any point (in parallel with any task) or leave it for the start of 2B planning. Real pads are used only if the human provides them with consent; otherwise the spike uses synthetic documents and the finding says so.

**Files:**
- Create (throwaway, ignored): `spikes/s3-docxtemplater/{docx.mjs,probe.mjs}`
- Create (committed): `docs/spikes/2026-11-18-s3-docxtemplater.md`

**Interfaces:**
- Produces (for the 2B plan only): docxtemplater's licence as published in the installed package (`license` field and LICENSE text); whether the lexer finds tags split across runs; whether a custom parser can accept `{{#if x}}` or the sanitizer must normalise it to `{{#x}}`; whether LibreOffice (in a throwaway Gotenberg with LibreOffice routes enabled) repeats a `w:tblHeader` row across pages with 12 and 30 rows; whether two renders give identical bytes with fixed ZIP dates; whether pdf-lib `embedPage` can stamp a page onto the result.

- [ ] **Step 1: Install in the spike folder only**

```powershell
Set-Location E:\projects\clinicpad; New-Item -ItemType Directory -Force spikes\s3-docxtemplater | Out-Null
Set-Location E:\projects\clinicpad\spikes\s3-docxtemplater; npm init -y | Out-Null; npm install --save-exact docxtemplater@3 pizzip@3 pdf-lib@1 pdfjs-dist@5
Set-Location E:\projects\clinicpad\spikes\s3-docxtemplater; node -e "for (const p of ['docxtemplater','pizzip','pdf-lib']) { const j = require('./node_modules/' + p + '/package.json'); console.log(p, j.version, j.license); }"
Set-Location E:\projects\clinicpad; docker run -d --name clinicpad-office-spike -p 127.0.0.1:3003:3000 --memory 2g gotenberg/gotenberg:8 gotenberg --chromium-disable-routes --api-timeout=60s --log-level=warn
```

- [ ] **Step 2: Write a synthetic DOCX builder with split runs and a header-row table**

`spikes/s3-docxtemplater/docx.mjs`:

```js
import PizZip from "pizzip";

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const cell = (t) => `<w:tc><w:p>${run(t)}</w:p></w:tc>`;

/** Name split across three runs, an optional #if section, and a medicines table whose first row repeats as a header. */
export function pad({ withIf = true } = {}) {
  const body = [
    `<w:p>${run("Name: {{pat")}${run("ient.na")}${run("me}}")}</w:p>`,
    withIf
      ? `<w:p>${run("{{#if patient.allergies}}Allergies: {{patient.allergies}}{{/if}}")}</w:p>`
      : `<w:p>${run("{{#patient.allergies}}Allergies: {{patient.allergies}}{{/patient.allergies}}")}</w:p>`,
    `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr>`,
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("MEDHEAD")}${cell("Dose")}${cell("Days")}</w:tr>`,
    `<w:tr>${cell("{{#medicines}}{{name}}")}${cell("{{dose}}")}${cell("{{duration}}{{/medicines}}")}</w:tr>`,
    `</w:tbl>`,
  ].join("");
  const zip = new PizZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: "nodebuffer" });
}
```

- [ ] **Step 3: Write the probe**

`spikes/s3-docxtemplater/probe.mjs`:

```js
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pad } from "./docx.mjs";

const ownLookup = (obj, path) => path.split(".").reduce((v, k) => (v !== null && typeof v === "object" && Object.hasOwn(v, k) ? v[k] : undefined), obj);
const parser = (tag) => {
  const name = tag.trim().replace(/^if\s+/, "");
  return { get: (scope, context) => ownLookup(context.scopeList?.[0] ?? scope, name) ?? ownLookup(scope, name) };
};
const data = (n) => ({ patient: { name: "Asha Rao", allergies: "Penicillin" }, medicines: Array.from({ length: n }, (_, i) => ({ name: `Medicine ${i + 1}`, dose: "1-0-1", duration: "5 days" })) });

function render(n, withIf) {
  const doc = new Docxtemplater(new PizZip(pad({ withIf })), { delimiters: { start: "{{", end: "}}" }, paragraphLoop: true, linebreaks: true, parser, nullGetter: () => "" });
  doc.render(data(n));
  return { bytes: doc.getZip().generate({ type: "nodebuffer", date: new Date(0) }) };
}

async function toPdf(docx) {
  const form = new FormData();
  form.append("files", new Blob([docx]), "pad.docx");
  const r = await fetch("http://localhost:3003/forms/libreoffice/convert", { method: "POST", body: form });
  if (!r.ok) throw new Error(`office ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function headerPerPage(pdf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const text = (await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
    out.push(text.includes("MEDHEAD"));
  }
  return out;
}

const results = {};
try {
  render(3, true);
  results.ifSugar = "accepted by the custom parser";
} catch (error) {
  results.ifSugar = `refused (normalise {{#if x}} to {{#x}} in 2B): ${error?.properties?.errors?.map((e) => e.properties?.explanation).join("; ") ?? error.message}`;
}
const first = render(3, false);
results.splitRuns = "rendered";
results.deterministic = Buffer.compare(first.bytes, render(3, false).bytes) === 0;
for (const n of [12, 30]) {
  try {
    const pdf = await toPdf(render(n, false).bytes);
    results[`rows${n}`] = { headerOnEveryPage: await headerPerPage(pdf) };
    if (n === 30) {
      const target = await PDFDocument.load(pdf);
      const stamp = await PDFDocument.create();
      const page = stamp.addPage([595, 842]);
      page.drawText("DRAFT", { x: 200, y: 400, size: 60, color: rgb(0.7, 0.1, 0.1), opacity: 0.2, font: await stamp.embedFont(StandardFonts.HelveticaBold) });
      const [embedded] = await target.embedPdf(await stamp.save());
      for (const p of target.getPages()) p.drawPage(embedded);
      results.stampComposited = (await target.save()).byteLength > 0;
    }
  } catch (error) {
    results[`rows${n}`] = { error: String(error?.message ?? error).slice(0, 200) };
  }
}
console.log(JSON.stringify(results, null, 2));
```

- [ ] **Step 4: Run it, clean up, write the finding**

```powershell
Set-Location E:\projects\clinicpad\spikes\s3-docxtemplater; node probe.mjs
Set-Location E:\projects\clinicpad; docker rm -f clinicpad-office-spike
```

`docs/spikes/2026-11-18-s3-docxtemplater.md`: the licence fields and the first paragraph of each LICENSE file verbatim (no conclusion about legal compliance: that is the human's Q7), the probe results, and whether real pads were tested (only with the human's files and consent; never commit them). `Decision`: "input for 2B planning; gates nothing in 2A".

- [ ] **Step 5: Commit**

```powershell
Set-Location E:\projects\clinicpad; git add docs/spikes/2026-11-18-s3-docxtemplater.md; git commit -m "docs(spike): S3 docxtemplater readiness finding (2B input)" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 6: Gotenberg upgrade and engine pins (only if the S5 finding says GO)

If the S5 finding says **NO-GO**, skip Steps 3–6, still do Steps 1–2 (the pin test protects 8.11 too), and commit with the subject `test: one pinned Gotenberg image in compose, CI and the smoke test`.

**Files:**
- Create: `tests/unit/engine-pins.test.ts`
- Modify: `docker-compose.yml` (the `gotenberg` service `image:` line and, only if S5 recorded a renamed flag, its `command:`), `.github/workflows/ci.yml` (the `docker run … gotenberg/gotenberg:…` step), `tests/integration/gotenberg-smoke.test.ts` (`IMAGE` constant, and `GOTENBERG_FLAGS` only if a flag was renamed), `docs/SETUP.md` (every `8.11.0` mention)

**Interfaces:**
- Consumes: `GOTENBERG_IMAGE` and `FLAGS` from `docs/spikes/2026-11-18-s5-gotenberg-upgrade.md`.
- Produces: `tests/unit/engine-pins.test.ts` with a `pinsOf(text, image)` helper that Task 8 extends for ClamAV.

- [ ] **Step 1: Write the pin test**

`tests/unit/engine-pins.test.ts`:

```ts
// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = ["docker-compose.yml", ".github/workflows/ci.yml"] as const;
const read = (path: string) => readFileSync(path, "utf8");

/** Every "<image>:<tag>" reference in a file, with or without a digest. */
function pinsOf(text: string, image: string): string[] {
  const escaped = image.replace(/[/.]/g, (c) => `\\${c}`);
  return [...text.matchAll(new RegExp(`${escaped}:[A-Za-z0-9._-]+(?:@sha256:[0-9a-f]{64})?`, "g"))].map((m) => m[0]);
}

describe("engine image pins", () => {
  it("pins Gotenberg to one tag and digest in compose, CI, and the smoke test", () => {
    const found = [...FILES.map(read), read("tests/integration/gotenberg-smoke.test.ts")].flatMap((t) => pinsOf(t, "gotenberg/gotenberg"));
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(new Set(found).size, found.join("\n")).toBe(1);
    expect(found[0]).toMatch(/^gotenberg\/gotenberg:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run it against the current pins**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/engine-pins.test.ts`
Expected: PASS (all three still say `8.11.0@sha256:e60da3ec…`). This proves the test reads the right files before the upgrade changes them.

- [ ] **Step 3: Change the pin everywhere**

Replace `gotenberg/gotenberg:8.11.0@sha256:e60da3ecc52050303c3886630aa7ed82f9486660b82a1ce6e5bf253c3b0764d4` with the `GOTENBERG_IMAGE` value from the S5 finding in `docker-compose.yml`, `.github/workflows/ci.yml`, and `tests/integration/gotenberg-smoke.test.ts`. In `docker-compose.yml` also change the comment line `# Image pinned by digest (tag 8.11.0). …` to the new tag. If the finding lists a renamed flag, change it in all three places (compose `command:`, the CI `docker run` arguments, `GOTENBERG_FLAGS` in the smoke test). Replace each `8.11.0` in `docs/SETUP.md` (find them with `Select-String -Path docs/SETUP.md -Pattern "8\.11\.0"`).

- [ ] **Step 4: Run the pin test, the smoke test, and the visual suite on the new image**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/engine-pins.test.ts
Set-Location E:\projects\clinicpad; docker compose up -d --force-recreate gotenberg
Set-Location E:\projects\clinicpad; $env:GOTENBERG_REQUIRED="1"; npx vitest run tests/integration/gotenberg-smoke.test.ts
Set-Location E:\projects\clinicpad; $env:RX_VISUAL="1"; npx playwright test tests/e2e/rx-visual.spec.ts
```

Expected: pin test PASS; smoke test PASS including "deny-list blocks outside requests" and the config-drift check; visual suite PASS (page counts within each case's bounds).

- [ ] **Step 5: Human PDF review (AGENTS §10)**

Open every PDF in `test-results/rx-visual-pdf/` and compare with `spikes/s5-gotenberg/old/`: footers at both edges, no heading split mid-word, page breaks unchanged. Record "reviewed by <name>, <date>, no regression" in the commit message body.

- [ ] **Step 6: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add tests/unit/engine-pins.test.ts docker-compose.yml .github/workflows/ci.yml tests/integration/gotenberg-smoke.test.ts docs/SETUP.md; git commit -m "chore(pdf): upgrade Gotenberg to the S5-verified 8.x pin, with a single-pin test" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 7: Template schema, migrations 0024–0026, and database guarantees

**Files:**
- Create: `src/server/db/schema/columns.ts`, `src/server/db/schema/templates.ts`
- Modify: `src/server/db/schema/tenancy.ts` (import `bytea`; `clinics.customTemplateId`, `doctors.templateId`), `src/server/db/schema/clinical.ts` (remove `templates`/`templateVersions`, import `templateVersions`; prescriptions CHECK; output columns), `src/server/db/schema/index.ts`
- Create: `drizzle/0024_phase2a_template_cleanup.sql`, `drizzle/0025_phase2a_templates.sql`, `drizzle/0026_phase2a_templates_security.sql`, their `drizzle/meta/*_snapshot.json` and `_journal.json` entries
- Create: `tests/fixtures/overlay-definitions.ts`, `tests/helpers/templates.ts`, `tests/integration/template-schema.test.ts`
- Modify: `tests/integration/tenant-fk.test.ts` (`seedPhase0`), `tests/integration/clinical-references.test.ts` (`world`), `tests/integration/rls-guard.test.ts` (known tables)

**Interfaces:**
- Consumes: `tenants`, `clinics`, `doctors` (`doctors_tenant_id_uq`), `prescriptions`, `prescriptionOutputs`; `tenant_is_erased(uuid)` (0005); `enforce_rx_output_target()` (0015); `makePng` (`tests/helpers/images.ts`); `createTestTenant`.
- Produces (Drizzle, exported from `@/server/db/schema`):
  - `templateFiles`: `id`, `tenantId`, `kind` (`"background_image"`), `mime` (`"image/png" | "image/jpeg"`), `byteSize`, `width`, `height`, `sha256`, `bytes: Buffer`, `scanEngine`, `storage` (`"pg"`), `createdBy`, `createdAt`.
  - `templates`: `id`, `tenantId`, `name`, `kind` (`"overlay"`), `status` (`"active" | "archived"`, default `active`), `identity` (`"dynamic" | "bound"`, default `dynamic`), `boundDoctorId`, `currentVersionId`, `createdBy`, `updatedAt`, `createdAt`.
  - `templateVersions`: `id`, `tenantId`, `templateId`, `version`, `state` (`"draft" | "published"`, default `draft`), `fileId`, `definition: unknown` (jsonb), `paperSize`, `labels`, `contentSha256`, `draftRevision`, `publishedAt`, `publishedBy`, `createdBy`, `updatedAt`, `createdAt`.
  - `clinics.customTemplateId`, `doctors.templateId` (`string | null`); `prescriptionOutputs.templateVersionId`, `prescriptionOutputs.engine` (`string | null`).
  - Database: forced RLS on `template_files` (select, insert, delete policies; no UPDATE grant); triggers `template_files_rules`, `templates_rules`, `template_versions_rules`, `prescriptions_template_version`; replaced `enforce_rx_output_target()`; the CHECKs listed in the schema below.
  - Test helpers (`tests/helpers/templates.ts`): `backgroundPng(label)`, `fileValues(tenantId, label, overrides?)`, `insertBackgroundFile(tenantId, label, overrides?)`, `MINIMAL_OVERLAY_DEFINITION`, `insertTemplate(tenantId, opts?) → { templateId, versionId, fileId }`.

- [ ] **Step 1: Write the test helpers**

The minimal definition lives in a database-free fixture so pure unit tests (Tasks 11, 12) can import it without loading `adminDb`.

`tests/fixtures/overlay-definitions.ts`:

```ts
/** A valid overlay definition for A4 (Task 11's schema accepts it; tests/unit/overlay-definition.test.ts pins that). */
export const MINIMAL_OVERLAY_DEFINITION = {
  v: 1,
  background: { printMode: "always" },
  boxes: [
    { id: "b1", field: "patient.name", xMm: 20, yMm: 52, wMm: 90, hMm: 7, fontPt: 11, align: "left", bold: true, repeat: "every_page" },
    { id: "b2", field: "visit.date", xMm: 150, yMm: 52, wMm: 40, hMm: 7, fontPt: 10, align: "right", bold: false, repeat: "every_page" },
  ],
  flow: {
    topMm: 64,
    bottomMm: 27,
    leftMm: 15,
    rightMm: 15,
    bodyStyle: "general",
    sections: ["vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp"],
    showRxMark: true,
  },
  signature: { mode: "end_of_content" },
  pageNumbers: { bandMm: 0 },
  printOffsetMm: { x: 0, y: 0 },
} as const;
```

`tests/helpers/templates.ts`:

```ts
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { templateFiles, templates, templateVersions } from "@/server/db/schema";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";
import { makePng } from "./images";

export { MINIMAL_OVERLAY_DEFINITION };

/** A real PNG with A-series proportions (780 x 1103 px). The colour, and so the hash, is derived from the label. */
export function backgroundPng(label: string): Buffer {
  const seed = createHash("sha256").update(label).digest();
  return makePng(780, 1103, [seed[0], seed[1], seed[2]]);
}

export function fileValues(tenantId: string, label: string, overrides: Partial<typeof templateFiles.$inferInsert> = {}) {
  const bytes = backgroundPng(label);
  return {
    tenantId,
    kind: "background_image",
    mime: "image/png",
    width: 780,
    height: 1103,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    scanEngine: "test-scanner 1.0",
    ...overrides,
  };
}

export async function insertBackgroundFile(tenantId: string, label: string, overrides: Partial<typeof templateFiles.$inferInsert> = {}): Promise<string> {
  const [row] = await adminDb.insert(templateFiles).values(fileValues(tenantId, label, overrides)).returning({ id: templateFiles.id });
  return row.id;
}

export type InsertedTemplate = { templateId: string; versionId: string; fileId: string };

/**
 * Admin insert of a template with one version: a draft, or (publish: true) flipped to published with a FAKE content hash.
 * Schema tests only: services and the renderer verify real hashes (use Task 13's insertPublishedOverlay there).
 */
export async function insertTemplate(
  tenantId: string,
  opts: { label?: string; version?: number; publish?: boolean; identity?: "dynamic" | "bound"; boundDoctorId?: string | null; fileId?: string } = {},
): Promise<InsertedTemplate> {
  const label = opts.label ?? `tpl-${Math.random().toString(36).slice(2)}`;
  const fileId = opts.fileId ?? (await insertBackgroundFile(tenantId, label));
  const [template] = await adminDb
    .insert(templates)
    .values({ tenantId, name: "Test pad", kind: "overlay", identity: opts.identity ?? "dynamic", boundDoctorId: opts.boundDoctorId ?? null })
    .returning({ id: templates.id });
  const [version] = await adminDb
    .insert(templateVersions)
    .values({ tenantId, templateId: template.id, version: opts.version ?? 1, fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en" })
    .returning({ id: templateVersions.id });
  if (opts.publish) {
    await adminDb
      .update(templateVersions)
      .set({ state: "published", contentSha256: "c".repeat(64), publishedAt: new Date() })
      .where(eq(templateVersions.id, version.id));
    await adminDb.update(templates).set({ currentVersionId: version.id }).where(eq(templates.id, template.id));
  }
  return { templateId: template.id, versionId: version.id, fileId };
}
```

- [ ] **Step 2: Write the failing schema test**

`tests/integration/template-schema.test.ts`:

```ts
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  clinics,
  doctors,
  patients,
  prescriptionItems,
  prescriptionOutputs,
  prescriptions,
  templateFiles,
  templates,
  templateVersions,
  tenants,
  visits,
} from "@/server/db/schema";
import { createTestTenant, type TestTenant } from "../helpers/tenant";
import { fileValues, insertBackgroundFile, insertTemplate, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";

let A: TestTenant;
let B: TestTenant;
let nextRxNo = 9300;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

async function doctorOf(tenantId: string): Promise<string> {
  const [row] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, tenantId)).limit(1);
  return row.id;
}

/** A draft prescription with one item, ready to be finalized by the test. */
async function draftRx(tenantId: string): Promise<{ rxId: string; visitId: string }> {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Template Schema Patient" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId, visitId: visit.id, status: "draft" }).returning();
  await adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "Paracetamol" });
  return { rxId: rx.id, visitId: visit.id };
}

/** Finalizes the way finalizePrescription does: template_version_id and the snapshot in the same UPDATE. */
function finalizeWith(rxId: string, templateVersionId: string | null, snapshotVersionId: string | null) {
  nextRxNo += 1;
  const template = snapshotVersionId
    ? { kind: "overlay", templateVersionId: snapshotVersionId, contentSha256: "c".repeat(64) }
    : { kind: "builtin", key: "general" };
  return adminDb
    .update(prescriptions)
    .set({ status: "finalized", rxNo: nextRxNo, finalizedAt: new Date(), templateVersionId, renderSnapshot: { v: 2, layout: { template } } })
    .where(eq(prescriptions.id, rxId));
}

beforeAll(async () => {
  A = await createTestTenant("tpl-schema-a");
  B = await createTestTenant("tpl-schema-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("template_files", () => {
  it("is tenant-isolated, readable and insertable by the app role, never updatable", async () => {
    await withTenant(A.tenantId, (tx) => tx.insert(templateFiles).values(fileValues(A.tenantId, "app-insert")));
    expect((await withTenant(A.tenantId, (tx) => tx.select({ id: templateFiles.id }).from(templateFiles))).length).toBeGreaterThan(0);
    expect(await withTenant(B.tenantId, (tx) => tx.select({ id: templateFiles.id }).from(templateFiles))).toHaveLength(0);
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(templateFiles).set({ scanEngine: "changed" })), "42501");
    await expectCode(withTenant(B.tenantId, (tx) => tx.insert(templateFiles).values(fileValues(A.tenantId, "leak"))), "42501");
  });

  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
  it.each([
    ["a DOCX kind (2B)", { kind: "docx" }],
    ["an SVG", { mime: "image/svg+xml" }],
    ["a size that does not match the bytes", { byteSize: 3 }],
    ["more than 2 MB", { bytes: big, byteSize: big.length, sha256: createHash("sha256").update(big).digest("hex") }],
    ["a long side under 1,100 px", { width: 700, height: 990 }],
    ["a long side over 3,600 px", { width: 2600, height: 3700 }],
    ["US Letter proportions", { width: 850, height: 1100 }],
    ["a square photo", { width: 1200, height: 1200 }],
    ["a hash that is not of the bytes", { sha256: "a".repeat(64) }],
    ["a malformed hash", { sha256: "not-a-hash" }],
    ["no scan engine", { scanEngine: "" }],
    ["object storage (not built)", { storage: "s3" }],
  ])("rejects %s (23514)", async (label, overrides) => {
    await expectCode(adminDb.insert(templateFiles).values(fileValues(A.tenantId, `bad-${label}`, overrides)), "23514");
  });

  it("de-duplicates identical bytes per tenant and kind (23505), but not across tenants", async () => {
    await insertBackgroundFile(A.tenantId, "dup");
    await expectCode(adminDb.insert(templateFiles).values(fileValues(A.tenantId, "dup")), "23505");
    await insertBackgroundFile(B.tenantId, "dup");
  });

  it("is immutable even on the admin connection (23000)", async () => {
    const id = await insertBackgroundFile(A.tenantId, "frozen");
    await expectCode(adminDb.update(templateFiles).set({ scanEngine: "changed" }).where(eq(templateFiles.id, id)), "23000");
  });

  it("refuses deleting a file younger than a day (23000) or one a version uses (23503)", async () => {
    const young = await insertBackgroundFile(A.tenantId, "young");
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(templateFiles).where(eq(templateFiles.id, young))), "23000");
    const old = await insertBackgroundFile(A.tenantId, "old-used", { createdAt: new Date(Date.now() - 3 * 86_400_000) });
    await insertTemplate(A.tenantId, { fileId: old });
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(templateFiles).where(eq(templateFiles.id, old))), "23503");
  });

  it("lets the app role delete an old unused file (garbage collection)", async () => {
    const old = await insertBackgroundFile(A.tenantId, "old-unused", { createdAt: new Date(Date.now() - 3 * 86_400_000) });
    await withTenant(A.tenantId, (tx) => tx.delete(templateFiles).where(eq(templateFiles.id, old)));
    expect(await adminDb.select().from(templateFiles).where(eq(templateFiles.id, old))).toHaveLength(0);
  });
});

describe("templates", () => {
  it.each([
    ["the Phase 0 html kind", { kind: "html" }],
    ["an unknown status", { status: "draft" }],
    ["bound without a doctor", { identity: "bound" }],
    ["an empty name", { name: "" }],
  ])("rejects %s (23514)", async (_label, overrides) => {
    await expectCode(adminDb.insert(templates).values({ tenantId: A.tenantId, name: "Pad", kind: "overlay", ...overrides }), "23514");
  });

  it("rejects a dynamic template that names a doctor (23514)", async () => {
    const doctorId = await doctorOf(A.tenantId);
    await expectCode(
      adminDb.insert(templates).values({ tenantId: A.tenantId, name: "Pad", kind: "overlay", identity: "dynamic", boundDoctorId: doctorId }),
      "23514",
    );
  });

  it("binds only to a doctor of the same clinic (23503)", async () => {
    const foreignDoctor = await doctorOf(B.tenantId);
    await expectCode(
      adminDb.insert(templates).values({ tenantId: A.tenantId, name: "Pad", kind: "overlay", identity: "bound", boundDoctorId: foreignDoctor }),
      "23503",
    );
    const own = await doctorOf(A.tenantId);
    await adminDb.insert(templates).values({ tenantId: A.tenantId, name: "Pad", kind: "overlay", identity: "bound", boundDoctorId: own });
  });

  it("points current_version_id only at one of its own published versions (23000)", async () => {
    const draft = await insertTemplate(A.tenantId);
    await expectCode(adminDb.update(templates).set({ currentVersionId: draft.versionId }).where(eq(templates.id, draft.templateId)), "23000");
    const other = await insertTemplate(A.tenantId, { publish: true });
    await expectCode(adminDb.update(templates).set({ currentVersionId: other.versionId }).where(eq(templates.id, draft.templateId)), "23000");
  });
});

describe("template_versions", () => {
  it("is born as a draft (23000 for a published insert)", async () => {
    const { templateId, fileId } = await insertTemplate(A.tenantId);
    await expectCode(
      adminDb.insert(templateVersions).values({
        tenantId: A.tenantId,
        templateId,
        version: 2,
        fileId,
        definition: MINIMAL_OVERLAY_DEFINITION,
        paperSize: "A4",
        labels: "en",
        state: "published",
        contentSha256: "c".repeat(64),
        publishedAt: new Date(),
      }),
      "23000",
    );
  });

  it("lets the app role edit and delete a draft", async () => {
    const { versionId } = await insertTemplate(A.tenantId);
    await withTenant(A.tenantId, (tx) => tx.update(templateVersions).set({ labels: "hi", draftRevision: 1 }).where(eq(templateVersions.id, versionId)));
    await withTenant(A.tenantId, (tx) => tx.delete(templateVersions).where(eq(templateVersions.id, versionId)));
    expect(await adminDb.select().from(templateVersions).where(eq(templateVersions.id, versionId))).toHaveLength(0);
  });

  it("freezes a published version on every connection, and refuses deleting it or its template (23000)", async () => {
    const { templateId, versionId } = await insertTemplate(A.tenantId, { publish: true });
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(templateVersions).set({ labels: "hi" }).where(eq(templateVersions.id, versionId))), "23000");
    await expectCode(adminDb.update(templateVersions).set({ definition: { v: 1 } }).where(eq(templateVersions.id, versionId)), "23000");
    await expectCode(adminDb.delete(templateVersions).where(eq(templateVersions.id, versionId)), "23000");
    await adminDb.update(templates).set({ currentVersionId: null }).where(eq(templates.id, templateId));
    await expectCode(adminDb.delete(templates).where(eq(templates.id, templateId)), "23000");
  });

  it.each([
    ["Letter paper", { paperSize: "Letter" }],
    ["an unknown label language", { labels: "fr" }],
    ["an unknown state", { state: "archived" }],
    ["version 0", { version: 0 }],
    ["a definition that is not an object", { definition: [1, 2] }],
  ])("rejects %s (23514)", async (_label, overrides) => {
    const { templateId, fileId } = await insertTemplate(A.tenantId);
    await expectCode(
      adminDb.insert(templateVersions).values({ tenantId: A.tenantId, templateId, version: 5, fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en", ...overrides }),
      "23514",
    );
  });

  it("rejects publishing without a content hash (23514)", async () => {
    const { versionId } = await insertTemplate(A.tenantId);
    await expectCode(adminDb.update(templateVersions).set({ state: "published", publishedAt: new Date() }).where(eq(templateVersions.id, versionId)), "23514");
  });

  it("uses only files of its own clinic (23503)", async () => {
    const { templateId } = await insertTemplate(A.tenantId);
    const foreignFile = await insertBackgroundFile(B.tenantId, "foreign-file");
    await expectCode(
      adminDb.insert(templateVersions).values({ tenantId: A.tenantId, templateId, version: 7, fileId: foreignFile, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en" }),
      "23503",
    );
  });
});

describe("assignment columns", () => {
  it("assign only the clinic's own templates (23503), and an assigned template cannot be deleted (23503)", async () => {
    const own = await insertTemplate(A.tenantId);
    const foreign = await insertTemplate(B.tenantId);
    await expectCode(adminDb.update(clinics).set({ customTemplateId: foreign.templateId }).where(eq(clinics.tenantId, A.tenantId)), "23503");
    await expectCode(adminDb.update(doctors).set({ templateId: foreign.templateId }).where(eq(doctors.tenantId, A.tenantId)), "23503");
    await adminDb.update(doctors).set({ templateId: own.templateId }).where(eq(doctors.tenantId, A.tenantId));
    await expectCode(adminDb.delete(templates).where(eq(templates.id, own.templateId)), "23503");
    await adminDb.update(doctors).set({ templateId: null }).where(eq(doctors.tenantId, A.tenantId));
  });
});

describe("prescriptions and outputs name the template version", () => {
  it("finalizes only on a published version (23000)", async () => {
    const { versionId } = await insertTemplate(A.tenantId);
    const { rxId } = await draftRx(A.tenantId);
    await expectCode(finalizeWith(rxId, versionId, versionId), "23000");
  });

  it("keeps the column and the frozen snapshot in agreement (23514)", async () => {
    const one = await insertTemplate(A.tenantId, { publish: true });
    const two = await insertTemplate(A.tenantId, { publish: true });
    const { rxId } = await draftRx(A.tenantId);
    await expectCode(finalizeWith(rxId, one.versionId, two.versionId), "23514");
    await expectCode(finalizeWith(rxId, one.versionId, null), "23514");
    await finalizeWith(rxId, one.versionId, one.versionId);
  });

  it("logs outputs that name exactly the prescription's template version", async () => {
    const one = await insertTemplate(A.tenantId, { publish: true });
    const two = await insertTemplate(A.tenantId, { publish: true });
    const { rxId } = await draftRx(A.tenantId);
    await finalizeWith(rxId, one.versionId, one.versionId);
    const base = { tenantId: A.tenantId, prescriptionId: rxId, kind: "browser_print", paperSize: "A4", htmlSha256: "a".repeat(64), engine: "browser" };
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "overlay" }), "23514");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "general", templateVersionId: one.versionId }), "23514");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "overlay", templateVersionId: one.versionId, engine: "gpu" }), "23514");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "overlay", templateVersionId: two.versionId }), "23000");
    await adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "overlay", templateVersionId: one.versionId });
  });
});

describe("offboarding", () => {
  it("still deletes a tenant with published versions, files, assignments and outputs", async () => {
    const C = await createTestTenant("tpl-schema-off");
    const { templateId, versionId, fileId } = await insertTemplate(C.tenantId, { publish: true });
    await adminDb.update(clinics).set({ customTemplateId: templateId }).where(eq(clinics.tenantId, C.tenantId));
    const { rxId } = await draftRx(C.tenantId);
    await finalizeWith(rxId, versionId, versionId);
    await C.cleanup();
    for (const [table, id] of [[templateFiles, fileId], [templateVersions, versionId], [templates, templateId]] as const) {
      expect(await adminDb.select({ id: table.id }).from(table).where(eq(table.id, id))).toHaveLength(0);
    }
    expect(await adminDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, C.tenantId))).toHaveLength(0);
  });
});

it("the migrations created every guard this file relies on", async () => {
  const rows = await adminDb.execute<{ tgname: string }>(sql`
    select tgname::text from pg_trigger where not tgisinternal and tgname in
      ('template_files_rules', 'templates_rules', 'template_versions_rules', 'prescriptions_template_version') order by 1`);
  expect(rows.map((r) => r.tgname)).toEqual(["prescriptions_template_version", "template_files_rules", "template_versions_rules", "templates_rules"]);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-schema.test.ts`
Expected: FAIL at import — `templateFiles` is not exported from `@/server/db/schema` (and the helper's `templates` insert lacks the new columns).

- [ ] **Step 4: Move `bytea` into its own module**

`src/server/db/schema/columns.ts` (the comment and body move verbatim from `tenancy.ts` lines 22–39):

```ts
import { customType } from "drizzle-orm/pg-core";

/**
 * Raw bytes. postgres-js returns bytea as a Buffer and normally sends a Buffer parameter as bytea. Under
 * vitest's jsdom environment a Buffer fails postgres-js's `instanceof Uint8Array` check, so it was sent as
 * text and any value with a NUL byte (every PNG) failed with 22021. Writing bytea hex text (`\x...`) works
 * in both. It relies on postgres-js `infer: false` (the default): with `infer: true` the string would be typed
 * and double-encoded. tests/integration/render-snapshot.test.ts round-trips bytes containing 0x00.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer | string }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return `\\x${value.toString("hex")}`;
  },
  fromDriver(value) {
    return typeof value === "string" ? Buffer.from(value.replace(/^\\x/, ""), "hex") : value;
  },
});
```

In `src/server/db/schema/tenancy.ts`: delete the local `bytea` definition and its comment (lines 22–39), remove `customType,` from the `drizzle-orm/pg-core` import, and add below the other imports:

```ts
import { bytea } from "./columns";
// templates is only used inside the lazy config callbacks below (clinics.custom_template_id, doctors.template_id),
// so the import cycle with templates.ts (which references tenants and doctors the same way) is safe.
import { templates } from "./templates";
```

- [ ] **Step 5: Create `src/server/db/schema/templates.ts`**

Remove the `templates` and `templateVersions` definitions (lines 240–284) from `src/server/db/schema/clinical.ts`, add `import { templateVersions } from "./templates";` to its imports (used only inside the lazy config callbacks of `prescriptions` and `prescriptionOutputs`), and create:

```ts
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { bytea } from "./columns";
// tenants and doctors are only used inside lazy callbacks (references() and the config callbacks), so the import
// cycle with tenancy.ts is safe, as for sharing.ts <-> clinical.ts.
import { doctors, tenants } from "./tenancy";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Uploaded template files (Plan 2A: pad backgrounds). Only scanned, validated, metadata-stripped bytes are ever
 * stored; the original upload and its file name never are. Immutable (0026): insert and read; the runtime role may
 * delete only a file no version uses and older than a day (garbage collection). `storage` is the seam for object
 * storage (ADR-0047); every read goes through loadTemplateFileIn().
 */
export const templateFiles = pgTable(
  "template_files",
  {
    id: pk(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    scanEngine: text("scan_engine").notNull(),
    storage: text("storage").notNull().default("pg"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("template_files_tenant_id_uq").on(t.tenantId, t.id),
    unique("template_files_dedupe_key").on(t.tenantId, t.kind, t.sha256),
    // Keep in step with BACKGROUND_LIMITS (src/lib/domain/image.ts).
    check("template_files_kind_check", sql`kind in ('background_image')`),
    check("template_files_mime_check", sql`mime in ('image/png', 'image/jpeg')`),
    check("template_files_size_check", sql`byte_size between 1 and 2097152 and octet_length(bytes) = byte_size`),
    check("template_files_dimensions_check", sql`greatest(width, height) between 1100 and 3600 and least(width, height) >= 1`),
    check("template_files_aspect_check", sql`abs(greatest(width, height)::numeric / least(width, height) - 1.41421356) <= 0.0425`),
    check("template_files_sha256_check", sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check("template_files_hash_matches_check", sql`sha256 = encode(sha256(bytes), 'hex')`),
    check("template_files_scan_engine_check", sql`length(scan_engine) between 1 and 200`),
    check("template_files_storage_check", sql`storage in ('pg')`),
  ],
);

/** A clinic's own pad template (built-in pads are code, not rows). Never deleted once a version was published. */
export const templates = pgTable(
  "templates",
  {
    id: pk(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    /** dynamic: prints the signing doctor from data; bound: the letterhead shows bound_doctor_id's identity (decision 9). */
    identity: text("identity").notNull().default("dynamic"),
    boundDoctorId: uuid("bound_doctor_id"),
    currentVersionId: uuid("current_version_id"),
    createdBy: uuid("created_by"),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    index("templates_tenant_idx").on(t.tenantId),
    // Target of the composite same-tenant foreign keys from template_versions, clinics and doctors.
    unique("templates_tenant_id_uq").on(t.tenantId, t.id),
    index("templates_tenant_bound_doctor_idx").on(t.tenantId, t.boundDoctorId),
    index("templates_tenant_current_version_idx").on(t.tenantId, t.currentVersionId),
    check("templates_kind_check", sql`kind in ('overlay')`),
    check("templates_status_check", sql`status in ('active', 'archived')`),
    check("templates_identity_check", sql`identity in ('dynamic', 'bound')`),
    check("templates_bound_doctor_check", sql`(identity = 'bound') = (bound_doctor_id is not null)`),
    check("templates_name_check", sql`length(name) between 1 and 120`),
    foreignKey({ name: "templates_bound_doctor_fk", columns: [t.tenantId, t.boundDoctorId], foreignColumns: [doctors.tenantId, doctors.id] }),
    foreignKey({ name: "templates_current_version_fk", columns: [t.tenantId, t.currentVersionId], foreignColumns: [templateVersions.tenantId, templateVersions.id] }),
  ],
);

/**
 * One version of a template. Born as a draft (a working copy, edited in place under draft_revision); published
 * by an UPDATE that sets content_sha256; frozen afterwards on every connection (0026).
 */
export const templateVersions = pgTable(
  "template_versions",
  {
    id: pk(),
    tenantId: tenantId(),
    templateId: uuid("template_id").notNull(),
    version: integer("version").notNull(),
    state: text("state").notNull().default("draft"),
    fileId: uuid("file_id").notNull(),
    /** overlay: overlayDefinitionSchema v1 (src/lib/rx-render/overlay-definition.ts). Parse, never trust. */
    definition: jsonb("definition").$type<unknown>().notNull(),
    paperSize: text("paper_size").notNull(),
    labels: text("labels").notNull(),
    contentSha256: text("content_sha256"),
    draftRevision: integer("draft_revision").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    createdBy: uuid("created_by"),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    // Target of the composite same-tenant foreign keys from prescriptions, prescription_outputs and templates.
    unique("template_versions_tenant_id_uq").on(t.tenantId, t.id),
    unique("template_versions_template_version_unique").on(t.templateId, t.version),
    index("template_versions_tenant_file_idx").on(t.tenantId, t.fileId),
    foreignKey({
      name: "template_versions_template_fk",
      columns: [t.tenantId, t.templateId],
      foreignColumns: [templates.tenantId, templates.id],
    }).onDelete("cascade"),
    foreignKey({ name: "template_versions_file_fk", columns: [t.tenantId, t.fileId], foreignColumns: [templateFiles.tenantId, templateFiles.id] }),
    check("template_versions_state_check", sql`state in ('draft', 'published')`),
    check("template_versions_version_check", sql`version between 1 and 100000`),
    check("template_versions_paper_size_check", sql`paper_size in ('A4', 'A5')`),
    check("template_versions_labels_check", sql`labels in ('en', 'hi', 'bilingual')`),
    check("template_versions_published_check", sql`(state = 'published') = (published_at is not null and content_sha256 is not null)`),
    check("template_versions_sha256_check", sql`content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'`),
    check("template_versions_definition_check", sql`jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 65536`),
    check("template_versions_revision_check", sql`draft_revision >= 0`),
  ],
);
```

Add `export * from "./templates";` to `src/server/db/schema/index.ts` (after `./clinical`).

- [ ] **Step 6: Add the assignment and output columns**

In `tenancy.ts`, `clinics`: add the column after `sharingEnabled`:

```ts
    /** The clinic's default custom pad (Plan 2A). null: the built-in rx_template applies, as before. */
    customTemplateId: uuid("custom_template_id"),
```

and in its config callback, after `clinics_logo_asset_fk`:

```ts
    index("clinics_tenant_custom_template_idx").on(t.tenantId, t.customTemplateId),
    foreignKey({ name: "clinics_custom_template_fk", columns: [t.tenantId, t.customTemplateId], foreignColumns: [templates.tenantId, templates.id] }),
```

`doctors`: add after `signatureAssetId`:

```ts
    /** This doctor's own custom pad (Plan 2A); wins over the clinic default when usable (decision 9). */
    templateId: uuid("template_id"),
```

and in its config callback, after `doctors_signature_asset_fk`:

```ts
    index("doctors_tenant_template_idx").on(t.tenantId, t.templateId),
    foreignKey({ name: "doctors_template_fk", columns: [t.tenantId, t.templateId], foreignColumns: [templates.tenantId, templates.id] }),
```

In `clinical.ts`, `prescriptions` config callback, after `prescriptions_not_own_parent_check`:

```ts
    // Plan 2A: a set template_version_id is the version the frozen snapshot names (text comparison: never a cast error).
    // A null column is allowed because tenant offboarding nulls it (ON DELETE SET NULL) before the row itself goes.
    check(
      "prescriptions_template_version_snapshot_check",
      sql`status = 'draft' or render_snapshot is null or template_version_id is null or (render_snapshot #>> '{layout,template,templateVersionId}') is not distinct from template_version_id::text`,
    ),
```

`prescriptionOutputs`: add after `shareLinkId`:

```ts
    /** Set exactly when template_key is 'overlay': the frozen template version that drew this output (Plan 2A). */
    templateVersionId: uuid("template_version_id"),
    /** chromium (Gotenberg PDF) or browser (HTML handed to a print dialog); null for rows written before Plan 2A. */
    engine: text("engine"),
```

and in its config callback replace `check("rx_outputs_template_key_check", sql\`template_key in ('general', 'paediatric', 'derma')\`),` with:

```ts
    check("rx_outputs_template_key_check", sql`template_key in ('general', 'paediatric', 'derma', 'overlay')`),
    check("rx_outputs_template_version_check", sql`(template_key = 'overlay') = (template_version_id is not null)`),
    check("rx_outputs_engine_check", sql`engine is null or engine in ('chromium', 'browser')`),
    index("rx_outputs_template_version_idx").on(t.tenantId, t.templateVersionId),
    foreignKey({
      name: "rx_outputs_template_version_fk",
      columns: [t.tenantId, t.templateVersionId],
      foreignColumns: [templateVersions.tenantId, templateVersions.id],
    }),
```

- [ ] **Step 7: Generate migration 0024 (drop the unused columns) separately, so drizzle-kit never asks about renames**

drizzle-kit asks interactively whether a new column is a rename when one table both loses and gains columns, so the drop gets its own migration. Put the Steps 4–6 edits of tracked files aside (the new, untracked `columns.ts` and `templates.ts` stay on disk but nothing imports them once `tenancy.ts` and `index.ts` are back at HEAD; drizzle-kit reads only `src/server/db/schema/index.ts`), make the drop alone, generate, and bring the edits back:

```powershell
Set-Location E:\projects\clinicpad; git stash push -m "plan-2a-schema" -- src/server/db/schema
```

In `src/server/db/schema/clinical.ts` (now at HEAD) delete only the two lines `fileKey: text("file_key"),` and `mapping: jsonb("mapping").$type<Record<string, string>>(),` of `templateVersions`. Then:

```powershell
Set-Location E:\projects\clinicpad; npx drizzle-kit generate --name phase2a_template_cleanup
Set-Location E:\projects\clinicpad; git checkout -- src/server/db/schema/clinical.ts; git stash pop
```

Expected: `drizzle/0024_phase2a_template_cleanup.sql` with exactly two `DROP COLUMN` statements, and Steps 4–6 restored (their `templateVersions`, now in `templates.ts`, never had those two columns). Prepend the guard by hand so the file reads:

```sql
-- Plan 2A (generated, hand-edited): template_versions loses the two Phase 0 placeholders nothing ever wrote. The
-- guard stops here when a development database still holds template rows from old tests, because 0025 adds NOT NULL
-- columns to template_versions. Migrations run as the database owner, which bypasses RLS, so the counts are real.
do $$
begin
  if exists (select 1 from public.templates) or exists (select 1 from public.template_versions) then
    raise exception 'templates or template_versions hold rows: run "npm run db:sweep-test-tenants -- --apply" first (Plan 2A Task 7)';
  end if;
end $$;
--> statement-breakpoint
ALTER TABLE "template_versions" DROP COLUMN "file_key";--> statement-breakpoint
ALTER TABLE "template_versions" DROP COLUMN "mapping";
```

- [ ] **Step 8: Generate migration 0025 (everything else) and hand-edit it**

Run: `Set-Location E:\projects\clinicpad; npx drizzle-kit generate --name phase2a_templates` (no rename question can come up now: 0025 only adds). Then edit `drizzle/0025_phase2a_templates.sql` so that every CHECK added to a table that already has rows (`prescriptions`, `prescription_outputs`) is added `NOT VALID` and validated in the same file (the 1D pattern, AGENTS §10), and so the header comment explains it. The statements must be exactly these (drizzle-kit may order them differently; keep its order, change only what is listed):

```sql
-- Plan 2A templates (generated, hand-edited): template files, the template model, assignment columns, and the
-- columns that pin outputs and prescriptions to a template version. CHECKs on tables with rows are added NOT VALID
-- and validated here (existing rows pass; a dirty development database is swept first, see 0024).
CREATE TABLE "template_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"scan_engine" text NOT NULL,
	"storage" text DEFAULT 'pg' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_files_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "template_files_dedupe_key" UNIQUE("tenant_id","kind","sha256"),
	CONSTRAINT "template_files_kind_check" CHECK (kind in ('background_image')),
	CONSTRAINT "template_files_mime_check" CHECK (mime in ('image/png', 'image/jpeg')),
	CONSTRAINT "template_files_size_check" CHECK (byte_size between 1 and 2097152 and octet_length(bytes) = byte_size),
	CONSTRAINT "template_files_dimensions_check" CHECK (greatest(width, height) between 1100 and 3600 and least(width, height) >= 1),
	CONSTRAINT "template_files_aspect_check" CHECK (abs(greatest(width, height)::numeric / least(width, height) - 1.41421356) <= 0.0425),
	CONSTRAINT "template_files_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "template_files_hash_matches_check" CHECK (sha256 = encode(sha256(bytes), 'hex')),
	CONSTRAINT "template_files_scan_engine_check" CHECK (length(scan_engine) between 1 and 200),
	CONSTRAINT "template_files_storage_check" CHECK (storage in ('pg'))
);
--> statement-breakpoint
ALTER TABLE "templates" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "templates" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "custom_template_id" uuid;--> statement-breakpoint
ALTER TABLE "doctors" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD COLUMN "template_version_id" uuid;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "identity" text DEFAULT 'dynamic' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "bound_doctor_id" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "state" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "file_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "definition" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "paper_size" text NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "labels" text NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "draft_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "template_versions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "template_files" ADD CONSTRAINT "template_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_custom_template_fk" FOREIGN KEY ("tenant_id","custom_template_id") REFERENCES "public"."templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_template_version_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."template_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_bound_doctor_fk" FOREIGN KEY ("tenant_id","bound_doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_current_version_fk" FOREIGN KEY ("tenant_id","current_version_id") REFERENCES "public"."template_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."template_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinics_tenant_custom_template_idx" ON "clinics" USING btree ("tenant_id","custom_template_id");--> statement-breakpoint
CREATE INDEX "doctors_tenant_template_idx" ON "doctors" USING btree ("tenant_id","template_id");--> statement-breakpoint
CREATE INDEX "rx_outputs_template_version_idx" ON "prescription_outputs" USING btree ("tenant_id","template_version_id");--> statement-breakpoint
CREATE INDEX "templates_tenant_bound_doctor_idx" ON "templates" USING btree ("tenant_id","bound_doctor_id");--> statement-breakpoint
CREATE INDEX "templates_tenant_current_version_idx" ON "templates" USING btree ("tenant_id","current_version_id");--> statement-breakpoint
CREATE INDEX "template_versions_tenant_file_idx" ON "template_versions" USING btree ("tenant_id","file_id");--> statement-breakpoint
ALTER TABLE "prescription_outputs" DROP CONSTRAINT "rx_outputs_template_key_check";--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_template_key_check" CHECK (template_key in ('general', 'paediatric', 'derma', 'overlay')) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_outputs" VALIDATE CONSTRAINT "rx_outputs_template_key_check";--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_template_version_check" CHECK ((template_key = 'overlay') = (template_version_id is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_outputs" VALIDATE CONSTRAINT "rx_outputs_template_version_check";--> statement-breakpoint
ALTER TABLE "prescription_outputs" ADD CONSTRAINT "rx_outputs_engine_check" CHECK (engine is null or engine in ('chromium', 'browser')) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_outputs" VALIDATE CONSTRAINT "rx_outputs_engine_check";--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_template_version_snapshot_check" CHECK (status = 'draft' or render_snapshot is null or template_version_id is null or (render_snapshot #>> '{layout,template,templateVersionId}') is not distinct from template_version_id::text) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_template_version_snapshot_check";--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_kind_check" CHECK (kind in ('overlay'));--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_status_check" CHECK (status in ('active', 'archived'));--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_identity_check" CHECK (identity in ('dynamic', 'bound'));--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_bound_doctor_check" CHECK ((identity = 'bound') = (bound_doctor_id is not null));--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_name_check" CHECK (length(name) between 1 and 120);--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_state_check" CHECK (state in ('draft', 'published'));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_version_check" CHECK (version between 1 and 100000);--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_paper_size_check" CHECK (paper_size in ('A4', 'A5'));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_labels_check" CHECK (labels in ('en', 'hi', 'bilingual'));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_published_check" CHECK ((state = 'published') = (published_at is not null and content_sha256 is not null));--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_sha256_check" CHECK (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_definition_check" CHECK (jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 65536);--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_revision_check" CHECK (draft_revision >= 0);
```

(`template_files_dimensions_check` keeps `least(width, height) >= 1` so the aspect division never divides by zero; the aspect check does the real work.)

- [ ] **Step 9: Write the security migration 0026**

Run: `Set-Location E:\projects\clinicpad; npx drizzle-kit generate --custom --name phase2a_templates_security`, then fill `drizzle/0026_phase2a_templates_security.sql`:

```sql
-- Plan 2A templates (custom migration): RLS and privileges for template files, and the rules that keep stored files
-- and published template versions immutable, pin a finalized prescription to a published version, and keep each output
-- on its prescription's version. templates and template_versions keep their 0002 tenant_isolation policy.

-- 1. Template files: forced RLS; the runtime role reads, inserts and (garbage collection only) deletes; never updates.
alter table template_files enable row level security;
--> statement-breakpoint
alter table template_files force row level security;
--> statement-breakpoint
create policy tenant_read on template_files for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on template_files for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_delete on template_files for delete using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, delete on template_files to clinicpad_app;
--> statement-breakpoint
revoke update, truncate on template_files from clinicpad_app;
--> statement-breakpoint
create or replace function public.enforce_template_file_rules() returns trigger language plpgsql as $$
begin
  if public.tenant_is_erased(old.tenant_id) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'IMMUTABLE: template files cannot be changed' using errcode = '23000';
  end if;
  -- A file a version uses cannot be deleted (template_versions_file_fk answers 23503). A file younger than a day cannot
  -- be deleted either: a draft may be about to use it (the upload and the draft are separate requests).
  if old.created_at > now() - interval '1 day' then
    raise exception 'IMMUTABLE: a template file can be removed only when unused and older than a day' using errcode = '23000';
  end if;
  return old;
end $$;
--> statement-breakpoint
create trigger template_files_rules before update or delete on template_files
  for each row execute function public.enforce_template_file_rules();
--> statement-breakpoint

-- 2. A template's current version is one of its own published versions.
create or replace function public.enforce_template_rules() returns trigger language plpgsql as $$
declare
  v_template uuid;
  v_state text;
begin
  if new.current_version_id is not null and (tg_op = 'INSERT' or new.current_version_id is distinct from old.current_version_id) then
    select template_id, state into v_template, v_state from public.template_versions
      where id = new.current_version_id and tenant_id = new.tenant_id;
    if v_template is distinct from new.id or v_state is distinct from 'published' then
      raise exception 'IMMUTABLE: the current version of a template must be one of its published versions' using errcode = '23000';
    end if;
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger templates_rules before insert or update on templates
  for each row execute function public.enforce_template_rules();
--> statement-breakpoint

-- 3. Versions are born as drafts; a draft is a working copy (any change, or deletion); a published version never changes
--    and is never deleted while its tenant exists (so deleting a template with a published version fails too).
create or replace function public.enforce_template_version_rules() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' or new.published_at is not null or new.published_by is not null or new.content_sha256 is not null then
      raise exception 'IMMUTABLE: a template version is created as a draft and published by an update' using errcode = '23000';
    end if;
    return new;
  end if;
  if old.state = 'published' then
    if public.tenant_is_erased(old.tenant_id) then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;
    raise exception 'IMMUTABLE: a published template version cannot be changed or deleted' using errcode = '23000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
--> statement-breakpoint
create trigger template_versions_rules before insert or update or delete on template_versions
  for each row execute function public.enforce_template_version_rules();
--> statement-breakpoint

-- 4. A prescription is finalized only on a published template version (or a built-in pad: no version). Rows that are
--    already frozen are the immutability trigger's business (0005), so only the draft -> final transition is checked.
create or replace function public.enforce_rx_template_version() returns trigger language plpgsql as $$
declare
  v_state text;
begin
  if new.status = 'draft' or new.template_version_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then return new; end if;
  select state into v_state from public.template_versions where id = new.template_version_id and tenant_id = new.tenant_id;
  if v_state is distinct from 'published' then
    raise exception 'IMMUTABLE: a prescription can only be finalized on a published template version' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger prescriptions_template_version before insert or update on prescriptions
  for each row execute function public.enforce_rx_template_version();
--> statement-breakpoint

-- 5. Outputs (as 0015) plus: an output that names a template version names its prescription's own version.
create or replace function public.enforce_rx_output_target() returns trigger language plpgsql as $$
declare
  rx_status text;
  rx_template_version uuid;
begin
  select status, template_version_id into rx_status, rx_template_version from public.prescriptions
    where id = new.prescription_id and tenant_id = new.tenant_id;
  if rx_status is null then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if rx_status not in ('finalized', 'amended') then
    raise exception 'IMMUTABLE: only finalized or amended prescriptions can be printed or downloaded' using errcode = '23000';
  end if;
  if new.template_version_id is not null and new.template_version_id is distinct from rx_template_version then
    raise exception 'IMMUTABLE: an output names the template version its prescription was finalized with' using errcode = '23000';
  end if;
  return new;
end $$;
```

- [ ] **Step 10: Update the existing tests that insert template rows**

`tests/integration/tenant-fk.test.ts` — in `seedPhase0(tenant, templateVersion = 1)`, replace the two template inserts with:

```ts
  const fileId = await insertBackgroundFile(tenant, `tfk-${tenant}-${templateVersion}-${Math.random()}`);
  const [template] = await adminDb.insert(templates).values({ tenantId: tenant, name: "Tenant FK template", kind: "overlay" }).returning();
  const [version] = await adminDb
    .insert(templateVersions)
    .values({ tenantId: tenant, templateId: template.id, version: templateVersion, fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en" })
    .returning();
```

and add `import { insertBackgroundFile, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";`. In `phase0Relations`, the `template_versions.template_id -> templates (cascade)` entry inserts versions with only `{ tenantId, templateId, version: 9 }`: add `fileId: x.own.version.fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en"` to both of its `.values({ … })` calls (`crossInsert` and `sameInsert`). (The cross-tenant cases still fail on `template_versions_template_fk` because the template is foreign while the file is the caller's own.)

`tests/integration/clinical-references.test.ts` — in `world(tenantId)`, replace the template and version inserts with:

```ts
  const { templateId, versionId } = await insertTemplate(tenantId, { publish: true });
  const [template] = await adminDb.select().from(templates).where(eq(templates.id, templateId));
  const [version] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, versionId));
```

and add `import { insertTemplate } from "../helpers/templates";`. The version must be published because the test's own `finalize` helper flips a prescription that points at it (trigger 4). In "nulls only the reference … when a doctor, branch, or template of a draft is deleted", deleting a template whose version is published is now refused; change that line to delete a separate unpublished template instead:

```ts
    const spare = await insertTemplate(tenantA);
    await adminDb.update(prescriptions).set({ templateVersionId: spare.versionId }).where(eq(prescriptions.id, rx.id));
    await adminDb.delete(templates).where(eq(templates.id, spare.templateId)); // cascades to its draft version
```

(and keep the `expect(p).toMatchObject({ tenantId: tenantA, templateVersionId: null })` assertion). The other two tests keep their assertions: deleting the published version answers `23000` (from the version trigger now, the same code as before).

`tests/integration/rls-guard.test.ts` — add `"template_files"`, `"template_versions"`, `"templates"` to the `arrayContaining` list in "sees the known tenant tables".

- [ ] **Step 11: Migrate and run the tests**

```powershell
Set-Location E:\projects\clinicpad; npm run db:migrate
Set-Location E:\projects\clinicpad; npx drizzle-kit generate
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-schema.test.ts tests/integration/tenant-fk.test.ts tests/integration/clinical-references.test.ts tests/integration/rls-guard.test.ts tests/integration/schema-checks.test.ts
```

Expected: the migration applies (if 0024's guard stops it, run `npm run db:sweep-test-tenants -- --apply` and migrate again); `drizzle-kit generate` answers "No schema changes"; all five files PASS — the tenant-fk guard ("has no single-column key …") passes with no allow-list entry, rls-guard sees `template_files` forced with scoped policies, schema-checks lists the new CHECKs.

- [ ] **Step 12: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/db/schema/columns.ts src/server/db/schema/templates.ts src/server/db/schema/tenancy.ts src/server/db/schema/clinical.ts src/server/db/schema/index.ts drizzle/0024_phase2a_template_cleanup.sql drizzle/0025_phase2a_templates.sql drizzle/0026_phase2a_templates_security.sql drizzle/meta/0024_snapshot.json drizzle/meta/0025_snapshot.json drizzle/meta/0026_snapshot.json drizzle/meta/_journal.json tests/fixtures/overlay-definitions.ts tests/helpers/templates.ts tests/integration/template-schema.test.ts tests/integration/tenant-fk.test.ts tests/integration/clinical-references.test.ts tests/integration/rls-guard.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(db): template files, versions and assignment with immutable published versions (0024-0026)" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 8: Malware scanner — interface, clamd adapter, fake, container, and the logo/signature retrofit

**Gate:** the S4 finding says GO or GO-WITH-FALLBACK. Copy `CLAMAV_IMAGE`, `CLAMAV_OPTIONS`, `CLAMAV_MEM_LIMIT` from it.

**Files:**
- Create: `src/server/scanning/scanner.ts`, `src/server/scanning/clamd.ts`, `src/server/scanning/index.ts`, `src/server/scanning/uploads.ts`
- Create: `tests/helpers/fake-scanner.ts`, `tests/helpers/eicar.ts`, `tests/unit/clamd.test.ts`, `tests/unit/scanner-config.test.ts`, `tests/integration/clamav-smoke.test.ts`, `tests/integration/upload-scanning.test.ts`
- Modify: `src/server/services/pad-settings.ts` (`setClinicLogo`, `setDoctorSignature`), `tests/integration/pad-settings.test.ts`, `tests/integration/settings-actions.test.ts` (mock the scanner), `docker-compose.yml`, `.github/workflows/ci.yml`, `.env.example`, `tests/unit/engine-pins.test.ts`

**Interfaces:**
- Consumes: `recordAudit` (`src/server/services/audit.ts`), `withTenant`, `inspectImage` (`src/lib/domain/image.ts`), `fail`/`ok`/`Result`.
- Produces:
  - `type ScanOutcome = { status: "clean"; engine: string } | { status: "infected"; engine: string; signature: string } | { status: "unavailable"; reason: string }`; `interface MalwareScanner { scan(bytes: Uint8Array, opts?: { signal?: AbortSignal }): Promise<ScanOutcome>; health(): Promise<{ up: boolean; detail: string }> }`; `SCAN_LIMITS`; `SCAN_MESSAGES` (`src/server/scanning/scanner.ts`).
  - `createClamdScanner(opts: { host: string; port: number; timeoutMs?: number; healthTimeoutMs?: number }): MalwareScanner`, `parseClamdReply(text)` (`clamd.ts`).
  - `resolveScannerConfig(env)`, `scannerFor(config)`, `getMalwareScanner()` (`index.ts`).
  - `scanOrRefuse(ctx, bytes, audit: { action: string; entityType: string; kind: string; field: string }, scanner?: MalwareScanner, signal?: AbortSignal): Promise<Result<{ engine: string }>>` (`uploads.ts`) — Task 9 uses it.
  - `setClinicLogo(ctx, image, deps?: { scanner?: MalwareScanner })`, `setDoctorSignature(ctx, image, deps?)` (signatures extended, callers unchanged).
  - Tests: `createFakeScanner(next?)`, `sharedFakeScanner`, `resetFakeScanner(s)`; `EICAR` (`tests/helpers/eicar.ts`).

- [ ] **Step 1: Write the scanner types**

`src/server/scanning/scanner.ts`:

```ts
export type ScanOutcome =
  | { status: "clean"; engine: string }
  | { status: "infected"; engine: string; signature: string }
  | { status: "unavailable"; reason: string };

export type ScannerHealth = { up: boolean; detail: string };

/**
 * Scans bytes for malware before anything is stored (ADR-0046). Never throws: a scanner that is down, slow, or answers
 * something unexpected is "unavailable", and callers refuse the upload (fail closed). Injected so tests never need clamd.
 */
export interface MalwareScanner {
  scan(bytes: Uint8Array, opts?: { signal?: AbortSignal }): Promise<ScanOutcome>;
  health(): Promise<ScannerHealth>;
}

export const SCAN_LIMITS = {
  timeoutMs: 15_000,
  healthTimeoutMs: 2_000,
  maxBytes: 8 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  maxReplyBytes: 4096,
  versionCacheMs: 10 * 60_000,
} as const;

/** Shown to the user. No file names, no signature names, no infrastructure detail. */
export const SCAN_MESSAGES = {
  infected: "The virus scanner flagged this file, so it was not saved. Export the image again from the original file, or send the pad to us.",
  unavailable: "The virus scanner is not available right now, so nothing was saved. Try again in a minute.",
} as const;
```

- [ ] **Step 2: Write the failing clamd adapter test**

`tests/unit/clamd.test.ts`:

```ts
// @vitest-environment node
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createClamdScanner, parseClamdReply } from "@/server/scanning/clamd";

const VERSION = "ClamAV 1.4.1/27470/Tue Nov 18 08:25:02 2026";
const servers: Server[] = [];

/** A tiny clamd: reads "z<COMMAND>\0", for INSTREAM the length-prefixed chunks up to a zero length, then answers. */
async function fakeClamd(answer: (command: string, payload: Buffer) => string | null) {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const payload: Buffer[] = [];
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        command = buffer.subarray(1, end).toString("ascii");
        buffer = buffer.subarray(end + 1);
        if (command !== "INSTREAM") {
          const reply = answer(command, Buffer.alloc(0));
          if (reply !== null) socket.end(`${reply}\0`);
          return;
        }
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const all = Buffer.concat(payload);
          received.push(all);
          const reply = answer(command, all);
          if (reply !== null) socket.end(`${reply}\0`);
          buffer = Buffer.alloc(0);
          return;
        }
        if (buffer.length < 4 + size) return;
        payload.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, received };
}

const standard = (instream: string | null) => (command: string) =>
  command === "VERSION" ? VERSION : command === "PING" ? "PONG" : instream;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("parseClamdReply", () => {
  it.each([
    ["stream: OK\0", { kind: "clean" }],
    ["stream: Win.Test.EICAR_HDB-1 FOUND\0", { kind: "infected", signature: "Win.Test.EICAR_HDB-1" }],
    ["INSTREAM size limit exceeded. ERROR\0", { kind: "error", message: "INSTREAM size limit exceeded. ERROR" }],
    ["", { kind: "error", message: "" }],
  ])("reads %j", (reply, expected) => {
    expect(parseClamdReply(reply)).toEqual(expected);
  });
});

describe("createClamdScanner", () => {
  it("streams the bytes in length-prefixed chunks and reports clean with the engine version", async () => {
    const fake = await fakeClamd(standard("stream: OK"));
    const bytes = randomBytes(200_000);
    const outcome = await createClamdScanner({ host: "127.0.0.1", port: fake.port }).scan(bytes);
    expect(outcome).toEqual({ status: "clean", engine: VERSION });
    expect(Buffer.compare(fake.received[0], bytes)).toBe(0);
  });

  it("reports an infected file with the signature name", async () => {
    const fake = await fakeClamd(standard("stream: Win.Test.EICAR_HDB-1 FOUND"));
    expect(await createClamdScanner({ host: "127.0.0.1", port: fake.port }).scan(Buffer.from("x"))).toEqual({
      status: "infected",
      engine: VERSION,
      signature: "Win.Test.EICAR_HDB-1",
    });
  });

  it("treats an error reply, a silent scanner, a closed port, and an abort as unavailable (never clean)", async () => {
    const error = await fakeClamd(standard("INSTREAM size limit exceeded. ERROR"));
    expect((await createClamdScanner({ host: "127.0.0.1", port: error.port }).scan(Buffer.from("x"))).status).toBe("unavailable");

    const silent = await fakeClamd(standard(null));
    expect(await createClamdScanner({ host: "127.0.0.1", port: silent.port, timeoutMs: 200 }).scan(Buffer.from("x"))).toEqual({
      status: "unavailable",
      reason: "timeout",
    });

    const closed = await fakeClamd(standard("stream: OK"));
    await new Promise((resolve) => servers.pop()?.close(resolve));
    expect((await createClamdScanner({ host: "127.0.0.1", port: closed.port }).scan(Buffer.from("x"))).status).toBe("unavailable");

    const slow = await fakeClamd(standard(null));
    const controller = new AbortController();
    const pending = createClamdScanner({ host: "127.0.0.1", port: slow.port, timeoutMs: 5_000 }).scan(Buffer.from("x"), { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: "unavailable", reason: "aborted" });
  });

  it("refuses to call a file clean when the engine cannot name its version", async () => {
    const fake = await fakeClamd((command) => (command === "VERSION" ? null : "stream: OK"));
    expect((await createClamdScanner({ host: "127.0.0.1", port: fake.port, timeoutMs: 200 }).scan(Buffer.from("x"))).status).toBe("unavailable");
  });

  it("refuses empty and oversized input without connecting", async () => {
    const scanner = createClamdScanner({ host: "127.0.0.1", port: 1 });
    expect(await scanner.scan(new Uint8Array(0))).toEqual({ status: "unavailable", reason: "empty" });
    expect(await scanner.scan(new Uint8Array(8 * 1024 * 1024 + 1))).toEqual({ status: "unavailable", reason: "too large" });
  });

  it("answers health from PING", async () => {
    const fake = await fakeClamd(standard("stream: OK"));
    expect(await createClamdScanner({ host: "127.0.0.1", port: fake.port }).health()).toEqual({ up: true, detail: "PONG" });
    expect((await createClamdScanner({ host: "127.0.0.1", port: 1, healthTimeoutMs: 200 }).health()).up).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/clamd.test.ts`
Expected: FAIL — `Cannot find module '@/server/scanning/clamd'`.

- [ ] **Step 4: Implement the clamd adapter**

`src/server/scanning/clamd.ts`:

```ts
import { connect, type Socket } from "node:net";
import { SCAN_LIMITS, type MalwareScanner, type ScanOutcome } from "./scanner";

export type ClamdOptions = { host: string; port: number; timeoutMs?: number; healthTimeoutMs?: number };

type Reply = { kind: "clean" } | { kind: "infected"; signature: string } | { kind: "error"; message: string };

/** clamd answers z-commands with NUL-terminated text: "stream: OK", "stream: <signature> FOUND", or "<message> ERROR". */
export function parseClamdReply(reply: string): Reply {
  const text = reply.replace(/\0+$/, "").trim();
  if (text === "stream: OK") return { kind: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { kind: "infected", signature: found[1].slice(0, 200) };
  return { kind: "error", message: text.slice(0, 200) };
}

type Talk = { ok: true; reply: string } | { ok: false; reason: string };

/** One TCP exchange: send, read one NUL-terminated reply (at most 4 KB). Never throws; always destroys the socket. */
function talk(opts: ClamdOptions, timeoutMs: number, send: (socket: Socket) => void, signal?: AbortSignal): Promise<Talk> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "aborted" });
      return;
    }
    const socket = connect({ host: opts.host, port: opts.port });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Talk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(value);
    };
    const onAbort = () => finish({ ok: false, reason: "aborted" });
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("error", () => finish({ ok: false, reason: "unreachable" }));
    socket.on("connect", () => send(socket));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > SCAN_LIMITS.maxReplyBytes) return finish({ ok: false, reason: "reply too long" });
      chunks.push(chunk);
      if (chunk.includes(0)) finish({ ok: true, reply: Buffer.concat(chunks).toString("utf8") });
    });
    socket.on("end", () => finish(chunks.length > 0 ? { ok: true, reply: Buffer.concat(chunks).toString("utf8") } : { ok: false, reason: "closed" }));
  });
}

/**
 * Scanner backed by clamd's INSTREAM command (ADR-0046). The engine string recorded with every stored file is clamd's
 * VERSION reply (engine/signature database/date), cached for ten minutes; without it a file is never called clean.
 */
export function createClamdScanner(opts: ClamdOptions): MalwareScanner {
  const timeoutMs = opts.timeoutMs ?? SCAN_LIMITS.timeoutMs;
  let version: { text: string; at: number } | null = null;

  async function engine(signal?: AbortSignal): Promise<string | null> {
    if (version && Date.now() - version.at < SCAN_LIMITS.versionCacheMs) return version.text;
    const result = await talk(opts, timeoutMs, (s) => s.end("zVERSION\0"), signal);
    const text = result.ok ? result.reply.replace(/\0+$/, "").trim().slice(0, 200) : "";
    if (!/^ClamAV \S+/.test(text)) return null;
    version = { text, at: Date.now() };
    return text;
  }

  return {
    async scan(bytes, scanOpts = {}): Promise<ScanOutcome> {
      if (bytes.length === 0) return { status: "unavailable", reason: "empty" };
      if (bytes.length > SCAN_LIMITS.maxBytes) return { status: "unavailable", reason: "too large" };
      const name = await engine(scanOpts.signal);
      if (name === null) return { status: "unavailable", reason: scanOpts.signal?.aborted ? "aborted" : "no engine version" };
      const result = await talk(
        opts,
        timeoutMs,
        (socket) => {
          socket.write("zINSTREAM\0");
          for (let at = 0; at < bytes.length; at += SCAN_LIMITS.chunkBytes) {
            const part = bytes.subarray(at, Math.min(bytes.length, at + SCAN_LIMITS.chunkBytes));
            const head = Buffer.alloc(4);
            head.writeUInt32BE(part.length);
            socket.write(head);
            socket.write(part);
          }
          socket.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
        },
        scanOpts.signal,
      );
      if (!result.ok) return { status: "unavailable", reason: result.reason };
      const reply = parseClamdReply(result.reply);
      if (reply.kind === "clean") return { status: "clean", engine: name };
      if (reply.kind === "infected") return { status: "infected", engine: name, signature: reply.signature };
      return { status: "unavailable", reason: reply.message };
    },
    async health() {
      const result = await talk(opts, opts.healthTimeoutMs ?? SCAN_LIMITS.healthTimeoutMs, (s) => s.end("zPING\0"));
      const text = result.ok ? result.reply.replace(/\0+$/, "").trim() : "";
      return text === "PONG" ? { up: true, detail: "PONG" } : { up: false, detail: result.ok ? "unexpected reply" : result.reason };
    },
  };
}
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/clamd.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing configuration test**

`tests/unit/scanner-config.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveScannerConfig, scannerFor } from "@/server/scanning";

describe("resolveScannerConfig", () => {
  it("defaults to the local container in development", () => {
    expect(resolveScannerConfig({ NODE_ENV: "development" })).toEqual({ ok: true, host: "127.0.0.1", port: 3310 });
  });

  it("requires both host and port in production", () => {
    expect(resolveScannerConfig({ NODE_ENV: "production" }).ok).toBe(false);
    expect(resolveScannerConfig({ NODE_ENV: "production", CLAMAV_HOST: "clamav.internal" }).ok).toBe(false);
    expect(resolveScannerConfig({ NODE_ENV: "production", CLAMAV_HOST: "clamav.internal", CLAMAV_PORT: "3310" })).toEqual({
      ok: true,
      host: "clamav.internal",
      port: 3310,
    });
  });

  it("allows the development switch only outside production", () => {
    expect(resolveScannerConfig({ NODE_ENV: "development", CLAMAV_DISABLED_FOR_DEVELOPMENT: "1" })).toEqual({ ok: true, disabled: true });
    expect(resolveScannerConfig({ NODE_ENV: "production", CLAMAV_DISABLED_FOR_DEVELOPMENT: "1", CLAMAV_HOST: "h", CLAMAV_PORT: "3310" }).ok).toBe(false);
  });

  it.each(["0", "65536", "33 10", "abc", "-1"])("refuses the port %j", (port) => {
    expect(resolveScannerConfig({ NODE_ENV: "development", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: port }).ok).toBe(false);
  });

  it.each(["has space", "a/b", "x".repeat(254)])("refuses the host %j", (host) => {
    expect(resolveScannerConfig({ NODE_ENV: "development", CLAMAV_HOST: host, CLAMAV_PORT: "3310" }).ok).toBe(false);
  });
});

describe("scannerFor", () => {
  it("refuses every upload when the scanner is not configured", async () => {
    const scanner = scannerFor({ ok: false, detail: "CLAMAV_HOST and CLAMAV_PORT are not set" });
    expect(await scanner.scan(Buffer.from("x"))).toEqual({ status: "unavailable", reason: "CLAMAV_HOST and CLAMAV_PORT are not set" });
    expect((await scanner.health()).up).toBe(false);
  });

  it("passes everything as 'unscanned-development' only when explicitly disabled", async () => {
    expect(await scannerFor({ ok: true, disabled: true }).scan(Buffer.from("x"))).toEqual({ status: "clean", engine: "unscanned-development" });
  });
});
```

- [ ] **Step 6: Implement the configuration**

`src/server/scanning/index.ts`:

```ts
import { createClamdScanner } from "./clamd";
import type { MalwareScanner } from "./scanner";

type ScannerEnv = { NODE_ENV?: string; CLAMAV_HOST?: string; CLAMAV_PORT?: string; CLAMAV_DISABLED_FOR_DEVELOPMENT?: string };

export type ScannerConfig = { ok: true; host: string; port: number } | { ok: true; disabled: true } | { ok: false; detail: string };

/**
 * CLAMAV_HOST and CLAMAV_PORT: mandatory in production (like GOTENBERG_URL), the local container otherwise.
 * CLAMAV_DISABLED_FOR_DEVELOPMENT=1 skips scanning on a development machine; in production it is a configuration
 * error, so every upload is refused (fail closed).
 */
export function resolveScannerConfig(env: ScannerEnv): ScannerConfig {
  const production = env.NODE_ENV === "production";
  if ((env.CLAMAV_DISABLED_FOR_DEVELOPMENT ?? "").trim() === "1") {
    return production ? { ok: false, detail: "CLAMAV_DISABLED_FOR_DEVELOPMENT is not allowed in production" } : { ok: true, disabled: true };
  }
  const host = (env.CLAMAV_HOST ?? "").trim();
  const portText = (env.CLAMAV_PORT ?? "").trim();
  if (host === "" || portText === "") {
    if (production) return { ok: false, detail: "CLAMAV_HOST and CLAMAV_PORT are not set" };
    if (host === "" && portText === "") return { ok: true, host: "127.0.0.1", port: 3310 };
  }
  const port = Number(portText || "3310");
  if (!/^\d{1,5}$/.test(portText || "3310") || port < 1 || port > 65535) return { ok: false, detail: "CLAMAV_PORT must be a port number" };
  const name = host || "127.0.0.1";
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(name)) return { ok: false, detail: "CLAMAV_HOST must be a host name or an IPv4 address" };
  return { ok: true, host: name, port };
}

let warned = false;

export function scannerFor(config: ScannerConfig): MalwareScanner {
  if (!config.ok) {
    return {
      async scan() {
        return { status: "unavailable", reason: config.detail };
      },
      async health() {
        return { up: false, detail: config.detail };
      },
    };
  }
  if ("disabled" in config) {
    if (!warned) {
      warned = true;
      console.warn("[scan] CLAMAV_DISABLED_FOR_DEVELOPMENT=1: uploads are stored WITHOUT a malware scan (development only)");
    }
    return {
      async scan() {
        return { status: "clean", engine: "unscanned-development" };
      },
      async health() {
        return { up: true, detail: "disabled for development" };
      },
    };
  }
  return createClamdScanner({ host: config.host, port: config.port });
}

let scanner: MalwareScanner | null = null;

/** The process-wide scanner, configured from the environment (see resolveScannerConfig). */
export function getMalwareScanner(): MalwareScanner {
  if (scanner === null) {
    scanner = scannerFor(
      resolveScannerConfig({
        NODE_ENV: process.env.NODE_ENV,
        CLAMAV_HOST: process.env.CLAMAV_HOST,
        CLAMAV_PORT: process.env.CLAMAV_PORT,
        CLAMAV_DISABLED_FOR_DEVELOPMENT: process.env.CLAMAV_DISABLED_FOR_DEVELOPMENT,
      }),
    );
  }
  return scanner;
}
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/scanner-config.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the upload helper, the fake scanner, and the EICAR helper**

`src/server/scanning/uploads.ts`:

```ts
import { fail, ok, type Result } from "@/lib/result";
import { withTenant } from "@/server/db/tenant";
import { recordAudit } from "@/server/services/audit";
import type { ServiceContext } from "@/server/services/context";
import { getMalwareScanner } from "./index";
import { SCAN_MESSAGES, type MalwareScanner } from "./scanner";

export type ScanAudit = { action: string; entityType: string; kind: string; field: string };

/**
 * Scans uploaded bytes BEFORE any transaction opens (a scan can take seconds). Infected: refused and audited with the
 * signature name (not personal data). Scanner unavailable: refused, logged with a short reason, not audited (not the
 * user's doing). Nothing is ever stored unscanned, so there is no quarantine state.
 */
export async function scanOrRefuse(
  ctx: ServiceContext,
  bytes: Uint8Array,
  audit: ScanAudit,
  scanner: MalwareScanner = getMalwareScanner(),
  signal?: AbortSignal,
): Promise<Result<{ engine: string }>> {
  const outcome = await scanner.scan(bytes, { signal });
  if (outcome.status === "clean") return ok({ engine: outcome.engine });
  if (outcome.status === "infected") {
    await withTenant(ctx.tenantId, (tx) =>
      recordAudit(tx, ctx, {
        action: audit.action,
        entityType: audit.entityType,
        after: { kind: audit.kind, reasonCode: "infected", signature: outcome.signature, byteSize: bytes.length, scanEngine: outcome.engine },
      }),
    );
    return fail("invalid", SCAN_MESSAGES.infected, audit.field);
  }
  console.warn(`[scan] upload refused: scanner unavailable (${outcome.reason.slice(0, 80)})`);
  return fail("unavailable", SCAN_MESSAGES.unavailable, audit.field);
}
```

`tests/helpers/fake-scanner.ts`:

```ts
import type { MalwareScanner, ScanOutcome } from "@/server/scanning/scanner";

export type FakeScanner = MalwareScanner & { calls: number; sizes: number[]; next: ScanOutcome; up: boolean };

const CLEAN: ScanOutcome = { status: "clean", engine: "fake-scanner 1.0" };

export function createFakeScanner(next: ScanOutcome = CLEAN): FakeScanner {
  const scanner: FakeScanner = {
    calls: 0,
    sizes: [],
    next,
    up: true,
    async scan(bytes) {
      scanner.calls += 1;
      scanner.sizes.push(bytes.length);
      return scanner.next;
    },
    async health() {
      return scanner.up ? { up: true, detail: "fake" } : { up: false, detail: "fake down" };
    },
  };
  return scanner;
}

/** One instance for vi.mock("@/server/scanning") factories and the tests that inspect it. */
export const sharedFakeScanner = createFakeScanner();

export function resetFakeScanner(scanner: FakeScanner): void {
  scanner.calls = 0;
  scanner.sizes.length = 0;
  scanner.next = CLEAN;
  scanner.up = true;
}
```

`tests/helpers/eicar.ts` (implemented in Task 8; the committed file is the reference, not this plan): exports `EICAR: Buffer`, assembled at run time by joining five short fragments, so neither a contiguous EICAR string nor its plain base64 appears anywhere in the repository (Windows Defender quarantines such files). Do not paste the string into plans, tests, docs or spikes: import the helper.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinicAssets } from "@/server/db/schema";
import { setClinicLogo, setDoctorSignature } from "@/server/services/pad-settings";
import { SCAN_MESSAGES } from "@/server/scanning/scanner";
import { createFakeScanner, resetFakeScanner } from "../helpers/fake-scanner";
import { makePng } from "../helpers/images";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const scanner = createFakeScanner();

beforeAll(async () => {
  A = await createTestTenant("upload-scan");
});
afterAll(async () => {
  await A.cleanup();
});
beforeEach(() => resetFakeScanner(scanner));

const assetsOf = () => adminDb.select({ id: clinicAssets.id }).from(clinicAssets).where(eq(clinicAssets.tenantId, A.tenantId));

describe("logo and signature uploads are scanned before anything is stored", () => {
  it("stores a clean logo and scans it exactly once", async () => {
    const result = await setClinicLogo(A.as("owner"), { bytes: makePng(120, 60, [1, 2, 3]) }, { scanner });
    expect(result.ok).toBe(true);
    expect(scanner.calls).toBe(1);
  });

  it("refuses an infected signature, stores nothing, and audits the signature name", async () => {
    scanner.next = { status: "infected", engine: "fake-scanner 1.0", signature: "Win.Test.EICAR_HDB-1" };
    const before = (await assetsOf()).length;
    const result = await setDoctorSignature(A.as("doctor"), { bytes: makePng(200, 80, [9, 9, 9]) }, { scanner });
    expect(result).toEqual({ ok: false, code: "invalid", message: SCAN_MESSAGES.infected, field: "image" });
    expect((await assetsOf()).length).toBe(before);
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "upload.rejected")));
    expect(event.after).toMatchObject({ kind: "signature", reasonCode: "infected", signature: "Win.Test.EICAR_HDB-1" });
  });

  it("refuses when the scanner is unavailable, stores nothing, and does not audit", async () => {
    scanner.next = { status: "unavailable", reason: "timeout" };
    const before = (await assetsOf()).length;
    const result = await setClinicLogo(A.as("owner"), { bytes: makePng(121, 60, [4, 5, 6]) }, { scanner });
    expect(result).toMatchObject({ ok: false, code: "unavailable", field: "image" });
    expect((await assetsOf()).length).toBe(before);
  });

  it("does not scan a file that is not an image at all", async () => {
    const result = await setClinicLogo(A.as("owner"), { bytes: new TextEncoder().encode("<svg onload=alert(1)>") }, { scanner });
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "image" });
    expect(scanner.calls).toBe(0);
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/upload-scanning.test.ts`
Expected: FAIL — `setClinicLogo` ignores the third argument, so the infected and unavailable cases store an asset.

- [ ] **Step 9: Scan logo and signature uploads**

In `src/server/services/pad-settings.ts` add the imports:

```ts
import { inspectImage } from "@/lib/domain/image";
import type { MalwareScanner } from "@/server/scanning/scanner";
import { scanOrRefuse } from "@/server/scanning/uploads";
```

Change `export async function setClinicLogo(ctx: ServiceContext, image: UploadedImage | null)` to take `deps: { scanner?: MalwareScanner } = {}` as a third parameter and insert, right after its `if (!can(ctx.role, "settings.clinic")) return fail("forbidden", CLINIC_FORBIDDEN);` line:

```ts
  let scanned: ScannedImage | null = null;
  if (image !== null) {
    // Not an image: refused without a scan. Otherwise strip metadata and re-inspect FIRST, then scan the original AND the
    // stripped bytes (before any transaction); the stripped bytes are what storeImageAsset stores, so the stored bytes
    // are exactly bytes the scanner saw (fix round 1).
    const result = await scanImage(ctx, image, "clinic", "logo", deps.scanner);
    if (!result.ok) return result;
    scanned = result.value; // { bytes: stripped, engine }
  }
```

Do the same in `setDoctorSignature` (after its `settings.profile` permission check), with `{ action: "upload.rejected", entityType: "doctor", kind: "signature", field: "image" }`. The transaction calls `storeImageAsset` with the stripped bytes (it strips again, a no-op), and the `logo_set` / `signature_set` audit payload records `scanEngine`, which also marks a development-bypass upload (`unscanned-development`).

In `tests/integration/pad-settings.test.ts` and `tests/integration/settings-actions.test.ts`, add `vi` to the `vitest` import if missing and put this block right after the imports' `vi.mock` lines (or at the top, before other imports, if the file has none):

```ts
vi.mock("@/server/scanning", async () => {
  const { sharedFakeScanner } = await import("../helpers/fake-scanner");
  return { getMalwareScanner: () => sharedFakeScanner };
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/upload-scanning.test.ts tests/integration/pad-settings.test.ts tests/integration/settings-actions.test.ts`
Expected: PASS.

- [ ] **Step 10: Add the ClamAV container, CI service, smoke test, and pin test**

`docker-compose.yml` — add this service after `gotenberg`, using the S4 values (`CLAMAV_IMAGE`, `CLAMAV_OPTIONS`, `CLAMAV_MEM_LIMIT`; if S4 found that `cap_drop: ALL` works without additions, delete the `cap_add` block), and add `clinicpad_clamav:` under `volumes:`:

```yaml
  clamav:
    # Malware scanner for uploads (Plan 2A, ADR-0046). Pinned by digest: docs/spikes/2026-11-18-s4-clamav.md.
    # clamd reads only bytes the app streams to it (INSTREAM). freshclam in the same container updates signatures and
    # needs egress to the ClamAV mirror; split it into its own container before patient documents are stored (2C) so
    # the container that reads hostile files has no network (spec section 8.3).
    # Bound to loopback only: clamd has no authentication. First start downloads signatures (several minutes).
    image: clamav/clamav:1.4@sha256:<CLAMAV digest from the S4 finding>
    container_name: clinicpad-clamav
    restart: unless-stopped
    ports:
      - "127.0.0.1:3310:3310"
    volumes:
      - clinicpad_clamav:/var/lib/clamav
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
      - DAC_OVERRIDE
    security_opt:
      - no-new-privileges:true
    mem_limit: 2g
    pids_limit: 256
    healthcheck:
      test: ["CMD", "clamdcheck.sh"]
      interval: 30s
      timeout: 10s
      retries: 20
      start_period: 300s
```

(The image reference line must equal `CLAMAV_IMAGE` from the finding exactly, tag and digest; `mem_limit` is `CLAMAV_MEM_LIMIT`.)

`.github/workflows/ci.yml` — add to the job `env:` block `CLAMAV_HOST: 127.0.0.1`, `CLAMAV_PORT: "3310"`, `CLAMAV_REQUIRED: "1"`, and these two steps right before `- run: npm run test` (same image and options as compose; keep them in sync):

```yaml
      # Same image and options as the clamav service in docker-compose.yml; keep them in sync.
      - run: >-
          docker run -d --name clamav -p 127.0.0.1:3310:3310
          --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE
          --security-opt no-new-privileges:true --memory 2g --pids-limit 256
          clamav/clamav:1.4@sha256:<CLAMAV digest from the S4 finding>
      - run: |
          for i in $(seq 1 90); do printf 'zPING\0' | timeout 2 nc 127.0.0.1 3310 | grep -q PONG && break; sleep 5; done
          printf 'zPING\0' | timeout 2 nc 127.0.0.1 3310 | grep -q PONG
```

`.env.example` — replace the two lines `CLAMAV_HOST=localhost` and `CLAMAV_PORT=3310` with:

```
# Malware scanning of uploads (Plan 2A): `docker compose up -d clamav` (the first start downloads signatures).
# Both are mandatory in production. CLAMAV_DISABLED_FOR_DEVELOPMENT=1 stores uploads WITHOUT a scan on a development
# machine only; in production it makes every upload fail (fail closed).
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
CLAMAV_DISABLED_FOR_DEVELOPMENT=
```

`tests/unit/engine-pins.test.ts` — add inside the `describe`:

```ts
  it("pins ClamAV to one tag and digest in compose and CI", () => {
    const found = FILES.map(read).flatMap((t) => pinsOf(t, "clamav/clamav"));
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(new Set(found).size, found.join("\n")).toBe(1);
    expect(found[0]).toMatch(/^clamav\/clamav:[0-9.]+@sha256:[0-9a-f]{64}$/);
  });
```

`tests/integration/clamav-smoke.test.ts`:

```ts
// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createClamdScanner } from "@/server/scanning/clamd";
import { EICAR } from "../helpers/eicar";
import { makePng } from "../helpers/images";

const run = promisify(execFile);
const host = process.env.CLAMAV_HOST ?? "127.0.0.1";
const port = Number(process.env.CLAMAV_PORT ?? 3310);
const scanner = createClamdScanner({ host, port, timeoutMs: 60_000 });
const health = await scanner.health();
// CI (or CLAMAV_REQUIRED=1) must never go green without real scanner coverage.
const required = process.env.CI === "true" || process.env.CLAMAV_REQUIRED === "1";
if (!health.up) console.warn(`SKIP clamav-smoke: clamd is not reachable at ${host}:${port} (${health.detail}). Run "docker compose up -d clamav".`);

describe.runIf(required && !health.up)("ClamAV is required here", () => {
  it(`is reachable at ${host}:${port}`, () => {
    throw new Error(`ClamAV is required (CI or CLAMAV_REQUIRED=1) but not reachable at ${host}:${port}: ${health.detail}`);
  });
});

describe.runIf(health.up)("clamd", () => {
  it("names its engine and signature database", async () => {
    const outcome = await scanner.scan(makePng(32, 32));
    expect(outcome).toMatchObject({ status: "clean", engine: expect.stringMatching(/^ClamAV \S+\/\d+\//) });
  });

  it("flags the EICAR test file", async () => {
    expect(await scanner.scan(EICAR)).toMatchObject({ status: "infected" });
  });

  it("runs with the isolation this repo configures (config drift)", async ({ skip }) => {
    let inspected: string | null = null;
    for (const name of ["clinicpad-clamav", "clamav"]) {
      try {
        inspected = (await run("docker", ["inspect", name, "--format", "{{json .HostConfig}}"])).stdout;
        break;
      } catch {
        inspected = null;
      }
    }
    if (inspected === null) {
      if (required) throw new Error("config drift check needs a local container named clinicpad-clamav or clamav (CLAMAV_REQUIRED or CI is set).");
      skip();
      return;
    }
    const config = JSON.parse(inspected) as { CapDrop: string[] | null; SecurityOpt: string[] | null; PortBindings: Record<string, { HostIp: string }[]> };
    expect(config.CapDrop).toContain("ALL");
    expect(config.SecurityOpt).toContain("no-new-privileges:true");
    for (const bindings of Object.values(config.PortBindings ?? {})) for (const b of bindings) expect(b.HostIp).toBe("127.0.0.1");
  });
});
```

- [ ] **Step 11: Run the container and every changed test**

```powershell
Set-Location E:\projects\clinicpad; docker compose up -d clamav
Set-Location E:\projects\clinicpad; docker compose ps clamav
Set-Location E:\projects\clinicpad; $env:CLAMAV_REQUIRED="1"; npx vitest run tests/integration/clamav-smoke.test.ts tests/unit/engine-pins.test.ts tests/unit/clamd.test.ts tests/unit/scanner-config.test.ts
```

Expected: `docker compose ps` shows `clinicpad-clamav` healthy (wait for the health check; the first start takes minutes); all four files PASS.

- [ ] **Step 12: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/scanning/scanner.ts src/server/scanning/clamd.ts src/server/scanning/index.ts src/server/scanning/uploads.ts src/server/services/pad-settings.ts tests/helpers/fake-scanner.ts tests/helpers/eicar.ts tests/unit/clamd.test.ts tests/unit/scanner-config.test.ts tests/unit/engine-pins.test.ts tests/integration/clamav-smoke.test.ts tests/integration/upload-scanning.test.ts tests/integration/pad-settings.test.ts tests/integration/settings-actions.test.ts docker-compose.yml .github/workflows/ci.yml .env.example
Set-Location E:\projects\clinicpad; git commit -m "feat(security): ClamAV scanning of uploads, fail closed, retrofitted to logo and signature" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 9: Upload pipeline — background limits, quotas, garbage collection, upload and file routes

**Files:**
- Modify: `src/lib/domain/image.ts` (`SizeLimits`, `inspectImage(bytes, limits)`, `BACKGROUND_LIMITS`, `inspectBackground`), `src/lib/domain/permissions.ts` + `tests/unit/permissions.test.ts` (`template.*` actions), `src/server/pdf/gotenberg.ts` (use the shared `readCapped`), `src/middleware.ts`, `next.config.ts`, `tests/unit/image.test.ts`
- Create: `src/server/http/read-capped.ts`, `src/server/http/upload-limits.ts`, `src/server/services/template-files.ts`, `src/app/(app)/templates/uploads/route.ts`, `src/app/(app)/templates/files/[fileId]/route.ts`
- Test: `tests/unit/read-capped.test.ts`, `tests/integration/template-files.test.ts`, `tests/integration/template-upload-route.test.ts`

**Interfaces:**
- Consumes: `scanOrRefuse` (Task 8), `templateFiles`, `templateVersions` (Task 7), `stripImageMetadata`, `createRateLimiter`, `crossSiteRefusal`, `statusForError`, `publicCode`, `getSessionContext`, `pgErrorInfo`.
- Produces:
  - `type SizeLimits = { maxBytes: number; minSide: number; maxSide: number }`; `inspectImage(bytes: Uint8Array, limits?: SizeLimits): ImageCheck` (default `IMAGE_LIMITS`, behaviour unchanged); `BACKGROUND_LIMITS = { maxBytes: 2097152, minLongSide: 1100, maxLongSide: 3600, aspect: Math.SQRT2, aspectTolerance: 0.0425 }`; `inspectBackground(bytes): ImageCheck`.
  - `readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<ArrayBuffer | "too_large">` (`src/server/http/read-capped.ts`).
  - `templateUploadLimiter` (`src/server/http/upload-limits.ts`).
  - `src/server/services/template-files.ts`: `TEMPLATE_QUOTAS = { activeTemplates: 20, versions: 100, fileBytes: 52428800 }`, `UNUSED_FILE_DAYS = 30`, `lockTemplateQuota(tx, tenantId): Promise<void>`, `type StoredTemplateFile = { id: string; mime: ImageMime; width: number; height: number; byteSize: number; reused: boolean }`, `uploadBackground(ctx, bytes, deps?: { scanner?: MalwareScanner; now?: Date; quotaBytes?: number }): Promise<Result<StoredTemplateFile>>`, `type LoadedTemplateFile = { id; mime: ImageMime; width; height; sha256; bytes: Buffer }`, `loadTemplateFileIn(tx, tenantId, fileId): Promise<LoadedTemplateFile | null>` (re-hashes the bytes; null on mismatch), `fileAsImageAsset(file): ImageAsset`, `getTemplateFile(ctx, fileId): Promise<Result<LoadedTemplateFile>>`, `TEMPLATE_UPLOAD_MESSAGES`.
  - Routes: `POST /templates/uploads` (body = the image bytes, `Content-Type: application/octet-stream`) → `201 { fileId, width, height, byteSize, reused }` or `{ error, message, field? }`; `GET /templates/files/<fileId>` → the image.

- [ ] **Step 1: Write the failing image-limit tests**

Append to `tests/unit/image.test.ts` (it already imports from `@/lib/domain/image` and `../helpers/images`; add `inspectBackground`, `BACKGROUND_LIMITS` to the first import and `makeJpegCustom` to the second if missing):

```ts
describe("inspectBackground (pad backgrounds)", () => {
  it("accepts A4 and A5 proportioned PNG and JPEG scans", () => {
    expect(inspectBackground(makePng(1240, 1754))).toEqual({ ok: true, info: { mime: "image/png", width: 1240, height: 1754 } });
    expect(inspectBackground(makeJpegCustom(1654, 2339))).toEqual({ ok: true, info: { mime: "image/jpeg", width: 1654, height: 2339 } });
  });

  it.each([
    ["too small (long side under 1,100 px)", makePng(700, 990), "too small for a pad"],
    ["too large (long side over 3,600 px)", makeJpegCustom(2600, 3700), "too large"],
    ["US Letter proportions", makePng(850, 1100), "A4 or A5 proportions"],
    ["a square phone photo", makeJpegCustom(1500, 1500), "A4 or A5 proportions"],
    ["a sideways (landscape) scan", makePng(1754, 1240), "upright"],
    ["a 1 x 10,000 strip", makeJpegCustom(1, 10000), "too large"],
    ["bytes hidden after the PNG end", Buffer.concat([makePng(1240, 1754), Buffer.from("MZ payload")]), "extra data after its end"],
  ])("refuses %s", (_label, bytes, message) => {
    const check = inspectBackground(bytes);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain(message);
  });

  it("refuses more than 2 MB before looking at the content", () => {
    const check = inspectBackground(new Uint8Array(BACKGROUND_LIMITS.maxBytes + 1));
    expect(check).toEqual({ ok: false, message: "The image is larger than 2 MB." });
  });

  it("keeps the logo and signature limits unchanged", () => {
    expect(inspectImage(makePng(1240, 1754)).ok).toBe(false);
    expect(inspectImage(makePng(1000, 500)).ok).toBe(true);
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/image.test.ts`
Expected: FAIL — `inspectBackground` is not exported.

- [ ] **Step 2: Implement the parameterised limits**

In `src/lib/domain/image.ts`:
- Below `IMAGE_LIMITS`, add:

```ts
export type SizeLimits = { maxBytes: number; minSide: number; maxSide: number };

/**
 * Pad backgrounds (Plan 2A). Embedded into every printed document and PDF, so bounded; portrait A-series proportions
 * (A4 and A5 share 1 : 1.414). Keep in step with the template_files CHECKs (0025).
 */
export const BACKGROUND_LIMITS = { maxBytes: 2 * 1024 * 1024, minLongSide: 1100, maxLongSide: 3600, aspect: Math.SQRT2, aspectTolerance: 0.0425 } as const;

const BACKGROUND_SIZE: SizeLimits = { maxBytes: BACKGROUND_LIMITS.maxBytes, minSide: 1, maxSide: BACKGROUND_LIMITS.maxLongSide };

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MB` : `${bytes / 1024} KB`;
}
```

- Change `function withSize(mime: ImageMime, width: number, height: number): ImageCheck` to `function withSize(mime: ImageMime, width: number, height: number, limits: SizeLimits): ImageCheck` and its first line to `const { minSide, maxSide } = limits;`.
- Change `inspectPng(b: Uint8Array)` and `inspectJpeg(b: Uint8Array)` to take `limits: SizeLimits` as a second parameter and pass it to their `withSize(…)` calls.
- Replace `inspectImage` with:

```ts
export function inspectImage(bytes: Uint8Array, limits: SizeLimits = IMAGE_LIMITS): ImageCheck {
  if (bytes.length === 0) return fail("The file is empty.");
  if (bytes.length > limits.maxBytes) return fail(`The image is larger than ${sizeText(limits.maxBytes)}.`);
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return inspectPng(bytes, limits);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return inspectJpeg(bytes, limits);
  return fail(NOT_AN_IMAGE);
}

/**
 * A pad background: PNG or JPEG identified from its bytes, at most 2 MB, upright, long side 1,100 to 3,600 px
 * (about 130 to 430 dpi on A4), and A-series proportions within 3 %, so it is never stretched on the page.
 */
export function inspectBackground(bytes: Uint8Array): ImageCheck {
  const check = inspectImage(bytes, BACKGROUND_SIZE);
  if (!check.ok) return check;
  const { width, height } = check.info;
  if (width > height) return fail("Rotate the image so the pad stands upright (portrait), then upload it again.");
  if (height < BACKGROUND_LIMITS.minLongSide) {
    return fail(`The image is too small for a pad: use at least ${BACKGROUND_LIMITS.minLongSide} pixels on the long side (scan at 150 dpi or more).`);
  }
  if (Math.abs(height / width - BACKGROUND_LIMITS.aspect) > BACKGROUND_LIMITS.aspectTolerance) {
    return fail("Crop the image to the edges of the pad: it must have A4 or A5 proportions (1 : 1.41).");
  }
  return check;
}
```

(`512 * 1024` still reads "512 KB", so existing messages and tests are unchanged.)

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/image.test.ts`
Expected: PASS (the 1 × 10,000 strip fails `maxSide` 3,600 first with "too large").

- [ ] **Step 3: Write the failing `readCapped` test, then move the function**

`tests/unit/read-capped.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readCapped } from "@/server/http/read-capped";

function stream(chunks: number, size: number) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(pulled));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, pulled: () => pulled, cancelled: () => cancelled };
}

describe("readCapped", () => {
  it("returns every byte up to and including the cap", async () => {
    const s = stream(4, 256);
    const out = await readCapped(s.body, 1024);
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect((out as ArrayBuffer).byteLength).toBe(1024);
    expect(new Uint8Array(out as ArrayBuffer)[1023]).toBe(4);
  });

  it("stops reading and cancels the stream once the cap is exceeded", async () => {
    const s = stream(1000, 64 * 1024);
    expect(await readCapped(s.body, 2 * 1024 * 1024)).toBe("too_large");
    expect(s.pulled()).toBeLessThan(40);
    expect(s.cancelled()).toBe(true);
  });

  it("reads a missing body as empty", async () => {
    expect(((await readCapped(null, 10)) as ArrayBuffer).byteLength).toBe(0);
  });
});
```

`src/server/http/read-capped.ts`:

```ts
/**
 * Reads a body while counting bytes; stops reading (and cancels the stream) once `maxBytes` is exceeded, so a client or
 * a service can never make the server buffer more than the cap. A missing body reads as empty.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<ArrayBuffer | "too_large"> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  const buffer = new ArrayBuffer(total);
  const out = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}
```

In `src/server/pdf/gotenberg.ts`: delete the private `readCapped` function (and its doc comment), add `import { readCapped } from "@/server/http/read-capped";`, and change its two calls from `readCapped(response, maxBytes)` / `readCapped(response, 4096)` to `readCapped(response.body, maxBytes)` / `readCapped(response.body, 4096)`.

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/read-capped.test.ts tests/unit/gotenberg.test.ts`
Expected: PASS (the Gotenberg engine tests are unchanged).

- [ ] **Step 4: Write the failing service test**

`tests/integration/template-files.test.ts`:

```ts
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
  });

  it("reuses the stored row for identical bytes", async () => {
    const bytes = backgroundPng("upload-dup");
    const first = await uploadBackground(owner(), bytes, { scanner });
    const second = await uploadBackground(owner(), bytes, { scanner });
    expect(first.ok && second.ok && second.value.id === first.value.id && second.value.reused).toBe(true);
  });

  it("refuses roles without template.write before scanning", async () => {
    expect(await uploadBackground(A.as("reception"), backgroundPng("r"), { scanner })).toMatchObject({ ok: false, code: "forbidden" });
    expect(scanner.calls).toBe(0);
  });

  it("refuses non-images and wrong proportions without scanning, and audits the refusal", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await uploadBackground(owner(), svg, { scanner })).toMatchObject({ ok: false, code: "invalid", field: "file" });
    expect(await uploadBackground(owner(), makePng(1200, 1200), { scanner })).toMatchObject({ ok: false, code: "invalid", field: "file" });
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
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-files.test.ts`
Expected: FAIL — `Cannot find module '@/server/services/template-files'`.

- [ ] **Step 5: Add the `template.*` actions the services check**

(Task 15 adds the `designer` role to these rows; the services need the actions now.) In `src/lib/domain/permissions.ts`, add after `"settings.profile": ["owner", "doctor"],`:

```ts
  // Plan 2A Template Studio. Doctors write and assign only within their own profile (checked in the services).
  "template.read": ["owner", "doctor"],
  "template.write": ["owner", "doctor"],
  "template.publish": ["owner"],
  "template.assign": ["owner", "doctor"],
```

`tests/unit/permissions.test.ts` has a typed `granted: Record<Action, readonly string[]>` matrix, so typecheck fails until the same four rows are added there (after `"settings.profile"`):

```ts
    "template.read": ["owner", "doctor"],
    "template.write": ["owner", "doctor"],
    "template.publish": ["owner"],
    "template.assign": ["owner", "doctor"],
```

- [ ] **Step 6: Implement the file service**

`src/server/services/template-files.ts`:

```ts
import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { inspectBackground, stripImageMetadata, type ImageMime } from "@/lib/domain/image";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, ok, type Result } from "@/lib/result";
import type { ImageAsset } from "@/lib/rx-render/types";
import { templateFiles, templateVersions } from "@/server/db/schema";
import { pgErrorInfo } from "@/server/db/errors";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import type { MalwareScanner } from "@/server/scanning/scanner";
import { scanOrRefuse } from "@/server/scanning/uploads";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";

/** Per-tenant limits (decision 7), exact under lockTemplateQuota(). */
export const TEMPLATE_QUOTAS = { activeTemplates: 20, versions: 100, fileBytes: 50 * 1024 * 1024 } as const;
/** Files no version uses are deleted at the next upload once they are this old (the database refuses younger than a day). */
export const UNUSED_FILE_DAYS = 30;

export const TEMPLATE_UPLOAD_MESSAGES = {
  forbidden: "You cannot upload pad templates.",
  damaged: "The image file is damaged. Export it again as a PNG or JPEG.",
  quota: `This clinic has used its ${TEMPLATE_QUOTAS.fileBytes / 1024 / 1024} MB for pad images. Delete pads you never published, or ask us to raise the limit.`,
  notFound: "File not found.",
} as const;

export type StoredTemplateFile = { id: string; mime: ImageMime; width: number; height: number; byteSize: number; reused: boolean };
export type LoadedTemplateFile = { id: string; mime: ImageMime; width: number; height: number; sha256: string; bytes: Buffer };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Serializes everything that counts against a clinic's template quotas (files, templates, versions). Take it before
 * any row lock (decision 20). Released at commit.
 */
export async function lockTemplateQuota(tx: TenantTx, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`clinicpad:template-quota:${tenantId}`}, 0))`);
}

async function audit(ctx: ServiceContext, action: string, after: Record<string, unknown>): Promise<void> {
  await withTenant(ctx.tenantId, (tx) => recordAudit(tx, ctx, { action, entityType: "template_file", after }));
}

/** Deletes this clinic's files that no version uses and that are older than UNUSED_FILE_DAYS, in a savepoint. */
async function collectUnusedFiles(tx: TenantTx, tenantId: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - UNUSED_FILE_DAYS * 86_400_000);
  try {
    await tx.transaction(async (sp) => {
      await sp
        .delete(templateFiles)
        .where(
          and(
            eq(templateFiles.tenantId, tenantId),
            lt(templateFiles.createdAt, cutoff),
            sql`not exists (select 1 from ${templateVersions} v where v.tenant_id = ${templateFiles.tenantId} and v.file_id = ${templateFiles.id})`,
          ),
        );
    });
  } catch (error) {
    // A draft started using one of them meanwhile (23503) or a row is younger than the database allows (23000): keep
    // them all; the next upload tries again. Anything else is a bug.
    const { code } = pgErrorInfo(error);
    if (code !== "23503" && code !== "23000") throw error;
  }
}

/**
 * Validates, scans, strips and stores a pad background (spec section 8.2). The bytes are identified from their content
 * (never from a name or declared type, neither of which is read); the scan runs before any transaction; the stored
 * bytes, hash and size are those of the metadata-stripped image; identical bytes reuse the existing row.
 */
export async function uploadBackground(
  ctx: ServiceContext,
  uploaded: Uint8Array,
  deps: { scanner?: MalwareScanner; now?: Date; quotaBytes?: number } = {},
): Promise<Result<StoredTemplateFile>> {
  if (!can(ctx.role, "template.write")) return fail("forbidden", TEMPLATE_UPLOAD_MESSAGES.forbidden);
  const first = inspectBackground(uploaded);
  if (!first.ok) {
    await audit(ctx, "template_file.rejected", { kind: "background_image", reasonCode: "invalid_image", byteSize: uploaded.length });
    return fail("invalid", first.message, "file");
  }
  // Strip and re-inspect FIRST, then scan the original AND the stripped bytes (fix round 1): what is stored is what was scanned.
  const bytes = stripImageMetadata(uploaded);
  const check = bytes ? inspectBackground(bytes) : null;
  if (!bytes || !check?.ok) {
    await audit(ctx, "template_file.rejected", { kind: "background_image", reasonCode: "damaged", byteSize: uploaded.length });
    return fail("invalid", TEMPLATE_UPLOAD_MESSAGES.damaged, "file");
  }
  const scanAudit = { action: "template_file.rejected", entityType: "template_file", kind: "background_image", field: "file" };
  const original = await scanOrRefuse(ctx, uploaded, scanAudit, deps.scanner);
  if (!original.ok) return original;
  const scanned = Buffer.compare(Buffer.from(bytes), Buffer.from(uploaded)) === 0 ? original : await scanOrRefuse(ctx, bytes, scanAudit, deps.scanner);
  if (!scanned.ok) return scanned;
  const { mime, width, height } = check.info;
  const hash = sha256(bytes);
  const quotaBytes = deps.quotaBytes ?? TEMPLATE_QUOTAS.fileBytes;

  return withTenant(ctx.tenantId, async (tx): Promise<Result<StoredTemplateFile>> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    await collectUnusedFiles(tx, ctx.tenantId, deps.now ?? new Date());
    const [existing] = await tx
      .select({ id: templateFiles.id })
      .from(templateFiles)
      .where(and(eq(templateFiles.tenantId, ctx.tenantId), eq(templateFiles.kind, "background_image"), eq(templateFiles.sha256, hash)))
      .limit(1);
    if (existing) return ok({ id: existing.id, mime, width, height, byteSize: bytes.length, reused: true });
    const [used] = await tx
      .select({ total: sql<number>`coalesce(sum(${templateFiles.byteSize}), 0)::int` })
      .from(templateFiles)
      .where(eq(templateFiles.tenantId, ctx.tenantId));
    if ((used?.total ?? 0) + bytes.length > quotaBytes) {
      await recordAudit(tx, ctx, { action: "template_file.rejected", entityType: "template_file", after: { kind: "background_image", reasonCode: "quota", byteSize: bytes.length } });
      return fail("invalid", TEMPLATE_UPLOAD_MESSAGES.quota, "file");
    }
    const [row] = await tx
      .insert(templateFiles)
      .values({
        tenantId: ctx.tenantId,
        kind: "background_image",
        mime,
        width,
        height,
        byteSize: bytes.length,
        sha256: hash,
        bytes: Buffer.from(bytes),
        scanEngine: scanned.value.engine,
        createdBy: ctx.userId,
      })
      .returning({ id: templateFiles.id });
    await recordAudit(tx, ctx, {
      action: "template_file.uploaded",
      entityType: "template_file",
      entityId: row.id,
      after: { fileId: row.id, kind: "background_image", byteSize: bytes.length, sha256: hash, scanEngine: scanned.value.engine, width, height },
    });
    return ok({ id: row.id, mime, width, height, byteSize: bytes.length, reused: false });
  });
}

function asMime(value: string): ImageMime | null {
  return value === "image/png" || value === "image/jpeg" ? value : null;
}

/**
 * The only way template file bytes are read (the storage seam, ADR-0047). Filters on the tenant on top of RLS and
 * re-hashes the bytes: a row whose bytes do not match its hash is treated as missing (callers fail closed).
 */
export async function loadTemplateFileIn(tx: TenantTx, tenantId: string, fileId: string): Promise<LoadedTemplateFile | null> {
  if (!isUuid(fileId)) return null;
  const [row] = await tx
    .select()
    .from(templateFiles)
    .where(and(eq(templateFiles.tenantId, tenantId), eq(templateFiles.id, fileId)))
    .limit(1);
  const mime = row ? asMime(row.mime) : null;
  if (!row || !mime || row.storage !== "pg" || sha256(row.bytes) !== row.sha256) return null;
  return { id: row.id, mime, width: row.width, height: row.height, sha256: row.sha256, bytes: row.bytes };
}

export function fileAsImageAsset(file: LoadedTemplateFile): ImageAsset {
  return { mime: file.mime, width: file.width, height: file.height, base64: file.bytes.toString("base64") };
}

/** A file for Template Studio's editor (the background behind the boxes). */
export async function getTemplateFile(ctx: ServiceContext, fileId: string): Promise<Result<LoadedTemplateFile>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", TEMPLATE_UPLOAD_MESSAGES.notFound);
  if (!isUuid(fileId)) return fail("not_found", TEMPLATE_UPLOAD_MESSAGES.notFound);
  const file = await withTenant(ctx.tenantId, (tx) => loadTemplateFileIn(tx, ctx.tenantId, fileId));
  return file ? ok(file) : fail("not_found", TEMPLATE_UPLOAD_MESSAGES.notFound);
}
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-files.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing route test**

`tests/integration/template-upload-route.test.ts`:

```ts
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

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  upload(new Request("http://localhost/templates/uploads", { method: "POST", body, headers: { "content-type": "application/octet-stream", ...headers }, duplex: "half" } as RequestInit));

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

  it("answers 413 for a declared length over 2 MB without reading or scanning", async () => {
    const response = await post(new Uint8Array(10), { "content-length": String(2 * 1024 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect(sharedFakeScanner.calls).toBe(0);
  });

  it("answers 413 for a streamed body over 2 MB with no length, and stops reading early", async () => {
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
  });

  it("answers 422 for an empty body and for a file that is not a pad image", async () => {
    expect((await post(new Uint8Array(0))).status).toBe(422);
    // The first bytes of a Windows executable renamed to .png.
    const response = await post(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid", field: "file" });
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
    session.mockResolvedValueOnce(B.as("owner"));
    expect((await getFile(new Request("http://localhost/x"), params)).status).toBe(404);
    session.mockResolvedValueOnce(A.as("pharmacist"));
    expect((await getFile(new Request("http://localhost/x"), params)).status).toBe(404);
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-upload-route.test.ts`
Expected: FAIL — the route modules do not exist.

- [ ] **Step 8: Implement the limiter and the two routes**

`src/server/http/upload-limits.ts`:

```ts
import { createRateLimiter } from "./rate-limit";

/** Template uploads per signed-in user and clinic: 30 an hour, per process (production also limits at the edge). */
export const templateUploadLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
```

`src/app/(app)/templates/uploads/route.ts`:

```ts
import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import { can } from "@/lib/domain/permissions";
import { getSessionContext } from "@/server/auth/session";
import { readCapped } from "@/server/http/read-capped";
import { crossSiteRefusal, publicCode, statusForError } from "@/server/http/response";
import { templateUploadLimiter } from "@/server/http/upload-limits";
import { uploadBackground } from "@/server/services/template-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const TOO_LARGE = { error: "invalid", field: "file", message: "The image is larger than 2 MB. Export it again at a smaller size." };

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

/**
 * Uploads one pad background (the processed image bytes as the request body). The file name and the declared type are
 * never read; the bytes decide. Nothing is logged about the content.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) return json(401, { error: "unauthenticated", message: "Sign in again to upload." });
    if (!can(session.role, "template.write")) return json(404, { error: "not_found", message: "Not found." });
    if (!templateUploadLimiter.hit(`${session.tenantId}:${session.userId}`)) {
      return json(429, { error: "unavailable", message: "Too many uploads. Wait a few minutes and try again." }, { "Retry-After": "600" });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > BACKGROUND_LIMITS.maxBytes) return json(413, TOO_LARGE);
    const body = await readCapped(request.body, BACKGROUND_LIMITS.maxBytes);
    if (body === "too_large") return json(413, TOO_LARGE);
    if (body.byteLength === 0) return json(422, { error: "invalid", field: "file", message: "The file is empty." });
    const result = await uploadBackground(session, new Uint8Array(body), {});
    if (!result.ok) {
      const retry: Record<string, string> = result.code === "unavailable" ? { "Retry-After": "60" } : {};
      return json(statusForError(result.code), { error: publicCode(result.code), message: result.message, field: result.field }, retry);
    }
    const { id, width, height, byteSize, reused } = result.value;
    return json(201, { fileId: id, width, height, byteSize, reused });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("template upload failed", error instanceof Error ? error.name : typeof error);
    return json(500, { error: "internal", message: "The file could not be saved. Try again." });
  }
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
```

`src/app/(app)/templates/files/[fileId]/route.ts`:

```ts
import { getSessionContext } from "@/server/auth/session";
import { crossSiteRefusal, headNotAllowed } from "@/server/http/response";
import { getTemplateFile } from "@/server/services/template-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

/** A stored pad background for the Template Studio editor. Same clinic and template.read only; anything else is 404. */
export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) return new Response(null, { status: 401, headers: NO_STORE });
    const { fileId } = await params;
    const file = await getTemplateFile(session, fileId);
    if (!file.ok) return new Response(null, { status: 404, headers: NO_STORE });
    return new Response(new Uint8Array(file.value.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.value.mime,
        "Content-Length": String(file.value.bytes.length),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("template file failed", error instanceof Error ? error.name : typeof error);
    return new Response(null, { status: 500, headers: NO_STORE });
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
```

In `src/middleware.ts`, add `"/templates/:path*"` to the `matcher` array. In `next.config.ts`, add `"/templates/**": PRESCRIPTION_FONTS,` to `outputFileTracingIncludes` (the preview and alignment routes render documents with the embedded font).

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-upload-route.test.ts tests/integration/template-files.test.ts tests/unit/image.test.ts tests/unit/read-capped.test.ts tests/unit/permissions.test.ts`
Expected: PASS.

- [ ] **Step 9: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/domain/image.ts src/lib/domain/permissions.ts tests/unit/permissions.test.ts src/server/http/read-capped.ts src/server/http/upload-limits.ts src/server/pdf/gotenberg.ts src/server/services/template-files.ts "src/app/(app)/templates/uploads/route.ts" "src/app/(app)/templates/files/[fileId]/route.ts" src/middleware.ts next.config.ts tests/unit/image.test.ts tests/unit/read-capped.test.ts tests/integration/template-files.test.ts tests/integration/template-upload-route.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(templates): background upload pipeline with byte caps, scan, quotas and lazy cleanup" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 10: Split `render.ts` (pure refactor, goldens unchanged); field catalogue, template data, and sample documents (pure, TDD)

The split comes first because the template data reuses the renderer's private helpers (`printedRxNo`, the vitals formatting) and because Task 12 reuses the built-in section and medicine renderers. Two commits: the refactor alone (golden files prove it changed nothing), then the catalogue.

**Files:**
- Create: `src/lib/rx-render/common.ts`, `src/lib/rx-render/marks.ts`, `src/lib/rx-render/vitals.ts`, `src/lib/rx-render/sections.ts`, `src/lib/rx-render/medicines.ts`, `src/lib/rx-render/builtin.ts`
- Modify: `src/lib/rx-render/render.ts` (dispatch only), `src/lib/rx-render/labels.ts` (export `pickLabel`)
- Create: `src/lib/rx-render/fields.ts`, `src/lib/rx-render/template-data.ts`, `src/lib/rx-render/samples.ts`
- Test: `tests/unit/template-fields.test.ts`, `tests/unit/template-samples.test.ts` (and the unchanged `tests/unit/rx-render.test.ts` goldens)

**Interfaces:**
- Consumes: everything in today's `render.ts`; `format.ts`, `labels.ts`, `templates.ts`, `types.ts`.
- Produces:
  - `common.ts`: `DOCUMENT_CSP`, `type Ctx = { doc: RxDocument; def: TemplateDefinition; lang: LabelLanguage; assets: RenderAssets; paper: PaperSpec }`, `positive(n): n is number`, `present(v): v is string`, `printedRxNo(doc): number | null`, `rxNoText(doc): string` ("12", "12 (v2)", or ""), `documentTitle(doc)`, `joined(parts, separator)`, `image(asset): SafeHtml | null`, `isSuperseded(doc)`, `footerTemplate(doc, paper)`.
  - `marks.ts`: `watermark(c)`, `statusBanner(c)`, `signature(c)`, `snapshotNote(c)`. `vitals.ts`: `VITAL_LABEL`, `vitalText(key: VitalKey, v: Vitals): string | null`. `sections.ts`: `kv(c, key, value)`, `allergies(c)`, `section(c, key)`. `medicines.ts`: `medicines(c)`. `builtin.ts`: `renderBuiltin(c): RenderedDocument`. `render.ts`: `renderPrescription`, `RENDERER_VERSION`, and re-exports of `DOCUMENT_CSP`, `footerTemplate` (every existing importer keeps working).
  - `labels.ts`: `pickLabel(en, hi, lang): string` (the existing private `pick`, now exported).
  - `fields.ts`: `TEXT_FIELD_KEYS`, `IMAGE_FIELD_KEYS`, `BOX_FIELD_KEYS`, `LIST_FIELD_KEYS`, `FLAG_FIELD_KEYS`, `MEDICINE_ITEM_KEYS`, `TEST_ITEM_KEYS`, `RESERVED_FIELD_KEYS`; types `TextFieldKey`, `ImageFieldKey`, `BoxFieldKey`, `ListFieldKey`, `FlagFieldKey`, `MedicineItemKey`, `TestItemKey`, `FieldKey`, `FieldType`, `FieldGroup`, `TemplateFieldInfo`; `TEMPLATE_FIELDS: Record<FieldKey, TemplateFieldInfo>`; `fieldType(key: string): FieldType | null`.
  - `template-data.ts`: `type TemplateData = { text: Record<TextFieldKey, string>; flags: Record<FlagFieldKey, boolean>; lists: { medicines: Record<MedicineItemKey, string>[]; tests: Record<TestItemKey, string>[] } }`, `toTemplateData(doc: RxDocument, lang: LabelLanguage): TemplateData`.
  - `samples.ts`: `SAMPLE_KINDS`, `type SampleKind = "short" | "long" | "blank"`, `sampleDocument(kind, base: RenderSnapshot): RxDocument`.

- [ ] **Step 1: Split `render.ts` into modules (move code verbatim)**

Create the six files and move the functions **verbatim** (bodies unchanged) from `src/lib/rx-render/render.ts`:

| New file | Moves from `render.ts` | Exports |
|---|---|---|
| `common.ts` | `DOCUMENT_CSP` (with its comment), `type Ctx`, `positive`, `present`, `printedRxNo`, `documentTitle`, `joined`, `image`, `isSuperseded`, `footerTemplate` (with its comment); the "Safety rules for this file" paragraph of the `renderPrescription` comment becomes this module's top comment, reworded "Safety rules for every rx-render module" | all of them |
| `marks.ts` | `watermark`, `statusBanner`, `signature`, `snapshotNote` | all four |
| `vitals.ts` | `VITAL_LABEL`, `withUnit`, `VITAL_VALUE` | `VITAL_LABEL`, plus the new `vitalText` below |
| `sections.ts` | `kv`, `allergies`, `vitalsBlock`, `line`, `textLine`, `listLine`, `block`, `investigations`, `followUp`, `section` | `kv`, `allergies`, `section` |
| `medicines.ts` | `scheduleParts`, `medicineCell`, `foodCell`, `frequencyCell`, `medicines`, `slotsTable`, `patternTable`, `topicalTable` | `medicines` |
| `builtin.ts` | `renderBuiltin`, `padHeader`, `padFooter`, `patientStrip` | `renderBuiltin` |

Only these lines change while moving:
- `common.ts` gains, after `printedRxNo`:

```ts
/** The printed Rx number: "12", "12 (v2)" for later versions or superseded copies, "" for drafts. */
export function rxNoText(doc: RxDocument): string {
  const no = printedRxNo(doc);
  const showVersion = positive(doc.version) && (doc.version > 1 || isSuperseded(doc));
  return no !== null ? (showVersion ? `${no} (v${doc.version})` : String(no)) : "";
}
```

  and in `builtin.ts` `patientStrip`, the three lines `const no = printedRxNo(doc);`, `const showVersion = …;`, `const rxNo = no !== null ? … : "";` become `const rxNo = rxNoText(doc);` (same output).
- `vitals.ts` gains `export function vitalText(key: VitalKey, v: Vitals): string | null { return VITAL_VALUE[key](v); }`, and `sections.ts` `vitalsBlock` calls `vitalText(key, v)` where it called `VITAL_VALUE[key](v)`.

Import headers (exactly what each file needs; fix any the compiler reports as unused):

```ts
// common.ts
import { html, userText, type HtmlValue, type SafeHtml } from "./html";
import type { TemplateDefinition } from "./templates";
import type { ImageAsset, LabelLanguage, PaperSpec, RenderAssets, RxDocument } from "./types";

// marks.ts
import { formatIssuedDate } from "./format";
import { html, userText, type SafeHtml } from "./html";
import { statusText, supersededByText } from "./labels";
import { image, isSuperseded, positive, present, type Ctx } from "./common";

// vitals.ts
import type { Vitals } from "@/lib/domain/rx-options";
import { bmiText, bpText, numberText } from "./format";
import type { LabelKey } from "./labels";
import type { VitalKey } from "./templates";

// sections.ts
import { formatCalendarDate } from "./format";
import { html, userText, type HtmlValue, type SafeHtml } from "./html";
import { labelText, type LabelKey } from "./labels";
import { joined, present, type Ctx } from "./common";
import { medicines } from "./medicines";
import type { SectionKey } from "./templates";
import { VITAL_LABEL, vitalText } from "./vitals";

// medicines.ts
import { hasSlots, quantityText, scheduleText } from "./format";
import { html, userText, type HtmlValue, type SafeHtml } from "./html";
import { durationText, foodText, labelHtml, labelText, periodicityText } from "./labels";
import { joined, present, type Ctx } from "./common";
import type { RxItem } from "./types";

// builtin.ts
import { formatIssuedDate, numberText } from "./format";
import { html, raw, userText, type SafeHtml } from "./html";
import { ageText, draftAmendmentText, genderText, labelText, replacesVersionText } from "./labels";
import { documentCss } from "./styles";
import { DOCUMENT_CSP, documentTitle, footerTemplate, image, positive, present, rxNoText, type Ctx } from "./common";
import { signature, snapshotNote, statusBanner, watermark } from "./marks";
import { allergies, kv, section } from "./sections";
import type { SectionKey } from "./templates";
import type { RenderedDocument } from "./types";
```

`render.ts` keeps only:

```ts
import { renderBuiltin } from "./builtin";
import { PAPER } from "./paper";
import { TEMPLATE_DEFINITIONS } from "./templates";
import type { RenderAssets, RenderedDocument, RxDocument } from "./types";

export { DOCUMENT_CSP, footerTemplate } from "./common";

/**
 * Bump when templates, labels, CSS, fonts or layout change in a way that alters printed output.
 * The document DATA is frozen at finalize (the snapshot); the PRESENTATION is not, so every
 * output row records the version that drew it (prescription_outputs.renderer_version).
 */
export const RENDERER_VERSION = "1";

/**
 * Renders a prescription pad as one self-contained HTML document. Pure: the same input gives
 * byte-identical output. Dispatches on the template kind (the switch has no default: a new
 * TemplateRef kind fails to compile until it is drawn). Safety rules: src/lib/rx-render/common.ts.
 */
export function renderPrescription(doc: RxDocument, assets: RenderAssets): RenderedDocument {
  const { template, paperSize, labels } = doc.snapshot.layout;
  switch (template.kind) {
    case "builtin":
      return renderBuiltin({ doc, def: TEMPLATE_DEFINITIONS[template.key], lang: labels, assets, paper: PAPER[paperSize] });
  }
}
```

In `labels.ts`, rename the private `function pick(en: string, hindi: string, lang: LabelLanguage)` to `export function pickLabel(…)` and update its five callers in the same file (`labelText`, `labelHtml`, `coded`, `genderText`, `durationText`, `ageText`, `statusText`, `supersededByText`, `replacesVersionText`, `draftAmendmentText` — every `pick(` in the file).

- [ ] **Step 2: Prove the refactor changed nothing**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/rx-render.test.ts tests/unit/rx-html.test.ts tests/unit/self-contained.test.ts tests/unit/rx-labels.test.ts
Set-Location E:\projects\clinicpad; git status --porcelain tests/unit/__golden__
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }
Set-Location E:\projects\clinicpad; (Get-Content src/lib/rx-render/render.ts | Measure-Object -Line).Lines
```

Expected: all PASS; `git status` prints nothing for the golden folder (no golden file rewritten); `render.ts` is under 40 lines and every new module under 250.

- [ ] **Step 3: Commit the refactor alone**

```powershell
Set-Location E:\projects\clinicpad; npm run test
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/common.ts src/lib/rx-render/marks.ts src/lib/rx-render/vitals.ts src/lib/rx-render/sections.ts src/lib/rx-render/medicines.ts src/lib/rx-render/builtin.ts src/lib/rx-render/render.ts src/lib/rx-render/labels.ts
Set-Location E:\projects\clinicpad; git commit -m "refactor(rx-render): split render.ts into modules (golden files unchanged)" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

- [ ] **Step 4: Write the failing catalogue and data test**

`tests/unit/template-fields.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BOX_FIELD_KEYS,
  FLAG_FIELD_KEYS,
  IMAGE_FIELD_KEYS,
  LIST_FIELD_KEYS,
  RESERVED_FIELD_KEYS,
  TEMPLATE_FIELDS,
  TEXT_FIELD_KEYS,
  fieldType,
} from "@/lib/rx-render/fields";
import { toTemplateData } from "@/lib/rx-render/template-data";
import { DEVANAGARI, HOSTILE, documentFixture, item, snapshot, visit } from "../fixtures/rx-documents";

describe("TEMPLATE_FIELDS", () => {
  it("describes every key exactly once, with its type and both labels", () => {
    const keys = [...BOX_FIELD_KEYS, ...LIST_FIELD_KEYS, ...FLAG_FIELD_KEYS];
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(TEMPLATE_FIELDS).sort()).toEqual([...keys].sort());
    for (const key of TEXT_FIELD_KEYS) expect(TEMPLATE_FIELDS[key].type).toBe("text");
    for (const key of IMAGE_FIELD_KEYS) expect(TEMPLATE_FIELDS[key].type).toBe("image");
    for (const key of LIST_FIELD_KEYS) expect(TEMPLATE_FIELDS[key].type).toBe("list");
    for (const key of FLAG_FIELD_KEYS) expect(TEMPLATE_FIELDS[key].type).toBe("flag");
    for (const info of Object.values(TEMPLATE_FIELDS)) expect(info.en.trim() && info.hi.trim()).toBeTruthy();
  });

  it("uses the documented names (PRODUCT_SPEC 7.3, ADR-0014)", () => {
    expect(BOX_FIELD_KEYS).toEqual(expect.arrayContaining(["doctor.reg_no", "visit.rx_no", "follow_up.date", "patient.name", "clinic.logo", "doctor.signature"]));
  });

  it("never offers the patient's phone or a QR code, and answers null for unknown or prototype keys", () => {
    for (const key of Object.keys(RESERVED_FIELD_KEYS)) expect(fieldType(key)).toBeNull();
    for (const key of ["constructor", "__proto__", "toString", "patient.name.x", ""]) expect(fieldType(key)).toBeNull();
    expect(fieldType("patient.name")).toBe("text");
  });
});

describe("toTemplateData", () => {
  it("formats the frozen snapshot, the visit and the items with the same helpers as the built-in pads", () => {
    const data = toTemplateData(documentFixture(), "en");
    expect(data.text).toMatchObject({
      "clinic.name": "Sunrise Family Clinic",
      "clinic.address": "12 MG Road\nPune, Maharashtra - 411001",
      "doctor.reg_no": "MMC 2011/04/1234",
      "patient.name": "Asha Rao",
      "patient.age_gender": "36 y / Female",
      "patient.no": "42",
      "patient.allergies": "Penicillin",
      "patient.weight": "70 kg",
      "visit.date": "12/11/2026",
      "visit.rx_no": "12",
      "visit.type": "New visit",
      "vitals.bp": "130/85 mmHg",
      complaints: "Fever, Body ache",
      "follow_up.line": "19/11/2026 · Review CBC report",
    });
    expect(data.text["vitals.line"]).toContain("BP 130/85 mmHg");
    expect(data.lists.medicines[0]).toMatchObject({ n: "1", name: "Medicine 1" });
    expect(data.lists.tests).toEqual([
      { n: "1", name: "CBC", instructions: "" },
      { n: "2", name: "Dengue NS1", instructions: "If fever persists" },
    ]);
    expect(data.flags).toMatchObject({ "has.allergies": true, "has.medicines": true, "has.tests": true, "has.follow_up": true });
  });

  it("prints blanks as empty strings, never undefined or null", () => {
    const doc = documentFixture({
      snapshot: snapshot({ patient: { gender: null, patientNo: null, allergies: [], ageLabel: "" }, doctor: { registrationNo: null, qualifications: null } }),
      visit: visit({ chiefComplaint: null, advice: null, followUpDate: null, followUpReason: null, vitals: {}, investigations: [] }),
      items: [],
    });
    const data = toTemplateData(doc, "en");
    for (const [key, value] of Object.entries(data.text)) {
      expect(typeof value, key).toBe("string");
      expect(value, key).not.toMatch(/undefined|null|NaN/);
    }
    expect(data.text["patient.age_gender"]).toBe("");
    expect(data.flags).toMatchObject({ "has.allergies": false, "has.vitals": false, "has.medicines": false, "has.tests": false, "has.follow_up": false });
  });

  it("never gives a draft an Rx number or a signature", () => {
    const draft = documentFixture({ status: "draft", rxNo: 12, issuedAt: null, snapshot: snapshot({ doctor: { signatureAssetId: "019a0000-0000-7000-8000-000000000001" } }) });
    const data = toTemplateData(draft, "en");
    expect(data.text["visit.rx_no"]).toBe("");
    expect(data.flags["has.signature"]).toBe(false);
  });

  it("shows the version on later versions and localises coded values", () => {
    const v2 = toTemplateData(documentFixture({ version: 2 }), "hi");
    expect(v2.text["visit.rx_no"]).toBe("12 (v2)");
    expect(v2.text["patient.age"]).toBe("36 वर्ष");
    expect(toTemplateData(documentFixture(), "bilingual").text["patient.gender"]).toBe("Female / महिला");
  });

  it("keeps hostile and Devanagari text as plain text (escaping is the renderer's job)", () => {
    const data = toTemplateData(documentFixture({ snapshot: snapshot({ patient: { name: HOSTILE.script + DEVANAGARI.name } }), items: [item(1, { drugName: HOSTILE.img })] }), "en");
    expect(data.text["patient.name"]).toBe(HOSTILE.script + DEVANAGARI.name);
    expect(data.lists.medicines[0].name).toBe(HOSTILE.img);
  });
});
```

(`महिला` is `translations.hindi.female`, which `genderText` uses.)

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/template-fields.test.ts`
Expected: FAIL — `@/lib/rx-render/fields` does not exist.

- [ ] **Step 5: Implement the catalogue**

`src/lib/rx-render/fields.ts`:

```ts
/**
 * The field catalogue (spec section 5.5): every value a custom template may print, by name. Templates never see
 * database rows; toTemplateData() fills these from the frozen snapshot, the visit and the items. Names follow
 * PRODUCT_SPEC 7.3 and ADR-0014. Overlay boxes use text and image fields; lists and flags are for DOCX (2B).
 * NEEDS NATIVE-SPEAKER REVIEW: every Hindi label below is a first draft.
 */
export const TEXT_FIELD_KEYS = [
  "clinic.name", "clinic.address", "clinic.phone", "clinic.email", "clinic.footer",
  "doctor.name", "doctor.qualifications", "doctor.designation", "doctor.reg_no", "doctor.council",
  "patient.name", "patient.age", "patient.gender", "patient.age_gender", "patient.no", "patient.allergies", "patient.weight",
  "visit.date", "visit.rx_no", "visit.type",
  "vitals.bp", "vitals.pulse", "vitals.temperature", "vitals.spo2", "vitals.rr", "vitals.weight", "vitals.height", "vitals.bmi", "vitals.sugar", "vitals.line",
  "chief_complaint", "complaints", "diagnosis", "history.medical", "history.drug", "examination", "advice",
  "follow_up.date", "follow_up.reason", "follow_up.line",
] as const;
export const IMAGE_FIELD_KEYS = ["clinic.logo", "doctor.signature"] as const;
export const BOX_FIELD_KEYS = [...TEXT_FIELD_KEYS, ...IMAGE_FIELD_KEYS] as const;
export const LIST_FIELD_KEYS = ["medicines", "tests"] as const;
export const FLAG_FIELD_KEYS = ["has.allergies", "has.vitals", "has.medicines", "has.tests", "has.follow_up", "has.signature"] as const;
export const MEDICINE_ITEM_KEYS = [
  "n", "name", "generic", "strength", "form", "route", "dose", "schedule", "morning", "afternoon", "evening", "night",
  "timing", "food", "frequency", "duration", "remarks", "sos",
] as const;
export const TEST_ITEM_KEYS = ["n", "name", "instructions"] as const;

/** Names people expect that are deliberately not printable: refused with this reason (Q14; QR needs a share link). */
export const RESERVED_FIELD_KEYS = {
  qr: "QR codes on pads are coming later.",
  "patient.phone": "Pads do not print the patient's phone number.",
} as const;

export type TextFieldKey = (typeof TEXT_FIELD_KEYS)[number];
export type ImageFieldKey = (typeof IMAGE_FIELD_KEYS)[number];
export type BoxFieldKey = (typeof BOX_FIELD_KEYS)[number];
export type ListFieldKey = (typeof LIST_FIELD_KEYS)[number];
export type FlagFieldKey = (typeof FLAG_FIELD_KEYS)[number];
export type MedicineItemKey = (typeof MEDICINE_ITEM_KEYS)[number];
export type TestItemKey = (typeof TEST_ITEM_KEYS)[number];
export type FieldKey = BoxFieldKey | ListFieldKey | FlagFieldKey;
export type FieldType = "text" | "image" | "list" | "flag";
export type FieldGroup = "clinic" | "doctor" | "patient" | "visit" | "vitals" | "clinical" | "lists" | "flags";
export type TemplateFieldInfo = { type: FieldType; group: FieldGroup; en: string; hi: string };

const t = (group: FieldGroup, en: string, hi: string): TemplateFieldInfo => ({ type: "text", group, en, hi });

export const TEMPLATE_FIELDS: Record<FieldKey, TemplateFieldInfo> = {
  "clinic.name": t("clinic", "Clinic name", "क्लिनिक का नाम"),
  "clinic.address": t("clinic", "Clinic address", "क्लिनिक का पता"),
  "clinic.phone": t("clinic", "Clinic phone", "क्लिनिक फोन"),
  "clinic.email": t("clinic", "Clinic email", "क्लिनिक ईमेल"),
  "clinic.footer": t("clinic", "Pad footer", "पैड फुटर"),
  "clinic.logo": { type: "image", group: "clinic", en: "Clinic logo", hi: "क्लिनिक लोगो" },
  "doctor.name": t("doctor", "Doctor's name", "चिकित्सक का नाम"),
  "doctor.qualifications": t("doctor", "Qualifications", "योग्यताएं"),
  "doctor.designation": t("doctor", "Designation", "पद"),
  "doctor.reg_no": t("doctor", "Registration no.", "पंजीकरण संख्या"),
  "doctor.council": t("doctor", "Medical council", "चिकित्सा परिषद"),
  "doctor.signature": { type: "image", group: "doctor", en: "Signature (never on drafts)", hi: "हस्ताक्षर" },
  "patient.name": t("patient", "Patient's name", "रोगी का नाम"),
  "patient.age": t("patient", "Age", "आयु"),
  "patient.gender": t("patient", "Gender", "लिंग"),
  "patient.age_gender": t("patient", "Age / gender", "आयु / लिंग"),
  "patient.no": t("patient", "Patient no.", "रोगी क्रमांक"),
  "patient.allergies": t("patient", "Allergies", "एलर्जी"),
  "patient.weight": t("patient", "Weight", "वजन"),
  "visit.date": t("visit", "Date", "दिनांक"),
  "visit.rx_no": t("visit", "Rx no. (blank on drafts)", "पर्चा क्रमांक"),
  "visit.type": t("visit", "Visit type", "मुलाकात का प्रकार"),
  "vitals.bp": t("vitals", "BP", "रक्तचाप"),
  "vitals.pulse": t("vitals", "Pulse", "नाड़ी"),
  "vitals.temperature": t("vitals", "Temperature", "तापमान"),
  "vitals.spo2": t("vitals", "SpO2", "SpO2"),
  "vitals.rr": t("vitals", "Respiratory rate", "श्वसन दर"),
  "vitals.weight": t("vitals", "Weight", "वजन"),
  "vitals.height": t("vitals", "Height", "लंबाई"),
  "vitals.bmi": t("vitals", "BMI", "BMI"),
  "vitals.sugar": t("vitals", "Blood sugar", "शुगर"),
  "vitals.line": t("vitals", "Vitals (one line)", "जीवन संकेत (एक पंक्ति)"),
  chief_complaint: t("clinical", "Chief complaint", "मुख्य शिकायत"),
  complaints: t("clinical", "Complaints", "शिकायतें"),
  diagnosis: t("clinical", "Diagnosis", "निदान"),
  "history.medical": t("clinical", "Medical history", "चिकित्सा इतिहास"),
  "history.drug": t("clinical", "Drug history", "दवा इतिहास"),
  examination: t("clinical", "Examination", "जांच"),
  advice: t("clinical", "Advice", "सलाह"),
  "follow_up.date": t("clinical", "Follow-up date", "पुनः जांच दिनांक"),
  "follow_up.reason": t("clinical", "Follow-up reason", "पुनः जांच का कारण"),
  "follow_up.line": t("clinical", "Follow-up", "पुनः जांच"),
  medicines: { type: "list", group: "lists", en: "Medicines", hi: "दवाइयां" },
  tests: { type: "list", group: "lists", en: "Tests", hi: "जांचें" },
  "has.allergies": { type: "flag", group: "flags", en: "Has allergies", hi: "एलर्जी है" },
  "has.vitals": { type: "flag", group: "flags", en: "Has vitals", hi: "जीवन संकेत हैं" },
  "has.medicines": { type: "flag", group: "flags", en: "Has medicines", hi: "दवाइयां हैं" },
  "has.tests": { type: "flag", group: "flags", en: "Has tests", hi: "जांचें हैं" },
  "has.follow_up": { type: "flag", group: "flags", en: "Has a follow-up", hi: "पुनः जांच है" },
  "has.signature": { type: "flag", group: "flags", en: "Is signed", hi: "हस्ताक्षरित है" },
};

/** The type of a catalogue key, or null for anything else (own-property lookup: prototype names are never fields). */
export function fieldType(key: string): FieldType | null {
  return Object.hasOwn(TEMPLATE_FIELDS, key) ? TEMPLATE_FIELDS[key as FieldKey].type : null;
}
```

- [ ] **Step 6: Implement the template data**

`src/lib/rx-render/template-data.ts`:

```ts
import { present, rxNoText } from "./common";
import type { FlagFieldKey, MedicineItemKey, TestItemKey, TextFieldKey } from "./fields";
import { formatCalendarDate, formatIssuedDate, hasSlots, quantityText, scheduleText } from "./format";
import { ageText, durationText, foodText, genderText, labelText, periodicityText, pickLabel } from "./labels";
import { TEMPLATE_DEFINITIONS, type VitalKey } from "./templates";
import type { LabelLanguage, RxDocument } from "./types";
import { VITAL_LABEL, vitalText } from "./vitals";

export type TemplateData = {
  text: Record<TextFieldKey, string>;
  flags: Record<FlagFieldKey, boolean>;
  lists: { medicines: Record<MedicineItemKey, string>[]; tests: Record<TestItemKey, string>[] };
};

/* NEEDS NATIVE-SPEAKER REVIEW: visit type words. Codes come from src/server/validation/prescription.ts. */
const VISIT_TYPE: Record<string, { en: string; hi: string }> = {
  new: { en: "New visit", hi: "नई मुलाकात" },
  "follow-up": { en: "Follow-up", hi: "पुनः जांच" },
};

const s = (value: string | null | undefined): string => (present(value) ? value.trim() : "");
const list = (values: readonly string[]): string => values.filter(present).map((v) => v.trim()).join(", ");

/**
 * Every catalogue value as plain text (never markup: the renderer escapes), built from the same snapshot, labels and
 * formatting helpers as the built-in pads, so a custom pad prints exactly the same words. Missing values are "".
 * A draft has no Rx number and no signature (ADR-0032).
 */
export function toTemplateData(doc: RxDocument, lang: LabelLanguage): TemplateData {
  const { patient, clinic, doctor } = doc.snapshot;
  const v = doc.visit;
  const vital = (key: VitalKey) => vitalText(key, v.vitals) ?? "";
  const age = ageText(patient.ageLabel, lang);
  const gender = genderText(patient.gender, lang);
  const followDate = formatCalendarDate(v.followUpDate);
  const reason = s(v.followUpReason);
  const vitalsLine = TEMPLATE_DEFINITIONS.general.vitals
    .map((key) => {
      const value = vitalText(key, v.vitals);
      return value === null ? null : `${labelText(VITAL_LABEL[key], lang)} ${value}`;
    })
    .filter((part): part is string => part !== null)
    .join(" · ");
  const visitType = Object.hasOwn(VISIT_TYPE, v.visitType) ? pickLabel(VISIT_TYPE[v.visitType].en, VISIT_TYPE[v.visitType].hi, lang) : "";

  const text: Record<TextFieldKey, string> = {
    "clinic.name": s(clinic.name),
    "clinic.address": clinic.addressLines.filter(present).map((l) => l.trim()).join("\n"),
    "clinic.phone": s(clinic.phone),
    "clinic.email": s(clinic.email),
    "clinic.footer": clinic.footerLines.filter(present).map((l) => l.trim()).join("\n"),
    "doctor.name": s(doctor.name),
    "doctor.qualifications": s(doctor.qualifications),
    "doctor.designation": s(doctor.designation),
    "doctor.reg_no": s(doctor.registrationNo),
    "doctor.council": s(doctor.registrationCouncil),
    "patient.name": s(patient.name),
    "patient.age": age,
    "patient.gender": gender,
    "patient.age_gender": [age, gender].filter((x) => x !== "").join(" / "),
    "patient.no": patient.patientNo !== null ? String(patient.patientNo) : "",
    "patient.allergies": list(patient.allergies),
    "patient.weight": vital("weightKg"),
    "visit.date": formatIssuedDate(doc.issuedAt ?? doc.snapshot.takenAt, clinic.timezone),
    "visit.rx_no": rxNoText(doc),
    "visit.type": visitType,
    "vitals.bp": vital("bp"),
    "vitals.pulse": vital("pulse"),
    "vitals.temperature": vital("temperatureF"),
    "vitals.spo2": vital("spo2"),
    "vitals.rr": vital("respiratoryRate"),
    "vitals.weight": vital("weightKg"),
    "vitals.height": vital("heightCm"),
    "vitals.bmi": vital("bmi"),
    "vitals.sugar": vital("bloodSugarMgDl"),
    "vitals.line": vitalsLine,
    chief_complaint: s(v.chiefComplaint),
    complaints: list(v.complaints),
    diagnosis: list(v.diagnosis),
    "history.medical": list(v.medicalHistory),
    "history.drug": list(v.drugHistory),
    examination: s(v.examinationNotes),
    advice: s(v.advice),
    "follow_up.date": followDate,
    "follow_up.reason": reason,
    "follow_up.line": [followDate, reason].filter((x) => x !== "").join(" · "),
  };

  const medicines = doc.items.map((item, i): Record<MedicineItemKey, string> => ({
    n: String(i + 1),
    name: s(item.drugName),
    generic: s(item.genericName),
    strength: s(item.strength),
    form: s(item.form),
    route: s(item.route),
    dose: s(item.dose),
    schedule: hasSlots(item) ? scheduleText({ ...item, timing: null }) : "",
    morning: quantityText(item.doseMorning),
    afternoon: quantityText(item.doseAfternoon),
    evening: quantityText(item.doseEvening),
    night: quantityText(item.doseNight),
    timing: s(item.timing),
    food: foodText(item.foodRelation, lang),
    frequency: periodicityText(item.periodicity, lang),
    duration: durationText(item.durationValue, item.durationUnit, lang),
    remarks: s(item.remarks),
    sos: item.isSos ? "SOS" : "",
  }));
  const tests = v.investigations
    .filter((test) => present(test.name))
    .map((test, i): Record<TestItemKey, string> => ({ n: String(i + 1), name: s(test.name), instructions: s(test.instructions) }));

  const flags: Record<FlagFieldKey, boolean> = {
    "has.allergies": patient.allergies.some(present),
    "has.vitals": vitalsLine !== "",
    "has.medicines": medicines.length > 0,
    "has.tests": tests.length > 0,
    "has.follow_up": text["follow_up.line"] !== "",
    "has.signature": doc.status !== "draft" && doctor.signatureAssetId !== null,
  };
  return { text, flags, lists: { medicines, tests } };
}
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/template-fields.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing sample test, then the samples**

`tests/unit/template-samples.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SAMPLE_KINDS, sampleDocument } from "@/lib/rx-render/samples";
import { toTemplateData } from "@/lib/rx-render/template-data";
import { snapshot } from "../fixtures/rx-documents";

const base = snapshot({ doctor: { signatureAssetId: "019a0000-0000-7000-8000-000000000001" } });

describe("sampleDocument", () => {
  it("keeps the clinic's own letterhead details and never carries a real signature", () => {
    for (const kind of SAMPLE_KINDS) {
      const doc = sampleDocument(kind, base);
      expect(doc.snapshot.clinic).toEqual(base.clinic);
      expect(doc.snapshot.doctor.name).toBe(base.doctor.name);
      expect(doc.snapshot.doctor.signatureAssetId).toBeNull();
      expect(doc.snapshot.layout).toEqual(base.layout);
    }
  });

  it("gives the short sample 3 medicines, the long one 12 with Devanagari text, and the blank one nothing", () => {
    expect(sampleDocument("short", base).items).toHaveLength(3);
    const long = sampleDocument("long", base);
    expect(long.items).toHaveLength(12);
    expect(long.snapshot.patient.name).toMatch(/[\u0900-\u097F]/);
    const blank = toTemplateData(sampleDocument("blank", base), "en");
    expect(blank.text["patient.name"]).toBe("");
    expect(blank.text["visit.rx_no"]).toBe("");
    expect(blank.lists.medicines).toHaveLength(0);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(sampleDocument("long", base))).toBe(JSON.stringify(sampleDocument("long", base)));
  });
});
```

`src/lib/rx-render/samples.ts`:

```ts
import type { RenderSnapshot } from "./snapshot";
import type { RxDocument, RxItem, RxVisit } from "./types";

export const SAMPLE_KINDS = ["short", "long", "blank"] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

const med = (drugName: string, strength: string, form: string, slots: [number, number, number, number] | null, rest: Partial<RxItem> = {}): RxItem => ({
  drugName,
  genericName: null,
  strength,
  form,
  route: null,
  dose: null,
  doseMorning: slots ? slots[0] : null,
  doseAfternoon: slots ? slots[1] : null,
  doseEvening: slots ? slots[2] : null,
  doseNight: slots ? slots[3] : null,
  timing: null,
  foodRelation: "after",
  periodicity: "daily",
  isSos: false,
  durationValue: 5,
  durationUnit: "days",
  durationDays: 5,
  remarks: null,
  ...rest,
});

/** Typical Indian outpatient lines (fake data for previews). */
const SAMPLE_ITEMS: RxItem[] = [
  med("Paracetamol", "650 mg", "Tablet", [1, 0, 0, 1]),
  med("Pantoprazole", "40 mg", "Tablet", [1, 0, 0, 0], { foodRelation: "before", durationValue: 14, durationDays: 14 }),
  med("Cetirizine", "10 mg", "Tablet", [0, 0, 0, 1]),
  med("Amoxicillin + Clavulanic acid", "625 mg", "Tablet", [1, 0, 0, 1], { remarks: "Complete the full course" }),
  med("Azithromycin", "500 mg", "Tablet", [1, 0, 0, 0], { durationValue: 3, durationDays: 3 }),
  med("Cholecalciferol", "60,000 IU", "Sachet", null, { periodicity: "weekly", timing: "Once a week with milk", durationValue: 8, durationUnit: "weeks", durationDays: 56 }),
  med("Oral rehydration salts", "21 g", "Sachet", null, { isSos: true, periodicity: "as_needed", timing: "After each loose stool" }),
  med("Ibuprofen", "400 mg", "Tablet", null, { isSos: true, periodicity: "as_needed", timing: "If pain is severe" }),
  med("Montelukast", "10 mg", "Tablet", [0, 0, 0, 1], { durationValue: 14, durationDays: 14 }),
  med("Calcium carbonate", "500 mg", "Tablet", [0, 1, 0, 0], { durationValue: 1, durationUnit: "months", durationDays: 30 }),
  med("Metformin", "500 mg", "Tablet", [1, 0, 0, 1], { durationValue: 1, durationUnit: "months", durationDays: 30 }),
  med("Levocetirizine", "2.5 mg/5 ml", "Syrup", null, { dose: "5 ml", timing: "At bedtime" }),
];

const EMPTY_VISIT: RxVisit = {
  visitType: "new",
  chiefComplaint: null,
  complaints: [],
  diagnosis: [],
  medicalHistory: [],
  drugHistory: [],
  examinationNotes: null,
  vitals: {},
  investigations: [],
  advice: null,
  followUpDate: null,
  followUpReason: null,
};

/**
 * A fake prescription on the clinic's real letterhead details, for template previews only (never a record, never
 * logged). The doctor block is the base's; the signature image is always removed.
 */
export function sampleDocument(kind: SampleKind, base: RenderSnapshot): RxDocument {
  const doctor = { ...base.doctor, signatureAssetId: null };
  const common = {
    status: "finalized" as const,
    version: 1,
    issuedAt: base.takenAt,
    supersededBy: null,
    replacesVersion: null,
    snapshotSource: "finalize" as const,
  };
  if (kind === "blank") {
    return {
      ...common,
      rxNo: null,
      snapshot: { ...base, doctor, patient: { name: "", patientNo: null, gender: null, dob: null, ageLabel: "", allergies: [] } },
      visit: EMPTY_VISIT,
      items: [],
    };
  }
  if (kind === "short") {
    return {
      ...common,
      rxNo: 123,
      snapshot: { ...base, doctor, patient: { name: "Asha Rao", patientNo: 42, gender: "female", dob: "1990-04-02", ageLabel: "36 y", allergies: ["Penicillin"] } },
      visit: { ...EMPTY_VISIT, chiefComplaint: "Fever for 2 days", diagnosis: ["Viral fever"], vitals: { bpSystolic: 124, bpDiastolic: 82, pulse: 88, temperatureF: 100.2, weightKg: 62 }, advice: "Plenty of fluids. Rest for 3 days.", followUpDate: null, followUpReason: "If fever persists after 3 days" },
      items: SAMPLE_ITEMS.slice(0, 3),
    };
  }
  return {
    ...common,
    rxNo: 1234,
    snapshot: {
      ...base,
      doctor,
      patient: { name: "श्रीमती अन्नपूर्णा देवी रामचंद्रन सुब्रमण्यम", patientNo: 10234, gender: "female", dob: "1958-01-15", ageLabel: "68 y", allergies: ["Penicillin", "Sulfa drugs", "Peanuts"] },
    },
    visit: {
      ...EMPTY_VISIT,
      chiefComplaint: "बुखार और खांसी, 5 दिनों से",
      complaints: ["Fever", "Dry cough", "Body ache", "Loss of appetite"],
      diagnosis: ["Lower respiratory tract infection", "Type 2 diabetes mellitus"],
      medicalHistory: ["Type 2 diabetes for 10 years", "Hypertension"],
      vitals: { bpSystolic: 146, bpDiastolic: 92, pulse: 102, temperatureF: 101.4, spo2: 95, respiratoryRate: 22, weightKg: 71.5, heightCm: 158, bloodSugarMgDl: 214 },
      investigations: [{ name: "CBC" }, { name: "Chest X-ray PA view" }, { name: "HbA1c", instructions: "Fasting not needed" }],
      advice: Array.from({ length: 6 }, () => "भोजन के बाद दवा लें। पानी अधिक पिएं। आराम करें।").join(" "),
      followUpReason: "Review with X-ray and blood reports",
    },
    items: SAMPLE_ITEMS,
  };
}
```

(The codes `before`, `after`, `daily`, `weekly`, `as_needed` are the ones in `FOOD_RELATIONS` / `PERIODICITIES`, `src/lib/domain/rx-options.ts`.)

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/template-samples.test.ts tests/unit/template-fields.test.ts`
Expected: PASS.

- [ ] **Step 8: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/fields.ts src/lib/rx-render/template-data.ts src/lib/rx-render/samples.ts tests/unit/template-fields.test.ts tests/unit/template-samples.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(rx-render): template field catalogue, template data and preview samples" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 11: Overlay definition schema, publish rules, and canonical JSON (pure, TDD)

**Files:**
- Create: `src/lib/rx-render/overlay-definition.ts`, `src/lib/rx-render/canonical-json.ts`, `src/lib/templates/publish-rules.ts`
- Test: `tests/unit/overlay-definition.test.ts`, `tests/unit/publish-rules.test.ts`, `tests/unit/canonical-json.test.ts`

**Interfaces:**
- Consumes: `BOX_FIELD_KEYS` (Task 10), `PAPER`, `BUILTIN_TEMPLATES`, `SectionKey`; `MINIMAL_OVERLAY_DEFINITION` (`tests/fixtures/overlay-definitions.ts`, Task 7).
- Produces:
  - `OVERLAY_LIMITS`, `SECTION_KEYS`, `overlayDefinitionSchema`, `type OverlayDefinition`, `type OverlayBox`, `type GeometryIssue = { path: string; message: string }`, `overlayGeometryIssues(def, paperSize): GeometryIssue[]`, `parseOverlayDefinition(value: unknown, paperSize): OverlayDefinition | null`, `defaultOverlayDefinition(paperSize): OverlayDefinition` (`src/lib/rx-render/overlay-definition.ts`).
  - `canonicalJson(value: unknown): string` (`src/lib/rx-render/canonical-json.ts`).
  - `type PublishIdentity = { kind: "dynamic" } | { kind: "bound"; doctorId: string | null; confirmed: boolean }`, `type PublishIssue = { code: PublishIssueCode; message: string }`, `overlayPublishIssues(def, paperSize, identity): PublishIssue[]` (`src/lib/templates/publish-rules.ts`).
- Geometry conventions (used by Tasks 12, 16, 17, 19): all lengths in millimetres from the page's top-left corner; boxes are `xMm, yMm, wMm, hMm`; the flow region's `topMm`, `bottomMm`, `leftMm`, `rightMm` are **insets from the matching page edge**; `pageNumbers.bandMm` is a blank band at the bottom of the page (0 = off); `bottomMm` must be at least `bandMm`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/overlay-definition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  defaultOverlayDefinition,
  overlayDefinitionSchema,
  overlayGeometryIssues,
  parseOverlayDefinition,
  type OverlayDefinition,
} from "@/lib/rx-render/overlay-definition";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const base = (): OverlayDefinition => structuredClone(MINIMAL_OVERLAY_DEFINITION) as unknown as OverlayDefinition;
const withBox = (patch: Record<string, unknown>) => ({ ...base(), boxes: [{ ...base().boxes[0], ...patch }] });

describe("overlayDefinitionSchema", () => {
  it("accepts the test helpers' minimal definition on A4 (keeps the two in step)", () => {
    expect(parseOverlayDefinition(MINIMAL_OVERLAY_DEFINITION, "A4")).not.toBeNull();
  });

  it("rounds every length to 0.1 mm, idempotently", () => {
    const parsed = overlayDefinitionSchema.parse(withBox({ xMm: 20.04, yMm: 52.06, fontPt: 10.26 }));
    expect(parsed.boxes[0]).toMatchObject({ xMm: 20, yMm: 52.1, fontPt: 10.3 });
    expect(overlayDefinitionSchema.parse(parsed)).toEqual(parsed);
  });

  it.each([
    ["the patient's phone", withBox({ field: "patient.phone" })],
    ["a QR code", withBox({ field: "qr" })],
    ["a list field in a box", withBox({ field: "medicines" })],
    ["NaN", withBox({ xMm: Number.NaN })],
    ["Infinity", withBox({ wMm: Number.POSITIVE_INFINITY })],
    ["a negative position", withBox({ xMm: -1 })],
    ["a 2 mm box", withBox({ hMm: 2 })],
    ["5 pt text", withBox({ fontPt: 5 })],
    ["25 pt text", withBox({ fontPt: 25 })],
    ["an id with a quote", withBox({ id: 'b1" onload="x' })],
    ["an upper-case id", withBox({ id: "B1" })],
    ["an unknown alignment", withBox({ align: "justify" })],
    ["31 boxes", { ...base(), boxes: Array.from({ length: 31 }, (_, i) => ({ ...base().boxes[0], id: `b${i}` })) }],
    ["two boxes with one id", { ...base(), boxes: [base().boxes[0], base().boxes[0]] }],
    ["an unknown section", { ...base(), flow: { ...base().flow, sections: ["medicines", "billing"] } }],
    ["a section twice", { ...base(), flow: { ...base().flow, sections: ["medicines", "medicines"] } }],
    ["no sections", { ...base(), flow: { ...base().flow, sections: [] } }],
    ["a 4 mm page-number band", { ...base(), pageNumbers: { bandMm: 4 } }],
    ["a 13 mm page-number band", { ...base(), pageNumbers: { bandMm: 13 } }],
    ["an 11 mm printer offset", { ...base(), printOffsetMm: { x: 11, y: 0 } }],
    ["a signature box mode without a signature box", { ...base(), signature: { mode: "box" } }],
    ["version 2", { ...base(), v: 2 }],
  ])("refuses %s", (_label, value) => {
    expect(overlayDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it("drops unknown keys instead of storing them", () => {
    const parsed = overlayDefinitionSchema.parse({ ...base(), script: "<script>", boxes: [{ ...base().boxes[0], style: "x" }] });
    expect(JSON.stringify(parsed)).not.toContain("script");
    expect(JSON.stringify(parsed)).not.toContain("style");
  });
});

describe("overlayGeometryIssues", () => {
  it("refuses boxes past the page edge (the A4 definition on A5: the date box ends at 190 mm on a 148 mm page)", () => {
    expect(overlayGeometryIssues(base(), "A5").map((i) => i.path)).toEqual(["boxes.1"]);
    expect(parseOverlayDefinition(MINIMAL_OVERLAY_DEFINITION, "A5")).toBeNull();
  });

  it("refuses a body region that is too short, too narrow, or inside the page-number band", () => {
    expect(overlayGeometryIssues({ ...base(), flow: { ...base().flow, topMm: 200, bottomMm: 60 } }, "A4")[0].path).toBe("flow");
    expect(overlayGeometryIssues({ ...base(), flow: { ...base().flow, leftMm: 80, rightMm: 80 } }, "A4")[0].path).toBe("flow");
    expect(overlayGeometryIssues({ ...base(), pageNumbers: { bandMm: 10 }, flow: { ...base().flow, bottomMm: 8 } }, "A4")[0].path).toBe("flow.bottomMm");
    const lowBox = { ...base(), pageNumbers: { bandMm: 10 }, boxes: [{ ...base().boxes[0], yMm: 285, hMm: 7 }] };
    expect(overlayGeometryIssues(lowBox, "A4")[0].path).toBe("boxes.0");
  });
});

describe("defaultOverlayDefinition", () => {
  it.each(["A4", "A5"] as const)("is valid and fits %s", (paper) => {
    const def = defaultOverlayDefinition(paper);
    expect(overlayDefinitionSchema.parse(def)).toEqual(def);
    expect(overlayGeometryIssues(def, paper)).toEqual([]);
    expect(def.boxes.map((b) => b.field)).toEqual(["patient.name", "patient.age_gender", "visit.date", "visit.rx_no"]);
  });
});
```

`tests/unit/canonical-json.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/lib/rx-render/canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: "x" } })).toBe('{"a":{"c":"x","d":[3,1,2]},"b":1}');
    expect(canonicalJson({ a: { c: "x", d: [3, 1, 2] }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: "x" } }));
  });

  it("omits undefined properties and escapes strings like JSON", () => {
    expect(canonicalJson({ a: undefined, b: 'q"\n\u2028' })).toBe('{"b":"q\\"\\n\u2028"}');
    expect(canonicalJson([null, true, false, 0, -0, 1.5])).toBe("[null,true,false,0,0,1.5]");
  });

  it("refuses values JSON cannot represent exactly", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson(BigInt(1))).toThrow();
  });
});
```

`tests/unit/publish-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { overlayPublishIssues } from "@/lib/templates/publish-rules";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const def = (): OverlayDefinition => structuredClone(MINIMAL_OVERLAY_DEFINITION) as unknown as OverlayDefinition;
const codes = (d: OverlayDefinition, identity: Parameters<typeof overlayPublishIssues>[2]) => overlayPublishIssues(d, "A4", identity).map((i) => i.code);

describe("overlayPublishIssues", () => {
  it("passes the minimal dynamic definition (the signature block prints the doctor's name and registration)", () => {
    expect(codes(def(), { kind: "dynamic" })).toEqual([]);
  });

  it("needs the patient's name, the date and the medicines", () => {
    const d = { ...def(), boxes: [], flow: { ...def().flow, sections: ["advice" as const] } };
    expect(codes(d, { kind: "dynamic" })).toEqual(["missing_patient_name", "missing_date", "missing_medicines"]);
  });

  it("needs the doctor's name and registration on a dynamic pad that prints the signature in a box", () => {
    const sig = { id: "sig", field: "doctor.signature" as const, xMm: 140, yMm: 250, wMm: 50, hMm: 15, fontPt: 10, align: "center" as const, bold: false, repeat: "every_page" as const };
    const d = { ...def(), signature: { mode: "box" as const }, boxes: [...def().boxes, sig] };
    expect(codes(d, { kind: "dynamic" })).toEqual(["doctor_identity"]);
    const named = { ...d, boxes: [...d.boxes, { ...sig, id: "dn", field: "doctor.name" as const, yMm: 266, hMm: 6 }, { ...sig, id: "dr", field: "doctor.reg_no" as const, yMm: 273, hMm: 6 }] };
    expect(codes(named, { kind: "dynamic" })).toEqual([]);
  });

  it("needs a doctor and an explicit confirmation for a bound pad", () => {
    expect(codes(def(), { kind: "bound", doctorId: null, confirmed: false })).toEqual(["bound_doctor", "bound_confirmation"]);
    expect(codes(def(), { kind: "bound", doctorId: "019a0000-0000-7000-8000-000000000002", confirmed: true })).toEqual([]);
  });

  it("reports geometry problems first", () => {
    expect(overlayPublishIssues(def(), "A5", { kind: "dynamic" })[0].code).toBe("geometry");
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/overlay-definition.test.ts tests/unit/canonical-json.test.ts tests/unit/publish-rules.test.ts`
Expected: FAIL — the three modules do not exist.

- [ ] **Step 2: Implement the definition**

`src/lib/rx-render/overlay-definition.ts`:

```ts
import { z } from "zod";
import { BOX_FIELD_KEYS } from "./fields";
import { PAPER } from "./paper";
import type { SectionKey } from "./templates";
import { BUILTIN_TEMPLATES, type PaperSize } from "./types";

/**
 * An overlay pad (spec section 6.1): the clinic's background image with field boxes on top and one flow region where
 * the prescription body runs across pages. Lengths are millimetres from the page's top-left corner; flow insets are
 * measured from the matching page edge. Stored in template_versions.definition; parse it, never trust it.
 */
export const OVERLAY_LIMITS = {
  maxBoxes: 30,
  minBoxMm: 3,
  minFontPt: 6,
  maxFontPt: 24,
  minFlowHeightMm: 40,
  minFlowWidthMm: 60,
  maxOffsetMm: 10,
  minBandMm: 5,
  maxBandMm: 12,
} as const;

export const SECTION_KEYS = [
  "vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines",
  "investigations", "advice", "followUp",
] as const satisfies readonly SectionKey[];

const tenth = (n: number) => Math.round(n * 10) / 10;
/** z.number() refuses NaN and Infinity; values are rounded to 0.1 so a stored definition hashes the same after a round trip. */
const mm = (min: number, max: number) => z.number().min(min).max(max).transform(tenth);

const boxSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,24}$/),
  field: z.enum(BOX_FIELD_KEYS),
  xMm: mm(0, 210),
  yMm: mm(0, 297),
  wMm: mm(OVERLAY_LIMITS.minBoxMm, 210),
  hMm: mm(OVERLAY_LIMITS.minBoxMm, 297),
  fontPt: z.number().min(OVERLAY_LIMITS.minFontPt).max(OVERLAY_LIMITS.maxFontPt).transform(tenth),
  align: z.enum(["left", "center", "right"]),
  bold: z.boolean(),
  repeat: z.enum(["every_page", "first_page"]),
});

export const overlayDefinitionSchema = z
  .object({
    v: z.literal(1),
    background: z.object({ printMode: z.enum(["always", "pdf_only"]) }),
    boxes: z.array(boxSchema).max(OVERLAY_LIMITS.maxBoxes),
    flow: z.object({
      topMm: mm(0, 297),
      bottomMm: mm(0, 297),
      leftMm: mm(0, 210),
      rightMm: mm(0, 210),
      bodyStyle: z.enum(BUILTIN_TEMPLATES),
      sections: z.array(z.enum(SECTION_KEYS)).min(1).max(SECTION_KEYS.length),
      showRxMark: z.boolean(),
    }),
    signature: z.object({ mode: z.enum(["end_of_content", "box"]) }),
    pageNumbers: z.object({ bandMm: z.union([z.literal(0), mm(OVERLAY_LIMITS.minBandMm, OVERLAY_LIMITS.maxBandMm)]) }),
    printOffsetMm: z.object({ x: mm(-OVERLAY_LIMITS.maxOffsetMm, OVERLAY_LIMITS.maxOffsetMm), y: mm(-OVERLAY_LIMITS.maxOffsetMm, OVERLAY_LIMITS.maxOffsetMm) }),
  })
  .superRefine((def, ctx) => {
    const ids = new Set<string>();
    def.boxes.forEach((box, i) => {
      if (ids.has(box.id)) ctx.addIssue({ code: "custom", message: "Two boxes have the same id.", path: ["boxes", i, "id"] });
      ids.add(box.id);
    });
    if (new Set(def.flow.sections).size !== def.flow.sections.length) {
      ctx.addIssue({ code: "custom", message: "A section is listed twice.", path: ["flow", "sections"] });
    }
    if (def.signature.mode === "box" && !def.boxes.some((b) => b.field === "doctor.signature")) {
      ctx.addIssue({ code: "custom", message: "Add a signature box, or print the signature after the prescription.", path: ["signature", "mode"] });
    }
  });

export type OverlayDefinition = z.infer<typeof overlayDefinitionSchema>;
export type OverlayBox = OverlayDefinition["boxes"][number];
export type GeometryIssue = { path: string; message: string };

const EPSILON = 0.05;

/** Placement problems the schema cannot see because they depend on the paper size. */
export function overlayGeometryIssues(def: OverlayDefinition, paperSize: PaperSize): GeometryIssue[] {
  const { widthMm, heightMm } = PAPER[paperSize];
  const band = def.pageNumbers.bandMm;
  const issues: GeometryIssue[] = [];
  def.boxes.forEach((box, i) => {
    if (box.xMm + box.wMm > widthMm + EPSILON || box.yMm + box.hMm > heightMm - band + EPSILON) {
      issues.push({ path: `boxes.${i}`, message: `The "${box.id}" box goes past the edge of the page${band > 0 ? " or into the page-number band" : ""}.` });
    }
  });
  if (def.flow.bottomMm < band) issues.push({ path: "flow.bottomMm", message: "The body region runs into the page-number band." });
  if (heightMm - def.flow.topMm - def.flow.bottomMm < OVERLAY_LIMITS.minFlowHeightMm) {
    issues.push({ path: "flow", message: `The body region is too short: leave at least ${OVERLAY_LIMITS.minFlowHeightMm} mm for the prescription.` });
  }
  if (widthMm - def.flow.leftMm - def.flow.rightMm < OVERLAY_LIMITS.minFlowWidthMm) {
    issues.push({ path: "flow", message: `The body region is too narrow: leave at least ${OVERLAY_LIMITS.minFlowWidthMm} mm.` });
  }
  return issues;
}

/** The stored definition, or null when it is damaged or does not fit the paper (callers fail closed). Never throws. */
export function parseOverlayDefinition(value: unknown, paperSize: PaperSize): OverlayDefinition | null {
  const parsed = overlayDefinitionSchema.safeParse(value);
  if (!parsed.success) return null;
  return overlayGeometryIssues(parsed.data, paperSize).length === 0 ? parsed.data : null;
}

/** A starting layout: a patient strip under a typical letterhead and the body below it (auto-layout refines it). */
export function defaultOverlayDefinition(paperSize: PaperSize): OverlayDefinition {
  const { widthMm: w, heightMm: h } = PAPER[paperSize];
  const y = tenth(h * 0.18);
  const rowH = paperSize === "A4" ? 7 : 6;
  const font = paperSize === "A4" ? 10 : 8.5;
  const box = (id: string, field: OverlayBox["field"], x: number, width: number, align: OverlayBox["align"]): OverlayBox => ({
    id,
    field,
    xMm: tenth(w * x),
    yMm: y,
    wMm: tenth(w * width),
    hMm: rowH,
    fontPt: font,
    align,
    bold: field === "patient.name",
    repeat: "every_page",
  });
  return {
    v: 1,
    background: { printMode: "always" },
    boxes: [
      box("name", "patient.name", 0.07, 0.4, "left"),
      box("age", "patient.age_gender", 0.48, 0.18, "left"),
      box("date", "visit.date", 0.67, 0.14, "right"),
      box("rx", "visit.rx_no", 0.82, 0.11, "right"),
    ],
    flow: {
      topMm: tenth(y + rowH + 3),
      bottomMm: tenth(h * 0.09),
      leftMm: tenth(w * 0.07),
      rightMm: tenth(w * 0.07),
      bodyStyle: "general",
      sections: [...SECTION_KEYS],
      showRxMark: true,
    },
    signature: { mode: "end_of_content" },
    pageNumbers: { bandMm: 0 },
    printOffsetMm: { x: 0, y: 0 },
  };
}
```

`src/lib/rx-render/canonical-json.ts`:

```ts
/**
 * JSON with object keys sorted at every depth, so equal values always give equal text (the input of template content
 * hashes). Arrays keep their order; undefined properties are omitted; anything JSON cannot represent exactly throws.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}
```

`src/lib/templates/publish-rules.ts`:

```ts
import { overlayGeometryIssues, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { PaperSize } from "@/lib/rx-render/types";

/** How the publisher answered "does the printed letterhead show a doctor's name or registration number?" (decision 19). */
export type PublishIdentity = { kind: "dynamic" } | { kind: "bound"; doctorId: string | null; confirmed: boolean };
export type PublishIssueCode =
  | "geometry"
  | "missing_patient_name"
  | "missing_date"
  | "missing_medicines"
  | "doctor_identity"
  | "bound_doctor"
  | "bound_confirmation";
export type PublishIssue = { code: PublishIssueCode; message: string };

/** Everything that blocks publishing an overlay pad, in the order the editor shows them. Empty means publishable. */
export function overlayPublishIssues(def: OverlayDefinition, paperSize: PaperSize, identity: PublishIdentity): PublishIssue[] {
  const fields = new Set<string>(def.boxes.map((box) => box.field));
  const issues: PublishIssue[] = overlayGeometryIssues(def, paperSize).map((g) => ({ code: "geometry", message: g.message }));
  if (!fields.has("patient.name")) issues.push({ code: "missing_patient_name", message: "Add a box for the patient's name." });
  if (!fields.has("visit.date")) issues.push({ code: "missing_date", message: "Add a box for the date." });
  if (!def.flow.sections.includes("medicines")) issues.push({ code: "missing_medicines", message: "The body region must include the medicines." });
  if (identity.kind === "dynamic") {
    const printsDoctor = def.signature.mode === "end_of_content" || (fields.has("doctor.name") && fields.has("doctor.reg_no"));
    if (!printsDoctor) {
      issues.push({ code: "doctor_identity", message: "Print the doctor's name and registration number: add boxes for both, or show the signature block after the prescription." });
    }
  } else {
    if (!identity.doctorId) issues.push({ code: "bound_doctor", message: "Choose the doctor whose letterhead this is." });
    if (!identity.confirmed) issues.push({ code: "bound_confirmation", message: "Confirm that the letterhead shows this doctor's name and registration number." });
  }
  return issues;
}
```

- [ ] **Step 3: Run the tests**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/overlay-definition.test.ts tests/unit/canonical-json.test.ts tests/unit/publish-rules.test.ts`
Expected: PASS.

- [ ] **Step 4: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/overlay-definition.ts src/lib/rx-render/canonical-json.ts src/lib/templates/publish-rules.ts tests/unit/overlay-definition.test.ts tests/unit/canonical-json.test.ts tests/unit/publish-rules.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(templates): overlay definition schema, geometry and publish rules, canonical JSON" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 12: The overlay renderer and its golden files (pure, TDD)

**Gate:** the S1 finding says GO (fixed background and boxes repeat on every page and the spacers hold in Chromium and Gotenberg).

`renderOverlay` is tested directly here; Task 13 wires it into `renderPrescription` together with the snapshot union (the `overlay` template kind does not exist in the types until then).

**Files:**
- Modify: `src/lib/rx-render/types.ts` (`RenderTarget`, `OverlayInput`, `RenderAssets.overlay`), `src/lib/rx-render/labels.ts` (`sampleWatermark`)
- Create: `src/lib/rx-render/overlay-css.ts`, `src/lib/rx-render/overlay.ts`, `tests/fixtures/overlay-documents.ts`
- Test: `tests/unit/rx-overlay.test.ts`, golden files `tests/unit/__golden__/overlay-a4-en.html`, `overlay-a5-bilingual-long.html`, `overlay-draft-signature-box.html`, `overlay-print-preprinted.html`

**Interfaces:**
- Consumes: `common.ts`, `marks.ts`, `sections.ts` (Task 10), `toTemplateData` (Task 10), `OverlayDefinition`, `defaultOverlayDefinition`, `overlayDefinitionSchema` (Task 11), `documentCss`, `PAPER`, `TEMPLATE_DEFINITIONS`.
- Produces:
  - `types.ts`: `type RenderTarget = "screen" | "print" | "pdf"`; `type OverlayInput = { templateVersionId: string; definition: OverlayDefinition; background: ImageAsset }`; `RenderAssets` gains `overlay?: OverlayInput | null` (optional, so existing callers compile unchanged).
  - `overlay-css.ts`: `overlayCss(def: OverlayDefinition, paper: PaperSpec, offset: { x: number; y: number }): string`.
  - `overlay.ts`: `OVERLAY_RENDERER_VERSION = "overlay-1"`, `EMPTY_FOOTER`, `type OverlayRenderOptions = { target: RenderTarget; sample: boolean }`, `renderOverlay(doc, assets, overlay, options): RenderedDocument` (its `paper.marginMm` is `{ top: 0, right: 0, bottom: bandMm, left: 0 }`, which is what `gotenbergForm` sends).
  - Fixture (`tests/fixtures/overlay-documents.ts`): `OVERLAY_VERSION_ID`, `OVERLAY_HASH`, `overlayDefinition(patch?)`, `a5Definition()`, `overlayInput(definition?)`, `overlayDocument(overrides?)`.
- Render targets: `screen` = in-app preview (background always, no offset; repeated boxes appear once at the top on screen); `print` = paper (printer offset applied; background omitted when `printMode = "pdf_only"`); `pdf` = digital copy for download and sharing (background always, no offset).

- [ ] **Step 1: Extend the types and labels**

In `src/lib/rx-render/types.ts` add `import type { OverlayDefinition } from "./overlay-definition";` and, after `RenderAssets`:

```ts
/** screen: in-app preview. print: paper (printer offset; no background on pre-printed stationery). pdf: digital copy. */
export type RenderTarget = "screen" | "print" | "pdf";

/** A custom overlay pad, loaded and hash-verified by the server (template-resolution.ts) before rendering. */
export type OverlayInput = { templateVersionId: string; definition: OverlayDefinition; background: ImageAsset };
```

and change `RenderAssets` to:

```ts
export type RenderAssets = { logo: ImageAsset | null; signature: ImageAsset | null; fontCss: string; overlay?: OverlayInput | null };
```

In `src/lib/rx-render/labels.ts`, add to `STATUS_TEXT` (inside the existing NEEDS NATIVE-SPEAKER REVIEW block):

```ts
  sampleWatermark: { en: "SAMPLE · NOT A PRESCRIPTION", hi: "नमूना · यह पर्चा नहीं है" },
```

- [ ] **Step 2: Write the fixture**

`tests/fixtures/overlay-documents.ts`:

```ts
import { defaultOverlayDefinition, overlayDefinitionSchema, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { OverlayInput, RxDocument } from "@/lib/rx-render/types";
import { MINIMAL_OVERLAY_DEFINITION } from "./overlay-definitions";
import { TINY_PNG, documentFixture } from "./rx-documents";

export const OVERLAY_VERSION_ID = "019a5c00-0000-7000-8000-00000000a001";
export const OVERLAY_HASH = "ab".repeat(32);

/** The minimal A4 definition, parsed, with top-level parts replaced. */
export function overlayDefinition(patch: Partial<OverlayDefinition> = {}): OverlayDefinition {
  return overlayDefinitionSchema.parse({ ...structuredClone(MINIMAL_OVERLAY_DEFINITION), ...patch });
}

export const a5Definition = (): OverlayDefinition => defaultOverlayDefinition("A5");

export function overlayInput(definition: OverlayDefinition = overlayDefinition()): OverlayInput {
  return { templateVersionId: OVERLAY_VERSION_ID, definition, background: TINY_PNG };
}

/** A finalized prescription for the overlay above (Task 13 points its layout at OVERLAY_VERSION_ID). */
export function overlayDocument(overrides: Parameters<typeof documentFixture>[0] = {}): RxDocument {
  return documentFixture(overrides);
}
```

- [ ] **Step 3: Write the failing renderer test**

`tests/unit/rx-overlay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_FOOTER, renderOverlay, type OverlayRenderOptions } from "@/lib/rx-render/overlay";
import { overlayCss } from "@/lib/rx-render/overlay-css";
import type { OverlayBox } from "@/lib/rx-render/overlay-definition";
import { PAPER } from "@/lib/rx-render/paper";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import type { RenderAssets, RenderTarget, RxDocument } from "@/lib/rx-render/types";
import { DEVANAGARI, HOSTILE, TINY_PNG, manyItems, snapshot } from "../fixtures/rx-documents";
import { a5Definition, overlayDefinition, overlayDocument, overlayInput } from "../fixtures/overlay-documents";

const NO_ASSETS: RenderAssets = { logo: null, signature: null, fontCss: "" };
const SCREEN: OverlayRenderOptions = { target: "screen", sample: false };
const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");
const css = (markup: string) => parse(markup).querySelector("style")?.textContent ?? "";
const box = (patch: Partial<OverlayBox>): OverlayBox => ({ id: "x", field: "patient.name", xMm: 20, yMm: 30, wMm: 60, hMm: 7, fontPt: 10, align: "left", bold: false, repeat: "every_page", ...patch });

function render(doc: RxDocument = overlayDocument(), options: OverlayRenderOptions = SCREEN, input = overlayInput(), assets = NO_ASSETS) {
  return renderOverlay(doc, assets, input, options);
}

describe("renderOverlay", () => {
  it("is self-contained for every target, paper size and status", () => {
    for (const target of ["screen", "print", "pdf"] as RenderTarget[]) {
      for (const [doc, def] of [
        [overlayDocument(), overlayDefinition()],
        [overlayDocument({ layout: { paperSize: "A5", labels: "bilingual" }, items: manyItems(30) }), a5Definition()],
        [overlayDocument({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" }), overlayDefinition({ pageNumbers: { bandMm: 8 } })],
        [overlayDocument({ status: "amended", supersededBy: { version: 2, issuedAt: null } }), overlayDefinition()],
      ] as const) {
        const out = render(doc, { target, sample: target === "screen" }, overlayInput(def), { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG });
        expect(checkSelfContained(out.html)).toEqual({ ok: true });
        expect(checkSelfContained(out.footerHtml)).toEqual({ ok: true });
      }
    }
  });

  it("draws the background, the field boxes and the body region", () => {
    const page = parse(render().html);
    expect(page.querySelector(".bg img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(page.querySelectorAll(".box")).toHaveLength(2);
    expect(page.querySelector(".box-0")?.textContent).toBe("Asha Rao");
    expect(page.querySelector(".box-1")?.textContent).toBe("12/11/2026");
    expect(page.querySelector(".flow .flow-body")?.textContent).toContain("Medicine 1");
    expect(page.querySelector(".flow > thead .flow-top")).not.toBeNull();
    expect(page.querySelector(".flow > tfoot .flow-bottom")).not.toBeNull();
  });

  it("fixes every-page boxes and places first-page boxes once", () => {
    const def = overlayDefinition({ boxes: [box({ id: "a" }), box({ id: "b", field: "visit.rx_no", repeat: "first_page", yMm: 40 })] });
    const out = render(overlayDocument(), SCREEN, overlayInput(def));
    expect(css(out.html)).toContain(".box{position:fixed");
    expect(css(out.html)).toContain(".box-first{position:absolute}");
    expect(parse(out.html).querySelector(".box-1")?.className).toBe("box box-1 box-first");
  });

  it("omits the background only when printing on pre-printed paper", () => {
    const preprinted = overlayInput(overlayDefinition({ background: { printMode: "pdf_only" } }));
    expect(parse(render(overlayDocument(), { target: "print", sample: false }, preprinted).html).querySelector(".bg")).toBeNull();
    expect(parse(render(overlayDocument(), { target: "pdf", sample: false }, preprinted).html).querySelector(".bg")).not.toBeNull();
    expect(parse(render(overlayDocument(), SCREEN, preprinted).html).querySelector(".bg")).not.toBeNull();
    expect(parse(render(overlayDocument(), { target: "print", sample: false }).html).querySelector(".bg")).not.toBeNull();
  });

  it("applies the printer offset to paper only", () => {
    const input = overlayInput(overlayDefinition({ printOffsetMm: { x: 2, y: -1.5 } }));
    const printed = css(render(overlayDocument(), { target: "print", sample: false }, input).html);
    expect(printed).toContain(".box-0{left:22mm;top:50.5mm;");
    expect(printed).toContain(".flow-top{height:62.5mm}");
    const pdf = css(render(overlayDocument(), { target: "pdf", sample: false }, input).html);
    expect(pdf).toContain(".box-0{left:20mm;top:52mm;");
  });

  it("prints hostile text literally and in isolation, and never puts user text in CSS", () => {
    const doc = overlayDocument({ snapshot: snapshot({ patient: { name: `${HOSTILE.script}${HOSTILE.bidi}${HOSTILE.urls}` } }) });
    const out = render(doc);
    const page = parse(out.html);
    expect(page.querySelector("script")).toBeNull();
    expect(page.querySelector(".box-0 .v")?.textContent).toBe(`${HOSTILE.script}${HOSTILE.bidi}${HOSTILE.urls}`);
    expect(css(out.html)).not.toContain("evil.example");
    expect(css(out.html)).not.toContain("alert");
  });

  it("never clips: overflow stays visible and a 2,000-character word prints whole", () => {
    const out = render(overlayDocument({ snapshot: snapshot({ patient: { name: HOSTILE.longWord } }) }));
    expect(css(out.html)).toContain("overflow:visible");
    expect(parse(out.html).querySelector(".box-0")?.textContent).toBe(HOSTILE.longWord);
  });

  it("prints blanks as nothing, never 'undefined'", () => {
    const def = overlayDefinition({ boxes: [box({ id: "reg", field: "doctor.reg_no" }), box({ id: "fu", field: "follow_up.line", yMm: 40 })] });
    const doc = overlayDocument({ snapshot: snapshot({ doctor: { registrationNo: null } }), visit: { ...overlayDocument().visit, followUpDate: null, followUpReason: null } });
    const page = parse(render(doc, SCREEN, overlayInput(def)).html);
    expect(page.querySelector(".box-0")?.textContent).toBe("");
    expect(page.querySelector(".box-1")?.textContent).toBe("");
    expect(page.body.textContent).not.toMatch(/undefined|null/);
  });

  it("never prints a signature image or an Rx number on a draft", () => {
    const def = overlayDefinition({
      signature: { mode: "box" },
      boxes: [box({ id: "sig", field: "doctor.signature", yMm: 250, hMm: 15 }), box({ id: "rx", field: "visit.rx_no", yMm: 40 })],
    });
    const assets = { ...NO_ASSETS, signature: TINY_PNG };
    const draft = parse(render(overlayDocument({ status: "draft", issuedAt: null }), SCREEN, overlayInput(def), assets).html);
    expect(draft.querySelector(".box-0 img")).toBeNull();
    expect(draft.querySelector(".box-1")?.textContent).toBe("");
    expect(draft.querySelector(".watermark")?.textContent).toBe("DRAFT · NOT VALID FOR DISPENSING");
    const final = parse(render(overlayDocument(), SCREEN, overlayInput(def), assets).html);
    expect(final.querySelector(".box-0 img")).not.toBeNull();
    expect(final.querySelector(".box-1")?.textContent).toBe("12");
  });

  it("prints the signature block after the content unless the signature has its own box", () => {
    expect(parse(render().html).querySelector(".closing .sig")).not.toBeNull();
    const def = overlayDefinition({ signature: { mode: "box" }, boxes: [box({ id: "sig", field: "doctor.signature" })] });
    expect(parse(render(overlayDocument(), SCREEN, overlayInput(def)).html).querySelector(".sig")).toBeNull();
  });

  it("marks sample previews", () => {
    expect(parse(render(overlayDocument(), { target: "screen", sample: true }).html).querySelector(".watermark")?.textContent).toBe("SAMPLE · NOT A PRESCRIPTION");
  });

  it("leaves a page-number band only when asked, and sends Gotenberg the matching margins", () => {
    const banded = render(overlayDocument(), SCREEN, overlayInput(overlayDefinition({ pageNumbers: { bandMm: 8 } })));
    expect(css(banded.html)).toContain("@page{size:A4 portrait;margin:0mm 0mm 8mm 0mm}");
    expect(css(banded.html)).toContain("height:289mm");
    expect(banded.paper.marginMm).toEqual({ top: 0, right: 0, bottom: 8, left: 0 });
    expect(banded.footerHtml).toContain('class="pageNumber"');
    const plain = render();
    expect(plain.paper.marginMm).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(plain.footerHtml).toBe(EMPTY_FOOTER);
  });

  it("keeps all 30 medicines in one repeating table", () => {
    const page = parse(render(overlayDocument({ items: manyItems(30) })).html);
    expect(page.querySelectorAll(".meds tbody tr")).toHaveLength(30);
    expect(page.querySelectorAll(".meds thead")).toHaveLength(1);
  });

  it("is deterministic", () => {
    const doc = overlayDocument({ snapshot: snapshot({ patient: { name: DEVANAGARI.name } }) });
    expect(render(doc).html).toBe(render(doc).html);
  });
});

describe("overlayCss", () => {
  it("contains only CSS built from numbers and fixed words", () => {
    const text = overlayCss(overlayDefinition(), PAPER.A4, { x: 0, y: 0 });
    expect(text).toMatch(/^[a-z0-9.\-{}:;%(),> @\n]+$/i);
  });

  it("throws on a number that is not finite (a programming error: the schema refuses it)", () => {
    const def = overlayDefinition();
    expect(() => overlayCss({ ...def, boxes: [{ ...def.boxes[0], xMm: Number.NaN }] }, PAPER.A4, { x: 0, y: 0 })).toThrow();
  });
});

describe("overlay golden files", () => {
  const assets: RenderAssets = { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG };

  it("A4, English, three medicines (screen)", async () => {
    await expect(render(overlayDocument(), SCREEN, overlayInput(), assets).html).toMatchFileSnapshot("./__golden__/overlay-a4-en.html");
  });

  it("A5, bilingual, 12 medicines, Devanagari name (pdf)", async () => {
    const doc = overlayDocument({ layout: { paperSize: "A5", labels: "bilingual" }, items: manyItems(12), snapshot: snapshot({ patient: { name: DEVANAGARI.name }, layout: { paperSize: "A5", labels: "bilingual" } }) });
    await expect(render(doc, { target: "pdf", sample: false }, overlayInput(a5Definition()), assets).html).toMatchFileSnapshot("./__golden__/overlay-a5-bilingual-long.html");
  });

  it("draft with a signature box (screen)", async () => {
    const def = overlayDefinition({ signature: { mode: "box" }, boxes: [...overlayDefinition().boxes, box({ id: "sig", field: "doctor.signature", xMm: 140, yMm: 255, wMm: 50, hMm: 15 })] });
    await expect(render(overlayDocument({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" }), SCREEN, overlayInput(def), assets).html).toMatchFileSnapshot("./__golden__/overlay-draft-signature-box.html");
  });

  it("pre-printed paper with a printer offset (print)", async () => {
    const def = overlayDefinition({ background: { printMode: "pdf_only" }, printOffsetMm: { x: 1.5, y: -2 }, pageNumbers: { bandMm: 8 } });
    await expect(render(overlayDocument(), { target: "print", sample: false }, overlayInput(def), assets).html).toMatchFileSnapshot("./__golden__/overlay-print-preprinted.html");
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/rx-overlay.test.ts`
Expected: FAIL — `@/lib/rx-render/overlay` does not exist.

- [ ] **Step 4: Implement the overlay CSS**

`src/lib/rx-render/overlay-css.ts`:

```ts
import type { OverlayDefinition } from "./overlay-definition";
import type { PaperSpec } from "./types";

const ALIGN = { left: "left", center: "center", right: "right" } as const;

/** A validated length as CSS text. A non-finite number cannot come from a parsed definition: it is a bug, so it throws. */
function n(value: number): string {
  if (!Number.isFinite(value)) throw new Error("overlay css: a length is not a finite number");
  const rounded = Math.round(value * 10) / 10;
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * Positions for one overlay pad, built ONLY from numbers of a definition that overlayDefinitionSchema accepted and from
 * fixed words (spec section 6.2): no strings from the definition, no url(), no comments. Box classes use the box's
 * index, never its id. `paper` is the full page (PAPER[size]); `offset` is the printer calibration (paper only).
 */
export function overlayCss(def: OverlayDefinition, paper: PaperSpec, offset: { x: number; y: number }): string {
  const band = def.pageNumbers.bandMm;
  const top = Math.max(0, def.flow.topMm + offset.y);
  const bottom = Math.max(0, def.flow.bottomMm - band - offset.y);
  const left = Math.max(0, def.flow.leftMm + offset.x);
  const right = Math.max(0, def.flow.rightMm - offset.x);
  return [
    `.overlay .bg{position:fixed;left:${n(offset.x)}mm;top:${n(offset.y)}mm;width:${n(paper.widthMm)}mm;height:${n(paper.heightMm - band)}mm;z-index:0;overflow:hidden}`,
    ".overlay .bg img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}",
    ".box{position:fixed;z-index:1;overflow:visible;line-height:1.2;overflow-wrap:anywhere}",
    ".box-first{position:absolute}",
    ".box img{display:block;max-width:100%;max-height:100%;width:auto;height:auto}",
    ".flow{position:relative;z-index:1;width:100%;border-collapse:collapse}",
    ".flow>thead{display:table-header-group}",
    ".flow>tfoot{display:table-footer-group}",
    ".flow>thead>tr>td,.flow>tfoot>tr>td{padding:0}",
    `.flow-top{height:${n(top)}mm}`,
    `.flow-bottom{height:${n(bottom)}mm}`,
    `.flow-body{padding:0 ${n(right)}mm 0 ${n(left)}mm;vertical-align:top}`,
    ...def.boxes.map(
      (box, i) =>
        `.box-${i}{left:${n(box.xMm + offset.x)}mm;top:${n(box.yMm + offset.y)}mm;width:${n(box.wMm)}mm;height:${n(box.hMm)}mm;font-size:${n(box.fontPt)}pt;text-align:${ALIGN[box.align]};font-weight:${box.bold ? 700 : 400}}`,
    ),
    // On screen there are no pages: the preview is one sheet with everything placed relative to it.
    `@media screen{body.overlay{position:relative;width:${n(paper.widthMm)}mm;min-height:${n(paper.heightMm)}mm;padding:0}.overlay .bg,.overlay .box{position:absolute}}`,
  ].join("\n");
}
```

- [ ] **Step 5: Implement the renderer**

`src/lib/rx-render/overlay.ts`:

```ts
import { DOCUMENT_CSP, documentTitle, footerTemplate, image, present, type Ctx } from "./common";
import { html, raw, userText, type SafeHtml } from "./html";
import { statusText } from "./labels";
import { signature, snapshotNote, statusBanner, watermark } from "./marks";
import { overlayCss } from "./overlay-css";
import type { OverlayBox } from "./overlay-definition";
import { PAPER } from "./paper";
import { allergies, section } from "./sections";
import { documentCss } from "./styles";
import { toTemplateData, type TemplateData } from "./template-data";
import { TEMPLATE_DEFINITIONS, type SectionKey } from "./templates";
import type { OverlayInput, PaperSpec, RenderAssets, RenderedDocument, RenderTarget, RxDocument } from "./types";

/** Logged per output (prescription_outputs.renderer_version) for overlay pads; bump when overlay output changes. */
export const OVERLAY_RENDERER_VERSION = "overlay-1";

/** Gotenberg's footer when there is no page-number band (no margin, so nothing would show anyway). */
export const EMPTY_FOOTER = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

export type OverlayRenderOptions = { target: RenderTarget; sample: boolean };

function boxContent(c: Ctx, data: TemplateData, box: OverlayBox): SafeHtml | null {
  if (box.field === "clinic.logo") return image(c.assets.logo);
  // A draft is never signed (ADR-0032), whatever the caller passed in.
  if (box.field === "doctor.signature") return c.doc.status === "draft" ? null : image(c.assets.signature);
  const value = data.text[box.field];
  return present(value) ? userText(value) : null;
}

function boxMarkup(c: Ctx, data: TemplateData, box: OverlayBox, index: number): SafeHtml {
  const className = `box box-${index}${box.repeat === "first_page" ? " box-first" : ""}`;
  return html`<div class="${className}">${boxContent(c, data, box)}</div>`;
}

/**
 * A clinic's own pad (spec section 6.2): the background and the every-page boxes are position:fixed, so Chromium repeats
 * them on every printed page; first-page boxes are absolute; the clinical body flows inside a table whose thead and tfoot
 * spacers keep it clear of the letterhead and the footer on every page, drawn by the same section and medicine renderers
 * as the built-in pads. Pure, self-contained, and inside the same safety rules (common.ts).
 */
export function renderOverlay(doc: RxDocument, assets: RenderAssets, overlay: OverlayInput, options: OverlayRenderOptions): RenderedDocument {
  const { paperSize, labels } = doc.snapshot.layout;
  const def = overlay.definition;
  const full = PAPER[paperSize];
  const band = def.pageNumbers.bandMm;
  const paper: PaperSpec = { ...full, marginMm: { top: 0, right: 0, bottom: band, left: 0 } };
  const c: Ctx = { doc, def: TEMPLATE_DEFINITIONS[def.flow.bodyStyle], lang: labels, assets, paper };
  const data = toTemplateData(doc, labels);
  const printing = options.target === "print";
  const offset = printing ? def.printOffsetMm : { x: 0, y: 0 };
  const background = printing && def.background.printMode === "pdf_only" ? null : image(overlay.background);
  const title = documentTitle(doc);

  const sections = def.flow.sections
    .map((key) => ({ key, markup: section(c, key) }))
    .filter((entry): entry is { key: SectionKey; markup: SafeHtml } => entry.markup !== null);
  const endSignature = def.signature.mode === "end_of_content";
  // As on the built-in pads: the signature stays with the last block of text, never with a long medicine table.
  const last = endSignature && sections.length > 0 && sections[sections.length - 1].key !== "medicines" ? sections.pop() : undefined;
  const mark = options.sample ? html`<div class="watermark">${statusText("sampleWatermark", labels)}</div>` : watermark(c);

  const page = html`<!doctype html>
<html lang="${labels === "en" ? "en" : "hi"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>${title}</title>
<style>${raw(assets.fontCss)}
${raw(documentCss(c.def, paper))}
${raw(overlayCss(def, full, offset))}</style>
</head>
<body class="overlay paper-${paperSize.toLowerCase()} status-${doc.status} target-${options.target}" data-rx="ready">
${background ? html`<div class="bg">${background}</div>` : null}
${mark}
${def.boxes.map((box, i) => boxMarkup(c, data, box, i))}
<table class="flow">
<thead><tr><td><div class="flow-top"></div></td></tr></thead>
<tfoot><tr><td><div class="flow-bottom"></div></td></tr></tfoot>
<tbody><tr><td class="flow-body">
${statusBanner(c)}
${allergies(c)}
${def.flow.showRxMark ? html`<div class="rx-mark">R<span>x</span></div>` : null}
${sections.map((entry) => entry.markup)}
${endSignature ? html`<div class="closing">${last?.markup}${signature(c)}</div>` : null}
${snapshotNote(c)}
</td></tr></tbody>
</table>
</body>
</html>
`;
  const footerHtml = band > 0 ? footerTemplate(doc, { ...paper, marginMm: { ...paper.marginMm, left: def.flow.leftMm } }) : EMPTY_FOOTER;
  return { format: "html", html: page.value, footerHtml, paper, title };
}
```

- [ ] **Step 6: Run the tests, then read the golden files**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/rx-overlay.test.ts`
Expected: PASS, and four new files under `tests/unit/__golden__/` (written on first run). Open each and check by eye: the background `<img>` sits in `.bg` (absent in `overlay-print-preprinted.html`), the boxes carry `box-<n>` classes, no user text appears inside `<style>`, the draft golden has no `<img>` inside a box and shows the draft watermark. Run the file a second time: still PASS with no golden change (`git status --porcelain tests/unit/__golden__` lists only the four new files).

- [ ] **Step 7: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/types.ts src/lib/rx-render/labels.ts src/lib/rx-render/overlay-css.ts src/lib/rx-render/overlay.ts tests/fixtures/overlay-documents.ts tests/unit/rx-overlay.test.ts tests/unit/__golden__/overlay-a4-en.html tests/unit/__golden__/overlay-a5-bilingual-long.html tests/unit/__golden__/overlay-draft-signature-box.html tests/unit/__golden__/overlay-print-preprinted.html
Set-Location E:\projects\clinicpad; git commit -m "feat(rx-render): overlay pad renderer inside the self-contained HTML pipeline" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 13: Snapshot v2, template resolution at finalize, and frozen template versions

**Files:**
- Modify: `src/lib/rx-render/snapshot.ts` (v2 + v1 parser), `src/lib/rx-render/types.ts` (`TemplateRef`, `OverlayTemplateRef`, `PadLayout` from the snapshot), `src/lib/rx-render/render.ts` (overlay dispatch, `RenderOptions`, `RENDERER_VERSIONS`, `rendererVersionFor`)
- Create: `src/server/templates/content-hash.ts`, `src/server/services/template-resolution.ts`
- Modify: `src/server/services/render-snapshot.ts` (`compose` takes a layout; `buildFinalSnapshot` resolves; new `buildDraftSnapshot`), `src/server/services/prescriptions.ts` (finalize writes `templateVersionId`; `PrescriptionView.templateVersionId`), `src/server/services/rx-mapping.ts` (amend rule `reset`)
- Modify tests: `tests/fixtures/rx-documents.ts` (`v: 2`), `tests/fixtures/overlay-documents.ts` (overlay layout), `tests/unit/rx-column-rules.test.ts` (line 36), `tests/integration/render-snapshot.test.ts` (line 137 `v: 2`), `tests/helpers/templates.ts` (`insertPublishedOverlay`, `publishNewVersion`)
- Create tests: `tests/unit/snapshot-v2.test.ts`, `tests/helpers/rx-flow.ts`, `tests/integration/template-resolution.test.ts`

**Interfaces:**
- Consumes: `parseOverlayDefinition` (Task 11), `canonicalJson` (Task 11), `renderOverlay`, `OVERLAY_RENDERER_VERSION` (Task 12), `loadTemplateFileIn`, `fileAsImageAsset` (Task 9), `templates`, `templateVersions`, `templateFiles`, `clinics`, `doctors`.
- Produces:
  - `snapshot.ts`: `renderSnapshotSchema` (v2), `renderSnapshotV1Schema`, `type RenderSnapshot` (v2 shape), `parseRenderSnapshot(value): RenderSnapshot | null` (accepts v1 and v2, returns v2).
  - `types.ts`: `type TemplateRef = RenderSnapshot["layout"]["template"]` (`{ kind: "builtin"; key } | { kind: "overlay"; templateVersionId: string; contentSha256: string }`), `type OverlayTemplateRef`, `type PadLayout = RenderSnapshot["layout"]`.
  - `render.ts`: `type RenderOptions = { target?: RenderTarget; sample?: boolean }`, `renderPrescription(doc, assets, options?)`, `RENDERER_VERSIONS = { builtin: "1", overlay: "overlay-1" }`, `rendererVersionFor(template: TemplateRef): string` (`RENDERER_VERSION` stays `"1"`).
  - `content-hash.ts`: `type TemplateContent = { kind: "overlay"; paperSize; labels; definition: OverlayDefinition; fileSha256: string }`, `templateContentSha256(content): string`.
  - `template-resolution.ts`: `TEMPLATE_DAMAGED_MESSAGE`, `TEMPLATE_UNUSABLE_MESSAGE`, `builtinLayout(clinic): PadLayout`, `resolveTemplateIn(tx, tenantId, clinic, doctor): Promise<Result<PadLayout>>`, `loadOverlayIn(tx, tenantId, layout: PadLayout): Promise<OverlayInput | null>`.
  - `render-snapshot.ts`: `buildDraftSnapshot(tx, sources): Promise<Result<RenderSnapshot>>` (Task 14's loader uses it for drafts).
  - `PrescriptionView.templateVersionId: string | null` (Task 19 uses it).
  - Test helpers: `insertPublishedOverlay(tenantId, opts?) → { templateId, versionId, fileId, contentSha256 }`, `publishNewVersion(tenantId, templateId, opts?) → { versionId, contentSha256 }`; `tests/helpers/rx-flow.ts`: `newPatient(ctx, name)`, `savedDraft(ctx, patientId)`, `finalized(ctx, patientId)`.

- [ ] **Step 1: Write the failing snapshot test**

`tests/unit/snapshot-v2.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderPrescription } from "@/lib/rx-render/render";
import { parseRenderSnapshot, renderSnapshotSchema } from "@/lib/rx-render/snapshot";
import { snapshot } from "../fixtures/rx-documents";
import { OVERLAY_HASH, OVERLAY_VERSION_ID, overlayDocument, overlayInput } from "../fixtures/overlay-documents";

const overlayRef = { kind: "overlay" as const, templateVersionId: OVERLAY_VERSION_ID, contentSha256: OVERLAY_HASH };
const NO_ASSETS = { logo: null, signature: null, fontCss: "" };

describe("render snapshot v2", () => {
  it("reads a version 1 snapshot (everything finalized before Plan 2A) as v2 with the same content", () => {
    const v1 = { ...snapshot(), v: 1 };
    expect(parseRenderSnapshot(v1)).toEqual({ ...v1, v: 2 });
  });

  it("accepts an overlay reference with a version id and a content hash", () => {
    expect(parseRenderSnapshot(snapshot({ layout: { template: overlayRef } }))?.layout.template).toEqual(overlayRef);
  });

  it.each([
    ["an overlay reference inside a v1 snapshot", { ...snapshot({ layout: { template: overlayRef } }), v: 1 }],
    ["a malformed content hash", snapshot({ layout: { template: { ...overlayRef, contentSha256: "XYZ" } } })],
    ["a missing version id", snapshot({ layout: { template: { kind: "overlay", contentSha256: OVERLAY_HASH } as never } })],
    ["a DOCX reference (2B)", snapshot({ layout: { template: { ...overlayRef, kind: "docx" } as never } })],
    ["version 3", { ...snapshot(), v: 3 }],
  ])("refuses %s", (_label, value) => {
    expect(parseRenderSnapshot(value)).toBeNull();
  });

  it("writes version 2", () => {
    expect(renderSnapshotSchema.parse(snapshot()).v).toBe(2);
  });
});

describe("renderPrescription dispatch", () => {
  it("draws an overlay document only with its own loaded template", () => {
    const doc = overlayDocument();
    expect(renderPrescription(doc, { ...NO_ASSETS, overlay: overlayInput() }).html).toContain('<table class="flow">');
    expect(() => renderPrescription(doc, NO_ASSETS)).toThrow(/not loaded/);
    expect(() => renderPrescription(doc, { ...NO_ASSETS, overlay: { ...overlayInput(), templateVersionId: "019a5c00-0000-7000-8000-00000000ffff" } })).toThrow(/not loaded/);
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/snapshot-v2.test.ts`
Expected: FAIL (type errors on the overlay template kind; `v: 1` parses as v1).

- [ ] **Step 2: Implement snapshot v2**

Replace `src/lib/rx-render/snapshot.ts` with:

```ts
import { z } from "zod";
import { isCalendarDate, isValidTimeZone } from "./format";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES } from "./types";

/**
 * Snapshot limits must be >= every write-side limit (patient, clinic and doctor validation), so
 * anything that can be saved can also be frozen and printed. They are deliberately looser than the
 * write side (names 200, lines 200, free text 5,000, bounded lists); tests/unit/rx-labels.test.ts
 * pins this against the write-side numbers. Raise a snapshot limit before raising a write-side one.
 */
const name = z.string().max(200);
const line = z.string().max(200);
const freeText = z.string().max(5000);
const assetId = z.uuid().nullable();

const parts = {
  takenAt: z.iso.datetime({ offset: true }),
  patient: z.object({
    name,
    patientNo: z.number().int().nullable(),
    gender: z.string().max(32).nullable(),
    dob: z.string().refine(isCalendarDate, "dob must be YYYY-MM-DD").nullable(),
    ageLabel: z.string().max(32),
    allergies: z.array(line).max(50),
  }),
  clinic: z.object({
    name,
    addressLines: z.array(line).max(10),
    phone: line.nullable(),
    email: z.string().max(254).nullable(),
    footerLines: z.array(freeText).max(10),
    logoAssetId: assetId,
    timezone: z.string().refine(isValidTimeZone, "timezone must be an IANA zone"),
  }),
  doctor: z.object({
    name,
    qualifications: line.nullable(),
    designation: line.nullable(),
    registrationNo: z.string().max(80).nullable(),
    registrationCouncil: line.nullable(),
    signatureAssetId: assetId,
  }),
};

const builtinRef = z.object({ kind: z.literal("builtin"), key: z.enum(BUILTIN_TEMPLATES) });
/** A custom pad, frozen by version id AND content hash (Plan 2A, ADR-0045): reprints verify both. */
const overlayRef = z.object({ kind: z.literal("overlay"), templateVersionId: z.uuid(), contentSha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** Version 1 (Plan 1C): built-in pads only. Still parsed: finalized rows can never be rewritten. */
export const renderSnapshotV1Schema = z.object({
  v: z.literal(1),
  ...parts,
  layout: z.object({ template: builtinRef, paperSize: z.enum(PAPER_SIZES), labels: z.enum(LABEL_LANGUAGES) }),
});

/** Shape of prescriptions.render_snapshot, version 2. Bump `v` and keep a parser per version if it changes. */
export const renderSnapshotSchema = z.object({
  v: z.literal(2),
  ...parts,
  layout: z.object({
    template: z.discriminatedUnion("kind", [builtinRef, overlayRef]),
    paperSize: z.enum(PAPER_SIZES),
    labels: z.enum(LABEL_LANGUAGES),
  }),
});

export type RenderSnapshot = z.infer<typeof renderSnapshotSchema>;

/**
 * The stored jsonb is data, not trusted code: parse it, and treat anything unexpected as damaged. Version 1 snapshots
 * are read as version 2 in memory (no backfill: finalized rows are frozen). Never throws.
 */
export function parseRenderSnapshot(value: unknown): RenderSnapshot | null {
  const v2 = renderSnapshotSchema.safeParse(value);
  if (v2.success) return v2.data;
  const v1 = renderSnapshotV1Schema.safeParse(value);
  return v1.success ? { ...v1.data, v: 2 } : null;
}
```

In `src/lib/rx-render/types.ts`, replace the `TemplateRef` comment and type and the `PadLayout` type with:

```ts
/** Which template draws the pad: a built-in key, or a frozen custom version (Plan 2A). Phase 2B adds "docx". */
export type TemplateRef = RenderSnapshot["layout"]["template"];
export type OverlayTemplateRef = Extract<TemplateRef, { kind: "overlay" }>;

export type PadLayout = RenderSnapshot["layout"];
```

In `tests/fixtures/rx-documents.ts`, change `v: 1,` in `snapshot()` to `v: 2,`. In `tests/fixtures/overlay-documents.ts`, change `overlayDocument` to:

```ts
/** A finalized prescription that prints on OVERLAY_VERSION_ID (override anything, the layout included). */
export function overlayDocument(overrides: Parameters<typeof documentFixture>[0] = {}): RxDocument {
  const { layout, ...rest } = overrides;
  return documentFixture({ ...rest, layout: { template: { kind: "overlay", templateVersionId: OVERLAY_VERSION_ID, contentSha256: OVERLAY_HASH }, ...layout } });
}
```

(`documentFixture` builds `snapshot({ layout })` from `overrides.layout`; a test that passes its own `snapshot` must pass the overlay layout inside it too — the A5 golden in Task 12 passes `layout` both ways, which keeps working.)

- [ ] **Step 3: Dispatch overlays**

Replace the body of `src/lib/rx-render/render.ts` below its imports with:

```ts
export { DOCUMENT_CSP, footerTemplate } from "./common";

/**
 * Bump when templates, labels, CSS, fonts or layout change in a way that alters printed output.
 * The document DATA is frozen at finalize (the snapshot); the PRESENTATION of built-in pads is not, so every
 * output row records the version that drew it (prescription_outputs.renderer_version).
 */
export const RENDERER_VERSION = "1";

/** Renderer version per template kind, logged with every output. */
export const RENDERER_VERSIONS = { builtin: RENDERER_VERSION, overlay: OVERLAY_RENDERER_VERSION } as const;

export function rendererVersionFor(template: TemplateRef): string {
  return RENDERER_VERSIONS[template.kind];
}

export type RenderOptions = { target?: RenderTarget; sample?: boolean };

/**
 * Renders a prescription pad as one self-contained HTML document. Pure: the same input gives byte-identical output.
 * Dispatches on the template kind (the switch has no default: a new TemplateRef kind fails to compile until it is
 * drawn). An overlay prints only with the exact template version the snapshot names, loaded and verified by the server;
 * anything else is a programming error. Safety rules: src/lib/rx-render/common.ts.
 */
export function renderPrescription(doc: RxDocument, assets: RenderAssets, options: RenderOptions = {}): RenderedDocument {
  const { template, paperSize, labels } = doc.snapshot.layout;
  switch (template.kind) {
    case "builtin":
      return renderBuiltin({ doc, def: TEMPLATE_DEFINITIONS[template.key], lang: labels, assets, paper: PAPER[paperSize] });
    case "overlay": {
      const overlay = assets.overlay;
      if (!overlay || overlay.templateVersionId !== template.templateVersionId) {
        throw new Error("renderPrescription: the overlay template for this document was not loaded");
      }
      return renderOverlay(doc, assets, overlay, { target: options.target ?? "screen", sample: options.sample === true });
    }
  }
}
```

and its imports become:

```ts
import { renderBuiltin } from "./builtin";
import { OVERLAY_RENDERER_VERSION, renderOverlay } from "./overlay";
import { PAPER } from "./paper";
import { TEMPLATE_DEFINITIONS } from "./templates";
import type { RenderAssets, RenderedDocument, RenderTarget, RxDocument, TemplateRef } from "./types";
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/snapshot-v2.test.ts tests/unit/rx-render.test.ts tests/unit/rx-overlay.test.ts tests/unit/rx-labels.test.ts`
Expected: PASS; no golden file changes. Then run `npm run typecheck`: it reports exactly two errors, the `layout.template.key` reads in `recordOutput` (`src/server/services/rx-output.ts`) and in `render` (`src/server/services/share-open.ts`), because an overlay reference has no `key`. Fix both now with the smallest correct change (Task 14 replaces them with `outputTemplateColumns`): read `const template = bundle.document.snapshot.layout.template;` and write `templateKey: template.kind === "builtin" ? template.key : "overlay"`. No overlay document can reach either function before Task 14 (the loader does not load overlay templates yet, so rendering one throws), so no output row with `template_key = 'overlay'` and no version id can be written in between.

- [ ] **Step 4: Write the content hash**

`src/server/templates/content-hash.ts`:

```ts
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/rx-render/canonical-json";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { LabelLanguage, PaperSize } from "@/lib/rx-render/types";

export type TemplateContent = { kind: "overlay"; paperSize: PaperSize; labels: LabelLanguage; definition: OverlayDefinition; fileSha256: string };

/**
 * The value a snapshot freezes (ADR-0045): SHA-256 of the canonical JSON of everything that decides how a custom pad
 * prints, the PARSED definition (lengths rounded, unknown keys dropped) and the stored file's hash included.
 */
export function templateContentSha256(content: TemplateContent): string {
  const canonical = canonicalJson({ v: 1, kind: content.kind, paperSize: content.paperSize, labels: content.labels, definition: content.definition, fileSha256: content.fileSha256 });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
```

- [ ] **Step 5: Write the resolution service**

`src/server/services/template-resolution.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { parseOverlayDefinition } from "@/lib/rx-render/overlay-definition";
import {
  BUILTIN_TEMPLATES,
  LABEL_LANGUAGES,
  PAPER_SIZES,
  pickOption,
  type LabelLanguage,
  type OverlayInput,
  type PadLayout,
  type PaperSize,
} from "@/lib/rx-render/types";
import { clinics, doctors, templateFiles, templates, templateVersions } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import { templateContentSha256 } from "@/server/templates/content-hash";
import { fileAsImageAsset, loadTemplateFileIn } from "./template-files";

/** Shown when a frozen pad no longer matches what was signed: never print something else instead. */
export const TEMPLATE_DAMAGED_MESSAGE = "This prescription's pad template is damaged, so it cannot be printed. Contact support.";
/** Shown when the pad assigned to the signer cannot be used at finalize: nothing is finalized and no number is used. */
export const TEMPLATE_UNUSABLE_MESSAGE =
  "The pad assigned to you is damaged, so the prescription was not finalized. Ask the clinic owner to publish the pad again, or remove the assignment.";

type ClinicRow = typeof clinics.$inferSelect;
type DoctorRow = typeof doctors.$inferSelect;

const oneOf = <T extends string>(options: readonly T[], value: string): T | null => ((options as readonly string[]).includes(value) ? (value as T) : null);

/** The built-in pad chosen in the clinic's settings (Plan 1C behaviour, unchanged). */
export function builtinLayout(clinic: ClinicRow | null): PadLayout {
  return {
    template: { kind: "builtin", key: pickOption(BUILTIN_TEMPLATES, clinic?.rxTemplate, "general") },
    paperSize: pickOption(PAPER_SIZES, clinic?.rxPaperSize, "A4"),
    labels: pickOption(LABEL_LANGUAGES, clinic?.rxLabels, "en"),
  };
}

/**
 * Which pad a prescription signed by `doctor` prints on (decision 9): the doctor's own template, then the clinic
 * default, then the built-in pad. A template is usable when it is active and has a published current version; a bound
 * template is used only for its own doctor and skipped (never used) for anyone else. A usable template whose stored
 * content no longer matches its hash fails closed. Plain reads, no locks: published versions never change.
 */
export async function resolveTemplateIn(tx: TenantTx, tenantId: string, clinic: ClinicRow | null, doctor: DoctorRow | null): Promise<Result<PadLayout>> {
  const candidates = [doctor?.templateId ?? null, clinic?.customTemplateId ?? null].filter(
    (id, i, all): id is string => id !== null && all.indexOf(id) === i,
  );
  for (const templateId of candidates) {
    const [template] = await tx.select().from(templates).where(and(eq(templates.tenantId, tenantId), eq(templates.id, templateId))).limit(1);
    if (!template || template.kind !== "overlay" || template.status !== "active" || template.currentVersionId === null) continue;
    if (template.identity === "bound" && (doctor === null || template.boundDoctorId !== doctor.id)) continue;
    const [version] = await tx
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.tenantId, tenantId), eq(templateVersions.id, template.currentVersionId)))
      .limit(1);
    const paperSize: PaperSize | null = version ? oneOf(PAPER_SIZES, version.paperSize) : null;
    const labels: LabelLanguage | null = version ? oneOf(LABEL_LANGUAGES, version.labels) : null;
    const definition = version && paperSize ? parseOverlayDefinition(version.definition, paperSize) : null;
    const [file] = version
      ? await tx.select({ sha256: templateFiles.sha256 }).from(templateFiles).where(and(eq(templateFiles.tenantId, tenantId), eq(templateFiles.id, version.fileId))).limit(1)
      : [];
    if (!version || version.state !== "published" || !version.contentSha256 || !paperSize || !labels || !definition || !file) {
      return fail("invalid", TEMPLATE_UNUSABLE_MESSAGE);
    }
    const contentSha256 = templateContentSha256({ kind: "overlay", paperSize, labels, definition, fileSha256: file.sha256 });
    if (contentSha256 !== version.contentSha256) return fail("invalid", TEMPLATE_UNUSABLE_MESSAGE);
    return ok({ template: { kind: "overlay", templateVersionId: version.id, contentSha256 }, paperSize, labels });
  }
  return ok(builtinLayout(clinic));
}

/**
 * The exact template a document names, re-verified byte for byte (spec section 5.4): the version must be published and
 * carry the frozen hash, the file bytes must match their hash (loadTemplateFileIn), and the hash recomputed from the
 * parsed definition and the file must equal the snapshot's. null on any mismatch: the caller fails closed.
 */
export async function loadOverlayIn(tx: TenantTx, tenantId: string, layout: PadLayout): Promise<OverlayInput | null> {
  if (layout.template.kind !== "overlay") return null;
  const ref = layout.template;
  const [version] = await tx
    .select()
    .from(templateVersions)
    .where(and(eq(templateVersions.tenantId, tenantId), eq(templateVersions.id, ref.templateVersionId)))
    .limit(1);
  if (!version || version.state !== "published" || version.contentSha256 !== ref.contentSha256) return null;
  if (version.paperSize !== layout.paperSize || version.labels !== layout.labels) return null;
  const definition = parseOverlayDefinition(version.definition, layout.paperSize);
  const file = definition ? await loadTemplateFileIn(tx, tenantId, version.fileId) : null;
  if (!definition || !file) return null;
  const contentSha256 = templateContentSha256({ kind: "overlay", paperSize: layout.paperSize, labels: layout.labels, definition, fileSha256: file.sha256 });
  if (contentSha256 !== ref.contentSha256) return null;
  return { templateVersionId: version.id, definition, background: fileAsImageAsset(file) };
}
```

- [ ] **Step 6: Resolve at finalize and for drafts**

In `src/server/services/render-snapshot.ts`:
- add imports `import type { PadLayout } from "@/lib/rx-render/types";` and `import { builtinLayout, resolveTemplateIn } from "./template-resolution";`; remove the now-unused `BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES, pickOption` import;
- change `function compose(found: Gathered, at: Date): RenderSnapshot` to `function compose(found: Gathered, at: Date, layout: PadLayout): RenderSnapshot`, its `v: 1` to `v: 2`, and its `layout: { … }` block to `layout,`;
- `buildRenderSnapshot` returns `compose(found, sources.at, builtinLayout(found.clinic))` (rows finalized before Plan 1C keep the built-in pad);
- replace `buildFinalSnapshot` and add `buildDraftSnapshot`:

```ts
/**
 * The snapshot finalize freezes into the record (ADR-0032, ADR-0045), or `invalid` when it cannot be a faithful one:
 * the patient or the clinic profile is missing, a stored value is unprintable, or the signer's pad template is damaged.
 * The pad is resolved for the finalizing doctor (template-resolution.ts). Nothing here allocates or writes.
 */
export async function buildFinalSnapshot(tx: TenantTx, sources: SnapshotSources): Promise<Result<RenderSnapshot>> {
  const found = await gather(tx, sources);
  if (!found.patient) return fail("invalid", "The patient record could not be read, so the prescription cannot be finalized.");
  if (!found.clinic) {
    return fail("invalid", "Set up the clinic profile (name and address) before finalizing prescriptions.");
  }
  const layout = await resolveTemplateIn(tx, sources.tenantId, found.clinic, found.doctor);
  if (!layout.ok) return layout;
  const snapshot = parseRenderSnapshot(compose(found, sources.at, layout.value));
  if (!snapshot) {
    return fail(
      "invalid",
      "The patient, clinic, or doctor details cannot be printed as they are. Check the clinic profile and the patient record, then finalize again.",
    );
  }
  return ok(snapshot);
}

/** A draft's preview snapshot with the pad its would-be signer would get (spec section 5.3). Call it only inside withTenant(). */
export async function buildDraftSnapshot(tx: TenantTx, sources: SnapshotSources): Promise<Result<RenderSnapshot>> {
  const found = await gather(tx, sources);
  const layout = await resolveTemplateIn(tx, sources.tenantId, found.clinic, found.doctor);
  if (!layout.ok) return layout;
  return ok(compose(found, sources.at, layout.value));
}
```

In `src/server/services/prescriptions.ts` `finalizePrescription`, right after `const renderSnapshot = built.value;` add:

```ts
      // Plan 2A (ADR-0045): the resolved custom pad version is frozen with the record, in the same UPDATE.
      const templateVersionId = renderSnapshot.layout.template.kind === "overlay" ? renderSnapshot.layout.template.templateVersionId : null;
```

change the UPDATE's `.set({ status: "finalized", rxNo, finalizedAt: now, finalizedBy: ctx.userId, renderSnapshot })` to `.set({ status: "finalized", rxNo, finalizedAt: now, finalizedBy: ctx.userId, renderSnapshot, templateVersionId })`, and add `...(templateVersionId ? { templateVersionId } : {})` at the end of both `after` objects of the `prescription.finalized` / `prescription.amended` audit event (built-in pads keep exactly today's payload). Add `templateVersionId: string | null;` to `PrescriptionView` (after `finalizedAt`, with the comment `/** The frozen custom pad version, null for built-in pads and drafts (Plan 2A). */`) and `templateVersionId: row.rx.templateVersionId,` to the object `readSnapshot` returns.

In `src/server/services/rx-mapping.ts`, change `templateVersionId: "copy",` in `AMEND_PRESCRIPTION_COLUMNS` to `templateVersionId: "reset", // an amendment resolves its own pad at its own finalize (Plan 2A, Q15)`, and in `src/server/services/prescriptions.ts` `amendPrescription`, change the comment `// rxNo and templateVersionId are the only copied columns …` to `// rxNo is the only copied column (AMEND_PRESCRIPTION_COLUMNS); the new version never inherits the frozen render_snapshot or template version.`. In `tests/unit/rx-column-rules.test.ts` line 36, expect `["rxNo"]`. In `tests/integration/render-snapshot.test.ts` line 137 (`v: 1,` inside the finalized-snapshot `toMatchObject`), expect `v: 2,`.

- [ ] **Step 7: Extend the test helpers**

Append to `tests/helpers/templates.ts` (add `import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";` and `import { templateContentSha256 } from "@/server/templates/content-hash";`; `sql` from `drizzle-orm` if needed):

```ts
async function fileSha(fileId: string): Promise<string> {
  const [file] = await adminDb.select({ sha256: templateFiles.sha256 }).from(templateFiles).where(eq(templateFiles.id, fileId));
  return file.sha256;
}

/** A published overlay template with a REAL content hash (what the services would write). */
export async function insertPublishedOverlay(
  tenantId: string,
  opts: { label?: string; identity?: "dynamic" | "bound"; boundDoctorId?: string | null; definition?: unknown; paperSize?: "A4" | "A5"; labels?: "en" | "hi" | "bilingual" } = {},
): Promise<InsertedTemplate & { contentSha256: string }> {
  const paperSize = opts.paperSize ?? "A4";
  const labels = opts.labels ?? "en";
  const definition = overlayDefinitionSchema.parse(opts.definition ?? MINIMAL_OVERLAY_DEFINITION);
  const fileId = await insertBackgroundFile(tenantId, opts.label ?? `pub-${Math.random().toString(36).slice(2)}`);
  const contentSha256 = templateContentSha256({ kind: "overlay", paperSize, labels, definition, fileSha256: await fileSha(fileId) });
  const [template] = await adminDb
    .insert(templates)
    .values({ tenantId, name: "Published pad", kind: "overlay", identity: opts.identity ?? "dynamic", boundDoctorId: opts.boundDoctorId ?? null })
    .returning({ id: templates.id });
  const [version] = await adminDb
    .insert(templateVersions)
    .values({ tenantId, templateId: template.id, version: 1, fileId, definition, paperSize, labels })
    .returning({ id: templateVersions.id });
  await adminDb.update(templateVersions).set({ state: "published", contentSha256, publishedAt: new Date() }).where(eq(templateVersions.id, version.id));
  await adminDb.update(templates).set({ currentVersionId: version.id }).where(eq(templates.id, template.id));
  return { templateId: template.id, versionId: version.id, fileId, contentSha256 };
}

/** Publishes a further version of a template (a new background unless a file id is given) and makes it current. */
export async function publishNewVersion(
  tenantId: string,
  templateId: string,
  opts: { fileId?: string; definition?: unknown } = {},
): Promise<{ versionId: string; contentSha256: string }> {
  const rows = await adminDb.select({ version: templateVersions.version }).from(templateVersions).where(eq(templateVersions.templateId, templateId));
  const next = Math.max(0, ...rows.map((r) => r.version)) + 1;
  const definition = overlayDefinitionSchema.parse(opts.definition ?? MINIMAL_OVERLAY_DEFINITION);
  const fileId = opts.fileId ?? (await insertBackgroundFile(tenantId, `v${next}-${Math.random().toString(36).slice(2)}`));
  const contentSha256 = templateContentSha256({ kind: "overlay", paperSize: "A4", labels: "en", definition, fileSha256: await fileSha(fileId) });
  const [version] = await adminDb
    .insert(templateVersions)
    .values({ tenantId, templateId, version: next, fileId, definition, paperSize: "A4", labels: "en" })
    .returning({ id: templateVersions.id });
  await adminDb.update(templateVersions).set({ state: "published", contentSha256, publishedAt: new Date() }).where(eq(templateVersions.id, version.id));
  await adminDb.update(templates).set({ currentVersionId: version.id }).where(eq(templates.id, templateId));
  return { versionId: version.id, contentSha256 };
}
```

`tests/helpers/rx-flow.ts`:

```ts
import type { ServiceContext } from "@/server/services/context";
import { createPatient } from "@/server/services/patients";
import { finalizePrescription, saveDraft, startPrescription } from "@/server/services/prescriptions";

export async function newPatient(ctx: ServiceContext, name: string): Promise<string> {
  const created = await createPatient(ctx, { name }, { allowDuplicate: true });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

/** A draft with one medicine, saved the way the editor saves it. */
export async function savedDraft(ctx: ServiceContext, patientId: string): Promise<{ id: string; revision: number }> {
  const started = await startPrescription(ctx, { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraft(ctx, started.value.prescriptionId, { items: [{ drugName: "Paracetamol", doseMorning: 1, doseNight: 1 }] }, { baseRevision: 0 });
  if (!saved.ok) throw new Error(saved.message);
  return { id: started.value.prescriptionId, revision: saved.value.revision };
}

/** Finalized exactly the way finalizeDraftAction does it. Throws on refusal (use savedDraft + finalizePrescription to test refusals). */
export async function finalized(ctx: ServiceContext, patientId: string): Promise<string> {
  const { id, revision } = await savedDraft(ctx, patientId);
  const done = await finalizePrescription(ctx, id, { expectedRevision: revision });
  if (!done.ok) throw new Error(`${done.code}: ${done.message}`);
  return id;
}
```

- [ ] **Step 8: Write the resolution integration test**

`tests/integration/template-resolution.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics, doctors, prescriptions, templates, templateVersions, tenantCounters, users } from "@/server/db/schema";
import { defaultOverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { parseRenderSnapshot } from "@/lib/rx-render/snapshot";
import { amendPrescription, finalizePrescription, repeatPrescription } from "@/server/services/prescriptions";
import { TEMPLATE_UNUSABLE_MESSAGE } from "@/server/services/template-resolution";
import type { ServiceContext } from "@/server/services/context";
import { finalized, newPatient, savedDraft } from "../helpers/rx-flow";
import { insertPublishedOverlay, insertTemplate, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let doctorA = "";
let secondDoctorUser = "";
let secondDoctorRow = "";
let patientId = "";
const doctor = () => A.as("doctor");
const second = (): ServiceContext => ({ tenantId: A.tenantId, userId: secondDoctorUser, role: "doctor" });

async function rxRow(id: string) {
  const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
  return { row, snap: parseRenderSnapshot(row.renderSnapshot) };
}
const setClinicTemplate = (templateId: string | null) => adminDb.update(clinics).set({ customTemplateId: templateId }).where(eq(clinics.tenantId, A.tenantId));
const setDoctorTemplate = (doctorId: string, templateId: string | null) => adminDb.update(doctors).set({ templateId }).where(eq(doctors.id, doctorId));

beforeAll(async () => {
  A = await createTestTenant("tpl-resolve");
  const [row] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, A.tenantId)).limit(1);
  doctorA = row.id;
  const [user] = await adminDb.insert(users).values({ email: `tpl-resolve-2-${Date.now()}@example.com`, name: "Dr Second", passwordHash: "x" }).returning();
  secondDoctorUser = user.id;
  const [docRow] = await adminDb.insert(doctors).values({ tenantId: A.tenantId, userId: user.id, displayName: "Dr Second" }).returning();
  secondDoctorRow = docRow.id;
  patientId = await newPatient(A.as("reception"), "Resolution Patient");
});
afterAll(async () => {
  await A.cleanup();
  await adminDb.delete(users).where(eq(users.id, secondDoctorUser));
});
beforeEach(async () => {
  await setClinicTemplate(null);
  await adminDb.update(doctors).set({ templateId: null }).where(eq(doctors.tenantId, A.tenantId));
});

describe("resolution at finalize", () => {
  it("prints on the built-in pad when nothing is assigned", async () => {
    const { row, snap } = await rxRow(await finalized(doctor(), patientId));
    expect(row.templateVersionId).toBeNull();
    expect(snap?.layout.template).toEqual({ kind: "builtin", key: "general" });
  });

  it("freezes the clinic default's published version, its hash, and its paper and labels", async () => {
    const t = await insertPublishedOverlay(A.tenantId, { paperSize: "A5", labels: "bilingual", definition: defaultOverlayDefinition("A5") });
    await setClinicTemplate(t.templateId);
    const { row, snap } = await rxRow(await finalized(doctor(), patientId));
    expect(row.templateVersionId).toBe(t.versionId);
    expect(snap?.layout).toEqual({ template: { kind: "overlay", templateVersionId: t.versionId, contentSha256: t.contentSha256 }, paperSize: "A5", labels: "bilingual" });
  });

  it("prefers the signing doctor's own template over the clinic default", async () => {
    const clinicPad = await insertPublishedOverlay(A.tenantId);
    const own = await insertPublishedOverlay(A.tenantId, { identity: "bound", boundDoctorId: doctorA });
    await setClinicTemplate(clinicPad.templateId);
    await setDoctorTemplate(doctorA, own.templateId);
    expect((await rxRow(await finalized(doctor(), patientId))).row.templateVersionId).toBe(own.versionId);
    expect((await rxRow(await finalized(second(), patientId))).row.templateVersionId).toBe(clinicPad.versionId);
  });

  it("never prints Dr A's bound letterhead for Dr B, even if it is assigned to Dr B or set as the clinic default", async () => {
    const boundToA = await insertPublishedOverlay(A.tenantId, { identity: "bound", boundDoctorId: doctorA });
    await setClinicTemplate(boundToA.templateId);
    await setDoctorTemplate(secondDoctorRow, boundToA.templateId);
    const { row, snap } = await rxRow(await finalized(second(), patientId));
    expect(row.templateVersionId).toBeNull();
    expect(snap?.layout.template.kind).toBe("builtin");
  });

  it("skips archived templates and templates that were never published", async () => {
    const archived = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(templates).set({ status: "archived" }).where(eq(templates.id, archived.templateId));
    const unpublished = await insertTemplate(A.tenantId);
    await setDoctorTemplate(doctorA, archived.templateId);
    await setClinicTemplate(unpublished.templateId);
    expect((await rxRow(await finalized(doctor(), patientId))).row.templateVersionId).toBeNull();
  });

  it("uses only a dynamic clinic default for an owner without a doctor profile", async () => {
    const [user] = await adminDb.insert(users).values({ email: `tpl-owner-${Date.now()}@example.com`, name: "Owner", passwordHash: "x" }).returning();
    try {
      const owner: ServiceContext = { tenantId: A.tenantId, userId: user.id, role: "owner" };
      const bound = await insertPublishedOverlay(A.tenantId, { identity: "bound", boundDoctorId: doctorA });
      await setClinicTemplate(bound.templateId);
      expect((await rxRow(await finalized(owner, patientId))).row.templateVersionId).toBeNull();
      const dynamic = await insertPublishedOverlay(A.tenantId);
      await setClinicTemplate(dynamic.templateId);
      expect((await rxRow(await finalized(owner, patientId))).row.templateVersionId).toBe(dynamic.versionId);
    } finally {
      await adminDb.delete(users).where(eq(users.id, user.id));
    }
  });

  it("fails closed on a damaged template: nothing finalized, no Rx number used", async () => {
    const t = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(t.templateId);
    // Simulate tampering outside the app: replica mode skips the immutability trigger (superuser only). The tampered
    // definition still parses, so only the hash can catch it.
    const tampered = { ...structuredClone(MINIMAL_OVERLAY_DEFINITION), printOffsetMm: { x: 9, y: 9 } };
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(templateVersions).set({ definition: tampered }).where(eq(templateVersions.id, t.versionId));
    });
    const counter = async () => (await adminDb.select().from(tenantCounters).where(and(eq(tenantCounters.tenantId, A.tenantId), eq(tenantCounters.name, "rx"))))[0]?.lastNo ?? 0;
    const before = await counter();
    const { id, revision } = await savedDraft(doctor(), patientId);
    expect(await finalizePrescription(doctor(), id, { expectedRevision: revision })).toEqual({ ok: false, code: "invalid", message: TEMPLATE_UNUSABLE_MESSAGE });
    expect((await rxRow(id)).row.status).toBe("draft");
    expect(await counter()).toBe(before);
  });
});

describe("new versions of a record", () => {
  it("an amendment resolves its own pad; the original keeps the one it was signed on", async () => {
    const first = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(first.templateId);
    const original = await finalized(doctor(), patientId);
    const later = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(later.templateId);
    const amended = await amendPrescription(doctor(), { prescriptionId: original, reason: "Dose correction" });
    if (!amended.ok) throw new Error(amended.message);
    expect((await rxRow(amended.value.prescriptionId)).row.templateVersionId).toBeNull();
    const [draft] = await adminDb.select({ revision: prescriptions.draftRevision }).from(prescriptions).where(eq(prescriptions.id, amended.value.prescriptionId));
    expect((await finalizePrescription(doctor(), amended.value.prescriptionId, { expectedRevision: draft.revision })).ok).toBe(true);
    expect((await rxRow(amended.value.prescriptionId)).row.templateVersionId).toBe(later.versionId);
    expect((await rxRow(original)).row.templateVersionId).toBe(first.versionId);
  });

  it("a repeat starts as a draft without a template version", async () => {
    const t = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(t.templateId);
    const source = await finalized(doctor(), patientId);
    const repeated = await repeatPrescription(doctor(), source);
    if (!repeated.ok) throw new Error(repeated.message);
    expect((await rxRow(repeated.value.prescriptionId)).row.templateVersionId).toBeNull();
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-resolution.test.ts tests/integration/render-snapshot.test.ts tests/unit/rx-column-rules.test.ts tests/unit/snapshot-v2.test.ts`
Expected: PASS.

- [ ] **Step 9: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/snapshot.ts src/lib/rx-render/types.ts src/lib/rx-render/render.ts src/server/templates/content-hash.ts src/server/services/template-resolution.ts src/server/services/render-snapshot.ts src/server/services/prescriptions.ts src/server/services/rx-mapping.ts src/server/services/rx-output.ts src/server/services/share-open.ts tests/fixtures/rx-documents.ts tests/fixtures/overlay-documents.ts tests/unit/rx-column-rules.test.ts tests/unit/snapshot-v2.test.ts tests/integration/render-snapshot.test.ts tests/helpers/templates.ts tests/helpers/rx-flow.ts tests/integration/template-resolution.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(rx): snapshot v2 freezes the signer's custom pad version and hash at finalize" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 14: Render dispatch and output plumbing — the loader loads and verifies the frozen template; outputs, share opens and print-through-PDF record it

**Files:**
- Modify: `src/server/services/rx-documents.ts` (`RxDocumentBundle.overlay`, draft resolution, verified overlay load), `src/server/services/rx-output.ts` (targets, `outputTemplateColumns`, `engine`, PDF purpose), `src/server/services/share-open.ts` (columns, `pdf` target), `src/app/(app)/prescriptions/[id]/pdf/route.ts` (`?purpose=print`)
- Modify tests: `tests/integration/rx-output-routes.test.ts` (the download audit payload gains `engine`)
- Create: `tests/integration/overlay-output.test.ts`

**Interfaces:**
- Consumes: `buildDraftSnapshot`, `loadOverlayIn`, `TEMPLATE_DAMAGED_MESSAGE` (Task 13), `renderPrescription(doc, assets, { target })`, `rendererVersionFor` (Task 13), `insertPublishedOverlay`, `publishNewVersion` (Task 13 helpers), `shareablePrescription`, `linkFor` (`tests/helpers/share.ts`).
- Produces:
  - `RxDocumentBundle = { prescriptionId; document; logo; signature; overlay: OverlayInput | null }`.
  - `renderDocument(bundle, target?: RenderTarget): RenderedDocument` (default `"screen"`); `outputTemplateColumns(bundle): { templateKey: string; templateVersionId: string | null; rendererVersion: string }`; `type OutputEngine = "chromium" | "browser"`; `type PdfPurpose = "download" | "print"`; `renderPrescriptionPdf(ctx, id, engine?, limiter?, signal?, purpose?: PdfPurpose)` — `purpose: "print"` renders `target: "print"` and logs `browser_print` with engine `chromium`.
  - `GET /prescriptions/<id>/pdf?purpose=print` answers the PDF `inline`, and errors as a small HTML page (it opens in a new tab).

- [ ] **Step 1: Write the failing integration test**

`tests/integration/overlay-output.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/pdf", async () => {
  const { sharedFakeEngine } = await import("../helpers/fake-pdf-engine");
  return { getPdfEngine: () => sharedFakeEngine };
});

import { createHash } from "node:crypto";
import { getSessionContext } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, prescriptionOutputs, templateFiles, templates, templateVersions } from "@/server/db/schema";
import { htmlSha256, renderPrescriptionHtml, renderPrescriptionPdf } from "@/server/services/rx-output";
import { openSharedPrescription } from "@/server/services/share-open";
import { TEMPLATE_DAMAGED_MESSAGE } from "@/server/services/template-resolution";
import { createLimiter } from "@/server/pdf/limiter";
import { GET as getPdf } from "@/app/(app)/prescriptions/[id]/pdf/route";
import { resetFakeEngine, sharedFakeEngine } from "../helpers/fake-pdf-engine";
import { finalized, newPatient, savedDraft } from "../helpers/rx-flow";
import { linkFor, shareablePrescription } from "../helpers/share";
import { backgroundPng, insertPublishedOverlay, MINIMAL_OVERLAY_DEFINITION, publishNewVersion } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
let A: TestTenant;
let pad: Awaited<ReturnType<typeof insertPublishedOverlay>>;
let rxId = "";

const outputsOf = (id: string) => adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.prescriptionId, id));
const printHtml = async (id: string) => {
  const result = await renderPrescriptionHtml(A.as("doctor"), id, "print");
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value.html;
};

beforeAll(async () => {
  A = await createTestTenant("overlay-out");
  pad = await insertPublishedOverlay(A.tenantId, { definition: { ...MINIMAL_OVERLAY_DEFINITION, background: { printMode: "pdf_only" } } });
  await adminDb.update(clinics).set({ customTemplateId: pad.templateId }).where(eq(clinics.tenantId, A.tenantId));
  rxId = await finalized(A.as("doctor"), await newPatient(A.as("reception"), "Overlay Output Patient"));
});
afterAll(async () => {
  await A.cleanup();
});
beforeEach(() => {
  resetFakeEngine(sharedFakeEngine);
  session.mockResolvedValue(A.as("doctor"));
});

describe("printing a prescription finalized on a custom pad", () => {
  it("prints the frozen overlay and logs the version, the engine and the overlay renderer", async () => {
    const html = await printHtml(rxId);
    expect(html).toContain('<table class="flow">');
    expect(html).not.toContain('class="bg"'); // pdf_only: printed on pre-printed paper
    const [row] = (await outputsOf(rxId)).filter((o) => o.kind === "browser_print");
    expect(row).toMatchObject({ templateKey: "overlay", templateVersionId: pad.versionId, engine: "browser", rendererVersion: "overlay-1" });
  });

  it("downloads the PDF with the background, zero margins, and engine chromium", async () => {
    const result = await renderPrescriptionPdf(A.as("doctor"), rxId, sharedFakeEngine, createLimiter({ concurrency: 1, maxQueue: 1 }));
    expect(result.ok).toBe(true);
    expect(sharedFakeEngine.calls[0].html).toContain('class="bg"');
    expect(sharedFakeEngine.calls[0].paper.marginMm).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    const rows = (await outputsOf(rxId)).filter((o) => o.kind === "pdf_download");
    expect(rows.at(-1)).toMatchObject({ templateKey: "overlay", templateVersionId: pad.versionId, engine: "chromium" });
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.entityId, rxId), eq(auditEvents.action, "prescription.pdf_downloaded")));
    expect(event.after).toMatchObject({ template: "overlay", templateVersionId: pad.versionId, engine: "chromium" });
  });

  it("prints through a PDF rendered for paper (Firefox and Safari): logged as a print by chromium, inline", async () => {
    const response = await getPdf(new Request(`http://localhost/prescriptions/${rxId}/pdf?purpose=print`), { params: Promise.resolve({ id: rxId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(sharedFakeEngine.calls[0].html).not.toContain('class="bg"');
    const rows = (await outputsOf(rxId)).filter((o) => o.kind === "browser_print" && o.engine === "chromium");
    expect(rows).toHaveLength(1);
  });

  it("reprints byte for byte after the pad is edited, archived and replaced as the default", async () => {
    const first = htmlSha256(await printHtml(rxId));
    await publishNewVersion(A.tenantId, pad.templateId);
    await adminDb.update(clinics).set({ customTemplateId: null }).where(eq(clinics.tenantId, A.tenantId));
    await adminDb.update(templates).set({ status: "archived" }).where(eq(templates.id, pad.templateId));
    const other = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(clinics).set({ customTemplateId: other.templateId }).where(eq(clinics.tenantId, A.tenantId));
    expect(htmlSha256(await printHtml(rxId))).toBe(first);
    await adminDb.update(templates).set({ status: "active" }).where(eq(templates.id, pad.templateId));
  });

  it("refuses to print when the frozen version or its file was tampered with, and logs nothing", async () => {
    const victim = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(clinics).set({ customTemplateId: victim.templateId }).where(eq(clinics.tenantId, A.tenantId));
    const id = await finalized(A.as("doctor"), await newPatient(A.as("reception"), "Tamper Patient"));
    const swapped = backgroundPng("swapped-background");
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx
        .update(templateFiles)
        .set({ bytes: swapped, byteSize: swapped.length, sha256: createHash("sha256").update(swapped).digest("hex") })
        .where(eq(templateFiles.id, victim.fileId));
    });
    expect(await renderPrescriptionHtml(A.as("doctor"), id, "print")).toEqual({ ok: false, code: "invalid", message: TEMPLATE_DAMAGED_MESSAGE });
    expect(await outputsOf(id)).toHaveLength(0);
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(templateVersions).set({ labels: "hi" }).where(eq(templateVersions.id, victim.versionId));
    });
    expect((await renderPrescriptionHtml(A.as("doctor"), id, "preview")).ok).toBe(false);
  });
});

describe("drafts and shares", () => {
  it("previews a draft on the would-be signer's pad, unlogged", async () => {
    const fresh = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(clinics).set({ customTemplateId: fresh.templateId }).where(eq(clinics.tenantId, A.tenantId));
    const { id } = await savedDraft(A.as("doctor"), await newPatient(A.as("reception"), "Draft Overlay Patient"));
    const preview = await renderPrescriptionHtml(A.as("reception"), id, "preview");
    expect(preview.ok && preview.value.html.includes('<table class="flow">') && preview.value.html.includes("DRAFT")).toBe(true);
    expect(await outputsOf(id)).toHaveLength(0);
  });

  it("opens a shared overlay prescription and logs the frozen version", async () => {
    const shared = await shareablePrescription(A, "Shared Overlay Patient");
    const link = await linkFor(A, shared.prescriptionId);
    const opened = await openSharedPrescription(link.token, { engine: sharedFakeEngine, limiter: createLimiter({ concurrency: 1, maxQueue: 1 }) });
    expect(opened.ok).toBe(true);
    const [row] = await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.shareLinkId, link.linkId));
    expect(row).toMatchObject({ kind: "shared_pdf", templateKey: "overlay", engine: "chromium" });
    expect(row.templateVersionId).not.toBeNull();
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/overlay-output.test.ts`
Expected: FAIL — rendering an overlay document throws "the overlay template for this document was not loaded" (the loader does not load it yet).

- [ ] **Step 2: Load and verify the frozen template in the document loader**

In `src/server/services/rx-documents.ts`:
- imports: add `import type { OverlayInput } from "@/lib/rx-render/types";` (merge into the existing type import), `import { buildDraftSnapshot, buildRenderSnapshot } from "./render-snapshot";` (replacing the single import), `import { loadOverlayIn, TEMPLATE_DAMAGED_MESSAGE } from "./template-resolution";`;
- `RxDocumentBundle` gains `overlay: OverlayInput | null;` (with the comment `/** The frozen custom pad, loaded and hash-verified; null for built-in pads and when assets were not requested. */`);
- in `loadRxDocumentIn`, replace the `else { … }` branch that builds the live snapshot with:

```ts
  } else {
    const sources = {
      tenantId: tenantId,
      patientId: row.visit.patientId,
      // A pre-1C finalized row is signed by its finalizer. A draft is signed by nobody yet: its would-be signer is the
      // VIEWER, and only when the viewer can finalize (never the visit's doctor, whose name an amendment inherits).
      prescriberUserId: status === "draft" ? (viewer.canFinalize ? viewer.userId : null) : row.rx.finalizedBy,
      visitDoctorId: status === "draft" ? null : row.visit.doctorId,
      at: row.rx.finalizedAt ?? new Date(),
    };
    if (status === "draft") {
      // A draft previews on the pad its would-be signer would get (Plan 2A); a damaged pad fails closed here too.
      const built = await buildDraftSnapshot(tx, sources);
      if (!built.ok) return built;
      snapshot = built.value;
    } else {
      // Rows finalized before Plan 1C have no snapshot; they keep printing on the built-in pad.
      snapshot = await buildRenderSnapshot(tx, sources);
    }
    snapshotSource = "live";
    // A draft never embeds a signature image, whoever views it.
    if (status === "draft") snapshot = { ...snapshot, doctor: { ...snapshot.doctor, signatureAssetId: null } };
  }
```

- change `if (opts.withAssets === false) return ok({ prescriptionId: id, document, logo: null, signature: null });` to return `overlay: null` too, and replace the final `return ok({ … })` with:

```ts
  let overlay: OverlayInput | null = null;
  if (snapshot.layout.template.kind === "overlay") {
    // The column written at finalize must name the same version as the frozen snapshot (a draft has no column yet).
    if (status !== "draft" && row.rx.templateVersionId !== snapshot.layout.template.templateVersionId) {
      return fail("invalid", TEMPLATE_DAMAGED_MESSAGE);
    }
    overlay = await loadOverlayIn(tx, tenantId, snapshot.layout);
    if (!overlay) return fail("invalid", TEMPLATE_DAMAGED_MESSAGE);
  }
  return ok({
    prescriptionId: id,
    document,
    logo: logoAssetId ? (assets.get(assetKey("logo", logoAssetId)) ?? null) : null,
    signature: signatureAssetId ? (assets.get(assetKey("signature", signatureAssetId)) ?? null) : null,
    overlay,
  });
```

- [ ] **Step 3: Targets, template columns and engines in the output service**

In `src/server/services/rx-output.ts`:
- imports: replace `import { RENDERER_VERSION, renderPrescription } from "@/lib/rx-render/render";` with `import { rendererVersionFor, renderPrescription } from "@/lib/rx-render/render";` and `import type { RenderedDocument } from "@/lib/rx-render/types";` with `import type { RenderedDocument, RenderTarget } from "@/lib/rx-render/types";`;
- add after `export type OutputKind = …`:

```ts
/** chromium: Gotenberg made a PDF. browser: the HTML document was handed to a browser print dialog. */
export type OutputEngine = "chromium" | "browser";
/** download: the digital copy. print: a PDF rendered for paper, for browsers that cannot print an overlay pad themselves. */
export type PdfPurpose = "download" | "print";
```

- replace `renderDocument` with:

```ts
export function renderDocument(bundle: RxDocumentBundle, target: RenderTarget = "screen"): RenderedDocument {
  const rendered = renderPrescription(
    bundle.document,
    { logo: bundle.logo, signature: bundle.signature, fontCss: loadFontCss(), overlay: bundle.overlay },
    { target },
  );
  for (const part of [rendered.html, rendered.footerHtml]) {
    const check = checkSelfContained(part);
    // The renderer only emits embedded content, so this is a programming error, never user error.
    if (!check.ok) throw new Error(`Rendered prescription is not self-contained: ${check.reason}`);
  }
  return rendered;
}

/** The template columns of an output row and its audit event: the built-in key, or 'overlay' and the frozen version. */
export function outputTemplateColumns(bundle: RxDocumentBundle): { templateKey: string; templateVersionId: string | null; rendererVersion: string } {
  const template = bundle.document.snapshot.layout.template;
  return template.kind === "builtin"
    ? { templateKey: template.key, templateVersionId: null, rendererVersion: rendererVersionFor(template) }
    : { templateKey: "overlay", templateVersionId: template.templateVersionId, rendererVersion: rendererVersionFor(template) };
}
```

- replace `recordOutput` with:

```ts
async function recordOutput(
  ctx: ServiceContext,
  bundle: RxDocumentBundle,
  rendered: RenderedDocument,
  kind: OutputKind,
  engine: OutputEngine,
  pdf: { pageCount: number; byteSize: number } | null,
): Promise<void> {
  const columns = outputTemplateColumns(bundle);
  await withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(prescriptionOutputs)
      .values({
        tenantId: ctx.tenantId,
        prescriptionId: bundle.prescriptionId,
        actorUserId: ctx.userId,
        kind,
        templateKey: columns.templateKey,
        templateVersionId: columns.templateVersionId,
        engine,
        paperSize: rendered.paper.size,
        pageCount: pdf?.pageCount ?? null,
        byteSize: pdf?.byteSize ?? null,
        htmlSha256: htmlSha256(rendered.html),
        rendererVersion: columns.rendererVersion,
      })
      .returning({ id: prescriptionOutputs.id });
    await recordAudit(tx, ctx, {
      action: kind === "pdf_download" ? "prescription.pdf_downloaded" : "prescription.printed",
      entityType: "prescription",
      entityId: bundle.prescriptionId,
      after: {
        outputId: row.id,
        version: bundle.document.version,
        template: columns.templateKey,
        paperSize: rendered.paper.size,
        pageCount: pdf?.pageCount ?? null,
        engine,
        ...(columns.templateVersionId ? { templateVersionId: columns.templateVersionId } : {}),
      },
    });
  });
}
```

- in `renderPrescriptionHtml`, change `const rendered = renderDocument(loaded.value);` to `const rendered = renderDocument(loaded.value, purpose === "print" ? "print" : "screen");` and `await recordOutput(ctx, loaded.value, rendered, "browser_print", null);` to `await recordOutput(ctx, loaded.value, rendered, "browser_print", "browser", null);`;
- change `renderPrescriptionPdf`'s signature to add `purpose: PdfPurpose = "download"` after `signal?: AbortSignal`, its `const rendered = renderDocument(loaded.value);` to `const rendered = renderDocument(loaded.value, purpose === "print" ? "print" : "pdf");`, and its `await recordOutput(ctx, loaded.value, rendered, "pdf_download", { … })` to:

```ts
  await recordOutput(ctx, loaded.value, rendered, purpose === "print" ? "browser_print" : "pdf_download", "chromium", { pageCount: outcome.pageCount, byteSize: outcome.pdf.byteLength });
```

In `src/server/services/share-open.ts` `render()`: change `import { RENDERER_VERSION } from "@/lib/rx-render/render";` to nothing (remove it), import `outputTemplateColumns` with `htmlSha256, renderDocument` from `./rx-output`, change `const rendered = renderDocument(bundle);` to `const rendered = renderDocument(bundle, "pdf");`, and in the `prescriptionOutputs` insert replace the `templateKey: …` line (Task 13's interim one) and `rendererVersion: RENDERER_VERSION,` with:

```ts
        ...outputTemplateColumns(bundle),
        engine: "chromium",
```

(the spread supplies `templateKey`, `templateVersionId`, `rendererVersion`). Add `...(outputTemplateColumns(bundle).templateVersionId ? { templateVersionId: outputTemplateColumns(bundle).templateVersionId } : {})` to the `prescription.share_opened` audit `after` object — assign `const columns = outputTemplateColumns(bundle);` once before the transaction and use `columns` in both places.

In `tests/integration/rx-output-routes.test.ts`, the download audit assertion becomes `expect(events[0].after).toEqual({ outputId: outputs[0].id, version: 1, template: "general", paperSize: "A4", pageCount: 2, engine: "chromium" });`.

- [ ] **Step 4: Print through PDF from the PDF route**

Replace `src/app/(app)/prescriptions/[id]/pdf/route.ts` with:

```ts
import { escapeHtml } from "@/lib/rx-render/html";
import { getSessionContext } from "@/server/auth/session";
import { BUSY_MESSAGE, renderPrescriptionPdf, type PdfPurpose } from "@/server/services/rx-output";
import { contentDisposition, crossSiteRefusal, headNotAllowed, publicCode, publicMessage, statusForError } from "@/server/http/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const UNAVAILABLE_MESSAGE = "The PDF service is not available right now. Try again, or use Print.";
const INTERNAL = { error: "internal", message: "The PDF could not be generated. Try again, or use Print." };

/** ?purpose=print opens in a new tab (overlay pads on Firefox and Safari): its errors are a readable page, not JSON. */
function failure(purpose: PdfPurpose, status: number, body: { error: string; message: string }, extra: Record<string, string> = {}): Response {
  if (purpose === "download") return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Prescription unavailable</title></head><body><p>${escapeHtml(body.message)}</p></body></html>`;
  return new Response(page, {
    status,
    headers: { ...NO_STORE, ...extra, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'" },
  });
}

/** The pad as a PDF: a download, or (?purpose=print) a PDF rendered for paper and shown inline to print from. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const purpose: PdfPurpose = new URL(request.url).searchParams.get("purpose") === "print" ? "print" : "download";
  try {
    const session = await getSessionContext();
    if (!session) return failure(purpose, 401, { error: "unauthenticated", message: "Sign in again to download this prescription." });
    const { id } = await params;
    const result = await renderPrescriptionPdf(session, id, undefined, undefined, request.signal, purpose);
    if (!result.ok) {
      const busy = result.code === "unavailable" && result.message === BUSY_MESSAGE;
      // The engine's own text ("not configured", "not reachable") names infrastructure: show a generic line.
      const message = result.code === "unavailable" && !busy ? UNAVAILABLE_MESSAGE : publicMessage(result.code, result.message);
      return failure(purpose, statusForError(result.code), { error: publicCode(result.code), message }, busy ? { "Retry-After": "2" } : {});
    }
    return new Response(result.value.pdf, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition(purpose === "print" ? "inline" : "attachment", result.value.fileName),
        "Content-Length": String(result.value.pdf.byteLength),
      },
    });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("prescription pdf failed", error instanceof Error ? error.name : typeof error);
    return failure(purpose, 500, INTERNAL);
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
```

- [ ] **Step 5: Run the tests**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/overlay-output.test.ts tests/integration/rx-output-routes.test.ts tests/integration/share-links.test.ts tests/integration/share-route.test.ts tests/integration/render-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 6: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/services/rx-documents.ts src/server/services/rx-output.ts src/server/services/share-open.ts "src/app/(app)/prescriptions/[id]/pdf/route.ts" tests/integration/overlay-output.test.ts tests/integration/rx-output-routes.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(rx): print, download and share overlay pads from their verified frozen version" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 15: Roles (`designer`, migration 0027) and the template services and actions

**Files:**
- Modify: `src/server/db/schema/enums.ts` (`designer`), `src/server/db/schema/tenancy.ts` (`memberships.expiresAt` + CHECKs), `src/lib/domain/permissions.ts` (designer on `template.read`/`template.write`), `tests/unit/permissions.test.ts`, `src/server/auth/credentials.ts` (`getActiveMembership` ignores expired memberships), `src/components/app-shell/sidebar.tsx`, `tests/unit/sidebar.test.tsx`, `src/app/(app)/dashboard/page.tsx` (designer → `/templates`), `tests/e2e/helpers.ts` (`setRole` sets an expiry for designer)
- Create: `drizzle/0027_phase2a_designer_role.sql` (generated, hand-edited) + meta
- Create: `src/server/validation/templates.ts`, `src/server/services/template-access.ts`, `src/server/services/templates.ts`, `src/server/services/template-publish.ts`, `src/server/services/template-assign.ts`, `src/server/actions/templates.ts`
- Test: `tests/integration/designer-role.test.ts`, `tests/integration/template-services.test.ts`

**Interfaces:**
- Consumes: `lockTemplateQuota`, `TEMPLATE_QUOTAS`, `loadTemplateFileIn` (Task 9); `parseOverlayDefinition`, `overlayDefinitionSchema`, `overlayGeometryIssues` (Task 11); `overlayPublishIssues` (Task 11); `templateContentSha256` (Task 13); `primaryClinic` (`render-snapshot.ts`); `recordAudit`; `invalidFrom`; `cleanRequiredText` (`src/server/validation/text.ts`).
- Produces:
  - `template-access.ts`: `TEMPLATE_NOT_FOUND`, `type TemplateRow`, `myDoctorId(tx, ctx): Promise<string | null>`, `lockTemplate(tx, tenantId, id, mode: "update" | "share"): Promise<TemplateRow | null>`, `mayWriteTemplate(ctx, template, doctorId): boolean`.
  - `templates.ts`: `type TemplateSummary`, `type TemplateEditorView`, `listTemplates(ctx)`, `getTemplateEditor(ctx, templateId)`, `createOverlayTemplate(ctx, raw) → Result<{ templateId; versionId }>`, `saveTemplateDraft(ctx, templateId, raw) → Result<{ revision }> | DraftRevisionConflict`, `startTemplateDraft(ctx, templateId) → Result<{ versionId; version }>`, `discardTemplateDraft(ctx, templateId) → Result<{ templateDeleted: boolean }>`, `archiveTemplate(ctx, templateId)`, `unarchiveTemplate(ctx, templateId)`.
  - `template-publish.ts`: `publishTemplate(ctx, templateId, raw) → Result<{ versionId; version; contentSha256 }>`, `rollbackTemplate(ctx, templateId, versionId) → Result<{ versionId; version }>`.
  - `template-assign.ts`: `assignTemplate(ctx, raw) → Result<{ previousTemplateId: string | null }>`, `listTemplateDoctors(ctx) → Result<{ id: string; name: string; isMe: boolean }[]>`.
  - `src/server/actions/templates.ts` (`"use server"`): `createTemplateAction`, `saveTemplateDraftAction`, `startTemplateDraftAction`, `discardTemplateDraftAction`, `publishTemplateAction`, `rollbackTemplateAction`, `archiveTemplateAction`, `unarchiveTemplateAction`, `assignTemplateAction`, all returning `TemplateActionState = { ok?: true; error?: string; field?: string; templateId?: string; revision?: number; currentRevision?: number; issues?: string[] }`.

- [ ] **Step 1: Write the failing role and membership tests**

In `tests/unit/permissions.test.ts`: add `"designer"` to the `roles` array of "role x action matrix", change the two template rows of `granted` to `"template.read": ["owner", "doctor", "designer"]` and `"template.write": ["owner", "doctor", "designer"]`, and add:

```ts
describe("template permissions", () => {
  it("lets designers work on templates and nothing else", () => {
    expect(can("designer", "template.read")).toBe(true);
    expect(can("designer", "template.write")).toBe(true);
    for (const action of ["template.publish", "template.assign", "patient.read", "rx.read", "catalogue.read", "settings.clinic", "settings.profile", "rx.share"] as const) {
      expect(can("designer", action)).toBe(false);
    }
  });

  it("lets only owners publish", () => {
    expect(can("owner", "template.publish")).toBe(true);
    for (const role of ["doctor", "designer", "reception", "nurse", "pharmacist", "accountant"]) expect(can(role, "template.publish")).toBe(false);
  });
});
```

`tests/integration/designer-role.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { pgErrorInfo } from "@/server/db/errors";
import { memberships, users } from "@/server/db/schema";
import { getActiveMembership } from "@/server/auth/credentials";
import { loadRxDocument } from "@/server/services/rx-documents";
import { newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let designer = "";

beforeAll(async () => {
  A = await createTestTenant("designer");
  const [user] = await adminDb.insert(users).values({ email: `designer-${Date.now()}@example.com`, name: "ClinicPad setup", passwordHash: "x" }).returning();
  designer = user.id;
});
afterAll(async () => {
  await A.cleanup();
  await adminDb.delete(users).where(eq(users.id, designer));
});

describe("designer memberships", () => {
  it("must expire (23514)", async () => {
    const error = await adminDb
      .insert(memberships)
      .values({ tenantId: A.tenantId, userId: designer, role: "designer" })
      .then(() => null, (e: unknown) => e);
    expect(pgErrorInfo(error).code).toBe("23514");
  });

  it("count while unexpired and stop counting the moment they expire", async () => {
    await adminDb.insert(memberships).values({ tenantId: A.tenantId, userId: designer, role: "designer", expiresAt: new Date(Date.now() + 7 * 86_400_000) });
    expect(await getActiveMembership(designer)).toEqual({ tenantId: A.tenantId, role: "designer" });
    await adminDb.update(memberships).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(memberships.userId, designer));
    expect(await getActiveMembership(designer)).toBeNull();
  });

  it("never reads prescriptions", async () => {
    expect(await loadRxDocument({ tenantId: A.tenantId, userId: newId(), role: "designer" }, newId())).toMatchObject({ ok: false, code: "forbidden" });
  });
});
```

Add to `tests/unit/sidebar.test.tsx`:

```tsx
  it("shows a designer only the pad templates", () => {
    render(<Sidebar role="designer" clinicName="Sunrise" />);
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Pad templates"]);
  });

  it("shows pad templates to owners and doctors, never to reception", () => {
    for (const role of ["owner", "doctor"]) {
      const { unmount } = render(<Sidebar role={role} clinicName="Sunrise" />);
      expect(screen.getByRole("link", { name: "Pad templates" })).toHaveAttribute("href", "/templates");
      unmount();
    }
    render(<Sidebar role="reception" clinicName="Sunrise" />);
    expect(screen.queryByRole("link", { name: "Pad templates" })).not.toBeInTheDocument();
  });
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/permissions.test.ts tests/unit/sidebar.test.tsx tests/integration/designer-role.test.ts`
Expected: FAIL (no designer role, no `expires_at`, no sidebar link).

- [ ] **Step 2: Add the role, the expiry, migration 0027, and the auth filter**

`src/server/db/schema/enums.ts`: add `"designer",` after `"pharmacist",` in `memberRole`.

`src/server/db/schema/tenancy.ts`, `memberships`: add `expiresAt: timestamp("expires_at", { withTimezone: true }),` after `status`, and in its config callback:

```ts
    // A designer (concierge template setup, Plan 2A) is a temporary member: the membership must expire. The role is
    // compared as text because a new enum value cannot be used in the migration that adds it (one transaction).
    check("memberships_designer_expiry_check", sql`role::text <> 'designer' or expires_at is not null`),
    check("memberships_expiry_check", sql`expires_at is null or expires_at > created_at`),
```

Run: `Set-Location E:\projects\clinicpad; npx drizzle-kit generate --name phase2a_designer_role`, then edit `drizzle/0027_phase2a_designer_role.sql` to exactly:

```sql
-- Plan 2A roles (generated, hand-edited): the designer role (templates only) and expiring memberships. memberships
-- has rows, so its CHECKs are added NOT VALID and validated here. The new enum value is not used as an enum literal in
-- this run (drizzle applies every pending migration in one transaction).
ALTER TYPE "public"."member_role" ADD VALUE 'designer';--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_designer_expiry_check" CHECK (role::text <> 'designer' or expires_at is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "memberships" VALIDATE CONSTRAINT "memberships_designer_expiry_check";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_expiry_check" CHECK (expires_at is null or expires_at > created_at) NOT VALID;--> statement-breakpoint
ALTER TABLE "memberships" VALIDATE CONSTRAINT "memberships_expiry_check";
```

In `src/server/auth/credentials.ts` `getActiveMembership`, add `gt, isNull, or, sql` to the `drizzle-orm` import and change the `where` to:

```ts
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        // Expiring memberships (designers) stop working at expires_at; the JWT callback re-reads this on every request.
        or(isNull(memberships.expiresAt), gt(memberships.expiresAt, sql`now()`)),
      ),
    )
```

`src/lib/domain/permissions.ts`: `"template.read": ["owner", "doctor", "designer"]`, `"template.write": ["owner", "doctor", "designer"]` (the comment above them: `// Plan 2A Template Studio. Doctors write and assign only within their own profile; designers never touch patients (checked in the services).`).

`src/components/app-shell/sidebar.tsx`: import `FileImage` from `lucide-react` and add after the Patients item:

```ts
  { href: "/templates", label: "Pad templates", icon: FileImage, roles: ["owner", "doctor", "designer"] },
```

`src/app/(app)/dashboard/page.tsx`: add `import { redirect } from "next/navigation";` and right after `const session = await requireSession();`:

```ts
  // A designer sets up pad templates only: no patient, prescription or clinic numbers (Plan 2A).
  if (session.role === "designer") redirect("/templates");
```

`tests/e2e/helpers.ts` `setRole`: replace the update with

```ts
    await sql`update memberships set role = ${role},
      expires_at = case when ${role} = 'designer' then now() + interval '7 days' else null end
      where user_id = (select id from users where email = ${email})`;
```

Run: `Set-Location E:\projects\clinicpad; npm run db:migrate; npx drizzle-kit generate; npx vitest run tests/unit/permissions.test.ts tests/unit/sidebar.test.tsx tests/integration/designer-role.test.ts tests/integration/schema-checks.test.ts`
Expected: migrate applies 0027; "No schema changes"; all PASS.

- [ ] **Step 3: Commit the role**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/db/schema/enums.ts src/server/db/schema/tenancy.ts drizzle/0027_phase2a_designer_role.sql drizzle/meta/0027_snapshot.json drizzle/meta/_journal.json src/lib/domain/permissions.ts tests/unit/permissions.test.ts src/server/auth/credentials.ts src/components/app-shell/sidebar.tsx tests/unit/sidebar.test.tsx "src/app/(app)/dashboard/page.tsx" tests/e2e/helpers.ts tests/integration/designer-role.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(auth): expiring designer role for pad template setup (0027)" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

- [ ] **Step 4: Write the failing service test**

`tests/integration/template-services.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, doctors, prescriptions, templates, templateVersions } from "@/server/db/schema";
import { newId } from "@/lib/domain/ids";
import type { ServiceContext } from "@/server/services/context";
import { finalizePrescription } from "@/server/services/prescriptions";
import { assignTemplate } from "@/server/services/template-assign";
import { publishTemplate, rollbackTemplate } from "@/server/services/template-publish";
import {
  archiveTemplate,
  createOverlayTemplate,
  discardTemplateDraft,
  getTemplateEditor,
  listTemplates,
  saveTemplateDraft,
  startTemplateDraft,
  unarchiveTemplate,
} from "@/server/services/templates";
import { TEMPLATE_QUOTAS } from "@/server/services/template-files";
import { newPatient, savedDraft } from "../helpers/rx-flow";
import { insertBackgroundFile, insertTemplate, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let fileA = "";
let doctorA = "";
const owner = () => A.as("owner");
const designer = (): ServiceContext => ({ tenantId: A.tenantId, userId: newId(), role: "designer" });
const def = () => structuredClone(MINIMAL_OVERLAY_DEFINITION);
const publishInput = (baseRevision: number) => ({ identity: "dynamic", boundDoctorId: null, confirmLetterhead: false, baseRevision });

async function created(ctx: ServiceContext = owner(), definition: unknown = def()) {
  const result = await createOverlayTemplate(ctx, { name: "Dr Shah's pad", fileId: fileA, paperSize: "A4", labels: "en", definition });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}
async function published() {
  const t = await created();
  const done = await publishTemplate(owner(), t.templateId, publishInput(0));
  if (!done.ok) throw new Error(done.message);
  return { ...t, ...done.value };
}

beforeAll(async () => {
  A = await createTestTenant("tpl-svc-a");
  B = await createTestTenant("tpl-svc-b");
  fileA = await insertBackgroundFile(A.tenantId, "svc-file");
  const [d] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, A.tenantId)).limit(1);
  doctorA = d.id;
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});
beforeEach(async () => {
  await adminDb.update(clinics).set({ customTemplateId: null }).where(eq(clinics.tenantId, A.tenantId));
  await adminDb.update(doctors).set({ templateId: null }).where(eq(doctors.tenantId, A.tenantId));
});

describe("creating and editing drafts", () => {
  it("creates a template with a version-1 draft and audits ids only (never the name)", async () => {
    const t = await created();
    const [v] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, t.versionId));
    expect(v).toMatchObject({ version: 1, state: "draft", paperSize: "A4", labels: "en", draftRevision: 0 });
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.entityId, t.templateId), eq(auditEvents.action, "template.created")));
    expect(JSON.stringify(event.after)).not.toContain("Shah");
  });

  it("binds a doctor's new template to the doctor, lets a designer create, and refuses reception", async () => {
    const mine = await created(A.as("doctor"));
    const [row] = await adminDb.select().from(templates).where(eq(templates.id, mine.templateId));
    expect(row).toMatchObject({ identity: "bound", boundDoctorId: doctorA });
    expect((await createOverlayTemplate(designer(), { name: "Setup", fileId: fileA, paperSize: "A4", labels: "en", definition: def() })).ok).toBe(true);
    expect(await createOverlayTemplate(A.as("reception"), { name: "X", fileId: fileA, paperSize: "A4", labels: "en", definition: def() })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("refuses another clinic's file, a definition that does not fit the paper, and a NUL in the name", async () => {
    const foreign = await insertBackgroundFile(B.tenantId, "svc-foreign");
    expect(await createOverlayTemplate(owner(), { name: "X", fileId: foreign, paperSize: "A4", labels: "en", definition: def() })).toMatchObject({ ok: false, code: "not_found" });
    expect(await createOverlayTemplate(owner(), { name: "X", fileId: fileA, paperSize: "A5", labels: "en", definition: def() })).toMatchObject({ ok: false, code: "invalid", field: "definition" });
    expect(await createOverlayTemplate(owner(), { name: "A\u0000B", fileId: fileA, paperSize: "A4", labels: "en", definition: def() })).toMatchObject({ ok: false, code: "invalid", field: "name" });
  });

  it("saves a draft with a revision check: of two saves from one revision, the second conflicts", async () => {
    const t = await created();
    const changed = { ...def(), printOffsetMm: { x: 1, y: 1 } };
    expect(await saveTemplateDraft(owner(), t.templateId, { definition: changed, labels: "hi", baseRevision: 0 })).toEqual({ ok: true, value: { revision: 1 } });
    expect(await saveTemplateDraft(owner(), t.templateId, { definition: def(), labels: "en", baseRevision: 0 })).toMatchObject({ ok: false, code: "conflict", currentRevision: 1 });
  });

  it("lets a doctor edit only templates bound to them", async () => {
    const dynamic = await created();
    expect(await saveTemplateDraft(A.as("doctor"), dynamic.templateId, { definition: def(), labels: "en", baseRevision: 0 })).toMatchObject({ ok: false, code: "forbidden" });
    const mine = await created(A.as("doctor"));
    expect((await saveTemplateDraft(A.as("doctor"), mine.templateId, { definition: def(), labels: "en", baseRevision: 0 })).ok).toBe(true);
  });

  it("never shows another clinic's template", async () => {
    const t = await created();
    expect(await getTemplateEditor(B.as("owner"), t.templateId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await listTemplates(B.as("owner"))).toEqual({ ok: true, value: [] });
  });

  it("keeps the active-template quota exact", async () => {
    const C = await createTestTenant("tpl-svc-quota");
    try {
      const file = await insertBackgroundFile(C.tenantId, "quota-file");
      for (let i = 0; i < TEMPLATE_QUOTAS.activeTemplates; i += 1) await insertTemplate(C.tenantId, { fileId: file });
      expect(await createOverlayTemplate(C.as("owner"), { name: "One too many", fileId: file, paperSize: "A4", labels: "en", definition: def() })).toMatchObject({ ok: false, code: "invalid" });
    } finally {
      await C.cleanup();
    }
  });
});

describe("publishing", () => {
  it("freezes the draft, makes it current, and audits the hash and the identity choice", async () => {
    const t = await published();
    const [v] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, t.versionId));
    expect(v).toMatchObject({ state: "published", contentSha256: t.contentSha256 });
    const [row] = await adminDb.select().from(templates).where(eq(templates.id, t.templateId));
    expect(row.currentVersionId).toBe(t.versionId);
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.entityId, t.templateId), eq(auditEvents.action, "template.published")));
    expect(event.after).toMatchObject({ versionId: t.versionId, version: 1, contentSha256: t.contentSha256, kind: "overlay", identity: "dynamic", fieldCount: 2 });
  });

  it("publishes exactly once on a double-click", async () => {
    const t = await created();
    const results = await Promise.all([publishTemplate(owner(), t.templateId, publishInput(0)), publishTemplate(owner(), t.templateId, publishInput(0))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "conflict" });
  });

  it("refuses doctors and designers, a pad without the patient's name, and a bound pad without confirmation", async () => {
    const t = await created();
    expect(await publishTemplate(A.as("doctor"), t.templateId, publishInput(0))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await publishTemplate(designer(), t.templateId, publishInput(0))).toMatchObject({ ok: false, code: "forbidden" });
    const bare = await created(owner(), { ...def(), boxes: [def().boxes[1]] });
    expect(await publishTemplate(owner(), bare.templateId, publishInput(0))).toMatchObject({ ok: false, code: "invalid", field: "definition" });
    expect(await publishTemplate(owner(), t.templateId, { identity: "bound", boundDoctorId: doctorA, confirmLetterhead: false, baseRevision: 0 })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it("refuses to publish a pad as bound while it is the clinic default", async () => {
    const t = await published();
    await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId });
    const draft = await startTemplateDraft(owner(), t.templateId);
    if (!draft.ok) throw new Error(draft.message);
    expect(await publishTemplate(owner(), t.templateId, { identity: "bound", boundDoctorId: doctorA, confirmLetterhead: true, baseRevision: 0 })).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  it("starts a new draft from the published version (idempotently), and rolls back by publishing a copy", async () => {
    const t = await published();
    const first = await startTemplateDraft(owner(), t.templateId);
    const again = await startTemplateDraft(owner(), t.templateId);
    expect(first.ok && again.ok && first.value.versionId === again.value.versionId && first.value.version === 2).toBe(true);
    expect(await rollbackTemplate(owner(), t.templateId, t.versionId)).toMatchObject({ ok: false, code: "conflict" });
    expect((await discardTemplateDraft(owner(), t.templateId)).ok).toBe(true);
    const rolled = await rollbackTemplate(owner(), t.templateId, t.versionId);
    expect(rolled).toMatchObject({ ok: true, value: { version: 2 } });
    if (!rolled.ok) return;
    const [copy] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, rolled.value.versionId));
    expect(copy).toMatchObject({ state: "published", contentSha256: t.contentSha256 });
  });

  it("deletes a never-published template when its only draft is discarded", async () => {
    const t = await created();
    expect(await discardTemplateDraft(owner(), t.templateId)).toEqual({ ok: true, value: { templateDeleted: true } });
    expect(await adminDb.select().from(templates).where(eq(templates.id, t.templateId))).toHaveLength(0);
  });
});

describe("assigning and archiving", () => {
  it("assigns a dynamic pad to the clinic and a bound pad only to its own doctor", async () => {
    const dynamic = await published();
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: dynamic.templateId })).toEqual({ ok: true, value: { previousTemplateId: null } });
    const bound = await created(A.as("doctor"));
    await publishTemplate(owner(), bound.templateId, { identity: "bound", boundDoctorId: doctorA, confirmLetterhead: true, baseRevision: 0 });
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: bound.templateId })).toMatchObject({ ok: false, code: "invalid" });
    expect((await assignTemplate(A.as("doctor"), { scope: "doctor", doctorId: doctorA, templateId: bound.templateId })).ok).toBe(true);
  });

  it("lets a doctor set only their own pad, and nobody assign an unpublished or archived one", async () => {
    const other = (await adminDb.insert(doctors).values({ tenantId: A.tenantId, displayName: "Dr Other" }).returning())[0];
    const t = await published();
    expect(await assignTemplate(A.as("doctor"), { scope: "doctor", doctorId: other.id, templateId: t.templateId })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await assignTemplate(A.as("doctor"), { scope: "clinic", templateId: t.templateId })).toMatchObject({ ok: false, code: "forbidden" });
    const draftOnly = await created();
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: draftOnly.templateId })).toMatchObject({ ok: false, code: "conflict" });
    expect((await archiveTemplate(owner(), t.templateId)).ok).toBe(true);
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId })).toMatchObject({ ok: false, code: "conflict" });
  });

  it("refuses to archive a pad in use, and an archive racing an assignment never leaves an archived pad assigned", async () => {
    const t = await published();
    await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId });
    expect(await archiveTemplate(owner(), t.templateId)).toMatchObject({ ok: false, code: "conflict" });
    await assignTemplate(owner(), { scope: "clinic", templateId: null });
    const race = await published();
    await Promise.all([archiveTemplate(owner(), race.templateId), assignTemplate(owner(), { scope: "clinic", templateId: race.templateId })]);
    const [row] = await adminDb.select().from(templates).where(eq(templates.id, race.templateId));
    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(row.status === "archived" && clinic.customTemplateId === race.templateId).toBe(false);
  });

  it("restores an archived pad within the quota", async () => {
    const t = await published();
    await archiveTemplate(owner(), t.templateId);
    expect((await unarchiveTemplate(owner(), t.templateId)).ok).toBe(true);
  });

  it("a finalize racing a publish freezes one of the published versions, never a draft", async () => {
    const t = await published();
    await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId });
    await startTemplateDraft(owner(), t.templateId);
    const { id, revision } = await savedDraft(A.as("doctor"), await newPatient(A.as("reception"), "Race Patient"));
    const [done] = await Promise.all([finalizePrescription(A.as("doctor"), id, { expectedRevision: revision }), publishTemplate(owner(), t.templateId, publishInput(0))]);
    expect(done.ok).toBe(true);
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    const [version] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, row.templateVersionId as string));
    expect(version.state).toBe("published");
  });
});
```

(The NUL in `"A\u0000B"` is an escape in the source; after writing the file run `Select-String -Path tests/integration/template-services.test.ts -Pattern '[\u0000-\u0008]'` — no output expected.)

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-services.test.ts`
Expected: FAIL — the service modules do not exist.

- [ ] **Step 5: Write validation and access helpers**

`src/server/validation/templates.ts`:

```ts
import { z } from "zod";
import { LABEL_LANGUAGES, PAPER_SIZES } from "@/lib/rx-render/types";
import { cleanRequiredText } from "./text";

export const templateNameSchema = cleanRequiredText(120, "Give the pad a name.");

export const createTemplateSchema = z.object({
  name: templateNameSchema,
  fileId: z.uuid({ message: "Upload the pad image again." }),
  paperSize: z.enum(PAPER_SIZES),
  labels: z.enum(LABEL_LANGUAGES),
  definition: z.unknown(),
});

export const saveDraftSchema = z.object({
  definition: z.unknown(),
  labels: z.enum(LABEL_LANGUAGES),
  fileId: z.uuid().optional(),
  name: templateNameSchema.optional(),
  baseRevision: z.number().int().min(0),
});

export const publishSchema = z.object({
  identity: z.enum(["dynamic", "bound"]),
  boundDoctorId: z.uuid().nullable(),
  confirmLetterhead: z.boolean(),
  baseRevision: z.number().int().min(0),
});

export const assignSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("clinic"), templateId: z.uuid().nullable() }),
  z.object({ scope: z.literal("doctor"), doctorId: z.uuid(), templateId: z.uuid().nullable() }),
]);
```

`src/server/services/template-access.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { doctors, templates } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { ServiceContext } from "./context";

export type TemplateRow = typeof templates.$inferSelect;
export const TEMPLATE_NOT_FOUND = "Pad template not found.";

/** The caller's own doctor profile in this clinic, or null (owners without a profile, designers). */
export async function myDoctorId(tx: TenantTx, ctx: ServiceContext): Promise<string | null> {
  const [row] = await tx
    .select({ id: doctors.id })
    .from(doctors)
    .where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.userId, ctx.userId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Locks a template row (decision 20): FOR UPDATE before writing it or its versions, FOR SHARE before writing anything
 * that references it (an assignment). Take lockTemplateQuota first when the change counts against a quota.
 */
export async function lockTemplate(tx: TenantTx, tenantId: string, id: string, mode: "update" | "share"): Promise<TemplateRow | null> {
  const [row] = await tx
    .select()
    .from(templates)
    .where(and(eq(templates.tenantId, tenantId), eq(templates.id, id)))
    .limit(1)
    .for(mode);
  return row ?? null;
}

/** template.write, and for a doctor only a template bound to their own profile (decision 15). */
export function mayWriteTemplate(ctx: ServiceContext, template: TemplateRow, doctorId: string | null): boolean {
  if (!can(ctx.role, "template.write")) return false;
  if (ctx.role !== "doctor") return true;
  return template.identity === "bound" && doctorId !== null && template.boundDoctorId === doctorId;
}
```

- [ ] **Step 6: Write the template service**

`src/server/services/templates.ts`:

```ts
import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, invalidFrom, ok, type Result, type ServiceError } from "@/lib/result";
import { overlayDefinitionSchema, overlayGeometryIssues, parseOverlayDefinition, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { pickOption, PAPER_SIZES, LABEL_LANGUAGES, type LabelLanguage, type PaperSize } from "@/lib/rx-render/types";
import { clinics, doctors, templateFiles, templates, templateVersions } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { createTemplateSchema, saveDraftSchema } from "@/server/validation/templates";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { lockTemplate, mayWriteTemplate, myDoctorId, TEMPLATE_NOT_FOUND, type TemplateRow } from "./template-access";
import { lockTemplateQuota, TEMPLATE_QUOTAS } from "./template-files";

export type TemplateSummary = {
  id: string;
  name: string;
  status: "active" | "archived";
  identity: "dynamic" | "bound";
  boundDoctorId: string | null;
  current: { versionId: string; version: number; publishedAt: Date } | null;
  draft: { versionId: string; version: number; revision: number; updatedAt: Date } | null;
  assignedToClinic: boolean;
  assignedDoctorIds: string[];
  canWrite: boolean;
};

export type TemplateEditorView = {
  summary: TemplateSummary;
  draft: { versionId: string; version: number; revision: number; definition: OverlayDefinition; paperSize: PaperSize; labels: LabelLanguage; fileId: string } | null;
  history: { versionId: string; version: number; publishedAt: Date; contentSha256: string }[];
};

export type DraftRevisionConflict = ServiceError & { code: "conflict"; currentRevision: number };

const NOT_FOUND = () => fail("not_found", TEMPLATE_NOT_FOUND);
const FORBIDDEN = () => fail("forbidden", "You cannot change this pad template.");

/** The first problem with a definition, as a field error on "definition". */
function definitionError(value: unknown, paperSize: PaperSize): ServiceError | null {
  const parsed = overlayDefinitionSchema.safeParse(value);
  if (!parsed.success) return { ...invalidFrom(parsed.error), field: "definition" };
  const issues = overlayGeometryIssues(parsed.data, paperSize);
  return issues.length > 0 ? { ok: false, code: "invalid", message: issues[0].message, field: "definition", path: issues[0].path } : null;
}

async function summaries(tx: TenantTx, ctx: ServiceContext, rows: TemplateRow[]): Promise<TemplateSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const versions = await tx
    .select()
    .from(templateVersions)
    .where(and(eq(templateVersions.tenantId, ctx.tenantId), inArray(templateVersions.templateId, ids)));
  const [clinic] = await tx.select({ customTemplateId: clinics.customTemplateId }).from(clinics).where(eq(clinics.tenantId, ctx.tenantId)).limit(1);
  const assigned = await tx
    .select({ id: doctors.id, templateId: doctors.templateId })
    .from(doctors)
    .where(and(eq(doctors.tenantId, ctx.tenantId), inArray(doctors.templateId, ids)));
  const mine = await myDoctorId(tx, ctx);
  return rows.map((t) => {
    const current = versions.find((v) => v.id === t.currentVersionId && v.state === "published");
    const draft = versions.find((v) => v.templateId === t.id && v.state === "draft");
    return {
      id: t.id,
      name: t.name,
      status: t.status === "archived" ? "archived" : "active",
      identity: t.identity === "bound" ? "bound" : "dynamic",
      boundDoctorId: t.boundDoctorId,
      current: current && current.publishedAt ? { versionId: current.id, version: current.version, publishedAt: current.publishedAt } : null,
      draft: draft ? { versionId: draft.id, version: draft.version, revision: draft.draftRevision, updatedAt: draft.updatedAt } : null,
      assignedToClinic: clinic?.customTemplateId === t.id,
      assignedDoctorIds: assigned.filter((d) => d.templateId === t.id).map((d) => d.id),
      canWrite: mayWriteTemplate(ctx, t, mine),
    };
  });
}

export async function listTemplates(ctx: ServiceContext): Promise<Result<TemplateSummary[]>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", "You cannot view pad templates.");
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx.select().from(templates).where(eq(templates.tenantId, ctx.tenantId)).orderBy(asc(templates.createdAt), asc(templates.id));
    return ok(await summaries(tx, ctx, rows));
  });
}

export async function getTemplateEditor(ctx: ServiceContext, templateId: string): Promise<Result<TemplateEditorView>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", "You cannot view pad templates.");
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<TemplateEditorView>> => {
    const [row] = await tx.select().from(templates).where(and(eq(templates.tenantId, ctx.tenantId), eq(templates.id, templateId))).limit(1);
    if (!row) return NOT_FOUND();
    const [summary] = await summaries(tx, ctx, [row]);
    const versions = await tx
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.tenantId, ctx.tenantId), eq(templateVersions.templateId, templateId)))
      .orderBy(desc(templateVersions.version));
    const draftRow = versions.find((v) => v.state === "draft");
    let draft: TemplateEditorView["draft"] = null;
    if (draftRow) {
      const paperSize = pickOption(PAPER_SIZES, draftRow.paperSize, "A4");
      const definition = parseOverlayDefinition(draftRow.definition, paperSize);
      if (!definition) return fail("invalid", "This draft is damaged. Discard it and start again from the published version.");
      draft = {
        versionId: draftRow.id,
        version: draftRow.version,
        revision: draftRow.draftRevision,
        definition,
        paperSize,
        labels: pickOption(LABEL_LANGUAGES, draftRow.labels, "en"),
        fileId: draftRow.fileId,
      };
    }
    const history = versions
      .filter((v) => v.state === "published" && v.publishedAt && v.contentSha256)
      .map((v) => ({ versionId: v.id, version: v.version, publishedAt: v.publishedAt as Date, contentSha256: v.contentSha256 as string }));
    return ok({ summary, draft, history });
  });
}

async function fileExists(tx: TenantTx, tenantId: string, fileId: string): Promise<boolean> {
  const [row] = await tx.select({ id: templateFiles.id }).from(templateFiles).where(and(eq(templateFiles.tenantId, tenantId), eq(templateFiles.id, fileId))).limit(1);
  return Boolean(row);
}

async function versionQuotaReached(tx: TenantTx, tenantId: string): Promise<boolean> {
  const [row] = await tx.select({ n: count() }).from(templateVersions).where(eq(templateVersions.tenantId, tenantId));
  return (row?.n ?? 0) >= TEMPLATE_QUOTAS.versions;
}

/** A new overlay template with its first draft (version 1). A doctor's template is bound to the doctor (decision 15). */
export async function createOverlayTemplate(ctx: ServiceContext, raw: unknown): Promise<Result<{ templateId: string; versionId: string }>> {
  if (!can(ctx.role, "template.write")) return fail("forbidden", "You cannot create pad templates.");
  const input = createTemplateSchema.safeParse(raw);
  if (!input.success) return invalidFrom(input.error);
  const bad = definitionError(input.data.definition, input.data.paperSize);
  if (bad) return bad;
  const definition = parseOverlayDefinition(input.data.definition, input.data.paperSize) as OverlayDefinition;
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ templateId: string; versionId: string }>> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    if (!(await fileExists(tx, ctx.tenantId, input.data.fileId))) return fail("not_found", "The uploaded pad image was not found. Upload it again.");
    const [active] = await tx.select({ n: count() }).from(templates).where(and(eq(templates.tenantId, ctx.tenantId), eq(templates.status, "active")));
    if ((active?.n ?? 0) >= TEMPLATE_QUOTAS.activeTemplates) {
      return fail("invalid", `This clinic already has ${TEMPLATE_QUOTAS.activeTemplates} active pads. Archive one first.`);
    }
    if (await versionQuotaReached(tx, ctx.tenantId)) return fail("invalid", "This clinic has reached its limit of pad versions. Ask us to raise it.");
    let boundDoctorId: string | null = null;
    if (ctx.role === "doctor") {
      boundDoctorId = await myDoctorId(tx, ctx);
      if (!boundDoctorId) return fail("forbidden", "Set up your doctor profile before creating your own pad.");
    }
    const [template] = await tx
      .insert(templates)
      .values({ tenantId: ctx.tenantId, name: input.data.name, kind: "overlay", identity: boundDoctorId ? "bound" : "dynamic", boundDoctorId, createdBy: ctx.userId })
      .returning({ id: templates.id });
    const [version] = await tx
      .insert(templateVersions)
      .values({ tenantId: ctx.tenantId, templateId: template.id, version: 1, fileId: input.data.fileId, definition, paperSize: input.data.paperSize, labels: input.data.labels, createdBy: ctx.userId })
      .returning({ id: templateVersions.id });
    await recordAudit(tx, ctx, {
      action: "template.created",
      entityType: "template",
      entityId: template.id,
      after: { templateId: template.id, versionId: version.id, kind: "overlay", paperSize: input.data.paperSize, labels: input.data.labels, identity: boundDoctorId ? "bound" : "dynamic" },
    });
    return ok({ templateId: template.id, versionId: version.id });
  });
}

/** Saves the working draft in place (not audited: a draft is not a record, ADR-0029), under its revision counter. */
export async function saveTemplateDraft(ctx: ServiceContext, templateId: string, raw: unknown): Promise<Result<{ revision: number }> | DraftRevisionConflict> {
  if (!can(ctx.role, "template.write")) return FORBIDDEN();
  if (!isUuid(templateId)) return NOT_FOUND();
  const input = saveDraftSchema.safeParse(raw);
  if (!input.success) return invalidFrom(input.error);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ revision: number }> | DraftRevisionConflict> => {
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (!mayWriteTemplate(ctx, template, await myDoctorId(tx, ctx))) return FORBIDDEN();
    if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it before editing.");
    const [draft] = await tx
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.templateId, templateId), eq(templateVersions.state, "draft")))
      .limit(1);
    if (!draft) return fail("conflict", "There is no draft to save. Start editing again from the published pad.");
    if (draft.draftRevision !== input.data.baseRevision) {
      return { ok: false, code: "conflict", message: "This pad was changed in another window. Reload to see the latest version.", currentRevision: draft.draftRevision };
    }
    const paperSize = pickOption(PAPER_SIZES, draft.paperSize, "A4");
    const bad = definitionError(input.data.definition, paperSize);
    if (bad) return bad;
    if (input.data.fileId && input.data.fileId !== draft.fileId && !(await fileExists(tx, ctx.tenantId, input.data.fileId))) {
      return fail("not_found", "The uploaded pad image was not found. Upload it again.", "fileId");
    }
    const revision = draft.draftRevision + 1;
    await tx
      .update(templateVersions)
      .set({ definition: parseOverlayDefinition(input.data.definition, paperSize) as OverlayDefinition, labels: input.data.labels, fileId: input.data.fileId ?? draft.fileId, draftRevision: revision })
      .where(eq(templateVersions.id, draft.id));
    if (input.data.name && input.data.name !== template.name) await tx.update(templates).set({ name: input.data.name }).where(eq(templates.id, templateId));
    return ok({ revision });
  });
}

/** The working draft, created from the current published version when there is none (idempotent). */
export async function startTemplateDraft(ctx: ServiceContext, templateId: string): Promise<Result<{ versionId: string; version: number }>> {
  if (!can(ctx.role, "template.write")) return FORBIDDEN();
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ versionId: string; version: number }>> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (!mayWriteTemplate(ctx, template, await myDoctorId(tx, ctx))) return FORBIDDEN();
    if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it before editing.");
    const [open] = await tx.select().from(templateVersions).where(and(eq(templateVersions.templateId, templateId), eq(templateVersions.state, "draft"))).limit(1);
    if (open) return ok({ versionId: open.id, version: open.version });
    const [current] = template.currentVersionId
      ? await tx.select().from(templateVersions).where(eq(templateVersions.id, template.currentVersionId)).limit(1)
      : [];
    if (!current) return fail("conflict", "This pad has nothing published to start from.");
    if (await versionQuotaReached(tx, ctx.tenantId)) return fail("invalid", "This clinic has reached its limit of pad versions. Ask us to raise it.");
    const [top] = await tx.select({ v: max(templateVersions.version) }).from(templateVersions).where(eq(templateVersions.templateId, templateId));
    const [row] = await tx
      .insert(templateVersions)
      .values({ tenantId: ctx.tenantId, templateId, version: (top?.v ?? 0) + 1, fileId: current.fileId, definition: current.definition, paperSize: current.paperSize, labels: current.labels, createdBy: ctx.userId })
      .returning({ id: templateVersions.id, version: templateVersions.version });
    return ok({ versionId: row.id, version: row.version });
  });
}

/** Drops the working draft; a template that was never published goes with it (audited, ids only). */
export async function discardTemplateDraft(ctx: ServiceContext, templateId: string): Promise<Result<{ templateDeleted: boolean }>> {
  if (!can(ctx.role, "template.write")) return FORBIDDEN();
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ templateDeleted: boolean }>> => {
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (!mayWriteTemplate(ctx, template, await myDoctorId(tx, ctx))) return FORBIDDEN();
    await tx.delete(templateVersions).where(and(eq(templateVersions.templateId, templateId), eq(templateVersions.state, "draft")));
    if (template.currentVersionId !== null) return ok({ templateDeleted: false });
    await tx.delete(templates).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, { action: "template.deleted", entityType: "template", entityId: templateId, after: { templateId } });
    return ok({ templateDeleted: true });
  });
}

/** Hides a pad from assignment (owner only); refused while the clinic or a doctor uses it. */
export async function archiveTemplate(ctx: ServiceContext, templateId: string): Promise<Result<null>> {
  if (!can(ctx.role, "template.publish")) return fail("forbidden", "Only the clinic owner can archive pads.");
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<null>> => {
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (template.status === "archived") return ok(null);
    const [clinic] = await tx.select({ id: clinics.id }).from(clinics).where(and(eq(clinics.tenantId, ctx.tenantId), eq(clinics.customTemplateId, templateId))).limit(1);
    const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.templateId, templateId))).limit(1);
    if (clinic || doctor) return fail("conflict", "This pad is in use. Choose another pad for the clinic and its doctors first.");
    await tx.update(templates).set({ status: "archived" }).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, { action: "template.archived", entityType: "template", entityId: templateId, after: { templateId } });
    return ok(null);
  });
}

export async function unarchiveTemplate(ctx: ServiceContext, templateId: string): Promise<Result<null>> {
  if (!can(ctx.role, "template.publish")) return fail("forbidden", "Only the clinic owner can restore pads.");
  if (!isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<null>> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (template.status === "active") return ok(null);
    const [active] = await tx.select({ n: count() }).from(templates).where(and(eq(templates.tenantId, ctx.tenantId), eq(templates.status, "active")));
    if ((active?.n ?? 0) >= TEMPLATE_QUOTAS.activeTemplates) return fail("invalid", `This clinic already has ${TEMPLATE_QUOTAS.activeTemplates} active pads. Archive one first.`);
    await tx.update(templates).set({ status: "active" }).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, { action: "template.unarchived", entityType: "template", entityId: templateId, after: { templateId } });
    return ok(null);
  });
}
```

(`templates.ts` is close to the 250-line guideline; if it goes over, move `archiveTemplate` and `unarchiveTemplate` into `src/server/services/template-archive.ts` with the same exports.)

- [ ] **Step 7: Write the publish and assign services**

`src/server/services/template-publish.ts`:

```ts
import { and, count, eq, max } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { parseOverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { LABEL_LANGUAGES, PAPER_SIZES, pickOption } from "@/lib/rx-render/types";
import { overlayPublishIssues, type PublishIdentity } from "@/lib/templates/publish-rules";
import { clinics, doctors, templateFiles, templates, templateVersions } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { templateContentSha256 } from "@/server/templates/content-hash";
import { publishSchema } from "@/server/validation/templates";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { lockTemplate, TEMPLATE_NOT_FOUND } from "./template-access";
import { lockTemplateQuota, TEMPLATE_QUOTAS } from "./template-files";

const NOT_FOUND = () => fail("not_found", TEMPLATE_NOT_FOUND);
const FORBIDDEN = () => fail("forbidden", "Only the clinic owner can publish pads.");

type VersionRow = typeof templateVersions.$inferSelect;

/** Freezes one draft row as published and makes it current (in the caller's transaction, under the template lock). */
async function freeze(tx: TenantTx, ctx: ServiceContext, draft: VersionRow): Promise<Result<{ contentSha256: string; fieldCount: number }>> {
  const paperSize = pickOption(PAPER_SIZES, draft.paperSize, "A4");
  const labels = pickOption(LABEL_LANGUAGES, draft.labels, "en");
  const definition = parseOverlayDefinition(draft.definition, paperSize);
  const [file] = await tx.select({ sha256: templateFiles.sha256 }).from(templateFiles).where(and(eq(templateFiles.tenantId, ctx.tenantId), eq(templateFiles.id, draft.fileId))).limit(1);
  if (!definition || !file) return fail("invalid", "This draft is damaged. Discard it and start again from the published version.");
  const contentSha256 = templateContentSha256({ kind: "overlay", paperSize, labels, definition, fileSha256: file.sha256 });
  await tx.update(templateVersions).set({ state: "published", contentSha256, publishedAt: new Date(), publishedBy: ctx.userId }).where(eq(templateVersions.id, draft.id));
  return ok({ contentSha256, fieldCount: definition.boxes.length });
}

/**
 * Publishes the working draft (owner only): checks the publish rules and the identity answer, refuses identity changes
 * that would break an assignment, freezes the version (trigger), and makes it current. A double-click publishes once:
 * the second request waits on the template lock and then finds no draft.
 */
export async function publishTemplate(ctx: ServiceContext, templateId: string, raw: unknown): Promise<Result<{ versionId: string; version: number; contentSha256: string }>> {
  if (!can(ctx.role, "template.publish")) return FORBIDDEN();
  if (!isUuid(templateId)) return NOT_FOUND();
  const input = publishSchema.safeParse(raw);
  if (!input.success) return invalidFrom(input.error);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ versionId: string; version: number; contentSha256: string }>> => {
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it before publishing.");
    const [draft] = await tx.select().from(templateVersions).where(and(eq(templateVersions.templateId, templateId), eq(templateVersions.state, "draft"))).limit(1);
    if (!draft) return fail("conflict", "There is nothing new to publish.");
    if (draft.draftRevision !== input.data.baseRevision) return fail("conflict", "This pad was changed in another window. Reload and check it before publishing.");
    const paperSize = pickOption(PAPER_SIZES, draft.paperSize, "A4");
    const definition = parseOverlayDefinition(draft.definition, paperSize);
    if (!definition) return fail("invalid", "This draft is damaged. Discard it and start again from the published version.");
    const bound = input.data.identity === "bound";
    if (bound && input.data.boundDoctorId) {
      const [doc] = await tx.select({ id: doctors.id }).from(doctors).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.id, input.data.boundDoctorId))).limit(1);
      if (!doc) return fail("invalid", "Choose a doctor of this clinic.", "boundDoctorId");
    }
    const identity: PublishIdentity = bound ? { kind: "bound", doctorId: input.data.boundDoctorId, confirmed: input.data.confirmLetterhead } : { kind: "dynamic" };
    const issues = overlayPublishIssues(definition, paperSize, identity);
    if (issues.length > 0) return fail("invalid", issues[0].message, "definition");
    if (bound) {
      const [asDefault] = await tx.select({ id: clinics.id }).from(clinics).where(and(eq(clinics.tenantId, ctx.tenantId), eq(clinics.customTemplateId, templateId))).limit(1);
      if (asDefault) return fail("conflict", "This pad is the clinic default. A doctor's own letterhead cannot be the clinic default: choose another default first.");
      const users = await tx.select({ id: doctors.id }).from(doctors).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.templateId, templateId)));
      if (users.some((d) => d.id !== input.data.boundDoctorId)) return fail("conflict", "Another doctor uses this pad. Choose another pad for them first.");
    }
    const frozen = await freeze(tx, ctx, draft);
    if (!frozen.ok) return frozen;
    await tx
      .update(templates)
      .set({ currentVersionId: draft.id, identity: input.data.identity, boundDoctorId: bound ? input.data.boundDoctorId : null })
      .where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, {
      action: "template.published",
      entityType: "template",
      entityId: templateId,
      after: {
        templateId,
        versionId: draft.id,
        version: draft.version,
        contentSha256: frozen.value.contentSha256,
        kind: "overlay",
        fieldCount: frozen.value.fieldCount,
        identity: input.data.identity,
        boundDoctorId: bound ? input.data.boundDoctorId : null,
        boundConfirmation: bound ? input.data.confirmLetterhead : null,
      },
    });
    return ok({ versionId: draft.id, version: draft.version, contentSha256: frozen.value.contentSha256 });
  });
}

/** Publishes a copy of an older published version as the next version number (history stays linear, never rewritten). */
export async function rollbackTemplate(ctx: ServiceContext, templateId: string, sourceVersionId: string): Promise<Result<{ versionId: string; version: number }>> {
  if (!can(ctx.role, "template.publish")) return FORBIDDEN();
  if (!isUuid(templateId) || !isUuid(sourceVersionId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ versionId: string; version: number }>> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    const template = await lockTemplate(tx, ctx.tenantId, templateId, "update");
    if (!template) return NOT_FOUND();
    if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it first.");
    const [open] = await tx.select({ id: templateVersions.id }).from(templateVersions).where(and(eq(templateVersions.templateId, templateId), eq(templateVersions.state, "draft"))).limit(1);
    if (open) return fail("conflict", "Publish or discard the open draft first.");
    const [source] = await tx
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.templateId, templateId), eq(templateVersions.id, sourceVersionId), eq(templateVersions.state, "published")))
      .limit(1);
    if (!source) return NOT_FOUND();
    const [used] = await tx.select({ n: count() }).from(templateVersions).where(eq(templateVersions.tenantId, ctx.tenantId));
    if ((used?.n ?? 0) >= TEMPLATE_QUOTAS.versions) return fail("invalid", "This clinic has reached its limit of pad versions. Ask us to raise it.");
    const [top] = await tx.select({ v: max(templateVersions.version) }).from(templateVersions).where(eq(templateVersions.templateId, templateId));
    const [copy] = await tx
      .insert(templateVersions)
      .values({ tenantId: ctx.tenantId, templateId, version: (top?.v ?? 0) + 1, fileId: source.fileId, definition: source.definition, paperSize: source.paperSize, labels: source.labels, createdBy: ctx.userId })
      .returning();
    const frozen = await freeze(tx, ctx, copy);
    if (!frozen.ok) return frozen;
    await tx.update(templates).set({ currentVersionId: copy.id }).where(eq(templates.id, templateId));
    await recordAudit(tx, ctx, {
      action: "template.published",
      entityType: "template",
      entityId: templateId,
      after: { templateId, versionId: copy.id, version: copy.version, contentSha256: frozen.value.contentSha256, kind: "overlay", fieldCount: frozen.value.fieldCount, identity: template.identity, rolledBackFrom: source.id },
    });
    return ok({ versionId: copy.id, version: copy.version });
  });
}
```

`src/server/services/template-assign.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { clinics, doctors } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { assignSchema } from "@/server/validation/templates";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";
import { lockTemplate, myDoctorId, TEMPLATE_NOT_FOUND } from "./template-access";

/**
 * Chooses the pad the clinic (owner) or one doctor (owner, or that doctor) prints on; templateId null means the built-in
 * pad. The template row is locked FOR SHARE, so an archive (FOR UPDATE) cannot slip in between check and write.
 */
export async function assignTemplate(ctx: ServiceContext, raw: unknown): Promise<Result<{ previousTemplateId: string | null }>> {
  if (!can(ctx.role, "template.assign")) return fail("forbidden", "You cannot choose pads.");
  const input = assignSchema.safeParse(raw);
  if (!input.success) return invalidFrom(input.error);
  const target = input.data;
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ previousTemplateId: string | null }>> => {
    const mine = await myDoctorId(tx, ctx);
    if (target.scope === "clinic" && ctx.role !== "owner") return fail("forbidden", "Only the clinic owner can choose the clinic's pad.");
    if (target.scope === "doctor" && ctx.role !== "owner" && target.doctorId !== mine) return fail("forbidden", "You can only choose your own pad.");
    if (target.templateId !== null) {
      const template = await lockTemplate(tx, ctx.tenantId, target.templateId, "share");
      if (!template) return fail("not_found", TEMPLATE_NOT_FOUND);
      if (template.status !== "active") return fail("conflict", "This pad is archived. Restore it first.");
      if (template.currentVersionId === null) return fail("conflict", "Publish this pad before using it.");
      if (template.identity === "bound") {
        if (target.scope === "clinic") return fail("invalid", "A doctor's own letterhead cannot be the clinic default.");
        if (template.boundDoctorId !== target.doctorId) return fail("invalid", "This letterhead belongs to another doctor.");
      }
    }
    let previousTemplateId: string | null;
    if (target.scope === "clinic") {
      const clinic = await primaryClinic(tx, ctx.tenantId, true);
      if (!clinic) return fail("not_found", "Set up the clinic profile first.");
      previousTemplateId = clinic.customTemplateId;
      await tx.update(clinics).set({ customTemplateId: target.templateId }).where(eq(clinics.id, clinic.id));
    } else {
      const [doctor] = await tx.select().from(doctors).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.id, target.doctorId))).limit(1).for("update");
      if (!doctor) return fail("not_found", "Doctor not found.");
      previousTemplateId = doctor.templateId;
      await tx.update(doctors).set({ templateId: target.templateId }).where(eq(doctors.id, doctor.id));
    }
    await recordAudit(tx, ctx, {
      action: "template.assigned",
      entityType: "template",
      entityId: target.templateId ?? undefined,
      after: { scope: target.scope, doctorId: target.scope === "doctor" ? target.doctorId : null, templateId: target.templateId, previousTemplateId },
    });
    return ok({ previousTemplateId });
  });
}

/** Doctors of this clinic for the bound-letterhead and assignment pickers (display names only). */
export async function listTemplateDoctors(ctx: ServiceContext): Promise<Result<{ id: string; name: string; isMe: boolean }[]>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", "You cannot view pad templates.");
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx.select({ id: doctors.id, name: doctors.displayName, userId: doctors.userId }).from(doctors).where(eq(doctors.tenantId, ctx.tenantId)).orderBy(asc(doctors.displayName));
    return ok(rows.map((r) => ({ id: r.id, name: r.name?.trim() || "Doctor without a name", isMe: r.userId === ctx.userId })));
  });
}
```

(Lock order in `assignTemplate`: template FOR SHARE, then the clinic or doctor row FOR UPDATE. Nothing else locks a clinic or doctor row and then a template, so this order cannot deadlock; `archiveTemplate` locks only the template.)

- [ ] **Step 8: Write the actions**

`src/server/actions/templates.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireSession, type SessionContext } from "@/server/auth/session";
import { assignTemplate } from "@/server/services/template-assign";
import { publishTemplate, rollbackTemplate } from "@/server/services/template-publish";
import { archiveTemplate, createOverlayTemplate, discardTemplateDraft, saveTemplateDraft, startTemplateDraft, unarchiveTemplate } from "@/server/services/templates";

export type TemplateActionState = { ok?: true; error?: string; field?: string; templateId?: string; revision?: number; currentRevision?: number };

const INTERNAL: TemplateActionState = { error: "Something went wrong. Please try again." };

/** requireSession() redirects (it throws), so it runs outside the try block; everything after it is caught. Error class only in logs. */
async function asSession(name: string, run: (session: SessionContext) => Promise<TemplateActionState>): Promise<TemplateActionState> {
  const session = await requireSession();
  try {
    return await run(session);
  } catch (error) {
    console.error(`${name} failed`, error instanceof Error ? error.name : typeof error);
    return INTERNAL;
  }
}

type Failure = { ok: false; message: string; field?: string; currentRevision?: number };
const failed = (r: Failure): TemplateActionState => ({ error: r.message, field: r.field, currentRevision: r.currentRevision });

export async function createTemplateAction(input: { name: string; fileId: string; paperSize: string; labels: string; definition: unknown }): Promise<TemplateActionState> {
  return asSession("createTemplateAction", async (session) => {
    const result = await createOverlayTemplate(session, input);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true, templateId: result.value.templateId };
  });
}

export async function saveTemplateDraftAction(templateId: string, input: { definition: unknown; labels: string; name?: string; fileId?: string; baseRevision: number }): Promise<TemplateActionState> {
  return asSession("saveTemplateDraftAction", async (session) => {
    const result = await saveTemplateDraft(session, templateId, input);
    if (!result.ok) return failed(result);
    return { ok: true, revision: result.value.revision };
  });
}

export async function startTemplateDraftAction(templateId: string): Promise<TemplateActionState> {
  return asSession("startTemplateDraftAction", async (session) => {
    const result = await startTemplateDraft(session, templateId);
    if (!result.ok) return failed(result);
    revalidatePath(`/templates/${templateId}`);
    return { ok: true };
  });
}

export async function discardTemplateDraftAction(templateId: string): Promise<TemplateActionState> {
  return asSession("discardTemplateDraftAction", async (session) => {
    const result = await discardTemplateDraft(session, templateId);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true };
  });
}

export async function publishTemplateAction(templateId: string, input: { identity: string; boundDoctorId: string | null; confirmLetterhead: boolean; baseRevision: number }): Promise<TemplateActionState> {
  return asSession("publishTemplateAction", async (session) => {
    const result = await publishTemplate(session, templateId, input);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    revalidatePath(`/templates/${templateId}`);
    return { ok: true };
  });
}

export async function rollbackTemplateAction(templateId: string, versionId: string): Promise<TemplateActionState> {
  return asSession("rollbackTemplateAction", async (session) => {
    const result = await rollbackTemplate(session, templateId, versionId);
    if (!result.ok) return failed(result);
    revalidatePath(`/templates/${templateId}`);
    return { ok: true };
  });
}

export async function archiveTemplateAction(templateId: string): Promise<TemplateActionState> {
  return asSession("archiveTemplateAction", async (session) => {
    const result = await archiveTemplate(session, templateId);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true };
  });
}

export async function unarchiveTemplateAction(templateId: string): Promise<TemplateActionState> {
  return asSession("unarchiveTemplateAction", async (session) => {
    const result = await unarchiveTemplate(session, templateId);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true };
  });
}

export async function assignTemplateAction(input: { scope: "clinic"; templateId: string | null } | { scope: "doctor"; doctorId: string; templateId: string | null }): Promise<TemplateActionState> {
  return asSession("assignTemplateAction", async (session) => {
    const result = await assignTemplate(session, input);
    if (!result.ok) return failed(result);
    revalidatePath("/templates");
    return { ok: true };
  });
}
```

- [ ] **Step 9: Run the tests**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-services.test.ts tests/integration/designer-role.test.ts`
Expected: PASS. In particular: one success and one `conflict` on the double-click publish; the archive/assign race never ends with an archived pad assigned.

- [ ] **Step 10: Full checks and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/validation/templates.ts src/server/services/template-access.ts src/server/services/templates.ts src/server/services/template-publish.ts src/server/services/template-assign.ts src/server/actions/templates.ts tests/integration/template-services.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(templates): create, edit, publish, roll back, archive and assign pad templates" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 16: Template Studio UI 1 — the list, the new-pad wizard, the sandboxed PDF frame, crop and rotate, auto-layout

**Gate:** the S2 finding. GO or GO-WITH-FALLBACK: `PDF_INTAKE_ENABLED = true`. NO-GO: `PDF_INTAKE_ENABLED = false` (the PDF source option is hidden; everything else in this task is unchanged).

**Files:**
- Modify: `package.json`, `package-lock.json` (`pdfjs-dist`, exact), `scripts/build-desktop.mjs` (`src/app/pdf-frame`), `next.config.ts` (trace the two pdf.js files)
- Create: `src/server/templates/pdf-frame-assets.ts`, `src/app/pdf-frame/[asset]/route.ts`
- Create: `src/lib/templates/pdf-intake.ts`, `src/lib/templates/pdf-frame-client.ts`, `src/lib/templates/image-geometry.ts`, `src/lib/templates/auto-layout.ts`, `src/lib/templates/canvas.ts`
- Create: `src/app/(app)/templates/page.tsx`, `src/app/(app)/templates/new/page.tsx`, `src/components/templates/template-list.tsx`, `src/components/templates/template-row-actions.tsx`, `src/components/templates/new-template-wizard.tsx`, `src/components/templates/source-step.tsx`, `src/components/templates/file-step.tsx`, `src/components/templates/fit-step.tsx`
- Test: `tests/unit/image-geometry.test.ts`, `tests/unit/auto-layout.test.ts`, `tests/unit/pdf-frame-route.test.ts`, `tests/unit/new-template-wizard.test.tsx`; create `tests/helpers/pdfs.ts` (used by Task 20's e2e)

**Interfaces:**
- Consumes: `POST /templates/uploads` (Task 9), `createTemplateAction`, `archiveTemplateAction`, `unarchiveTemplateAction` (Task 15), `listTemplates` (Task 15), `defaultOverlayDefinition`, `overlayGeometryIssues` (Task 11), `PAPER`, `BACKGROUND_LIMITS`.
- Produces:
  - `/pdf-frame/frame.html|frame.mjs|pdf.mjs|pdf.worker.mjs` (public, static, server-only route).
  - `PDF_INTAKE_ENABLED`, `PDF_INTAKE_LIMITS = { maxBytes: 10485760, maxPages: 50, timeoutMs: 20000, dpi: 200 }` (`pdf-intake.ts`).
  - `rasterizePdfPage(pdf: ArrayBuffer, opts: { page: number; dpi: number; timeoutMs?: number }): Promise<RasterResult>` (`pdf-frame-client.ts`, client only).
  - `image-geometry.ts`: `A_SERIES_RATIO`, `ASPECT_TOLERANCE`, `type Crop`, `NO_CROP`, `clampCrop(c)`, `rotatedSize(w, h, quarterTurns)`, `cropRect(w, h, crop)`, `aspectOk(w, h)`, `aspectError(w, h): number` (|height / width − √2|, or 1 for landscape), `targetPixels(paper)`, `paperFromPdfPoints(wPt, hPt): PaperSize | null`, `JPEG_QUALITIES`, `TARGET_UPLOAD_BYTES`.
  - `autoLayout(paper: PaperSize, darkness: readonly number[]): OverlayDefinition` (`auto-layout.ts`).
  - `canvas.ts` (client only): `loadBitmap(blob)`, `drawFitted(bitmap, crop, quarterTurns, target)`, `rowDarkness(canvas, strips?)`, `encodeForUpload(canvas)`.
  - Pages `/templates` and `/templates/new`.

- [ ] **Step 1: Add pdf.js, exactly as S2 recorded, after an audit baseline**

```powershell
Set-Location E:\projects\clinicpad; npm audit --omit=dev 2>&1 | Select-String "vulnerabilities"
Set-Location E:\projects\clinicpad; npm install --save-exact pdfjs-dist@<PDFJS_VERSION from the S2 finding>
Set-Location E:\projects\clinicpad; npm audit --omit=dev 2>&1 | Select-String "vulnerabilities"
Set-Location E:\projects\clinicpad; Test-Path node_modules/pdfjs-dist/build/pdf.min.mjs, node_modules/pdfjs-dist/build/pdf.worker.min.mjs
```

Expected: the version in `package.json` has no `^`; both files exist; note both audit lines for the commit body. pdf.js is never imported by app code: only the frame route reads these two files.

- [ ] **Step 2: Write the failing pure tests**

`tests/unit/image-geometry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aspectError, aspectOk, clampCrop, cropRect, paperFromPdfPoints, rotatedSize, targetPixels } from "@/lib/templates/image-geometry";
import { BACKGROUND_LIMITS } from "@/lib/domain/image";

describe("image geometry", () => {
  it("swaps the sides for quarter turns", () => {
    expect(rotatedSize(1000, 1414, 1)).toEqual({ width: 1414, height: 1000 });
    expect(rotatedSize(1000, 1414, 2)).toEqual({ width: 1000, height: 1414 });
  });

  it("crops by fractions, never below one pixel, never more than 45 % per side", () => {
    expect(cropRect(1000, 2000, { top: 0.1, right: 0.05, bottom: 0.1, left: 0.05 })).toEqual({ x: 50, y: 200, width: 900, height: 1600 });
    expect(clampCrop({ top: -1, right: 2, bottom: Number.NaN, left: 0.2 })).toEqual({ top: 0, right: 0.45, bottom: 0, left: 0.2 });
  });

  it("accepts only upright A-series proportions, with the server's tolerance", () => {
    expect(aspectOk(1654, 2339)).toBe(true);
    expect(aspectOk(1165, 1654)).toBe(true);
    expect(aspectOk(2339, 1654)).toBe(false);
    expect(aspectOk(850, 1100)).toBe(false);
    expect(aspectError(1000, 1000)).toBeGreaterThan(BACKGROUND_LIMITS.aspectTolerance);
  });

  it("produces upload sizes the server accepts", () => {
    for (const paper of ["A4", "A5"] as const) {
      const { width, height } = targetPixels(paper);
      expect(aspectOk(width, height)).toBe(true);
      expect(height).toBeGreaterThanOrEqual(BACKGROUND_LIMITS.minLongSide);
      expect(height).toBeLessThanOrEqual(BACKGROUND_LIMITS.maxLongSide);
    }
  });

  it("recognises A4 and A5 PDF pages, either way up, and nothing else", () => {
    expect(paperFromPdfPoints(595.28, 841.89)).toBe("A4");
    expect(paperFromPdfPoints(841.89, 595.28)).toBe("A4");
    expect(paperFromPdfPoints(419.53, 595.28)).toBe("A5");
    expect(paperFromPdfPoints(612, 792)).toBeNull();
  });
});
```

`tests/unit/auto-layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultOverlayDefinition, overlayGeometryIssues } from "@/lib/rx-render/overlay-definition";
import { autoLayout } from "@/lib/templates/auto-layout";

const page = (ink: (i: number) => boolean, strips = 100) => Array.from({ length: strips }, (_, i) => (ink(i) ? 0.3 : 0.01));

describe("autoLayout", () => {
  it("places the patient strip under the letterhead and the body above the footer", () => {
    const def = autoLayout("A4", page((i) => i < 20 || i >= 92));
    expect(def.boxes.every((b) => b.yMm === 62.4)).toBe(true);
    expect(def.flow.topMm).toBe(72.4);
    expect(def.flow.bottomMm).toBe(26.8);
    expect(overlayGeometryIssues(def, "A4")).toEqual([]);
  });

  it("falls back to the default layout on a blank or unreadable page", () => {
    expect(autoLayout("A5", page(() => false))).toEqual(defaultOverlayDefinition("A5"));
    expect(autoLayout("A5", [])).toEqual(defaultOverlayDefinition("A5"));
  });

  it("never lets a fully printed page squeeze the body below the minimum", () => {
    for (const paper of ["A4", "A5"] as const) expect(overlayGeometryIssues(autoLayout(paper, page(() => true)), paper)).toEqual([]);
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/image-geometry.test.ts tests/unit/auto-layout.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement geometry and auto-layout**

`src/lib/templates/image-geometry.ts`:

```ts
import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import type { PaperSize } from "@/lib/rx-render/types";

export const A_SERIES_RATIO = BACKGROUND_LIMITS.aspect;
export const ASPECT_TOLERANCE = BACKGROUND_LIMITS.aspectTolerance;
/** The client aims well under the server's 2 MB cap: the background is embedded in every printed document. */
export const TARGET_UPLOAD_BYTES = 600 * 1024;
export const JPEG_QUALITIES = [0.8, 0.7, 0.6] as const;

/** Fractions of the (rotated) image to cut from each side. */
export type Crop = { top: number; right: number; bottom: number; left: number };
export const NO_CROP: Crop = { top: 0, right: 0, bottom: 0, left: 0 };

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(0.45, Math.max(0, n)) : 0);

export function clampCrop(c: Crop): Crop {
  return { top: clamp(c.top), right: clamp(c.right), bottom: clamp(c.bottom), left: clamp(c.left) };
}

export function rotatedSize(width: number, height: number, quarterTurns: number): { width: number; height: number } {
  return ((quarterTurns % 4) + 4) % 2 === 0 ? { width, height } : { width: height, height: width };
}

export function cropRect(width: number, height: number, crop: Crop): { x: number; y: number; width: number; height: number } {
  const c = clampCrop(crop);
  return {
    x: Math.round(width * c.left),
    y: Math.round(height * c.top),
    width: Math.max(1, Math.round(width * (1 - c.left - c.right))),
    height: Math.max(1, Math.round(height * (1 - c.top - c.bottom))),
  };
}

/** How far height / width is from the A-series ratio, relative (0.05 = 5 % off); landscape counts as far off. */
export function aspectError(width: number, height: number): number {
  if (width <= 0 || height <= 0 || width > height) return 1;
  return Math.abs(height / width - A_SERIES_RATIO);
}

export function aspectOk(width: number, height: number): boolean {
  return aspectError(width, height) <= ASPECT_TOLERANCE;
}

/** About 200 dpi: sharp on paper, small enough to embed in every print. */
export function targetPixels(paper: PaperSize): { width: number; height: number } {
  return paper === "A4" ? { width: 1654, height: 2339 } : { width: 1165, height: 1654 };
}

const near = (a: number, b: number) => Math.abs(a - b) / b <= 0.02;

/** A4 (595 x 842 pt) or A5 (420 x 595 pt), either orientation; anything else (Letter, legal, custom) is null. */
export function paperFromPdfPoints(widthPt: number, heightPt: number): PaperSize | null {
  const short = Math.min(widthPt, heightPt);
  const long = Math.max(widthPt, heightPt);
  if (near(short, 595.28) && near(long, 841.89)) return "A4";
  if (near(short, 419.53) && near(long, 595.28)) return "A5";
  return null;
}
```

`src/lib/templates/auto-layout.ts`:

```ts
import { defaultOverlayDefinition, overlayGeometryIssues, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { PAPER } from "@/lib/rx-render/paper";
import type { PaperSize } from "@/lib/rx-render/types";

/** A strip darker than this on average holds printed letterhead content. */
const INK = 0.06;
const tenth = (n: number) => Math.round(n * 10) / 10;

/**
 * A first layout from the background's ink (spec section 10.1 step 3): the patient strip goes 3 mm under the last
 * inked strip of the top 40 % of the page (the letterhead), the body runs from under the strip to 3 mm above the
 * first inked strip of the bottom quarter (the footer). `darkness` is one value per horizontal strip, top to bottom
 * (0 white, 1 black). Anything it cannot use gives the default layout; the user adjusts the rest.
 */
export function autoLayout(paper: PaperSize, darkness: readonly number[]): OverlayDefinition {
  const base = defaultOverlayDefinition(paper);
  if (darkness.length < 20) return base;
  const { heightMm } = PAPER[paper];
  const mmPerStrip = heightMm / darkness.length;
  let headerEnd = -1;
  for (let i = 0; i < Math.floor(darkness.length * 0.4); i += 1) if (darkness[i] > INK) headerEnd = i;
  let footerStart = darkness.length;
  for (let i = darkness.length - 1; i >= Math.floor(darkness.length * 0.75); i -= 1) if (darkness[i] > INK) footerStart = i;
  if (headerEnd < 0 && footerStart === darkness.length) return base;
  const stripY = headerEnd >= 0 ? tenth((headerEnd + 1) * mmPerStrip + 3) : base.boxes[0].yMm;
  const rowHeight = base.boxes[0].hMm;
  const def: OverlayDefinition = {
    ...base,
    boxes: base.boxes.map((box) => ({ ...box, yMm: stripY })),
    flow: {
      ...base.flow,
      topMm: tenth(stripY + rowHeight + 3),
      bottomMm: footerStart < darkness.length ? tenth(heightMm - footerStart * mmPerStrip + 3) : base.flow.bottomMm,
    },
  };
  return overlayGeometryIssues(def, paper).length === 0 ? def : base;
}
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/image-geometry.test.ts tests/unit/auto-layout.test.ts`
Expected: PASS (A4: strip 20 ends at 59.4 mm + 3 = 62.4; body top 62.4 + 7 + 3 = 72.4; footer starts at 273.24 mm, so 297 − 273.24 + 3 = 26.76 → 26.8).

- [ ] **Step 4: Write the failing frame-route test**

`tests/unit/pdf-frame-route.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GET } from "@/app/pdf-frame/[asset]/route";

const get = (asset: string) => GET(new Request(`https://clinic.example/pdf-frame/${asset}`), { params: Promise.resolve({ asset }) });

describe("/pdf-frame", () => {
  it("serves the frame as a sandboxed document that may load scripts only from /pdf-frame/", async () => {
    const response = await get("frame.html");
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox allow-scripts;/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("script-src https://clinic.example/pdf-frame/;");
    expect(csp).toContain("connect-src https://clinic.example/pdf-frame/;");
    expect(csp).toContain("frame-ancestors https://clinic.example");
    expect(await response.text()).toContain('<script type="module" src="/pdf-frame/frame.mjs"></script>');
  });

  it("serves pdf.js and the frame script with CORS for the opaque-origin frame", async () => {
    for (const asset of ["frame.mjs", "pdf.mjs", "pdf.worker.mjs"]) {
      const response = await get(asset);
      expect(response.status, asset).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(await (await get("frame.mjs")).text()).toContain("isEvalSupported: false");
  });

  it("serves nothing else", async () => {
    for (const asset of ["index.html", "..%2F..%2Fpackage.json", "pdf.min.mjs", "", "PDF.MJS"]) expect((await get(asset)).status, asset).toBe(404);
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/pdf-frame-route.test.ts`
Expected: FAIL — route missing.

- [ ] **Step 5: Implement the frame assets and route**

`src/server/templates/pdf-frame-assets.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The PDF reader frame (ADR-0046, spec section 6.3): pdf.js runs ONLY inside <iframe sandbox="allow-scripts"> (an
 * opaque origin: no cookies, no storage, no access to the app), with eval off, and answers the parent with a PNG. The
 * server never receives a PDF. The parent (src/lib/templates/pdf-frame-client.ts) validates every reply.
 */
export const FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>PDF reader</title></head><body><script type="module" src="/pdf-frame/frame.mjs"></script></body></html>';

/** The CSP of the frame document. The origin comes from the request (the page that embeds the frame). */
export function frameCsp(origin: string): string {
  const own = `${origin}/pdf-frame/`;
  return `sandbox allow-scripts; default-src 'none'; script-src ${own}; worker-src blob:; connect-src ${own}; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`;
}

/** The frame's own script: one message in ({ type: "render", bytes, page, dpi }), one message out (image or error). */
export const FRAME_SCRIPT = `import * as pdfjs from "./pdf.mjs";
const MAX_SIDE = 3600;
const MAX_PAGES = 50;
async function attachWorker() {
  const source = await (await fetch(new URL("./pdf.worker.mjs", import.meta.url))).text();
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(url, { type: "module" });
}
async function render(bytes, pageNumber, dpi) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false, disableRange: true, disableStream: true, disableAutoFetch: true }).promise;
  try {
    if (doc.numPages > MAX_PAGES) return { type: "error", code: "too_many_pages" };
    const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(dpi / 72, MAX_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return { type: "image", bytes: await blob.arrayBuffer(), width: canvas.width, height: canvas.height, pageCount: doc.numPages, pageSizePt: [base.width, base.height] };
  } finally {
    await doc.destroy();
  }
}
window.addEventListener("message", async (event) => {
  if (event.source !== window.parent) return;
  const m = event.data;
  if (!m || m.type !== "render" || !(m.bytes instanceof ArrayBuffer)) return;
  let reply;
  try {
    reply = await render(m.bytes, Number(m.page) || 1, Number(m.dpi) || 200);
  } catch (error) {
    reply = { type: "error", code: error && error.name === "PasswordException" ? "encrypted" : "unreadable" };
  }
  window.parent.postMessage(reply, "*", reply.bytes ? [reply.bytes] : []);
});
await attachWorker();
window.parent.postMessage({ type: "ready" }, "*");
`;

const PDFJS_DIR = path.join(process.cwd(), "node_modules", "pdfjs-dist", "build");
const cache = new Map<string, string>();

/** One of the two pinned pdf.js builds, read once from node_modules (traced into the build by next.config.ts). */
export function pdfjsFile(name: "pdf.min.mjs" | "pdf.worker.min.mjs"): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = readFileSync(path.join(PDFJS_DIR, name), "utf8");
  cache.set(name, text);
  return text;
}
```

(Write the `FRAME_SCRIPT` exactly as above: it is the S2-tested protocol without the isolation probes. If S2 recorded a worker strategy other than `blob-module`, replace `attachWorker` with the strategy the finding names.)

`src/app/pdf-frame/[asset]/route.ts`:

```ts
import { FRAME_HTML, FRAME_SCRIPT, frameCsp, pdfjsFile } from "@/server/templates/pdf-frame-assets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const JS_HEADERS = {
  "Content-Type": "text/javascript; charset=utf-8",
  // The sandboxed frame has an opaque origin, so its module and worker fetches are cross-origin CORS requests.
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "public, max-age=3600",
};

/** Static, public assets of the PDF reader frame (no session, no data). Anything not listed is 404. */
export async function GET(request: Request, { params }: { params: Promise<{ asset: string }> }): Promise<Response> {
  const { asset } = await params;
  try {
    switch (asset) {
      case "frame.html":
        return new Response(FRAME_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": frameCsp(new URL(request.url).origin),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
          },
        });
      case "frame.mjs":
        return new Response(FRAME_SCRIPT, { headers: JS_HEADERS });
      case "pdf.mjs":
        return new Response(pdfjsFile("pdf.min.mjs"), { headers: JS_HEADERS });
      case "pdf.worker.mjs":
        return new Response(pdfjsFile("pdf.worker.min.mjs"), { headers: JS_HEADERS });
      default:
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
  } catch (error) {
    console.error("pdf frame asset failed", error instanceof Error ? error.name : typeof error);
    return new Response("Unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
```

In `scripts/build-desktop.mjs`, add `"src/app/pdf-frame", // PDF reader frame for Template Studio (server only)` to `SERVER_ONLY` after `"src/app/s"`. In `next.config.ts` add above `nextConfig`:

```ts
const PDFJS_BUILD = ["./node_modules/pdfjs-dist/build/pdf.min.mjs", "./node_modules/pdfjs-dist/build/pdf.worker.min.mjs"];
```

and `"/pdf-frame/**": PDFJS_BUILD,` to `outputFileTracingIncludes`.

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/pdf-frame-route.test.ts`
Expected: PASS.

- [ ] **Step 6: The client side of the frame and the canvas helpers**

`src/lib/templates/pdf-intake.ts`:

```ts
/** From docs/spikes/2026-11-18-s2-pdfjs-frame.md: true unless the finding says NO-GO. */
export const PDF_INTAKE_ENABLED = true;
export const PDF_INTAKE_LIMITS = { maxBytes: 10 * 1024 * 1024, maxPages: 50, timeoutMs: 20_000, dpi: 200 } as const;
```

(Set `dpi` to the S2 finding's `DPI` value.)

`src/lib/templates/pdf-frame-client.ts`:

```ts
import { z } from "zod";
import { PDF_INTAKE_LIMITS } from "./pdf-intake";

export type RasterResult =
  | { ok: true; png: Blob; width: number; height: number; pageCount: number; pageSizePt: [number, number] }
  | { ok: false; code: "too_large" | "too_many_pages" | "encrypted" | "unreadable" | "timeout" };

const reply = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("image"),
    bytes: z.instanceof(ArrayBuffer).refine((b) => b.byteLength > 0 && b.byteLength <= 60 * 1024 * 1024),
    width: z.number().int().min(1).max(3600),
    height: z.number().int().min(1).max(3600),
    pageCount: z.number().int().min(1).max(PDF_INTAKE_LIMITS.maxPages),
    pageSizePt: z.tuple([z.number().positive().max(14400), z.number().positive().max(14400)]),
  }),
  z.object({ type: z.literal("error"), code: z.enum(["too_many_pages", "encrypted", "unreadable"]) }),
]);

/**
 * Renders one page of a PDF to a PNG inside a fresh sandboxed frame (opaque origin) and removes the frame. Only
 * messages from that frame's window, from the opaque origin "null", and of the exact shapes above are accepted.
 * Browser only.
 */
export function rasterizePdfPage(pdf: ArrayBuffer, opts: { page: number; dpi: number; timeoutMs?: number }): Promise<RasterResult> {
  if (pdf.byteLength === 0 || pdf.byteLength > PDF_INTAKE_LIMITS.maxBytes) return Promise.resolve({ ok: false, code: "too_large" });
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "PDF reader";
    Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    let settled = false;
    const finish = (result: RasterResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), opts.timeoutMs ?? PDF_INTAKE_LIMITS.timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== "null") return;
      const message = reply.safeParse(event.data);
      if (!message.success) return finish({ ok: false, code: "unreadable" });
      const data = message.data;
      if (data.type === "ready") {
        const copy = pdf.slice(0);
        frame.contentWindow?.postMessage({ type: "render", bytes: copy, page: opts.page, dpi: opts.dpi }, "*", [copy]);
        return;
      }
      if (data.type === "error") return finish({ ok: false, code: data.code });
      finish({ ok: true, png: new Blob([data.bytes], { type: "image/png" }), width: data.width, height: data.height, pageCount: data.pageCount, pageSizePt: data.pageSizePt });
    };
    window.addEventListener("message", onMessage);
    frame.src = "/pdf-frame/frame.html";
    document.body.appendChild(frame);
  });
}
```

`src/lib/templates/canvas.ts`:

```ts
import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import { cropRect, JPEG_QUALITIES, rotatedSize, TARGET_UPLOAD_BYTES, type Crop } from "./image-geometry";

/** Decodes an image, applying its EXIF orientation (phone photos). Browser only. */
export function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

/** Rotates by quarter turns, crops, and scales into a canvas of exactly `target` pixels on a white background. */
export function drawFitted(bitmap: ImageBitmap, crop: Crop, quarterTurns: number, target: { width: number; height: number }): HTMLCanvasElement {
  const turns = ((quarterTurns % 4) + 4) % 4;
  const rotated = rotatedSize(bitmap.width, bitmap.height, turns);
  const stage = document.createElement("canvas");
  stage.width = rotated.width;
  stage.height = rotated.height;
  const s = stage.getContext("2d");
  if (!s) throw new Error("canvas unavailable");
  s.translate(rotated.width / 2, rotated.height / 2);
  s.rotate((turns * Math.PI) / 2);
  s.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  const r = cropRect(rotated.width, rotated.height, crop);
  const out = document.createElement("canvas");
  out.width = target.width;
  out.height = target.height;
  const o = out.getContext("2d");
  if (!o) throw new Error("canvas unavailable");
  o.fillStyle = "#ffffff";
  o.fillRect(0, 0, out.width, out.height);
  o.imageSmoothingQuality = "high";
  o.drawImage(stage, r.x, r.y, r.width, r.height, 0, 0, out.width, out.height);
  return out;
}

/** Average darkness of `strips` horizontal strips, top to bottom (0 white, 1 black), for autoLayout. */
export function rowDarkness(canvas: HTMLCanvasElement, strips = 100): number[] {
  const small = document.createElement("canvas");
  small.width = 40;
  small.height = strips;
  const ctx = small.getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  const { data } = ctx.getImageData(0, 0, small.width, small.height);
  return Array.from({ length: strips }, (_, y) => {
    let sum = 0;
    for (let x = 0; x < small.width; x += 1) {
      const i = (y * small.width + x) * 4;
      sum += 1 - (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    }
    return sum / small.width;
  });
}

/** A JPEG at the first quality that fits the 600 KB target, or the smallest one under the server's cap; null if none fits. */
export async function encodeForUpload(canvas: HTMLCanvasElement): Promise<Blob | null> {
  let best: Blob | null = null;
  for (const quality of JPEG_QUALITIES) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) continue;
    if (blob.size <= TARGET_UPLOAD_BYTES) return blob;
    if (!best || blob.size < best.size) best = blob;
  }
  return best && best.size <= BACKGROUND_LIMITS.maxBytes ? best : null;
}
```

`tests/helpers/pdfs.ts` (for Task 20's e2e upload):

```ts
/** A valid one-page PDF (correct xref offsets) with a coloured header band and Helvetica text (from spike S2). */
export function minimalPdf(widthPt: number, heightPt: number, label: string): Buffer {
  const content = [
    "0.12 0.25 0.69 rg",
    `0 ${heightPt - 113} ${widthPt} 113 re f`,
    `BT /F1 24 Tf 40 ${heightPt - 70} Td (${label}) Tj ET`,
    `0 0 0 RG 40 ${heightPt - 200} m ${widthPt - 40} ${heightPt - 200} l S`,
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
```

- [ ] **Step 7: The list page and its actions**

`src/app/(app)/templates/page.tsx`:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { requireSession } from "@/server/auth/session";
import { listTemplates } from "@/server/services/templates";
import { listTemplateDoctors } from "@/server/services/template-assign";
import { TemplateList } from "@/components/templates/template-list";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const session = await requireSession();
  if (!can(session.role, "template.read")) redirect("/dashboard");
  const [templates, doctors] = await Promise.all([listTemplates(session), listTemplateDoctors(session)]);
  if (!templates.ok) throw new Error("templates could not be listed");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Pad templates</h1>
          <p className="text-sm text-muted-foreground">Print prescriptions on your own letterhead. Until a pad is published and chosen, the standard ClinicPad pad is used.</p>
        </div>
        {can(session.role, "template.write") ? (
          <Button asChild>
            <Link href="/templates/new">Use my own pad</Link>
          </Button>
        ) : null}
      </div>
      <TemplateList templates={templates.value} doctors={doctors.ok ? doctors.value : []} canArchive={can(session.role, "template.publish")} />
    </div>
  );
}
```

`src/components/templates/template-list.tsx`:

```tsx
import Link from "next/link";
import type { TemplateSummary } from "@/server/services/templates";
import { Badge } from "@/components/ui/badge";
import { TemplateRowActions } from "./template-row-actions";

type Props = { templates: TemplateSummary[]; doctors: { id: string; name: string }[]; canArchive: boolean };

function usedBy(t: TemplateSummary, doctors: Props["doctors"]): string {
  const names = t.assignedDoctorIds.map((id) => doctors.find((d) => d.id === id)?.name ?? "a doctor");
  const parts = [...(t.assignedToClinic ? ["the whole clinic"] : []), ...names];
  return parts.length > 0 ? `Used by ${parts.join(", ")}` : "Not in use";
}

export function TemplateList({ templates, doctors, canArchive }: Props) {
  if (templates.length === 0) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">No pads yet. Upload a photo, scan or PDF of the pad you already use.</p>;
  }
  return (
    <ul className="divide-y rounded-md border" aria-label="Pad templates">
      {templates.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0 space-y-1">
            <Link href={`/templates/${t.id}`} className="font-medium hover:underline">
              {t.name}
            </Link>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {t.status === "archived" ? <Badge variant="secondary">Archived</Badge> : null}
              {t.current ? <Badge>Published v{t.current.version}</Badge> : <Badge variant="outline">Not published</Badge>}
              {t.draft ? <Badge variant="outline">Draft v{t.draft.version}</Badge> : null}
              {t.identity === "bound" ? <span>Letterhead of one doctor</span> : null}
              <span>{usedBy(t, doctors)}</span>
            </div>
          </div>
          {canArchive ? <TemplateRowActions templateId={t.id} archived={t.status === "archived"} inUse={t.assignedToClinic || t.assignedDoctorIds.length > 0} /> : null}
        </li>
      ))}
    </ul>
  );
}
```

`src/components/templates/template-row-actions.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { archiveTemplateAction, unarchiveTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";

export function TemplateRowActions({ templateId, archived, inUse }: { templateId: string; archived: boolean; inUse: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = () =>
    start(async () => {
      const result = archived ? await unarchiveTemplateAction(templateId) : await archiveTemplateAction(templateId);
      setError(result.error ?? null);
    });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={pending || (!archived && inUse)} title={!archived && inUse ? "Choose another pad for the clinic and its doctors first" : undefined}>
        {archived ? "Restore" : "Archive"}
      </Button>
      <p role="status" aria-live="polite" className="text-xs text-destructive">
        {error}
      </p>
    </div>
  );
}
```

- [ ] **Step 8: The wizard**

`src/app/(app)/templates/new/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { PDF_INTAKE_ENABLED } from "@/lib/templates/pdf-intake";
import { requireSession } from "@/server/auth/session";
import { NewTemplateWizard } from "@/components/templates/new-template-wizard";

export const dynamic = "force-dynamic";

export default async function NewTemplatePage() {
  const session = await requireSession();
  if (!can(session.role, "template.write")) redirect("/templates");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Use my own pad</h1>
      <NewTemplateWizard pdfEnabled={PDF_INTAKE_ENABLED} />
    </div>
  );
}
```

`src/components/templates/source-step.tsx`:

```tsx
"use client";

export type Source = "image" | "pdf" | "word" | "concierge";

const OPTIONS: { value: Source; label: string; hint: string }[] = [
  { value: "image", label: "Photo or scan", hint: "A JPEG or PNG of the blank pad. A flat scan works best." },
  { value: "pdf", label: "PDF", hint: "The PDF your printer sent, or a scan saved as PDF." },
  { value: "word", label: "Word file", hint: "Open the pad in Word, choose File, Save As, PDF, then pick PDF here." },
  { value: "concierge", label: "Send it to us", hint: "Send a photo of your pad on WhatsApp or email; we set it up and you check it." },
];

export function SourceStep({ value, onChange, pdfEnabled }: { value: Source | null; onChange: (s: Source) => void; pdfEnabled: boolean }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-lg font-medium">What do you have?</legend>
      {OPTIONS.filter((o) => pdfEnabled || (o.value !== "pdf" && o.value !== "word")).map((option) => (
        <label key={option.value} className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary">
          <input type="radio" name="source" value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span>
            <span className="block font-medium">{option.label}</span>
            <span className="block text-sm text-muted-foreground">{option.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
```

`src/components/templates/file-step.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { PaperSize } from "@/lib/rx-render/types";
import { paperFromPdfPoints } from "@/lib/templates/image-geometry";
import { rasterizePdfPage } from "@/lib/templates/pdf-frame-client";
import { PDF_INTAKE_LIMITS } from "@/lib/templates/pdf-intake";

export type PickedImage = { blob: Blob; proposedPaper: PaperSize };

const IMAGE_LIMIT = 15 * 1024 * 1024; // before the browser shrinks it; the upload itself is at most 2 MB
const PDF_ERRORS: Record<string, string> = {
  too_large: "The PDF is larger than 10 MB. Save page 1 alone as a PDF, or export it as an image.",
  too_many_pages: "The PDF has more than 50 pages. Save only the pad page as a PDF.",
  encrypted: "The PDF is password-protected. Save an unprotected copy, or export the pad page as an image.",
  unreadable: "The PDF could not be read here. Export the pad page as a PNG or JPEG image and upload that instead.",
  timeout: "Reading the PDF took too long. Export the pad page as a PNG or JPEG image and upload that instead.",
};

export function FileStep({ kind, onPicked }: { kind: "image" | "pdf"; onPicked: (picked: PickedImage) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdf, setPdf] = useState<{ bytes: ArrayBuffer; pages: number; page: number } | null>(null);

  async function renderPage(bytes: ArrayBuffer, page: number) {
    setBusy(true);
    const result = await rasterizePdfPage(bytes, { page, dpi: PDF_INTAKE_LIMITS.dpi });
    setBusy(false);
    if (!result.ok) return setError(PDF_ERRORS[result.code]);
    setPdf({ bytes, pages: result.pageCount, page });
    onPicked({ blob: result.png, proposedPaper: paperFromPdfPoints(result.pageSizePt[0], result.pageSizePt[1]) ?? "A4" });
  }

  async function choose(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (kind === "image") {
      // The bytes decide on the server; here only the size is checked so the browser does not try to decode a huge file.
      if (file.size > IMAGE_LIMIT) return setError("The image is larger than 15 MB. Scan at a lower resolution.");
      return onPicked({ blob: file, proposedPaper: "A4" });
    }
    if (file.size > PDF_INTAKE_LIMITS.maxBytes) return setError(PDF_ERRORS.too_large);
    await renderPage(await file.arrayBuffer(), 1);
  }

  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="font-medium">{kind === "image" ? "Choose the photo or scan" : "Choose the PDF"}</span>
        <input type="file" accept={kind === "image" ? "image/png,image/jpeg" : "application/pdf"} onChange={(e) => void choose(e.target.files?.[0])} disabled={busy} />
      </label>
      {pdf && pdf.pages > 1 ? (
        <label className="block space-y-1">
          <span className="text-sm">The pad is on page</span>
          <select value={pdf.page} onChange={(e) => void renderPage(pdf.bytes, Number(e.target.value))} disabled={busy} className="rounded border p-1">
            {Array.from({ length: pdf.pages }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm">
        {busy ? "Reading the PDF…" : null}
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
```

`src/components/templates/fit-step.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PaperSize } from "@/lib/rx-render/types";
import { drawFitted } from "@/lib/templates/canvas";
import { aspectError, aspectOk, ASPECT_TOLERANCE, cropRect, NO_CROP, rotatedSize, targetPixels, type Crop } from "@/lib/templates/image-geometry";
import { Button } from "@/components/ui/button";

export type Fitted = { canvas: HTMLCanvasElement; paper: PaperSize };

const SIDES: (keyof Crop)[] = ["top", "bottom", "left", "right"];

export function FitStep({ bitmap, proposedPaper, onFitted, busy }: { bitmap: ImageBitmap; proposedPaper: PaperSize; onFitted: (f: Fitted) => void; busy: boolean }) {
  const [crop, setCrop] = useState<Crop>(NO_CROP);
  const [turns, setTurns] = useState(0);
  const [paper, setPaper] = useState<PaperSize>(proposedPaper);
  const preview = useRef<HTMLDivElement>(null);
  const rotated = rotatedSize(bitmap.width, bitmap.height, turns);
  const cut = cropRect(rotated.width, rotated.height, crop);
  const ok = aspectOk(cut.width, cut.height);
  const off = Math.round((aspectError(cut.width, cut.height) / 1.414) * 100);

  const canvas = useMemo(() => drawFitted(bitmap, crop, turns, { width: 300, height: Math.round((300 * cut.height) / cut.width) }), [bitmap, crop, turns, cut.width, cut.height]);
  useEffect(() => {
    const host = preview.current;
    if (!host) return;
    canvas.className = "mx-auto block max-h-[60vh] w-auto border shadow";
    host.replaceChildren(canvas);
  }, [canvas]);

  return (
    <div className="space-y-4">
      <div ref={preview} aria-label="Preview of the cropped pad" role="img" />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => setTurns((t) => t - 1)}>
          Rotate left
        </Button>
        <Button type="button" variant="outline" onClick={() => setTurns((t) => t + 1)}>
          Rotate right
        </Button>
      </div>
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="font-medium">Crop to the edges of the pad</legend>
        {SIDES.map((side) => (
          <label key={side} className="flex items-center gap-2 text-sm">
            <span className="w-14 capitalize">{side}</span>
            <input type="range" min={0} max={45} step={0.5} value={crop[side] * 100} onChange={(e) => setCrop((c) => ({ ...c, [side]: Number(e.target.value) / 100 }))} aria-label={`Crop ${side}`} />
          </label>
        ))}
      </fieldset>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Paper size of this pad</span>
        <select value={paper} onChange={(e) => setPaper(e.target.value === "A5" ? "A5" : "A4")} className="rounded border p-1">
          <option value="A4">A4 (210 × 297 mm)</option>
          <option value="A5">A5 (148 × 210 mm)</option>
        </select>
      </label>
      <p role="status" aria-live="polite" className={ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
        {ok
          ? "The proportions fit an A4 or A5 pad."
          : rotated.width > rotated.height
            ? "Rotate the image so the pad stands upright."
            : `Crop to the pad edges: the proportions are about ${off} % away from A4/A5 (at most ${Math.round((ASPECT_TOLERANCE / 1.414) * 100)} % allowed).`}
      </p>
      <Button type="button" disabled={!ok || busy} onClick={() => onFitted({ canvas: drawFitted(bitmap, crop, turns, targetPixels(paper)), paper })}>
        {busy ? "Uploading…" : "Continue"}
      </Button>
    </div>
  );
}
```

`src/components/templates/new-template-wizard.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LabelLanguage, PaperSize } from "@/lib/rx-render/types";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { autoLayout } from "@/lib/templates/auto-layout";
import { encodeForUpload, loadBitmap, rowDarkness } from "@/lib/templates/canvas";
import { createTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileStep, type PickedImage } from "./file-step";
import { FitStep, type Fitted } from "./fit-step";
import { SourceStep, type Source } from "./source-step";

type Uploaded = { fileId: string; paper: PaperSize; definition: OverlayDefinition };

async function upload(blob: Blob): Promise<{ ok: true; fileId: string } | { ok: false; message: string }> {
  try {
    const response = await fetch("/templates/uploads", { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" } });
    const body = (await response.json().catch(() => ({}))) as { fileId?: string; message?: string };
    if (response.ok && typeof body.fileId === "string") return { ok: true, fileId: body.fileId };
    return { ok: false, message: body.message ?? "The pad image could not be uploaded. Try again." };
  } catch {
    return { ok: false, message: "The pad image could not be uploaded. Check the connection and try again." };
  }
}

/** Source, file, fit, name: about two minutes (spec section 10.1 steps 1-3); boxes are adjusted in the editor next. */
export function NewTemplateWizard({ pdfEnabled }: { pdfEnabled: boolean }) {
  const router = useRouter();
  const [source, setSource] = useState<Source | null>(null);
  const [picked, setPicked] = useState<{ bitmap: ImageBitmap; proposedPaper: PaperSize } | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [name, setName] = useState("My pad");
  const [labels, setLabels] = useState<LabelLanguage>("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPicked(p: PickedImage) {
    setError(null);
    try {
      setPicked({ bitmap: await loadBitmap(p.blob), proposedPaper: p.proposedPaper });
    } catch {
      setError("This file could not be opened as an image. Upload a PNG or JPEG.");
    }
  }

  async function onFitted(f: Fitted) {
    setBusy(true);
    setError(null);
    const blob = await encodeForUpload(f.canvas);
    if (!blob) {
      setBusy(false);
      return setError("The pad image is too large even after shrinking it. Crop it more tightly.");
    }
    const result = await upload(blob);
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setUploaded({ fileId: result.fileId, paper: f.paper, definition: autoLayout(f.paper, rowDarkness(f.canvas)) });
  }

  async function create() {
    if (!uploaded) return;
    setBusy(true);
    const result = await createTemplateAction({ name, fileId: uploaded.fileId, paperSize: uploaded.paper, labels, definition: uploaded.definition });
    setBusy(false);
    if (result.ok && result.templateId) return router.push(`/templates/${result.templateId}`);
    setError(result.error ?? "The pad could not be created.");
  }

  return (
    <div className="space-y-6">
      <SourceStep value={source} onChange={(s) => { setSource(s); setPicked(null); setUploaded(null); }} pdfEnabled={pdfEnabled} />
      {source === "word" ? <p className="text-sm">Open your pad in Word, then File → Save As → PDF. Come back and choose “PDF”.</p> : null}
      {source === "concierge" ? <p className="text-sm">Send a clear photo of your blank pad to ClinicPad support on WhatsApp or email. We set it up with sample data; you check it with a real patient and publish it.</p> : null}
      {(source === "image" || source === "pdf") && !picked ? <FileStep kind={source} onPicked={(p) => void onPicked(p)} /> : null}
      {picked && !uploaded ? <FitStep bitmap={picked.bitmap} proposedPaper={picked.proposedPaper} onFitted={(f) => void onFitted(f)} busy={busy} /> : null}
      {uploaded ? (
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="font-medium">Name of this pad</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          <label className="block space-y-1">
            <span className="font-medium">Headings on the prescription</span>
            <select value={labels} onChange={(e) => setLabels(e.target.value === "hi" ? "hi" : e.target.value === "bilingual" ? "bilingual" : "en")} className="rounded border p-1">
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
              <option value="bilingual">English + हिन्दी</option>
            </select>
          </label>
          <Button type="button" onClick={() => void create()} disabled={busy || name.trim() === ""}>
            {busy ? "Creating…" : "Place the boxes"}
          </Button>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm text-destructive">
        {error}
      </p>
    </div>
  );
}
```

- [ ] **Step 9: A component test for the wizard's first steps**

`tests/unit/new-template-wizard.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/actions/templates", () => ({ createTemplateAction: vi.fn() }));

import { NewTemplateWizard } from "@/components/templates/new-template-wizard";

describe("NewTemplateWizard", () => {
  it("offers PDF and Word only when PDF intake is enabled", () => {
    const { unmount } = render(<NewTemplateWizard pdfEnabled />);
    expect(screen.getByRole("radio", { name: /PDF/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Word file/ })).toBeInTheDocument();
    unmount();
    render(<NewTemplateWizard pdfEnabled={false} />);
    expect(screen.queryByRole("radio", { name: /^PDF/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Word file/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Photo or scan/ })).toBeInTheDocument();
  });

  it("asks for an image file for a photo, and explains Save as PDF for Word", () => {
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /Photo or scan/ }));
    expect(screen.getByLabelText("Choose the photo or scan")).toHaveAttribute("accept", "image/png,image/jpeg");
    fireEvent.click(screen.getByRole("radio", { name: /Word file/ }));
    expect(screen.getByText(/Save As → PDF/)).toBeInTheDocument();
  });

  it("refuses an image over 15 MB before decoding it", () => {
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /Photo or scan/ }));
    const big = new File([new Uint8Array(1)], "pad.jpg", { type: "image/jpeg" });
    Object.defineProperty(big, "size", { value: 16 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Choose the photo or scan"), { target: { files: [big] } });
    expect(screen.getByText(/larger than 15 MB/)).toBeInTheDocument();
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/new-template-wizard.test.tsx tests/unit/image-geometry.test.ts tests/unit/auto-layout.test.ts tests/unit/pdf-frame-route.test.ts`
Expected: PASS.

- [ ] **Step 10: Look at it, build both targets, commit**

Start `npm run dev`, sign in as an owner, open `/templates/new`, upload a phone photo of any A4 page and a PDF made by `minimalPdf(595, 842, "TEST")` (save it from a node one-liner into your scratch folder), crop, rotate, continue, name it, and confirm you land on `/templates/<id>` (the editor arrives in Task 17; a 404 or a bare page is expected now). Then:

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }; if ($?) { npm run build:web }; if ($?) { npm run build:desktop }
Set-Location E:\projects\clinicpad; git add package.json package-lock.json scripts/build-desktop.mjs next.config.ts src/server/templates/pdf-frame-assets.ts "src/app/pdf-frame/[asset]/route.ts" src/lib/templates/pdf-intake.ts src/lib/templates/pdf-frame-client.ts src/lib/templates/image-geometry.ts src/lib/templates/auto-layout.ts src/lib/templates/canvas.ts "src/app/(app)/templates/page.tsx" "src/app/(app)/templates/new/page.tsx" src/components/templates/template-list.tsx src/components/templates/template-row-actions.tsx src/components/templates/new-template-wizard.tsx src/components/templates/source-step.tsx src/components/templates/file-step.tsx src/components/templates/fit-step.tsx tests/unit/image-geometry.test.ts tests/unit/auto-layout.test.ts tests/unit/pdf-frame-route.test.ts tests/unit/new-template-wizard.test.tsx tests/helpers/pdfs.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(templates): Template Studio list and new-pad wizard with sandboxed PDF reading" -m "npm audit --omit=dev before: <line>; after: <line>" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: `build:desktop` passes (the new route and `(app)/templates` are stashed).

## Task 17: Template Studio UI 2 — the box editor (drag, keyboard, fonts, body region, overflow warnings, save)

**Files:**
- Create: `src/lib/templates/editor-state.ts`, `src/app/(app)/templates/[id]/page.tsx`, `src/components/templates/template-editor.tsx`, `src/components/templates/box-canvas.tsx`, `src/components/templates/box-inspector.tsx`, `src/components/templates/flow-inspector.tsx`, `src/components/templates/use-overflow-warnings.ts`
- Modify: `src/lib/rx-render/samples.ts` (`SAMPLE_LETTERHEAD`)
- Test: `tests/unit/editor-state.test.ts`, `tests/unit/template-editor.test.tsx`

**Interfaces:**
- Consumes: `getTemplateEditor`, `startTemplateDraftAction`, `saveTemplateDraftAction`, `discardTemplateDraftAction` (Task 15); `TEMPLATE_FIELDS`, `BOX_FIELD_KEYS` (Task 10); `sampleDocument`, `toTemplateData` (Task 10); `OVERLAY_LIMITS`, `SECTION_KEYS`, `type OverlayDefinition`, `type OverlayBox` (Task 11); `PAPER`; `GET /templates/files/<id>` (Task 9).
- Produces:
  - `editor-state.ts`: `type EditorState = { definition: OverlayDefinition; paper: PaperSize; selected: string | null; dirty: boolean }`, `type EditorAction` (union below), `initialEditorState(definition, paper)`, `editorReducer(state, action)`, `nextBoxId(boxes)`, `MOVE_STEP_MM = 1`, `BIG_STEP_MM = 5`.
  - `SAMPLE_LETTERHEAD: RenderSnapshot` (long clinic and doctor values for overflow checks).
  - `overflowingBoxes(boxes, text, measure): Set<string>` (pure, in `use-overflow-warnings.ts`) and `useOverflowWarnings(definition, labels): Set<string>`.
  - `TemplateEditor` props: `{ templateId: string; name: string; fileId: string; paper: PaperSize; labels: LabelLanguage; definition: OverlayDefinition; revision: number; children?: React.ReactNode }` (Task 18 passes the preview/publish/assign panels as `children`; Task 19 adds the print inspector).

- [ ] **Step 1: Write the failing reducer test**

`tests/unit/editor-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { editorReducer, initialEditorState, nextBoxId } from "@/lib/templates/editor-state";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const start = () => initialEditorState(overlayDefinitionSchema.parse(structuredClone(MINIMAL_OVERLAY_DEFINITION)), "A4");

describe("editorReducer", () => {
  it("moves a box by millimetres and keeps it on the page", () => {
    let s = editorReducer(start(), { type: "move", id: "b1", dxMm: 5.04, dyMm: -1 });
    expect(s.definition.boxes[0]).toMatchObject({ xMm: 25, yMm: 51 });
    expect(s.dirty).toBe(true);
    s = editorReducer(s, { type: "move", id: "b1", dxMm: 500, dyMm: 500 });
    expect(s.definition.boxes[0]).toMatchObject({ xMm: 120, yMm: 290 });
    s = editorReducer(s, { type: "move", id: "b1", dxMm: -999, dyMm: -999 });
    expect(s.definition.boxes[0]).toMatchObject({ xMm: 0, yMm: 0 });
  });

  it("resizes within the page and never below 3 mm", () => {
    let s = editorReducer(start(), { type: "resize", id: "b2", dwMm: -100, dhMm: -100 });
    expect(s.definition.boxes[1]).toMatchObject({ wMm: 3, hMm: 3 });
    s = editorReducer(s, { type: "resize", id: "b2", dwMm: 500, dhMm: 0 });
    expect(s.definition.boxes[1].xMm + s.definition.boxes[1].wMm).toBe(210);
  });

  it("keeps boxes out of the page-number band", () => {
    const banded = editorReducer(start(), { type: "options", patch: { pageNumbers: { bandMm: 10 } } });
    const s = editorReducer(banded, { type: "move", id: "b1", dxMm: 0, dyMm: 999 });
    expect(s.definition.boxes[0].yMm + s.definition.boxes[0].hMm).toBe(287);
  });

  it("adds boxes with unique ids up to 30, removes them, and clears the selection", () => {
    let s = start();
    for (let i = 0; i < 40; i += 1) s = editorReducer(s, { type: "add", field: "doctor.name" });
    expect(s.definition.boxes).toHaveLength(30);
    expect(new Set(s.definition.boxes.map((b) => b.id)).size).toBe(30);
    s = editorReducer(s, { type: "select", id: "b1" });
    s = editorReducer(s, { type: "remove", id: "b1" });
    expect(s.selected).toBeNull();
    expect(s.definition.boxes.some((b) => b.id === "b1")).toBe(false);
  });

  it("changes a box's field and font within the limits", () => {
    const s = editorReducer(start(), { type: "set", id: "b1", patch: { field: "patient.age_gender", fontPt: 40, bold: false } });
    expect(s.definition.boxes[0]).toMatchObject({ field: "patient.age_gender", fontPt: 24, bold: false });
  });

  it("keeps the body region at least 40 mm tall and 60 mm wide", () => {
    const s = editorReducer(start(), { type: "flow", patch: { topMm: 280, leftMm: 200 } });
    expect(297 - s.definition.flow.topMm - s.definition.flow.bottomMm).toBeGreaterThanOrEqual(40);
    expect(210 - s.definition.flow.leftMm - s.definition.flow.rightMm).toBeGreaterThanOrEqual(60);
  });

  it("produces definitions the schema accepts, and marks a save", () => {
    let s = editorReducer(start(), { type: "add", field: "clinic.logo" });
    s = editorReducer(s, { type: "move", id: s.definition.boxes[2].id, dxMm: 0.33, dyMm: 0.77 });
    expect(overlayDefinitionSchema.parse(s.definition)).toEqual(s.definition);
    expect(editorReducer(s, { type: "saved" }).dirty).toBe(false);
  });

  it("picks the next free id", () => {
    expect(nextBoxId([{ id: "b1" }, { id: "b3" }, { id: "name" }])).toBe("b4");
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/editor-state.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement the reducer**

`src/lib/templates/editor-state.ts`:

```ts
import type { BoxFieldKey } from "@/lib/rx-render/fields";
import { OVERLAY_LIMITS, type OverlayBox, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { PAPER } from "@/lib/rx-render/paper";
import type { PaperSize } from "@/lib/rx-render/types";

export const MOVE_STEP_MM = 1;
export const BIG_STEP_MM = 5;

export type EditorState = { definition: OverlayDefinition; paper: PaperSize; selected: string | null; dirty: boolean };

type BoxPatch = Partial<Pick<OverlayBox, "field" | "xMm" | "yMm" | "wMm" | "hMm" | "fontPt" | "align" | "bold" | "repeat">>;
type OptionsPatch = Partial<Pick<OverlayDefinition, "background" | "signature" | "pageNumbers" | "printOffsetMm">>;

export type EditorAction =
  | { type: "select"; id: string | null }
  | { type: "add"; field: BoxFieldKey }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; dxMm: number; dyMm: number }
  | { type: "resize"; id: string; dwMm: number; dhMm: number }
  | { type: "set"; id: string; patch: BoxPatch }
  | { type: "flow"; patch: Partial<OverlayDefinition["flow"]> }
  | { type: "options"; patch: OptionsPatch }
  | { type: "replace"; definition: OverlayDefinition }
  | { type: "saved" };

const tenth = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));

export function initialEditorState(definition: OverlayDefinition, paper: PaperSize): EditorState {
  return { definition, paper, selected: null, dirty: false };
}

export function nextBoxId(boxes: readonly { id: string }[]): string {
  const used = boxes.map((b) => /^b(\d+)$/.exec(b.id)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  return `b${Math.max(0, ...used) + 1}`;
}

/** Keeps a box whole on the usable page (above the page-number band) with lengths rounded to 0.1 mm. */
function fit(box: OverlayBox, paper: PaperSize, band: number): OverlayBox {
  const { widthMm: w, heightMm: h } = PAPER[paper];
  const usable = h - band;
  const wMm = tenth(clamp(box.wMm, OVERLAY_LIMITS.minBoxMm, w));
  const hMm = tenth(clamp(box.hMm, OVERLAY_LIMITS.minBoxMm, usable));
  return {
    ...box,
    wMm,
    hMm,
    xMm: tenth(clamp(box.xMm, 0, w - wMm)),
    yMm: tenth(clamp(box.yMm, 0, usable - hMm)),
    fontPt: tenth(clamp(box.fontPt, OVERLAY_LIMITS.minFontPt, OVERLAY_LIMITS.maxFontPt)),
  };
}

function fitFlow(flow: OverlayDefinition["flow"], paper: PaperSize, band: number): OverlayDefinition["flow"] {
  const { widthMm: w, heightMm: h } = PAPER[paper];
  const bottomMm = tenth(clamp(flow.bottomMm, band, h - OVERLAY_LIMITS.minFlowHeightMm));
  const topMm = tenth(clamp(flow.topMm, 0, h - bottomMm - OVERLAY_LIMITS.minFlowHeightMm));
  const leftMm = tenth(clamp(flow.leftMm, 0, w - OVERLAY_LIMITS.minFlowWidthMm));
  const rightMm = tenth(clamp(flow.rightMm, 0, w - leftMm - OVERLAY_LIMITS.minFlowWidthMm));
  return { ...flow, topMm, bottomMm, leftMm, rightMm };
}

function mapBox(state: EditorState, id: string, change: (box: OverlayBox) => OverlayBox): EditorState {
  const band = state.definition.pageNumbers.bandMm;
  const boxes = state.definition.boxes.map((box) => (box.id === id ? fit(change(box), state.paper, band) : box));
  return { ...state, definition: { ...state.definition, boxes }, dirty: true };
}

/** Pure editor state: every change keeps the definition inside overlayDefinitionSchema and the paper. */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const band = state.definition.pageNumbers.bandMm;
  switch (action.type) {
    case "select":
      return { ...state, selected: action.id };
    case "add": {
      if (state.definition.boxes.length >= OVERLAY_LIMITS.maxBoxes) return state;
      const { widthMm, heightMm } = PAPER[state.paper];
      const box = fit(
        { id: nextBoxId(state.definition.boxes), field: action.field, xMm: widthMm * 0.35, yMm: heightMm * 0.3, wMm: widthMm * 0.3, hMm: 7, fontPt: 10, align: "left", bold: false, repeat: "every_page" },
        state.paper,
        band,
      );
      return { ...state, definition: { ...state.definition, boxes: [...state.definition.boxes, box] }, selected: box.id, dirty: true };
    }
    case "remove":
      return {
        ...state,
        definition: { ...state.definition, boxes: state.definition.boxes.filter((b) => b.id !== action.id) },
        selected: state.selected === action.id ? null : state.selected,
        dirty: true,
      };
    case "move":
      return mapBox(state, action.id, (b) => ({ ...b, xMm: b.xMm + action.dxMm, yMm: b.yMm + action.dyMm }));
    case "resize":
      return mapBox(state, action.id, (b) => ({ ...b, wMm: b.wMm + action.dwMm, hMm: b.hMm + action.dhMm }));
    case "set":
      return mapBox(state, action.id, (b) => ({ ...b, ...action.patch }));
    case "flow":
      return { ...state, definition: { ...state.definition, flow: fitFlow({ ...state.definition.flow, ...action.patch }, state.paper, band) }, dirty: true };
    case "options": {
      const definition = { ...state.definition, ...action.patch };
      const nextBand = definition.pageNumbers.bandMm;
      return {
        ...state,
        definition: { ...definition, boxes: definition.boxes.map((b) => fit(b, state.paper, nextBand)), flow: fitFlow(definition.flow, state.paper, nextBand) },
        dirty: true,
      };
    }
    case "replace":
      return { ...state, definition: action.definition, dirty: false };
    case "saved":
      return { ...state, dirty: false };
  }
}
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/editor-state.test.ts`
Expected: PASS. (Moving `b1` (90 × 7 mm) to the far corner stops at x 210 − 90 = 120, y 297 − 7 = 290.)

- [ ] **Step 3: The overflow measurement (pure core plus a hook)**

Append to `src/lib/rx-render/samples.ts`:

```ts
/** Long clinic and doctor values for the editor's overflow warnings (never printed). */
export const SAMPLE_LETTERHEAD: RenderSnapshot = {
  v: 2,
  takenAt: "2026-11-18T05:30:00.000Z",
  patient: { name: "", patientNo: null, gender: null, dob: null, ageLabel: "", allergies: [] },
  clinic: {
    name: "Shri Annapurna Multispeciality Clinic and Diagnostic Centre",
    addressLines: ["Shop 4-5, Ground Floor, Sai Krupa Complex, Near Railway Station Road", "Kalyan (West), Thane, Maharashtra - 421301"],
    phone: "0251-2345678, 98765 43210",
    email: "appointments@annapurnaclinic.example",
    footerLines: ["Mon-Sat 10 am to 1 pm and 5 pm to 9 pm · Sunday closed"],
    logoAssetId: null,
    timezone: "Asia/Kolkata",
  },
  doctor: {
    name: "Dr. Venkataraman Subramaniam Ramachandran",
    qualifications: "MBBS, MD (General Medicine), DNB (Cardiology), FACC",
    designation: "Senior Consultant Physician and Cardiologist",
    registrationNo: "MMC 2011/04/123456",
    registrationCouncil: "Maharashtra Medical Council",
    signatureAssetId: null,
  },
  layout: { template: { kind: "builtin", key: "general" }, paperSize: "A4", labels: "en" },
};
```

`src/components/templates/use-overflow-warnings.ts`:

```ts
"use client";

import { useEffect, useMemo, useState } from "react";
import type { TextFieldKey } from "@/lib/rx-render/fields";
import type { OverlayBox, OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { SAMPLE_LETTERHEAD, sampleDocument } from "@/lib/rx-render/samples";
import { toTemplateData } from "@/lib/rx-render/template-data";
import type { LabelLanguage } from "@/lib/rx-render/types";

const PX_PER_MM = 96 / 25.4;

/** The ids of boxes whose long sample text does not fit; `measure` answers "does this text overflow this box?". */
export function overflowingBoxes(boxes: readonly OverlayBox[], text: Partial<Record<string, string>>, measure: (box: OverlayBox, value: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const box of boxes) {
    const value = text[box.field];
    if (typeof value === "string" && value !== "" && measure(box, value)) out.add(box.id);
  }
  return out;
}

/** Live overflow warnings with the long sample (spec section 6.4), measured in the same embedded font as the print. */
export function useOverflowWarnings(definition: OverlayDefinition, labels: LabelLanguage): Set<string> {
  const text = useMemo<Record<TextFieldKey, string>>(() => toTemplateData(sampleDocument("long", { ...SAMPLE_LETTERHEAD, layout: { ...SAMPLE_LETTERHEAD.layout, labels } }), labels).text, [labels]);
  const [warnings, setWarnings] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const probe = document.createElement("div");
    Object.assign(probe.style, { position: "absolute", left: "-10000px", top: "0", visibility: "hidden", fontFamily: '"Noto Sans Devanagari", sans-serif', lineHeight: "1.2", overflowWrap: "anywhere", whiteSpace: "pre-line" });
    document.body.appendChild(probe);
    const measure = (box: OverlayBox, value: string) => {
      probe.style.width = `${box.wMm * PX_PER_MM}px`;
      probe.style.height = `${box.hMm * PX_PER_MM}px`;
      probe.style.fontSize = `${(box.fontPt * 4) / 3}px`;
      probe.style.fontWeight = box.bold ? "700" : "400";
      probe.textContent = value;
      return probe.scrollHeight > probe.clientHeight + 1 || probe.scrollWidth > probe.clientWidth + 1;
    };
    void document.fonts.ready.then(() => {
      if (!cancelled) setWarnings(overflowingBoxes(definition.boxes, text, measure));
    });
    return () => {
      cancelled = true;
      probe.remove();
    };
  }, [definition.boxes, text]);
  return warnings;
}
```

(The editor page imports `@fontsource/noto-sans-devanagari/400.css` and `700.css`, so the probe measures with the font the pad prints in.)

- [ ] **Step 4: The canvas, the inspectors, and the editor**

`src/components/templates/box-canvas.tsx`:

```tsx
"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { TEMPLATE_FIELDS } from "@/lib/rx-render/fields";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { PAPER } from "@/lib/rx-render/paper";
import type { PaperSize } from "@/lib/rx-render/types";
import { BIG_STEP_MM, MOVE_STEP_MM, type EditorAction } from "@/lib/templates/editor-state";

type Props = {
  fileId: string;
  paper: PaperSize;
  definition: OverlayDefinition;
  selected: string | null;
  warnings: Set<string>;
  dispatch: (action: EditorAction) => void;
};

const pct = (mm: number, total: number) => `${(mm / total) * 100}%`;

/**
 * The pad with its boxes. Drag a box with the pointer, or focus it and use the arrow keys (Shift: 5 mm; Alt: resize;
 * Delete: remove). Every change goes through the reducer, which keeps boxes on the page.
 */
export function BoxCanvas({ fileId, paper, definition, selected, warnings, dispatch }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; y: number } | null>(null);
  const { widthMm, heightMm } = PAPER[paper];
  const mmPerPx = () => widthMm / (host.current?.clientWidth || 1);

  function onPointerDown(event: PointerEvent<HTMLDivElement>, id: string) {
    dispatch({ type: "select", id });
    drag.current = { id, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const scale = mmPerPx();
    dispatch({ type: "move", id: d.id, dxMm: (event.clientX - d.x) * scale, dyMm: (event.clientY - d.y) * scale });
    drag.current = { ...d, x: event.clientX, y: event.clientY };
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, id: string) {
    const step = event.shiftKey ? BIG_STEP_MM : MOVE_STEP_MM;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (event.key in delta) {
      event.preventDefault();
      const [dx, dy] = delta[event.key];
      dispatch(event.altKey ? { type: "resize", id, dwMm: dx, dhMm: dy } : { type: "move", id, dxMm: dx, dyMm: dy });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ type: "remove", id });
    } else if (event.key === "Escape") {
      dispatch({ type: "select", id: null });
    }
  }

  const flow = definition.flow;
  return (
    <div ref={host} className="relative w-full select-none overflow-hidden border bg-white shadow" style={{ aspectRatio: `${widthMm} / ${heightMm}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a private, same-origin image route; next/image would proxy it */}
      <img src={`/templates/files/${fileId}`} alt="" className="absolute inset-0 h-full w-full object-cover object-top" draggable={false} />
      <div
        aria-hidden="true"
        className="absolute border-2 border-dashed border-sky-500/70 bg-sky-100/20"
        style={{ left: pct(flow.leftMm, widthMm), right: pct(flow.rightMm, widthMm), top: pct(flow.topMm, heightMm), bottom: pct(flow.bottomMm, heightMm) }}
      >
        <span className="m-1 inline-block rounded bg-sky-600 px-1 text-[10px] text-white">Prescription body</span>
      </div>
      {definition.boxes.map((box) => {
        const label = TEMPLATE_FIELDS[box.field].en;
        const warn = warnings.has(box.id);
        return (
          <div
            key={box.id}
            role="button"
            tabIndex={0}
            aria-pressed={selected === box.id}
            aria-label={`${label} box at ${box.xMm} by ${box.yMm} mm, ${box.wMm} by ${box.hMm} mm${warn ? ", long values may not fit" : ""}`}
            onPointerDown={(e) => onPointerDown(e, box.id)}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onKeyDown={(e) => onKeyDown(e, box.id)}
            onFocus={() => dispatch({ type: "select", id: box.id })}
            className={`absolute cursor-move touch-none overflow-hidden border text-[10px] leading-tight outline-none focus-visible:ring-2 ${selected === box.id ? "border-primary bg-primary/15" : "border-amber-600 bg-amber-100/40"} ${warn ? "border-destructive" : ""}`}
            style={{ left: pct(box.xMm, widthMm), top: pct(box.yMm, heightMm), width: pct(box.wMm, widthMm), height: pct(box.hMm, heightMm) }}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}
```

`src/components/templates/box-inspector.tsx`:

```tsx
"use client";

import { BOX_FIELD_KEYS, TEMPLATE_FIELDS, type BoxFieldKey } from "@/lib/rx-render/fields";
import type { OverlayBox } from "@/lib/rx-render/overlay-definition";
import type { EditorAction } from "@/lib/templates/editor-state";
import { Button } from "@/components/ui/button";

const GROUPS = ["patient", "visit", "doctor", "clinic", "vitals", "clinical"] as const;
const num = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

export function BoxInspector({ box, warn, dispatch }: { box: OverlayBox; warn: boolean; dispatch: (a: EditorAction) => void }) {
  const set = (patch: Partial<OverlayBox>) => dispatch({ type: "set", id: box.id, patch });
  const length = (key: "xMm" | "yMm" | "wMm" | "hMm", label: string) => (
    <label className="flex flex-col text-xs">
      {label}
      <input type="number" step={0.5} value={box[key]} onChange={(e) => Number.isFinite(num(e.target.value)) && set({ [key]: num(e.target.value) })} className="rounded border p-1" />
    </label>
  );
  return (
    <section aria-label="Selected box" className="space-y-3 rounded-md border p-3">
      <label className="flex flex-col text-sm">
        Prints
        <select value={box.field} onChange={(e) => set({ field: e.target.value as BoxFieldKey })} className="rounded border p-1">
          {GROUPS.map((group) => (
            <optgroup key={group} label={group[0].toUpperCase() + group.slice(1)}>
              {BOX_FIELD_KEYS.filter((k) => TEMPLATE_FIELDS[k].group === group).map((k) => (
                <option key={k} value={k}>
                  {TEMPLATE_FIELDS[k].en}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-4 gap-2">
        {length("xMm", "Left (mm)")}
        {length("yMm", "Top (mm)")}
        {length("wMm", "Width")}
        {length("hMm", "Height")}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs">
          Size (pt)
          <input type="number" min={6} max={24} step={0.5} value={box.fontPt} onChange={(e) => Number.isFinite(num(e.target.value)) && set({ fontPt: num(e.target.value) })} className="w-20 rounded border p-1" />
        </label>
        <label className="flex flex-col text-xs">
          Align
          <select value={box.align} onChange={(e) => set({ align: e.target.value === "center" ? "center" : e.target.value === "right" ? "right" : "left" })} className="rounded border p-1">
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={box.bold} onChange={(e) => set({ bold: e.target.checked })} /> Bold
        </label>
        <label className="flex flex-col text-xs">
          On
          <select value={box.repeat} onChange={(e) => set({ repeat: e.target.value === "first_page" ? "first_page" : "every_page" })} className="rounded border p-1">
            <option value="every_page">Every page</option>
            <option value="first_page">First page only</option>
          </select>
        </label>
      </div>
      {warn ? <p className="text-xs text-destructive">A long value does not fit this box: it will print past its edge. Make the box bigger or the text smaller.</p> : null}
      <Button type="button" variant="outline" size="sm" onClick={() => dispatch({ type: "remove", id: box.id })}>
        Remove box
      </Button>
    </section>
  );
}
```

`src/components/templates/flow-inspector.tsx`:

```tsx
"use client";

import type { LabelLanguage } from "@/lib/rx-render/types";
import { SECTION_KEYS, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { SectionKey } from "@/lib/rx-render/templates";
import type { EditorAction } from "@/lib/templates/editor-state";

const SECTION_LABELS: Record<SectionKey, string> = {
  vitals: "Vitals", chiefComplaint: "Chief complaint", complaints: "Complaints", medicalHistory: "Medical history", drugHistory: "Drug history",
  examination: "Examination", diagnosis: "Diagnosis", medicines: "Medicines", investigations: "Tests", advice: "Advice", followUp: "Follow-up",
};
const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

type Props = { definition: OverlayDefinition; labels: LabelLanguage; onLabels: (l: LabelLanguage) => void; dispatch: (a: EditorAction) => void };

export function FlowInspector({ definition, labels, onLabels, dispatch }: Props) {
  const flow = definition.flow;
  const inset = (key: "topMm" | "bottomMm" | "leftMm" | "rightMm", label: string) => (
    <label className="flex flex-col text-xs">
      {label}
      <input type="number" step={0.5} value={flow[key]} onChange={(e) => Number.isFinite(num(e.target.value)) && dispatch({ type: "flow", patch: { [key]: num(e.target.value) } })} className="rounded border p-1" />
    </label>
  );
  const toggle = (key: SectionKey, on: boolean) => {
    const next = on ? SECTION_KEYS.filter((k) => k === key || flow.sections.includes(k)) : flow.sections.filter((k) => k !== key);
    if (next.length > 0) dispatch({ type: "flow", patch: { sections: next } });
  };
  return (
    <section aria-label="Prescription body" className="space-y-3 rounded-md border p-3">
      <h2 className="text-sm font-medium">Prescription body (blue area)</h2>
      <div className="grid grid-cols-4 gap-2">
        {inset("topMm", "From top")}
        {inset("bottomMm", "From bottom")}
        {inset("leftMm", "From left")}
        {inset("rightMm", "From right")}
      </div>
      <label className="flex flex-col text-xs">
        Style of the medicine table
        <select value={flow.bodyStyle} onChange={(e) => dispatch({ type: "flow", patch: { bodyStyle: e.target.value === "paediatric" ? "paediatric" : e.target.value === "derma" ? "derma" : "general" } })} className="rounded border p-1">
          <option value="general">General (morning, noon, evening, night)</option>
          <option value="paediatric">Paediatric (dose and schedule)</option>
          <option value="derma">Dermatology (how to use)</option>
        </select>
      </label>
      <fieldset className="grid grid-cols-2 gap-1 text-xs">
        <legend className="mb-1 font-medium">Print these sections</legend>
        {SECTION_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-1">
            <input type="checkbox" checked={flow.sections.includes(key)} onChange={(e) => toggle(key, e.target.checked)} /> {SECTION_LABELS[key]}
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={flow.showRxMark} onChange={(e) => dispatch({ type: "flow", patch: { showRxMark: e.target.checked } })} /> Print the ℞ mark
      </label>
      <fieldset className="space-y-1 text-xs">
        <legend className="font-medium">Signature</legend>
        <label className="flex items-center gap-1">
          <input type="radio" name="sig" checked={definition.signature.mode === "end_of_content"} onChange={() => dispatch({ type: "options", patch: { signature: { mode: "end_of_content" } } })} /> After the prescription, with the doctor&apos;s name and registration
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="sig"
            checked={definition.signature.mode === "box"}
            disabled={!definition.boxes.some((b) => b.field === "doctor.signature")}
            onChange={() => dispatch({ type: "options", patch: { signature: { mode: "box" } } })}
          />{" "}
          In my signature box (add a “Signature” box first)
        </label>
      </fieldset>
      <label className="flex flex-col text-xs">
        Page numbers
        <select value={definition.pageNumbers.bandMm} onChange={(e) => dispatch({ type: "options", patch: { pageNumbers: { bandMm: Number(e.target.value) } } })} className="rounded border p-1">
          <option value={0}>Off (most pads are one page)</option>
          <option value={8}>On, in a blank 8 mm strip at the bottom</option>
          <option value={12}>On, in a blank 12 mm strip at the bottom</option>
        </select>
      </label>
      <label className="flex flex-col text-xs">
        Headings
        <select value={labels} onChange={(e) => onLabels(e.target.value === "hi" ? "hi" : e.target.value === "bilingual" ? "bilingual" : "en")} className="rounded border p-1">
          <option value="en">English</option>
          <option value="hi">हिन्दी</option>
          <option value="bilingual">English + हिन्दी</option>
        </select>
      </label>
    </section>
  );
}
```

`src/components/templates/template-editor.tsx`:

```tsx
"use client";

import "@fontsource/noto-sans-devanagari/400.css";
import "@fontsource/noto-sans-devanagari/700.css";
import { useEffect, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { BOX_FIELD_KEYS, TEMPLATE_FIELDS, type BoxFieldKey } from "@/lib/rx-render/fields";
import { OVERLAY_LIMITS, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { LabelLanguage, PaperSize } from "@/lib/rx-render/types";
import { editorReducer, initialEditorState } from "@/lib/templates/editor-state";
import { discardTemplateDraftAction, saveTemplateDraftAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";
import { BoxCanvas } from "./box-canvas";
import { BoxInspector } from "./box-inspector";
import { FlowInspector } from "./flow-inspector";
import { useOverflowWarnings } from "./use-overflow-warnings";

type Props = {
  templateId: string;
  name: string;
  fileId: string;
  paper: PaperSize;
  labels: LabelLanguage;
  definition: OverlayDefinition;
  revision: number;
  /** Preview, publish and assign panels (Task 18), shown under the editor; they read only saved drafts. */
  children?: React.ReactNode;
};

export function TemplateEditor({ templateId, name, fileId, paper, labels: initialLabels, definition, revision: initialRevision, children }: Props) {
  const router = useRouter();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState(definition, paper));
  const [labels, setLabels] = useState(initialLabels);
  const [labelsDirty, setLabelsDirty] = useState(false);
  const [revision, setRevision] = useState(initialRevision);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addField, setAddField] = useState<BoxFieldKey>("doctor.name");
  const warnings = useOverflowWarnings(state.definition, labels);
  const dirty = state.dirty || labelsDirty;
  const selected = state.definition.boxes.find((b) => b.id === state.selected) ?? null;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setSaving(true);
    setMessage(null);
    const result = await saveTemplateDraftAction(templateId, { definition: state.definition, labels, baseRevision: revision });
    setSaving(false);
    if (result.ok && typeof result.revision === "number") {
      setRevision(result.revision);
      dispatch({ type: "saved" });
      setLabelsDirty(false);
      setMessage("Saved.");
      router.refresh();
    } else {
      setMessage(result.currentRevision !== undefined ? `${result.error} (Reload the page.)` : (result.error ?? "Could not save."));
    }
  }

  async function discard() {
    const result = await discardTemplateDraftAction(templateId);
    if (result.ok) router.push("/templates");
    else setMessage(result.error ?? "Could not discard the draft.");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{name}</h1>
        <div className="flex gap-2">
          <Button type="button" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "Saving…" : dirty ? "Save draft" : "Saved"}
          </Button>
          <Button type="button" variant="outline" onClick={() => void discard()}>
            Discard draft
          </Button>
        </div>
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <BoxCanvas fileId={fileId} paper={paper} definition={state.definition} selected={state.selected} warnings={warnings} dispatch={dispatch} />
        <div className="space-y-4">
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col text-xs">
              Add a box for
              <select value={addField} onChange={(e) => setAddField(e.target.value as BoxFieldKey)} className="rounded border p-1">
                {BOX_FIELD_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {TEMPLATE_FIELDS[k].en}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" disabled={state.definition.boxes.length >= OVERLAY_LIMITS.maxBoxes} onClick={() => dispatch({ type: "add", field: addField })}>
              Add
            </Button>
          </div>
          {selected ? <BoxInspector box={selected} warn={warnings.has(selected.id)} dispatch={dispatch} /> : <p className="text-sm text-muted-foreground">Select a box to change it, or drag it on the pad. Arrow keys move a selected box.</p>}
          <FlowInspector definition={state.definition} labels={labels} onLabels={(l) => { setLabels(l); setLabelsDirty(true); }} dispatch={dispatch} />
        </div>
      </div>
      {dirty ? <p className="text-sm text-muted-foreground">Save the draft to preview or publish these changes.</p> : null}
      {children}
    </div>
  );
}
```

`src/app/(app)/templates/[id]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { requireSession } from "@/server/auth/session";
import { startTemplateDraftAction } from "@/server/actions/templates";
import { getTemplateEditor } from "@/server/services/templates";
import { TemplateEditor } from "@/components/templates/template-editor";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!can(session.role, "template.read")) redirect("/dashboard");
  const { id } = await params;
  const view = await getTemplateEditor(session, id);
  if (!view.ok) notFound();
  const { summary, draft } = view.value;
  if (!draft) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">{summary.name}</h1>
        <p className="text-sm text-muted-foreground">{summary.current ? `Published version ${summary.current.version}.` : "Nothing published yet."}</p>
        {summary.canWrite && summary.status === "active" ? (
          <form action={async () => { "use server"; await startTemplateDraftAction(id); }}>
            <Button type="submit">Edit this pad</Button>
          </form>
        ) : null}
      </div>
    );
  }
  return (
    <TemplateEditor templateId={id} name={summary.name} fileId={draft.fileId} paper={draft.paperSize} labels={draft.labels} definition={draft.definition} revision={draft.revision} />
  );
}
```

- [ ] **Step 5: A component test for keyboard editing and saving**

`tests/unit/template-editor.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const save = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/templates", () => ({ saveTemplateDraftAction: save, discardTemplateDraftAction: vi.fn() }));
vi.mock("@fontsource/noto-sans-devanagari/400.css", () => ({}));
vi.mock("@fontsource/noto-sans-devanagari/700.css", () => ({}));

import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { TemplateEditor } from "@/components/templates/template-editor";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
const definition = overlayDefinitionSchema.parse(structuredClone(MINIMAL_OVERLAY_DEFINITION));
const editor = () => render(<TemplateEditor templateId="t1" name="My pad" fileId="f1" paper="A4" labels="en" definition={definition} revision={3} />);

describe("TemplateEditor", () => {
  it("moves the focused box with the arrow keys, 5 mm with Shift, and announces its position", () => {
    editor();
    const box = screen.getByRole("button", { name: /Patient's name box at 20 by 52 mm/ });
    fireEvent.keyDown(box, { key: "ArrowRight" });
    fireEvent.keyDown(box, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByRole("button", { name: /Patient's name box at 21 by 57 mm/ })).toBeInTheDocument();
  });

  it("removes a box with Delete and adds one from the picker", () => {
    editor();
    fireEvent.keyDown(screen.getByRole("button", { name: /Date box/ }), { key: "Delete" });
    expect(screen.queryByRole("button", { name: /Date box/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Add a box for"), { target: { value: "visit.rx_no" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("button", { name: /Rx no\. \(blank on drafts\) box/ })).toBeInTheDocument();
  });

  it("saves with the revision it loaded, then the next one", async () => {
    save.mockResolvedValueOnce({ ok: true, revision: 4 }).mockResolvedValueOnce({ ok: true, revision: 5 });
    editor();
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("t1", expect.objectContaining({ baseRevision: 3, labels: "en" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled());
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith("t1", expect.objectContaining({ baseRevision: 4 })));
  });

  it("tells the user to reload on a revision conflict", async () => {
    save.mockResolvedValueOnce({ error: "This pad was changed in another window. Reload to see the latest version.", currentRevision: 9 });
    editor();
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowUp" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/another window.*Reload the page/)).toBeInTheDocument();
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/editor-state.test.ts tests/unit/template-editor.test.tsx`
Expected: PASS.

- [ ] **Step 6: Try it, then commit**

With `npm run dev`, open the pad created in Task 16: drag boxes, move one with the keyboard only (Tab to it, arrows, Shift+arrows, Alt+arrows, Delete), make a box narrow and see the overflow warning, save, reload, and see the change kept. Then:

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/templates/editor-state.ts src/lib/rx-render/samples.ts "src/app/(app)/templates/[id]/page.tsx" src/components/templates/template-editor.tsx src/components/templates/box-canvas.tsx src/components/templates/box-inspector.tsx src/components/templates/flow-inspector.tsx src/components/templates/use-overflow-warnings.ts tests/unit/editor-state.test.ts tests/unit/template-editor.test.tsx
Set-Location E:\projects\clinicpad; git commit -m "feat(templates): box editor with drag, keyboard moves, fonts, body region and overflow warnings" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 18: Previews (sample, long, blank, real patient), publish, assign, and version history

**Files:**
- Create: `src/server/services/template-preview.ts`, `src/app/(app)/templates/[id]/preview/route.ts`, `src/components/templates/preview-panel.tsx`, `src/components/templates/publish-panel.tsx`, `src/components/templates/assign-panel.tsx`, `src/components/templates/version-history.tsx`
- Modify: `src/app/(app)/templates/[id]/page.tsx` (panels as `children`, and for templates without a draft)
- Test: `tests/integration/template-preview-route.test.ts`, `tests/unit/publish-panel.test.tsx`, `tests/unit/assign-panel.test.tsx`

**Interfaces:**
- Consumes: `buildRenderSnapshot` (`render-snapshot.ts`), `loadRxDocumentIn` (`rx-documents.ts`), `loadImageAssets`, `assetKey` (`assets.ts`), `loadTemplateFileIn`, `fileAsImageAsset` (Task 9), `parseOverlayDefinition` (Task 11), `sampleDocument`, `SAMPLE_LETTERHEAD` (Tasks 10, 17), `renderPrescription` (Task 13), `checkSelfContained`, `loadFontCss`, `getPdfEngine`, `renderLimiter`, `publishTemplateAction`, `assignTemplateAction`, `rollbackTemplateAction` (Task 15), `overlayPublishIssues` (Task 11).
- Produces:
  - `type PreviewSource = { kind: "sample"; sample: SampleKind } | { kind: "patient"; prescriptionId: string }`; `renderTemplatePreview(ctx, templateId, input: { source: PreviewSource; versionId?: string | null; format: "html" | "pdf" }, deps?: { engine?: PdfEngine; limiter?: Limiter; signal?: AbortSignal }): Promise<Result<{ format: "html"; html: string } | { format: "pdf"; pdf: ArrayBuffer }>>`; `listPreviewPrescriptions(ctx): Promise<Result<PreviewPrescription[]>>` with `PreviewPrescription = { id: string; label: string }`.
  - `GET /templates/<id>/preview?sample=short|long|blank` or `?prescriptionId=<uuid>`, optional `&version=<uuid>`, `&format=pdf`.
- Rules: previews never write `prescription_outputs`; a sample preview is not audited; a real-patient preview needs `rx.read` (so never a designer), always renders as a draft (watermark, no Rx number, no signature) and audits `template.previewed_with_patient` with ids only.

- [ ] **Step 1: Write the failing route test**

`tests/integration/template-preview-route.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/pdf", async () => {
  const { sharedFakeEngine } = await import("../helpers/fake-pdf-engine");
  return { getPdfEngine: () => sharedFakeEngine };
});

import { getSessionContext } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { auditEvents, prescriptionOutputs } from "@/server/db/schema";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { newId } from "@/lib/domain/ids";
import { GET } from "@/app/(app)/templates/[id]/preview/route";
import { resetFakeEngine, sharedFakeEngine } from "../helpers/fake-pdf-engine";
import { finalized, newPatient } from "../helpers/rx-flow";
import { insertPublishedOverlay, insertTemplate } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
let A: TestTenant;
let B: TestTenant;
let templateId = "";
let rxId = "";
let foreignRx = "";

const preview = (id: string, query: string) => GET(new Request(`http://localhost/templates/${id}/preview?${query}`), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  A = await createTestTenant("tpl-preview-a");
  B = await createTestTenant("tpl-preview-b");
  templateId = (await insertPublishedOverlay(A.tenantId)).templateId;
  rxId = await finalized(A.as("doctor"), await newPatient(A.as("reception"), "Preview Patient आशा"));
  foreignRx = await finalized(B.as("doctor"), await newPatient(B.as("reception"), "Other Clinic Patient"));
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});
beforeEach(() => {
  resetFakeEngine(sharedFakeEngine);
  session.mockResolvedValue(A.as("owner"));
});

describe("GET /templates/<id>/preview", () => {
  it("renders a self-contained sample preview marked SAMPLE, and logs nothing", async () => {
    const response = await preview(templateId, "sample=long");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(checkSelfContained(html)).toEqual({ ok: true });
    expect(html).toContain("SAMPLE · NOT A PRESCRIPTION");
    expect(html).toContain('<table class="flow">');
    expect(await adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "template.previewed_with_patient")))).toHaveLength(0);
  });

  it("previews a real patient as a draft (no Rx number, no signature) and audits ids only", async () => {
    const response = await preview(templateId, `prescriptionId=${rxId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("DRAFT · NOT VALID FOR DISPENSING");
    expect(html).toContain("Preview Patient");
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "template.previewed_with_patient")));
    expect(event.after).toEqual({ templateId, templateVersionId: expect.any(String), prescriptionId: rxId });
    expect(JSON.stringify(event)).not.toContain("Preview Patient");
    expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.prescriptionId, rxId))).toHaveLength(0);
  });

  it("never lets a designer see a patient, but lets them see samples", async () => {
    session.mockResolvedValue({ tenantId: A.tenantId, userId: newId(), role: "designer" });
    expect((await preview(templateId, `prescriptionId=${rxId}`)).status).toBe(404);
    expect((await preview(templateId, "sample=short")).status).toBe(200);
  });

  it("answers 404 for roles without template.read, another clinic's template or prescription, and a foreign version", async () => {
    session.mockResolvedValue(A.as("reception"));
    expect((await preview(templateId, "sample=short")).status).toBe(404);
    session.mockResolvedValue(B.as("owner"));
    expect((await preview(templateId, "sample=short")).status).toBe(404);
    session.mockResolvedValue(A.as("owner"));
    expect((await preview(templateId, `prescriptionId=${foreignRx}`)).status).toBe(404);
    const other = await insertTemplate(A.tenantId);
    expect((await preview(templateId, `sample=short&version=${other.versionId}`)).status).toBe(404);
    expect((await preview(templateId, "sample=huge")).status).toBe(404);
  });

  it("renders a PDF preview through the engine, inline", async () => {
    const response = await preview(templateId, "sample=blank&format=pdf");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(sharedFakeEngine.calls).toHaveLength(1);
  });

  it("refuses cross-site requests", async () => {
    const response = await GET(new Request(`http://localhost/templates/${templateId}/preview?sample=short`, { headers: { "sec-fetch-site": "cross-site" } }), {
      params: Promise.resolve({ id: templateId }),
    });
    expect(response.status).toBe(403);
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-preview-route.test.ts`
Expected: FAIL — the route does not exist.

- [ ] **Step 2: Implement the preview service**

`src/server/services/template-preview.ts`:

```ts
import { and, desc, eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid, newId } from "@/lib/domain/ids";
import { fail, ok, type Result } from "@/lib/result";
import { parseOverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { renderPrescription } from "@/lib/rx-render/render";
import { SAMPLE_LETTERHEAD, sampleDocument, type SampleKind } from "@/lib/rx-render/samples";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { LABEL_LANGUAGES, PAPER_SIZES, pickOption, type ImageAsset, type OverlayInput, type PadLayout, type RxDocument } from "@/lib/rx-render/types";
import { patients, prescriptions, templates, templateVersions, visits } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { getPdfEngine } from "@/server/pdf";
import type { PdfEngine } from "@/server/pdf/engine";
import { renderLimiter, type Limiter } from "@/server/pdf/limiter";
import { loadFontCss } from "@/server/rx-render/fonts";
import { assetKey, loadImageAssets } from "./assets";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { buildRenderSnapshot } from "./render-snapshot";
import { loadRxDocumentIn } from "./rx-documents";
import { BUSY_MESSAGE } from "./rx-output";
import { TEMPLATE_NOT_FOUND } from "./template-access";
import { fileAsImageAsset, loadTemplateFileIn } from "./template-files";

export type PreviewSource = { kind: "sample"; sample: SampleKind } | { kind: "patient"; prescriptionId: string };
export type PreviewResult = { format: "html"; html: string } | { format: "pdf"; pdf: ArrayBuffer };
export type PreviewPrescription = { id: string; label: string };
type Prepared = { doc: RxDocument; logo: ImageAsset | null; overlay: OverlayInput };

const NOT_FOUND = () => fail("not_found", TEMPLATE_NOT_FOUND);
const ZERO_HASH = "0".repeat(64);

/**
 * A template version drawn with sample content (the clinic's own letterhead details, fake patient) or with a real
 * prescription of this clinic shown as a draft. Never a record: no output row; only the real-patient preview is audited.
 */
export async function renderTemplatePreview(
  ctx: ServiceContext,
  templateId: string,
  input: { source: PreviewSource; versionId?: string | null; format: "html" | "pdf" },
  deps: { engine?: PdfEngine; limiter?: Limiter; signal?: AbortSignal } = {},
): Promise<Result<PreviewResult>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", TEMPLATE_NOT_FOUND);
  if (!isUuid(templateId) || (input.versionId != null && !isUuid(input.versionId))) return NOT_FOUND();
  const { source } = input;
  if (source.kind === "patient" && (!can(ctx.role, "rx.read") || !isUuid(source.prescriptionId))) return NOT_FOUND();

  const prepared = await withTenant(ctx.tenantId, async (tx): Promise<Result<Prepared>> => {
    const [template] = await tx.select().from(templates).where(and(eq(templates.tenantId, ctx.tenantId), eq(templates.id, templateId))).limit(1);
    if (!template) return NOT_FOUND();
    const versions = await tx.select().from(templateVersions).where(and(eq(templateVersions.tenantId, ctx.tenantId), eq(templateVersions.templateId, templateId)));
    const version = input.versionId
      ? versions.find((v) => v.id === input.versionId)
      : (versions.find((v) => v.state === "draft") ?? versions.find((v) => v.id === template.currentVersionId));
    if (!version) return NOT_FOUND();
    const paperSize = pickOption(PAPER_SIZES, version.paperSize, "A4");
    const labels = pickOption(LABEL_LANGUAGES, version.labels, "en");
    const definition = parseOverlayDefinition(version.definition, paperSize);
    const file = definition ? await loadTemplateFileIn(tx, ctx.tenantId, version.fileId) : null;
    if (!definition || !file) return fail("invalid", "This pad version is damaged and cannot be shown.");
    const layout: PadLayout = { template: { kind: "overlay", templateVersionId: version.id, contentSha256: version.contentSha256 ?? ZERO_HASH }, paperSize, labels };
    const overlay = { templateVersionId: version.id, definition, background: fileAsImageAsset(file) };

    if (source.kind === "sample") {
      const base = await buildRenderSnapshot(tx, { tenantId: ctx.tenantId, patientId: newId(), prescriberUserId: can(ctx.role, "rx.finalize") ? ctx.userId : null, visitDoctorId: null, at: new Date() });
      // Without a doctor profile (owners, designers) the sample shows a long example doctor, so a dynamic pad shows its doctor block.
      const withDoctor = base.doctor.name.trim() === "" ? { ...base, doctor: SAMPLE_LETTERHEAD.doctor } : base;
      const doc = sampleDocument(source.sample, { ...withDoctor, layout });
      const logoId = base.clinic.logoAssetId;
      const logos = logoId ? await loadImageAssets(tx, ctx.tenantId, [{ id: logoId, kind: "logo" }]) : new Map();
      return ok({ doc, logo: logoId ? (logos.get(assetKey("logo", logoId)) ?? null) : null, overlay });
    }

    const loaded = await loadRxDocumentIn(tx, ctx.tenantId, source.prescriptionId, { userId: ctx.userId, canFinalize: false });
    if (!loaded.ok) return loaded.code === "not_found" ? NOT_FOUND() : loaded;
    const original = loaded.value.document;
    const doc: RxDocument = {
      ...original,
      status: "draft",
      rxNo: null,
      issuedAt: null,
      supersededBy: null,
      snapshotSource: "live",
      snapshot: { ...original.snapshot, doctor: { ...original.snapshot.doctor, signatureAssetId: null }, layout },
    };
    await recordAudit(tx, ctx, {
      action: "template.previewed_with_patient",
      entityType: "template",
      entityId: templateId,
      after: { templateId, templateVersionId: version.id, prescriptionId: source.prescriptionId },
    });
    return ok({ doc, logo: loaded.value.logo, overlay });
  });
  if (!prepared.ok) return prepared;

  const { doc, logo, overlay } = prepared.value;
  const rendered = renderPrescription(doc, { logo, signature: null, fontCss: loadFontCss(), overlay }, { target: input.format === "pdf" ? "pdf" : "screen", sample: source.kind === "sample" });
  for (const part of [rendered.html, rendered.footerHtml]) {
    const check = checkSelfContained(part);
    if (!check.ok) throw new Error(`Rendered template preview is not self-contained: ${check.reason}`);
  }
  if (input.format === "html") return ok({ format: "html", html: rendered.html });
  const engine = deps.engine ?? getPdfEngine();
  const run = await (deps.limiter ?? renderLimiter).run(() => engine.render(rendered, { signal: deps.signal }), { signal: deps.signal });
  if (run.busy || run.aborted === true) return fail("unavailable", BUSY_MESSAGE);
  if (!run.value.ok) return fail(run.value.code === "pdf_timeout" ? "timeout" : "unavailable", run.value.message);
  return ok({ format: "pdf", pdf: run.value.pdf });
}

/** The latest prescriptions of this clinic for the real-patient preview picker (rx.read only; label shows the name and Rx). */
export async function listPreviewPrescriptions(ctx: ServiceContext): Promise<Result<PreviewPrescription[]>> {
  if (!can(ctx.role, "rx.read") || !can(ctx.role, "template.read")) return ok([]);
  return withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: prescriptions.id, rxNo: prescriptions.rxNo, status: prescriptions.status, name: patients.name })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .innerJoin(patients, eq(patients.id, visits.patientId))
      .where(eq(prescriptions.tenantId, ctx.tenantId))
      .orderBy(desc(prescriptions.createdAt))
      .limit(10);
    return ok(rows.map((r) => ({ id: r.id, label: `${r.name} · ${r.status === "draft" || r.rxNo === null ? "draft" : `Rx ${r.rxNo}`}` })));
  });
}
```

- [ ] **Step 3: Implement the route**

`src/app/(app)/templates/[id]/preview/route.ts`:

```ts
import { z } from "zod";
import { DOCUMENT_CSP } from "@/lib/rx-render/render";
import { escapeHtml } from "@/lib/rx-render/html";
import { SAMPLE_KINDS } from "@/lib/rx-render/samples";
import { getSessionContext } from "@/server/auth/session";
import { crossSiteRefusal, headNotAllowed, statusForError } from "@/server/http/response";
import { renderTemplatePreview, type PreviewSource } from "@/server/services/template-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `${DOCUMENT_CSP}; frame-ancestors 'self'`,
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const query = z.object({
  sample: z.enum(SAMPLE_KINDS).optional(),
  prescriptionId: z.uuid().optional(),
  version: z.uuid().optional(),
  format: z.enum(["html", "pdf"]).default("html"),
});

function page(status: number, message: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview unavailable</title></head><body data-rx="error"><p>${escapeHtml(message)}</p></body></html>`, {
    status,
    headers: HTML_HEADERS,
  });
}

/** A Template Studio preview: ?sample=short|long|blank or ?prescriptionId=…, optionally &version=… and &format=pdf. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) return Response.redirect(new URL("/login", request.url), 303);
    const { id } = await params;
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || (parsed.data.sample === undefined) === (parsed.data.prescriptionId === undefined)) return page(404, "Preview not found.");
    const source: PreviewSource = parsed.data.prescriptionId ? { kind: "patient", prescriptionId: parsed.data.prescriptionId } : { kind: "sample", sample: parsed.data.sample ?? "short" };
    const result = await renderTemplatePreview(session, id, { source, versionId: parsed.data.version ?? null, format: parsed.data.format }, { signal: request.signal });
    if (!result.ok) return page(statusForError(result.code), result.code === "forbidden" || result.code === "not_found" ? "Preview not found." : result.message);
    if (result.value.format === "html") return new Response(result.value.html, { status: 200, headers: HTML_HEADERS });
    return new Response(result.value.pdf, {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="pad-preview.pdf"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    console.error("template preview failed", error instanceof Error ? error.name : typeof error);
    return page(500, "The preview could not be prepared. Try again.");
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-preview-route.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing panel tests**

`tests/unit/publish-panel.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const publish = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/templates", () => ({ publishTemplateAction: publish }));

import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { PublishPanel } from "@/components/templates/publish-panel";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const definition = overlayDefinitionSchema.parse(structuredClone(MINIMAL_OVERLAY_DEFINITION));
const doctors = [{ id: "019a0000-0000-7000-8000-0000000000d1", name: "Dr Meera Shah", isMe: true }];
const panel = (over: Partial<Parameters<typeof PublishPanel>[0]> = {}) =>
  render(<PublishPanel templateId="t1" definition={definition} paper="A4" revision={2} doctors={doctors} canPublish dirty={false} {...over} />);

describe("PublishPanel", () => {
  it("has no preselected answer to the letterhead question", () => {
    panel();
    expect(screen.getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("needs a doctor and the confirmation for a doctor's own letterhead", async () => {
    publish.mockResolvedValueOnce({ ok: true });
    panel();
    fireEvent.click(screen.getByRole("radio", { name: /shows one doctor/ }));
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Whose letterhead is it?"), { target: { value: doctors[0].id } });
    fireEvent.click(screen.getByRole("checkbox", { name: /shows Dr Meera Shah's name and registration number/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith("t1", { identity: "bound", boundDoctorId: doctors[0].id, confirmLetterhead: true, baseRevision: 2 }),
    );
  });

  it("lists what blocks publishing", () => {
    panel({ definition: { ...definition, boxes: [] } });
    fireEvent.click(screen.getByRole("radio", { name: /does not show a doctor/ }));
    expect(screen.getByText("Add a box for the patient's name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("tells a doctor that the owner publishes, and asks to save first", () => {
    const { unmount } = panel({ canPublish: false });
    expect(screen.getByText(/clinic owner publishes/)).toBeInTheDocument();
    unmount();
    panel({ dirty: true });
    expect(screen.getByText(/Save the draft before publishing/)).toBeInTheDocument();
  });
});
```

`tests/unit/assign-panel.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const assign = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/templates", () => ({ assignTemplateAction: assign }));

import { AssignPanel } from "@/components/templates/assign-panel";

const doctors = [
  { id: "019a0000-0000-7000-8000-0000000000d1", name: "Dr Meera Shah", isMe: true },
  { id: "019a0000-0000-7000-8000-0000000000d2", name: "Dr Ravi Rao", isMe: false },
];

describe("AssignPanel", () => {
  it("lets the owner use a dynamic pad for the whole clinic or one doctor", async () => {
    assign.mockResolvedValue({ ok: true });
    render(<AssignPanel templateId="t1" identity="dynamic" boundDoctorId={null} role="owner" doctors={doctors} />);
    fireEvent.click(screen.getByRole("button", { name: "Use for the whole clinic" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith({ scope: "clinic", templateId: "t1" }));
    fireEvent.change(screen.getByLabelText("Or for one doctor"), { target: { value: doctors[1].id } });
    fireEvent.click(screen.getByRole("button", { name: "Use for this doctor" }));
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith({ scope: "doctor", doctorId: doctors[1].id, templateId: "t1" }));
  });

  it("offers a bound pad only to its own doctor", () => {
    render(<AssignPanel templateId="t1" identity="bound" boundDoctorId={doctors[1].id} role="owner" doctors={doctors} />);
    expect(screen.queryByRole("button", { name: "Use for the whole clinic" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use for Dr Ravi Rao" })).toBeInTheDocument();
  });

  it("lets a doctor choose it only for their own prescriptions", async () => {
    assign.mockResolvedValue({ ok: true });
    render(<AssignPanel templateId="t1" identity="dynamic" boundDoctorId={null} role="doctor" doctors={doctors} />);
    expect(screen.queryByRole("button", { name: "Use for the whole clinic" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use for my prescriptions" }));
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith({ scope: "doctor", doctorId: doctors[0].id, templateId: "t1" }));
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/publish-panel.test.tsx tests/unit/assign-panel.test.tsx`
Expected: FAIL — components missing.

- [ ] **Step 5: Implement the panels**

`src/components/templates/publish-panel.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { PaperSize } from "@/lib/rx-render/types";
import { overlayPublishIssues, type PublishIdentity } from "@/lib/templates/publish-rules";
import { publishTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";

type Doctor = { id: string; name: string; isMe: boolean };
type Props = { templateId: string; definition: OverlayDefinition; paper: PaperSize; revision: number; doctors: Doctor[]; canPublish: boolean; dirty: boolean };

/** Decision 19: the publisher answers the letterhead question explicitly (nothing preselected); the server re-checks everything. */
export function PublishPanel({ templateId, definition, paper, revision, doctors, canPublish, dirty }: Props) {
  const router = useRouter();
  const [identity, setIdentity] = useState<"dynamic" | "bound" | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const doctor = doctors.find((d) => d.id === doctorId) ?? null;
  const asked: PublishIdentity | null = identity === null ? null : identity === "dynamic" ? { kind: "dynamic" } : { kind: "bound", doctorId: doctor?.id ?? null, confirmed };
  const issues = useMemo(() => (asked ? overlayPublishIssues(definition, paper, asked) : []), [asked, definition, paper]);

  if (!canPublish) return <p className="rounded-md border p-3 text-sm">The clinic owner publishes pads. Save your draft and ask them to review and publish it.</p>;

  async function publish() {
    if (!asked) return;
    setBusy(true);
    const result = await publishTemplateAction(templateId, { identity: asked.kind, boundDoctorId: asked.kind === "bound" ? asked.doctorId : null, confirmLetterhead: confirmed, baseRevision: revision });
    setBusy(false);
    setMessage(result.ok ? "Published. Choose who uses it below." : (result.error ?? "Could not publish."));
    if (result.ok) router.refresh();
  }

  return (
    <section aria-label="Publish" className="space-y-3 rounded-md border p-3">
      <h2 className="font-medium">Publish</h2>
      <fieldset className="space-y-1 text-sm">
        <legend>Does the printed letterhead show a doctor&apos;s name or registration number?</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="identity" checked={identity === "dynamic"} onChange={() => setIdentity("dynamic")} /> No, it does not show a doctor: ClinicPad prints the signing doctor&apos;s details
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="identity" checked={identity === "bound"} onChange={() => setIdentity("bound")} /> Yes, it shows one doctor: only that doctor&apos;s prescriptions use it
        </label>
      </fieldset>
      {identity === "bound" ? (
        <div className="space-y-2 text-sm">
          <label className="flex flex-col">
            Whose letterhead is it?
            <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="rounded border p-1">
              <option value="">Choose a doctor</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          {doctor ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> The letterhead shows {doctor.name}&apos;s name and registration number
            </label>
          ) : null}
        </div>
      ) : null}
      {issues.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-destructive">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
      {dirty ? <p className="text-sm">Save the draft before publishing.</p> : null}
      <Button type="button" onClick={() => void publish()} disabled={busy || dirty || asked === null || issues.length > 0}>
        Publish
      </Button>
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
    </section>
  );
}
```

`src/components/templates/assign-panel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { assignTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";

type Doctor = { id: string; name: string; isMe: boolean };
type Props = { templateId: string; identity: "dynamic" | "bound"; boundDoctorId: string | null; role: string; doctors: Doctor[] };

/** Who prints on this published pad (decision 9). The server enforces every rule shown here. */
export function AssignPanel({ templateId, identity, boundDoctorId, role, doctors }: Props) {
  const router = useRouter();
  const [doctorId, setDoctorId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const me = doctors.find((d) => d.isMe) ?? null;
  const bound = doctors.find((d) => d.id === boundDoctorId) ?? null;

  async function run(input: Parameters<typeof assignTemplateAction>[0], done: string) {
    const result = await assignTemplateAction(input);
    setMessage(result.ok ? done : (result.error ?? "Could not change the pad."));
    if (result.ok) router.refresh();
  }

  return (
    <section aria-label="Use this pad" className="space-y-3 rounded-md border p-3 text-sm">
      <h2 className="font-medium">Use this pad</h2>
      {identity === "bound" ? (
        bound && (role === "owner" || bound.isMe) ? (
          <Button type="button" onClick={() => void run({ scope: "doctor", doctorId: bound.id, templateId }, `${bound.name}'s prescriptions now print on this pad.`)}>
            {bound.isMe ? "Use for my prescriptions" : `Use for ${bound.name}`}
          </Button>
        ) : (
          <p>This letterhead belongs to {bound?.name ?? "another doctor"}.</p>
        )
      ) : role === "owner" ? (
        <>
          <Button type="button" onClick={() => void run({ scope: "clinic", templateId }, "Every prescription now prints on this pad, unless a doctor has chosen their own.")}>
            Use for the whole clinic
          </Button>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col">
              Or for one doctor
              <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="rounded border p-1">
                <option value="">Choose a doctor</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" disabled={doctorId === ""} onClick={() => void run({ scope: "doctor", doctorId, templateId }, "Done.")}>
              Use for this doctor
            </Button>
          </div>
        </>
      ) : me ? (
        <Button type="button" onClick={() => void run({ scope: "doctor", doctorId: me.id, templateId }, "Your prescriptions now print on this pad.")}>
          Use for my prescriptions
        </Button>
      ) : null}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
```

`src/components/templates/preview-panel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Props = { templateId: string; versionId: string | null; prescriptions: { id: string; label: string }[]; disabled: boolean };

function href(templateId: string, query: Record<string, string>, versionId: string | null): string {
  const params = new URLSearchParams(versionId ? { ...query, version: versionId } : query);
  return `/templates/${templateId}/preview?${params.toString()}`;
}

/** Opens previews in a new tab (spec section 10.1 step 5). Real-patient previews are audited by the server. */
export function PreviewPanel({ templateId, versionId, prescriptions, disabled }: Props) {
  const [rx, setRx] = useState("");
  const link = (label: string, query: Record<string, string>) => (
    <Button asChild variant="outline" size="sm" key={label}>
      <a href={disabled ? undefined : href(templateId, query, versionId)} target="_blank" rel="noopener noreferrer" aria-disabled={disabled}>
        {label}
      </a>
    </Button>
  );
  return (
    <section aria-label="Preview" className="space-y-3 rounded-md border p-3 text-sm">
      <h2 className="font-medium">Preview</h2>
      {disabled ? <p>Save the draft to preview your changes.</p> : null}
      <div className="flex flex-wrap gap-2">
        {link("3 medicines", { sample: "short" })}
        {link("12 medicines (page 2)", { sample: "long" })}
        {link("Blank pad", { sample: "blank" })}
        {link("12 medicines as PDF", { sample: "long", format: "pdf" })}
      </div>
      {prescriptions.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col">
            With a real patient (shown as a draft; recorded)
            <select value={rx} onChange={(e) => setRx(e.target.value)} className="rounded border p-1">
              <option value="">Choose a recent prescription</option>
              {prescriptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {rx ? link("Preview with this patient", { prescriptionId: rx }) : null}
        </div>
      ) : null}
    </section>
  );
}
```

`src/components/templates/version-history.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { rollbackTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";

type Version = { versionId: string; version: number; publishedAt: string };

/** Published versions, newest first. Publishing an older one again makes a new version (history is never rewritten). */
export function VersionHistory({ templateId, currentVersionId, versions, canPublish }: { templateId: string; currentVersionId: string | null; versions: Version[]; canPublish: boolean }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  if (versions.length === 0) return null;
  return (
    <section aria-label="Versions" className="space-y-2 rounded-md border p-3 text-sm">
      <h2 className="font-medium">Published versions</h2>
      <ul className="space-y-1">
        {versions.map((v) => (
          <li key={v.versionId} className="flex items-center justify-between gap-2">
            <span>
              Version {v.version} · {new Date(v.publishedAt).toLocaleDateString("en-IN")}
              {v.versionId === currentVersionId ? " (in use)" : ""}
            </span>
            {canPublish && v.versionId !== currentVersionId ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  const result = await rollbackTemplateAction(templateId, v.versionId);
                  setMessage(result.ok ? `Version ${v.version} is published again as a new version.` : (result.error ?? "Could not publish it again."));
                  if (result.ok) router.refresh();
                }}
              >
                Publish again
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
```

- [ ] **Step 6: Wire the panels into the template page**

Replace `src/app/(app)/templates/[id]/page.tsx` with:

```tsx
import { notFound, redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { requireSession } from "@/server/auth/session";
import { startTemplateDraftAction } from "@/server/actions/templates";
import { listTemplateDoctors } from "@/server/services/template-assign";
import { listPreviewPrescriptions } from "@/server/services/template-preview";
import { getTemplateEditor } from "@/server/services/templates";
import { AssignPanel } from "@/components/templates/assign-panel";
import { PreviewPanel } from "@/components/templates/preview-panel";
import { PublishPanel } from "@/components/templates/publish-panel";
import { TemplateEditor } from "@/components/templates/template-editor";
import { VersionHistory } from "@/components/templates/version-history";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!can(session.role, "template.read")) redirect("/dashboard");
  const { id } = await params;
  const [view, doctors, recent] = await Promise.all([getTemplateEditor(session, id), listTemplateDoctors(session), listPreviewPrescriptions(session)]);
  if (!view.ok) notFound();
  const { summary, draft, history } = view.value;
  const doctorList = doctors.ok ? doctors.value : [];
  const versions = history.map((v) => ({ versionId: v.versionId, version: v.version, publishedAt: v.publishedAt.toISOString() }));
  const canPublish = can(session.role, "template.publish");
  const assign =
    summary.current && summary.status === "active" && can(session.role, "template.assign") ? (
      <AssignPanel templateId={id} identity={summary.identity} boundDoctorId={summary.boundDoctorId} role={session.role} doctors={doctorList} />
    ) : null;
  const versionHistory = <VersionHistory templateId={id} currentVersionId={summary.current?.versionId ?? null} versions={versions} canPublish={canPublish} />;

  if (!draft) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">{summary.name}</h1>
        <p className="text-sm text-muted-foreground">{summary.current ? `Published version ${summary.current.version}.` : "Nothing published yet."}</p>
        {summary.canWrite && summary.status === "active" ? (
          <form action={async () => { "use server"; await startTemplateDraftAction(id); }}>
            <Button type="submit">Edit this pad</Button>
          </form>
        ) : null}
        {summary.current ? <PreviewPanel templateId={id} versionId={summary.current.versionId} prescriptions={recent.ok ? recent.value : []} disabled={false} /> : null}
        {assign}
        {versionHistory}
      </div>
    );
  }
  return (
    <TemplateEditor templateId={id} name={summary.name} fileId={draft.fileId} paper={draft.paperSize} labels={draft.labels} definition={draft.definition} revision={draft.revision}>
      <div className="grid gap-4 lg:grid-cols-2">
        <PreviewPanel templateId={id} versionId={null} prescriptions={recent.ok ? recent.value : []} disabled={false} />
        <PublishPanel templateId={id} definition={draft.definition} paper={draft.paperSize} revision={draft.revision} doctors={doctorList} canPublish={canPublish} dirty={false} />
        {assign}
        {versionHistory}
      </div>
    </TemplateEditor>
  );
}
```

The panels receive the **saved** draft (server props); the editor's own `dirty` flag tells the user to save first, and `router.refresh()` after a save re-renders these panels with the new revision and definition.

- [ ] **Step 7: Run, try, commit**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/publish-panel.test.tsx tests/unit/assign-panel.test.tsx tests/integration/template-preview-route.test.ts`
Expected: PASS. Then with `npm run dev`: open each preview kind; the long sample flows to page 2 in the PDF preview with the boxes on both pages; publish as dynamic; use it for the whole clinic; finalize a prescription; print it.

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/services/template-preview.ts "src/app/(app)/templates/[id]/preview/route.ts" "src/app/(app)/templates/[id]/page.tsx" src/components/templates/preview-panel.tsx src/components/templates/publish-panel.tsx src/components/templates/assign-panel.tsx src/components/templates/version-history.tsx tests/integration/template-preview-route.test.ts tests/unit/publish-panel.test.tsx tests/unit/assign-panel.test.tsx
Set-Location E:\projects\clinicpad; git commit -m "feat(templates): previews with sample and real data, publish with the letterhead question, assign and history" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 19: Print modes — pre-printed paper, the alignment check, the printer offset, and per-browser print

**Gate:** the S1 finding's `OVERLAY_BROWSER_PRINT` values.

**Files:**
- Create: `src/lib/rx-render/overlay-alignment.ts`, `src/app/(app)/templates/[id]/alignment/route.ts`, `src/components/templates/print-inspector.tsx`, `src/lib/templates/print-support.ts`
- Modify: `src/server/services/template-preview.ts` (`renderTemplateAlignment`), `src/components/templates/template-editor.tsx` (print inspector), `src/components/rx/output-actions.tsx` (`printsOnOverlay`), `src/components/rx/rx-output-panel.tsx` (pass it), `src/app/(app)/prescriptions/[id]/page.tsx` (pass it), `src/server/services/patient-history.ts` + `src/components/patients/prescription-history.tsx` (pass it from history rows)
- Test: `tests/unit/overlay-alignment.test.ts`, `tests/unit/print-support.test.ts`, `tests/unit/output-actions.test.tsx` (new cases)

**Interfaces:**
- Consumes: `overlayCss` (Task 12), `TEMPLATE_FIELDS` (Task 10), `DOCUMENT_CSP`, `PAPER`; `GET /prescriptions/<id>/pdf?purpose=print` (Task 14); `PrescriptionView.templateVersionId` (Task 13).
- Produces: `renderAlignmentCheck(def: OverlayDefinition, paperSize: PaperSize, fontCss: string): string`; `renderTemplateAlignment(ctx, templateId): Promise<Result<string>>`; `GET /templates/<id>/alignment`; `OVERLAY_BROWSER_PRINT: Record<BrowserFamily, boolean>`, `type BrowserFamily = "chromium" | "firefox" | "webkit" | "other"`, `browserFamily(userAgent: string, hasUserAgentData: boolean): BrowserFamily`, `overlayPrintsInBrowser(family): boolean`; `OutputActions` prop `printsOnOverlay?: boolean`; `HistoryRow.templateVersionId`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/overlay-alignment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderAlignmentCheck } from "@/lib/rx-render/overlay-alignment";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { overlayDefinition } from "../fixtures/overlay-documents";

const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");

describe("renderAlignmentCheck", () => {
  it("outlines every box and the body region with fixed labels, without the background, and is self-contained", () => {
    const html = renderAlignmentCheck(overlayDefinition(), "A4", "");
    expect(checkSelfContained(html)).toEqual({ ok: true });
    const page = parse(html);
    expect(page.querySelectorAll(".box")).toHaveLength(2);
    expect(page.querySelector(".box-0")?.textContent).toBe("Patient's name");
    expect(page.querySelector(".flow-outline")).not.toBeNull();
    expect(page.querySelector(".bg")).toBeNull();
    expect(page.body.textContent).toContain("hold it against the light");
  });

  it("applies the printer offset, as printing does", () => {
    const html = renderAlignmentCheck(overlayDefinition({ printOffsetMm: { x: 2, y: -1.5 } }), "A4", "");
    expect(parse(html).querySelector("style")?.textContent).toContain(".box-0{left:22mm;top:50.5mm;");
  });
});
```

`tests/unit/print-support.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { browserFamily, overlayPrintsInBrowser, OVERLAY_BROWSER_PRINT } from "@/lib/templates/print-support";

const UA = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1",
};

describe("browserFamily", () => {
  it("recognises the print engine, not the brand", () => {
    expect(browserFamily(UA.chrome, true)).toBe("chromium");
    expect(browserFamily(UA.edge, true)).toBe("chromium");
    expect(browserFamily(UA.firefox, false)).toBe("firefox");
    expect(browserFamily(UA.safari, false)).toBe("webkit");
    expect(browserFamily(UA.iosChrome, false)).toBe("webkit");
    expect(browserFamily("", false)).toBe("other");
  });

  it("prints overlays in the browser only where the S1 check passed, never in an unknown browser", () => {
    expect(overlayPrintsInBrowser("chromium")).toBe(OVERLAY_BROWSER_PRINT.chromium);
    expect(overlayPrintsInBrowser("other")).toBe(false);
  });
});
```

Add to `tests/unit/output-actions.test.tsx` (inside a new `describe`; reuse that file's existing `ID` constant and imports):

```tsx
describe("OutputActions on an overlay pad", () => {
  it("prints through the paper PDF in a new tab where the browser cannot print overlays", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    // An unknown print engine is never trusted with overlays, whatever the S1 finding says about Firefox and Safari.
    Object.defineProperty(window.navigator, "userAgent", { value: "Mozilla/5.0 (UnknownOS) UnknownBrowser/1.0", configurable: true });
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" printsOnOverlay />);
    fireEvent.click(screen.getByRole("button", { name: /print/i }));
    expect(open).toHaveBeenCalledWith(`/prescriptions/${ID}/pdf?purpose=print`, "_blank", "noopener");
    expect(document.querySelector("iframe")).toBeNull();
    open.mockRestore();
  });

  it("keeps the print frame for built-in pads", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: /print/i }));
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).not.toBeNull();
    open.mockRestore();
  });
});
```

(Add `vi`, `fireEvent` to the file's imports if they are not there.)

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/overlay-alignment.test.ts tests/unit/print-support.test.ts tests/unit/output-actions.test.tsx`
Expected: FAIL — modules and the prop missing.

- [ ] **Step 2: Implement the alignment page and print support**

`src/lib/rx-render/overlay-alignment.ts`:

```ts
import { DOCUMENT_CSP } from "./common";
import { TEMPLATE_FIELDS } from "./fields";
import { html, raw } from "./html";
import { overlayCss } from "./overlay-css";
import type { OverlayDefinition } from "./overlay-definition";
import { PAPER } from "./paper";
import type { PaperSize } from "./types";

/**
 * One page to print on the clinic's own pre-printed pad (spec section 10.1): every box and the body region outlined
 * where ClinicPad will print them, with the printer offset applied, and no background. Labels are the catalogue's
 * fixed English names (never user text). Self-contained like every document.
 */
export function renderAlignmentCheck(def: OverlayDefinition, paperSize: PaperSize, fontCss: string): string {
  const paper = PAPER[paperSize];
  const offset = def.printOffsetMm;
  const css = [
    `@page{size:${paperSize} portrait;margin:0}`,
    "html,body{margin:0;padding:0;background:#fff;color:#111;font-family:\"Noto Sans Devanagari\",sans-serif;font-size:9pt}",
    overlayCss(def, paper, offset),
    ".box{border:0.3mm dashed #b91c1c;color:#b91c1c}",
    `.flow-outline{position:fixed;left:${def.flow.leftMm + offset.x}mm;right:${def.flow.rightMm - offset.x}mm;top:${def.flow.topMm + offset.y}mm;bottom:${def.flow.bottomMm - offset.y}mm;border:0.3mm dashed #1d4ed8;color:#1d4ed8;padding:1mm}`,
    ".note{position:fixed;left:10mm;right:10mm;bottom:3mm;font-size:8pt;color:#333}",
  ].join("\n");
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>Alignment check</title>
<style>${raw(fontCss)}
${raw(css)}</style>
</head>
<body class="overlay" data-rx="ready">
${def.boxes.map((box, i) => {
  const className = `box box-${i}`;
  return html`<div class="${className}">${TEMPLATE_FIELDS[box.field].en}</div>`;
})}
<div class="flow-outline">Prescription body</div>
<p class="note">Print this page on your pre-printed pad and hold it against the light. If the red boxes sit off their places, change the printer adjustment in Template Studio and print this page again.</p>
</body>
</html>
`.value;
}
```

(`overlayCss` keeps every number finite and rounded; the `.flow-outline` numbers come from the same parsed definition.)

`src/lib/templates/print-support.ts`:

```ts
export type BrowserFamily = "chromium" | "firefox" | "webkit" | "other";

/**
 * Which print engines print an overlay pad correctly from HTML (background and boxes repeated on every page). From
 * docs/spikes/2026-11-18-s1-overlay-print.md: Chromium is checked automatically; Firefox and WebKit stay false until a
 * person has checked their print preview (decision 16). Every false browser prints the Gotenberg PDF made for paper.
 */
export const OVERLAY_BROWSER_PRINT: Record<BrowserFamily, boolean> = { chromium: true, firefox: false, webkit: false, other: false };

/** The print engine behind a user agent. Every iOS browser is WebKit; Chromium exposes navigator.userAgentData. */
export function browserFamily(userAgent: string, hasUserAgentData: boolean): BrowserFamily {
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return "webkit";
  if (/\bFirefox\/\d/.test(userAgent)) return "firefox";
  if (hasUserAgentData || /\b(Chrome|Chromium|Edg)\/\d/.test(userAgent)) return "chromium";
  if (/\bAppleWebKit\/\d/.test(userAgent) && /\bSafari\/\d/.test(userAgent)) return "webkit";
  return "other";
}

export function overlayPrintsInBrowser(family: BrowserFamily): boolean {
  return OVERLAY_BROWSER_PRINT[family];
}
```

(Copy the three booleans for `chromium`, `firefox`, `webkit` from the S1 finding's `OVERLAY_BROWSER_PRINT` line.)

Append to `src/server/services/template-preview.ts`:

```ts
/** The alignment page for a template's draft (or its current version): template.read only, nothing logged. */
export async function renderTemplateAlignment(ctx: ServiceContext, templateId: string): Promise<Result<string>> {
  if (!can(ctx.role, "template.read") || !isUuid(templateId)) return NOT_FOUND();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<string>> => {
    const [template] = await tx.select().from(templates).where(and(eq(templates.tenantId, ctx.tenantId), eq(templates.id, templateId))).limit(1);
    if (!template) return NOT_FOUND();
    const versions = await tx.select().from(templateVersions).where(and(eq(templateVersions.tenantId, ctx.tenantId), eq(templateVersions.templateId, templateId)));
    const version = versions.find((v) => v.state === "draft") ?? versions.find((v) => v.id === template.currentVersionId);
    if (!version) return NOT_FOUND();
    const paperSize = pickOption(PAPER_SIZES, version.paperSize, "A4");
    const definition = parseOverlayDefinition(version.definition, paperSize);
    if (!definition) return fail("invalid", "This pad version is damaged and cannot be shown.");
    const markup = renderAlignmentCheck(definition, paperSize, loadFontCss());
    if (!checkSelfContained(markup).ok) throw new Error("Alignment check is not self-contained");
    return ok(markup);
  });
}
```

(and import `renderAlignmentCheck` from `@/lib/rx-render/overlay-alignment`).

`src/app/(app)/templates/[id]/alignment/route.ts`:

```ts
import { DOCUMENT_CSP } from "@/lib/rx-render/render";
import { getSessionContext } from "@/server/auth/session";
import { crossSiteRefusal, headNotAllowed } from "@/server/http/response";
import { renderTemplateAlignment } from "@/server/services/template-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `${DOCUMENT_CSP}; frame-ancestors 'self'`,
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) return Response.redirect(new URL("/login", request.url), 303);
    const { id } = await params;
    const result = await renderTemplateAlignment(session, id);
    if (!result.ok) return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body data-rx="error"><p>Not found.</p></body></html>', { status: 404, headers: HEADERS });
    return new Response(result.value, { status: 200, headers: HEADERS });
  } catch (error) {
    console.error("alignment check failed", error instanceof Error ? error.name : typeof error);
    return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Error</title></head><body data-rx="error"><p>Try again.</p></body></html>', { status: 500, headers: HEADERS });
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
```

- [ ] **Step 3: The print inspector in the editor**

`src/components/templates/print-inspector.tsx`:

```tsx
"use client";

import { OVERLAY_LIMITS, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { EditorAction } from "@/lib/templates/editor-state";

const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));
const clampOffset = (n: number) => Math.min(OVERLAY_LIMITS.maxOffsetMm, Math.max(-OVERLAY_LIMITS.maxOffsetMm, n));

/** Pre-printed stationery (decision 12): paper prints only the data; downloads and shares keep the background. */
export function PrintInspector({ templateId, definition, dirty, dispatch }: { templateId: string; definition: OverlayDefinition; dirty: boolean; dispatch: (a: EditorAction) => void }) {
  const preprinted = definition.background.printMode === "pdf_only";
  const offset = definition.printOffsetMm;
  const setOffset = (axis: "x" | "y", value: string) => {
    const n = num(value);
    if (Number.isFinite(n)) dispatch({ type: "options", patch: { printOffsetMm: { ...offset, [axis]: Math.round(clampOffset(n) * 10) / 10 } } });
  };
  return (
    <section aria-label="Printing" className="space-y-3 rounded-md border p-3 text-sm">
      <h2 className="font-medium">Printing</h2>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={preprinted} onChange={(e) => dispatch({ type: "options", patch: { background: { printMode: e.target.checked ? "pdf_only" : "always" } } })} />
        <span>We print on our pre-printed pads (print only the data; PDFs sent to patients still show the letterhead)</span>
      </label>
      {preprinted ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col text-xs">
              Move right (mm, −10 to 10)
              <input type="number" step={0.5} min={-10} max={10} value={offset.x} onChange={(e) => setOffset("x", e.target.value)} className="rounded border p-1" />
            </label>
            <label className="flex flex-col text-xs">
              Move down (mm, −10 to 10)
              <input type="number" step={0.5} min={-10} max={10} value={offset.y} onChange={(e) => setOffset("y", e.target.value)} className="rounded border p-1" />
            </label>
          </div>
          {dirty ? (
            <p className="text-xs">Save the draft, then print the alignment check.</p>
          ) : (
            <a className="text-xs underline" href={`/templates/${templateId}/alignment`} target="_blank" rel="noopener noreferrer">
              Print the alignment check on one of your pads
            </a>
          )}
        </>
      ) : null}
    </section>
  );
}
```

In `src/components/templates/template-editor.tsx`, import `PrintInspector` and render `<PrintInspector templateId={templateId} definition={state.definition} dirty={dirty} dispatch={dispatch} />` right after the `<FlowInspector … />` element.

- [ ] **Step 4: Per-browser print for overlay prescriptions**

In `src/components/rx/output-actions.tsx`:
- import `{ browserFamily, overlayPrintsInBrowser } from "@/lib/templates/print-support"`;
- change `type Props = { prescriptionId: string; fileName: string };` to `type Props = { prescriptionId: string; fileName: string; /** The prescription prints on a custom overlay pad (Plan 2A). */ printsOnOverlay?: boolean };` and the signature to `export function OutputActions({ prescriptionId, fileName, printsOnOverlay = false }: Props)`;
- at the very start of `function print()` add:

```ts
    // Overlay pads print from HTML only where the S1 check passed (decision 16); elsewhere the paper PDF opens in a new
    // tab (window.open runs synchronously in the click, so popup blockers allow it). The server logs it as a print.
    if (printsOnOverlay && !overlayPrintsInBrowser(browserFamily(navigator.userAgent, "userAgentData" in navigator))) {
      setError(null);
      window.open(`/prescriptions/${prescriptionId}/pdf?purpose=print`, "_blank", "noopener");
      router.refresh();
      return;
    }
```

In `src/components/rx/rx-output-panel.tsx`, add `printsOnOverlay: boolean` to the panel's props type and pass `printsOnOverlay={p.printsOnOverlay}` to its `<OutputActions … />`. In `src/app/(app)/prescriptions/[id]/page.tsx`, pass `printsOnOverlay={rx.status !== "draft" && rx.templateVersionId !== null}` to `<RxOutputPanel … />`. In `src/server/services/patient-history.ts`, add `templateVersionId: string | null;` to `HistoryRow` and `templateVersionId: prescriptions.templateVersionId,` to the history `select({ … })`; in `src/components/patients/prescription-history.tsx`, pass `printsOnOverlay={r.templateVersionId !== null}` to `<OutputActions … />`. In `tests/unit/prescription-page.test.tsx` add `templateVersionId: null,` to `finalizedView()`'s value, and in `tests/unit/prescription-history.test.tsx` add `templateVersionId: null` to its row fixtures if the type check asks for it.

- [ ] **Step 5: Run and commit**

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/overlay-alignment.test.ts tests/unit/print-support.test.ts tests/unit/output-actions.test.tsx tests/unit/prescription-page.test.tsx tests/unit/prescription-history.test.tsx tests/integration/patient-history.test.ts`
Expected: PASS. Then by hand in Chrome and in Firefox: a prescription on a `pdf_only` overlay pad prints without the background in Chrome (HTML) and opens the paper PDF without the background in Firefox; the alignment check prints the dashed boxes shifted by the offset.

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/overlay-alignment.ts "src/app/(app)/templates/[id]/alignment/route.ts" src/components/templates/print-inspector.tsx src/lib/templates/print-support.ts src/server/services/template-preview.ts src/components/templates/template-editor.tsx src/components/rx/output-actions.tsx src/components/rx/rx-output-panel.tsx "src/app/(app)/prescriptions/[id]/page.tsx" src/server/services/patient-history.ts src/components/patients/prescription-history.tsx tests/unit/overlay-alignment.test.ts tests/unit/print-support.test.ts tests/unit/output-actions.test.tsx tests/unit/prescription-page.test.tsx tests/unit/prescription-history.test.tsx
Set-Location E:\projects\clinicpad; git commit -m "feat(templates): pre-printed paper, alignment check, printer offset and per-browser overlay print" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

## Task 20: Cross-tenant sweep, overlay visuals, the end-to-end flow, desktop build, ADRs, docs, and the Gate 2A verification

**Files:**
- Create: `tests/integration/template-cross-tenant.test.ts`, `tests/e2e/templates.spec.ts`
- Modify: `tests/e2e/helpers.ts` (move `completeProfile`, `registerPatient`, `startDraft`, `finalizeDraft` here from `tests/e2e/rx-output.spec.ts`, bodies unchanged, exported), `tests/e2e/rx-output.spec.ts` (import them), `tests/helpers/images.ts` (`makeLetterheadPng`), `tests/e2e/rx-visual.spec.ts` (overlay cases)
- Modify: `docs/DECISIONS.md` (ADR-0043 to ADR-0048), `docs/PROGRESS.md` (section 4.12, section 5, numbering), `docs/SETUP.md` (ClamAV, the PDF frame, the Gotenberg pin, the development switch), `AGENTS.md` (sections 2, 6, 8, 10)

**Interfaces:**
- Consumes: everything above; `minimalPdf` (`tests/helpers/pdfs.ts`), `registerClinic`, `cleanupClinic`, `setRole`, `ensureCatalogue`, `waitForEditor` (`tests/e2e/helpers.ts`).
- Produces: the Gate 2A evidence in `docs/PROGRESS.md` section 4.12.

- [ ] **Step 1: The cross-tenant sweep (spec section 12.3, one table, so a new route without a case fails review)**

`tests/integration/template-cross-tenant.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/scanning", async () => {
  const { sharedFakeScanner } = await import("../helpers/fake-scanner");
  return { getMalwareScanner: () => sharedFakeScanner };
});

import { getSessionContext } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { clinics, templateFiles } from "@/server/db/schema";
import { renderPrescriptionHtml } from "@/server/services/rx-output";
import { assignTemplate } from "@/server/services/template-assign";
import { getTemplateFile, uploadBackground } from "@/server/services/template-files";
import { renderTemplateAlignment, renderTemplatePreview } from "@/server/services/template-preview";
import { publishTemplate, rollbackTemplate } from "@/server/services/template-publish";
import {
  archiveTemplate,
  createOverlayTemplate,
  discardTemplateDraft,
  getTemplateEditor,
  listTemplates,
  saveTemplateDraft,
  startTemplateDraft,
  unarchiveTemplate,
} from "@/server/services/templates";
import { GET as getFile } from "@/app/(app)/templates/files/[fileId]/route";
import { GET as getPreview } from "@/app/(app)/templates/[id]/preview/route";
import { GET as getAlignment } from "@/app/(app)/templates/[id]/alignment/route";
import { finalized, newPatient } from "../helpers/rx-flow";
import { backgroundPng, insertPublishedOverlay, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
let A: TestTenant;
let B: TestTenant;
let a: Awaited<ReturnType<typeof insertPublishedOverlay>>;
let bRx = "";
const owner = () => B.as("owner");

beforeAll(async () => {
  A = await createTestTenant("tpl-x-a");
  B = await createTestTenant("tpl-x-b");
  a = await insertPublishedOverlay(A.tenantId, { label: "tenant-a-background" });
  bRx = await finalized(B.as("doctor"), await newPatient(B.as("reception"), "Tenant B Patient"));
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

type Case = { name: string; run: () => Promise<unknown> };
const notFound = (r: unknown) => expect(r).toMatchObject({ ok: false, code: "not_found" });

const serviceCases: Case[] = [
  { name: "getTemplateEditor", run: () => getTemplateEditor(owner(), a.templateId) },
  { name: "saveTemplateDraft", run: () => saveTemplateDraft(owner(), a.templateId, { definition: MINIMAL_OVERLAY_DEFINITION, labels: "en", baseRevision: 0 }) },
  { name: "startTemplateDraft", run: () => startTemplateDraft(owner(), a.templateId) },
  { name: "discardTemplateDraft", run: () => discardTemplateDraft(owner(), a.templateId) },
  { name: "publishTemplate", run: () => publishTemplate(owner(), a.templateId, { identity: "dynamic", boundDoctorId: null, confirmLetterhead: false, baseRevision: 0 }) },
  { name: "rollbackTemplate", run: () => rollbackTemplate(owner(), a.templateId, a.versionId) },
  { name: "archiveTemplate", run: () => archiveTemplate(owner(), a.templateId) },
  { name: "unarchiveTemplate", run: () => unarchiveTemplate(owner(), a.templateId) },
  { name: "assignTemplate (clinic)", run: () => assignTemplate(owner(), { scope: "clinic", templateId: a.templateId }) },
  { name: "createOverlayTemplate with A's file", run: () => createOverlayTemplate(owner(), { name: "X", fileId: a.fileId, paperSize: "A4", labels: "en", definition: MINIMAL_OVERLAY_DEFINITION }) },
  { name: "getTemplateFile", run: () => getTemplateFile(owner(), a.fileId) },
  { name: "renderTemplatePreview (sample)", run: () => renderTemplatePreview(owner(), a.templateId, { source: { kind: "sample", sample: "short" }, format: "html" }) },
  { name: "renderTemplatePreview with B's prescription on A's template", run: () => renderTemplatePreview(A.as("owner"), a.templateId, { source: { kind: "patient", prescriptionId: bRx }, format: "html" }) },
  { name: "renderTemplateAlignment", run: () => renderTemplateAlignment(owner(), a.templateId) },
];

describe("tenant B never reaches tenant A's templates (services)", () => {
  it.each(serviceCases)("$name answers not_found", async ({ run }) => {
    notFound(await run());
  });

  it("lists none of A's templates", async () => {
    expect(await listTemplates(owner())).toEqual({ ok: true, value: [] });
  });
});

describe("tenant B never reaches tenant A's templates (routes)", () => {
  const routeCases: Case[] = [
    { name: "GET /templates/files/<A's file>", run: () => getFile(new Request("http://localhost/x"), { params: Promise.resolve({ fileId: a.fileId }) }) },
    { name: "GET /templates/<A's template>/preview", run: () => getPreview(new Request(`http://localhost/templates/${a.templateId}/preview?sample=short`), { params: Promise.resolve({ id: a.templateId }) }) },
    { name: "GET /templates/<A's template>/alignment", run: () => getAlignment(new Request("http://localhost/x"), { params: Promise.resolve({ id: a.templateId }) }) },
  ];
  it.each(routeCases)("$name answers 404", async ({ run }) => {
    session.mockResolvedValue(owner());
    expect(((await run()) as Response).status).toBe(404);
  });
});

describe("tenant A's bytes never appear in tenant B's output", () => {
  it("stores B's own copy of identical bytes, and B's pads print B's background only", async () => {
    const [aFile] = await adminDb.select().from(templateFiles).where(eq(templateFiles.id, a.fileId));
    const uploaded = await uploadBackground(owner(), aFile.bytes);
    expect(uploaded.ok && uploaded.value.id !== a.fileId).toBe(true);
    const bPad = await insertPublishedOverlay(B.tenantId, { label: "tenant-b-background" });
    await adminDb.update(clinics).set({ customTemplateId: bPad.templateId }).where(eq(clinics.tenantId, B.tenantId));
    const rx = await finalized(B.as("doctor"), await newPatient(B.as("reception"), "Tenant B Overlay Patient"));
    const printed = await renderPrescriptionHtml(B.as("doctor"), rx, "preview");
    expect(printed.ok).toBe(true);
    if (!printed.ok) return;
    expect(printed.value.html).toContain(backgroundPng("tenant-b-background").toString("base64"));
    expect(printed.value.html).not.toContain(backgroundPng("tenant-a-background").toString("base64"));
  });
});
```

Run: `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/template-cross-tenant.test.ts`
Expected: PASS. (Every service filters on the caller's tenant on top of RLS; a new template service or route added later must get a row in these tables: reviewers check that.)

- [ ] **Step 2: Overlay visual cases**

Append to `tests/helpers/images.ts`:

```ts
/** A letterhead-like PNG (blue header band, green footer band, a light 10 mm grid) for overlay visual tests. */
export function makeLetterheadPng(width: number, height: number, paperHeightMm: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pxPerMm = height / paperHeightMm;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    const mm = y / pxPerMm;
    const band = mm < 40 ? [30, 64, 175] : mm > paperHeightMm - 15 ? [15, 118, 110] : null;
    for (let x = 0; x < width; x += 1) {
      const grid = Math.floor(x / pxPerMm) % 10 === 0 || Math.floor(mm) % 10 === 0;
      const rgb = band ?? (grid ? [225, 225, 225] : [255, 255, 255]);
      row[1 + x * 3] = rgb[0];
      row[2 + x * 3] = rgb[1];
      row[3 + x * 3] = rgb[2];
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
```

Append to `tests/e2e/rx-visual.spec.ts` (add the imports `import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";`, `import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";`, `import { makeLetterheadPng } from "../helpers/images";`, `import { a5Definition, overlayDefinition, overlayDocument, OVERLAY_VERSION_ID } from "../fixtures/overlay-documents";`):

```ts
type OverlayCase = { name: string; doc: RxDocument; def: OverlayDefinition; target: "screen" | "print" | "pdf"; pages: [number, number]; namePerPage: string };

const A4_BG = { mime: "image/png" as const, base64: makeLetterheadPng(827, 1170, 297).toString("base64"), width: 827, height: 1170 };
const A5_BG = { mime: "image/png" as const, base64: makeLetterheadPng(583, 827, 210).toString("base64"), width: 583, height: 827 };
const OVERLAY_CASES: OverlayCase[] = [
  { name: "overlay-a4-3-medicines", doc: overlayDocument(), def: overlayDefinition(), target: "pdf", pages: [1, 1], namePerPage: "Asha Rao" },
  { name: "overlay-a4-30-medicines", doc: overlayDocument({ items: manyItems(30) }), def: overlayDefinition(), target: "pdf", pages: [3, 6], namePerPage: "Asha Rao" },
  {
    name: "overlay-a5-12-medicines-hindi",
    doc: overlayDocument({ layout: { paperSize: "A5", labels: "bilingual" }, items: manyItems(12), snapshot: snapshot({ patient: { name: DEVANAGARI.name }, layout: { template: { kind: "overlay", templateVersionId: OVERLAY_VERSION_ID, contentSha256: "ab".repeat(32) }, paperSize: "A5", labels: "bilingual" } }) }),
    def: a5Definition(),
    target: "pdf",
    pages: [2, 5],
    namePerPage: "",
  },
  { name: "overlay-a4-preprinted-print", doc: overlayDocument({ items: manyItems(12) }), def: overlayDefinition({ background: { printMode: "pdf_only" }, printOffsetMm: { x: 1.5, y: -1 } }), target: "print", pages: [1, 3], namePerPage: "Asha Rao" },
  { name: "overlay-a4-page-numbers", doc: overlayDocument({ items: manyItems(30) }), def: overlayDefinition({ pageNumbers: { bandMm: 8 }, flow: { ...overlayDefinition().flow, bottomMm: 30 } }), target: "pdf", pages: [3, 6], namePerPage: "Asha Rao" },
  { name: "overlay-a4-draft-no-signature", doc: overlayDocument({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live", items: manyItems(12) }), def: overlayDefinition(), target: "screen", pages: [1, 3], namePerPage: "Asha Rao" },
];

async function textPerPage(pdf: ArrayBuffer): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) out.push((await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" "));
  return out;
}

for (const c of OVERLAY_CASES) {
  test.describe(`pad ${c.name}`, () => {
    const overlayAssets = { ...assets, overlay: { templateVersionId: OVERLAY_VERSION_ID, definition: c.def, background: c.doc.snapshot.layout.paperSize === "A5" ? A5_BG : A4_BG } };

    test("repeats the field boxes on every page, keeps rows whole, fetches nothing", async ({ page }) => {
      const rendered = renderPrescription(c.doc, overlayAssets, { target: c.target });
      const requests: string[] = [];
      page.on("request", (r) => {
        if (!r.url().startsWith("data:")) requests.push(r.url());
      });
      await page.setContent(rendered.html, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      const pages = await textPerPage(new Uint8Array(pdf).buffer);
      expect(pages.length).toBeGreaterThanOrEqual(c.pages[0]);
      expect(pages.length).toBeLessThanOrEqual(c.pages[1]);
      if (c.namePerPage) for (const text of pages) expect(text).toContain(c.namePerPage);
      expect(requests).toEqual([]);
    });

    test("renders through the real Gotenberg engine (PDFs kept for the human review)", async () => {
      test.setTimeout(120_000);
      const engine = createGotenbergEngine({ baseUrl: gotenbergUrl, renderTimeoutMs: 60_000 });
      const health = await engine.health();
      if (!health.up) {
        if (required) throw new Error(`Gotenberg is required here but not reachable at ${gotenbergUrl}: ${health.detail}`);
        test.skip(true, `Gotenberg is not reachable at ${gotenbergUrl}; run "docker compose up -d gotenberg".`);
      }
      const outcome = await engine.render(renderPrescription(c.doc, overlayAssets, { target: c.target }));
      if (!outcome.ok) throw new Error(`Gotenberg render failed: ${outcome.code}`);
      const pages = await textPerPage(outcome.pdf);
      expect(pages.length).toBeGreaterThanOrEqual(c.pages[0]);
      expect(pages.length).toBeLessThanOrEqual(c.pages[1]);
      if (c.namePerPage) for (const text of pages) expect(text).toContain(c.namePerPage);
      if (c.def.pageNumbers.bandMm > 0) expect(pages.at(-1)).toMatch(/Page \d+ of \d+/);
      if (visual) {
        mkdirSync(PDF_DIR, { recursive: true });
        writeFileSync(path.join(PDF_DIR, `${c.name}.pdf`), new Uint8Array(outcome.pdf));
      }
    });

    test("matches the reviewed screenshot (provisional tolerance, Q9)", async ({ page }) => {
      test.skip(!visual, "Set RX_VISUAL=1 (npm run test:visual) to compare screenshots; baselines are per platform.");
      await page.setViewportSize({ width: c.doc.snapshot.layout.paperSize === "A5" ? 560 : 794, height: 1123 });
      await page.setContent(renderPrescription(c.doc, overlayAssets, { target: "screen" }).html, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await expect(page).toHaveScreenshot(`${c.name}.png`, { fullPage: true, maxDiffPixelRatio: 0.001 });
    });
  });
}
```

Run: `Set-Location E:\projects\clinicpad; docker compose up -d gotenberg; $env:RX_VISUAL="1"; npx playwright test tests/e2e/rx-visual.spec.ts --update-snapshots`, then read every `overlay-*.png` written under `tests/e2e/rx-visual.spec.ts-snapshots/` and every `overlay-*.pdf` under `test-results/rx-visual-pdf/` (AGENTS §10): the letterhead and the boxes on every page, nothing under the header band or the footer band, no row cut in half, the page number in the bottom strip on the banded case only, no background on `overlay-a4-preprinted-print`, no signature image on the draft. Then run once more without `--update-snapshots`: PASS.

- [ ] **Step 3: The end-to-end flow and the roles**

Move `completeProfile`, `registerPatient`, `startDraft` and `finalizeDraft` from `tests/e2e/rx-output.spec.ts` into `tests/e2e/helpers.ts` unchanged, add `export` to each, and import them in `rx-output.spec.ts` (`import { cleanupClinic, completeProfile, ensureCatalogue, finalizeDraft, registerClinic, registerPatient, setRole, startDraft, waitForEditor, type Clinic } from "./helpers";`). Then `tests/e2e/templates.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { makeLetterheadPng } from "../helpers/images";
import { minimalPdf } from "../helpers/pdfs";
import { cleanupClinic, completeProfile, ensureCatalogue, finalizeDraft, registerClinic, registerPatient, setRole, startDraft, type Clinic } from "./helpers";

const clinics: Clinic[] = [];
test.beforeAll(async () => {
  await ensureCatalogue();
});
test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

test("an owner turns a scanned pad into a template, publishes it, and prints a prescription on it", async ({ page }) => {
  test.setTimeout(240_000);
  const started = Date.now();
  await page.addInitScript(() => {
    const top = window.top as unknown as { __printCalls?: number };
    top.__printCalls = top.__printCalls ?? 0;
    window.print = () => {
      top.__printCalls = (top.__printCalls ?? 0) + 1;
      window.dispatchEvent(new Event("afterprint"));
    };
  });
  clinics.push(await registerClinic(page, "tpl-e2e"));
  await completeProfile(page);

  await page.goto("/templates/new");
  await page.getByRole("radio", { name: /Photo or scan/ }).check();
  await page.getByLabel("Choose the photo or scan").setInputFiles({ name: "pad.png", mimeType: "image/png", buffer: makeLetterheadPng(1240, 1754, 297) });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Place the boxes" }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);

  const nameBox = page.getByRole("button", { name: /Patient's name box/ });
  await nameBox.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  const [preview] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "12 medicines (page 2)" }).click()]);
  await expect(preview.locator("table.flow")).toBeAttached();
  await expect(preview.getByText("SAMPLE · NOT A PRESCRIPTION")).toBeVisible();
  await preview.close();

  await page.getByRole("radio", { name: /does not show a doctor/ }).check();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/^Published\./)).toBeVisible();
  await page.getByRole("button", { name: "Use for the whole clinic" }).click();
  await expect(page.getByText(/Every prescription now prints on this pad/)).toBeVisible();
  test.info().annotations.push({ type: "setup-seconds", description: String(Math.round((Date.now() - started) / 1000)) });

  const patientUrl = await registerPatient(page, "Template E2E Patient");
  await startDraft(page, patientUrl);
  await finalizeDraft(page, "Paracetamol", /Rx #1/);
  await page.getByRole("button", { name: /^print$/i }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printCalls?: number }).__printCalls ?? 0)).toBe(1);
  const frame = page.frames().find((f) => f.url().includes("/document?purpose=print"));
  expect(frame, "the print frame").toBeDefined();
  await expect(frame!.locator("table.flow")).toBeAttached();
  await expect(frame!.locator(".box").first()).toHaveText("Template E2E Patient");
});

test("a PDF pad is read in the sandboxed frame and becomes a template", async ({ page }) => {
  test.setTimeout(120_000);
  clinics.push(await registerClinic(page, "tpl-e2e-pdf"));
  await page.goto("/templates/new");
  await page.getByRole("radio", { name: /^PDF/ }).check();
  await page.getByLabel("Choose the PDF").setInputFiles({ name: "pad.pdf", mimeType: "application/pdf", buffer: minimalPdf(595.28, 841.89, "E2E PAD") });
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByLabel("Paper size of this pad")).toHaveValue("A4");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Place the boxes" }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
});

test("reception cannot open Template Studio; a designer can, and sees no patients", async ({ page }) => {
  const clinic = await registerClinic(page, "tpl-e2e-roles");
  clinics.push(clinic);
  await setRole(clinic.email, "reception");
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Pad templates" })).toHaveCount(0);
  await page.goto("/templates");
  await expect(page).toHaveURL(/\/dashboard$/);
  await setRole(clinic.email, "designer");
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/templates$/);
  await page.goto("/patients");
  await expect(page).not.toHaveURL(/\/patients$/);
});
```

Run: `Set-Location E:\projects\clinicpad; docker compose up -d clamav gotenberg; npx playwright test tests/e2e/templates.spec.ts tests/e2e/rx-output.spec.ts`
Expected: PASS (ClamAV must be healthy, or set `CLAMAV_DISABLED_FOR_DEVELOPMENT=1` in `.env.local` for a local run and say so in the gate notes; CI always runs the real scanner). The first test's `setup-seconds` annotation is the scripted baseline for the 10-minute criterion; write it into PROGRESS 4.12.

- [ ] **Step 4: Decisions (ADR-0043 to ADR-0048)**

Append to `docs/DECISIONS.md` (check that ADR-0042 is the last entry first):

```markdown
## ADR-0043 — Phase 2 order: overlay pads first, DOCX after pilot evidence

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** Phase 2 must let a doctor print on their own pad within ten minutes. Many target doctors have a printed pad, a photo or a printer's PDF rather than a Word file, and DOCX brings the largest new attack surface (zip, XML, LibreOffice) and cannot print in the browser or offline (spec section 4).

**Decision:** Sub-plan 2A ships overlay pads (a background image plus field boxes and one flow region) on the existing HTML pipeline. DOCX (2B) starts only after pilot evidence on the formats doctors bring and Gate 1; docxtemplater core only, never paid modules. Spikes S1, S2, S4, S5 gated 2A; S3 is input for 2B.

**Consequences:** Word users print through "Save as PDF" in Word. The exit criterion "DOCX pad with overflow and a repeated header" waits for 2B.

**Revisit trigger:** pilot evidence that most partners bring editable Word pads, or a fidelity problem overlays cannot solve.

---

## ADR-0044 — Template model: immutable published versions, explicit assignment, letterhead identity, roles

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** A custom pad is clinic data that a signed prescription depends on, and a letterhead can carry one doctor's name and registration number.

**Decision:** `templates` (kind `overlay`; status `active | archived`; identity `dynamic | bound` with `bound_doctor_id`; `current_version_id`) and `template_versions` (born as drafts by trigger; a draft is a working copy under `draft_revision`; a published version is frozen on every connection; rollback publishes a copy as the next number). Assignment columns `clinics.custom_template_id` and `doctors.template_id` (composite keys, NO ACTION). At finalize the signer's own template wins, then the clinic default, then the built-in pad; a bound template is used only for its doctor and skipped for anyone else, and cannot be the clinic default. Publishing asks the letterhead question with no preselected answer and checks PRODUCT_SPEC 7.7's preconditions. Roles: `template.read` and `template.write` (owner, doctor for templates bound to them, designer), `template.publish` (owner), `template.assign` (owner; a doctor for their own profile). The `designer` role works on templates only and its membership must expire (`memberships.expires_at`, enforced by `getActiveMembership`). Lock order: the template-quota advisory lock, then the template row, then clinic or doctor rows; finalize takes no template lock.

**Consequences:** Binding is strict by default while the human decision Q6 is open; turning it off means publishing every pad as dynamic. There is no designer invite UI until 2C.

**Revisit trigger:** branch-level pads, a designer invite flow (2C), or a decision against binding.

---

## ADR-0045 — Snapshot v2 freezes a custom pad by version and content hash

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** ADR-0032 froze print data but left presentation free. A custom pad is the clinic's own artifact, so a reprint must use exactly the pad that was signed.

**Decision:** `render_snapshot` version 2: `layout.template` is `{ kind: "builtin", key }` or `{ kind: "overlay", templateVersionId, contentSha256 }`, with paper and labels from the version. `contentSha256` is the SHA-256 of the canonical JSON of the parsed definition, paper, labels and the stored file's hash. Finalize writes `prescriptions.template_version_id` in the same UPDATE (a CHECK ties a set column to the snapshot; a trigger refuses an unpublished version) and fails closed, without using an Rx number, when the pad is damaged. Every print, download, share open and preview reloads the version and file inside `withTenant`, re-hashes the bytes and the definition, and refuses to print on any mismatch. Version 1 snapshots are read as version 2 in memory. Amendments resolve their own pad (the amend column rule is now `reset`). Output rows record `template_version_id`, `engine` and the renderer version per kind (`1`, `overlay-1`).

**Consequences:** Renderer code, Chromium and fonts are still not frozen (recorded per output); a stored as-issued PDF (Q16) would be the stronger proof and needs object storage.

**Revisit trigger:** DOCX pads (2B adds the `docx` reference), or as-issued PDF storage.

---

## ADR-0046 — Upload pipeline: bytes decide, scan before store, PDFs read only in a sandboxed browser frame

- **Status:** accepted (supersedes the "no malware scan" note of ADR-0035)
- **Date:** 2026-11-18

**Context:** Uploads are hostile (invariant 8). Server actions are capped at 1 MB; LibreOffice and server-side PDF parsing are not needed for overlays.

**Decision:** `POST /templates/uploads` (route handler, session, `template.write`, `Sec-Fetch-Site`, 30 uploads per user per hour, streamed 2 MB cap). The bytes decide the type (PNG or JPEG only, nothing after the end marker, upright, long side 1,100 to 3,600 px, A-series proportions within 3 %); ClamAV `clamd` scans them over INSTREAM before any transaction (15 s timeout; down, slow or confused means refused, fail closed; infected is audited with the signature name); metadata is stripped and the stripped bytes are hashed and stored; the original bytes and the file name are never stored or logged. Logo and signature uploads are scanned the same way. `CLAMAV_HOST`/`CLAMAV_PORT` are mandatory in production; `CLAMAV_DISABLED_FOR_DEVELOPMENT=1` works only outside production. A PDF never reaches the server: pdf.js (pinned, eval off) runs in `<iframe sandbox="allow-scripts">` served by `/pdf-frame/*` with a CSP that allows scripts only from that path, and the parent accepts only well-formed messages from that frame's opaque origin.

**Scope by decision:** uploads of logos, signatures and pad backgrounds are scanned (original and stripped bytes); CSV patient import is NOT scanned (text parsed and validated, never stored as a file). Note for Tasks 15/16: a 23503 on `template_versions_file_fk` after a collectible file is deduped away must be reported as "upload the image again".

**Consequences:** About 1.5 to 2 GB of memory for clamd. freshclam shares the clamd container, which therefore has egress: split it before patient documents are stored (2C).

**Revisit trigger:** DOCX intake (2B), patient documents (2C), or a pdf.js advisory.

---

## ADR-0047 — Template files in Postgres behind a storage seam, with exact quotas

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** There is no object storage, and template files must share the guarantees of the rows that reference them.

**Decision:** `template_files` (bytea, forced RLS, composite keys, CHECKs mirroring the upload limits and the hash, immutable by trigger; `storage = 'pg'` is the seam and `loadTemplateFileIn()` the only reader). Per tenant: 20 active templates, 100 versions, 50 MB of files, checked under one advisory lock. Files no version uses are deleted at the next upload once they are 30 days old; the database refuses deleting a file in use (foreign key) or younger than a day (trigger).

**Consequences:** Database and backups grow by a few MB per clinic.

**Revisit trigger:** template bytes above 5 GB, or patient documents (2C).

---

## ADR-0048 — Overlay pads in the self-contained HTML pipeline; render targets; per-browser print; Gotenberg pin

- **Status:** accepted (extends ADR-0034)
- **Date:** 2026-11-18

**Context:** Overlay pads should keep every Plan 1C guarantee: self-contained documents, browser print without Gotenberg, the same text as built-in pads.

**Decision:** `renderOverlay` (pure) draws the background and every-page boxes `position:fixed` and first-page boxes absolute, and runs the body inside a table whose thead and tfoot spacers repeat on every page, using the built-in section and medicine renderers; CSS lengths come only from numbers of a parsed definition. Three targets: `screen`, `print` (printer offset; no background on pre-printed stationery) and `pdf` (background always, no offset). Page numbers are off by default; a 5 to 12 mm blank band puts them in Gotenberg's footer. Chromium browsers print overlay pads from HTML; Firefox and Safari print the Gotenberg PDF made for paper until the S1 human check passes for them (`OVERLAY_BROWSER_PRINT`). Gotenberg is pinned to the S5-verified 8.x digest (or stays on 8.11 if S5 said no), with one pin across compose, CI and the smoke test (`engine-pins.test.ts`). Overlay screenshot regression uses `maxDiffPixelRatio` 0.001, provisional until the human decides Q9.

**Consequences:** Body tables use ClinicPad's styling, not the doctor's own table design; phone photos print as photographed.

**Revisit trigger:** the S1 human check, Chromium `@page` margin boxes for browser page numbers, or DOCX (2B).
```

(If S5 said NO-GO, write the Gotenberg sentence as "Gotenberg stays on 8.11.0 for 2A (S5 said no: <reason>)". Write the `OVERLAY_BROWSER_PRINT` values the S1 finding recorded.)

- [ ] **Step 5: Progress, setup, and AGENTS.md**

`docs/PROGRESS.md`: add section `### 4.12 Phase 2A checklist (overlay pads)` with one checkbox per item, ticked only with the evidence named: spikes S1 to S5 (finding files); Gotenberg pin (Task 6 commit and PDF review note); template schema and guarantees (0024 to 0026); scanner and container (EICAR smoke in CI); upload pipeline; field catalogue; overlay renderer and goldens; snapshot v2 and resolution; output plumbing; roles and designer (0027); Template Studio list, wizard, editor, previews, publish, assign, history; print modes; cross-tenant sweep; e2e; visual PDF review (who, when); test totals (files, tests, skipped; e2e run and skipped) from the gate run. Under it, the exit criteria table from spec section 4.3 for 2A, each row with its evidence or PENDING: "photo/scan/PDF pad prints with real data" (e2e), "Hindi name" (golden, visual), "missing signature" (unit, visual draft case), "A4 and A5" (visual), "12 medicines overflow with repeated header and repeated patient boxes" (visual text-per-page check), "no cross-tenant read" (sweep), "median setup time on design partners" (PENDING: needs staging and the pilot; scripted baseline `<setup-seconds>` s). Add the funnel query for when staging exists:

```sql
-- Setup funnel per clinic (spec section 10.1): sign-up -> first upload -> first publish -> first prescription on a custom pad.
select t.id as tenant_id,
       t.created_at as signed_up,
       min(a.created_at) filter (where a.action = 'template_file.uploaded') as first_upload,
       min(a.created_at) filter (where a.action = 'template.published') as first_publish,
       min(a.created_at) filter (where a.action = 'prescription.finalized' and a.after ? 'templateVersionId') as first_custom_rx
  from tenants t left join audit_events a on a.tenant_id = t.id
 group by t.id, t.created_at;
```

In section 5, replace the "**Next:**" paragraph with: Phase 2A is code complete (date, gate result); 2B needs pilot evidence, Gate 1, the S3 finding and staging with the office container egress-blocked; Phase 2B ADRs start at ADR-0049 and its migrations at 0028.

`docs/SETUP.md`: a ClamAV section (`docker compose up -d clamav`, first start takes minutes, `docker compose ps clamav` until healthy, memory, `CLAMAV_DISABLED_FOR_DEVELOPMENT=1` for machines that cannot run it, never in production); the PDF frame (`/pdf-frame/*` is public static code, kept out of the desktop export); the Gotenberg pin and the visual review after any engine change; `$env:CLAMAV_REQUIRED="1"` for the smoke test.

`AGENTS.md`: in section 2 add a "Repository state" sentence for Phase 2A (what exists: overlay pads, Template Studio, ClamAV scanning, snapshot v2; what does not: DOCX, object storage, designer invites); in section 6 add `docker compose up -d clamav`; in section 8 replace "Next" with the 2B gate; in section 10 add these bullets:

- **A finalized overlay prescription prints only from its frozen template version, verified by hash** (`loadOverlayIn`). Never render a finalized prescription with a template's current version; a mismatch fails closed with `TEMPLATE_DAMAGED_MESSAGE`. The content hash covers the PARSED definition (lengths rounded to 0.1 mm, unknown keys dropped): hash what `parseOverlayDefinition` returns, never the raw jsonb (ADR-0045).
- **Template versions are born as drafts; a published version and every template file are frozen on every connection.** A template with a published version cannot be deleted (archive it). Lock order: `lockTemplateQuota` (advisory) first, then the template row (`FOR UPDATE` to change it or its versions, `FOR SHARE` to assign it), then clinic or doctor rows; finalize takes no template lock (ADR-0044).
- **Uploads go through route handlers with `readCapped`, never server actions (1 MB).** Scan before any transaction; a scanner that is down refuses the upload. `CLAMAV_DISABLED_FOR_DEVELOPMENT=1` is development only. Never commit the EICAR string: tests decode it from base64 (`tests/helpers/eicar.ts`) because Windows Defender quarantines the file otherwise (ADR-0046).
- **pdf.js runs only inside `/pdf-frame/*`** (an opaque-origin sandboxed iframe); `src/app/pdf-frame` is in `SERVER_ONLY` of `scripts/build-desktop.mjs`; app code never imports `pdfjs-dist` (tests may, in Node).
- **drizzle-kit asks about renames** when one generate both drops and adds columns of a table: generate the drop alone first (0024). A new enum value cannot be used as an enum literal in the same migration run (all pending migrations share one transaction): compare `role::text` (0027).
- **Tests simulate tampering with `set local session_replication_role = replica`** on the admin connection (superuser only), which skips the immutability triggers; CHECK constraints still apply.
- **A designer membership must expire** (`memberships_designer_expiry_check`); `setRole` in the e2e helpers sets seven days.

- [ ] **Step 6: Gate 2A verification**

```powershell
Set-Location E:\projects\clinicpad; docker compose up -d postgres gotenberg clamav
Set-Location E:\projects\clinicpad; npx drizzle-kit generate
Set-Location E:\projects\clinicpad; $env:GOTENBERG_REQUIRED="1"; $env:CLAMAV_REQUIRED="1"; npx vitest run tests/integration/gotenberg-smoke.test.ts tests/integration/clamav-smoke.test.ts tests/unit/engine-pins.test.ts
Set-Location E:\projects\clinicpad; node scripts/verify-gate-0.mjs
Set-Location E:\projects\clinicpad; $env:RX_VISUAL="1"; npx playwright test tests/e2e/rx-visual.spec.ts
Set-Location E:\projects\clinicpad; git status --porcelain
```

Expected: "No schema changes"; both smoke tests and the pin test PASS (not skipped); `verify-gate-0` PASSES (lint, typecheck, unit and integration tests, `build:web`, `build:desktop`, e2e); the visual run PASSES and its PDFs were reviewed by a person (name and date in PROGRESS 4.12); `git status` shows only the docs you are about to commit. Record the totals.

- [ ] **Step 7: Commit the docs**

```powershell
Set-Location E:\projects\clinicpad; git add tests/integration/template-cross-tenant.test.ts tests/e2e/templates.spec.ts tests/e2e/helpers.ts tests/e2e/rx-output.spec.ts tests/e2e/rx-visual.spec.ts tests/e2e/rx-visual.spec.ts-snapshots tests/helpers/images.ts
Set-Location E:\projects\clinicpad; git commit -m "test(templates): cross-tenant sweep, overlay visuals and the Template Studio e2e flow" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
Set-Location E:\projects\clinicpad; git add docs/DECISIONS.md docs/PROGRESS.md docs/SETUP.md AGENTS.md
Set-Location E:\projects\clinicpad; git commit -m "docs: record Phase 2A decisions (ADR-0043..0048), Gate 2A evidence and setup" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

(`tests/e2e/rx-visual.spec.ts-snapshots` is a directory of reviewed baselines: add the new `overlay-*.png` files by name, e.g. `git add tests/e2e/rx-visual.spec.ts-snapshots/overlay-a4-3-medicines-chromium-win32.png …`, never the bare directory.)

---

## Self-review

**1. Spec coverage (sub-plan 2A, spec section 15.1 and the controller's list).**

| Spec item | Task |
|---|---|
| Spikes S1, S2, S5 (gate 2A); S4 (ClamAV footprint, needed by 2A's scanner); S3 (2B input, non-gating) | 1, 2, 4, 3, 5 |
| Gotenberg upgrade (D14) with drift/smoke/visual re-baseline and human PDF review | 6 |
| Template tables, assignment columns, output columns, immutability triggers, RLS, composite keys, CHECKs in Drizzle; migrations from 0024 | 7 (0024–0026), 15 (0027) |
| Upload route with byte cap, `Sec-Fetch-Site`, per-user limit; background limits; ClamAV with fake and container, EICAR tests; quotas under an advisory lock; lazy GC; audit; logo/signature retrofit | 8, 9 |
| PDF rasterized in the browser in an opaque-origin sandboxed iframe (D2) | 2, 16 |
| Field catalogue and `toTemplateData`, samples (en, hi, long, blank) | 10 |
| `render.ts` split with unchanged goldens; overlay definition schema; overlay renderer with goldens and `checkSelfContained` | 10, 11, 12 |
| Snapshot v2 with v1 parser; resolution with the identity rule; `template_version_id` at finalize; hash check at reprint; amend rule `reset`; draft would-be resolution | 13, 14 |
| Render dispatch, loader with version and background inside `withTenant`, output log (`template_version_id`, `engine`), share route, renderer versions | 13, 14 |
| Roles (`template.*`, designer, `memberships.expires_at`); create, draft edit, validate, publish, rollback, archive, assign, audit | 9 (actions), 15 |
| Studio UI: list, source choice, upload (image and PDF), crop/rotate, paper confirmation; box editor (drag, keyboard, fields, fonts, body style), auto-layout, live overflow warnings | 16, 17 |
| Previews (sample, long, blank, real patient audited), publish and assign | 18 |
| Print modes: `pdf_only`, alignment check, print offset, per-browser fallback from S1 | 12, 19 |
| Cross-tenant sweep, overlay visual tests with human PDF review, e2e flow and roles, `build:desktop`, middleware matcher, ADR-0043 to ADR-0048, PROGRESS, setup notes, Gate 2A | 9 (matcher), 16 (desktop), 20 |
| Fonts and Hindi (embedded Noto Sans Devanagari, Devanagari text in boxes) | 12 (golden), 17 (editor font), 20 (visual) |
| Paper A4/A5 only; proposal from the PDF page size, confirmation by the user | 16 |
| Known limits honestly stated (page numbers vs full bleed, Safari/Firefox, table style, photo quality) | 12, 19, ADR-0048 |

Deliberately not in 2A (spec section 14 or 2B/2C): DOCX anything, the "did you mean" suggestion for unknown DOCX tags (overlay fields come from a picker), `input_sha256` on outputs (equal to `html_sha256` for HTML; 2B), the freshclam split (before 2C), designer invites (2C), branch-level assignment, the PDF cache, as-issued PDFs.

**2. Placeholder scan.** No "TBD" or "implement later". The values that cannot be known when planning are named outputs of a spike and copied by exact name: `PDFJS_VERSION` and the worker strategy (S2 → Task 16 Steps 1 and 5), `CLAMAV_IMAGE`/`CLAMAV_OPTIONS`/`CLAMAV_MEM_LIMIT` (S4 → Task 8 Step 10), `GOTENBERG_IMAGE`/`FLAGS` (S5 → Task 6 Step 3), `OVERLAY_BROWSER_PRINT` (S1 → Task 19 Step 2), `DPI` (S2 → Task 16 Step 6). Each finding's Decision section is specified to print them in that form.

**3. Type and name consistency (checked across tasks).** `RenderTarget`, `OverlayInput`, `RenderAssets.overlay` (Task 12) are used by Tasks 13, 14, 18; `TemplateRef`/`PadLayout` come from the snapshot (Task 13) and are what `resolveTemplateIn`, `loadOverlayIn`, `outputTemplateColumns` and the preview service use; `renderPrescription(doc, assets, { target, sample })` (Task 13) is called the same way in Tasks 14, 18, 20; `templateContentSha256` (Task 13) is used by the helpers (13), publish (15); `lockTemplateQuota` and `TEMPLATE_QUOTAS` (Task 9) by Task 15; `TemplateEditorView.summary/draft/history` (Task 15) by the pages (17, 18); `TemplateActionState` fields (`ok`, `error`, `revision`, `currentRevision`, `templateId`) match every component that reads them; `MINIMAL_OVERLAY_DEFINITION` lives in `tests/fixtures/overlay-definitions.ts` and is re-exported by `tests/helpers/templates.ts`; the box id regex `^[a-z0-9-]{1,24}$` admits both `b<n>` (editor) and `name`/`age`/`date`/`rx` (defaults).

**4. Review Focus.** The five lines at the top each have a test in the owning task: reprint after change and tampering (Tasks 13, 14); Dr B never on Dr A's letterhead (Tasks 13, 15); hostile uploads including chunked bodies and a down scanner (Tasks 8, 9); long, missing and hostile values in fixed boxes with 30 medicines (Tasks 12, 20); concurrency — double publish, revision conflicts, archive versus assign, quota race (Tasks 9, 15).

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-18-phase-2a-overlay-templates.md`. Spikes first (Tasks 1–5, partly human: the Safari/Firefox print preview in Task 1 Step 7), then Tasks 6–20 in the order above. Recommended: subagent-driven execution with the reviewer named per task (opus for every database, security, renderer, snapshot and concurrency task), because the tasks hand exact interfaces to each other and a shipped mistake in the schema, the scanner or the snapshot is a medico-legal or tenant-isolation defect.

