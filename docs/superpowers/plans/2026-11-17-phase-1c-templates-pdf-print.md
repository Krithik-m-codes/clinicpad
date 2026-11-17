# ClinicPad Phase 1C — Template Renderer, Built-in Pads, Server PDF, and Print

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A finalized prescription prints and downloads as a real pad — clinic and doctor header from settings (logo and signature included), patient details frozen at finalize, one of three built-in templates (General, Paediatric, Derma) on A4 or A5 with English, Hindi, or bilingual labels — through one pure HTML renderer whose output feeds the browser print dialog and a Gotenberg-generated PDF, with every print and download recorded in an append-only log and the audit trail.

**Architecture:** A pure renderer in `src/lib/rx-render/` turns an `RxDocument` (frozen snapshot + clinical content) into a self-contained HTML string (inline CSS, fonts and images as `data:` URIs, a `default-src 'none'` CSP, no scripts) using an auto-escaping `html` tagged template, so hostile text can never become markup. Finalize writes `prescriptions.render_snapshot` (patient, clinic, doctor, layout as of that moment) in the same UPDATE that freezes the row. Server code loads a document through RLS (`loadRxDocument`), renders it, checks it is self-contained, and either serves it to a hidden print iframe or posts it to Gotenberg's Chromium route through an injectable `PdfEngine`; each output appends a `prescription_outputs` row plus an audit event with ids and counts only.

**Tech Stack:** Next.js 15.5 (App Router, route handlers, server actions), React 19, TypeScript strict, Drizzle ORM 0.45 + drizzle-kit 0.31, Postgres 16 with forced RLS, Zod 4, Vitest 5 (+ Testing Library), Playwright, Gotenberg 8 (Chromium route) in Docker, `@fontsource/noto-sans-devanagari` (new, OFL).

**Spec:** `docs/superpowers/specs/2026-11-06-clinicpad-platform-design.md` (roles §4, domain model §7). Workstreams: `docs/ROADMAP.md` §3 rows 1.5 and 1.6 and the print part of 1.9. Rendering rules: `docs/ARCHITECTURE.md` §6.1, §6.2, §6.5; `docs/PRODUCT_SPEC.md` §6.3 (print, A4/A5, repeated header), §7.3 (placeholder names), §7.5 (fonts, overflow, determinism). Gotenberg decision: `docs/DECISIONS.md` ADR-0007 and ADR-0014. The code this plan builds on was written by `docs/superpowers/plans/2026-11-12-phase-1a-patients-and-prescription-core.md` (Plan 1A) and `docs/superpowers/plans/2026-11-16-phase-1b-clinical-form-and-medicines.md` (Plan 1B; read its last section "What Plan 1C expects from 1B"). Both plans were changed by review rounds while they ran; this plan was reconciled against the **code** at HEAD `4747932` (branch `phase-1-prescription-mvp`), and where the code and those plans differ, the code wins.

## Prerequisites

Plans 1A and 1B are merged on `phase-1-prescription-mvp` (HEAD `4747932` or later). From PowerShell:

```powershell
Set-Location E:\projects\clinicpad; Test-Path src/server/services/rx-mapping.ts, src/lib/domain/rx-format.ts, src/lib/domain/rx-options.ts, src/lib/domain/text.ts, src/server/validation/text.ts, src/components/rx/prescription-view.tsx, src/components/rx/clinical-editor.tsx, src/components/rx/repeat-form.tsx, src/components/rx/discard-draft-form.tsx, src/components/patients/allergy-banner.tsx, src/server/actions/drafts.ts, src/server/services/catalogue.ts, tests/helpers/tenant.ts, tests/e2e/helpers.ts, tests/unit/prescription-page.test.tsx
Set-Location E:\projects\clinicpad; Get-ChildItem drizzle -Filter *.sql | Select-Object -ExpandProperty Name
Set-Location E:\projects\clinicpad; Select-String -Path src/server/auth/session.ts -Pattern "getSessionContext"
Set-Location E:\projects\clinicpad; npm run test
```

Expected: fifteen `True` lines; the migration list ends with `0012_phase1b_catalogue_security.sql` (so this plan's migrations are `0013_phase1c_print.sql` and `0014_phase1c_print_security.sql`); `getSessionContext` is found; `npm run test` reports **48 files, 872 tests passed** at `4747932` (Plan 1B's gate on 2026-11-17; the e2e suite has 18 tests: smoke 6, patients 4, prescriptions 6, clinical-form 2). If the Plan 1B final-review fixes were committed since (see the text-rules bullet below), the counts are higher: write down what you see; it is the baseline for the totals quoted in Tasks 1 and 11. If Postgres is not running, start Docker Desktop (on this machine it lives under `%LOCALAPPDATA%\Programs\DockerDesktop`, not Program Files), then `docker compose up -d postgres`.

What the code at HEAD looks like, and what this plan relies on (checked file by file):
- **Immutability (ADR-0023):** migrations `0004`, `0005`, `0006`, `0008` freeze a prescription once `old.status <> 'draft'`: any column change is refused with SQLSTATE `23000`, even on the admin connection, except the `finalized -> amended` flip that changes only `status` and `updated_at`. While `old.status = 'draft'` every column may change, so a column written by the finalizing UPDATE is frozen with the row by the existing trigger (new columns need no trigger change). Finalized rows can be deleted only by deleting their tenant (`tenant_is_erased`). The item trigger reads its parent `FOR SHARE`; a draft visit whose prescription is no longer a draft accepts only the plain flip to `finalized` (`status`, `finalized_at`, `updated_at`).
- **Composite same-tenant keys (ADR-0025):** every relation between tenant-owned tables is `(tenant_id, x_id) -> parent(tenant_id, id)` with an explicit constraint name, backed by `unique (tenant_id, id)` named `<table>_tenant_id_uq` (`patients`, `visits`, `prescriptions`, `clinics`, `branches`, `templates`, `template_versions`, and since 0010 `doctors`, which also has `doctors_tenant_user_uq` on `(tenant_id, user_id)`). 0010 added `visits_doctor_fk`, `visits_branch_fk`, `prescriptions_template_version_fk` (hand-written `ON DELETE SET NULL (col)`). The guard test in `tests/integration/tenant-fk.test.ts` ("has no single-column key into a tenant-owned table", allow-list empty) fails on any single-column key into a table that has `tenant_id`. drizzle-kit emits foreign keys before the unique constraints they need; every migration was reordered by hand.
- **`finalizePrescription(ctx, id, opts: { expectedRevision?: number } = {})`** in `src/server/services/prescriptions.ts`: locks the row `FOR UPDATE` first; `conflict` unless `status = 'draft'`; `conflict` when `expectedRevision` differs from `draft_revision`; `invalid` (field `items`) with no items; reads the visit; first versions (`parentPrescriptionId === null`) allocate the next Rx number, amendments must already carry their parent's number (else `conflict`); one `now`; UPDATE prescription (`status`, `rxNo`, `finalizedAt`, `finalizedBy`), then the plain visit flip, then (amendments) the parent flip to `amended` (child-then-parent lock order, safe because `amendPrescription` checks before it writes); audit `prescription.finalized` or `prescription.amended` with `{ rxNo, version[, parentPrescriptionId], ...clinicalSummary(visit, itemCount) }`; `23000` maps to `immutable`. The editor calls it only through `finalizeDraftAction(prescriptionId, payload, baseRevision)` (`src/server/actions/drafts.ts`), which saves first and then finalizes `{ expectedRevision: saved.revision }`; that signature does not change.
- **`amendPrescription` and `repeatPrescription`** insert prescriptions with explicit column lists, so nothing this plan adds to `prescriptions` is copied to a new version. `amendVisitValues` copies every **visit** column; `repeatPrescription` refuses drafts, `amended` (superseded) sources, and sources with an open amendment, and reads the source `FOR SHARE`. `discardDraft` deletes only drafts.
- **`getPrescription(ctx, id)` → `PrescriptionView`** `{ id, status, version, revision, rxNo, amendmentReason, parentPrescriptionId, finalizedAt, patient: { id, name, patientNo, allergies }, visit: ClinicalVisitView, items: ItemView[] }`; the patient is read **live**; three reads with a revision re-check, else `conflict`. `ClinicalVisitView` and `ItemView` live in `src/server/services/rx-mapping.ts` (with `toVisitView`, `toItemView`, `clinicalSummary`). Clinical columns: `visits.chief_complaint`, `complaints[]`, `diagnosis[]`, `medical_history[]`, `drug_history[]`, `examination_notes`, `vitals` jsonb (`bpSystolic`, `bpDiastolic`, `pulse`, `temperatureF` (°F only), `spo2`, `respiratoryRate`, `weightKg`, `heightCm`, `bloodSugarMgDl`, `notes`), `investigations` jsonb (`{ name, instructions? }[]`), `advice`, `follow_up_date`, `follow_up_reason`; items `drug_name`, `generic_name`, `strength`, `form`, `route`, `dose`, `dose_morning|afternoon|evening|night` (numeric, quarter steps), `timing`, `food_relation`, `periodicity`, `is_sos`, `duration_value` + `duration_unit` (`days|weeks|months`), `duration_days` (derived), `remarks`; pre-1B items read as days.
- **The prescription page** (`src/app/(app)/prescriptions/[id]/page.tsx`): no role redirect — forbidden, malformed, unknown, and foreign ids all become `notFound()`, and a read `conflict` renders a "This prescription changed while loading." refresh state; the header shows the live patient name and `<AllergyBanner allergies showWhenEmpty />`; drafts render `<ClinicalEditor … canAddToClinic canFinalize />` for `rx.draft` roles (everyone else gets `<PrescriptionReadOnly rx />`, with no draft marking today) plus `<DiscardDraftForm>`; Amend (`AmendForm`) and Repeat (`RepeatForm`) appear only for `status === "finalized"`; superseded versions carry no marker today. `tests/unit/prescription-page.test.tsx` (8 tests) renders the page with mocked services.
- **Text rules (Plan 1A final fix wave and Plan 1B Tasks 1 and 3):** `cleanText` (`src/lib/domain/text.ts`) applies NFC, turns NEL/U+2028/U+2029/CR into LF, and strips C0/C1 controls, zero-width space, soft hyphen, BOM, word joiner, bidi embeddings/overrides/isolates (U+202A–202E, U+2066–2069) and lone surrogates, but keeps ZWJ/ZWNJ (Devanagari conjuncts). It strips NUL too, so **free text is validated with `cleanInput` / `cleanOptionalText(max)` / `cleanRequiredText(max, message)` and `hasNoNul` + `NUL_MESSAGE` from `src/server/validation/text.ts`: a NUL is refused with a field error, never silently dropped.** Length messages read "Keep this to at most N characters". (At reconcile time a Plan 1B final-review fix wave was in the working tree, uncommitted: it also strips direction marks U+200E/U+200F/U+061C, invisible operators U+2061–2064, U+180E and the tag block, iterates by code point, and runs `cleanInput` on patient fields and the amend reason; the same wave adds `path?` to `ServiceError` (`src/lib/result.ts`) and `ActionFailure`, and changes autosave and editor internals without changing `ClinicalEditor`'s props or `finalizeDraftAction`'s signature. Helper names, the NUL rule, the `ErrorCode` line Task 9 edits, and every interface this plan consumes are unchanged, so nothing below depends on whether it has landed; if it changed something this plan prints, keep its version.)
- **Roles (`src/lib/domain/permissions.ts`, ADR-0026/0030):** `rx.read` = owner, doctor, reception, nurse, pharmacist; `rx.draft`/`rx.finalize`/`rx.amend` = owner, doctor; the last `MATRIX` entry is `"catalogue.write"`. `tests/unit/permissions.test.ts` has a typed `granted: Record<Action, …>` matrix, so a new action must be added there too or typecheck fails. The settings page today is owner-only (`role !== "owner"` redirects to `/dashboard`).
- **Sessions:** `requireSession()` redirects; `getSessionContext()` returns `null` (route handlers, editor actions). The middleware matcher is `["/dashboard/:path*", "/patients/:path*", "/settings/:path*"]` — `/prescriptions` is missing (a Plan 1A follow-up assigned here).
- **Tests:** `createTestTenant(label)` (`tests/helpers/tenant.ts`) creates a tenant, one user, and one doctor profile (no clinic row, no `display_name`, no registration number); `as("owner")` and `as("doctor")` share that user, every other role gets a random user id. e2e helpers (`tests/e2e/helpers.ts`): `registerClinic(page, label)` (owner "Dr. E2E Tester"), `cleanupClinic(email)`, `setRole(email, role)`, `withAdminSql`, `seedPatients`, `ensureCatalogue()`, `waitForEditor(page)` (the editor is disabled until hydrated; always wait before typing into it). Playwright labels overlap ("Dose" is inside "Morning dose"), so use `exact: true` and row scoping; `getByRole("alert")` also matches Next's route announcer.
- **Desktop build:** `scripts/build-desktop.mjs` stashes `src/app/(app)`, `src/app/(auth)`, `src/app/api/auth`, `src/app/api/health`, `src/app/api/catalogue`, `src/app/api/clean-data`, `src/app/page.tsx`, `src/middleware.ts`.
- Every replacement below prints the current code plus this plan's change. If the code moved again before you start (a later fix), keep its behaviour and apply only the change this plan describes.

## Where this plan sits in Phase 1

| Plan | Roadmap workstreams | Ships |
|---|---|---|
| 1A (done) | 1.1 core, 1.2 lifecycle, 1.8 list, 1.9 audit | Patients + immutable, audited prescription lifecycle |
| 1B (done) | 1.3 clinical form, 1.4 medicine catalogue, 1.2 autosave | Server-backed clinical form, catalogue, lossless autosave |
| **1C (this plan)** | 1.5 template renderer + 3 built-in templates, 1.6 server PDF + print, 1.9 print audit | A prescription that looks like a pad, prints, and downloads as PDF |
| 1D | 1.7 sharing, 1.1 rest (CSV import, merge), 1.8 filters, 1.10 hardening | Pilot-ready for design partners |

Do not pull 1D or Phase 2 work into this plan: no WhatsApp or email, no DOCX upload, no overlay templates, no Template Studio, no object storage, no CSV import, no app-UI Hindi strings.

## Decisions made in this plan

Each line: decision — reason — cost if wrong. Task 11 records the durable ones as ADR-0032 to ADR-0035 (ADR-0022 to ADR-0026 are Plan 1A's and ADR-0027 to ADR-0031 Plan 1B's; re-check that ADR-0032 is still the next free number before writing them).

1. **Finalize freezes what the pad prints in `prescriptions.render_snapshot jsonb`** (patient name, patient no., gender, date of birth, age at the visit, allergies; clinic name, address lines, phone, email, footer lines, logo asset id, timezone; prescribing doctor's name, qualifications, designation, registration number and council, signature asset id; template, paper size, label language), written by the same UPDATE in `finalizePrescription` that moves the row from draft to finalized — the existing trigger allows any column change while `old.status = 'draft'` and freezes the row afterwards (the `finalized -> amended` flip compares every other column, the snapshot included), so the snapshot is immutable with no new trigger; amend and repeat insert prescriptions with explicit column lists, so a new version never inherits a snapshot and gets its own at its own finalize; a reprint of an old prescription must not show a later edit of the patient or the doctor — if live demographics are ever wanted, the renderer can read live data without a schema change.
2. **Drafts and prescriptions finalized before this plan have no snapshot and render from live data; the latter print a small note saying so** — the immutability triggers forbid a backfill `UPDATE`, and every existing row is demo data (AGENTS.md §2) — a one-off admin backfill if real pre-1C prescriptions ever matter. The demo seed (`src/server/db/seed.ts`) also finalizes without a snapshot, so demo prescriptions print the note; `buildRenderSnapshot` must not be called from the seed, because it relies on RLS to scope its reads and the seed runs on the admin connection.
3. **Finalize never blocks on an incomplete doctor profile, or on a prescriber with no doctor profile at all** (today an owner without a doctor row can finalize; Plans 1A/1B left that to a human decision and asked this plan to warn). A missing doctor name or registration number prints blank; the draft page warns before finalizing ("Your doctor profile is missing …", or "You have no doctor profile in this clinic …") and the finalized page says what the copy lacks — keeps Plan 1A/1B's lifecycle and tests unchanged and keeps the pilot moving — if the clinic must never print without a registration number, add one precondition to `finalizePrescription` and give `createTestTenant` a registration number.
4. **Print and PDF metadata live in an append-only `prescription_outputs` table** (who, when, kind, template, paper, page count, PDF size, SHA-256 of the exact HTML) **plus one audit event per output**; nothing is written to `prescriptions` after finalize — finalized rows are frozen, and audit stays a compliance log rather than a UI data source — two small writes per print.
5. **Generated PDFs are not stored; every download is regenerated from frozen inputs.** The HTML of a reprint is byte-identical (its SHA-256 is recorded and tested); Chromium PDF bytes differ only in metadata — there is no object storage yet and PHI-bearing PDFs need retention rules — one Gotenberg call (~0.3–1 s) per download; add a cache keyed by `html_sha256` with Phase 2 storage.
6. **The renderer is pure TypeScript with an auto-escaping `html` tagged template, not React `renderToStaticMarkup`** — it runs in route handlers, workers, tests, and later Tauri, with no Next.js `react-dom/server` restrictions, and an interpolation cannot be emitted unescaped unless wrapped in `raw()` — verbose templates; revisit if template logic grows.
7. **Template model seam: the snapshot stores `{ kind: "builtin", key }`; built-in templates are data (`TemplateDefinition`: sections, vitals, medicine-table layout, accent colour) drawn by one renderer.** `renderPrescription(doc, assets)` dispatches on `kind` and returns a `RenderedDocument`; Phase 2 adds `"docx"` and `"overlay"` kinds and their renderers behind the same call (those kinds will use `prescriptions.template_version_id`, which has had a composite key since 0010 and stays `null` for built-in pads) — nothing of Phase 2 is built here — low.
8. **Template, paper size, and label language are clinic-level settings, frozen into the snapshot at finalize; there is no per-print choice** — the same prescription always prints the same — per-doctor or per-branch assignment arrives with Template Studio.
9. **Labels: `en`, `hi`, or `bilingual`.** Headings and coded values (food relation, frequency, duration units, gender, age units) are localized for the printed pad only, reusing `src/lib/translations.ts` strings where they exist (every key `labels.ts` reads exists there today); free text prints exactly as entered — `src/lib/domain/rx-options.ts` says Hindi labels for the app UI arrive with Plan 1D, keyed by the same codes, and Plan 1D can reuse `labels.ts` — a wrong Hindi word is a one-line fix in `labels.ts`; a native speaker should read the new Hindi words before a pilot.
10. **Repeating header without JavaScript:** the page is one outer `<table>` whose `<thead>` holds the pad header and `<tfoot>` the pad footer (both repeat on every printed page in Chromium, Gotenberg, and Safari); the medicines table has its own repeating `<thead>`; rows never split (`break-inside: avoid`). "Page X of Y" appears only in the Gotenberg PDF footer (Chromium footer template) — browser print gets no page numbers — acceptable for Phase 1.
11. **Fonts: Noto Sans Devanagari (Devanagari + Latin subsets, weights 400 and 700) from `@fontsource/noto-sans-devanagari`, inlined as `data:` URIs in every document** — identical glyphs in Gotenberg and every browser, no dependency on container or OS fonts, works offline — about 300–400 KB per document.
12. **Gotenberg cannot fetch anything:** every document passes `checkSelfContained()` before it is served or sent; the document carries a `default-src 'none'` CSP; Gotenberg runs with `--chromium-disable-javascript=true`; a real-service test proves the CSP blocks an image beacon; production must also block the container's egress (documented) — local Docker cannot enforce egress on a container with a published port — low.
13. **Print = a hidden same-origin iframe that loads the HTML document and calls `print()`; Download PDF = Gotenberg.** When Gotenberg is down, Print still works and Download shows a clear error — printing never depends on the PDF service — print-dialog output can differ slightly between browser engines; the PDF is the canonical copy.
14. **Drafts preview only.** A draft renders as HTML with a repeated "DRAFT · NOT VALID FOR DISPENSING" watermark and banner, no Rx number, and is not audited; printing or downloading a draft returns 409 and is also refused by a database trigger on `prescription_outputs`. On the page, a draft shown to a role that cannot edit it (reception, nurse, pharmacist) now carries a "This draft is not a prescription yet" notice (it was unmarked; a Plan 1A follow-up). **Superseded (amended) versions stay printable as read-only history**, with a repeated "SUPERSEDED by version N" banner and watermark on the pad and a "Superseded by version N" notice with a link on the page; Repeat and Amend stay offered only on the current finalized version (the page already gates them on `status === "finalized"`; `repeatPrescription` refuses an amended source and a source with an open amendment) — low.
15. **Clinic logo and doctor signature are stored in Postgres (`clinic_assets`, `bytea`, ≤ 512 KB), immutable and de-duplicated by SHA-256; snapshots reference asset ids** — there is no object storage yet and the data stays in the India-region database; an immutable asset row means a reprint keeps the signature it was signed with — move bytes to S3-compatible storage later behind `loadImageAssets()`.
16. **Uploads accept PNG and JPEG only, detected from the bytes (never the declared type), 16–2000 px per side, no data after the image's end marker.** No malware scan and no EXIF stripping in this phase: the images are only header-parsed and embedded into a JavaScript-free sandboxed Chromium, and carry no patient data — ClamAV and re-encoding arrive with the Phase 2 upload pipeline (ROADMAP 2.1). The client refuses files over 512 KB before sending, which also keeps uploads under Next's default 1 MB server-action body limit.
17. **Permissions:** new actions `settings.clinic` (owner) for the clinic pad and logo and `settings.profile` (owner, doctor) for one's own doctor profile and signature; viewing, previewing, printing, and downloading use the existing `rx.read` (owner, doctor, reception, nurse, pharmacist) — matches roles §4 and ADR-0026 (reception prints and shares) — a matrix edit. Printing puts the whole clinical content (history, examination, vitals) in the hands of every `rx.read` role; the data-minimisation decision ADR-0030 left open for reception and pharmacists covers printed copies too.
18. **The doctor's printed name lives on `doctors.display_name`** (the runtime role cannot read `users`); the migration backfills it from `users.name`, sign-up and seed set it — low.
19. **Desktop build: no new stash entries.** Every new route lives under `src/app/(app)/` or `src/app/api/health/`, which `scripts/build-desktop.mjs` already stashes; the Tauri app stays the legacy offline generator with its own browser print until Phase 4 — low.
20. **`/prescriptions/:path*` joins the middleware matcher**, so an expired session on a document link lands on the login page instead of a bare error (a Plan 1A follow-up) — none.
21. **The pad is signed by the user who finalizes it, and nobody else.** `finalizePrescription` snapshots the finalizing user's own doctor profile (`doctors.user_id = ctx.userId`); it never falls back to the visit's doctor, because that would print another doctor's name and signature on a prescription they did not sign (an amendment copies the original visit's `doctor_id`, ADR-0024). Live rendering of a pre-1C finalized row uses its `finalized_by` user's current profile; only a draft preview (no `finalized_by`) uses the visit's doctor — medico-legal attribution — a finalizer without a profile prints no doctor block, and the draft page warns (decision 3).
22. **The prescription page shows the record, not today's patient row, for finalized versions.** For a version with a finalize snapshot, the header shows the patient name frozen at finalize (with "(now recorded as …)" when the patient was renamed since), and the printed pad shows the frozen allergies; the on-screen `AllergyBanner` stays live on purpose, because it is a safety prompt for whoever acts on the prescription today, not part of the record (resolves the Plan 1A follow-up "the finalized view reads the LIVE patient row") — low.

## Global Constraints

Copied from Plans 1A and 1B (still binding):

- Node.js 22+; npm only (commit `package-lock.json`).
- TypeScript strict; no `any`; no `@ts-ignore`.
- Every business table has `tenant_id UUID NOT NULL`; RLS is enabled **and forced** on all of them (new tables included).
- `tenant_id`, `user_id`, and `role` come from the session (`requireSession()` / `getSessionContext()`), never from request input or form fields.
- Feature code reaches tenant data only through `withTenant()`. `adminDb` is for auth, sign-up, seed, and tests.
- Finalized prescriptions are never overwritten: amendments create a new version with a reason (AGENTS.md invariant 3).
- Creating, amending, finalizing, archiving, **printing, and downloading** write an append-only audit event (invariant 2). Audit payloads carry ids, counts, and field **names**, not free-text patient data.
- Dates: store UTC; calendar dates are `YYYY-MM-DD` strings; render in the clinic timezone (default `Asia/Kolkata`).
- IDs are UUIDv7 (`newId()` / schema `$defaultFn`); human-facing numbers are per-tenant sequences.
- Every service returns `Result<T>` (`{ ok: true, value } | { ok: false, code, message, field? }`); no thrown strings.
- Use existing shadcn/ui primitives (`src/components/ui/*`) and native form elements; do not add a UI kit.
- All user free text is validated through `cleanInput` / `cleanOptionalText(max)` / `cleanRequiredText(max, message)` and `hasNoNul` + `NUL_MESSAGE` (`src/server/validation/text.ts`): it is cleaned by `cleanText` (NFC, line breaks to LF, controls, zero-width and bidi-control characters and lone surrogates removed, ZWJ/ZWNJ kept), and **a NUL is refused with a field error, never stripped**. `cleanText` alone is for search terms and keys. Text is stored as plain text and never rendered with `dangerouslySetInnerHTML`.
- Migrations never run data backfill `UPDATE`s on `visits`, `prescriptions`, or `prescription_items` (the immutability triggers reject them on finalized rows). New columns are nullable or have a constant default.
- **Lock order (ADR-0023):** lock the prescription row `FOR UPDATE` before touching its items or its visit; finalizing an amendment locks the child, then flips the parent. Nothing in this plan adds a lock: the snapshot reads in `finalizePrescription` are plain SELECTs, and the output log only inserts.
- Client components fetch data through GET route handlers; server actions are for mutations only (Next runs server actions one at a time). Route handlers catch unexpected errors and answer a typed 500 with `Cache-Control: private, no-store`, logging the error class only (`error instanceof Error ? error.name : typeof error`): exception messages can carry row values.
- Keep components under ~250 lines; domain logic lives in `src/lib/` or `src/server/`, not in components.
- Conventional commits; one logical change per commit; `git add` names explicit file paths (never a bare directory), so parallel work never lands in the wrong commit.
- **Windows:** run every vitest and Playwright command from PowerShell with the working directory `E:\projects\clinicpad` (UPPERCASE drive letter). A lowercase `e:` cwd makes every test fail with `Cannot read properties of undefined (reading 'config')`. Start **every** command with `Set-Location E:\projects\clinicpad;`. PowerShell 5.1 has no `&&`; chain with `; if ($?) { ... }`. If the Docker engine is down, start Docker Desktop from `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe` (not Program Files).
- Before every commit run `Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }` and show the output.
- **Playwright:** `getByRole("alert")` also matches Next's route announcer: assert error text with `getByText` or scope the locator. Labels overlap ("Dose" is inside "Morning dose"), so use `{ exact: true }` and row scoping. Wait for the clinical editor with `waitForEditor(page)` before typing into it.
- Reviewers skip `drizzle/meta/*_snapshot.json` (generated).

New in Plan 1C:

- **Commit command:** `git commit -m "<subject>" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"` (PowerShell cannot pipe a message to `git commit -F -`). `<model>` is the model that actually wrote the commit (for example `Sonnet 5.5`); never name a different model.
- **Invisible or non-printing characters in tests** (U+0000, U+202E, U+2028, ...) are written as `\uXXXX` escapes, never pasted, and each such test asserts the code point it relies on (`codePointAt` or `Array.from(s).length`). The Write tool has re-encoded escapes into raw characters before (Plans 1A and 1B): after writing such a file, check it with `Select-String -Path <file> -Pattern '[\u0000-\u0008\u200B-\u200F\u202A-\u202E\u2028\u2029]'` (no output expected) and convert any hit back to an escape.
- **HTML is built only with `html`, `userText`, and `raw` from `src/lib/rx-render/html.ts`.** Interpolated strings are escaped automatically; `raw()` is only for markup, CSS, and `data:` URIs that this code generated itself. User text always goes through `userText()` (escaped, bidi-isolated, line breaks kept).
- **Every rendered document is self-contained:** inline `<style>`, fonts and images as `data:` URIs, a `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ...">`, no scripts, no links, no external URLs. `checkSelfContained()` runs before any document is served to a browser or sent to Gotenberg; a failure is a bug and throws.
- **The renderer (`src/lib/rx-render/*`) is pure:** no database, no `fs`, no `process.env`, no `Date.now()`/`new Date()` without an argument. The same input produces byte-identical HTML.
- **A finalized prescription prints from its `render_snapshot`**, never from live patient, clinic, or doctor rows. Only drafts and pre-1C rows use live data.
- **No PHI in URLs, file names, PDF titles, logs, or audit payloads.** File names are `Rx-<rxNo>-v<version>.pdf`; the document title is `Prescription Rx-<rxNo> v<version>`.
- **Uploaded images:** PNG or JPEG detected from bytes, ≤ 512 KB, 16–2000 px per side, nothing after the end marker; stored only in `clinic_assets`, which the runtime role can insert and read but never update or delete.
- **New tenant-owned foreign keys use the composite pattern** `foreignKey({ name, columns: [t.tenantId, t.xId], foreignColumns: [parent.tenantId, parent.id] })` with an explicit name under 63 characters, against a parent that has `unique (tenant_id, id)`.
- **Tests never require Gotenberg.** Code takes a `PdfEngine`; tests use the fake in `tests/helpers/fake-pdf-engine.ts`. The only real-service tests (`tests/integration/gotenberg-smoke.test.ts`, the download step of `tests/e2e/rx-output.spec.ts`) check `/health` first and skip or take the "service down" branch cleanly.
- **The only new npm dependency is `@fontsource/noto-sans-devanagari`, installed with `--save-exact`.** No PDF, HTML, or image libraries.
- Test files that use `Request`, `Response`, `FormData`, `File`, or `fetch` start with `// @vitest-environment node`.

## Review Focus

Failure modes most likely to hurt a real clinic that no happy-path test would catch. Each is pinned to a test in the owning task.

1. **Reprinting an old prescription after the patient, clinic, or doctor details changed** (patient renamed, clinic moved, new logo, doctor's registration number corrected, template switched). The reprint must show exactly what was finalized; an amendment shows its own. → Task 5 (`render-snapshot.test.ts`), Task 10 (e2e reprint check).
2. **Hostile or odd text in any printed field:** `<script>`, `<img onerror>`, `src=http://…`, `url(…)`, `@import`, quotes and ampersands, a right-to-left override (U+202E), a 2,000-character word with no spaces, long Devanagari advice, 30 medicines. Nothing executes, nothing is fetched, nothing is clipped, no row splits across pages. → Task 2 (`self-contained.test.ts`, `rx-html.test.ts`), Task 4 (`rx-render.test.ts`), Task 11 (`rx-visual.spec.ts`).
3. **The PDF service is down, slow, or returns garbage** (connection refused, timeout, HTTP 500/503, HTML instead of PDF, a 200-page PDF). The user sees a clear message, Print still works, and no output row or audit event claims a download happened. → Task 8 (`gotenberg.test.ts`), Task 9 (`rx-output-routes.test.ts`), Task 10 (e2e "down" branch).
4. **Cross-tenant ids, malformed ids, and roles without `rx.read`** on every new endpoint (document, PDF, settings actions), including a session that expired mid-print. Clean 404/403/401, never another clinic's data, and an unexpected failure is a typed 500 that leaks nothing. → Task 5, Task 6, Task 9.
5. **Hostile uploads posing as images:** an SVG with a script, an executable renamed to `.png`, a PNG with a payload appended after `IEND`, a truncated JPEG, a 5000-px-wide "decompression bomb", an empty file, a 600 KB file. Rejected with a field error before anything is stored. → Task 2 (`image.test.ts`), Task 6 (`pad-settings.test.ts`, `settings-actions.test.ts`), Task 7 (e2e).
6. **The page and the pad say who signed and what state the record is in** (raised by the Plan 1A/1B reviews): a superseded version is marked and links to its successor; a draft shown to a read-only role is marked as not a prescription; a finalized version shows the patient name it was finalized with; a pad is signed only by the doctor who finalized it (never the visit's original doctor); a prescriber with an incomplete or missing doctor profile is warned before finalizing; a NUL in a settings field is refused, not stripped. → Task 5 (`render-snapshot.test.ts`), Task 6 (`pad-settings.test.ts`), Task 10 (`prescription-page.test.tsx`, `rx-output.spec.ts`).

---

## File Structure

**Create**
- `src/lib/rx-render/html.ts` — `SafeHtml`, `html`, `raw`, `userText`, `escapeHtml`.
- `src/lib/rx-render/self-contained.ts` — `checkSelfContained`.
- `src/lib/domain/image.ts` — `inspectImage`, `IMAGE_LIMITS`.
- `src/lib/rx-render/types.ts` — template/paper/label constants, `RxDocument`, `RenderedDocument`, `PaperSpec`, `pickOption`.
- `src/lib/rx-render/snapshot.ts` — `renderSnapshotSchema`, `RenderSnapshot`, `parseRenderSnapshot`.
- `src/lib/rx-render/paper.ts` — `PAPER`.
- `src/lib/rx-render/labels.ts` — `LABELS`, `labelText`, `labelHtml`, coded-value translators.
- `src/lib/rx-render/format.ts` — dates, quantities, schedules, `pdfFileName`.
- `src/lib/rx-render/templates.ts` — `TEMPLATE_DEFINITIONS`.
- `src/lib/rx-render/styles.ts` — `documentCss`.
- `src/lib/rx-render/render.ts` — `renderPrescription`, `footerTemplate`, `DOCUMENT_CSP`.
- `src/server/rx-render/fonts.ts` — `loadFontCss`, `inlineFontCss`.
- `src/server/pdf/engine.ts` — `PdfEngine`, `PdfOutcome`, `PDF_LIMITS`, `PDF_MESSAGES`, `countPdfPages`.
- `src/server/pdf/gotenberg.ts` — `createGotenbergEngine`, `gotenbergForm`, `postHtmlToGotenberg`.
- `src/server/pdf/index.ts` — `getPdfEngine`.
- `src/server/services/assets.ts` — `loadImageAssets`, `assetPreview`, `storeImageAsset`.
- `src/server/services/render-snapshot.ts` — `buildRenderSnapshot`, `addressLines`, `footerLines`.
- `src/server/services/rx-documents.ts` — `loadRxDocument`, `getVersionLinks`.
- `src/server/services/pad-settings.ts` — clinic pad and doctor profile services.
- `src/server/services/rx-output.ts` — `renderPrescriptionHtml`, `renderPrescriptionPdf`, `listPrescriptionOutputs`.
- `src/server/validation/pad-settings.ts` — `clinicPadSchema`, `doctorProfileSchema`.
- `src/server/actions/settings.ts` — settings server actions.
- `src/app/(app)/prescriptions/[id]/document/route.ts`, `src/app/(app)/prescriptions/[id]/pdf/route.ts`, `src/app/api/health/pdf/route.ts`.
- `src/app/(app)/settings/profile/page.tsx`.
- `src/components/settings/clinic-pad-form.tsx`, `src/components/settings/doctor-profile-form.tsx`, `src/components/settings/image-upload-form.tsx`.
- `src/components/rx/output-actions.tsx`, `src/components/rx/rx-output-panel.tsx`.
- `drizzle/0013_phase1c_print.sql` (generated) and `drizzle/0014_phase1c_print_security.sql` (custom), with `drizzle/meta/0013_snapshot.json`, `drizzle/meta/0014_snapshot.json` (generated); `0012_phase1b_catalogue_security.sql` is the last migration at HEAD.
- Tests: `tests/helpers/images.ts`, `tests/helpers/fake-pdf-engine.ts`, `tests/fixtures/rx-documents.ts`; unit `tests/unit/{image,rx-html,self-contained,rx-labels,rx-render,fonts,gotenberg}.test.ts`, `tests/unit/image-upload-form.test.tsx`, golden files `tests/unit/__golden__/*.html`; integration `tests/integration/{print-schema,render-snapshot,pad-settings,settings-actions,rx-output-routes,gotenberg-smoke}.test.ts`; e2e `tests/e2e/{pad-settings,rx-output,rx-visual}.spec.ts`.

**Modify**
- `src/server/db/schema/tenancy.ts` — `clinicAssets`; clinic pad and doctor profile columns.
- `src/server/db/schema/clinical.ts` — `prescriptions.renderSnapshot`; `prescriptionOutputs`.
- `src/server/services/prescriptions.ts` — `finalizePrescription` writes the snapshot (everything else in the file unchanged except the `PrescriptionView.patient` comment).
- `src/server/auth/create-clinic.ts`, `src/server/db/seed.ts` — doctor display name, demo pad details.
- `src/lib/domain/permissions.ts` — `settings.clinic`, `settings.profile`.
- `src/lib/result.ts` — error code `unavailable`.
- `src/app/(app)/settings/page.tsx` — clinic pad form and logo (full replacement of the 37-line owner-only page).
- `src/app/(app)/prescriptions/[id]/page.tsx` — preview, print, download, version and draft notices, frozen patient name (full replacement of the current page, keeping its conflict state, `AllergyBanner`, `DiscardDraftForm`, `RepeatForm`, and `canFinalize`).
- `src/components/app-shell/sidebar.tsx` — "My profile" for doctors.
- `src/middleware.ts` — `/prescriptions/:path*`.
- `next.config.ts` — trace the font package into the web build.
- `docker-compose.yml`, `.github/workflows/ci.yml`, `.env.example` — Gotenberg.
- `package.json` / `package-lock.json` — the font dependency, `test:visual`.
- `tests/unit/permissions.test.ts` (new `granted` rows + cases), `tests/unit/sidebar.test.tsx` (appended case), `tests/unit/prescription-page.test.tsx` (mocks for the new services + new cases).
- `tsconfig.json` — only if Playwright needs `"baseUrl": "."` to resolve the `@/` alias (Task 11).
- `docs/DECISIONS.md`, `docs/PROGRESS.md`, `docs/SETUP.md`, `AGENTS.md`.

---

## Task 1: Schema, migrations, and database guarantees for print data

**Files:**
- Modify: `src/server/db/schema/tenancy.ts`, `src/server/db/schema/clinical.ts`, `src/server/auth/create-clinic.ts`, `src/server/db/seed.ts`
- Create: `drizzle/0013_phase1c_print.sql` (generated), `drizzle/0014_phase1c_print_security.sql` (custom, via drizzle-kit), their `drizzle/meta/0013_snapshot.json` / `0014_snapshot.json` and the `_journal.json` entries
- Test: `tests/integration/print-schema.test.ts`

**Interfaces:**
- Consumes: the schema at HEAD (`tenants`, `clinics` with `clinics_tenant_id_uq`, `doctors` with `doctors_tenant_id_uq` and `doctors_tenant_user_uq`, `patients`, `visits`, `prescriptions` with `prescriptions_tenant_id_uq`, `prescriptionItems`), the immutability triggers (0004–0008), and the composite-key pattern of 0007/0009/0010; `createClinicAccount(raw)` (`src/server/auth/create-clinic.ts`); `pgErrorInfo` (`src/server/db/errors.ts`).
- Produces (Drizzle, exported from `@/server/db/schema`):
  - `clinicAssets`: `id`, `tenantId`, `kind` (`"logo" | "signature"`), `mime` (`"image/png" | "image/jpeg"`), `width`, `height`, `byteSize`, `sha256`, `bytes: Buffer`, `createdBy`, `createdAt`; unique `(tenant_id, id)` and `(tenant_id, kind, sha256)`.
  - `clinics` gains `addressLine2`, `phone`, `email`, `padFooter` (`string | null`), `rxTemplate`, `rxPaperSize`, `rxLabels` (`string`, not null, defaults `"general"`, `"A4"`, `"en"`), `logoAssetId: string | null` (composite FK to `clinic_assets`).
  - `doctors` gains `displayName`, `designation`, `registrationCouncil` (`string | null`), `signatureAssetId: string | null` (composite FK to `clinic_assets`).
  - `prescriptions.renderSnapshot: unknown` (jsonb, nullable; parsed by Task 3's schema).
  - `prescriptionOutputs`: `id`, `tenantId`, `prescriptionId` (composite FK, cascade), `actorUserId`, `kind` (`"pdf_download" | "browser_print"`), `templateKey`, `paperSize`, `pageCount: number | null`, `byteSize: number | null`, `htmlSha256`, `createdAt`.
  - Database: forced RLS on both new tables with select + insert policies only; UPDATE/DELETE/TRUNCATE revoked from `clinicpad_app`; CHECK constraints on kinds, MIME types, sizes, dimensions, hashes, template/paper/label codes; a trigger that refuses outputs for drafts (`23000`) or for a prescription not visible in the row's tenant (`23503`); `doctors.display_name` backfilled from `users.name`.
  - `createClinicAccount` stores the sign-up name as `doctors.displayName`.
  - Foreign keys: `clinics_logo_asset_fk` and `doctors_signature_asset_fk` (`NO ACTION`), `rx_outputs_prescription_fk` (`CASCADE`), all `(tenant_id, x_id) -> (tenant_id, id)`, so the existing guard test in `tests/integration/tenant-fk.test.ts` passes without an allow-list entry.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/print-schema.test.ts`:

```ts
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  clinicAssets,
  clinics,
  doctors,
  patients,
  prescriptionItems,
  prescriptionOutputs,
  prescriptions,
  tenants,
  users,
  visits,
} from "@/server/db/schema";
import { createClinicAccount } from "@/server/auth/create-clinic";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let A = "";
let B = "";
let nextRxNo = 9100;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

function assetValues(tenantId: string, label: string, overrides: Partial<typeof clinicAssets.$inferInsert> = {}) {
  const bytes = Buffer.from(`fake-image-${label}-${stamp}`);
  return {
    tenantId,
    kind: "logo",
    mime: "image/png",
    width: 120,
    height: 60,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    ...overrides,
  };
}

async function insertAsset(tenantId: string, label: string): Promise<string> {
  const [row] = await adminDb.insert(clinicAssets).values(assetValues(tenantId, label)).returning({ id: clinicAssets.id });
  return row.id;
}

/** A prescription with one item, left as a draft or moved to finalized the way Plan 1A's tests do. */
async function prescriptionIn(tenantId: string, status: "draft" | "finalized"): Promise<string> {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Print Schema Patient" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId, visitId: visit.id, status: "draft" }).returning();
  await adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "Paracetamol" });
  if (status === "finalized") {
    nextRxNo += 1;
    await adminDb
      .update(prescriptions)
      .set({ status: "finalized", rxNo: nextRxNo, finalizedAt: new Date(), renderSnapshot: { v: 1, marker: "frozen" } })
      .where(eq(prescriptions.id, rx.id));
    await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visit.id));
  }
  return rx.id;
}

function outputValues(tenantId: string, prescriptionId: string, overrides: Partial<typeof prescriptionOutputs.$inferInsert> = {}) {
  return {
    tenantId,
    prescriptionId,
    kind: "browser_print",
    templateKey: "general",
    paperSize: "A4",
    htmlSha256: "a".repeat(64),
    ...overrides,
  };
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenants).values({ name: "PrintA", slug: `print-a-${stamp}` }).returning();
  const [b] = await adminDb.insert(tenants).values({ name: "PrintB", slug: `print-b-${stamp}` }).returning();
  A = a.id;
  B = b.id;
  await adminDb.insert(clinics).values([
    { tenantId: A, name: "Print Clinic A" },
    { tenantId: B, name: "Print Clinic B" },
  ]);
  await adminDb.insert(doctors).values([{ tenantId: A }, { tenantId: B }]);
});

afterAll(async () => {
  // Offboarding must still remove assets, outputs, and the clinics that point at assets.
  await adminDb.delete(tenants).where(eq(tenants.id, A));
  await adminDb.delete(tenants).where(eq(tenants.id, B));
  expect(await adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, A))).toHaveLength(0);
  expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.tenantId, A))).toHaveLength(0);
  expect(await adminDb.select().from(clinics).where(eq(clinics.tenantId, A))).toHaveLength(0);
});

describe("clinic_assets", () => {
  it("is tenant-isolated and append-only for the application role", async () => {
    await withTenant(A, (tx) => tx.insert(clinicAssets).values(assetValues(A, "app-insert")));
    expect((await withTenant(A, (tx) => tx.select().from(clinicAssets))).length).toBeGreaterThan(0);
    expect(await withTenant(B, (tx) => tx.select().from(clinicAssets))).toHaveLength(0);

    await expectCode(withTenant(A, (tx) => tx.update(clinicAssets).set({ width: 99 })), "42501");
    await expectCode(withTenant(A, (tx) => tx.delete(clinicAssets)), "42501");
  });

  it("refuses rows written for another tenant", async () => {
    await expectCode(withTenant(B, (tx) => tx.insert(clinicAssets).values(assetValues(A, "leak"))), "42501");
  });

  it.each([
    ["an SVG", { mime: "image/svg+xml" }],
    ["an unknown kind", { kind: "letterhead" }],
    ["a size that does not match the bytes", { byteSize: 3 }],
    ["an oversized image", { width: 5000 }],
    ["a tiny image", { height: 4 }],
    ["a malformed hash", { sha256: "not-a-hash" }],
  ])("rejects %s", async (_label, overrides) => {
    await expectCode(adminDb.insert(clinicAssets).values(assetValues(A, `bad-${JSON.stringify(overrides)}`, overrides)), "23514");
  });

  it("rejects more than 512 KB", async () => {
    const bytes = Buffer.alloc(600 * 1024, 1);
    await expectCode(
      adminDb.insert(clinicAssets).values(
        assetValues(A, "huge", { bytes, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }),
      ),
      "23514",
    );
  });

  it("de-duplicates identical uploads per tenant and kind", async () => {
    await adminDb.insert(clinicAssets).values(assetValues(A, "dup"));
    await expectCode(adminDb.insert(clinicAssets).values(assetValues(A, "dup")), "23505");
    // The same bytes as a signature, or in another clinic, are separate assets.
    await adminDb.insert(clinicAssets).values(assetValues(A, "dup", { kind: "signature" }));
    await adminDb.insert(clinicAssets).values(assetValues(B, "dup"));
  });
});

describe("clinic and doctor pad columns", () => {
  it("defaults the layout to General, A4, English", async () => {
    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A));
    expect(clinic).toMatchObject({ rxTemplate: "general", rxPaperSize: "A4", rxLabels: "en", logoAssetId: null });
  });

  it("rejects unknown template, paper, and label codes", async () => {
    await expectCode(adminDb.update(clinics).set({ rxTemplate: "fancy" }).where(eq(clinics.tenantId, A)), "23514");
    await expectCode(adminDb.update(clinics).set({ rxPaperSize: "Letter" }).where(eq(clinics.tenantId, A)), "23514");
    await expectCode(adminDb.update(clinics).set({ rxLabels: "fr" }).where(eq(clinics.tenantId, A)), "23514");
  });

  it("only points at the clinic's own assets (composite foreign keys)", async () => {
    const mine = await insertAsset(A, "own-logo");
    const theirs = await insertAsset(B, "their-logo");
    await adminDb.update(clinics).set({ logoAssetId: mine }).where(eq(clinics.tenantId, A));
    await expectCode(adminDb.update(clinics).set({ logoAssetId: theirs }).where(eq(clinics.tenantId, A)), "23503");
    await expectCode(adminDb.update(doctors).set({ signatureAssetId: theirs }).where(eq(doctors.tenantId, A)), "23503");
  });

  it("stores the sign-up name as the doctor's printed name", async () => {
    const phone = `9${String(Date.now()).slice(-9)}`;
    const email = `print-${stamp}@example.com`;
    const created = await createClinicAccount({
      clinicName: "Print Signup Clinic",
      doctorName: "Dr. Print Signup",
      email,
      phone,
      password: "ClinicPad!2026",
    });
    if (!created.ok) throw new Error(created.error);
    try {
      const [doctor] = await adminDb.select().from(doctors).where(eq(doctors.userId, created.userId));
      expect(doctor.displayName).toBe("Dr. Print Signup");
    } finally {
      await adminDb.delete(tenants).where(eq(tenants.id, created.tenantId));
      await adminDb.delete(users).where(eq(users.id, created.userId));
    }
  });
});

describe("prescriptions.render_snapshot", () => {
  it("can be written while the prescription is a draft", async () => {
    const id = await prescriptionIn(A, "draft");
    await adminDb.update(prescriptions).set({ renderSnapshot: { v: 1 } }).where(eq(prescriptions.id, id));
  });

  it("is frozen with the rest of a finalized prescription, and the amended flip still works", async () => {
    const id = await prescriptionIn(A, "finalized");
    await expectCode(adminDb.update(prescriptions).set({ renderSnapshot: { v: 1, marker: "tampered" } }).where(eq(prescriptions.id, id)), "23000");
    await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, id));
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    expect(row.renderSnapshot).toEqual({ v: 1, marker: "frozen" });
  });
});

describe("prescription_outputs", () => {
  it("records outputs of finalized prescriptions and is append-only for the application role", async () => {
    const id = await prescriptionIn(A, "finalized");
    await withTenant(A, (tx) => tx.insert(prescriptionOutputs).values(outputValues(A, id)));
    expect(await withTenant(A, (tx) => tx.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.prescriptionId, id)))).toHaveLength(1);
    expect(await withTenant(B, (tx) => tx.select().from(prescriptionOutputs))).toHaveLength(0);

    await expectCode(withTenant(A, (tx) => tx.update(prescriptionOutputs).set({ kind: "pdf_download" })), "42501");
    await expectCode(withTenant(A, (tx) => tx.delete(prescriptionOutputs)), "42501");
  });

  it("refuses outputs for drafts, even on the admin connection", async () => {
    const id = await prescriptionIn(A, "draft");
    await expectCode(adminDb.insert(prescriptionOutputs).values(outputValues(A, id)), "23000");
  });

  it("refuses an output that points at another clinic's prescription", async () => {
    const theirs = await prescriptionIn(B, "finalized");
    await expectCode(adminDb.insert(prescriptionOutputs).values(outputValues(A, theirs)), "23503");
    await expectCode(withTenant(A, (tx) => tx.insert(prescriptionOutputs).values(outputValues(A, theirs))), "23503");
  });

  it.each([
    ["an unknown kind", { kind: "fax" }],
    ["an unknown paper size", { paperSize: "Letter" }],
    ["a zero page count", { pageCount: 0 }],
    ["a malformed hash", { htmlSha256: "xyz" }],
  ])("rejects %s", async (_label, overrides) => {
    const id = await prescriptionIn(A, "finalized");
    await expectCode(adminDb.insert(prescriptionOutputs).values(outputValues(A, id, overrides)), "23514");
  });
});

describe("foreign keys", () => {
  it("are composite same-tenant keys with the intended delete rules", async () => {
    const rows = await adminDb.execute<{ conname: string; on_delete: string; cols: string[] }>(sql`
      select c.conname::text as conname,
             case c.confdeltype when 'a' then 'NO ACTION' when 'c' then 'CASCADE' else c.confdeltype::text end as on_delete,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
        from pg_constraint c
       where c.connamespace = 'public'::regnamespace
         and c.conname in ('clinics_logo_asset_fk', 'doctors_signature_asset_fk', 'rx_outputs_prescription_fk')
       order by c.conname`);
    expect([...rows]).toEqual([
      { conname: "clinics_logo_asset_fk", on_delete: "NO ACTION", cols: ["tenant_id", "logo_asset_id"] },
      { conname: "doctors_signature_asset_fk", on_delete: "NO ACTION", cols: ["tenant_id", "signature_asset_id"] },
      { conname: "rx_outputs_prescription_fk", on_delete: "CASCADE", cols: ["tenant_id", "prescription_id"] },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/print-schema.test.ts
```

Expected: FAIL — `clinicAssets` and `prescriptionOutputs` are not exported from `@/server/db/schema`.

- [ ] **Step 3: Extend the tenancy schema**

In `src/server/db/schema/tenancy.ts`:

1. Add `customType` to the `drizzle-orm/pg-core` import list (it already imports `boolean, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid`).
2. Directly below the `createdAt` helper (`const createdAt = () => timestamp("created_at", …)`), add the `bytea` column type:

```ts
/** Raw bytes (postgres-js returns bytea as a Buffer). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
```

3. Add this table **directly after `tenants` and before `clinics`** (clinics and doctors reference it, so it must be declared first):

```ts
/**
 * Uploaded clinic images (logo, doctor signature). Immutable: the runtime role can insert
 * and read but never update or delete. Finalized prescriptions reference these ids in
 * their print snapshot, so a reprint keeps the image it was finalized with.
 */
export const clinicAssets = pgTable(
  "clinic_assets",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    // Target of the composite same-tenant foreign keys from clinics and doctors (ADR-0025 pattern).
    unique("clinic_assets_tenant_id_uq").on(t.tenantId, t.id),
    unique("clinic_assets_dedupe_key").on(t.tenantId, t.kind, t.sha256),
  ],
);
```

4. In `clinics`, add these columns directly after `logoUrl: text("logo_url"),`:

```ts
    addressLine2: text("address_line2"),
    phone: text("phone"),
    email: text("email"),
    padFooter: text("pad_footer"),
    rxTemplate: text("rx_template").notNull().default("general"),
    rxPaperSize: text("rx_paper_size").notNull().default("A4"),
    rxLabels: text("rx_labels").notNull().default("en"),
    logoAssetId: uuid("logo_asset_id"),
```

and add this entry to the `clinics` constraint list (the array returned by `(t) => [...]`, after `unique("clinics_tenant_id_uq").on(t.tenantId, t.id)`):

```ts
    // Same-tenant reference to the current logo. NO ACTION: the runtime role can never delete assets.
    foreignKey({
      name: "clinics_logo_asset_fk",
      columns: [t.tenantId, t.logoAssetId],
      foreignColumns: [clinicAssets.tenantId, clinicAssets.id],
    }),
```

5. In `doctors`, add these columns directly after `stampUrl: text("stamp_url"),`:

```ts
    displayName: text("display_name"),
    designation: text("designation"),
    registrationCouncil: text("registration_council"),
    signatureAssetId: uuid("signature_asset_id"),
```

and add this entry to the `doctors` constraint list (after the existing `doctors_primary_branch_fk` entry):

```ts
    // Same-tenant reference to the current signature (NO ACTION, as for the clinic logo).
    foreignKey({
      name: "doctors_signature_asset_fk",
      columns: [t.tenantId, t.signatureAssetId],
      foreignColumns: [clinicAssets.tenantId, clinicAssets.id],
    }),
```

No delete rule is given on purpose (`NO ACTION`): the runtime role can never delete assets, and a tenant deletion removes clinics, doctors, and assets in the same statement, where `NO ACTION` is checked only at its end. Both columns are nullable; a composite key is `MATCH SIMPLE`, so a `NULL` asset id skips the check (as `prescriptions_parent_fk` does).

- [ ] **Step 4: Extend the clinical schema**

In `src/server/db/schema/clinical.ts`:

1. `foreignKey`, `index`, `integer`, `jsonb`, `text`, `uuid` are already in the `drizzle-orm/pg-core` import; `tenants` is already imported from `./tenancy`. Nothing to add.
2. The `prescriptions` constraint list already contains `unique("prescriptions_tenant_id_uq").on(t.tenantId, t.id)`. The composite foreign key below points at it; do not add a second one. (`prescriptions.pdf_url` stays unused: it cannot be written after finalize.)
3. In `prescriptions`, add directly after `finalizedBy: uuid("finalized_by"),`:

```ts
    /** What the printed pad shows, frozen by finalize (Plan 1C). Parse with parseRenderSnapshot(). */
    renderSnapshot: jsonb("render_snapshot").$type<unknown>(),
```

4. Append this table to the end of the file:

```ts
/**
 * Append-only log of every print and PDF download of a finalized prescription: who, when,
 * which layout, and the SHA-256 of the exact HTML that was rendered. Replaces the
 * printed_at / pdf_url columns, which cannot be written once a prescription is frozen.
 */
export const prescriptionOutputs = pgTable(
  "prescription_outputs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    prescriptionId: uuid("prescription_id").notNull(),
    actorUserId: uuid("actor_user_id"),
    kind: text("kind").notNull(),
    templateKey: text("template_key").notNull(),
    paperSize: text("paper_size").notNull(),
    pageCount: integer("page_count"),
    byteSize: integer("byte_size"),
    htmlSha256: text("html_sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "rx_outputs_prescription_fk",
      columns: [t.tenantId, t.prescriptionId],
      foreignColumns: [prescriptions.tenantId, prescriptions.id],
    }).onDelete("cascade"),
    index("rx_outputs_prescription_idx").on(t.tenantId, t.prescriptionId, t.createdAt),
  ],
);
```

`actor_user_id` has no foreign key on purpose, like `patients.created_by`: the runtime role has no access to `users`.

- [ ] **Step 5: Generate the structural migration and inspect it**

```powershell
Set-Location E:\projects\clinicpad; Get-ChildItem drizzle -Filter *.sql | Select-Object -ExpandProperty Name
Set-Location E:\projects\clinicpad; npm run db:generate -- --name=phase1c_print
```

The first listing ends with `0012_phase1b_catalogue_security.sql`, so drizzle-kit writes `drizzle/0013_phase1c_print.sql` (and `drizzle/meta/0013_snapshot.json`). Open it. It must contain only:

- `CREATE TABLE "clinic_assets"` (with `"bytes" bytea NOT NULL`), its `tenant_id` foreign key (`ON DELETE cascade`) and the two unique constraints;
- `CREATE TABLE "prescription_outputs"`, its `tenant_id` foreign key, `rx_outputs_prescription_fk` on `("tenant_id","prescription_id")` referencing `"prescriptions"("tenant_id","id") ON DELETE cascade`, and `CREATE INDEX "rx_outputs_prescription_idx"`;
- `ALTER TABLE "clinics" ADD COLUMN` for `address_line2`, `phone`, `email`, `pad_footer`, `rx_template text DEFAULT 'general' NOT NULL`, `rx_paper_size text DEFAULT 'A4' NOT NULL`, `rx_labels text DEFAULT 'en' NOT NULL`, `logo_asset_id uuid`, plus `clinics_logo_asset_fk`;
- `ALTER TABLE "doctors" ADD COLUMN` for `display_name`, `designation`, `registration_council`, `signature_asset_id`, plus `doctors_signature_asset_fk`;
- `ALTER TABLE "prescriptions" ADD COLUMN "render_snapshot" jsonb;`.

Ordering: every `ADD CONSTRAINT ... FOREIGN KEY` must come after the `CREATE TABLE` or `UNIQUE` it references (`clinic_assets_tenant_id_uq` is created inside `CREATE TABLE "clinic_assets"`, so the `clinics_logo_asset_fk` and `doctors_signature_asset_fk` statements must follow it). If drizzle-kit put a foreign key first, move the statements by hand, as was done for 0007, 0009 and 0010, keep the `--> statement-breakpoint` markers between statements, and add a header comment saying what was hand-edited (0010's header is the model). The new keys are `NO ACTION`/`CASCADE`, so no `ON DELETE SET NULL (col)` hand edit is needed. drizzle-kit should not ask about renames (only additions); if it does, answer **create**. If the file drops, alters, or recreates any existing column, constraint, or table, stop and fix the schema edit. Adding nullable columns or columns with a constant default does not fire the row triggers, so finalized rows are untouched.

- [ ] **Step 6: Create the custom security migration**

```powershell
Set-Location E:\projects\clinicpad; npx drizzle-kit generate --custom --name=phase1c_print_security
```

drizzle-kit writes an empty `drizzle/0014_phase1c_print_security.sql` (plus `drizzle/meta/0014_snapshot.json` and a journal entry after 0013). Replace the file's contents with exactly:

```sql
-- Row-level security, privileges, closed vocabularies and the draft guard for the Plan 1C tables (custom migration).

-- 1. New tenant tables: forced RLS, and append-only for the runtime role (select + insert only), like audit_events.
alter table clinic_assets enable row level security;
alter table clinic_assets force row level security;
alter table prescription_outputs enable row level security;
alter table prescription_outputs force row level security;

create policy tenant_read on clinic_assets
  for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_insert on clinic_assets
  for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_read on prescription_outputs
  for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy tenant_insert on prescription_outputs
  for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 0002's default privileges granted UPDATE/DELETE on every new table; take them back.
grant select, insert on clinic_assets, prescription_outputs to clinicpad_app;
revoke update, delete, truncate on clinic_assets, prescription_outputs from clinicpad_app;

-- 2. Closed vocabularies and caps, enforced here as well as in Zod and inspectImage().
alter table clinic_assets
  add constraint clinic_assets_kind_check check (kind in ('logo', 'signature')),
  add constraint clinic_assets_mime_check check (mime in ('image/png', 'image/jpeg')),
  add constraint clinic_assets_size_check check (byte_size between 1 and 524288 and octet_length(bytes) = byte_size),
  add constraint clinic_assets_dimensions_check check (width between 16 and 2000 and height between 16 and 2000),
  add constraint clinic_assets_sha256_check check (sha256 ~ '^[0-9a-f]{64}$');

alter table clinics
  add constraint clinics_rx_template_check check (rx_template in ('general', 'paediatric', 'derma')),
  add constraint clinics_rx_paper_size_check check (rx_paper_size in ('A4', 'A5')),
  add constraint clinics_rx_labels_check check (rx_labels in ('en', 'hi', 'bilingual'));

alter table prescription_outputs
  add constraint rx_outputs_kind_check check (kind in ('pdf_download', 'browser_print')),
  add constraint rx_outputs_paper_size_check check (paper_size in ('A4', 'A5')),
  add constraint rx_outputs_page_count_check check (page_count is null or page_count between 1 and 50),
  add constraint rx_outputs_byte_size_check check (byte_size is null or byte_size >= 0),
  add constraint rx_outputs_sha256_check check (html_sha256 ~ '^[0-9a-f]{64}$');

-- 3. Only finalized or amended prescriptions of the row's own tenant can be printed (same style as the 0006
--    item trigger: 23503 for a missing, invisible or foreign parent first, then 23000 for a draft).
--    The lookup runs as the caller, so RLS applies: another tenant's prescription reads as missing.
--    No FOR SHARE: an output never changes its prescription, and a status can only move away from draft.
create or replace function public.enforce_rx_output_target() returns trigger language plpgsql as $$
declare
  rx_status text;
begin
  select status into rx_status from public.prescriptions
    where id = new.prescription_id and tenant_id = new.tenant_id;
  if rx_status is null then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if rx_status = 'draft' then
    raise exception 'IMMUTABLE: drafts cannot be printed or downloaded' using errcode = '23000';
  end if;
  return new;
end $$;

create trigger prescription_outputs_target before insert on prescription_outputs
  for each row execute function public.enforce_rx_output_target();

-- 4. Printed doctor names for existing doctor rows. The runtime role cannot read users,
--    so the name is copied once here; doctors has no immutability trigger.
update doctors d
set display_name = u.name
from users u
where u.id = d.user_id and d.display_name is null;
```

- [ ] **Step 7: Store the sign-up name and give the demo clinic a real pad**

In `src/server/auth/create-clinic.ts`, in the `tx.insert(doctors).values({ tenantId, userId, primaryBranchId: branch.id, specialties: [], consultationFeePaise: 0 })` call, add `displayName: input.doctorName,` after `userId,`.

In `src/server/db/seed.ts` (`seedDemo`):

1. In the `clinics` insert (`name: "Sunrise Family Clinic"`), add after `pincode: "411001",`:

```ts
        phone: "020-2612 3456",
        padFooter: "Mon–Sat 9 am – 1 pm and 5 pm – 8 pm\nPlease bring your previous prescriptions.",
```

2. In the `doctors` insert inside the staff loop (`if (person.clinician)`), add after `userId,`:

```ts
            displayName: person.name,
            regNo: person.role === "owner" ? "MMC 2011/04/1234" : "MMC 2015/07/5678",
            registrationCouncil: "Maharashtra Medical Council",
```

The seeded prescriptions are finalized by a bulk admin UPDATE without a snapshot; they print from live data with the "finalized before print snapshots were recorded" note (decision 2). Do not call `buildRenderSnapshot` (Task 5) from the seed.

- [ ] **Step 8: Apply the migrations and run the test**

```powershell
Set-Location E:\projects\clinicpad; npm run db:migrate
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/print-schema.test.ts tests/integration/immutability.test.ts tests/integration/rls.test.ts tests/integration/seed.test.ts tests/integration/signup.test.ts tests/integration/tenant-fk.test.ts tests/integration/clinical-references.test.ts tests/integration/clinical-schema.test.ts
```

Expected: both migrations apply; every file PASSES (`print-schema.test.ts`: 24 tests; the guard test in `tenant-fk.test.ts` finds no single-column key; the offboarding tests in `clinical-references.test.ts` still delete whole tenants). If the append-only tests get `0` rows changed instead of `42501`, the `revoke` did not run: check that `0014_phase1c_print_security` is listed in `drizzle/meta/_journal.json` after `0013_phase1c_print`. If the draft-output test gets `23514` instead of `23000`, the trigger is missing (`\df enforce_rx_output_target` in `psql` must list it). If the `afterAll` tenant deletion fails with `23503` on `clinics_logo_asset_fk` or `doctors_signature_asset_fk`, the cascade reached the asset before the clinic: make both constraints `DEFERRABLE INITIALLY DEFERRED` in the custom migration (`alter table clinics alter constraint clinics_logo_asset_fk deferrable initially deferred;` and the same for doctors) rather than weakening the test.

- [ ] **Step 9: Whole suite, typecheck, snapshot consistency, commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; npx drizzle-kit generate
Set-Location E:\projects\clinicpad; git add src/server/db/schema/tenancy.ts src/server/db/schema/clinical.ts src/server/db/seed.ts src/server/auth/create-clinic.ts drizzle/0013_phase1c_print.sql drizzle/0014_phase1c_print_security.sql drizzle/meta/0013_snapshot.json drizzle/meta/0014_snapshot.json drizzle/meta/_journal.json tests/integration/print-schema.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: add print snapshot, output log, and clinic asset tables" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: the suite is green (the baseline + this task's 24 tests and one file: 896 in 49 files from the `4747932` baseline); `npx drizzle-kit generate` prints `No schema changes, nothing to migrate`.

---

## Task 2: Safe-HTML, self-containment, and image inspection primitives (pure, TDD)

**Files:**
- Create: `src/lib/rx-render/html.ts`, `src/lib/rx-render/self-contained.ts`, `src/lib/domain/image.ts`, `tests/helpers/images.ts`
- Test: `tests/unit/rx-html.test.ts`, `tests/unit/self-contained.test.ts`, `tests/unit/image.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class SafeHtml { readonly value: string }`; `type HtmlValue = SafeHtml | string | number | null | undefined | false | HtmlValue[]`; `` html`...`: SafeHtml `` (escapes interpolated strings and numbers, inserts `SafeHtml` as-is, joins arrays, drops `null`/`undefined`/`false`); `raw(markup: string): SafeHtml`; `userText(value: string | null | undefined): SafeHtml` (escaped, wrapped in `<span class="v">`, line breaks as `<br>`, empty for blank); `escapeHtml(value: string): string` (also removes C0 control characters except tab, LF, CR).
  - `type SelfContainedResult = { ok: true } | { ok: false; reason: string }`; `checkSelfContained(document: string): SelfContainedResult`; `ALLOWED_TAGS`.
  - `type ImageMime = "image/png" | "image/jpeg"`; `type ImageInfo = { mime: ImageMime; width: number; height: number }`; `type ImageCheck = { ok: true; info: ImageInfo } | { ok: false; message: string }`; `IMAGE_LIMITS = { maxBytes: 524288, minSide: 16, maxSide: 2000 }`; `inspectImage(bytes: Uint8Array): ImageCheck`.
  - Test helpers: `makePng(width, height, rgb?): Buffer` (real, decodable PNG); `makeJpegHeader(width, height): Buffer` (structurally valid JPEG markers).

- [ ] **Step 1: Write the test helpers**

`tests/helpers/images.ts`:

```ts
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable 8-bit RGB PNG filled with one colour. */
export function makePng(width: number, height: number, rgb: [number, number, number] = [30, 64, 175]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + width * 3); // filter byte 0, then pixels
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** SOI, APP0 (JFIF), SOF0 with the given size, SOS, a few scan bytes, EOI. Valid markers, not decodable pixels. */
export function makeJpegHeader(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, ...sos, 0x12, 0x34, 0x56, 0xff, 0xd9]);
}

/** The scan segment alone, for building malformed JPEGs. */
export const JPEG_SOS = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/rx-html.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeHtml, html, raw, userText } from "@/lib/rx-render/html";

describe("html tagged template", () => {
  it("escapes every interpolated string", () => {
    expect(html`<p>${`<b>&'"`}</p>`.value).toBe("<p>&lt;b&gt;&amp;&#39;&quot;</p>");
  });

  it("inserts SafeHtml as-is, joins arrays, prints numbers, and drops empty values", () => {
    const items = ["a<", "b"].map((v) => html`<li>${v}</li>`);
    expect(html`<ul>${items}</ul>${null}${undefined}${false}${0}`.value).toBe("<ul><li>a&lt;</li><li>b</li></ul>0");
  });

  it("passes raw markup through untouched", () => {
    expect(html`<div>${raw("<br>")}</div>`.value).toBe("<div><br></div>");
  });
});

describe("escapeHtml", () => {
  it("removes control characters but keeps tab, LF, and CR", () => {
    const input = "a\u0000b\u0007c\u001bd\te\nf\rg\u007f";
    expect(input.codePointAt(1)).toBe(0x0000);
    expect(input.codePointAt(3)).toBe(0x0007);
    expect(escapeHtml(input)).toBe("abcd\te\nf\rg");
  });
});

describe("userText", () => {
  it("escapes, isolates for bidi, and keeps line breaks", () => {
    expect(userText("<i>one</i>\r\ntwo\nthree\u2028four").value).toBe(
      '<span class="v">&lt;i&gt;one&lt;/i&gt;<br>two<br>three<br>four</span>',
    );
    expect("x\u2028y".codePointAt(1)).toBe(0x2028);
  });

  it("is empty for blank, null, and undefined", () => {
    expect(userText("   ").value).toBe("");
    expect(userText(null).value).toBe("");
    expect(userText(undefined).value).toBe("");
  });

  it("keeps Devanagari and a right-to-left override as text", () => {
    const rlo = "\u202Eevil\u202C";
    expect(Array.from(rlo)).toHaveLength(6);
    expect(userText(`आशा ${rlo}`).value).toBe(`<span class="v">आशा ${rlo}</span>`);
  });
});
```

`tests/unit/self-contained.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkSelfContained } from "@/lib/rx-render/self-contained";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FONT = "data:font/woff2;base64,d09GMgABAAAAAAA=";

const page = (head: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>x</title>${head}</head><body>${body}</body></html>`;

describe("checkSelfContained", () => {
  it("accepts inline CSS, embedded fonts, and embedded images", () => {
    const doc = page(
      `<style>@font-face{font-family:"X";src:url(${FONT}) format('woff2')}.a>.b{color:red}</style>`,
      `<table><thead><tr><th>a</th></tr></thead><tbody><tr><td><img src="${PIXEL}" alt="" width="1" height="1"></td></tr></tbody></table>`,
    );
    expect(checkSelfContained(doc)).toEqual({ ok: true });
  });

  it("accepts escaped user text that merely mentions URLs and CSS", () => {
    const text = "src=http://evil.example/a url(http://evil.example/b) @import &quot;x&quot; &lt;script&gt;";
    expect(checkSelfContained(page("", `<p><span class="v">${text}</span></p>`))).toEqual({ ok: true });
  });

  it.each([
    ["a script", page("", "<script>alert(1)</script>")],
    ["a stylesheet link", page('<link rel="stylesheet" href="http://evil.example/x.css">', "")],
    ["an image from the network", page("", '<img src="http://evil.example/x.png">')],
    ["an image from the file system", page("", '<img src="file:///etc/passwd">')],
    ["an SVG image", page("", '<img src="data:image/svg+xml;base64,PHN2Zz4=">')],
    ["an inline style with a URL", page("", '<div style="background:url(http://evil.example/x)">x</div>')],
    ["@import", page('<style>@import url("http://evil.example/x.css");</style>', "")],
    ["a font from the network", page("<style>@font-face{src:url(https://evil.example/x.woff2)}</style>", "")],
    ["a local font", page("<style>@font-face{src:local(Arial)}</style>", "")],
    ["CSS escapes", page('<style>.a{content:"\\41"}</style>', "")],
    ["an event handler", page("", '<div onclick="x()">x</div>')],
    ["a link", page("", '<a href="https://evil.example">x</a>')],
    ["a refresh meta tag", page('<meta http-equiv="refresh" content="0;url=https://evil.example">', "")],
    ["a base tag", page('<base href="https://evil.example/">', "")],
    ["an iframe", page("", '<iframe src="https://evil.example"></iframe>')],
    ["inline SVG", page("", "<svg><image href='https://evil.example/x.png'/></svg>")],
  ])("rejects %s", (_label, doc) => {
    expect(checkSelfContained(doc).ok).toBe(false);
  });

  it("explains why it rejected a document", () => {
    expect(checkSelfContained(page("", "<script></script>"))).toEqual({ ok: false, reason: "tag <script> is not allowed" });
  });
});
```

`tests/unit/image.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, inspectImage } from "@/lib/domain/image";
import { JPEG_SOS, makeJpegHeader, makePng } from "../helpers/images";

const bytes = (b: Buffer) => new Uint8Array(b);

describe("inspectImage", () => {
  it("reads PNG and JPEG dimensions from the bytes", () => {
    expect(inspectImage(bytes(makePng(120, 60)))).toEqual({ ok: true, info: { mime: "image/png", width: 120, height: 60 } });
    expect(inspectImage(bytes(makeJpegHeader(800, 300)))).toEqual({ ok: true, info: { mime: "image/jpeg", width: 800, height: 300 } });
  });

  it.each([
    ["an empty file", Buffer.alloc(0), /empty/],
    ["an SVG with a script", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), /PNG or JPEG/],
    ["a renamed executable", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]), /PNG or JPEG/],
    ["a GIF", Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1"), /PNG or JPEG/],
    ["a PNG with data after IEND", Buffer.concat([makePng(64, 32), Buffer.from("<script>alert(1)</script>")]), /extra data/],
    ["a truncated PNG", makePng(64, 32).subarray(0, 60), /damaged/],
    ["a PNG wider than 2000 px", makePng(5000, 16), /too large/],
    ["a PNG smaller than 16 px", makePng(8, 8), /too small/],
    ["a JPEG without its end marker", makeJpegHeader(100, 100).subarray(0, 30), /incomplete/],
    ["a JPEG whose scan starts before its frame header", Buffer.concat([Buffer.from([0xff, 0xd8]), JPEG_SOS, Buffer.from([0xff, 0xd9])]), /damaged/],
  ])("rejects %s", (_label, input, message) => {
    const result = inspectImage(bytes(input));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it("rejects anything above 512 KB before parsing it", () => {
    const big = Buffer.concat([makePng(64, 32), Buffer.alloc(IMAGE_LIMITS.maxBytes)]);
    const result = inspectImage(bytes(big));
    expect(result).toEqual({ ok: false, message: "The image is larger than 512 KB." });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/rx-html.test.ts tests/unit/self-contained.test.ts tests/unit/image.test.ts
```

Expected: FAIL — the three modules cannot be resolved.

- [ ] **Step 4: Implement**

`src/lib/rx-render/html.ts`:

```ts
/** Markup that is already escaped, or trusted markup built by the renderer itself. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

export type HtmlValue = SafeHtml | string | number | null | undefined | false | HtmlValue[];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// C0 controls except tab (09), line feed (0a) and carriage return (0d), plus DEL.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function escapeHtml(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function serialize(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(serialize).join("");
  return escapeHtml(String(value));
}

/**
 * Builds markup. Every interpolated string or number is escaped; only SafeHtml (from html,
 * raw, or userText) is inserted unchanged. This is the only way the renderer writes HTML.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += serialize(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Trusted markup, CSS, or data: URIs generated by this codebase. Never user text. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** User-entered text: escaped, isolated for bidirectional text, line breaks kept. */
export function userText(value: string | null | undefined): SafeHtml {
  if (!value || value.trim() === "") return new SafeHtml("");
  const escaped = escapeHtml(value).replace(/\r\n?|\n|\u2028|\u2029/g, "<br>");
  return new SafeHtml(`<span class="v">${escaped}</span>`);
}
```

`src/lib/rx-render/self-contained.ts`:

```ts
export type SelfContainedResult = { ok: true } | { ok: false; reason: string };

/** Every tag the renderer may emit. Anything else (script, link, a, svg, iframe, base, ...) is refused. */
export const ALLOWED_TAGS = new Set([
  "html", "head", "meta", "title", "style", "body", "header", "footer", "section",
  "div", "span", "p", "b", "strong", "i", "em", "small", "sub", "sup", "br", "hr",
  "table", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td", "ol", "ul", "li", "img",
]);

const URL_ATTRIBUTES = new Set([
  "href", "srcset", "poster", "action", "formaction", "data", "xlink:href", "background",
  "ping", "cite", "longdesc", "manifest", "codebase", "lowsrc", "dynsrc",
]);

const DATA_IMAGE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const DATA_FONT = /^data:font\/woff2;base64,[A-Za-z0-9+/]+={0,2}$/;

// Tags only: user text is escaped, so a literal "<" never comes from user data.
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g;
const ATTRIBUTE = /([^\s=/"'>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

const failure = (reason: string): SelfContainedResult => ({ ok: false, reason });

function unquote(value: string): string {
  return value.length >= 2 && (value[0] === '"' || value[0] === "'") ? value.slice(1, -1) : value;
}

function checkCss(css: string): SelfContainedResult {
  if (/@import/i.test(css)) return failure("CSS @import is not allowed");
  if (css.includes("\\")) return failure("CSS escapes are not allowed");
  if (/expression\s*\(/i.test(css)) return failure("CSS expressions are not allowed");
  if (/\blocal\s*\(/i.test(css)) return failure("local() fonts are not allowed");
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!DATA_FONT.test(match[2]) && !DATA_IMAGE.test(match[2])) {
      return failure("CSS url() must be an embedded WOFF2 font or PNG/JPEG image");
    }
  }
  return { ok: true };
}

/**
 * True when the document can render with no network and no file access: only allowed tags,
 * no event handlers, images and fonts only as data: URIs, no CSS imports. Runs before any
 * document is served to a browser or sent to the PDF service.
 */
export function checkSelfContained(document: string): SelfContainedResult {
  for (const tag of document.matchAll(TAG)) {
    const name = tag[2].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return failure(`tag <${name}> is not allowed`);
    if (tag[1] === "/") continue;
    for (const attribute of tag[3].matchAll(ATTRIBUTE)) {
      const attributeName = attribute[1].toLowerCase();
      const value = unquote(attribute[2] ?? "");
      if (attributeName.startsWith("on")) return failure(`event handler ${attributeName} is not allowed`);
      if (attributeName === "src") {
        if (name !== "img" || !DATA_IMAGE.test(value)) return failure("src must be an embedded PNG or JPEG");
        continue;
      }
      if (URL_ATTRIBUTES.has(attributeName)) return failure(`attribute ${attributeName} is not allowed`);
      if (attributeName === "style") {
        const css = checkCss(value);
        if (!css.ok) return css;
      }
      if (name === "meta" && attributeName === "http-equiv" && value.toLowerCase() !== "content-security-policy") {
        return failure("only a Content-Security-Policy meta tag is allowed");
      }
    }
  }
  for (const block of document.matchAll(/<style>([\s\S]*?)<\/style>/gi)) {
    const css = checkCss(block[1]);
    if (!css.ok) return css;
  }
  return { ok: true };
}
```

`src/lib/domain/image.ts`:

```ts
export type ImageMime = "image/png" | "image/jpeg";
export type ImageInfo = { mime: ImageMime; width: number; height: number };
export type ImageCheck = { ok: true; info: ImageInfo } | { ok: false; message: string };

/** Logos and signatures. maxSide also stops decompression bombs (a tiny file that decodes to gigabytes). */
export const IMAGE_LIMITS = { maxBytes: 512 * 1024, minSide: 16, maxSide: 2000 } as const;

const NOT_AN_IMAGE = "Upload a PNG or JPEG image.";
const DAMAGED = "The image file is damaged. Export it again as a PNG or JPEG.";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const fail = (message: string): ImageCheck => ({ ok: false, message });

function u32(b: Uint8Array, offset: number): number {
  return ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
}

function u16(b: Uint8Array, offset: number): number {
  return (b[offset] << 8) | b[offset + 1];
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...b.subarray(offset, offset + length));
}

function withSize(mime: ImageMime, width: number, height: number): ImageCheck {
  const { minSide, maxSide } = IMAGE_LIMITS;
  if (width < minSide || height < minSide) return fail(`The image is too small: use at least ${minSide} × ${minSide} pixels.`);
  if (width > maxSide || height > maxSide) {
    return fail(`The image is too large: use at most ${maxSide} × ${maxSide} pixels. Resize it and try again.`);
  }
  return { ok: true, info: { mime, width, height } };
}

/** Walks every chunk; the file must end exactly at IEND, so nothing can hide after it. */
function inspectPng(b: Uint8Array): ImageCheck {
  if (b.length < 8 + 25 + 12 || u32(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") return fail(DAMAGED);
  const width = u32(b, 16);
  const height = u32(b, 20);
  let offset = 8;
  while (offset + 12 <= b.length) {
    const length = u32(b, offset);
    const type = ascii(b, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail(DAMAGED);
    const next = offset + 12 + length;
    if (next > b.length) return fail(DAMAGED);
    if (type === "IEND") {
      if (next !== b.length) return fail("The image has extra data after its end. Export it again as a plain PNG or JPEG.");
      return withSize("image/png", width, height);
    }
    offset = next;
  }
  return fail(DAMAGED);
}

/** Reads markers up to the first frame header (SOF); the file must end with EOI. */
function inspectJpeg(b: Uint8Array): ImageCheck {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return fail("The image file is incomplete. Export it again.");
  let offset = 2;
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) return fail(DAMAGED);
    const marker = b[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return fail(DAMAGED); // end or scan before any frame header
    const length = u16(b, offset + 2);
    if (length < 2 || offset + 2 + length > b.length) return fail(DAMAGED);
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (length < 7) return fail(DAMAGED);
      return withSize("image/jpeg", u16(b, offset + 7), u16(b, offset + 5));
    }
    offset += 2 + length;
  }
  return fail(DAMAGED);
}

/**
 * Identifies an uploaded image from its bytes (never from the file name or declared type)
 * and checks the size limits. Only PNG and JPEG are accepted: SVG can carry scripts and
 * external references, and other formats are not needed for logos or signatures.
 */
export function inspectImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return fail("The file is empty.");
  if (bytes.length > IMAGE_LIMITS.maxBytes) return fail(`The image is larger than ${IMAGE_LIMITS.maxBytes / 1024} KB.`);
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return inspectPng(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return inspectJpeg(bytes);
  return fail(NOT_AN_IMAGE);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/rx-html.test.ts tests/unit/self-contained.test.ts tests/unit/image.test.ts
```

Expected: all PASS (`rx-html.test.ts` 7, `self-contained.test.ts` 19, `image.test.ts` 12). If the "truncated PNG" row reports `extra data` instead of `damaged`, the chunk walk is accepting a partial chunk: `next > b.length` must be checked before reading the chunk type of the next one. If a `rejects` row passes for the wrong reason, the message regex in the row tells you which branch ran; fix the code, not the row. These renderer-side checks are defence in depth: `cleanText` already strips U+202E and turns U+2028 into a line feed for anything entered through the app, but stored rows from before Plan 1B's hardening and rows written by the admin connection never went through it.

Check the escapes survived the Write tool (no output expected):

```powershell
Set-Location E:\projects\clinicpad; Select-String -Path tests/unit/rx-html.test.ts, tests/unit/image.test.ts -Pattern '[\u0000-\u0008\u001B\u007F\u202A-\u202E\u2028\u2029]'
```

- [ ] **Step 6: Lint, typecheck, full suite, commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/html.ts src/lib/rx-render/self-contained.ts src/lib/domain/image.ts tests/helpers/images.ts tests/unit/rx-html.test.ts tests/unit/self-contained.test.ts tests/unit/image.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: add escaping HTML builder, self-contained document check, and image inspection" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 3: Render model, snapshot schema, labels, and formatting (pure, TDD)

**Files:**
- Create: `src/lib/rx-render/types.ts`, `src/lib/rx-render/snapshot.ts`, `src/lib/rx-render/paper.ts`, `src/lib/rx-render/labels.ts`, `src/lib/rx-render/format.ts`, `tests/fixtures/rx-documents.ts`
- Test: `tests/unit/rx-labels.test.ts`

**Interfaces:**
- Consumes: Task 2 `html`, `SafeHtml`; Plan 1B `FOOD_RELATION_LABELS`, `PERIODICITY_LABELS`, `FoodRelation`, `Periodicity`, `Vitals`, `Investigation` (`src/lib/domain/rx-options.ts`), `formatDuration`, `formatSchedule` (`src/lib/domain/rx-format.ts`); `translations` (`src/lib/translations.ts`).
- Produces:
  - `types.ts`: `BUILTIN_TEMPLATES = ["general", "paediatric", "derma"]`, `BuiltinTemplateKey`; `PAPER_SIZES = ["A4", "A5"]`, `PaperSize`; `LABEL_LANGUAGES = ["en", "hi", "bilingual"]`, `LabelLanguage`; `TemplateRef = { kind: "builtin"; key: BuiltinTemplateKey }`; `PadLayout = { template: TemplateRef; paperSize: PaperSize; labels: LabelLanguage }`; `RxStatus = "draft" | "finalized" | "amended"`; `RxVisit`; `RxItem` (same fields as Plan 1B's `ItemView`); `RxDocument = { status; rxNo: number | null; version; issuedAt: string | null; supersededBy: { version: number; issuedAt: string | null } | null; replacesVersion: number | null; snapshot: RenderSnapshot; snapshotSource: "finalize" | "live"; visit: RxVisit; items: RxItem[] }`; `ImageAsset = { mime: "image/png" | "image/jpeg"; base64: string; width: number; height: number }`; `RenderAssets = { logo: ImageAsset | null; signature: ImageAsset | null; fontCss: string }`; `PaperSpec = { size; widthMm; heightMm; widthIn; heightIn; marginMm: { top; right; bottom; left }; baseFontPt }`; `RenderedDocument = { format: "html"; html: string; footerHtml: string; paper: PaperSpec; title: string }`; `pickOption<T extends string>(options: readonly T[], value: string | null | undefined, fallback: T): T`.
  - `snapshot.ts`: `renderSnapshotSchema`, `type RenderSnapshot` (inferred), `parseRenderSnapshot(value: unknown): RenderSnapshot | null`.
  - `paper.ts`: `PAPER: Record<PaperSize, PaperSpec>`.
  - `labels.ts`: `LABELS`, `type LabelKey`, `labelText(key, lang): string`, `labelHtml(key, lang): SafeHtml`, `foodText(code, lang)`, `periodicityText(code, lang)`, `genderText(code, lang)`, `durationText(value, unit, lang)`, `ageText(label, lang)` (all `string`).
  - `format.ts`: `formatIssuedDate(iso: string, timeZone: string): string` (`DD/MM/YYYY` in that zone), `formatCalendarDate(ymd: string | null): string`, `quantityText(q: number | null): string`, `hasSlots(item): boolean`, `scheduleText(item): string`, `pdfFileName(rx: { rxNo: number | null; version: number }): string`.
  - Fixtures: `HOSTILE`, `DEVANAGARI`, `TINY_PNG`, `snapshot(overrides?)`, `item(n, overrides?)`, `manyItems(count)`, `visit(overrides?)`, `documentFixture(overrides?)`.

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/rx-documents.ts`:

```ts
import type { RenderSnapshot } from "@/lib/rx-render/snapshot";
import type { ImageAsset, PadLayout, RxDocument, RxItem, RxVisit } from "@/lib/rx-render/types";

/** Text that must print literally: never markup, never a fetch. */
export const HOSTILE = {
  script: "<script>alert(1)</script>",
  img: '<img src=x onerror="alert(1)">',
  urls: 'src=http://evil.example/a url(http://evil.example/b) @import "http://evil.example/c";',
  bidi: "\u202Eevil\u202C",
  quotes: `Tom & Jerry's "syrup"`,
  longWord: "W".repeat(2000),
};

export const DEVANAGARI = {
  name: "आशा राव",
  complaint: "बुखार और खांसी",
  advice: Array.from({ length: 40 }, () => "भोजन के बाद दवा लें। पानी अधिक पिएं।").join(" "),
};

/** A 1×1 PNG; the renderer embeds base64 without decoding it. */
export const TINY_PNG: ImageAsset = {
  mime: "image/png",
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  width: 120,
  height: 60,
};

type SnapshotOverrides = {
  patient?: Partial<RenderSnapshot["patient"]>;
  clinic?: Partial<RenderSnapshot["clinic"]>;
  doctor?: Partial<RenderSnapshot["doctor"]>;
  layout?: Partial<PadLayout>;
};

export function snapshot(overrides: SnapshotOverrides = {}): RenderSnapshot {
  return {
    v: 1,
    takenAt: "2026-11-12T05:30:00.000Z",
    patient: {
      name: "Asha Rao",
      patientNo: 42,
      gender: "female",
      dob: "1990-04-02",
      ageLabel: "36 y",
      allergies: ["Penicillin"],
      ...overrides.patient,
    },
    clinic: {
      name: "Sunrise Family Clinic",
      addressLines: ["12 MG Road", "Pune, Maharashtra - 411001"],
      phone: "020-2612 3456",
      email: null,
      footerLines: ["Mon-Sat 9 am to 1 pm", "Please bring your previous prescriptions."],
      logoAssetId: null,
      timezone: "Asia/Kolkata",
      ...overrides.clinic,
    },
    doctor: {
      name: "Dr. Meera Shah",
      qualifications: "MBBS, MD (Medicine)",
      designation: "Consultant Physician",
      registrationNo: "MMC 2011/04/1234",
      registrationCouncil: "Maharashtra Medical Council",
      signatureAssetId: null,
      ...overrides.doctor,
    },
    layout: { template: { kind: "builtin", key: "general" }, paperSize: "A4", labels: "en", ...overrides.layout },
  };
}

export function item(n: number, overrides: Partial<RxItem> = {}): RxItem {
  return {
    drugName: `Medicine ${n}`,
    genericName: `Generic ${n}`,
    strength: "500 mg",
    form: "Tablet",
    route: "Oral",
    dose: "1 tab",
    doseMorning: 1,
    doseAfternoon: 0,
    doseEvening: null,
    doseNight: 1,
    timing: null,
    foodRelation: "after",
    periodicity: "daily",
    isSos: false,
    durationValue: 5,
    durationUnit: "days",
    durationDays: 5,
    remarks: null,
    ...overrides,
  };
}

export function manyItems(count: number): RxItem[] {
  return Array.from({ length: count }, (_, i) => item(i + 1));
}

export function visit(overrides: Partial<RxVisit> = {}): RxVisit {
  return {
    visitType: "new",
    chiefComplaint: "Fever for 2 days",
    complaints: ["Fever", "Body ache"],
    diagnosis: ["Viral fever"],
    medicalHistory: ["Type 2 diabetes"],
    drugHistory: ["Metformin 500"],
    examinationNotes: "Throat congested. Chest clear.",
    vitals: { bpSystolic: 130, bpDiastolic: 85, pulse: 92, temperatureF: 100.4, spo2: 97, weightKg: 70, heightCm: 175 },
    investigations: [{ name: "CBC" }, { name: "Dengue NS1", instructions: "If fever persists" }],
    advice: "Plenty of fluids.\nRest for 3 days.",
    followUpDate: "2026-11-19",
    followUpReason: "Review CBC report",
    ...overrides,
  };
}

/** A finalized General A4 prescription with three typical lines; override anything. */
export function documentFixture(overrides: Partial<RxDocument> & { layout?: Partial<PadLayout> } = {}): RxDocument {
  const { layout, ...rest } = overrides;
  return {
    status: "finalized",
    rxNo: 12,
    version: 1,
    issuedAt: "2026-11-12T05:30:00.000Z",
    supersededBy: null,
    replacesVersion: null,
    snapshot: snapshot({ layout }),
    snapshotSource: "finalize",
    visit: visit(),
    items: [
      item(1),
      item(2, { drugName: "Cetirizine", doseMorning: null, doseAfternoon: null, doseNight: 1, isSos: true, foodRelation: null, periodicity: "as_needed" }),
      item(3, { drugName: "ORS sachet", doseMorning: null, doseAfternoon: null, doseNight: null, timing: "After every loose stool", foodRelation: null, durationValue: 3, durationDays: 3 }),
    ],
    ...rest,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/rx-labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import {
  ageText,
  durationText,
  foodText,
  genderText,
  labelHtml,
  labelText,
  periodicityText,
} from "@/lib/rx-render/labels";
import {
  formatCalendarDate,
  formatIssuedDate,
  hasSlots,
  pdfFileName,
  quantityText,
  scheduleText,
} from "@/lib/rx-render/format";
import { parseRenderSnapshot } from "@/lib/rx-render/snapshot";
import { PAPER } from "@/lib/rx-render/paper";
import { BUILTIN_TEMPLATES, pickOption } from "@/lib/rx-render/types";
import { item, snapshot } from "../fixtures/rx-documents";

describe("labels", () => {
  it("prints English, Hindi, or both", () => {
    expect(labelText("diagnosis", "en")).toBe("Diagnosis");
    expect(labelText("diagnosis", "hi")).toBe(translations.hindi.diagnosis);
    expect(labelText("diagnosis", "bilingual")).toBe(`Diagnosis / ${translations.hindi.diagnosis}`);
  });

  it("stacks bilingual table headings and escapes nothing unexpected", () => {
    expect(labelHtml("medicine", "en").value).toBe("Medicine");
    expect(labelHtml("medicine", "bilingual").value).toBe(
      `<span class="l-en">Medicine</span><span class="l-hi">${translations.hindi.medicine}</span>`,
    );
  });

  it("translates coded values and keeps unknown codes as text", () => {
    expect(foodText("after", "en")).toBe("After food");
    expect(foodText("after", "hi")).toBe(translations.hindi.after);
    expect(foodText("after", "bilingual")).toBe(`After food / ${translations.hindi.after}`);
    expect(foodText("sometimes", "hi")).toBe("sometimes");
    expect(foodText(null, "en")).toBe("");
    expect(periodicityText("alternate_day", "hi")).toBe(translations.hindi.alternate);
    expect(periodicityText("twice_weekly", "en")).toBe("Twice a week");
    expect(genderText("female", "hi")).toBe(translations.hindi.female);
    expect(genderText("unknown", "en")).toBe("");
    expect(genderText(null, "en")).toBe("");
  });

  it("writes durations and ages in the label language", () => {
    expect(durationText(5, "days", "hi")).toBe("5 दिन");
    expect(durationText(1, "months", "hi")).toBe("1 महीना");
    expect(durationText(3, "months", "hi")).toBe("3 महीने");
    expect(durationText(2, "weeks", "en")).toBe("2 weeks");
    expect(durationText(2, "weeks", "bilingual")).toBe("2 weeks / 2 सप्ताह");
    expect(durationText(null, "days", "en")).toBe("");
    expect(ageText("6 y", "hi")).toBe("6 वर्ष");
    expect(ageText("15 mo", "hi")).toBe("15 माह");
    expect(ageText("11 d", "hi")).toBe("11 दिन");
    expect(ageText("6 y", "en")).toBe("6 y");
    expect(ageText("", "hi")).toBe("");
  });
});

describe("format", () => {
  it("prints the issue date in the clinic's timezone", () => {
    expect(formatIssuedDate("2026-11-12T20:00:00.000Z", "Asia/Kolkata")).toBe("13/11/2026");
    expect(formatIssuedDate("2026-11-12T20:00:00.000Z", "Mars/Olympus")).toBe("12/11/2026");
    expect(formatIssuedDate("yesterday", "Asia/Kolkata")).toBe("");
  });

  it("prints calendar dates day first", () => {
    expect(formatCalendarDate("2026-12-01")).toBe("01/12/2026");
    expect(formatCalendarDate("01/12/2026")).toBe("");
    expect(formatCalendarDate(null)).toBe("");
  });

  it.each([
    [null, "0"],
    [0, "0"],
    [1, "1"],
    [0.5, "½"],
    [1.5, "1½"],
    [0.25, "¼"],
    [2.75, "2¾"],
    [12, "12"],
    [0.3, "0.3"],
  ])("prints a dose of %j as %s", (q, expected) => {
    expect(quantityText(q)).toBe(expected);
  });

  it("uses the slot pattern when there is one, else the free-text timing", () => {
    expect(hasSlots(item(1))).toBe(true);
    expect(scheduleText(item(1))).toBe("1-0-1");
    const free = item(2, { doseMorning: null, doseAfternoon: null, doseEvening: null, doseNight: null, timing: "SOS" });
    expect(hasSlots(free)).toBe(false);
    expect(scheduleText(free)).toBe("SOS");
    expect(scheduleText(item(3, { doseMorning: 0, doseAfternoon: 0, doseEvening: null, doseNight: 0, timing: null }))).toBe("");
  });

  it("names PDFs without patient data", () => {
    expect(pdfFileName({ rxNo: 12, version: 2 })).toBe("Rx-12-v2.pdf");
    expect(pdfFileName({ rxNo: null, version: 1 })).toBe("Rx-draft-v1.pdf");
  });
});

describe("render snapshot schema", () => {
  it("round-trips a snapshot and drops unknown keys", () => {
    const value = { ...snapshot(), extra: "ignored" };
    expect(parseRenderSnapshot(value)).toEqual(snapshot());
  });

  it.each([
    ["a future version", { ...snapshot(), v: 2 }],
    ["a missing patient", { ...snapshot(), patient: undefined }],
    ["an unknown template", { ...snapshot(), layout: { template: { kind: "builtin", key: "fancy" }, paperSize: "A4", labels: "en" } }],
    ["a DOCX template (Phase 2 only)", { ...snapshot(), layout: { template: { kind: "docx", key: "general" }, paperSize: "A4", labels: "en" } }],
    ["a non-object", "snapshot"],
  ])("rejects %s", (_label, value) => {
    expect(parseRenderSnapshot(value)).toBeNull();
  });
});

describe("paper and options", () => {
  it("defines A4 and A5 in millimetres and inches", () => {
    expect(PAPER.A4).toMatchObject({ widthMm: 210, heightMm: 297, widthIn: 8.27, heightIn: 11.69 });
    expect(PAPER.A5).toMatchObject({ widthMm: 148, heightMm: 210, widthIn: 5.83, heightIn: 8.27 });
  });

  it("falls back for unknown option values", () => {
    expect(pickOption(BUILTIN_TEMPLATES, "derma", "general")).toBe("derma");
    expect(pickOption(BUILTIN_TEMPLATES, "fancy", "general")).toBe("general");
    expect(pickOption(BUILTIN_TEMPLATES, null, "general")).toBe("general");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/rx-labels.test.ts
```

Expected: FAIL — the `@/lib/rx-render/*` modules cannot be resolved.

- [ ] **Step 4: Implement the model**

`src/lib/rx-render/types.ts`:

```ts
import type { Investigation, Vitals } from "@/lib/domain/rx-options";
import type { RenderSnapshot } from "./snapshot";

export const BUILTIN_TEMPLATES = ["general", "paediatric", "derma"] as const;
export type BuiltinTemplateKey = (typeof BUILTIN_TEMPLATES)[number];

export const PAPER_SIZES = ["A4", "A5"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const LABEL_LANGUAGES = ["en", "hi", "bilingual"] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

/**
 * Which template draws the pad. Phase 2 (Template Studio) adds { kind: "docx"; templateVersionId }
 * and { kind: "overlay"; templateVersionId } with their own renderers; callers of
 * renderPrescription() do not change.
 */
export type TemplateRef = { kind: "builtin"; key: BuiltinTemplateKey };

export type PadLayout = { template: TemplateRef; paperSize: PaperSize; labels: LabelLanguage };

export type RxStatus = "draft" | "finalized" | "amended";

/** The clinical content a pad prints (a subset of Plan 1B's ClinicalVisitView). */
export type RxVisit = {
  visitType: string;
  chiefComplaint: string | null;
  complaints: string[];
  diagnosis: string[];
  medicalHistory: string[];
  drugHistory: string[];
  examinationNotes: string | null;
  vitals: Vitals;
  investigations: Investigation[];
  advice: string | null;
  followUpDate: string | null;
  followUpReason: string | null;
};

/** One medicine line (the same fields as Plan 1B's ItemView). */
export type RxItem = {
  drugName: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  route: string | null;
  dose: string | null;
  doseMorning: number | null;
  doseAfternoon: number | null;
  doseEvening: number | null;
  doseNight: number | null;
  timing: string | null;
  foodRelation: string | null;
  periodicity: string | null;
  isSos: boolean;
  durationValue: number | null;
  durationUnit: string | null;
  durationDays: number | null;
  remarks: string | null;
};

/** Everything the renderer needs. Built by loadRxDocument(); fixtures build it directly. */
export type RxDocument = {
  status: RxStatus;
  rxNo: number | null;
  version: number;
  /** finalized_at as ISO, null for drafts. */
  issuedAt: string | null;
  /** Set when a newer finalized version replaced this one. */
  supersededBy: { version: number; issuedAt: string | null } | null;
  /** Set on amendments: the version this one replaces. */
  replacesVersion: number | null;
  snapshot: RenderSnapshot;
  /** "finalize" = frozen at finalize; "live" = built from current data (drafts, pre-1C rows). */
  snapshotSource: "finalize" | "live";
  visit: RxVisit;
  items: RxItem[];
};

export type ImageAsset = { mime: "image/png" | "image/jpeg"; base64: string; width: number; height: number };

export type RenderAssets = { logo: ImageAsset | null; signature: ImageAsset | null; fontCss: string };

export type PaperSpec = {
  size: PaperSize;
  widthMm: number;
  heightMm: number;
  widthIn: number;
  heightIn: number;
  marginMm: { top: number; right: number; bottom: number; left: number };
  baseFontPt: number;
};

/** Output of every template kind. Phase 2's DOCX kind adds { format: "docx"; bytes } to this union. */
export type RenderedDocument = { format: "html"; html: string; footerHtml: string; paper: PaperSpec; title: string };

/** `value` if it is one of `options`, else `fallback`. For codes read from the database. */
export function pickOption<T extends string>(options: readonly T[], value: string | null | undefined, fallback: T): T {
  return value !== null && value !== undefined && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}
```

`src/lib/rx-render/snapshot.ts`:

```ts
import { z } from "zod";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES } from "./types";

/** Shape of prescriptions.render_snapshot, version 1. Bump `v` and keep a parser per version if it changes. */
export const renderSnapshotSchema = z.object({
  v: z.literal(1),
  takenAt: z.string(),
  patient: z.object({
    name: z.string(),
    patientNo: z.number().int().nullable(),
    gender: z.string().nullable(),
    dob: z.string().nullable(),
    ageLabel: z.string(),
    allergies: z.array(z.string()),
  }),
  clinic: z.object({
    name: z.string(),
    addressLines: z.array(z.string()),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    footerLines: z.array(z.string()),
    logoAssetId: z.string().nullable(),
    timezone: z.string(),
  }),
  doctor: z.object({
    name: z.string(),
    qualifications: z.string().nullable(),
    designation: z.string().nullable(),
    registrationNo: z.string().nullable(),
    registrationCouncil: z.string().nullable(),
    signatureAssetId: z.string().nullable(),
  }),
  layout: z.object({
    template: z.object({ kind: z.literal("builtin"), key: z.enum(BUILTIN_TEMPLATES) }),
    paperSize: z.enum(PAPER_SIZES),
    labels: z.enum(LABEL_LANGUAGES),
  }),
});

export type RenderSnapshot = z.infer<typeof renderSnapshotSchema>;

/** The stored jsonb is data, not trusted code: parse it, and treat anything unexpected as damaged. */
export function parseRenderSnapshot(value: unknown): RenderSnapshot | null {
  const parsed = renderSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
```

`src/lib/rx-render/paper.ts`:

```ts
import type { PaperSize, PaperSpec } from "./types";

/** Page sizes and margins shared by the print CSS and the Gotenberg request. */
export const PAPER: Record<PaperSize, PaperSpec> = {
  A4: {
    size: "A4",
    widthMm: 210,
    heightMm: 297,
    widthIn: 8.27,
    heightIn: 11.69,
    marginMm: { top: 12, right: 12, bottom: 14, left: 12 },
    baseFontPt: 10,
  },
  A5: {
    size: "A5",
    widthMm: 148,
    heightMm: 210,
    widthIn: 5.83,
    heightIn: 8.27,
    marginMm: { top: 9, right: 9, bottom: 12, left: 9 },
    baseFontPt: 8.5,
  },
};
```

`src/lib/rx-render/labels.ts`:

```ts
import { formatDuration } from "@/lib/domain/rx-format";
import { FOOD_RELATION_LABELS, PERIODICITY_LABELS, type FoodRelation, type Periodicity } from "@/lib/domain/rx-options";
import { translations } from "@/lib/translations";
import { html, type SafeHtml } from "./html";
import type { LabelLanguage } from "./types";

const hi = translations.hindi;

/** Pad headings. Hindi comes from src/lib/translations.ts wherever the legacy app already had it. */
export const LABELS = {
  name: { en: "Name", hi: hi.name },
  age: { en: "Age", hi: hi.age },
  gender: { en: "Gender", hi: hi.gender },
  patientNo: { en: "Patient No.", hi: "रोगी क्रमांक" },
  date: { en: "Date", hi: hi.date },
  rxNo: { en: "Rx No.", hi: "पर्चा क्रमांक" },
  phone: { en: "Ph.", hi: "फोन" },
  allergies: { en: "Allergies", hi: hi.allergies },
  chiefComplaint: { en: "Chief complaint", hi: "मुख्य शिकायत" },
  complaints: { en: "Complaints", hi: hi.patientComplaints },
  medicalHistory: { en: "Medical history", hi: hi.medicalHistory },
  drugHistory: { en: "Drug history", hi: hi.drugHistory },
  examination: { en: "Examination", hi: "परीक्षण" },
  diagnosis: { en: "Diagnosis", hi: hi.diagnosis },
  medicine: { en: "Medicine", hi: hi.medicine },
  dose: { en: "Dose", hi: hi.dosage },
  when: { en: "When", hi: "कब" },
  morning: { en: "Mor", hi: hi.mor },
  afternoon: { en: "Noon", hi: hi.noon },
  evening: { en: "Eve", hi: hi.eve },
  night: { en: "Night", hi: hi.night },
  food: { en: "Food", hi: hi.food },
  frequencyDuration: { en: "Frequency / Duration", hi: hi.frequencyDuration },
  duration: { en: "Duration", hi: hi.duration },
  howToUse: { en: "How to use", hi: "उपयोग विधि" },
  instructions: { en: "Instructions", hi: hi.instructions },
  remarks: { en: "Remarks", hi: hi.remarks },
  investigations: { en: "Investigations", hi: hi.tests },
  advice: { en: "Advice", hi: "सलाह" },
  followUp: { en: "Follow-up", hi: hi.followUpDate },
  regNo: { en: "Reg. No.", hi: "रजि. नं." },
  bp: { en: "BP", hi: hi.bp },
  pulse: { en: "Pulse", hi: "पल्स" },
  temperature: { en: "Temp", hi: "तापमान" },
  spo2: { en: "SpO2", hi: "SpO2" },
  respiratoryRate: { en: "RR", hi: "श्वसन दर" },
  weight: { en: "Weight", hi: "वजन" },
  height: { en: "Height", hi: "लंबाई" },
  bmi: { en: "BMI", hi: "BMI" },
  bloodSugar: { en: "Sugar", hi: "शुगर" },
} as const satisfies Record<string, { en: string; hi: string }>;

export type LabelKey = keyof typeof LABELS;

function pick(en: string, hindi: string, lang: LabelLanguage): string {
  if (lang === "en") return en;
  if (lang === "hi") return hindi;
  return en === hindi ? en : `${en} / ${hindi}`;
}

export function labelText(key: LabelKey, lang: LabelLanguage): string {
  return pick(LABELS[key].en, LABELS[key].hi, lang);
}

/** Table headings: bilingual stacks the Hindi under the English. */
export function labelHtml(key: LabelKey, lang: LabelLanguage): SafeHtml {
  const { en, hi: hindi } = LABELS[key];
  if (lang !== "bilingual" || en === hindi) return html`${pick(en, hindi, lang)}`;
  return html`<span class="l-en">${en}</span><span class="l-hi">${hindi}</span>`;
}

const HI_FOOD: Record<FoodRelation, string> = {
  before: hi.before,
  after: hi.after,
  with: hi.with,
  without: hi.without,
  with_tea: hi.with_tea,
  just_for_now: hi.just_for_now,
  according_to_pain: hi.according_to_pain,
};

const HI_PERIODICITY: Record<Periodicity, string> = {
  daily: hi.daily,
  alternate_day: hi.alternate,
  twice_weekly: hi.weeklyTwice,
  weekly: hi.weekly,
  every_5th_day: hi.every_5th_day,
  fortnightly: hi.fortnightly,
  monthly: hi.monthly,
  as_needed: hi.asNeeded,
};

const GENDER: Record<string, { en: string; hi: string }> = {
  female: { en: "Female", hi: hi.female },
  male: { en: "Male", hi: hi.male },
  other: { en: "Other", hi: hi.other },
};

function coded<K extends string>(code: string | null, en: Record<K, string>, hindi: Record<K, string>, lang: LabelLanguage): string {
  if (!code) return "";
  if (!Object.hasOwn(en, code)) return code; // unknown code: print it as text (it is escaped later)
  return pick(en[code as K], hindi[code as K], lang);
}

export function foodText(code: string | null, lang: LabelLanguage): string {
  return coded(code, FOOD_RELATION_LABELS, HI_FOOD, lang);
}

export function periodicityText(code: string | null, lang: LabelLanguage): string {
  return coded(code, PERIODICITY_LABELS, HI_PERIODICITY, lang);
}

export function genderText(code: string | null, lang: LabelLanguage): string {
  if (!code || !Object.hasOwn(GENDER, code)) return "";
  return pick(GENDER[code].en, GENDER[code].hi, lang);
}

const HI_UNITS: Record<string, [string, string]> = {
  days: ["दिन", "दिन"],
  weeks: ["सप्ताह", "सप्ताह"],
  months: ["महीना", "महीने"],
};

export function durationText(value: number | null, unit: string | null, lang: LabelLanguage): string {
  if (value === null) return "";
  const en = formatDuration(value, unit);
  const words = unit !== null && Object.hasOwn(HI_UNITS, unit) ? HI_UNITS[unit] : HI_UNITS.days;
  return pick(en, `${value} ${value === 1 ? words[0] : words[1]}`, lang);
}

const HI_AGE_UNITS: Record<string, string> = { y: "वर्ष", mo: "माह", d: "दिन" };

/** Plan 1A's ageLabel ("6 y", "15 mo", "11 d") in the label language. */
export function ageText(label: string, lang: LabelLanguage): string {
  const match = /^(\d+) (y|mo|d)$/.exec(label);
  if (!match) return label;
  return pick(label, `${match[1]} ${HI_AGE_UNITS[match[2]]}`, lang);
}
```

`src/lib/rx-render/format.ts`:

```ts
import { formatSchedule } from "@/lib/domain/rx-format";
import type { RxItem } from "./types";

function dayMonthYear(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}`;
}

/** DD/MM/YYYY of an instant in the clinic's timezone (UTC if the zone is unknown). Empty if unreadable. */
export function formatIssuedDate(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return dayMonthYear(date, timeZone);
  } catch {
    return dayMonthYear(date, "UTC");
  }
}

/** "2026-12-01" -> "01/12/2026"; anything else -> "". */
export function formatCalendarDate(ymd: string | null): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

/** One dose slot as printed in an M/A/E/N column: "0", "1", "½", "1½", "12". */
export function quantityText(q: number | null): string {
  if (q === null || q === 0) return "0";
  const whole = Math.trunc(q);
  const fraction = Math.round((q - whole) * 100) / 100;
  if (fraction === 0) return String(whole);
  const glyph = fraction === 0.25 ? "¼" : fraction === 0.5 ? "½" : fraction === 0.75 ? "¾" : null;
  if (glyph === null) return String(q);
  return whole === 0 ? glyph : `${whole}${glyph}`;
}

type Slots = Pick<RxItem, "doseMorning" | "doseAfternoon" | "doseEvening" | "doseNight">;

export function hasSlots(item: Slots): boolean {
  return [item.doseMorning, item.doseAfternoon, item.doseEvening, item.doseNight].some((q) => q !== null && q !== 0);
}

/** "1-0-1" from the dose slots, else the free-text timing, else "". */
export function scheduleText(item: Slots & Pick<RxItem, "timing">): string {
  const pattern = formatSchedule({
    morning: item.doseMorning,
    afternoon: item.doseAfternoon,
    evening: item.doseEvening,
    night: item.doseNight,
  });
  return pattern || item.timing || "";
}

/** Download name. Never contains patient data. */
export function pdfFileName(rx: { rxNo: number | null; version: number }): string {
  return `Rx-${rx.rxNo ?? "draft"}-v${rx.version}.pdf`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/rx-labels.test.ts
```

Expected: all PASS (`rx-labels.test.ts`: 25 tests). If `formatIssuedDate(..., "Mars/Olympus")` throws instead of falling back, the `try` must wrap the `Intl.DateTimeFormat` constructor (it throws `RangeError` for unknown zones). The English coded labels come from `src/lib/domain/rx-options.ts` as it is at HEAD (`"After food"`, `"Twice a week"`, …); the Hindi ones from `translations.hindi` (`after`, `alternate`, `weeklyTwice`, `asNeeded`, `every_5th_day`, `fortnightly`, `female`, …), all of which exist today. `formatDuration` and `formatSchedule` are the Plan 1B helpers in `src/lib/domain/rx-format.ts` (`formatSchedule` prints the four-slot form only when there is an evening dose).

- [ ] **Step 6: Lint, typecheck, full suite, commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/types.ts src/lib/rx-render/snapshot.ts src/lib/rx-render/paper.ts src/lib/rx-render/labels.ts src/lib/rx-render/format.ts tests/fixtures/rx-documents.ts tests/unit/rx-labels.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: add prescription render model, snapshot schema, labels, and formatting" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 4: The renderer and the three built-in templates (pure, TDD, golden files)

**Files:**
- Create: `src/lib/rx-render/templates.ts`, `src/lib/rx-render/styles.ts`, `src/lib/rx-render/render.ts`
- Test: `tests/unit/rx-render.test.ts`, golden files `tests/unit/__golden__/rx-general-a4-en.html`, `rx-paediatric-a5-bilingual.html`, `rx-derma-a4-hi.html`, `rx-general-draft.html` (written by the first run, reviewed, committed)

**Interfaces:**
- Consumes: Tasks 2–3 (`html`, `raw`, `userText`, `checkSelfContained`, types, `PAPER`, labels, format, fixtures); Plan 1B `bmi`, `formatBp`.
- Produces:
  - `templates.ts`: `type VitalKey`, `type SectionKey`, `type MedicineLayout = "slots" | "pattern" | "topical"`, `type TemplateDefinition = { key; name; description; accent; sections: SectionKey[]; vitals: VitalKey[]; medicineLayout; prominentWeight: boolean }`, `TEMPLATE_DEFINITIONS: Record<BuiltinTemplateKey, TemplateDefinition>`.
  - `styles.ts`: `documentCss(def: TemplateDefinition, paper: PaperSpec): string`.
  - `render.ts`: `DOCUMENT_CSP: string`; `renderPrescription(doc: RxDocument, assets: RenderAssets): RenderedDocument`; `footerTemplate(doc: RxDocument, paper: PaperSpec): string` (Gotenberg page-number footer, digits and Rx number only).
  - Document contract used by later tasks: `<body data-rx="ready">` on every rendered document; `.watermark` and `.banner` for draft and superseded; `.meds` medicine table; `.sig` signature block.

- [ ] **Step 1: Write the failing tests**

`tests/unit/rx-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderPrescription, footerTemplate } from "@/lib/rx-render/render";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, type RenderAssets, type RxDocument } from "@/lib/rx-render/types";
import { translations } from "@/lib/translations";
import { DEVANAGARI, HOSTILE, TINY_PNG, documentFixture, item, manyItems, snapshot, visit } from "../fixtures/rx-documents";

const NO_ASSETS: RenderAssets = { logo: null, signature: null, fontCss: "" };
const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");
const render = (doc: RxDocument, assets: RenderAssets = NO_ASSETS) => renderPrescription(doc, assets);
const text = (markup: string) => parse(markup).body.textContent ?? "";

function hostileDocument(overrides: Partial<RxDocument> = {}): RxDocument {
  return documentFixture({
    snapshot: snapshot({
      patient: { name: HOSTILE.script, allergies: [HOSTILE.img] },
      clinic: { name: HOSTILE.img, addressLines: [HOSTILE.urls], phone: HOSTILE.quotes, email: HOSTILE.script, footerLines: [HOSTILE.script] },
      doctor: { name: HOSTILE.quotes, qualifications: HOSTILE.urls, designation: HOSTILE.img, registrationNo: HOSTILE.script, registrationCouncil: HOSTILE.urls },
    }),
    visit: visit({
      chiefComplaint: HOSTILE.script,
      complaints: [HOSTILE.img],
      diagnosis: [HOSTILE.urls],
      medicalHistory: [HOSTILE.quotes],
      drugHistory: [HOSTILE.script],
      examinationNotes: HOSTILE.img,
      vitals: { pulse: 80, notes: HOSTILE.script },
      investigations: [{ name: HOSTILE.script, instructions: HOSTILE.img }],
      advice: `${HOSTILE.script}\n${HOSTILE.longWord}`,
      followUpReason: HOSTILE.urls,
    }),
    items: [
      item(1, {
        drugName: HOSTILE.script,
        genericName: HOSTILE.img,
        strength: HOSTILE.quotes,
        dose: HOSTILE.urls,
        route: HOSTILE.script,
        remarks: HOSTILE.img,
        foodRelation: "<b>bold</b>",
        periodicity: HOSTILE.img,
      }),
      item(2, { doseMorning: null, doseAfternoon: null, doseNight: null, timing: HOSTILE.img }),
    ],
    ...overrides,
  });
}

describe("hostile text", () => {
  for (const key of BUILTIN_TEMPLATES) {
    for (const labels of LABEL_LANGUAGES) {
      it(`prints every field literally in ${key} / ${labels}`, () => {
        const base = hostileDocument();
        const doc: RxDocument = { ...base, snapshot: { ...base.snapshot, layout: { template: { kind: "builtin", key }, paperSize: "A4", labels } } };
        const out = render(doc, { ...NO_ASSETS, signature: TINY_PNG });
        const dom = parse(out.html);

        expect(checkSelfContained(out.html)).toEqual({ ok: true });
        expect(dom.querySelectorAll("script, iframe, object, embed, link, svg, a, form, base")).toHaveLength(0);
        expect(dom.querySelectorAll("img")).toHaveLength(1); // only the signature we passed in
        const handlers = Array.from(dom.querySelectorAll("*")).flatMap((el) => Array.from(el.attributes)).filter((a) => a.name.startsWith("on"));
        expect(handlers).toHaveLength(0);

        const body = dom.body.textContent ?? "";
        expect(body).toContain(HOSTILE.script);
        expect(body).toContain(HOSTILE.img);
        expect(body).toContain("<b>bold</b>");
      });
    }
  }

  it("keeps a 2,000-character word and lets it wrap instead of overflowing", () => {
    const out = render(hostileDocument());
    expect(text(out.html)).toContain(HOSTILE.longWord);
    expect(out.html).toContain("overflow-wrap:anywhere");
  });

  it("isolates right-to-left overrides so they cannot reorder the labels around them", () => {
    expect(HOSTILE.bidi.codePointAt(0)).toBe(0x202e);
    expect(Array.from(HOSTILE.bidi)).toHaveLength(6);
    const dom = parse(render(documentFixture({ snapshot: snapshot({ patient: { name: HOSTILE.bidi } }) })).html);
    const holder = Array.from(dom.querySelectorAll("span.v")).find((el) => el.textContent === HOSTILE.bidi);
    expect(holder).toBeDefined();
    expect(dom.querySelector("style")?.textContent).toContain(".v{unicode-bidi:isolate}");
  });
});

describe("pagination structure", () => {
  it("prints 30 medicines in order inside a repeating table header, with rows that never split", () => {
    const out = render(documentFixture({ items: manyItems(30) }));
    const dom = parse(out.html);
    const rows = Array.from(dom.querySelectorAll(".meds tbody tr"));
    expect(rows).toHaveLength(30);
    rows.forEach((row, i) => expect(row.querySelector(".med-name")?.textContent?.startsWith(`${i + 1}. Medicine ${i + 1}`)).toBe(true));
    expect(dom.querySelector("table.sheet > thead .pad-head")).not.toBeNull();
    expect(dom.querySelector("table.sheet > tfoot .pad-foot")).not.toBeNull();
    expect(out.html).toContain(".sheet>thead{display:table-header-group}");
    expect(out.html).toContain(".sheet>tfoot{display:table-footer-group}");
    expect(out.html).toContain(".meds>thead{display:table-header-group}");
    expect(out.html).toContain(".meds tr{break-inside:avoid;page-break-inside:avoid}");
  });

  it("sets the page size and margins for A4 and A5", () => {
    expect(render(documentFixture()).html).toContain("@page{size:A4 portrait;margin:12mm 12mm 14mm 12mm}");
    const a5 = render(documentFixture({ layout: { paperSize: "A5" } }));
    expect(a5.html).toContain("@page{size:A5 portrait;margin:9mm 9mm 12mm 9mm}");
    expect(a5.paper).toMatchObject({ size: "A5", widthIn: 5.83, heightIn: 8.27 });
  });

  it("carries long Devanagari text in full and marks the document Hindi", () => {
    const doc = documentFixture({
      layout: { labels: "hi" },
      snapshot: snapshot({ patient: { name: DEVANAGARI.name }, layout: { labels: "hi" } }),
      visit: visit({ advice: DEVANAGARI.advice, complaints: [DEVANAGARI.complaint] }),
    });
    const out = render(doc);
    expect(out.html).toContain('<html lang="hi">');
    expect(text(out.html)).toContain(DEVANAGARI.advice);
    expect(text(out.html)).toContain(DEVANAGARI.name);
  });
});

describe("templates", () => {
  it("General prints morning/noon/evening/night columns and free-text timing across them", () => {
    const dom = parse(render(documentFixture()).html);
    expect(dom.querySelector(".meds-slots")).not.toBeNull();
    const headings = Array.from(dom.querySelectorAll(".meds th")).map((th) => th.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Mor", "Noon", "Eve", "Night"]));
    const first = Array.from(dom.querySelectorAll(".meds tbody tr")[0].querySelectorAll("td.slot")).map((td) => td.textContent);
    expect(first).toEqual(["1", "0", "0", "1"]);
    const free = dom.querySelectorAll(".meds tbody tr")[2].querySelector("td.slot-text");
    expect(free?.getAttribute("colspan")).toBe("4");
    expect(free?.textContent).toBe("After every loose stool");
    expect(dom.querySelector(".vitals")?.textContent).toContain("BP 130/85 mmHg");
  });

  it("Paediatric leads with weight and prints dose and schedule columns", () => {
    const dom = parse(render(documentFixture({ layout: { template: { kind: "builtin", key: "paediatric" } } })).html);
    expect(dom.querySelector(".meds-pattern")).not.toBeNull();
    expect(dom.querySelector(".patient")?.textContent).toContain("Weight: 70 kg");
    expect(dom.querySelector(".meds tbody tr td.when")?.textContent).toBe("1-0-1");
  });

  it("Derma prints how to use each medicine and no vitals", () => {
    const dom = parse(render(documentFixture({ layout: { template: { kind: "builtin", key: "derma" } } })).html);
    expect(dom.querySelector(".meds-topical")).not.toBeNull();
    expect(dom.querySelector(".vitals")).toBeNull();
    expect(dom.querySelector(".meds tbody tr td.how")?.textContent).toBe("Oral · 1 tab · 1-0-1 · After food");
  });

  it("omits empty sections", () => {
    const dom = parse(render(documentFixture({ visit: visit({ advice: null, investigations: [], examinationNotes: "  " }) })).html);
    expect(dom.body.textContent).not.toContain("Advice");
    expect(dom.body.textContent).not.toContain("Investigations");
    expect(dom.body.textContent).not.toContain("Examination");
  });
});

describe("labels", () => {
  it("uses English, Hindi, or both for headings and coded values", () => {
    expect(text(render(documentFixture()).html)).toContain("Diagnosis:");
    expect(text(render(documentFixture()).html)).toContain("After food");

    const hindi = text(render(documentFixture({ layout: { labels: "hi" } })).html);
    expect(hindi).toContain(`${translations.hindi.diagnosis}:`);
    expect(hindi).toContain(translations.hindi.after);

    const both = render(documentFixture({ layout: { labels: "bilingual" } })).html;
    expect(text(both)).toContain(`Diagnosis / ${translations.hindi.diagnosis}:`);
    expect(parse(both).querySelector(".meds th .l-hi")?.textContent).toBe(translations.hindi.medicine);
  });
});

describe("status markers", () => {
  it("watermarks a draft, shows no Rx number, and dates it on the day it was rendered", () => {
    const dom = parse(render(documentFixture({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" })).html);
    expect(dom.querySelector(".watermark")?.textContent).toBe("DRAFT · NOT VALID FOR DISPENSING");
    expect(dom.querySelector(".banner-draft")).not.toBeNull();
    expect(dom.body.textContent).not.toContain("Rx No.");
    expect(dom.querySelector(".patient-meta")?.textContent).toContain("12/11/2026");
    expect(dom.querySelector(".note")).toBeNull();
  });

  it("marks a superseded version on every page with the version that replaced it", () => {
    const dom = parse(
      render(documentFixture({ status: "amended", supersededBy: { version: 2, issuedAt: "2026-11-13T04:00:00.000Z" } })).html,
    );
    expect(dom.querySelector(".watermark")?.textContent).toBe("SUPERSEDED");
    expect(dom.querySelector("thead .banner-superseded")?.textContent).toBe(
      "SUPERSEDED by version 2 issued 13/11/2026. Do not dispense from this copy.",
    );
  });

  it("shows an amendment's version and what it replaces", () => {
    const dom = parse(render(documentFixture({ version: 2, replacesVersion: 1 })).html);
    expect(dom.querySelector(".patient-meta")?.textContent).toContain("12 (v2)");
    expect(dom.querySelector(".patient-meta")?.textContent).toContain("Replaces version 1");
  });

  it("says when a finalized prescription was printed from today's details", () => {
    const dom = parse(render(documentFixture({ snapshotSource: "live" })).html);
    expect(dom.querySelector(".note")?.textContent).toContain("finalized before print snapshots were recorded");
  });
});

describe("assets", () => {
  it("embeds the logo and signature as data URIs", () => {
    const dom = parse(render(documentFixture(), { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG }).html);
    expect(dom.querySelector(".logo img")?.getAttribute("src")).toBe(`data:image/png;base64,${TINY_PNG.base64}`);
    expect(dom.querySelector(".sig-box img")).not.toBeNull();
  });

  it("keeps the signature block intact without a signature image", () => {
    const dom = parse(render(documentFixture()).html);
    expect(dom.querySelector(".sig-box")?.children).toHaveLength(0);
    expect(dom.querySelector(".sig-name")?.textContent).toBe("Dr. Meera Shah");
    expect(dom.querySelector(".sig-line")?.textContent).toBe("Reg. No.: MMC 2011/04/1234");
  });

  it("drops an asset whose base64 is not base64", () => {
    const dom = parse(render(documentFixture(), { ...NO_ASSETS, logo: { ...TINY_PNG, base64: '"><script>' } }).html);
    expect(dom.querySelector(".logo")).toBeNull();
  });

  it("places the font CSS before the document CSS", () => {
    const out = render(documentFixture(), { ...NO_ASSETS, fontCss: "/*fonts*/" });
    expect(out.html.indexOf("/*fonts*/")).toBeLessThan(out.html.indexOf("@page"));
  });
});

describe("determinism and the PDF footer", () => {
  it("renders byte-identical HTML for the same input", () => {
    expect(render(documentFixture()).html).toBe(render(documentFixture()).html);
  });

  it("titles the document without patient data", () => {
    expect(render(documentFixture()).title).toBe("Prescription Rx-12 v1");
    expect(render(documentFixture({ status: "draft", rxNo: null })).title).toBe("Prescription draft v1");
  });

  it("builds a self-contained page-number footer with no patient data", () => {
    const doc = documentFixture();
    const footer = footerTemplate(doc, render(doc).paper);
    expect(footer).toContain('class="pageNumber"');
    expect(footer).toContain('class="totalPages"');
    expect(footer).toContain("Rx 12 v1");
    expect(footer).not.toContain("Asha");
    expect(checkSelfContained(footer)).toEqual({ ok: true });
  });
});

describe("golden files", () => {
  const assets: RenderAssets = { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG };

  it("General, A4, English", async () => {
    await expect(render(documentFixture(), assets).html).toMatchFileSnapshot("./__golden__/rx-general-a4-en.html");
  });

  it("Paediatric, A5, bilingual", async () => {
    const doc = documentFixture({ layout: { template: { kind: "builtin", key: "paediatric" }, paperSize: "A5", labels: "bilingual" } });
    await expect(render(doc, assets).html).toMatchFileSnapshot("./__golden__/rx-paediatric-a5-bilingual.html");
  });

  it("Derma, A4, Hindi", async () => {
    const doc = documentFixture({ layout: { template: { kind: "builtin", key: "derma" }, labels: "hi" } });
    await expect(render(doc, assets).html).toMatchFileSnapshot("./__golden__/rx-derma-a4-hi.html");
  });

  it("General draft", async () => {
    const doc = documentFixture({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" });
    await expect(render(doc, NO_ASSETS).html).toMatchFileSnapshot("./__golden__/rx-general-draft.html");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/rx-render.test.ts
```

Expected: FAIL — `@/lib/rx-render/render` cannot be resolved.

- [ ] **Step 3: Implement the template definitions**

`src/lib/rx-render/templates.ts`:

```ts
import type { BuiltinTemplateKey } from "./types";

export type VitalKey = "bp" | "pulse" | "temperatureF" | "spo2" | "respiratoryRate" | "weightKg" | "heightCm" | "bmi" | "bloodSugarMgDl";

export type SectionKey =
  | "vitals"
  | "chiefComplaint"
  | "complaints"
  | "medicalHistory"
  | "drugHistory"
  | "examination"
  | "diagnosis"
  | "medicines"
  | "investigations"
  | "advice"
  | "followUp";

/** slots: M/A/E/N columns (legacy pad); pattern: dose + "1-0-1" columns; topical: how-to-use column. */
export type MedicineLayout = "slots" | "pattern" | "topical";

export type TemplateDefinition = {
  key: BuiltinTemplateKey;
  name: string;
  description: string;
  accent: string;
  sections: SectionKey[];
  vitals: VitalKey[];
  medicineLayout: MedicineLayout;
  /** Paediatric dosing is weight-based: print weight next to the age. */
  prominentWeight: boolean;
};

/** Built-in pads are data, drawn by one renderer. Template Studio (Phase 2) adds other kinds beside them. */
export const TEMPLATE_DEFINITIONS: Record<BuiltinTemplateKey, TemplateDefinition> = {
  general: {
    key: "general",
    name: "General",
    description: "The classic pad: morning, noon, evening and night dose columns.",
    accent: "#b91c1c",
    sections: ["vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp"],
    vitals: ["bp", "pulse", "temperatureF", "spo2", "respiratoryRate", "weightKg", "heightCm", "bmi", "bloodSugarMgDl"],
    medicineLayout: "slots",
    prominentWeight: false,
  },
  paediatric: {
    key: "paediatric",
    name: "Paediatric",
    description: "Weight beside the age, with dose and schedule columns for syrups and drops.",
    accent: "#0f766e",
    sections: ["vitals", "chiefComplaint", "complaints", "medicalHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp"],
    vitals: ["weightKg", "heightCm", "temperatureF", "pulse", "respiratoryRate", "spo2", "bp"],
    medicineLayout: "pattern",
    prominentWeight: true,
  },
  derma: {
    key: "derma",
    name: "Dermatology",
    description: "Findings first, with how-to-use instructions for creams and lotions.",
    accent: "#6d28d9",
    sections: ["chiefComplaint", "complaints", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp", "medicalHistory", "drugHistory"],
    vitals: [],
    medicineLayout: "topical",
    prominentWeight: false,
  },
};
```

- [ ] **Step 4: Implement the print CSS**

`src/lib/rx-render/styles.ts`:

```ts
import type { TemplateDefinition } from "./templates";
import type { PaperSpec } from "./types";

/**
 * Print-first CSS. The outer .sheet table repeats its thead (pad header) and tfoot (pad footer)
 * on every printed page; the medicines table repeats its own header; rows never split. No url(),
 * no @import, no backslashes: checkSelfContained() would refuse them.
 */
export function documentCss(def: TemplateDefinition, paper: PaperSpec): string {
  const m = paper.marginMm;
  return [
    `@page{size:${paper.size} portrait;margin:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm}`,
    `:root{--accent:${def.accent}}`,
    `*{box-sizing:border-box}`,
    `html,body{margin:0;padding:0;background:#fff;color:#111;-webkit-print-color-adjust:exact;print-color-adjust:exact}`,
    `body{font-family:"Noto Sans Devanagari",sans-serif;font-size:${paper.baseFontPt}pt;line-height:1.35}`,
    `.sheet{width:100%;border-collapse:collapse}`,
    `.sheet>thead{display:table-header-group}`,
    `.sheet>tfoot{display:table-footer-group}`,
    `.sheet>thead>tr>td,.sheet>tfoot>tr>td,.sheet>tbody>tr>td{padding:0;vertical-align:top}`,
    `td,th,.v{overflow-wrap:anywhere;word-break:break-word}`,
    `.v{unicode-bidi:isolate}`,
    `.pad-head{border-bottom:2px solid var(--accent);padding-bottom:2mm;margin-bottom:3mm}`,
    `.head-row{display:flex;justify-content:space-between;align-items:flex-start;gap:4mm}`,
    `.doc,.clinic{flex:1;min-width:0}`,
    `.clinic{text-align:right}`,
    `.doc-name,.clinic-name{font-size:1.35em;font-weight:700;color:var(--accent)}`,
    `.doc-line,.clinic-line{font-size:.9em}`,
    `.logo img{display:block;max-height:22mm;max-width:40mm;width:auto;height:auto}`,
    `.banner{margin-top:2mm;padding:1.5mm 2mm;border:1px solid #b45309;background:#fef3c7;font-weight:700;font-size:.9em}`,
    `.banner-superseded{border-color:#b91c1c;background:#fee2e2}`,
    `.watermark{position:fixed;top:45%;left:0;right:0;text-align:center;transform:rotate(-30deg);font-size:3.2em;font-weight:700;color:rgba(185,28,28,.14);pointer-events:none}`,
    `.patient{display:flex;justify-content:space-between;gap:4mm;margin-bottom:2mm}`,
    `.patient-main{display:flex;flex-wrap:wrap;gap:1mm 5mm}`,
    `.patient-meta{text-align:right;white-space:nowrap}`,
    `.k{font-weight:700}`,
    `.small{font-size:.85em}`,
    `.muted{color:#555}`,
    `.generic{color:#555;font-size:.85em;font-style:italic}`,
    `.allergies{margin:1mm 0 2mm;padding:1mm 2mm;border-left:3px solid #b91c1c;background:#fff1f2}`,
    `.vitals{display:flex;flex-wrap:wrap;gap:1mm 5mm;margin:1mm 0 2mm}`,
    `.line{margin:0 0 1.2mm}`,
    `.block{margin:2mm 0;break-inside:avoid}`,
    `.block-title{font-weight:700;color:var(--accent)}`,
    `.block-body{margin-top:.5mm}`,
    `.rx-mark{font-size:1.9em;font-weight:700;font-style:italic;color:var(--accent);margin:1mm 0}`,
    `.rx-mark span{font-size:.6em}`,
    `.meds{width:100%;border-collapse:collapse;margin:1mm 0 3mm;table-layout:fixed}`,
    `.meds>thead{display:table-header-group}`,
    `.meds th,.meds td{border:1px solid #333;padding:1mm 1.2mm;vertical-align:top}`,
    `.meds th{background:#f3f4f6;font-weight:700;text-align:center;font-size:.9em}`,
    `.meds th.left{text-align:left}`,
    `.meds tr{break-inside:avoid;page-break-inside:avoid}`,
    `.l-hi{display:block;font-weight:400;font-size:.85em}`,
    `.slot,.slot-text,.center,.when{text-align:center}`,
    `.slot{font-weight:700}`,
    `.med-name{font-weight:700}`,
    `.sos{color:#b91c1c;font-weight:700;font-size:.85em}`,
    `.meds-slots .c-med{width:34%}.meds-slots .c-slot{width:6%}.meds-slots .c-food{width:14%}.meds-slots .c-freq{width:28%}`,
    `.meds-pattern .c-med{width:30%}.meds-pattern .c-dose{width:12%}.meds-pattern .c-when{width:12%}.meds-pattern .c-food{width:13%}.meds-pattern .c-dur{width:15%}.meds-pattern .c-rem{width:18%}`,
    `.meds-topical .c-med{width:32%}.meds-topical .c-how{width:30%}.meds-topical .c-dur{width:14%}.meds-topical .c-ins{width:24%}`,
    `.tests{margin:.5mm 0 0;padding-left:5mm}`,
    `.sig{margin-top:6mm;margin-left:auto;width:55mm;text-align:center;break-inside:avoid}`,
    `.sig-box{height:16mm;display:flex;align-items:flex-end;justify-content:center;border-bottom:1px solid #999}`,
    `.sig-box img{max-height:16mm;max-width:50mm;width:auto;height:auto}`,
    `.sig-name{font-weight:700;margin-top:1mm}`,
    `.sig-line{font-size:.85em}`,
    `.note{margin-top:4mm;font-size:.8em;color:#555;font-style:italic}`,
    `.pad-foot{border-top:1px solid #999;margin-top:3mm;padding-top:1.5mm;text-align:center;font-size:.85em;color:#333}`,
    `@media screen{html{background:#e5e7eb}body{width:${paper.widthMm}mm;min-height:${paper.heightMm}mm;margin:6mm auto;padding:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;box-shadow:0 1px 4px rgba(0,0,0,.2)}}`,
  ].join("\n");
}
```

- [ ] **Step 5: Implement the renderer**

`src/lib/rx-render/render.ts`:

```ts
import { bmi, formatBp } from "@/lib/domain/rx-format";
import type { Vitals } from "@/lib/domain/rx-options";
import { formatCalendarDate, formatIssuedDate, hasSlots, quantityText, scheduleText } from "./format";
import { html, raw, userText, type HtmlValue, type SafeHtml } from "./html";
import { ageText, durationText, foodText, genderText, labelHtml, labelText, periodicityText, type LabelKey } from "./labels";
import { PAPER } from "./paper";
import { documentCss } from "./styles";
import { TEMPLATE_DEFINITIONS, type SectionKey, type TemplateDefinition, type VitalKey } from "./templates";
import type { ImageAsset, LabelLanguage, PaperSpec, RenderAssets, RenderedDocument, RxDocument, RxItem } from "./types";

/** Nothing may load: styles are inline, fonts and images are data: URIs, there are no scripts. */
export const DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

type Ctx = { doc: RxDocument; def: TemplateDefinition; lang: LabelLanguage; assets: RenderAssets; paper: PaperSpec };

function assertNever(value: never): never {
  throw new Error(`Unsupported template ${JSON.stringify(value)}`);
}

/**
 * Renders a prescription pad as one self-contained HTML document. Pure: the same input gives
 * byte-identical output. Dispatches on the template kind so Phase 2 kinds slot in here.
 */
export function renderPrescription(doc: RxDocument, assets: RenderAssets): RenderedDocument {
  const { template, paperSize, labels } = doc.snapshot.layout;
  if (template.kind === "builtin") {
    return renderBuiltin({ doc, def: TEMPLATE_DEFINITIONS[template.key], lang: labels, assets, paper: PAPER[paperSize] });
  }
  return assertNever(template);
}

function documentTitle(doc: RxDocument): string {
  return `Prescription ${doc.rxNo !== null ? `Rx-${doc.rxNo}` : "draft"} v${doc.version}`;
}

function renderBuiltin(c: Ctx): RenderedDocument {
  const title = documentTitle(c.doc);
  const page = html`<!doctype html>
<html lang="${c.lang === "en" ? "en" : "hi"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${raw(DOCUMENT_CSP)}">
<title>${title}</title>
<style>${raw(c.assets.fontCss)}
${raw(documentCss(c.def, c.paper))}</style>
</head>
<body class="tpl-${c.def.key} paper-${c.paper.size.toLowerCase()} status-${c.doc.status}" data-rx="ready">
${watermark(c.doc)}
<table class="sheet">
<thead><tr><td>${padHeader(c)}</td></tr></thead>
<tfoot><tr><td>${padFooter(c)}</td></tr></tfoot>
<tbody><tr><td>
${patientStrip(c)}
<div class="rx-mark">R<span>x</span></div>
${c.def.sections.map((key) => section(c, key))}
${signature(c)}
${snapshotNote(c)}
</td></tr></tbody>
</table>
</body>
</html>
`;
  return { format: "html", html: page.value, footerHtml: footerTemplate(c.doc, c.paper), paper: c.paper, title };
}

/** Gotenberg's Chromium footer: page numbers and the Rx number only (no user text, system font is fine). */
export function footerTemplate(doc: RxDocument, paper: PaperSpec): string {
  const id = doc.rxNo !== null ? `Rx ${doc.rxNo} v${doc.version}` : "Draft";
  const side = `${paper.marginMm.left}mm`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:100%;font-family:sans-serif;font-size:7pt;color:#555}.f{display:flex;justify-content:space-between;padding:0 ${side}}</style></head><body><div class="f"><span>${id}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div></body></html>`;
}

function image(asset: ImageAsset): HtmlValue {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(asset.base64)) return null;
  return html`<img src="${raw(`data:${asset.mime};base64,${asset.base64}`)}" alt="" width="${asset.width}" height="${asset.height}">`;
}

function watermark(doc: RxDocument): HtmlValue {
  if (doc.status === "draft") return html`<div class="watermark">DRAFT · NOT VALID FOR DISPENSING</div>`;
  if (doc.supersededBy) return html`<div class="watermark">SUPERSEDED</div>`;
  return null;
}

function statusBanner(c: Ctx): HtmlValue {
  const { doc } = c;
  if (doc.status === "draft") {
    return html`<div class="banner banner-draft">DRAFT PREVIEW · This is not a prescription until it is finalized.</div>`;
  }
  if (doc.supersededBy) {
    const issued = doc.supersededBy.issuedAt ? formatIssuedDate(doc.supersededBy.issuedAt, doc.snapshot.clinic.timezone) : "";
    return html`<div class="banner banner-superseded">SUPERSEDED by version ${doc.supersededBy.version}${issued ? ` issued ${issued}` : ""}. Do not dispense from this copy.</div>`;
  }
  return null;
}

function padHeader(c: Ctx): SafeHtml {
  const { clinic, doctor } = c.doc.snapshot;
  return html`<header class="pad-head">
<div class="head-row">
<div class="doc">
<div class="doc-name">${userText(doctor.name)}</div>
${doctor.qualifications ? html`<div class="doc-line">${userText(doctor.qualifications)}</div>` : null}
${doctor.designation ? html`<div class="doc-line">${userText(doctor.designation)}</div>` : null}
${doctor.registrationNo ? html`<div class="doc-line">${labelText("regNo", c.lang)}: ${userText(doctor.registrationNo)}${doctor.registrationCouncil ? html` (${userText(doctor.registrationCouncil)})` : null}</div>` : null}
</div>
${c.assets.logo && image(c.assets.logo) ? html`<div class="logo">${image(c.assets.logo)}</div>` : null}
<div class="clinic">
<div class="clinic-name">${userText(clinic.name)}</div>
${clinic.addressLines.map((line) => html`<div class="clinic-line">${userText(line)}</div>`)}
${clinic.phone ? html`<div class="clinic-line">${labelText("phone", c.lang)}: ${userText(clinic.phone)}</div>` : null}
${clinic.email ? html`<div class="clinic-line">${userText(clinic.email)}</div>` : null}
</div>
</div>
${statusBanner(c)}
</header>`;
}

function padFooter(c: Ctx): SafeHtml {
  return html`<footer class="pad-foot">${c.doc.snapshot.clinic.footerLines.map((line) => html`<div>${userText(line)}</div>`)}</footer>`;
}

function kv(c: Ctx, key: LabelKey, value: string): SafeHtml {
  return html`<div class="kv"><span class="k">${labelText(key, c.lang)}:</span> ${userText(value)}</div>`;
}

function patientStrip(c: Ctx): SafeHtml {
  const { doc, lang } = c;
  const patient = doc.snapshot.patient;
  const age = ageText(patient.ageLabel, lang);
  const gender = genderText(patient.gender, lang);
  const weight = c.def.prominentWeight && doc.visit.vitals.weightKg !== undefined ? `${doc.visit.vitals.weightKg} kg` : "";
  const date = formatIssuedDate(doc.issuedAt ?? doc.snapshot.takenAt, doc.snapshot.clinic.timezone);
  const rxNo = doc.rxNo !== null ? (doc.version > 1 ? `${doc.rxNo} (v${doc.version})` : String(doc.rxNo)) : "";
  return html`<section class="patient">
<div class="patient-main">
<div class="kv"><span class="k">${labelText("name", lang)}:</span> <b>${userText(patient.name)}</b></div>
${age ? kv(c, "age", age) : null}
${gender ? kv(c, "gender", gender) : null}
${weight ? kv(c, "weight", weight) : null}
${patient.patientNo !== null ? kv(c, "patientNo", String(patient.patientNo)) : null}
</div>
<div class="patient-meta">
${kv(c, "date", date)}
${rxNo ? kv(c, "rxNo", rxNo) : null}
${doc.replacesVersion !== null ? html`<div class="small">Replaces version ${doc.replacesVersion}</div>` : null}
</div>
</section>
${patient.allergies.length > 0 ? html`<div class="allergies"><span class="k">${labelText("allergies", lang)}:</span> ${userText(patient.allergies.join(", "))}</div>` : null}`;
}

const VITAL_LABEL: Record<VitalKey, LabelKey> = {
  bp: "bp",
  pulse: "pulse",
  temperatureF: "temperature",
  spo2: "spo2",
  respiratoryRate: "respiratoryRate",
  weightKg: "weight",
  heightCm: "height",
  bmi: "bmi",
  bloodSugarMgDl: "bloodSugar",
};

const VITAL_VALUE: Record<VitalKey, (v: Vitals) => string | null> = {
  bp: (v) => (formatBp(v.bpSystolic, v.bpDiastolic) ? `${formatBp(v.bpSystolic, v.bpDiastolic)} mmHg` : null),
  pulse: (v) => (v.pulse !== undefined ? `${v.pulse}/min` : null),
  temperatureF: (v) => (v.temperatureF !== undefined ? `${v.temperatureF} °F` : null),
  spo2: (v) => (v.spo2 !== undefined ? `${v.spo2}%` : null),
  respiratoryRate: (v) => (v.respiratoryRate !== undefined ? `${v.respiratoryRate}/min` : null),
  weightKg: (v) => (v.weightKg !== undefined ? `${v.weightKg} kg` : null),
  heightCm: (v) => (v.heightCm !== undefined ? `${v.heightCm} cm` : null),
  bmi: (v) => {
    const index = bmi(v.weightKg, v.heightCm);
    return index === null ? null : String(index);
  },
  bloodSugarMgDl: (v) => (v.bloodSugarMgDl !== undefined ? `${v.bloodSugarMgDl} mg/dL` : null),
};

function vitalsBlock(c: Ctx): HtmlValue {
  const v = c.doc.visit.vitals;
  const parts = c.def.vitals
    .map((key) => {
      const value = VITAL_VALUE[key](v);
      return value === null ? null : html`<span class="vital"><span class="k">${labelText(VITAL_LABEL[key], c.lang)}</span> ${value}</span>`;
    })
    .filter((part): part is SafeHtml => part !== null);
  if (parts.length === 0 && !v.notes) return null;
  return html`<div class="vitals">${parts}${v.notes ? html`<span class="vital">${userText(v.notes)}</span>` : null}</div>`;
}

function line(c: Ctx, key: LabelKey, value: string | null): HtmlValue {
  if (!value || value.trim() === "") return null;
  return html`<p class="line"><span class="k">${labelText(key, c.lang)}:</span> ${userText(value)}</p>`;
}

function listLine(c: Ctx, key: LabelKey, values: string[]): HtmlValue {
  return values.length === 0 ? null : line(c, key, values.join(", "));
}

function block(c: Ctx, key: LabelKey, value: string | null): HtmlValue {
  if (!value || value.trim() === "") return null;
  return html`<section class="block"><div class="block-title">${labelText(key, c.lang)}</div><div class="block-body">${userText(value)}</div></section>`;
}

function investigations(c: Ctx): HtmlValue {
  const tests = c.doc.visit.investigations;
  if (tests.length === 0) return null;
  return html`<section class="block"><div class="block-title">${labelText("investigations", c.lang)}</div><ol class="tests">${tests.map(
    (t) => html`<li>${userText(t.name)}${t.instructions ? html` <span class="muted">(${userText(t.instructions)})</span>` : null}</li>`,
  )}</ol></section>`;
}

function followUp(c: Ctx): HtmlValue {
  const { followUpDate, followUpReason } = c.doc.visit;
  const date = formatCalendarDate(followUpDate);
  if (!date && !followUpReason) return null;
  return html`<p class="line"><span class="k">${labelText("followUp", c.lang)}:</span> ${date}${date && followUpReason ? " · " : ""}${userText(followUpReason)}</p>`;
}

function section(c: Ctx, key: SectionKey): HtmlValue {
  const v = c.doc.visit;
  switch (key) {
    case "vitals":
      return vitalsBlock(c);
    case "chiefComplaint":
      return line(c, "chiefComplaint", v.chiefComplaint);
    case "complaints":
      return listLine(c, "complaints", v.complaints);
    case "medicalHistory":
      return listLine(c, "medicalHistory", v.medicalHistory);
    case "drugHistory":
      return listLine(c, "drugHistory", v.drugHistory);
    case "examination":
      return block(c, "examination", v.examinationNotes);
    case "diagnosis":
      return listLine(c, "diagnosis", v.diagnosis);
    case "medicines":
      return medicines(c);
    case "investigations":
      return investigations(c);
    case "advice":
      return block(c, "advice", v.advice);
    case "followUp":
      return followUp(c);
  }
}

function medicineCell(c: Ctx, item: RxItem, index: number, show: { dose: boolean; remarks: boolean; form: boolean }): SafeHtml {
  return html`<td class="med">
<div class="med-name">${index + 1}. ${userText(item.drugName)}${item.strength ? html` <span class="muted">${userText(item.strength)}</span>` : null}${item.isSos ? html` <span class="sos">SOS</span>` : null}</div>
${item.genericName ? html`<div class="generic">${userText(item.genericName)}</div>` : null}
${show.form && item.form ? html`<div class="small">${userText(item.form)}</div>` : null}
${show.dose && item.dose ? html`<div class="small">${labelText("dose", c.lang)}: ${userText(item.dose)}</div>` : null}
${show.remarks && item.remarks ? html`<div class="small">${userText(item.remarks)}</div>` : null}
</td>`;
}

function frequencyAndDuration(c: Ctx, item: RxItem): string {
  return [periodicityText(item.periodicity, c.lang), durationText(item.durationValue, item.durationUnit, c.lang)]
    .filter((part) => part !== "")
    .join(" · ");
}

function medicines(c: Ctx): HtmlValue {
  if (c.doc.items.length === 0) return null;
  switch (c.def.medicineLayout) {
    case "slots":
      return slotsTable(c);
    case "pattern":
      return patternTable(c);
    case "topical":
      return topicalTable(c);
  }
}

function slotsTable(c: Ctx): SafeHtml {
  const { lang } = c;
  const rows = c.doc.items.map((item, i) => {
    const slots = hasSlots(item)
      ? html`<td class="slot">${quantityText(item.doseMorning)}</td><td class="slot">${quantityText(item.doseAfternoon)}</td><td class="slot">${quantityText(item.doseEvening)}</td><td class="slot">${quantityText(item.doseNight)}</td>`
      : html`<td class="slot-text" colspan="4">${userText(item.timing)}</td>`;
    return html`<tr>${medicineCell(c, item, i, { dose: true, remarks: true, form: false })}${slots}<td class="center">${foodText(item.foodRelation, lang)}</td><td class="center">${frequencyAndDuration(c, item)}</td></tr>`;
  });
  return html`<table class="meds meds-slots">
<colgroup><col class="c-med"><col class="c-slot"><col class="c-slot"><col class="c-slot"><col class="c-slot"><col class="c-food"><col class="c-freq"></colgroup>
<thead>
<tr><th rowspan="2" class="left">${labelHtml("medicine", lang)}</th><th colspan="4">${labelHtml("dose", lang)}</th><th rowspan="2">${labelHtml("food", lang)}</th><th rowspan="2">${labelHtml("frequencyDuration", lang)}</th></tr>
<tr><th>${labelHtml("morning", lang)}</th><th>${labelHtml("afternoon", lang)}</th><th>${labelHtml("evening", lang)}</th><th>${labelHtml("night", lang)}</th></tr>
</thead>
<tbody>${rows}</tbody>
</table>`;
}

function patternTable(c: Ctx): SafeHtml {
  const { lang } = c;
  const rows = c.doc.items.map(
    (item, i) =>
      html`<tr>${medicineCell(c, item, i, { dose: false, remarks: false, form: false })}<td>${userText(item.dose)}</td><td class="when">${userText(scheduleText(item))}</td><td class="center">${foodText(item.foodRelation, lang)}</td><td class="center">${frequencyAndDuration(c, item)}</td><td>${userText(item.remarks)}</td></tr>`,
  );
  return html`<table class="meds meds-pattern">
<colgroup><col class="c-med"><col class="c-dose"><col class="c-when"><col class="c-food"><col class="c-dur"><col class="c-rem"></colgroup>
<thead><tr><th class="left">${labelHtml("medicine", lang)}</th><th>${labelHtml("dose", lang)}</th><th>${labelHtml("when", lang)}</th><th>${labelHtml("food", lang)}</th><th>${labelHtml("duration", lang)}</th><th>${labelHtml("remarks", lang)}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function topicalTable(c: Ctx): SafeHtml {
  const { lang } = c;
  const rows = c.doc.items.map((item, i) => {
    const how = [item.route ?? "", item.dose ?? "", scheduleText(item), foodText(item.foodRelation, lang)]
      .filter((part) => part.trim() !== "")
      .join(" · ");
    return html`<tr>${medicineCell(c, item, i, { dose: false, remarks: false, form: true })}<td class="how">${userText(how)}</td><td class="center">${frequencyAndDuration(c, item)}</td><td>${userText(item.remarks)}</td></tr>`;
  });
  return html`<table class="meds meds-topical">
<colgroup><col class="c-med"><col class="c-how"><col class="c-dur"><col class="c-ins"></colgroup>
<thead><tr><th class="left">${labelHtml("medicine", lang)}</th><th>${labelHtml("howToUse", lang)}</th><th>${labelHtml("duration", lang)}</th><th>${labelHtml("instructions", lang)}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function signature(c: Ctx): SafeHtml {
  const doctor = c.doc.snapshot.doctor;
  return html`<div class="sig">
<div class="sig-box">${c.assets.signature ? image(c.assets.signature) : null}</div>
<div class="sig-name">${userText(doctor.name)}</div>
${doctor.registrationNo ? html`<div class="sig-line">${labelText("regNo", c.lang)}: ${userText(doctor.registrationNo)}</div>` : null}
</div>`;
}

function snapshotNote(c: Ctx): HtmlValue {
  if (c.doc.status === "draft" || c.doc.snapshotSource !== "live") return null;
  return html`<p class="note">Printed with the clinic, doctor and patient details on file today: this prescription was finalized before print snapshots were recorded.</p>`;
}
```

Notes for the implementer:
- Keep `<div class="sig-box">${...}</div>` on one line exactly as written: without a signature the box must be empty (the test checks it has no child elements), and the print layout reserves its height either way.
- `section()` and `medicines()` end in exhaustive `switch` statements over string unions; TypeScript accepts them without a default. Do not add a `default` that returns `null`: a new section key must fail to compile until it is drawn.
- The `.sig-line` text is `Reg. No.: <reg>`; with `userText()` the value sits in a `<span class="v">`, which `textContent` flattens, so the test sees `Reg. No.: MMC 2011/04/1234`.

- [ ] **Step 6: Run the tests; review and keep the golden files**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/rx-render.test.ts
```

Expected: all PASS. The first run writes the four files under `tests/unit/__golden__/`. Open each and check by eye: one `<style>` block, the CSP meta tag, the pad header inside `<thead>`, the footer lines inside `<tfoot>`, the three medicine rows, `data-rx="ready"` on `<body>`, the Hindi file using Devanagari headings, the draft file containing the watermark and no `Rx No.`. Run the command a second time: still PASS (the goldens now pin the output; CI runs with `CI=true`, where Vitest never writes new snapshots, so the files must be committed).

Troubleshooting without weakening a test:
- "Advice" found in the omitted-sections test: the `block()` guard must treat whitespace-only text as empty.
- The superseded banner text differs: `formatIssuedDate` must use the snapshot timezone (`2026-11-13T04:00Z` is 13/11 in Asia/Kolkata).
- `.sig-box` has a text child: see the first implementer note above.

- [ ] **Step 7: Lint, typecheck, full suite, commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/rx-render/templates.ts src/lib/rx-render/styles.ts src/lib/rx-render/render.ts tests/unit/rx-render.test.ts tests/unit/__golden__/rx-general-a4-en.html tests/unit/__golden__/rx-paediatric-a5-bilingual.html tests/unit/__golden__/rx-derma-a4-hi.html tests/unit/__golden__/rx-general-draft.html
Set-Location E:\projects\clinicpad; git commit -m "feat: add self-contained prescription renderer with General, Paediatric, and Derma pads" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: `rx-render.test.ts` has 34 tests (9 hostile-matrix cases, 4 golden files).

---

## Task 5: Freeze the pad at finalize and load printable documents

**Files:**
- Create: `src/server/services/assets.ts`, `src/server/services/render-snapshot.ts`, `src/server/services/rx-documents.ts`
- Modify: `src/server/services/prescriptions.ts` (`finalizePrescription` and the import list; one comment on `PrescriptionView.patient`)
- Test: `tests/integration/render-snapshot.test.ts`

**Interfaces:**
- Consumes: Task 1 schema (`clinicAssets`, clinic/doctor pad columns, `prescriptions.renderSnapshot`); Task 3 (`RenderSnapshot`, `parseRenderSnapshot`, `pickOption`, constants, `RxDocument`, `RxStatus`, `ImageAsset`); Task 4 `renderPrescription` (test only); `ageLabel(dob, now)` (`src/lib/domain/age.ts`), `can` (`src/lib/domain/permissions.ts`), `isUuid`/`newId` (`src/lib/domain/ids.ts`), `Result`/`ok`/`fail` (`src/lib/result.ts`), `withTenant`/`TenantTx` (`src/server/db/tenant.ts`), `ServiceContext` (`src/server/services/context.ts`), `createPatient`/`updatePatient` (`src/server/services/patients.ts`; `updatePatient` is a FULL REPLACE), `createTestTenant` (`tests/helpers/tenant.ts`); `toVisitView`, `toItemView` (`src/server/services/rx-mapping.ts`); `startPrescription`, `saveDraft(ctx, id, raw, { baseRevision? })`, `finalizePrescription(ctx, id, { expectedRevision? })`, `amendPrescription(ctx, { prescriptionId, reason })` (`src/server/services/prescriptions.ts`).
- Produces:
  - `assets.ts`: `loadImageAssets(tx: TenantTx, ids: (string | null)[]): Promise<Map<string, ImageAsset>>`; `type AssetPreview = { id: string; dataUrl: string; width: number; height: number }`; `assetPreview(id: string, asset: ImageAsset): AssetPreview`.
  - `render-snapshot.ts`: `type SnapshotSources = { patientId: string; prescriberUserId: string | null; visitDoctorId: string | null; at: Date }`; `buildRenderSnapshot(tx: TenantTx, sources: SnapshotSources): Promise<RenderSnapshot>` (signer rule: with a `prescriberUserId`, only that user's doctor profile, else none; the visit's doctor only when nobody has finalized); `addressLines(clinic)`; `footerLines(text)`; `primaryClinic(tx)`.
  - `rx-documents.ts`: `type RxDocumentBundle = { prescriptionId: string; document: RxDocument; logo: ImageAsset | null; signature: ImageAsset | null }`; `loadRxDocument(ctx, id: string, opts?: { withAssets?: boolean }): Promise<Result<RxDocumentBundle>>` (`forbidden` without `rx.read`, `not_found` for malformed / unknown / other-tenant ids, `invalid` for a damaged snapshot); `type VersionRef = { id: string; version: number }`; `getVersionLinks(ctx, id): Promise<Result<{ supersededBy: VersionRef | null; replaces: VersionRef | null }>>`.
  - `finalizePrescription` (signature, results, messages, lock order, numbering rule, and audit payload unchanged) now writes `render_snapshot` in its finalizing UPDATE.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/render-snapshot.test.ts`:

```ts
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { pgErrorInfo } from "@/server/db/errors";
import { clinicAssets, clinics, doctors, prescriptionItems, prescriptions, users, visits } from "@/server/db/schema";
import { createPatient, updatePatient } from "@/server/services/patients";
import { amendPrescription, finalizePrescription, saveDraft, startPrescription } from "@/server/services/prescriptions";
import { getVersionLinks, loadRxDocument } from "@/server/services/rx-documents";
import type { ServiceContext } from "@/server/services/context";
import { renderPrescription } from "@/lib/rx-render/render";
import { parseRenderSnapshot } from "@/lib/rx-render/snapshot";
import { newId } from "@/lib/domain/ids";
import { makePng } from "../helpers/images";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let firstLogoId = "";
let secondLogoId = "";
let secondDoctorUserId = "";
let legacyRxNo = 9500;
const doctor = () => A.as("doctor");
/** Another doctor of clinic A, with a profile of their own. */
const secondDoctor = (): ServiceContext => ({ tenantId: A.tenantId, userId: secondDoctorUserId, role: "doctor" });
const NO_FONTS = { logo: null, signature: null, fontCss: "" };

async function insertLogo(width: number): Promise<string> {
  const bytes = makePng(width, 20);
  const [row] = await adminDb
    .insert(clinicAssets)
    .values({
      tenantId: A.tenantId,
      kind: "logo",
      mime: "image/png",
      width,
      height: 20,
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    })
    .returning({ id: clinicAssets.id });
  return row.id;
}

async function patient(name: string, dob?: string): Promise<string> {
  const created = await createPatient(A.as("reception"), { name, dob }, { allowDuplicate: true });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

/** A draft with one medicine, saved the way the editor saves it. Returns the id and the saved revision. */
async function savedDraftFor(patientId: string): Promise<{ id: string; revision: number }> {
  const started = await startPrescription(doctor(), { patientId });
  if (!started.ok) throw new Error(started.message);
  const id = started.value.prescriptionId;
  const saved = await saveDraft(doctor(), id, { items: [{ drugName: "Paracetamol", doseMorning: 1, doseNight: 1 }] }, { baseRevision: 0 });
  if (!saved.ok) throw new Error(saved.message);
  return { id, revision: saved.value.revision };
}

/** Finalized exactly the way finalizeDraftAction does it: the saved revision is the expected one. */
async function finalizedFor(patientId: string, by: ServiceContext = doctor()): Promise<string> {
  const { id, revision } = await savedDraftFor(patientId);
  const done = await finalizePrescription(by, id, { expectedRevision: revision });
  if (!done.ok) throw new Error(done.message);
  return id;
}

async function load(id: string, role = "nurse") {
  const result = await loadRxDocument(A.as(role), id);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}

/** A finalized prescription written the way rows were written before this plan: no snapshot, no finalized_by. */
async function legacyFinalized(patientId: string, finalizedAt: Date, snapshot: unknown = null): Promise<string> {
  const [doc] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, doctor().userId)).limit(1);
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId: A.tenantId, patientId, doctorId: doc.id, status: "draft", diagnosis: ["Legacy"] })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId: A.tenantId, visitId: visit.id, status: "draft", renderSnapshot: snapshot })
    .returning();
  await adminDb.insert(prescriptionItems).values({ tenantId: A.tenantId, prescriptionId: rx.id, drugName: "Legacy drug" });
  legacyRxNo += 1;
  await adminDb.update(prescriptions).set({ status: "finalized", rxNo: legacyRxNo, finalizedAt }).where(eq(prescriptions.id, rx.id));
  // The draft-visit guard (0008) accepts only the plain flip once the prescription is finalized.
  await adminDb.update(visits).set({ status: "finalized", finalizedAt }).where(eq(visits.id, visit.id));
  return rx.id;
}

beforeAll(async () => {
  A = await createTestTenant("snapa");
  B = await createTestTenant("snapb");
  firstLogoId = await insertLogo(40);
  secondLogoId = await insertLogo(41);
  await adminDb.insert(clinics).values({
    tenantId: A.tenantId,
    name: "Snapshot Clinic",
    addressLine1: "1 Old Road",
    city: "Pune",
    pincode: "411001",
    phone: "020-1111 2222",
    padFooter: "Closed on Sundays\n\n  Bring old papers  ",
    logoAssetId: firstLogoId,
  });
  await adminDb
    .update(doctors)
    .set({ displayName: "Dr Snapshot", regNo: "MMC-1234", qualifications: "MBBS" })
    .where(eq(doctors.userId, doctor().userId));
  const [user] = await adminDb
    .insert(users)
    .values({ email: `snap-second-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, name: "Dr Second", passwordHash: "not-a-real-hash" })
    .returning();
  secondDoctorUserId = user.id;
  await adminDb.insert(doctors).values({ tenantId: A.tenantId, userId: user.id, displayName: "Dr Second", regNo: "MMC-2222" });
});

afterAll(async () => {
  try {
    await A.cleanup();
    await B.cleanup();
  } finally {
    if (secondDoctorUserId) await adminDb.delete(users).where(eq(users.id, secondDoctorUserId));
  }
});

describe("finalize freezes the printed details", () => {
  let id = "";
  let patientId = "";

  it("writes a snapshot of the patient, clinic, doctor, and layout", async () => {
    patientId = await patient("Snapshot Patient", "2020-03-15");
    id = await finalizedFor(patientId);
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    const snap = parseRenderSnapshot(row.renderSnapshot);
    expect(snap).toMatchObject({
      v: 1,
      patient: { name: "Snapshot Patient", dob: "2020-03-15", gender: "unknown", allergies: [] },
      clinic: {
        name: "Snapshot Clinic",
        addressLines: ["1 Old Road", "Pune - 411001"],
        phone: "020-1111 2222",
        footerLines: ["Closed on Sundays", "Bring old papers"],
        logoAssetId: firstLogoId,
        timezone: "Asia/Kolkata",
      },
      doctor: { name: "Dr Snapshot", registrationNo: "MMC-1234", qualifications: "MBBS" },
      layout: { template: { kind: "builtin", key: "general" }, paperSize: "A4", labels: "en" },
    });
    expect(snap?.patient.ageLabel).toMatch(/^\d+ y$/);
    expect(snap?.takenAt).toBe(row.finalizedAt?.toISOString());
  });

  it("cannot be changed afterwards, even on the admin connection", async () => {
    const error = await adminDb
      .update(prescriptions)
      .set({ renderSnapshot: { v: 1 } })
      .where(eq(prescriptions.id, id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgErrorInfo(error).code).toBe("23000");
  });

  it("reprints exactly what was finalized after the patient, clinic, doctor, logo, and template change", async () => {
    // updatePatient is a full replace: this clears the date of birth too, which the reprint must not show either.
    expect((await updatePatient(A.as("reception"), patientId, { name: "Renamed Patient" })).ok).toBe(true);
    await adminDb
      .update(clinics)
      .set({ name: "Moved Clinic", addressLine1: "99 New Road", rxTemplate: "derma", rxPaperSize: "A5", logoAssetId: secondLogoId })
      .where(eq(clinics.tenantId, A.tenantId));
    await adminDb.update(doctors).set({ regNo: "MMC-9999" }).where(eq(doctors.userId, doctor().userId));

    const bundle = await load(id);
    expect(bundle.document.snapshotSource).toBe("finalize");
    expect(bundle.document.snapshot.patient).toMatchObject({ name: "Snapshot Patient", dob: "2020-03-15" });
    expect(bundle.document.snapshot.clinic.name).toBe("Snapshot Clinic");
    expect(bundle.document.snapshot.doctor.registrationNo).toBe("MMC-1234");
    expect(bundle.document.snapshot.layout).toMatchObject({ template: { key: "general" }, paperSize: "A4" });

    const [first] = await adminDb.select().from(clinicAssets).where(eq(clinicAssets.id, firstLogoId));
    expect(bundle.logo?.base64).toBe(first.bytes.toString("base64"));

    const printed = renderPrescription(bundle.document, NO_FONTS).html;
    expect(printed).toContain("Snapshot Patient");
    expect(printed).not.toContain("Renamed Patient");
    expect(printed).not.toContain("Moved Clinic");
  });

  it("gives an amendment its own snapshot and marks the original superseded", async () => {
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Dose correction" });
    if (!amended.ok) throw new Error(amended.message);
    const v2 = amended.value.prescriptionId;
    // amendPrescription inserts the new version with an explicit column list: no snapshot is copied.
    const [draftRow] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, v2));
    expect(draftRow.renderSnapshot).toBeNull();
    expect((await finalizePrescription(doctor(), v2)).ok).toBe(true);

    const second = await load(v2);
    expect(second.document.snapshot.patient.name).toBe("Renamed Patient");
    expect(second.document.snapshot.clinic.name).toBe("Moved Clinic");
    expect(second.document.snapshot.doctor.registrationNo).toBe("MMC-9999");
    expect(second.document.snapshot.layout).toMatchObject({ template: { key: "derma" }, paperSize: "A5" });
    expect(second.document).toMatchObject({ version: 2, replacesVersion: 1, supersededBy: null });

    const first = await load(id);
    expect(first.document.status).toBe("amended");
    expect(first.document.supersededBy).toMatchObject({ version: 2 });
    expect(first.document.snapshot.patient.name).toBe("Snapshot Patient");

    expect(await getVersionLinks(A.as("reception"), id)).toMatchObject({
      ok: true,
      value: { supersededBy: { id: v2, version: 2 }, replaces: null },
    });
    expect(await getVersionLinks(A.as("reception"), v2)).toMatchObject({
      ok: true,
      value: { supersededBy: null, replaces: { id, version: 1 } },
    });
  });
});

describe("who signs the pad", () => {
  it("is the doctor who finalizes, also for an amendment of another doctor's prescription", async () => {
    const id = await finalizedFor(await patient("Signer Person"));
    expect((await load(id)).document.snapshot.doctor.name).toBe("Dr Snapshot");

    // The amendment's visit keeps the first doctor's doctor_id (ADR-0024); the second doctor finalizes it.
    const amended = await amendPrescription(secondDoctor(), { prescriptionId: id, reason: "Second opinion" });
    if (!amended.ok) throw new Error(amended.message);
    expect((await finalizePrescription(secondDoctor(), amended.value.prescriptionId)).ok).toBe(true);
    expect((await load(amended.value.prescriptionId)).document.snapshot.doctor).toMatchObject({
      name: "Dr Second",
      registrationNo: "MMC-2222",
    });
  });

  it("prints no doctor, never the visit's doctor, when the finalizer has no doctor profile", async () => {
    const { id } = await savedDraftFor(await patient("No Profile Person"));
    const ownerWithoutProfile: ServiceContext = { tenantId: A.tenantId, userId: newId(), role: "owner" };
    expect((await finalizePrescription(ownerWithoutProfile, id)).ok).toBe(true);
    const bundle = await load(id);
    expect(bundle.document.snapshot.doctor).toEqual({
      name: "",
      qualifications: null,
      designation: null,
      registrationNo: null,
      registrationCouncil: null,
      signatureAssetId: null,
    });
    expect(bundle.signature).toBeNull();
  });
});

describe("documents without a snapshot", () => {
  it("renders a draft with today's details, the visit's doctor, and no Rx number", async () => {
    const patientId = await patient("Draft Person");
    const started = await startPrescription(doctor(), { patientId });
    if (!started.ok) throw new Error(started.message);
    const bundle = await load(started.value.prescriptionId);
    expect(bundle.document).toMatchObject({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" });
    expect(bundle.document.snapshot.patient.name).toBe("Draft Person");
    expect(bundle.document.snapshot.doctor.name).toBe("Dr Snapshot");
  });

  it("renders a pre-1C finalized prescription from live data, aged on its own date, and says so", async () => {
    const patientId = await patient("Legacy Person", "2020-03-15");
    const id = await legacyFinalized(patientId, new Date("2026-11-12T10:00:00.000Z"));
    const bundle = await load(id);
    expect(bundle.document).toMatchObject({ status: "finalized", snapshotSource: "live", issuedAt: "2026-11-12T10:00:00.000Z" });
    expect(bundle.document.snapshot.patient.ageLabel).toBe("6 y");
    expect(bundle.document.snapshot.doctor.name).toBe("Dr Snapshot");
    expect(renderPrescription(bundle.document, NO_FONTS).html).toContain("finalized before print snapshots were recorded");
  });

  it("refuses to print a damaged snapshot instead of guessing", async () => {
    const patientId = await patient("Damaged Person");
    const id = await legacyFinalized(patientId, new Date(), { v: 99 });
    expect(await loadRxDocument(A.as("doctor"), id)).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("access", () => {
  it("lets every role with rx.read load a document and hides it from everyone else", async () => {
    const id = await finalizedFor(await patient("Access Person"));
    for (const role of ["owner", "doctor", "reception", "nurse", "pharmacist"]) {
      expect((await loadRxDocument(A.as(role), id)).ok).toBe(true);
    }
    expect(await loadRxDocument(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await loadRxDocument(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await loadRxDocument(A.as("doctor"), newId())).toMatchObject({ ok: false, code: "not_found" });
    expect(await loadRxDocument(A.as("doctor"), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
    expect(await getVersionLinks(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getVersionLinks(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("can skip loading image bytes", async () => {
    const id = await finalizedFor(await patient("No Assets Person"));
    const result = await loadRxDocument(A.as("doctor"), id, { withAssets: false });
    expect(result).toMatchObject({ ok: true, value: { logo: null, signature: null } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/render-snapshot.test.ts
```

Expected: FAIL — `@/server/services/rx-documents` cannot be resolved.

- [ ] **Step 3: Implement asset loading**

`src/server/services/assets.ts`:

```ts
import { inArray } from "drizzle-orm";
import { clinicAssets } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { ImageAsset } from "@/lib/rx-render/types";

export type AssetPreview = { id: string; dataUrl: string; width: number; height: number };

function asMime(value: string): ImageAsset["mime"] | null {
  return value === "image/png" || value === "image/jpeg" ? value : null;
}

/** Loads images by id through RLS (another clinic's ids simply are not found). */
export async function loadImageAssets(tx: TenantTx, ids: (string | null)[]): Promise<Map<string, ImageAsset>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const found = new Map<string, ImageAsset>();
  if (wanted.length === 0) return found;
  const rows = await tx
    .select({ id: clinicAssets.id, mime: clinicAssets.mime, width: clinicAssets.width, height: clinicAssets.height, bytes: clinicAssets.bytes })
    .from(clinicAssets)
    .where(inArray(clinicAssets.id, wanted));
  for (const row of rows) {
    const mime = asMime(row.mime);
    if (mime) found.set(row.id, { mime, width: row.width, height: row.height, base64: row.bytes.toString("base64") });
  }
  return found;
}

export function assetPreview(id: string, asset: ImageAsset): AssetPreview {
  return { id, dataUrl: `data:${asset.mime};base64,${asset.base64}`, width: asset.width, height: asset.height };
}
```

- [ ] **Step 4: Implement the snapshot builder**

`src/server/services/render-snapshot.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import { ageLabel } from "@/lib/domain/age";
import { clinics, doctors, patients } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { RenderSnapshot } from "@/lib/rx-render/snapshot";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES, pickOption } from "@/lib/rx-render/types";

export type SnapshotSources = {
  patientId: string;
  /** The user who finalizes (or finalized) the prescription. When set, only their own doctor profile signs it. */
  prescriberUserId: string | null;
  /** The doctor the visit was opened for. Used only when nobody has finalized yet (a draft preview). */
  visitDoctorId: string | null;
  /** The prescription's date: finalize time, or now for a draft. Age is computed for this day. */
  at: Date;
};

type ClinicRow = typeof clinics.$inferSelect;

function nonEmpty(values: (string | null | undefined)[]): string[] {
  return values.map((v) => (v ?? "").trim()).filter((v) => v !== "");
}

export function addressLines(clinic: Pick<ClinicRow, "addressLine1" | "addressLine2" | "city" | "state" | "pincode">): string[] {
  const place = nonEmpty([clinic.city, clinic.state]).join(", ");
  const pin = (clinic.pincode ?? "").trim();
  const last = pin ? (place ? `${place} - ${pin}` : pin) : place;
  return nonEmpty([clinic.addressLine1, clinic.addressLine2, last]);
}

/** Up to four non-empty, trimmed footer lines. */
export function footerLines(text: string | null): string[] {
  return nonEmpty((text ?? "").split("\n")).slice(0, 4);
}

/** The tenant's clinic profile (one per tenant today; the oldest if there are several). RLS scopes the read. */
export async function primaryClinic(tx: TenantTx): Promise<ClinicRow | null> {
  const [row] = await tx.select().from(clinics).orderBy(asc(clinics.createdAt), asc(clinics.id)).limit(1);
  return row ?? null;
}

/**
 * Who signs the pad (ADR-0032). Whoever finalized signs it, and nobody else: never fall back to the
 * visit's doctor, whose name and signature would then appear on a prescription they did not sign
 * (an amendment keeps the original visit's doctor_id). Only a draft (no finalizer yet) previews with
 * the visit's doctor.
 */
async function prescribingDoctor(tx: TenantTx, sources: SnapshotSources) {
  if (sources.prescriberUserId) {
    const [byUser] = await tx.select().from(doctors).where(eq(doctors.userId, sources.prescriberUserId)).limit(1);
    return byUser ?? null;
  }
  if (sources.visitDoctorId) {
    const [byId] = await tx.select().from(doctors).where(eq(doctors.id, sources.visitDoctorId)).limit(1);
    return byId ?? null;
  }
  return null;
}

/**
 * Everything the printed pad shows that is not clinical content. Finalize stores it in
 * prescriptions.render_snapshot so a reprint never picks up later edits (ADR-0032).
 * Call it only inside withTenant(): RLS scopes every read here (the clinic lookup takes the
 * tenant's first clinic), so on the admin connection it would read other tenants' rows.
 * The age uses ageLabel's UTC calendar day (clinic-timezone ages are a Plan 1D follow-up).
 */
export async function buildRenderSnapshot(tx: TenantTx, sources: SnapshotSources): Promise<RenderSnapshot> {
  const [patient] = await tx
    .select({
      name: patients.name,
      patientNo: patients.patientNo,
      gender: patients.gender,
      dob: patients.dob,
      allergies: patients.allergies,
    })
    .from(patients)
    .where(eq(patients.id, sources.patientId))
    .limit(1);
  const clinic = await primaryClinic(tx);
  const doctor = await prescribingDoctor(tx, sources);

  return {
    v: 1,
    takenAt: sources.at.toISOString(),
    patient: {
      name: patient?.name ?? "",
      patientNo: patient?.patientNo ?? null,
      gender: patient?.gender ?? null,
      dob: patient?.dob ?? null,
      ageLabel: patient?.dob ? ageLabel(patient.dob, sources.at) : "",
      allergies: patient?.allergies ?? [],
    },
    clinic: {
      name: clinic?.name ?? "",
      addressLines: clinic ? addressLines(clinic) : [],
      phone: clinic?.phone ?? null,
      email: clinic?.email ?? null,
      footerLines: footerLines(clinic?.padFooter ?? null),
      logoAssetId: clinic?.logoAssetId ?? null,
      timezone: clinic?.timezone ?? "Asia/Kolkata",
    },
    doctor: {
      name: doctor?.displayName ?? "",
      qualifications: doctor?.qualifications ?? null,
      designation: doctor?.designation ?? null,
      registrationNo: doctor?.regNo ?? null,
      registrationCouncil: doctor?.registrationCouncil ?? null,
      signatureAssetId: doctor?.signatureAssetId ?? null,
    },
    layout: {
      template: { kind: "builtin", key: pickOption(BUILTIN_TEMPLATES, clinic?.rxTemplate, "general") },
      paperSize: pickOption(PAPER_SIZES, clinic?.rxPaperSize, "A4"),
      labels: pickOption(LABEL_LANGUAGES, clinic?.rxLabels, "en"),
    },
  };
}
```

- [ ] **Step 5: Implement document loading**

`src/server/services/rx-documents.ts`:

```ts
import { and, asc, eq, ne } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { parseRenderSnapshot, type RenderSnapshot } from "@/lib/rx-render/snapshot";
import type { ImageAsset, RxDocument, RxStatus } from "@/lib/rx-render/types";
import type { ServiceContext } from "./context";
import { loadImageAssets } from "./assets";
import { buildRenderSnapshot } from "./render-snapshot";
import { toItemView, toVisitView } from "./rx-mapping";

export type RxDocumentBundle = {
  prescriptionId: string;
  document: RxDocument;
  logo: ImageAsset | null;
  signature: ImageAsset | null;
};

export type VersionRef = { id: string; version: number };

const STATUSES: readonly RxStatus[] = ["draft", "finalized", "amended"];
const notFound = () => fail("not_found", "Prescription not found.");

/** The finalized version that replaced this one (the child that is no longer a draft). */
async function supersedingVersion(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({ id: prescriptions.id, version: prescriptions.version, finalizedAt: prescriptions.finalizedAt })
    .from(prescriptions)
    .where(and(eq(prescriptions.parentPrescriptionId, id), ne(prescriptions.status, "draft")))
    .orderBy(asc(prescriptions.version))
    .limit(1);
  return row ?? null;
}

/**
 * Everything needed to print one prescription. Finalized rows print from their frozen
 * snapshot; drafts and rows finalized before Plan 1C are built from live data and marked
 * "live". A snapshot that does not parse fails closed with `invalid`. A finalized row is
 * frozen, so its reads are consistent; a draft preview is not a record and may, for a moment,
 * mix a save that lands between the two reads (getPrescription's revision re-check is not
 * repeated here).
 */
export async function loadRxDocument(
  ctx: ServiceContext,
  id: string,
  opts: { withAssets?: boolean } = {},
): Promise<Result<RxDocumentBundle>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return notFound();

  return withTenant(ctx.tenantId, async (tx): Promise<Result<RxDocumentBundle>> => {
    const [row] = await tx
      .select({ rx: prescriptions, visit: visits })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!row) return notFound();
    const status = STATUSES.find((s) => s === row.rx.status);
    if (!status) return fail("invalid", "This prescription has an unknown status.");

    let snapshot: RenderSnapshot;
    let snapshotSource: RxDocument["snapshotSource"];
    if (row.rx.renderSnapshot !== null && row.rx.renderSnapshot !== undefined) {
      const parsed = parseRenderSnapshot(row.rx.renderSnapshot);
      if (!parsed) return fail("invalid", "This prescription's print data is damaged and cannot be printed. Contact support.");
      snapshot = parsed;
      snapshotSource = "finalize";
    } else {
      snapshot = await buildRenderSnapshot(tx, {
        patientId: row.visit.patientId,
        // A pre-1C finalized row is signed by its finalizer; only a draft falls back to the visit's doctor.
        prescriberUserId: row.rx.finalizedBy,
        visitDoctorId: row.visit.doctorId,
        at: row.rx.finalizedAt ?? new Date(),
      });
      snapshotSource = "live";
    }

    const items = await tx
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, id))
      .orderBy(asc(prescriptionItems.sortOrder));
    const superseding = status === "amended" ? await supersedingVersion(tx, id) : null;

    const document: RxDocument = {
      status,
      rxNo: row.rx.rxNo,
      version: row.rx.version,
      issuedAt: row.rx.finalizedAt ? row.rx.finalizedAt.toISOString() : null,
      supersededBy: superseding
        ? { version: superseding.version, issuedAt: superseding.finalizedAt ? superseding.finalizedAt.toISOString() : null }
        : null,
      replacesVersion: row.rx.parentPrescriptionId ? row.rx.version - 1 : null,
      snapshot,
      snapshotSource,
      visit: toVisitView(row.visit),
      items: items.map(toItemView),
    };

    if (opts.withAssets === false) return ok({ prescriptionId: id, document, logo: null, signature: null });
    const { logoAssetId } = snapshot.clinic;
    const { signatureAssetId } = snapshot.doctor;
    const assets = await loadImageAssets(tx, [logoAssetId, signatureAssetId]);
    return ok({
      prescriptionId: id,
      document,
      logo: logoAssetId ? (assets.get(logoAssetId) ?? null) : null,
      signature: signatureAssetId ? (assets.get(signatureAssetId) ?? null) : null,
    });
  });
}

/** Links between versions for the prescription page: the version that replaced this one, and the one it replaces. */
export async function getVersionLinks(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ supersededBy: VersionRef | null; replaces: VersionRef | null }>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return notFound();
  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: prescriptions.id, status: prescriptions.status, parentId: prescriptions.parentPrescriptionId })
      .from(prescriptions)
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!row) return notFound();
    const superseding = row.status === "amended" ? await supersedingVersion(tx, id) : null;
    let replaces: VersionRef | null = null;
    if (row.parentId) {
      const [parent] = await tx
        .select({ id: prescriptions.id, version: prescriptions.version })
        .from(prescriptions)
        .where(eq(prescriptions.id, row.parentId))
        .limit(1);
      replaces = parent ?? null;
    }
    return ok({ supersededBy: superseding ? { id: superseding.id, version: superseding.version } : null, replaces });
  });
}
```

`toVisitView(row.visit)` returns `ClinicalVisitView`, a superset of `RxVisit` (it also carries `id`); TypeScript accepts it because it is not an object literal. `toItemView` returns `ItemView`, which has exactly `RxItem`'s eighteen fields (and maps pre-1B items to `durationUnit: "days"`).

- [ ] **Step 6: Make finalize write the snapshot**

In `src/server/services/prescriptions.ts`:

1. Add `import { buildRenderSnapshot } from "./render-snapshot";` after `import { recordAudit } from "./audit";`.
2. Change the comment on `PrescriptionView.patient` to:

```ts
  /** Read live from the patient row (allergies are [] when none). The page shows the name frozen in the finalize snapshot for finalized versions (Plan 1C). */
```

3. Replace the whole `finalizePrescription` function (from `export async function finalizePrescription(` to the closing `}` before `export async function amendPrescription(`) with the version below. It is the current function with three changes, marked `Plan 1C`: `const now` moves up to just after the visit read, the snapshot is built from the finalizing user before the number is allocated (so the counter row lock, which every concurrent finalize in the clinic queues on, is held no longer than before), and `renderSnapshot` joins the finalizing UPDATE. Lock order, checks, messages, the first-version vs amendment rule (by `parentPrescriptionId`), the parent flip, the audit payload, and the `23000` mapping are unchanged.

```ts
export async function finalizePrescription(
  ctx: ServiceContext,
  id: string,
  opts: { expectedRevision?: number } = {},
): Promise<Result<{ rxNo: number; version: number }>> {
  if (!can(ctx.role, "rx.finalize")) return fail("forbidden", "Only doctors can finalize prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ rxNo: number; version: number }>> => {
      // The row lock comes first: it serializes double-clicks and racing autosaves (the second request waits,
      // then sees "finalized"), and it must precede any visit or item write. Two lock orders exist (ADR-0023,
      // AGENTS.md section 10): writers lock prescription -> items/visit, and finalizing an amendment locks the
      // child and then the parent. The second is safe because amendPrescription never writes while a child is open.
      const [rx] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1).for("update");
      if (!rx) return prescriptionNotFound();
      if (rx.status !== "draft") return fail("conflict", "This prescription is already finalized.");
      // Finalize exactly the revision the doctor saw: a save from another window in between wins.
      if (opts.expectedRevision !== undefined && rx.draftRevision !== opts.expectedRevision) {
        return fail("conflict", "This draft changed after you last saw it. Review it, then finalize again.");
      }

      const [{ value: itemCount }] = await tx
        .select({ value: count() })
        .from(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, id));
      if (itemCount === 0) return fail("invalid", "Add at least one medicine before finalizing.", "items");
      const [visit] = await tx.select().from(visits).where(eq(visits.id, rx.visitId)).limit(1);
      const now = new Date();

      // Plan 1C (ADR-0032): freeze what the printed pad shows. Plain reads, no new locks. The finalizing user
      // signs: their own doctor profile or none, never the visit's doctor. The draft -> finalized UPDATE below
      // may set any column; the immutability trigger then freezes the snapshot with the rest of the row.
      const renderSnapshot = await buildRenderSnapshot(tx, {
        patientId: visit.patientId,
        prescriberUserId: ctx.userId,
        visitDoctorId: visit.doctorId,
        at: now,
      });

      // First versions (no parent) get the next number; amendments must already carry their parent's.
      // An amendment without a number means a corrupt chain: refuse rather than allocate a second number
      // for the same prescription. Allocating only after every check passes, inside this transaction,
      // means a failed finalize never burns a number.
      let rxNo: number;
      if (rx.parentPrescriptionId === null) {
        rxNo = await allocateNumber(tx, ctx.tenantId, "rx");
      } else if (rx.rxNo === null) {
        return fail("conflict", "The original prescription has no Rx number, so this amendment cannot be finalized.");
      } else {
        rxNo = rx.rxNo;
      }

      await tx
        .update(prescriptions)
        .set({ status: "finalized", rxNo, finalizedAt: now, finalizedBy: ctx.userId, renderSnapshot })
        .where(eq(prescriptions.id, id));
      // Only status and finalized_at may change on a visit whose prescription is already finalized.
      await tx.update(visits).set({ status: "finalized", finalizedAt: now }).where(eq(visits.id, rx.visitId));
      if (rx.parentPrescriptionId) {
        // The parent flip may change nothing but status. This locks the parent after the child (ADR-0023's
        // second lock order), which is safe because amendPrescription never writes while a child is open.
        await tx
          .update(prescriptions)
          .set({ status: "amended" })
          .where(eq(prescriptions.id, rx.parentPrescriptionId));
      }
      const summary = clinicalSummary(visit, itemCount);
      await recordAudit(tx, ctx, {
        action: rx.parentPrescriptionId ? "prescription.amended" : "prescription.finalized",
        entityType: "prescription",
        entityId: id,
        after: rx.parentPrescriptionId
          ? { rxNo, version: rx.version, parentPrescriptionId: rx.parentPrescriptionId, ...summary }
          : { rxNo, version: rx.version, ...summary },
      });
      return ok({ rxNo, version: rx.version });
    });
  } catch (error) {
    if (pgErrorInfo(error).code === "23000") return fail("immutable", IMMUTABLE_MESSAGE);
    throw error;
  }
}
```

Why no `invalidFromDatabase` (22021 / 22P02 / 22P05) mapping here, unlike `saveDraft` and `amendPrescription`: the snapshot is built only from values already stored in Postgres text, date, and array columns, which can hold neither a NUL nor a lone surrogate, so no such value can reach the jsonb write; the audit payload and the snapshot contain no new user input. The snapshot is not audited (the audit payload stays ids, counts, and field names). The callers do not change: `finalizeDraftAction` still calls `finalizePrescription(session, id, { expectedRevision: saved.revision })`.

- [ ] **Step 7: Run the new and the Plan 1A/1B lifecycle tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/render-snapshot.test.ts tests/integration/prescriptions-lifecycle.test.ts tests/integration/prescriptions-clinical-lifecycle.test.ts tests/integration/prescriptions-discard.test.ts tests/integration/immutability.test.ts tests/integration/immutability-races.test.ts tests/integration/editor-endpoints.test.ts tests/integration/numbering-audit.test.ts
Set-Location E:\projects\clinicpad; npm run typecheck
```

Expected: all PASS (`render-snapshot.test.ts`: 11 tests); typecheck exits 0. The Plan 1A/1B lifecycle, discard (including the two tests that hold the row lock), race, and endpoint tests are unchanged and still pass: finalize took no new lock, and its results and audit payload are the same. If the amendment test sees the old patient name in v2, a snapshot was copied: `amendPrescription` must keep inserting the new version with its explicit column list, and v2's own finalize writes v2's snapshot. If the second test of "who signs the pad" sees "Dr Snapshot", `prescribingDoctor` fell back to the visit's doctor: with a `prescriberUserId` it must return that user's profile or `null`. If `ageLabel` is not `"6 y"` for the legacy row, `at` must be the row's `finalizedAt`, not `new Date()`.

- [ ] **Step 8: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/services/assets.ts src/server/services/render-snapshot.ts src/server/services/rx-documents.ts src/server/services/prescriptions.ts tests/integration/render-snapshot.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: freeze the printed pad at finalize and load printable documents" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 6: Pad settings — clinic header, doctor profile, and image uploads (services and actions)

**Files:**
- Create: `src/server/validation/pad-settings.ts`, `src/server/services/pad-settings.ts`, `src/server/actions/settings.ts`
- Modify: `src/lib/domain/permissions.ts`, `src/server/services/assets.ts` (append), `tests/unit/permissions.test.ts` (two `granted` rows + a new `describe`)
- Test: `tests/integration/pad-settings.test.ts`, `tests/integration/settings-actions.test.ts`

**Interfaces:**
- Consumes: Task 1 schema; Task 2 `inspectImage`, `IMAGE_LIMITS`; Task 3 constants and `pickOption`; Task 5 `loadImageAssets`, `assetPreview`, `AssetPreview`, `primaryClinic`; `can` (`src/lib/domain/permissions.ts`), `recordAudit` (`src/server/services/audit.ts`), `Result`/`ok`/`fail`/`invalidFrom` (`src/lib/result.ts`; `invalidFrom` keeps the first path segment as `field`), `withTenant`, `pgErrorInfo`, `requireSession` (`src/server/auth/session.ts`), `createTestTenant`; the validation text helpers `cleanInput`, `cleanOptionalText`, `blankToUndefined`, `hasNoNul`, `NUL_MESSAGE` (`src/server/validation/text.ts`).
- Produces:
  - Permission actions `"settings.clinic"` (owner) and `"settings.profile"` (owner, doctor).
  - `clinicPadSchema`, `type ClinicPadInput`; `doctorProfileSchema`, `type DoctorProfileInput`.
  - `assets.ts` (appended): `type StoredAsset = { id: string; mime: ImageMime; width: number; height: number; byteSize: number }`; `storeImageAsset(tx, ctx, kind: "logo" | "signature", bytes: Uint8Array): Promise<Result<StoredAsset>>` (`invalid` with `field: "image"` for a rejected image).
  - `pad-settings.ts`: `type ClinicPadView = { name; addressLine1; addressLine2; city; state; pincode; phone; email; padFooter: string; rxTemplate: BuiltinTemplateKey; rxPaperSize: PaperSize; rxLabels: LabelLanguage; logo: AssetPreview | null }` (strings are `""` when empty); `type DoctorProfileView = { displayName; qualifications; designation; registrationNo; registrationCouncil: string; signature: AssetPreview | null }`; `type ProfileGap = "noDoctorProfile" | "doctorName" | "registrationNo"`; `getClinicPad(ctx)`, `updateClinicPad(ctx, raw)` → `Result<{ changedFields: string[] }>`, `getDoctorProfile(ctx)`, `updateDoctorProfile(ctx, raw)` → `Result<{ changedFields: string[] }>`, `setClinicLogo(ctx, image: { bytes: Uint8Array } | null)` and `setDoctorSignature(ctx, image | null)` → `Result<{ assetId: string | null }>`, `getPadReadiness(ctx)` → `Result<{ missing: ProfileGap[] }>` (`["noDoctorProfile"]` for a prescriber without a doctor row, else the missing name and/or registration number; `[]` for roles without `rx.draft`).
  - Actions (`"use server"`): `type SettingsFormState = { error?: string; field?: string; saved?: boolean; values?: Record<string, string> }`; `saveClinicPadAction(prev, formData)`, `saveDoctorProfileAction(prev, formData)`, `uploadLogoAction(prev, formData)`, `uploadSignatureAction(prev, formData)` (file field name `image`), `removeLogoAction(prev)`, `removeSignatureAction(prev)`, all returning `Promise<SettingsFormState>`.
  - Audit actions: `clinic.pad_updated` / `doctor.profile_updated` `{ changedFields }`; `clinic.logo_set` / `doctor.signature_set` `{ assetId, byteSize, width, height }`; `clinic.logo_removed` / `doctor.signature_removed`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/permissions.test.ts`, the `role x action matrix` block types `granted` as `Record<Action, readonly string[]>`, so typecheck fails until it has a row for every action. Add these two rows after `"catalogue.write": ["owner", "doctor"],`:

```ts
    "settings.clinic": ["owner"],
    "settings.profile": ["owner", "doctor"],
```

and append this block at the end of the file:

```ts
describe("pad settings permissions", () => {
  it("lets only owners edit the clinic pad", () => {
    expect(can("owner", "settings.clinic")).toBe(true);
    for (const role of ["doctor", "reception", "nurse", "pharmacist", "accountant", "mystery"]) {
      expect(can(role, "settings.clinic")).toBe(false);
    }
  });

  it("lets owners and doctors edit their own doctor profile", () => {
    expect(can("owner", "settings.profile")).toBe(true);
    expect(can("doctor", "settings.profile")).toBe(true);
    for (const role of ["reception", "nurse", "pharmacist", "accountant"]) {
      expect(can(role, "settings.profile")).toBe(false);
    }
  });
});
```

`tests/integration/pad-settings.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { auditEvents, clinicAssets, clinics } from "@/server/db/schema";
import {
  getClinicPad,
  getDoctorProfile,
  getPadReadiness,
  setClinicLogo,
  setDoctorSignature,
  updateClinicPad,
  updateDoctorProfile,
} from "@/server/services/pad-settings";
import { NUL_MESSAGE } from "@/server/validation/text";
import { newId } from "@/lib/domain/ids";
import { JPEG_SOS, makeJpegHeader, makePng } from "../helpers/images";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

const pad = (overrides: Record<string, unknown> = {}) => ({
  name: "Sunrise Family Clinic",
  addressLine1: "12 MG Road",
  addressLine2: "",
  city: "Pune",
  state: "Maharashtra",
  pincode: "411001",
  phone: "020-2612 3456, 98200 12345",
  email: "",
  padFooter: "Mon-Sat 9 am to 1 pm\nBring old prescriptions",
  rxTemplate: "paediatric",
  rxPaperSize: "A5",
  rxLabels: "bilingual",
  ...overrides,
});

const auditFor = (tenantId: string, action: string) =>
  withTenant(tenantId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));
const assetCount = async (tenantId: string) => (await adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, tenantId))).length;

beforeAll(async () => {
  A = await createTestTenant("pada");
  B = await createTestTenant("padb");
  await adminDb.insert(clinics).values([
    { tenantId: A.tenantId, name: "Clinic A" },
    { tenantId: B.tenantId, name: "Clinic B" },
  ]);
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("clinic pad", () => {
  it("starts from the defaults", async () => {
    expect(await getClinicPad(A.as("owner"))).toMatchObject({
      ok: true,
      value: { name: "Clinic A", addressLine1: "", rxTemplate: "general", rxPaperSize: "A4", rxLabels: "en", logo: null },
    });
  });

  it("saves the pad, reports changed field names, and audits names only", async () => {
    const result = await updateClinicPad(A.as("owner"), pad());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.value.changedFields).toEqual(
      expect.arrayContaining(["name", "addressLine1", "city", "state", "pincode", "phone", "padFooter", "rxTemplate", "rxPaperSize", "rxLabels"]),
    );
    expect(await getClinicPad(A.as("owner"))).toMatchObject({
      ok: true,
      value: { name: "Sunrise Family Clinic", padFooter: "Mon-Sat 9 am to 1 pm\nBring old prescriptions", rxTemplate: "paediatric" },
    });
    const events = await auditFor(A.tenantId, "clinic.pad_updated");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("12 MG Road");
  });

  it("is a no-op with no audit event when nothing changed", async () => {
    expect(await updateClinicPad(A.as("owner"), pad())).toMatchObject({ ok: true, value: { changedFields: [] } });
    expect(await auditFor(A.tenantId, "clinic.pad_updated")).toHaveLength(1);
  });

  it("stores markup verbatim, strips invisible characters, and refuses a NUL instead of dropping it", async () => {
    const name = "<script>alert(1)</script>\u202E";
    expect(name.codePointAt(name.length - 1)).toBe(0x202e);
    expect((await updateClinicPad(A.as("owner"), pad({ name }))).ok).toBe(true);
    expect(await getClinicPad(A.as("owner"))).toMatchObject({ ok: true, value: { name: "<script>alert(1)</script>" } });

    const withNul = "Clinic\u0000Name";
    expect(Array.from(withNul)).toHaveLength(11);
    expect(withNul.codePointAt(6)).toBe(0);
    expect(await updateClinicPad(A.as("owner"), pad({ name: withNul }))).toMatchObject({
      ok: false,
      code: "invalid",
      field: "name",
      message: NUL_MESSAGE,
    });
    expect(await updateClinicPad(A.as("owner"), pad({ padFooter: "Line one\u0000" }))).toMatchObject({ ok: false, field: "padFooter" });
  });

  it.each([
    [{ name: "X" }, "name"],
    [{ email: "not-an-email" }, "email"],
    [{ pincode: "4110@1" }, "pincode"],
    [{ padFooter: "1\n2\n3\n4\n5" }, "padFooter"],
    [{ padFooter: "x".repeat(601) }, "padFooter"],
    [{ rxTemplate: "fancy" }, "rxTemplate"],
    [{ rxPaperSize: "Letter" }, "rxPaperSize"],
    [{ rxLabels: "fr" }, "rxLabels"],
    [{ addressLine1: "a".repeat(201) }, "addressLine1"],
  ])("rejects %j", async (overrides, field) => {
    expect(await updateClinicPad(A.as("owner"), pad(overrides))).toMatchObject({ ok: false, code: "invalid", field });
  });

  it.each(["doctor", "reception", "nurse", "pharmacist", "accountant"])("forbids %s", async (role) => {
    expect(await updateClinicPad(A.as(role), pad())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getClinicPad(A.as(role))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setClinicLogo(A.as(role), { bytes: new Uint8Array(makePng(64, 32)) })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("changes only the caller's own clinic", async () => {
    await updateClinicPad(B.as("owner"), pad({ name: "Clinic B Renamed" }));
    expect(await getClinicPad(A.as("owner"))).toMatchObject({ ok: true, value: { name: "<script>alert(1)</script>" } });
  });
});

describe("clinic logo", () => {
  it("stores a PNG, shows it as a data URL, and de-duplicates a repeat upload", async () => {
    const bytes = new Uint8Array(makePng(120, 60));
    const first = await setClinicLogo(A.as("owner"), { bytes });
    if (!first.ok) throw new Error(first.message);
    const again = await setClinicLogo(A.as("owner"), { bytes });
    expect(again).toMatchObject({ ok: true, value: { assetId: first.value.assetId } });

    const view = await getClinicPad(A.as("owner"));
    expect(view.ok && view.value.logo?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(view.ok && view.value.logo).toMatchObject({ width: 120, height: 60 });

    const events = await auditFor(A.tenantId, "clinic.logo_set");
    expect(events[0].after).toMatchObject({ assetId: first.value.assetId, width: 120, height: 60 });
  });

  it("accepts a JPEG", async () => {
    expect((await setClinicLogo(A.as("owner"), { bytes: new Uint8Array(makeJpegHeader(300, 100)) })).ok).toBe(true);
  });

  it("removes the logo from the pad but keeps the asset for old prescriptions", async () => {
    const before = await assetCount(A.tenantId);
    expect(await setClinicLogo(A.as("owner"), null)).toEqual({ ok: true, value: { assetId: null } });
    expect(await getClinicPad(A.as("owner"))).toMatchObject({ ok: true, value: { logo: null } });
    expect(await assetCount(A.tenantId)).toBe(before);
    expect(await auditFor(A.tenantId, "clinic.logo_removed")).toHaveLength(1);
  });

  it.each([
    ["an SVG with a script", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ["a PNG with a payload after IEND", Buffer.concat([makePng(64, 32), Buffer.from("<script>alert(1)</script>")])],
    ["a decompression bomb", makePng(5000, 16)],
    ["a truncated JPEG", makeJpegHeader(100, 100).subarray(0, 30)],
    ["a JPEG with a scan before its frame", Buffer.concat([Buffer.from([0xff, 0xd8]), JPEG_SOS, Buffer.from([0xff, 0xd9])])],
    ["an empty file", Buffer.alloc(0)],
    ["a 600 KB file", Buffer.concat([makePng(64, 32), Buffer.alloc(600 * 1024)])],
  ])("rejects %s and stores nothing", async (_label, input) => {
    const before = await assetCount(A.tenantId);
    const result = await setClinicLogo(A.as("owner"), { bytes: new Uint8Array(input) });
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "image" });
    expect(await assetCount(A.tenantId)).toBe(before);
  });

  it("keeps assets immutable for the application role", async () => {
    const error = await withTenant(A.tenantId, (tx) => tx.delete(clinicAssets)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(pgErrorInfo(error).code).toBe("42501");
  });
});

describe("doctor profile", () => {
  const profile = (overrides: Record<string, unknown> = {}) => ({
    displayName: "Dr. Meera Shah",
    qualifications: "MBBS, MD (Medicine)",
    designation: "Consultant Physician",
    registrationNo: "MMC/2011/04-1234",
    registrationCouncil: "Maharashtra Medical Council",
    ...overrides,
  });

  it("reports what is missing for printing, then saves the profile", async () => {
    expect(await getPadReadiness(A.as("doctor"))).toEqual({ ok: true, value: { missing: ["doctorName", "registrationNo"] } });
    expect(await updateDoctorProfile(A.as("doctor"), profile())).toMatchObject({ ok: true });
    expect(await getDoctorProfile(A.as("owner"))).toMatchObject({
      ok: true,
      value: { displayName: "Dr. Meera Shah", registrationNo: "MMC/2011/04-1234", signature: null },
    });
    expect(await getPadReadiness(A.as("doctor"))).toEqual({ ok: true, value: { missing: [] } });
    const events = await auditFor(A.tenantId, "doctor.profile_updated");
    expect(JSON.stringify(events)).not.toContain("MMC/2011/04-1234");
  });

  it.each([
    [{ displayName: "D" }, "displayName"],
    [{ registrationNo: "<b>123</b>" }, "registrationNo"],
    [{ registrationNo: "x".repeat(41) }, "registrationNo"],
    [{ qualifications: "q".repeat(201) }, "qualifications"],
  ])("rejects %j", async (overrides, field) => {
    expect(await updateDoctorProfile(A.as("doctor"), profile(overrides))).toMatchObject({ ok: false, code: "invalid", field });
  });

  it.each(["reception", "nurse", "pharmacist", "accountant"])("forbids %s", async (role) => {
    expect(await updateDoctorProfile(A.as(role), profile())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setDoctorSignature(A.as(role), null)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("tells non-prescribers nothing is missing", async () => {
    expect(await getPadReadiness(A.as("reception"))).toEqual({ ok: true, value: { missing: [] } });
  });

  it("tells a prescriber without a doctor profile that their pads print no doctor", async () => {
    const ownerWithoutProfile = { tenantId: A.tenantId, userId: newId(), role: "owner" };
    expect(await getPadReadiness(ownerWithoutProfile)).toEqual({ ok: true, value: { missing: ["noDoctorProfile"] } });
    expect(await getDoctorProfile(ownerWithoutProfile)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("stores and removes a signature", async () => {
    const stored = await setDoctorSignature(A.as("doctor"), { bytes: new Uint8Array(makePng(200, 60)) });
    expect(stored.ok).toBe(true);
    expect(await getDoctorProfile(A.as("doctor"))).toMatchObject({ ok: true, value: { signature: { width: 200, height: 60 } } });
    expect(await setDoctorSignature(A.as("doctor"), null)).toEqual({ ok: true, value: { assetId: null } });
  });
});
```

`tests/integration/settings-actions.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ requireSession: vi.fn(), getSessionContext: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requireSession } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { clinicAssets, clinics } from "@/server/db/schema";
import { removeLogoAction, saveClinicPadAction, saveDoctorProfileAction, uploadLogoAction } from "@/server/actions/settings";
import { makePng } from "../helpers/images";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(requireSession);
let A: TestTenant;

function form(values: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeAll(async () => {
  A = await createTestTenant("padact");
  await adminDb.insert(clinics).values({ tenantId: A.tenantId, name: "Action Clinic" });
});

afterAll(async () => {
  await A.cleanup();
});

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(A.as("owner"));
});

describe("settings actions", () => {
  it("saves the clinic pad from a form", async () => {
    const state = await saveClinicPadAction({}, form({ name: "Action Clinic", city: "Nashik", rxTemplate: "derma", rxPaperSize: "A4", rxLabels: "hi" }));
    expect(state).toEqual({ saved: true });
    const [row] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(row).toMatchObject({ city: "Nashik", rxTemplate: "derma", rxLabels: "hi" });
  });

  it("returns the field error and the typed values on invalid input", async () => {
    const state = await saveClinicPadAction({}, form({ name: "Action Clinic", email: "nope", rxTemplate: "general", rxPaperSize: "A4", rxLabels: "en" }));
    expect(state).toMatchObject({ field: "email", values: { email: "nope" } });
  });

  it("refuses a doctor profile save for reception", async () => {
    session.mockResolvedValue(A.as("reception"));
    expect(await saveDoctorProfileAction({}, form({ displayName: "Dr. X" }))).toMatchObject({ error: expect.any(String) });
  });

  it("uploads and removes a logo", async () => {
    const file = new File([makePng(80, 40)], "logo.png", { type: "image/png" });
    expect(await uploadLogoAction({}, form({ image: file }))).toEqual({ saved: true });
    expect(await removeLogoAction({})).toEqual({ saved: true });
  });

  it("rejects an oversized file before reading it into the database", async () => {
    const before = (await adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, A.tenantId))).length;
    const big = new File([new Uint8Array(600 * 1024)], "big.png", { type: "image/png" });
    expect(await uploadLogoAction({}, form({ image: big }))).toEqual({ error: "The image is larger than 512 KB.", field: "image" });
    expect(await uploadLogoAction({}, form({}))).toEqual({ error: "Choose a PNG or JPEG image first.", field: "image" });
    const after = (await adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, A.tenantId))).length;
    expect(after).toBe(before);
  });

  it("rejects a non-image that claims to be a PNG", async () => {
    const fake = new File(["<svg onload=alert(1)>"], "evil.png", { type: "image/png" });
    expect(await uploadLogoAction({}, form({ image: fake }))).toEqual({ error: "Upload a PNG or JPEG image.", field: "image" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/permissions.test.ts tests/integration/pad-settings.test.ts tests/integration/settings-actions.test.ts
```

Expected: FAIL — `settings.clinic` is not an action (typecheck error in the test or `false` results), and the service and action modules cannot be resolved.

- [ ] **Step 3: Add the permissions**

In `src/lib/domain/permissions.ts`, add two entries to the `MATRIX` object directly after the last existing entry (Plan 1B's `"catalogue.write"`):

```ts
  "settings.clinic": ["owner"],
  "settings.profile": ["owner", "doctor"],
```

- [ ] **Step 4: Implement the validation schemas**

`src/server/validation/pad-settings.ts` (built on the shared helpers in `src/server/validation/text.ts`, like the prescription and catalogue schemas):

```ts
import { z } from "zod";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES } from "@/lib/rx-render/types";
import { blankToUndefined, cleanInput, cleanOptionalText, hasNoNul, NUL_MESSAGE } from "./text";

// Every string is cleaned (cleanText: NFC, line breaks to LF, control, zero-width and bidi-control characters
// removed) before any rule runs. A string that contains a NUL is passed through untouched, so hasNoNul (or a
// format rule) refuses it with a field error: a NUL is reported, never silently dropped. Blank means absent.
const cleanBlank = (value: unknown) => blankToUndefined(cleanInput(value));
const optionalText = cleanOptionalText;

/** Cleaned, trimmed text of `min` to `max` characters without NUL. */
const requiredText = (min: number, max: number, message: string) =>
  z.preprocess(
    cleanInput,
    z.string().trim().min(min, message).max(max, `Keep this to at most ${max} characters`).refine(hasNoNul, NUL_MESSAGE),
  );

const footer = z
  .string()
  .trim()
  .max(600, "Keep the footer to at most 600 characters")
  .refine(hasNoNul, NUL_MESSAGE)
  .transform((text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n"),
  )
  .refine((text) => text.split("\n").length <= 4, "Use at most 4 footer lines");

export const clinicPadSchema = z.object({
  name: requiredText(2, 120, "Enter the clinic name"),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  // The format rules below also refuse a NUL (it is not in their character classes).
  pincode: z.preprocess(cleanBlank, z.string().trim().regex(/^[0-9A-Za-z -]{3,12}$/, "Enter a valid PIN code").optional()),
  phone: optionalText(80),
  email: z.preprocess(
    cleanBlank,
    z.string().trim().max(120, "Keep this to at most 120 characters").email("Enter a valid email").optional(),
  ),
  padFooter: z.preprocess(cleanBlank, footer.optional()),
  // A missing or blank select reads as the default (the form always sends all three).
  rxTemplate: z.preprocess(cleanBlank, z.enum(BUILTIN_TEMPLATES, { error: "Choose a template from the list" }).default("general")),
  rxPaperSize: z.preprocess(cleanBlank, z.enum(PAPER_SIZES, { error: "Choose A4 or A5" }).default("A4")),
  rxLabels: z.preprocess(cleanBlank, z.enum(LABEL_LANGUAGES, { error: "Choose a label language from the list" }).default("en")),
});

export type ClinicPadInput = z.output<typeof clinicPadSchema>;

export const doctorProfileSchema = z.object({
  displayName: requiredText(2, 120, "Enter your name as it should appear on prescriptions"),
  qualifications: optionalText(200),
  designation: optionalText(200),
  registrationNo: z.preprocess(
    cleanBlank,
    z
      .string()
      .trim()
      .max(40, "Keep this to at most 40 characters")
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/, "Use letters, digits, spaces, dots, slashes or hyphens")
      .optional(),
  ),
  registrationCouncil: optionalText(120),
});

export type DoctorProfileInput = z.output<typeof doctorProfileSchema>;
```

- [ ] **Step 5: Implement image storage**

Append to `src/server/services/assets.ts` (and add these imports at the top: `import { createHash } from "node:crypto";`, `import { and, eq } from "drizzle-orm";` merged with the existing `inArray` import, `import { fail, ok, type Result } from "@/lib/result";`, `import { inspectImage, type ImageMime } from "@/lib/domain/image";`, `import type { ServiceContext } from "./context";`):

```ts
export type StoredAsset = { id: string; mime: ImageMime; width: number; height: number; byteSize: number };

/**
 * Validates an uploaded image from its bytes and stores it once per clinic and kind
 * (identical bytes reuse the existing row). Assets are never updated or deleted afterwards.
 */
export async function storeImageAsset(
  tx: TenantTx,
  ctx: ServiceContext,
  kind: "logo" | "signature",
  bytes: Uint8Array,
): Promise<Result<StoredAsset>> {
  const check = inspectImage(bytes);
  if (!check.ok) return fail("invalid", check.message, "image");
  const { mime, width, height } = check.info;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const [existing] = await tx
    .select({ id: clinicAssets.id })
    .from(clinicAssets)
    .where(and(eq(clinicAssets.kind, kind), eq(clinicAssets.sha256, sha256)))
    .limit(1);
  if (existing) return ok({ id: existing.id, mime, width, height, byteSize: bytes.length });

  const [row] = await tx
    .insert(clinicAssets)
    .values({
      tenantId: ctx.tenantId,
      kind,
      mime,
      width,
      height,
      byteSize: bytes.length,
      sha256,
      bytes: Buffer.from(bytes),
      createdBy: ctx.userId,
    })
    .returning({ id: clinicAssets.id });
  return ok({ id: row.id, mime, width, height, byteSize: bytes.length });
}
```

- [ ] **Step 6: Implement the settings service**

`src/server/services/pad-settings.ts`:

```ts
import { eq } from "drizzle-orm";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { clinics, doctors } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  BUILTIN_TEMPLATES,
  LABEL_LANGUAGES,
  PAPER_SIZES,
  pickOption,
  type BuiltinTemplateKey,
  type LabelLanguage,
  type PaperSize,
} from "@/lib/rx-render/types";
import { clinicPadSchema, doctorProfileSchema } from "@/server/validation/pad-settings";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";
import { assetPreview, loadImageAssets, storeImageAsset, type AssetPreview } from "./assets";
import { primaryClinic } from "./render-snapshot";

export type ClinicPadView = {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  padFooter: string;
  rxTemplate: BuiltinTemplateKey;
  rxPaperSize: PaperSize;
  rxLabels: LabelLanguage;
  logo: AssetPreview | null;
};

export type DoctorProfileView = {
  displayName: string;
  qualifications: string;
  designation: string;
  registrationNo: string;
  registrationCouncil: string;
  signature: AssetPreview | null;
};

/** What a prescriber's printed pads would lack. "noDoctorProfile": the user has no doctor row in this clinic at all. */
export type ProfileGap = "noDoctorProfile" | "doctorName" | "registrationNo";
export type UploadedImage = { bytes: Uint8Array };

const CLINIC_FORBIDDEN = "Only the clinic owner can change the prescription pad.";
const PROFILE_FORBIDDEN = "Only doctors can edit a doctor profile.";
const NO_CLINIC = () => fail("not_found", "Clinic not found.");
const NO_DOCTOR = () => fail("not_found", "You do not have a doctor profile in this clinic.");
const RACE = () => fail("conflict", "The same image was uploaded twice at once. Try again.");

function changedFields(current: Record<string, unknown>, next: Record<string, unknown>): string[] {
  return Object.keys(next).filter((key) => JSON.stringify(next[key] ?? null) !== JSON.stringify(current[key] ?? null));
}

async function ownDoctor(tx: TenantTx, userId: string) {
  const [row] = await tx.select().from(doctors).where(eq(doctors.userId, userId)).limit(1);
  return row ?? null;
}

async function preview(tx: TenantTx, assetId: string | null): Promise<AssetPreview | null> {
  if (!assetId) return null;
  const asset = (await loadImageAssets(tx, [assetId])).get(assetId);
  return asset ? assetPreview(assetId, asset) : null;
}

export async function getClinicPad(ctx: ServiceContext): Promise<Result<ClinicPadView>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", CLINIC_FORBIDDEN);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<ClinicPadView>> => {
    const clinic = await primaryClinic(tx);
    if (!clinic) return NO_CLINIC();
    return ok({
      name: clinic.name,
      addressLine1: clinic.addressLine1 ?? "",
      addressLine2: clinic.addressLine2 ?? "",
      city: clinic.city ?? "",
      state: clinic.state ?? "",
      pincode: clinic.pincode ?? "",
      phone: clinic.phone ?? "",
      email: clinic.email ?? "",
      padFooter: clinic.padFooter ?? "",
      rxTemplate: pickOption(BUILTIN_TEMPLATES, clinic.rxTemplate, "general"),
      rxPaperSize: pickOption(PAPER_SIZES, clinic.rxPaperSize, "A4"),
      rxLabels: pickOption(LABEL_LANGUAGES, clinic.rxLabels, "en"),
      logo: await preview(tx, clinic.logoAssetId),
    });
  });
}

export async function updateClinicPad(ctx: ServiceContext, raw: unknown): Promise<Result<{ changedFields: string[] }>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", CLINIC_FORBIDDEN);
  const parsed = clinicPadSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;
  const next = {
    name: input.name,
    addressLine1: input.addressLine1 ?? null,
    addressLine2: input.addressLine2 ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    pincode: input.pincode ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    padFooter: input.padFooter ?? null,
    rxTemplate: input.rxTemplate,
    rxPaperSize: input.rxPaperSize,
    rxLabels: input.rxLabels,
  };

  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ changedFields: string[] }>> => {
    const clinic = await primaryClinic(tx);
    if (!clinic) return NO_CLINIC();
    const changed = changedFields(clinic, next);
    if (changed.length === 0) return ok({ changedFields: [] });
    await tx.update(clinics).set(next).where(eq(clinics.id, clinic.id));
    await recordAudit(tx, ctx, { action: "clinic.pad_updated", entityType: "clinic", entityId: clinic.id, after: { changedFields: changed } });
    return ok({ changedFields: changed });
  });
}

export async function setClinicLogo(ctx: ServiceContext, image: UploadedImage | null): Promise<Result<{ assetId: string | null }>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", CLINIC_FORBIDDEN);
  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ assetId: string | null }>> => {
      const clinic = await primaryClinic(tx);
      if (!clinic) return NO_CLINIC();
      if (image === null) {
        await tx.update(clinics).set({ logoAssetId: null }).where(eq(clinics.id, clinic.id));
        await recordAudit(tx, ctx, { action: "clinic.logo_removed", entityType: "clinic", entityId: clinic.id });
        return ok({ assetId: null });
      }
      const stored = await storeImageAsset(tx, ctx, "logo", image.bytes);
      if (!stored.ok) return stored;
      await tx.update(clinics).set({ logoAssetId: stored.value.id }).where(eq(clinics.id, clinic.id));
      await recordAudit(tx, ctx, {
        action: "clinic.logo_set",
        entityType: "clinic",
        entityId: clinic.id,
        after: { assetId: stored.value.id, byteSize: stored.value.byteSize, width: stored.value.width, height: stored.value.height },
      });
      return ok({ assetId: stored.value.id });
    });
  } catch (error) {
    if (pgErrorInfo(error).code === "23505") return RACE();
    throw error;
  }
}

export async function getDoctorProfile(ctx: ServiceContext): Promise<Result<DoctorProfileView>> {
  if (!can(ctx.role, "settings.profile")) return fail("forbidden", PROFILE_FORBIDDEN);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<DoctorProfileView>> => {
    const doctor = await ownDoctor(tx, ctx.userId);
    if (!doctor) return NO_DOCTOR();
    return ok({
      displayName: doctor.displayName ?? "",
      qualifications: doctor.qualifications ?? "",
      designation: doctor.designation ?? "",
      registrationNo: doctor.regNo ?? "",
      registrationCouncil: doctor.registrationCouncil ?? "",
      signature: await preview(tx, doctor.signatureAssetId),
    });
  });
}

export async function updateDoctorProfile(ctx: ServiceContext, raw: unknown): Promise<Result<{ changedFields: string[] }>> {
  if (!can(ctx.role, "settings.profile")) return fail("forbidden", PROFILE_FORBIDDEN);
  const parsed = doctorProfileSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;
  const next = {
    displayName: input.displayName,
    qualifications: input.qualifications ?? null,
    designation: input.designation ?? null,
    regNo: input.registrationNo ?? null,
    registrationCouncil: input.registrationCouncil ?? null,
  };

  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ changedFields: string[] }>> => {
    const doctor = await ownDoctor(tx, ctx.userId);
    if (!doctor) return NO_DOCTOR();
    const changed = changedFields(doctor, next);
    if (changed.length === 0) return ok({ changedFields: [] });
    await tx.update(doctors).set(next).where(eq(doctors.id, doctor.id));
    await recordAudit(tx, ctx, { action: "doctor.profile_updated", entityType: "doctor", entityId: doctor.id, after: { changedFields: changed } });
    return ok({ changedFields: changed });
  });
}

export async function setDoctorSignature(ctx: ServiceContext, image: UploadedImage | null): Promise<Result<{ assetId: string | null }>> {
  if (!can(ctx.role, "settings.profile")) return fail("forbidden", PROFILE_FORBIDDEN);
  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ assetId: string | null }>> => {
      const doctor = await ownDoctor(tx, ctx.userId);
      if (!doctor) return NO_DOCTOR();
      if (image === null) {
        await tx.update(doctors).set({ signatureAssetId: null }).where(eq(doctors.id, doctor.id));
        await recordAudit(tx, ctx, { action: "doctor.signature_removed", entityType: "doctor", entityId: doctor.id });
        return ok({ assetId: null });
      }
      const stored = await storeImageAsset(tx, ctx, "signature", image.bytes);
      if (!stored.ok) return stored;
      await tx.update(doctors).set({ signatureAssetId: stored.value.id }).where(eq(doctors.id, doctor.id));
      await recordAudit(tx, ctx, {
        action: "doctor.signature_set",
        entityType: "doctor",
        entityId: doctor.id,
        after: { assetId: stored.value.id, byteSize: stored.value.byteSize, width: stored.value.width, height: stored.value.height },
      });
      return ok({ assetId: stored.value.id });
    });
  } catch (error) {
    if (pgErrorInfo(error).code === "23505") return RACE();
    throw error;
  }
}

/**
 * What the signed-in prescriber's printed pads would lack (the pad is signed by whoever finalizes, ADR-0032).
 * Non-prescribers lack nothing. An owner may have no doctor row at all: finalize still works, so say so.
 */
export async function getPadReadiness(ctx: ServiceContext): Promise<Result<{ missing: ProfileGap[] }>> {
  if (!can(ctx.role, "rx.draft")) return ok({ missing: [] });
  return withTenant(ctx.tenantId, async (tx) => {
    const doctor = await ownDoctor(tx, ctx.userId);
    const missing: ProfileGap[] = [];
    if (!doctor) {
      missing.push("noDoctorProfile");
    } else {
      if (!doctor.displayName?.trim()) missing.push("doctorName");
      if (!doctor.regNo?.trim()) missing.push("registrationNo");
    }
    return ok({ missing });
  });
}
```

`changedFields(clinic, next)` compares only the keys of `next`, so the clinic row's other columns (id, timezone, ...) are ignored. Drizzle row types are assignable to `Record<string, unknown>`.

- [ ] **Step 7: Implement the server actions**

`src/server/actions/settings.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/server/auth/session";
import { IMAGE_LIMITS } from "@/lib/domain/image";
import {
  setClinicLogo,
  setDoctorSignature,
  updateClinicPad,
  updateDoctorProfile,
} from "@/server/services/pad-settings";

export type SettingsFormState = { error?: string; field?: string; saved?: boolean; values?: Record<string, string> };

const CLINIC_FIELDS = ["name", "addressLine1", "addressLine2", "city", "state", "pincode", "phone", "email", "padFooter", "rxTemplate", "rxPaperSize", "rxLabels"];
const DOCTOR_FIELDS = ["displayName", "qualifications", "designation", "registrationNo", "registrationCouncil"];

function readValues(formData: FormData, fields: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = formData.get(field);
    values[field] = typeof value === "string" ? value : "";
  }
  return values;
}

/** Size is checked before the bytes are read; inspectImage() decides what the bytes are. */
async function readImage(formData: FormData): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const value = formData.get("image");
  if (!(value instanceof File) || value.size === 0) return { ok: false, error: "Choose a PNG or JPEG image first." };
  if (value.size > IMAGE_LIMITS.maxBytes) return { ok: false, error: `The image is larger than ${IMAGE_LIMITS.maxBytes / 1024} KB.` };
  return { ok: true, bytes: new Uint8Array(await value.arrayBuffer()) };
}

export async function saveClinicPadAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const session = await requireSession();
  const values = readValues(formData, CLINIC_FIELDS);
  const result = await updateClinicPad(session, values);
  if (!result.ok) return { error: result.message, field: result.field, values };
  revalidatePath("/settings");
  return { saved: true };
}

export async function saveDoctorProfileAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const session = await requireSession();
  const values = readValues(formData, DOCTOR_FIELDS);
  const result = await updateDoctorProfile(session, values);
  if (!result.ok) return { error: result.message, field: result.field, values };
  revalidatePath("/settings/profile");
  return { saved: true };
}

export async function uploadLogoAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const session = await requireSession();
  const image = await readImage(formData);
  if (!image.ok) return { error: image.error, field: "image" };
  const result = await setClinicLogo(session, { bytes: image.bytes });
  if (!result.ok) return { error: result.message, field: "image" };
  revalidatePath("/settings");
  return { saved: true };
}

export async function removeLogoAction(_prev: SettingsFormState): Promise<SettingsFormState> {
  const session = await requireSession();
  const result = await setClinicLogo(session, null);
  if (!result.ok) return { error: result.message };
  revalidatePath("/settings");
  return { saved: true };
}

export async function uploadSignatureAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  const session = await requireSession();
  const image = await readImage(formData);
  if (!image.ok) return { error: image.error, field: "image" };
  const result = await setDoctorSignature(session, { bytes: image.bytes });
  if (!result.ok) return { error: result.message, field: "image" };
  revalidatePath("/settings/profile");
  return { saved: true };
}

export async function removeSignatureAction(_prev: SettingsFormState): Promise<SettingsFormState> {
  const session = await requireSession();
  const result = await setDoctorSignature(session, null);
  if (!result.ok) return { error: result.message };
  revalidatePath("/settings/profile");
  return { saved: true };
}
```

The field-name lists are plain module constants, not exports (a `"use server"` file may export only async functions and types).

- [ ] **Step 8: Run the tests and typecheck**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/permissions.test.ts tests/integration/pad-settings.test.ts tests/integration/settings-actions.test.ts
Set-Location E:\projects\clinicpad; npm run typecheck
```

Expected: all PASS (`permissions.test.ts` gains 14: twelve matrix cells and two cases; `pad-settings.test.ts` 42; `settings-actions.test.ts` 6); typecheck exits 0 (it fails until `granted` has the two new rows). Every image rejection must come back with `field: "image"` (from `storeImageAsset`), whichever check failed. If the NUL row is accepted with the NUL removed, a field bypasses `cleanInput`: `cleanText` alone strips NUL, so every schema field must go through `requiredText`, `cleanOptionalText`, or `cleanBlank` as written. If the `rxTemplate: "fancy"` row reports no field, Zod put the enum issue at the root: the preprocessed `z.enum` must be a direct property of the object schema, as written.

- [ ] **Step 9: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/domain/permissions.ts src/server/validation/pad-settings.ts src/server/services/pad-settings.ts src/server/services/assets.ts src/server/actions/settings.ts tests/unit/permissions.test.ts tests/integration/pad-settings.test.ts tests/integration/settings-actions.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: add clinic pad, doctor profile, and validated logo and signature uploads" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 7: Settings UI — clinic pad, doctor profile, logo and signature

**Files:**
- Create: `src/components/settings/clinic-pad-form.tsx`, `src/components/settings/doctor-profile-form.tsx`, `src/components/settings/image-upload-form.tsx`, `src/app/(app)/settings/profile/page.tsx`, `tests/e2e/pad-settings.spec.ts`
- Modify: `src/app/(app)/settings/page.tsx` (full replacement), `src/components/app-shell/sidebar.tsx`, `tests/unit/sidebar.test.tsx` (append)
- Test: `tests/unit/image-upload-form.test.tsx`, `tests/unit/sidebar.test.tsx`, `tests/e2e/pad-settings.spec.ts`

**Interfaces:**
- Consumes: Task 6 actions and views (`SettingsFormState`, `ClinicPadView`, `DoctorProfileView`, `AssetPreview`, `getClinicPad`, `getDoctorProfile`); Task 4 `TEMPLATE_DEFINITIONS`; Task 2 `IMAGE_LIMITS`, test helper `makePng`; `requireSession` (`src/server/auth/session.ts`), `can`; e2e helpers `registerClinic(page, label)` (signs up "Dr. E2E Tester" as owner), `cleanupClinic(email)`, `setRole(email, role)` (`tests/e2e/helpers.ts`).
- Produces:
  - Routes `/settings` (owner: clinic details, pad form, logo) and `/settings/profile` (owner and doctor: profile form, signature). Non-owners who may edit a profile are redirected from `/settings` to `/settings/profile`; everyone else to `/dashboard`.
  - `<ClinicPadForm initial={ClinicPadView} />`, `<DoctorProfileForm initial={DoctorProfileView} />`, `<ImageUploadForm label hint current upload remove />`, `checkImageFile(file: { size: number; type: string }): string | null`.
  - Labels used by e2e specs: "Clinic name", "Address line 1", "Address line 2", "City", "State", "PIN code", "Phone on pad", "Email on pad", "Footer lines", "Template", "Paper size", "Label language", button "Save pad"; "Name on prescriptions", "Qualifications", "Designation", "Registration number", "Registration council", button "Save profile"; image inputs "Clinic logo" and "Signature", buttons "Upload" and "Remove"; status texts "Saved." and "Image saved.".
  - Sidebar item "My profile" (`/settings/profile`) for the doctor role.

- [ ] **Step 1: Write the failing tests**

`tests/unit/image-upload-form.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageUploadForm, checkImageFile } from "@/components/settings/image-upload-form";

function setup() {
  const upload = vi.fn(async () => ({ saved: true }));
  const remove = vi.fn(async () => ({ saved: true }));
  render(<ImageUploadForm label="Clinic logo" hint="PNG or JPEG" current={null} upload={upload} remove={remove} />);
  return { upload, remove, input: screen.getByLabelText("Clinic logo") as HTMLInputElement };
}

describe("checkImageFile", () => {
  it.each([
    [{ size: 1000, type: "image/png" }, null],
    [{ size: 1000, type: "image/jpeg" }, null],
    [{ size: 1000, type: "image/svg+xml" }, "Choose a PNG or JPEG image."],
    [{ size: 1000, type: "" }, "Choose a PNG or JPEG image."],
    [{ size: 600 * 1024, type: "image/png" }, "The image is larger than 512 KB."],
  ])("checks %j", (file, expected) => {
    expect(checkImageFile(file)).toBe(expected);
  });
});

describe("ImageUploadForm", () => {
  it("blocks an oversized file before it is sent", () => {
    const { input, upload } = setup();
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(600 * 1024)], "big.png", { type: "image/png" })] } });
    expect(screen.getByRole("alert")).toHaveTextContent("larger than 512 KB");
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("blocks an SVG", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })] } });
    expect(screen.getByRole("alert")).toHaveTextContent("PNG or JPEG");
  });

  it("allows a small PNG and says there is no image yet", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], "logo.png", { type: "image/png" })] } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
    expect(screen.getByText("No image yet.")).toBeInTheDocument();
  });

  it("shows the current image with a remove button", () => {
    render(
      <ImageUploadForm
        label="Signature"
        hint="PNG or JPEG"
        current={{ id: "a", dataUrl: "data:image/png;base64,AAAA", width: 200, height: 60 }}
        upload={vi.fn(async () => ({}))}
        remove={vi.fn(async () => ({}))}
      />,
    );
    expect(screen.getByRole("img", { name: "Current signature" })).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});
```

Append to `tests/unit/sidebar.test.tsx` (inside the existing `describe("Sidebar", ...)` block, after the last `it`):

```tsx
  it("gives doctors their profile but not clinic settings", () => {
    render(<Sidebar role="doctor" clinicName="Sunrise" />);
    expect(screen.getByRole("link", { name: /my profile/i })).toHaveAttribute("href", "/settings/profile");
    expect(screen.queryByRole("link", { name: /^settings$/i })).not.toBeInTheDocument();
  });
```

`tests/e2e/pad-settings.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { makePng } from "../helpers/images";
import { cleanupClinic, registerClinic, setRole, type Clinic } from "./helpers";

let clinic: Clinic;

test.afterAll(async () => {
  if (clinic) await cleanupClinic(clinic.email);
});

test("an owner sets up the prescription pad, logo, profile, and signature", async ({ page }) => {
  test.setTimeout(120_000);
  clinic = await registerClinic(page, "pad");
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    dialogs += 1;
    await dialog.dismiss();
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /clinic settings/i })).toBeVisible();
  await page.getByLabel("Address line 1").fill("12 MG Road");
  await page.getByLabel("City").fill("Pune");
  await page.getByLabel("PIN code").fill("411001");
  await page.getByLabel("Phone on pad").fill("020-2612 3456");
  await page.getByLabel("Footer lines").fill("Closed on Sundays\nPlease bring your previous prescriptions");
  await page.getByLabel("Template").selectOption("paediatric");
  await page.getByLabel("Paper size").selectOption("A5");
  await page.getByLabel("Label language").selectOption("bilingual");
  await page.getByRole("button", { name: "Save pad" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Address line 1")).toHaveValue("12 MG Road");
  await expect(page.getByLabel("Template")).toHaveValue("paediatric");
  await expect(page.getByLabel("Paper size")).toHaveValue("A5");

  // A file that claims to be a PNG but is an SVG with a script is refused by the server.
  await page.getByLabel("Clinic logo").setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)>") });
  await page.getByRole("button", { name: "Upload" }).click();
  // getByText, not getByRole("alert"): Next.js's route announcer is also an alert region.
  await expect(page.getByText("Upload a PNG or JPEG image.")).toBeVisible();

  await page.getByLabel("Clinic logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: makePng(120, 60) });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText("Image saved.")).toBeVisible();
  await expect(page.getByRole("img", { name: "Current clinic logo" })).toBeVisible();

  await page.getByRole("link", { name: /edit your doctor profile/i }).click();
  await expect(page.getByRole("heading", { name: /doctor profile/i })).toBeVisible();
  await expect(page.getByLabel("Name on prescriptions")).toHaveValue("Dr. E2E Tester");
  await page.getByLabel("Qualifications").fill("MBBS, MD (Medicine)");
  await page.getByLabel("Registration number").fill("MMC/2026/0042");
  await page.getByLabel("Registration council").fill("Maharashtra Medical Council");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  await page.getByLabel("Signature").setInputFiles({ name: "sign.png", mimeType: "image/png", buffer: makePng(200, 60, [10, 10, 10]) });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("img", { name: "Current signature" })).toBeVisible();
  expect(dialogs).toBe(0);
});

test("settings follow the role", async ({ page }) => {
  test.setTimeout(120_000);
  const other = await registerClinic(page, "padrole");
  try {
    await setRole(other.email, "doctor");
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(page.getByRole("link", { name: /my profile/i })).toBeVisible();

    await setRole(other.email, "reception");
    await page.goto("/settings/profile");
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/dashboard/);
  } finally {
    await cleanupClinic(other.email);
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/image-upload-form.test.tsx tests/unit/sidebar.test.tsx
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/pad-settings.spec.ts
```

Expected: FAIL — the components do not exist, the sidebar has no "My profile", the settings page has no pad form.

- [ ] **Step 3: Implement the image upload form**

`src/components/settings/image-upload-form.tsx`:

```tsx
"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { IMAGE_LIMITS } from "@/lib/domain/image";
import type { SettingsFormState } from "@/server/actions/settings";
import type { AssetPreview } from "@/server/services/assets";

type Props = {
  label: string;
  hint: string;
  current: AssetPreview | null;
  upload: (prev: SettingsFormState, formData: FormData) => Promise<SettingsFormState>;
  remove: (prev: SettingsFormState) => Promise<SettingsFormState>;
};

/** Quick checks before upload. The server decides from the bytes; this only saves a round trip. */
export function checkImageFile(file: { size: number; type: string }): string | null {
  if (file.type !== "image/png" && file.type !== "image/jpeg") return "Choose a PNG or JPEG image.";
  if (file.size > IMAGE_LIMITS.maxBytes) return `The image is larger than ${IMAGE_LIMITS.maxBytes / 1024} KB.`;
  return null;
}

export function ImageUploadForm({ label, hint, current, upload, remove }: Props) {
  const [state, uploadAction, uploading] = useActionState(upload, {} as SettingsFormState);
  const [removeState, removeAction, removing] = useActionState(remove, {} as SettingsFormState);
  const [clientError, setClientError] = useState<string | null>(null);
  const inputId = useId();
  const error = clientError ?? state.error ?? removeState.error ?? null;

  return (
    <div className="space-y-3">
      <form action={uploadAction} className="space-y-2">
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          id={inputId}
          name="image"
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => {
            const file = event.target.files?.[0];
            setClientError(file ? checkImageFile(file) : null);
          }}
        />
        <p className="text-xs text-muted-foreground">{hint}</p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {state.saved && !error ? (
          <p role="status" className="text-sm text-muted-foreground">
            Image saved.
          </p>
        ) : null}
        <Button type="submit" variant="outline" disabled={uploading || clientError !== null}>
          {uploading ? "Uploading…" : "Upload"}
        </Button>
      </form>

      {current ? (
        <div className="flex items-center gap-4 rounded-md border p-3">
          {/* A data: URL from our own asset store; next/image adds nothing here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={current.dataUrl}
            alt={`Current ${label.toLowerCase()}`}
            width={current.width}
            height={current.height}
            className="max-h-16 w-auto"
          />
          <form action={removeAction}>
            <Button type="submit" variant="ghost" disabled={removing}>
              Remove
            </Button>
          </form>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No image yet.</p>
      )}
    </div>
  );
}
```

`AssetPreview` and `SettingsFormState` are type-only imports from server modules, so no server code reaches the client bundle.

- [ ] **Step 4: Implement the two settings forms**

`src/components/settings/clinic-pad-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveClinicPadAction, type SettingsFormState } from "@/server/actions/settings";
import { TEMPLATE_DEFINITIONS } from "@/lib/rx-render/templates";
import type { ClinicPadView } from "@/server/services/pad-settings";

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

const TEXT_FIELDS = [
  ["name", "Clinic name"],
  ["addressLine1", "Address line 1"],
  ["addressLine2", "Address line 2"],
  ["city", "City"],
  ["state", "State"],
  ["pincode", "PIN code"],
  ["phone", "Phone on pad"],
  ["email", "Email on pad"],
] as const;

export function ClinicPadForm({ initial }: { initial: ClinicPadView }) {
  const [state, formAction, pending] = useActionState(saveClinicPadAction, {} as SettingsFormState);
  const v: Record<string, string> = state.values ?? {
    name: initial.name,
    addressLine1: initial.addressLine1,
    addressLine2: initial.addressLine2,
    city: initial.city,
    state: initial.state,
    pincode: initial.pincode,
    phone: initial.phone,
    email: initial.email,
    padFooter: initial.padFooter,
    rxTemplate: initial.rxTemplate,
    rxPaperSize: initial.rxPaperSize,
    rxLabels: initial.rxLabels,
  };

  return (
    <form action={formAction} className="max-w-2xl space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {TEXT_FIELDS.map(([name, label]) => (
          <div key={name} className="space-y-2">
            <Label htmlFor={`pad-${name}`}>{label}</Label>
            <Input id={`pad-${name}`} name={name} defaultValue={v[name] ?? ""} aria-invalid={state.field === name} />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <Label htmlFor="pad-padFooter">Footer lines</Label>
        <Textarea id="pad-padFooter" name="padFooter" rows={3} defaultValue={v.padFooter ?? ""} aria-invalid={state.field === "padFooter"} />
        <p className="text-xs text-muted-foreground">Up to 4 lines, printed at the bottom of every page (timings, holidays, notes).</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="pad-rxTemplate">Template</Label>
          <select id="pad-rxTemplate" name="rxTemplate" className={selectClass} defaultValue={v.rxTemplate}>
            {Object.values(TEMPLATE_DEFINITIONS).map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pad-rxPaperSize">Paper size</Label>
          <select id="pad-rxPaperSize" name="rxPaperSize" className={selectClass} defaultValue={v.rxPaperSize}>
            <option value="A4">A4</option>
            <option value="A5">A5</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pad-rxLabels">Label language</Label>
          <select id="pad-rxLabels" name="rxLabels" className={selectClass} defaultValue={v.rxLabels}>
            <option value="en">English</option>
            <option value="hi">Hindi</option>
            <option value="bilingual">English + Hindi</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Changes apply to prescriptions finalized from now on. Finalized prescriptions keep the pad they were finalized with.
      </p>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved.
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save pad"}
      </Button>
    </form>
  );
}
```

`src/components/settings/doctor-profile-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveDoctorProfileAction, type SettingsFormState } from "@/server/actions/settings";
import type { DoctorProfileView } from "@/server/services/pad-settings";

const FIELDS = [
  ["displayName", "Name on prescriptions"],
  ["qualifications", "Qualifications"],
  ["designation", "Designation"],
  ["registrationNo", "Registration number"],
  ["registrationCouncil", "Registration council"],
] as const;

export function DoctorProfileForm({ initial }: { initial: DoctorProfileView }) {
  const [state, formAction, pending] = useActionState(saveDoctorProfileAction, {} as SettingsFormState);
  const v: Record<string, string> = state.values ?? {
    displayName: initial.displayName,
    qualifications: initial.qualifications,
    designation: initial.designation,
    registrationNo: initial.registrationNo,
    registrationCouncil: initial.registrationCouncil,
  };

  return (
    <form action={formAction} className="max-w-xl space-y-4">
      {FIELDS.map(([name, label]) => (
        <div key={name} className="space-y-2">
          <Label htmlFor={`doc-${name}`}>{label}</Label>
          <Input id={`doc-${name}`} name={name} defaultValue={v[name] ?? ""} aria-invalid={state.field === name} />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Printed in the pad header and under your signature. Prescriptions you already finalized keep the details they were finalized with.
      </p>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved.
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 5: Implement the pages and the sidebar item**

Replace the whole content of `src/app/(app)/settings/page.tsx` with:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { withTenant } from "@/server/db/tenant";
import { tenants } from "@/server/db/schema";
import { primaryClinic } from "@/server/services/render-snapshot";
import { getClinicPad } from "@/server/services/pad-settings";
import { removeLogoAction, uploadLogoAction } from "@/server/actions/settings";
import { ClinicPadForm } from "@/components/settings/clinic-pad-form";
import { ImageUploadForm } from "@/components/settings/image-upload-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireSession();
  if (!can(session.role, "settings.clinic")) {
    redirect(can(session.role, "settings.profile") ? "/settings/profile" : "/dashboard");
  }

  const data = await withTenant(session.tenantId, async (tx) => {
    const [tenant] = await tx.select().from(tenants).limit(1);
    return { tenant, clinic: await primaryClinic(tx) };
  });
  const pad = await getClinicPad(session);

  const rows: [string, string | undefined][] = [
    ["Clinic", data.tenant?.name],
    ["Plan", data.tenant?.plan],
    ["Data region", data.tenant?.region],
    ["Timezone", data.clinic?.timezone],
    ["Currency", data.clinic?.currency],
  ];

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">Clinic settings</h1>
      <dl className="divide-y rounded-lg border">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 p-4 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value ?? "—"}</dd>
          </div>
        ))}
      </dl>

      {pad.ok ? (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Prescription pad</h2>
            <ClinicPadForm initial={pad.value} />
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Logo</h2>
            <ImageUploadForm
              label="Clinic logo"
              hint="PNG or JPEG, up to 512 KB and 2000 × 2000 pixels. Printed at the top of every page."
              current={pad.value.logo}
              upload={uploadLogoAction}
              remove={removeLogoAction}
            />
          </section>
        </>
      ) : (
        <p className="text-sm text-destructive">{pad.message}</p>
      )}

      <p className="text-sm">
        <Link className="underline" href="/settings/profile">
          Edit your doctor profile
        </Link>{" "}
        (name, qualifications, registration number, signature).
      </p>
    </div>
  );
}
```

`src/app/(app)/settings/profile/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { getDoctorProfile } from "@/server/services/pad-settings";
import { removeSignatureAction, uploadSignatureAction } from "@/server/actions/settings";
import { DoctorProfileForm } from "@/components/settings/doctor-profile-form";
import { ImageUploadForm } from "@/components/settings/image-upload-form";

export const dynamic = "force-dynamic";

export default async function DoctorProfilePage() {
  const session = await requireSession();
  if (!can(session.role, "settings.profile")) redirect("/dashboard");

  const profile = await getDoctorProfile(session);

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">Doctor profile</h1>
      {profile.ok ? (
        <>
          <DoctorProfileForm initial={profile.value} />
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Signature</h2>
            <ImageUploadForm
              label="Signature"
              hint="A PNG or JPEG of your signature on white paper, up to 512 KB. Printed above your name on every prescription you finalize."
              current={profile.value.signature}
              upload={uploadSignatureAction}
              remove={removeSignatureAction}
            />
          </section>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{profile.message}</p>
      )}
    </div>
  );
}
```

In `src/components/app-shell/sidebar.tsx`, change the import to `import { LayoutDashboard, Settings, UserRound, Users } from "lucide-react";` and add this entry to the `items` array (an `as const` list) directly after the `/settings` entry:

```ts
  { href: "/settings/profile", label: "My profile", icon: UserRound, roles: ["doctor"] },
```

(Owners reach their profile from the Settings page; doctors who are not owners get it in the sidebar.)

- [ ] **Step 6: Run the unit and e2e tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/image-upload-form.test.tsx tests/unit/sidebar.test.tsx
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/pad-settings.spec.ts tests/e2e/smoke.spec.ts
```

Expected: all PASS (`image-upload-form.test.tsx` 9, `sidebar.test.tsx` 5, e2e `pad-settings.spec.ts` 2 and `smoke.spec.ts` 6), including the Phase 0 smoke flow (it still finds the "Clinic settings" heading and `Asia/Kolkata`, unauthenticated `/settings` still goes to `/login`, and reception is still redirected from `/settings` to `/dashboard` with no "Settings" link). The settings forms are uncontrolled (`defaultValue`), so text Playwright types before hydration survives it; no hydration wait is needed here (unlike the clinical editor). If `getByLabel("City")` matches two inputs, a label elsewhere on the page contains "City": keep labels exactly as listed. If the SVG-as-PNG upload shows no alert, the server action's `{ error }` is not rendered: `ImageUploadForm` must show `state.error`.

- [ ] **Step 7: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/components/settings/clinic-pad-form.tsx src/components/settings/doctor-profile-form.tsx src/components/settings/image-upload-form.tsx "src/app/(app)/settings/page.tsx" "src/app/(app)/settings/profile/page.tsx" src/components/app-shell/sidebar.tsx tests/unit/image-upload-form.test.tsx tests/unit/sidebar.test.tsx tests/e2e/pad-settings.spec.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: add prescription pad settings, doctor profile, and image upload UI" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 8: Embedded fonts, the PDF engine, and Gotenberg in local dev and CI

**Files:**
- Create: `src/server/rx-render/fonts.ts`, `src/server/pdf/engine.ts`, `src/server/pdf/gotenberg.ts`, `src/server/pdf/index.ts`, `tests/helpers/fake-pdf-engine.ts`
- Modify: `package.json` + `package-lock.json` (dependency), `next.config.ts`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.env.example`
- Test: `tests/unit/fonts.test.ts`, `tests/unit/gotenberg.test.ts`, `tests/integration/gotenberg-smoke.test.ts`

**Interfaces:**
- Consumes: Task 2 `checkSelfContained`; Tasks 3–4 `RenderedDocument`, `PAPER`, `renderPrescription`, `DOCUMENT_CSP`, fixtures.
- Produces:
  - `loadFontCss(): string` (cached; Noto Sans Devanagari 400 + 700, every subset, as `data:font/woff2` URIs); `inlineFontCss(css: string, packageDir: string): string`; `FONT_PACKAGE_DIR`.
  - `engine.ts`: `type PdfFailureCode = "pdf_unavailable" | "pdf_timeout" | "pdf_failed" | "pdf_too_large" | "pdf_refused"`; `type PdfOutcome = { ok: true; pdf: ArrayBuffer; pageCount: number } | { ok: false; code: PdfFailureCode; message: string }`; `type PdfHealth = { up: boolean; detail: string }`; `interface PdfEngine { render(doc: RenderedDocument): Promise<PdfOutcome>; health(): Promise<PdfHealth> }`; `PDF_LIMITS = { maxHtmlBytes: 4 MiB, maxPdfBytes: 15 MiB, maxPages: 20, renderTimeoutMs: 20000, healthTimeoutMs: 2000 }`; `PDF_MESSAGES: Record<PdfFailureCode, string>`; `countPdfPages(pdf: ArrayBuffer): number`.
  - `gotenberg.ts`: `type GotenbergOptions = { baseUrl: string; fetch?: typeof fetch; renderTimeoutMs?; healthTimeoutMs?; maxPdfBytes?; maxPages? }`; `createGotenbergEngine(options): PdfEngine`; `gotenbergForm(doc: RenderedDocument): FormData`; `postHtmlToGotenberg(options, form): Promise<PdfOutcome>`.
  - `index.ts`: `getPdfEngine(): PdfEngine` (process-wide, `GOTENBERG_URL`, default `http://localhost:3001`).
  - Test helper: `type FakePdfEngine = PdfEngine & { calls: RenderedDocument[]; failWith: PdfFailureCode | null; up: boolean; pages: number }`; `createFakePdfEngine(pages?)`; `fakePdfBytes(pages): ArrayBuffer`; `sharedFakeEngine`; `resetFakeEngine(engine)`.
  - Docker service `gotenberg` on host port 3001; CI starts the same image and sets `GOTENBERG_URL`.

- [ ] **Step 1: Install the font package**

```powershell
Set-Location E:\projects\clinicpad; npm install --save-exact @fontsource/noto-sans-devanagari@5
Set-Location E:\projects\clinicpad; Get-ChildItem node_modules/@fontsource/noto-sans-devanagari -Name
Set-Location E:\projects\clinicpad; Get-Content node_modules/@fontsource/noto-sans-devanagari/400.css -TotalCount 12
```

Expected: `package.json` lists the package with an exact version (no `^`); the directory contains `400.css`, `700.css`, and a `files/` folder; `400.css` contains `@font-face` blocks with `src: url(./files/noto-sans-devanagari-<subset>-400-normal.woff2) format('woff2'), url(./files/...woff) format('woff');` and a `unicode-range`. The font is under the SIL Open Font License; the package includes the licence file.

- [ ] **Step 2: Write the fake engine helper**

`tests/helpers/fake-pdf-engine.ts`:

```ts
import { PDF_MESSAGES, type PdfEngine, type PdfFailureCode } from "@/server/pdf/engine";
import type { RenderedDocument } from "@/lib/rx-render/types";

export type FakePdfEngine = PdfEngine & {
  calls: RenderedDocument[];
  failWith: PdfFailureCode | null;
  up: boolean;
  pages: number;
};

/** A minimal PDF with one /Type /Page object per page (what countPdfPages counts). */
export function fakePdfBytes(pages: number): ArrayBuffer {
  const objects = Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n");
  const text = `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${objects}\n%%EOF\n`;
  const bytes = new TextEncoder().encode(text);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function createFakePdfEngine(pages = 1): FakePdfEngine {
  const engine: FakePdfEngine = {
    calls: [],
    failWith: null,
    up: true,
    pages,
    async render(doc) {
      engine.calls.push(doc);
      if (engine.failWith) return { ok: false, code: engine.failWith, message: PDF_MESSAGES[engine.failWith] };
      return { ok: true, pdf: fakePdfBytes(engine.pages), pageCount: engine.pages };
    },
    async health() {
      return engine.up ? { up: true, detail: "fake" } : { up: false, detail: "fake down" };
    },
  };
  return engine;
}

/** One instance for vi.mock("@/server/pdf") factories and the tests that inspect it. */
export const sharedFakeEngine = createFakePdfEngine(2);

export function resetFakeEngine(engine: FakePdfEngine, pages = 2): void {
  engine.calls.length = 0;
  engine.failWith = null;
  engine.up = true;
  engine.pages = pages;
}
```

- [ ] **Step 3: Write the failing tests**

`tests/unit/fonts.test.ts`:

```ts
// @vitest-environment node
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inlineFontCss, loadFontCss } from "@/server/rx-render/fonts";
import { checkSelfContained } from "@/lib/rx-render/self-contained";

describe("loadFontCss", () => {
  it("inlines every Noto Sans Devanagari face as WOFF2 data and nothing else", () => {
    const css = loadFontCss();
    expect(css).toMatch(/font-family:\s*['"]Noto Sans Devanagari['"]/);
    expect((css.match(/@font-face/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(css).toMatch(/U\+0900-097F/i);
    const urls = css.match(/url\(([^)]*)\)/g) ?? [];
    expect(urls.length).toBeGreaterThanOrEqual(6);
    for (const url of urls) expect(url.startsWith("url(data:font/woff2;base64,")).toBe(true);
    expect(css).not.toContain("./files/");
    expect(css).not.toContain("font-display: swap");
    expect(checkSelfContained(`<style>${css}</style>`)).toEqual({ ok: true });
  });

  it("is cached", () => {
    expect(loadFontCss()).toBe(loadFontCss());
  });
});

describe("inlineFontCss", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-"));
  mkdirSync(path.join(dir, "files"));
  writeFileSync(path.join(dir, "files", "a.woff2"), Buffer.from([1, 2, 3]));

  it("replaces relative WOFF2 URLs and drops the WOFF fallback", () => {
    const css = "@font-face{font-family:'X';font-display: swap;src:url(./files/a.woff2) format('woff2'), url(./files/a.woff) format('woff');}";
    expect(inlineFontCss(css, dir)).toBe("@font-face{font-family:'X';font-display: block;src:url(data:font/woff2;base64,AQID) format('woff2');}");
  });

  it("fails loudly on a reference it cannot inline", () => {
    expect(() => inlineFontCss("@font-face{src:url(./files/a.ttf)}", dir)).toThrow("not inlined");
    expect(() => inlineFontCss("@font-face{src:url(./files/missing.woff2) format('woff2')}", dir)).toThrow();
  });
});
```

`tests/unit/gotenberg.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createGotenbergEngine } from "@/server/pdf/gotenberg";
import { countPdfPages, PDF_LIMITS } from "@/server/pdf/engine";
import { renderPrescription } from "@/lib/rx-render/render";
import { documentFixture } from "../fixtures/rx-documents";
import { fakePdfBytes } from "../helpers/fake-pdf-engine";

const BASE = "http://gotenberg.test";
const rendered = renderPrescription(documentFixture(), { logo: null, signature: null, fontCss: "" });

type FetchInput = Parameters<typeof fetch>[0];
function recorder(respond: (input: FetchInput, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond(input, init);
  };
  return { calls, impl };
}

const pdfResponse = (pages: number, headers: Record<string, string> = {}) =>
  new Response(fakePdfBytes(pages), { status: 200, headers: { "Content-Type": "application/pdf", ...headers } });

describe("createGotenbergEngine.render", () => {
  it("posts the document, an empty header, and the page-number footer to the Chromium route", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(2));
    const outcome = await createGotenbergEngine({ baseUrl: `${BASE}/`, fetch: impl }).render(rendered);
    expect(outcome).toMatchObject({ ok: true, pageCount: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/forms/chromium/convert/html`);
    expect(calls[0].init?.method).toBe("POST");
    const form = calls[0].init?.body as FormData;
    const files = form.getAll("files") as File[];
    expect(files.map((f) => f.name)).toEqual(["index.html", "header.html", "footer.html"]);
    expect(await files[0].text()).toBe(rendered.html);
    expect(await files[2].text()).toBe(rendered.footerHtml);
    expect(form.get("paperWidth")).toBe("8.27");
    expect(form.get("paperHeight")).toBe("11.69");
    expect(form.get("marginTop")).toBe("0.472");
    expect(form.get("marginBottom")).toBe("0.551");
    expect(form.get("preferCssPageSize")).toBe("true");
    expect(form.get("printBackground")).toBe("true");
  });

  it("refuses a document that is not self-contained without calling the service", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(1));
    const tampered = { ...rendered, html: rendered.html.replace("</body>", '<img src="http://evil.example/x.png"></body>') };
    expect(await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).render(tampered)).toMatchObject({ ok: false, code: "pdf_refused" });
    expect(calls).toHaveLength(0);
  });

  it("refuses HTML over the size cap without calling the service", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(1));
    const huge = { ...rendered, html: rendered.html.replace("</body>", `<p>${"x".repeat(PDF_LIMITS.maxHtmlBytes)}</p></body>`) };
    expect(await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).render(huge)).toMatchObject({ ok: false, code: "pdf_too_large" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a refused connection", async () => { throw new TypeError("fetch failed"); }, "pdf_unavailable"],
    ["a 503", async () => new Response("busy", { status: 503 }), "pdf_unavailable"],
    ["a 500", async () => new Response("boom", { status: 500 }), "pdf_failed"],
    ["HTML instead of a PDF", async () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }), "pdf_failed"],
    ["a body that is not a PDF", async () => new Response("not a pdf", { status: 200, headers: { "Content-Type": "application/pdf" } }), "pdf_failed"],
    ["a declared size over the cap", async () => pdfResponse(1, { "Content-Length": String(PDF_LIMITS.maxPdfBytes + 1) }), "pdf_too_large"],
    ["more pages than the cap", async () => pdfResponse(PDF_LIMITS.maxPages + 1), "pdf_too_large"],
  ])("maps %s to %s", async (_label, respond, code) => {
    const engine = createGotenbergEngine({ baseUrl: BASE, fetch: recorder(respond).impl });
    expect(await engine.render(rendered)).toMatchObject({ ok: false, code });
  });

  it("gives up after the timeout", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const engine = createGotenbergEngine({ baseUrl: BASE, fetch: hang, renderTimeoutMs: 50 });
    expect(await engine.render(rendered)).toMatchObject({ ok: false, code: "pdf_timeout" });
  });
});

describe("createGotenbergEngine.health", () => {
  it.each([
    ["up", async () => Response.json({ status: "up" }), true],
    ["reporting down", async () => Response.json({ status: "down" }, { status: 503 }), false],
    ["unreachable", async () => { throw new TypeError("fetch failed"); }, false],
  ])("is %s", async (_label, respond, up) => {
    const { calls, impl } = recorder(respond);
    expect((await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).health()).up).toBe(up);
    expect(calls[0].url).toBe(`${BASE}/health`);
  });
});

describe("countPdfPages", () => {
  it("counts page objects but not the page tree", () => {
    expect(countPdfPages(fakePdfBytes(3))).toBe(3);
  });

  it("falls back to the page tree count when page objects are compressed away", () => {
    const text = "%PDF-1.7\n1 0 obj << /Type /Pages /Kids [] /Count 4 >> endobj\n%%EOF";
    const bytes = new TextEncoder().encode(text);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    expect(countPdfPages(copy.buffer)).toBe(4);
  });
});
```

`tests/integration/gotenberg-smoke.test.ts`:

```ts
// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createGotenbergEngine, gotenbergForm, postHtmlToGotenberg } from "@/server/pdf/gotenberg";
import { DOCUMENT_CSP, renderPrescription } from "@/lib/rx-render/render";
import { PAPER } from "@/lib/rx-render/paper";
import { BUILTIN_TEMPLATES, PAPER_SIZES } from "@/lib/rx-render/types";
import { loadFontCss } from "@/server/rx-render/fonts";
import { DEVANAGARI, documentFixture, manyItems, snapshot, visit } from "../fixtures/rx-documents";

const baseUrl = process.env.GOTENBERG_URL ?? "http://localhost:3001";
const engine = createGotenbergEngine({ baseUrl, renderTimeoutMs: 60_000 });
const health = await engine.health();
const fonts = { logo: null, signature: null, fontCss: loadFontCss() };

describe.skipIf(!health.up)(`real Gotenberg at ${baseUrl} (skipped when it is not reachable)`, () => {
  it("renders 30 medicines with Devanagari on more A5 pages than A4 pages", async () => {
    const base = documentFixture({
      items: manyItems(30),
      snapshot: snapshot({ patient: { name: DEVANAGARI.name } }),
      visit: visit({ advice: DEVANAGARI.advice }),
    });
    const a4 = await engine.render(renderPrescription(base, fonts));
    const a5 = await engine.render(
      renderPrescription({ ...base, snapshot: { ...base.snapshot, layout: { ...base.snapshot.layout, paperSize: "A5" } } }, fonts),
    );
    if (!a4.ok || !a5.ok) throw new Error(`render failed: ${JSON.stringify([a4.ok || a4.code, a5.ok || a5.code])}`);
    expect(new TextDecoder("latin1").decode(new Uint8Array(a4.pdf).subarray(0, 5))).toBe("%PDF-");
    expect(a4.pageCount).toBeGreaterThanOrEqual(2);
    expect(a5.pageCount).toBeGreaterThan(a4.pageCount);
  });

  it("renders every template on both paper sizes", async () => {
    for (const key of BUILTIN_TEMPLATES) {
      for (const paperSize of PAPER_SIZES) {
        const doc = documentFixture({ layout: { template: { kind: "builtin", key }, paperSize, labels: "bilingual" } });
        const outcome = await engine.render(renderPrescription(doc, fonts));
        expect(outcome, `${key} ${paperSize}`).toMatchObject({ ok: true });
      }
    }
  });

  it("loads nothing from the network once the document CSP is present", async ({ skip }) => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const page = (withCsp: boolean) =>
      `<!doctype html><html><head><meta charset="utf-8">${withCsp ? `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">` : ""}</head><body><p>probe</p><img src="http://host.docker.internal:${port}/beacon.png"></body></html>`;
    const send = (markup: string) =>
      postHtmlToGotenberg(
        { baseUrl, renderTimeoutMs: 30_000 },
        gotenbergForm({ format: "html", html: markup, footerHtml: "<!doctype html><html><body></body></html>", paper: PAPER.A4, title: "probe" }),
      );
    try {
      // Control: without the CSP, Chromium in the container fetches the beacon. If it cannot
      // reach this machine at all (firewall, network), there is nothing to prove either way.
      expect((await send(page(false))).ok).toBe(true);
      if (hits === 0) skip();
      hits = 0;
      expect((await send(page(true))).ok).toBe(true);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/fonts.test.ts tests/unit/gotenberg.test.ts tests/integration/gotenberg-smoke.test.ts
```

Expected: FAIL — the font, engine, and Gotenberg modules cannot be resolved.

- [ ] **Step 5: Implement the font loader**

`src/server/rx-render/fonts.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

/** Resolved from the project root, which is the working directory for Next.js, Vitest, and Playwright. */
export const FONT_PACKAGE_DIR = path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-devanagari");

const WEIGHTS = ["400", "700"] as const;
let cached: string | null = null;

/**
 * Rewrites a Fontsource stylesheet so every WOFF2 file is a data: URI (no network, no file
 * access at render time) and drops the WOFF fallback. Throws if any file reference is left.
 */
export function inlineFontCss(css: string, packageDir: string): string {
  const withoutWoff = css.replace(/,\s*url\(\.\/files\/[A-Za-z0-9._-]+\.woff\)\s*format\(['"]woff['"]\)/g, "");
  const inlined = withoutWoff.replace(/url\(\.\/files\/([A-Za-z0-9._-]+\.woff2)\)/g, (_match, file: string) => {
    const data = readFileSync(path.join(packageDir, "files", file)).toString("base64");
    return `url(data:font/woff2;base64,${data})`;
  });
  if (inlined.includes("./files/")) throw new Error("Unexpected font stylesheet: a font file reference was not inlined");
  // block: print engines must never draw fallback glyphs first; data: URIs load immediately anyway.
  return inlined.replace(/font-display:\s*swap/g, "font-display: block").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** @font-face rules for Noto Sans Devanagari (Devanagari, Latin, Latin Extended; 400 and 700). */
export function loadFontCss(): string {
  if (cached !== null) return cached;
  cached = WEIGHTS.map((weight) => inlineFontCss(readFileSync(path.join(FONT_PACKAGE_DIR, `${weight}.css`), "utf8"), FONT_PACKAGE_DIR)).join("\n");
  return cached;
}
```

- [ ] **Step 6: Implement the engine contract and the Gotenberg client**

`src/server/pdf/engine.ts`:

```ts
import type { RenderedDocument } from "@/lib/rx-render/types";

export type PdfFailureCode = "pdf_unavailable" | "pdf_timeout" | "pdf_failed" | "pdf_too_large" | "pdf_refused";

export type PdfOutcome = { ok: true; pdf: ArrayBuffer; pageCount: number } | { ok: false; code: PdfFailureCode; message: string };

export type PdfHealth = { up: boolean; detail: string };

/** Turns a rendered document into a PDF. Injected so tests never need the real service. */
export interface PdfEngine {
  render(doc: RenderedDocument): Promise<PdfOutcome>;
  health(): Promise<PdfHealth>;
}

export const PDF_LIMITS = {
  maxHtmlBytes: 4 * 1024 * 1024,
  maxPdfBytes: 15 * 1024 * 1024,
  maxPages: 20,
  renderTimeoutMs: 20_000,
  healthTimeoutMs: 2_000,
} as const;

/** Shown to the user. No patient data, no internal detail. */
export const PDF_MESSAGES: Record<PdfFailureCode, string> = {
  pdf_unavailable: "The PDF service is not reachable right now. Use Print instead, or try again in a minute.",
  pdf_timeout: "The PDF took too long to generate. Try again, or use Print.",
  pdf_failed: "The PDF could not be generated. Try again, or use Print.",
  pdf_too_large: "This prescription is too long to turn into a PDF. Use Print instead.",
  pdf_refused: "This document cannot be sent to the PDF service. Use Print instead.",
};

/** Counts `/Type /Page` objects (not `/Pages`); falls back to the page tree's `/Count`. */
export function countPdfPages(pdf: ArrayBuffer): number {
  const text = new TextDecoder("latin1").decode(new Uint8Array(pdf));
  const pages = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  if (pages > 0) return pages;
  const tree = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/.exec(text);
  return tree ? Number(tree[1]) : 0;
}
```

`src/server/pdf/gotenberg.ts`:

```ts
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import type { RenderedDocument } from "@/lib/rx-render/types";
import { countPdfPages, PDF_LIMITS, PDF_MESSAGES, type PdfEngine, type PdfFailureCode, type PdfOutcome } from "./engine";

export type GotenbergOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  renderTimeoutMs?: number;
  healthTimeoutMs?: number;
  maxPdfBytes?: number;
  maxPages?: number;
};

const EMPTY_HEADER = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

const failure = (code: PdfFailureCode): PdfOutcome => ({ ok: false, code, message: PDF_MESSAGES[code] });
const trimSlash = (url: string) => url.replace(/\/+$/, "");
const inches = (mm: number) => (mm / 25.4).toFixed(3);

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function startsWithPdfMagic(pdf: ArrayBuffer): boolean {
  const head = new Uint8Array(pdf.slice(0, 5));
  return String.fromCharCode(...head) === "%PDF-";
}

/** Gotenberg Chromium form: index.html, an empty header, the page-number footer, paper and margins. */
export function gotenbergForm(doc: RenderedDocument): FormData {
  const form = new FormData();
  form.append("files", new Blob([doc.html], { type: "text/html" }), "index.html");
  form.append("files", new Blob([EMPTY_HEADER], { type: "text/html" }), "header.html");
  form.append("files", new Blob([doc.footerHtml], { type: "text/html" }), "footer.html");
  const { paper } = doc;
  form.append("paperWidth", String(paper.widthIn));
  form.append("paperHeight", String(paper.heightIn));
  form.append("marginTop", inches(paper.marginMm.top));
  form.append("marginBottom", inches(paper.marginMm.bottom));
  form.append("marginLeft", inches(paper.marginMm.left));
  form.append("marginRight", inches(paper.marginMm.right));
  form.append("preferCssPageSize", "true");
  form.append("printBackground", "true");
  form.append("emulatedMediaType", "print");
  form.append("failOnConsoleExceptions", "true");
  return form;
}

/** Posts a prepared form. Callers must have checked the document; createGotenbergEngine().render does. */
export async function postHtmlToGotenberg(options: GotenbergOptions, form: FormData): Promise<PdfOutcome> {
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxPdfBytes ?? PDF_LIMITS.maxPdfBytes;
  let response: Response;
  try {
    response = await fetchImpl(`${trimSlash(options.baseUrl)}/forms/chromium/convert/html`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(options.renderTimeoutMs ?? PDF_LIMITS.renderTimeoutMs),
    });
  } catch (error) {
    return failure(isTimeout(error) ? "pdf_timeout" : "pdf_unavailable");
  }
  if (response.status === 502 || response.status === 503) return failure("pdf_unavailable");
  if (!response.ok) return failure("pdf_failed");
  if (!(response.headers.get("content-type") ?? "").includes("application/pdf")) return failure("pdf_failed");
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) return failure("pdf_too_large");

  let pdf: ArrayBuffer;
  try {
    pdf = await response.arrayBuffer();
  } catch (error) {
    return failure(isTimeout(error) ? "pdf_timeout" : "pdf_failed");
  }
  if (pdf.byteLength > maxBytes) return failure("pdf_too_large");
  if (!startsWithPdfMagic(pdf)) return failure("pdf_failed");
  const pageCount = countPdfPages(pdf);
  if (pageCount < 1) return failure("pdf_failed");
  if (pageCount > (options.maxPages ?? PDF_LIMITS.maxPages)) return failure("pdf_too_large");
  return { ok: true, pdf, pageCount };
}

/**
 * PDF engine backed by Gotenberg's Chromium route (ADR-0007). Refuses any document that is
 * not self-contained before it leaves the process, so the renderer cannot make Chromium fetch.
 */
export function createGotenbergEngine(options: GotenbergOptions): PdfEngine {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async render(doc) {
      for (const part of [doc.html, doc.footerHtml]) {
        if (!checkSelfContained(part).ok) return failure("pdf_refused");
      }
      if (new TextEncoder().encode(doc.html).byteLength > PDF_LIMITS.maxHtmlBytes) return failure("pdf_too_large");
      return postHtmlToGotenberg(options, gotenbergForm(doc));
    },
    async health() {
      try {
        const response = await fetchImpl(`${trimSlash(options.baseUrl)}/health`, {
          signal: AbortSignal.timeout(options.healthTimeoutMs ?? PDF_LIMITS.healthTimeoutMs),
        });
        if (!response.ok) return { up: false, detail: `status ${response.status}` };
        const body = (await response.json()) as { status?: unknown };
        return body.status === "up" ? { up: true, detail: "up" } : { up: false, detail: "reported down" };
      } catch {
        return { up: false, detail: "unreachable" };
      }
    },
  };
}
```

`src/server/pdf/index.ts`:

```ts
import type { PdfEngine } from "./engine";
import { createGotenbergEngine } from "./gotenberg";

let engine: PdfEngine | null = null;

/** The process-wide PDF engine, configured from GOTENBERG_URL (default http://localhost:3001). */
export function getPdfEngine(): PdfEngine {
  if (engine === null) engine = createGotenbergEngine({ baseUrl: process.env.GOTENBERG_URL ?? "http://localhost:3001" });
  return engine;
}
```

- [ ] **Step 7: Add Gotenberg to local dev, CI, and the web build**

In `docker-compose.yml`, add this service under `services:`, after the `postgres` service and before the top-level `volumes:` block:

```yaml
  gotenberg:
    # Pinned. Upgrades need the visual check in docs/SETUP.md (npm run test:visual).
    image: gotenberg/gotenberg:8.11.0
    container_name: clinicpad-gotenberg
    command:
      - gotenberg
      - --api-timeout=30s
      - --chromium-disable-javascript=true
      - --log-level=warn
    ports:
      - "3001:3000"
    extra_hosts:
      # Lets the smoke test's network-isolation probe reach the host on Linux too.
      - "host.docker.internal:host-gateway"
    security_opt:
      - no-new-privileges:true
    mem_limit: 1g
    healthcheck:
      test: ["CMD", "curl", "--silent", "--fail", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 10
```

If `docker compose pull gotenberg` reports that the tag does not exist, use the newest `8.x.y` tag listed at hub.docker.com/r/gotenberg/gotenberg that is at least two weeks old, in both this file and the CI step below, and keep the flags.

In `.github/workflows/ci.yml`, add `GOTENBERG_URL: http://localhost:3001` to the job's `env:` block, and add these two steps directly before `- run: npm run test`:

```yaml
      - run: docker run -d --name gotenberg -p 3001:3000 --add-host=host.docker.internal:host-gateway gotenberg/gotenberg:8.11.0 gotenberg --api-timeout=30s --chromium-disable-javascript=true --log-level=warn
      - run: for i in $(seq 1 30); do curl -sf http://localhost:3001/health && break; sleep 2; done
```

In `.env.example`, replace the line `GOTENBERG_URL=http://localhost:3001` and the heading comment above it so the block reads:

```
# ---------------------------------------------------------------------------
# Document engine (Phase 1C: prescription PDFs). `docker compose up -d gotenberg`.
# Storage and scanning (Phase 2)
# ---------------------------------------------------------------------------
GOTENBERG_URL=http://localhost:3001
```

(keep the `S3_*` and `CLAMAV_*` lines that follow).

In `next.config.ts`, the spread ends with `    : {}),`. Replace that line with:

```ts
    : {
        // Route handlers read the embedded prescription fonts from node_modules at runtime.
        outputFileTracingIncludes: {
          "/prescriptions/**": ["./node_modules/@fontsource/noto-sans-devanagari/**/*"],
        },
      }),
```

so the web build ships the font files with the server bundle (the desktop export has no server).

- [ ] **Step 8: Run the tests with and without Gotenberg**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/fonts.test.ts tests/unit/gotenberg.test.ts tests/integration/gotenberg-smoke.test.ts
Set-Location E:\projects\clinicpad; docker compose up -d gotenberg
Set-Location E:\projects\clinicpad; docker compose ps gotenberg
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/gotenberg-smoke.test.ts
```

If `docker compose` reports that the engine is not running, start Docker Desktop from `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe` (its location on this machine), wait for it, and repeat.

Expected: the first run passes the unit tests (`fonts.test.ts` 4, `gotenberg.test.ts` 16) and reports the smoke suite (3 tests) as **skipped** (Gotenberg not started yet). After `docker compose up -d gotenberg` and `ps` showing `healthy`, the smoke suite passes (or the network-probe test is reported skipped, with the other two passing, if this machine's firewall blocks the container from reaching it). Troubleshooting:
- `@font-face` count below 6: the Fontsource layout changed; read `400.css` and adjust `inlineFontCss`'s regexes so the test passes, never the test.
- The A5 page count is not higher than A4: the `@page` size is being ignored; confirm `preferCssPageSize=true` reaches Gotenberg (`docker compose logs gotenberg`).
- A `pdf_failed` from the real service with JavaScript disabled: Gotenberg 8 rejects unknown form fields in some versions; remove `failOnConsoleExceptions` from `gotenbergForm` and its unit-test expectation only if the logs name that field.

- [ ] **Step 9: Full suite, build, and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; node scripts/verify-build-config.mjs; if ($?) { npm run build:web }
Set-Location E:\projects\clinicpad; git add package.json package-lock.json next.config.ts docker-compose.yml .github/workflows/ci.yml .env.example src/server/rx-render/fonts.ts src/server/pdf/engine.ts src/server/pdf/gotenberg.ts src/server/pdf/index.ts tests/helpers/fake-pdf-engine.ts tests/unit/fonts.test.ts tests/unit/gotenberg.test.ts tests/integration/gotenberg-smoke.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: add embedded Devanagari fonts and a Gotenberg PDF engine with limits and health check" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: the build-config check prints only `PASS` lines and `build:web` exits 0.

---

## Task 9: Print and PDF service, routes, and the output log

**Files:**
- Create: `src/server/services/rx-output.ts`, `src/app/(app)/prescriptions/[id]/document/route.ts`, `src/app/(app)/prescriptions/[id]/pdf/route.ts`, `src/app/api/health/pdf/route.ts`
- Modify: `src/lib/result.ts`, `src/middleware.ts`
- Test: `tests/integration/rx-output-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 `prescriptionOutputs`; Task 2 `checkSelfContained`, `escapeHtml`; Task 3 `pdfFileName`; Task 4 `renderPrescription`, `DOCUMENT_CSP`; Task 5 `loadRxDocument`, `RxDocumentBundle`; Task 8 `PdfEngine`, `getPdfEngine`, `loadFontCss`, `sharedFakeEngine`, `resetFakeEngine`; `recordAudit`, `withTenant`, `can`, `isUuid`, `ok`/`fail`; `getSessionContext()` (`src/server/auth/session.ts`, returns `null` instead of redirecting); the route-handler error pattern of `src/app/api/catalogue/search/route.ts` (typed JSON 500, `private, no-store`, error class only in the log).
- Produces:
  - `ErrorCode` gains `"unavailable"`.
  - `rx-output.ts`: `type DocumentPurpose = "preview" | "print"`; `type OutputKind = "pdf_download" | "browser_print"`; `type OutputSummary = { count: number; lastAt: Date | null }`; `DRAFT_OUTPUT_MESSAGE`; `htmlSha256(html: string): string`; `renderPrescriptionHtml(ctx, id, purpose): Promise<Result<{ html: string; title: string }>>` (print of a draft → `conflict`; print records `browser_print` + audit `prescription.printed`); `renderPrescriptionPdf(ctx, id, engine?: PdfEngine): Promise<Result<{ pdf: ArrayBuffer; fileName: string; pageCount: number }>>` (draft → `conflict`; engine down/slow/failed → `unavailable`; too large/refused → `invalid`; success records `pdf_download` + audit `prescription.pdf_downloaded`); `listPrescriptionOutputs(ctx, id): Promise<Result<OutputSummary>>`.
  - `GET /prescriptions/[id]/document?purpose=preview|print` → `200 text/html` (CSP header, `no-store`), error pages with `<body data-rx="error">` (500 for an unexpected failure), `303 /login` without a session.
  - `GET /prescriptions/[id]/pdf` → `200 application/pdf` with `Content-Disposition: attachment; filename="Rx-<n>-v<v>.pdf"`; JSON `{ error, message }` with 401/403/404/409/422/503, and `{ error: "internal", message }` with 500 for an unexpected failure.
  - `GET /api/health/pdf` → `200 { status: "up" }` or `503 { status: "down" }`.
  - Audit payloads: `{ outputId, version, template, paperSize, pageCount }`.

- [ ] **Step 1: Write the failing test**

`tests/integration/rx-output-routes.test.ts`:

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
import { withTenant } from "@/server/db/tenant";
import { auditEvents, clinics, doctors, prescriptionOutputs } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { amendPrescription, finalizePrescription, saveDraft, startPrescription } from "@/server/services/prescriptions";
import { listPrescriptionOutputs } from "@/server/services/rx-output";
import { GET as getDocument } from "@/app/(app)/prescriptions/[id]/document/route";
import { GET as getPdf } from "@/app/(app)/prescriptions/[id]/pdf/route";
import { GET as getPdfHealth } from "@/app/api/health/pdf/route";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { newId } from "@/lib/domain/ids";
import { resetFakeEngine, sharedFakeEngine } from "../helpers/fake-pdf-engine";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
const PATIENT = "Route <b>Patient</b> आशा";
let A: TestTenant;
let B: TestTenant;
let finalizedId = "";
let draftId = "";
let supersededId = "";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const pdf = (id: string) => getPdf(new Request(`http://localhost/prescriptions/${id}/pdf`), params(id));
const documentFor = (id: string, purpose?: string) =>
  getDocument(new Request(`http://localhost/prescriptions/${id}/document${purpose ? `?purpose=${purpose}` : ""}`), params(id));

async function draft(patientId: string): Promise<string> {
  const started = await startPrescription(A.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraft(A.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Route Drug", doseMorning: 1 }] });
  if (!saved.ok) throw new Error(saved.message);
  return started.value.prescriptionId;
}

async function finalized(patientId: string): Promise<string> {
  const id = await draft(patientId);
  const done = await finalizePrescription(A.as("doctor"), id);
  if (!done.ok) throw new Error(done.message);
  return id;
}

const outputsFor = (id: string) =>
  adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.prescriptionId, id));
const auditFor = (id: string, action: string) =>
  withTenant(A.tenantId, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, action))));

beforeAll(async () => {
  A = await createTestTenant("outa");
  B = await createTestTenant("outb");
  await adminDb.insert(clinics).values({ tenantId: A.tenantId, name: "Output Clinic" });
  await adminDb.update(doctors).set({ displayName: "Dr Output", regNo: "OUT-1" }).where(eq(doctors.tenantId, A.tenantId));
  const created = await createPatient(A.as("reception"), { name: PATIENT });
  if (!created.ok) throw new Error(created.message);
  finalizedId = await finalized(created.value.id);
  draftId = await draft(created.value.id);
  supersededId = await finalized(created.value.id);
  const amended = await amendPrescription(A.as("doctor"), { prescriptionId: supersededId, reason: "Wrong dose" });
  if (!amended.ok) throw new Error(amended.message);
  const done = await finalizePrescription(A.as("doctor"), amended.value.prescriptionId);
  if (!done.ok) throw new Error(done.message);
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(A.as("doctor"));
  resetFakeEngine(sharedFakeEngine);
});

describe("GET /prescriptions/[id]/pdf", () => {
  it("returns the PDF, logs the output, and audits ids and counts only", async () => {
    const res = await pdf(finalizedId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Rx-\d+-v1\.pdf"$/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

    expect(sharedFakeEngine.calls).toHaveLength(1);
    expect(sharedFakeEngine.calls[0].html).toContain("Route &lt;b&gt;Patient&lt;/b&gt;");
    expect(checkSelfContained(sharedFakeEngine.calls[0].html)).toEqual({ ok: true });

    const outputs = await outputsFor(finalizedId);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ kind: "pdf_download", pageCount: 2, templateKey: "general", paperSize: "A4" });
    expect(outputs[0].htmlSha256).toMatch(/^[0-9a-f]{64}$/);

    const events = await auditFor(finalizedId, "prescription.pdf_downloaded");
    expect(events).toHaveLength(1);
    expect(events[0].after).toEqual({ outputId: outputs[0].id, version: 1, template: "general", paperSize: "A4", pageCount: 2 });
    expect(JSON.stringify(events[0])).not.toContain("Route");
    expect(JSON.stringify(events[0])).not.toContain("Route Drug");
  });

  it.each(["owner", "reception", "nurse", "pharmacist"])("lets %s download", async (role) => {
    session.mockResolvedValue(A.as(role));
    expect((await pdf(finalizedId)).status).toBe(200);
  });

  it("answers 401 without a session, 403 for accountants, and 404 for malformed, unknown, and other-clinic ids", async () => {
    session.mockResolvedValue(null);
    expect(await (await pdf(finalizedId)).json()).toEqual({ error: "unauthenticated", message: "Sign in again to download this prescription." });
    session.mockResolvedValue(A.as("accountant"));
    expect((await pdf(finalizedId)).status).toBe(403);
    session.mockResolvedValue(A.as("doctor"));
    expect((await pdf("not-a-uuid")).status).toBe(404);
    expect((await pdf(newId())).status).toBe(404);
    session.mockResolvedValue(B.as("doctor"));
    expect((await pdf(finalizedId)).status).toBe(404);
    expect(sharedFakeEngine.calls).toHaveLength(0);
  });

  it("refuses drafts with 409 and never calls the engine", async () => {
    const res = await pdf(draftId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", message: "Finalize this prescription before printing or downloading it." });
    expect(sharedFakeEngine.calls).toHaveLength(0);
    expect(await outputsFor(draftId)).toHaveLength(0);
  });

  it("answers 503 with a clear message when the PDF service is down, and logs nothing", async () => {
    const before = (await outputsFor(finalizedId)).length;
    sharedFakeEngine.failWith = "pdf_unavailable";
    const res = await pdf(finalizedId);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable", message: expect.stringMatching(/not reachable/) });
    expect(await outputsFor(finalizedId)).toHaveLength(before);
  });

  it("answers 422 when the document is too long for a PDF", async () => {
    sharedFakeEngine.failWith = "pdf_too_large";
    expect((await pdf(finalizedId)).status).toBe(422);
  });

  it("answers a typed 500 that leaks nothing when something unexpected throws, and logs no output", async () => {
    const before = (await outputsFor(finalizedId)).length;
    const render = vi.spyOn(sharedFakeEngine, "render").mockRejectedValueOnce(new Error("boom for Route Patient"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await pdf(finalizedId);
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ error: "internal", message: "The PDF could not be generated. Try again, or use Print." });
      expect(JSON.stringify(logged.mock.calls)).not.toContain("Route Patient");
      expect(await outputsFor(finalizedId)).toHaveLength(before);
    } finally {
      render.mockRestore();
      logged.mockRestore();
    }
  });
});

describe("GET /prescriptions/[id]/document", () => {
  it("previews a draft with a watermark, a strict CSP, and no output log", async () => {
    const res = await documentFor(draftId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    const markup = await res.text();
    expect(markup).toContain("DRAFT · NOT VALID FOR DISPENSING");
    expect(markup).toContain('data-rx="ready"');
    expect(await outputsFor(draftId)).toHaveLength(0);
  });

  it("refuses to print a draft", async () => {
    const res = await documentFor(draftId, "print");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('data-rx="error"');
  });

  it("logs and audits a print, and prints byte-identical HTML every time", async () => {
    const first = await (await documentFor(finalizedId, "print")).text();
    const second = await (await documentFor(finalizedId, "print")).text();
    expect(second).toBe(first);
    const prints = (await outputsFor(finalizedId)).filter((o) => o.kind === "browser_print");
    expect(prints).toHaveLength(2);
    expect(prints[0].htmlSha256).toBe(prints[1].htmlSha256);
    expect(prints[0].pageCount).toBeNull();
    expect(await auditFor(finalizedId, "prescription.printed")).toHaveLength(2);

    const summary = await listPrescriptionOutputs(A.as("reception"), finalizedId);
    expect(summary.ok && summary.value.count).toBeGreaterThanOrEqual(2);
    expect(summary.ok && summary.value.lastAt instanceof Date).toBe(true);
  });

  it("marks a superseded version", async () => {
    expect(await (await documentFor(supersededId, "print")).text()).toContain("SUPERSEDED by version 2");
  });

  it("sends a signed-out user to the login page and hides other clinics' prescriptions", async () => {
    session.mockResolvedValue(null);
    const res = await documentFor(finalizedId, "print");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/login");
    session.mockResolvedValue(B.as("owner"));
    const hidden = await documentFor(finalizedId);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain("Route");
  });
});

describe("GET /api/health/pdf", () => {
  it("reports the PDF service state without detail", async () => {
    const up = await getPdfHealth();
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ status: "up", service: "pdf" });
    sharedFakeEngine.up = false;
    const down = await getPdfHealth();
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ status: "down", service: "pdf" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/rx-output-routes.test.ts
```

Expected: FAIL — the route modules cannot be resolved.

- [ ] **Step 3: Add the error code**

In `src/lib/result.ts`, change the `ErrorCode` line to:

```ts
export type ErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "immutable" | "unavailable";
```

- [ ] **Step 4: Implement the output service**

`src/server/services/rx-output.ts`:

```ts
import { createHash } from "node:crypto";
import { count, eq, max } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { renderPrescription } from "@/lib/rx-render/render";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { pdfFileName } from "@/lib/rx-render/format";
import type { RenderedDocument } from "@/lib/rx-render/types";
import { prescriptionOutputs } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { getPdfEngine } from "@/server/pdf";
import type { PdfEngine } from "@/server/pdf/engine";
import { loadFontCss } from "@/server/rx-render/fonts";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";
import { loadRxDocument, type RxDocumentBundle } from "./rx-documents";

export type DocumentPurpose = "preview" | "print";
export type OutputKind = "pdf_download" | "browser_print";
export type OutputSummary = { count: number; lastAt: Date | null };

export const DRAFT_OUTPUT_MESSAGE = "Finalize this prescription before printing or downloading it.";

export function htmlSha256(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

function render(bundle: RxDocumentBundle): RenderedDocument {
  const rendered = renderPrescription(bundle.document, { logo: bundle.logo, signature: bundle.signature, fontCss: loadFontCss() });
  for (const part of [rendered.html, rendered.footerHtml]) {
    const check = checkSelfContained(part);
    // The renderer only emits embedded content, so this is a programming error, never user error.
    if (!check.ok) throw new Error(`Rendered prescription is not self-contained: ${check.reason}`);
  }
  return rendered;
}

/** One output row plus its audit event, in one transaction, after the output exists. */
async function recordOutput(
  ctx: ServiceContext,
  bundle: RxDocumentBundle,
  rendered: RenderedDocument,
  kind: OutputKind,
  pdf: { pageCount: number; byteSize: number } | null,
): Promise<void> {
  const template = bundle.document.snapshot.layout.template.key;
  await withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(prescriptionOutputs)
      .values({
        tenantId: ctx.tenantId,
        prescriptionId: bundle.prescriptionId,
        actorUserId: ctx.userId,
        kind,
        templateKey: template,
        paperSize: rendered.paper.size,
        pageCount: pdf?.pageCount ?? null,
        byteSize: pdf?.byteSize ?? null,
        htmlSha256: htmlSha256(rendered.html),
      })
      .returning({ id: prescriptionOutputs.id });
    await recordAudit(tx, ctx, {
      action: kind === "pdf_download" ? "prescription.pdf_downloaded" : "prescription.printed",
      entityType: "prescription",
      entityId: bundle.prescriptionId,
      after: { outputId: row.id, version: bundle.document.version, template, paperSize: rendered.paper.size, pageCount: pdf?.pageCount ?? null },
    });
  });
}

/** The pad as HTML: a preview (any status, not logged) or a print (finalized only, logged and audited). */
export async function renderPrescriptionHtml(
  ctx: ServiceContext,
  id: string,
  purpose: DocumentPurpose,
): Promise<Result<{ html: string; title: string }>> {
  const loaded = await loadRxDocument(ctx, id);
  if (!loaded.ok) return loaded;
  if (purpose === "print" && loaded.value.document.status === "draft") return fail("conflict", DRAFT_OUTPUT_MESSAGE);
  const rendered = render(loaded.value);
  if (purpose === "print") await recordOutput(ctx, loaded.value, rendered, "browser_print", null);
  return ok({ html: rendered.html, title: rendered.title });
}

/** The pad as a PDF from the PDF engine. Nothing is logged unless a PDF was actually produced. */
export async function renderPrescriptionPdf(
  ctx: ServiceContext,
  id: string,
  engine: PdfEngine = getPdfEngine(),
): Promise<Result<{ pdf: ArrayBuffer; fileName: string; pageCount: number }>> {
  const loaded = await loadRxDocument(ctx, id);
  if (!loaded.ok) return loaded;
  const { document } = loaded.value;
  if (document.status === "draft") return fail("conflict", DRAFT_OUTPUT_MESSAGE);
  const rendered = render(loaded.value);
  const outcome = await engine.render(rendered);
  if (!outcome.ok) {
    // Code only: never log patient data.
    console.warn(`[pdf] prescription PDF failed: ${outcome.code}`);
    const userFixable = outcome.code === "pdf_too_large" || outcome.code === "pdf_refused";
    return fail(userFixable ? "invalid" : "unavailable", outcome.message);
  }
  await recordOutput(ctx, loaded.value, rendered, "pdf_download", { pageCount: outcome.pageCount, byteSize: outcome.pdf.byteLength });
  return ok({ pdf: outcome.pdf, fileName: pdfFileName(document), pageCount: outcome.pageCount });
}

export async function listPrescriptionOutputs(ctx: ServiceContext, id: string): Promise<Result<OutputSummary>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return fail("not_found", "Prescription not found.");
  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ count: count(), lastAt: max(prescriptionOutputs.createdAt) })
      .from(prescriptionOutputs)
      .where(eq(prescriptionOutputs.prescriptionId, id));
    return ok({ count: row?.count ?? 0, lastAt: row?.lastAt ?? null });
  });
}
```

- [ ] **Step 5: Implement the routes and the middleware entry**

`src/app/(app)/prescriptions/[id]/document/route.ts`:

```ts
import { getSessionContext } from "@/server/auth/session";
import { renderPrescriptionHtml } from "@/server/services/rx-output";
import { DOCUMENT_CSP } from "@/lib/rx-render/render";
import { escapeHtml } from "@/lib/rx-render/html";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, conflict: 409, invalid: 422, unavailable: 503 };
const INTERNAL_MESSAGE = "The prescription could not be prepared. Reload the page and try again.";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `${DOCUMENT_CSP}; frame-ancestors 'self'`,
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** data-rx="error" lets the print iframe tell an error page from a pad. */
function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Prescription unavailable</title></head><body data-rx="error"><p>${escapeHtml(message)}</p></body></html>`;
}

/** The pad as HTML, for the preview tab and the print iframe. ?purpose=print logs a print. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await getSessionContext();
    if (!session) return Response.redirect(new URL("/login", request.url), 303);
    const { id } = await params;
    const purpose = new URL(request.url).searchParams.get("purpose") === "print" ? "print" : "preview";
    const result = await renderPrescriptionHtml(session, id, purpose);
    if (!result.ok) return new Response(errorPage(result.message), { status: STATUS[result.code] ?? 500, headers: HEADERS });
    return new Response(result.value.html, { status: 200, headers: HEADERS });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("prescription document failed", error instanceof Error ? error.name : typeof error);
    return new Response(errorPage(INTERNAL_MESSAGE), { status: 500, headers: HEADERS });
  }
}
```

`src/app/(app)/prescriptions/[id]/pdf/route.ts`:

```ts
import { getSessionContext } from "@/server/auth/session";
import { renderPrescriptionPdf } from "@/server/services/rx-output";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Record<string, number> = { forbidden: 403, not_found: 404, conflict: 409, invalid: 422, unavailable: 503 };
const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const INTERNAL = { error: "internal", message: "The PDF could not be generated. Try again, or use Print." };

/** The pad as a PDF download. Errors are JSON for the Download button to show. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await getSessionContext();
    if (!session) {
      return Response.json(
        { error: "unauthenticated", message: "Sign in again to download this prescription." },
        { status: 401, headers: NO_STORE },
      );
    }
    const { id } = await params;
    const result = await renderPrescriptionPdf(session, id);
    if (!result.ok) {
      return Response.json({ error: result.code, message: result.message }, { status: STATUS[result.code] ?? 500, headers: NO_STORE });
    }
    return new Response(result.value.pdf, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${result.value.fileName}"`,
        "Content-Length": String(result.value.pdf.byteLength),
      },
    });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("prescription pdf failed", error instanceof Error ? error.name : typeof error);
    return Response.json(INTERNAL, { status: 500, headers: NO_STORE });
  }
}
```

`src/app/api/health/pdf/route.ts`:

```ts
import { getPdfEngine } from "@/server/pdf";

export const dynamic = "force-dynamic";

/** Is the PDF service reachable? No detail, no auth needed, no patient data. */
export async function GET(): Promise<Response> {
  const health = await getPdfEngine().health();
  return Response.json(
    { status: health.up ? "up" : "down", service: "pdf" },
    { status: health.up ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
```

In `src/middleware.ts`, change the matcher to (a Plan 1A follow-up; the middleware's `authorized` callback sends a signed-out request to `/login`):

```ts
export const config = {
  matcher: ["/dashboard/:path*", "/patients/:path*", "/prescriptions/:path*", "/settings/:path*"],
};
```

A signed-out `fetch` of `/prescriptions/<id>/pdf` from the browser therefore follows a redirect to the login page (HTML), which `OutputActions` (Task 10) reports as "Your session ended"; the route's own 401 JSON covers callers that bypass the middleware (tests, an expired JWT that the middleware still accepts but `getSessionContext` rejects because the membership was removed).

The new routes live under `src/app/(app)/` and `src/app/api/health/`, both already in `SERVER_ONLY` in `scripts/build-desktop.mjs`, so the desktop export needs no change (Task 11 verifies it).

- [ ] **Step 6: Run the tests and typecheck**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/rx-output-routes.test.ts
Set-Location E:\projects\clinicpad; npm run typecheck
```

Expected: all PASS (`rx-output-routes.test.ts`: 16 tests); typecheck exits 0. Troubleshooting:
- The PDF test sees `fake.calls` from a previous test: `resetFakeEngine` must run in `beforeEach` (it does) and `vi.mock("@/server/pdf")` must return `sharedFakeEngine` itself, not a copy.
- `getPdf` typechecks but returns 500: `new Response(ArrayBuffer)` is valid; if TypeScript rejects `result.value.pdf` as a body, the type is not `ArrayBuffer` — keep `PdfOutcome.pdf` an `ArrayBuffer`, never a `Uint8Array`.
- `Response.redirect` throws "invalid URL": it needs an absolute URL; `new URL("/login", request.url)` provides one.
- The 503 test finds a new output row: `recordOutput` must run only after `engine.render` succeeded.

- [ ] **Step 7: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/result.ts src/middleware.ts src/server/services/rx-output.ts "src/app/(app)/prescriptions/[id]/document/route.ts" "src/app/(app)/prescriptions/[id]/pdf/route.ts" src/app/api/health/pdf/route.ts tests/integration/rx-output-routes.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: add audited print and PDF routes with an append-only output log" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 10: Print, download, and preview on the prescription page

**Files:**
- Create: `src/components/rx/output-actions.tsx`, `src/components/rx/rx-output-panel.tsx`, `tests/e2e/rx-output.spec.ts`
- Modify: `src/app/(app)/prescriptions/[id]/page.tsx` (full replacement of the current page, keeping everything it does today), `tests/unit/prescription-page.test.tsx` (new mocks, the eight existing tests unchanged, seven new tests)
- Test: `tests/unit/prescription-page.test.tsx`, `tests/e2e/rx-output.spec.ts`

**Interfaces:**
- Consumes: Task 3 `pdfFileName`; Task 5 `loadRxDocument`, `getVersionLinks`, `VersionRef`; Task 6 `getPadReadiness`, `ProfileGap`; Task 9 routes and `listPrescriptionOutputs`, `OutputSummary`; the current page's building blocks: `requireSession`, `can`, `getPrescription` (with its `conflict` refresh state), `listFavourites`, `amendAction`/`repeatAction`/`discardDraftAction` (`src/server/actions/prescriptions.ts`), `AllergyBanner` (`src/components/patients/allergy-banner.tsx`), `AmendForm`, `RepeatForm`, `DiscardDraftForm`, `ClinicalEditor` (props `prescriptionId`, `visit`, `items`, `revision`, `favourites`, `canAddToClinic`, `canFinalize`), `PrescriptionReadOnly`; e2e helpers `registerClinic`, `cleanupClinic`, `setRole`, `ensureCatalogue`, `waitForEditor`.
- Produces:
  - `<OutputActions prescriptionId fileName />` (client): buttons "Print" (hidden same-origin iframe titled "Prescription print frame", then `print()`) and "Download PDF" (fetch, checks `application/pdf`, saves as `fileName`); errors in a `role="alert"` paragraph.
  - `<RxOutputPanel ... />` (server component) with `type PrintGap = "doctorName" | "registrationNo"`: "Superseded by version N" notice with a link, "Replaces version N", the read-only draft notice ("This draft is not a prescription yet …") for viewers who cannot edit it, the profile warning before finalizing ("Your doctor profile is missing …" with the link "Complete your profile", or "You have no doctor profile in this clinic …"), the "This copy prints without …" notice for a finalized copy, "Preview pad" for drafts (new tab), output actions and the summary line ("Not printed or downloaded yet." / "Printed or downloaded N time(s), last on …") for finalized and amended versions.
  - Page rules: the header shows the patient name frozen at finalize for a version with a finalize snapshot, plus "(now recorded as …)" when the patient was renamed since; the `AllergyBanner` stays live; Amend and Repeat stay offered only when `status === "finalized"`; the conflict refresh state, the not-found mapping, `DiscardDraftForm`, and `canFinalize` are unchanged.

- [ ] **Step 1: Write the failing tests**

Replace `tests/unit/prescription-page.test.tsx` with the version below. The first eight tests are the current ones, unchanged; the mocks gain the three services the page now calls, and seven tests cover the new notices.

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getPrescription: vi.fn(),
  getVersionLinks: vi.fn(),
  loadRxDocument: vi.fn(),
  listPrescriptionOutputs: vi.fn(),
  getPadReadiness: vi.fn(),
  notFound: vi.fn(),
  session: { tenantId: "t", userId: "u", role: "doctor" },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    mocks.notFound();
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => mocks.session,
}));
vi.mock("@/server/services/prescriptions", () => ({ getPrescription: mocks.getPrescription }));
vi.mock("@/server/services/catalogue", () => ({ listFavourites: vi.fn() }));
vi.mock("@/server/services/rx-documents", () => ({
  getVersionLinks: mocks.getVersionLinks,
  loadRxDocument: mocks.loadRxDocument,
}));
vi.mock("@/server/services/rx-output", () => ({ listPrescriptionOutputs: mocks.listPrescriptionOutputs }));
vi.mock("@/server/services/pad-settings", () => ({ getPadReadiness: mocks.getPadReadiness }));
vi.mock("@/server/actions/prescriptions", () => ({
  amendAction: vi.fn(),
  repeatAction: vi.fn(),
  discardDraftAction: vi.fn(),
}));
vi.mock("@/components/rx/clinical-editor", () => ({ ClinicalEditor: () => <div>editor</div> }));
vi.mock("@/components/rx/prescription-view", () => ({ PrescriptionReadOnly: () => <div>read-only</div> }));
vi.mock("@/components/rx/discard-draft-form", () => ({
  DiscardDraftForm: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

import PrescriptionPage from "@/app/(app)/prescriptions/[id]/page";

const ID = "00000000-0000-4000-8000-000000000001";
const params = Promise.resolve({ id: ID });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.role = "doctor";
  mocks.getVersionLinks.mockResolvedValue({ ok: true, value: { supersededBy: null, replaces: null } });
  mocks.loadRxDocument.mockResolvedValue({ ok: false, code: "not_found", message: "x" });
  mocks.listPrescriptionOutputs.mockResolvedValue({ ok: true, value: { count: 0, lastAt: null } });
  mocks.getPadReadiness.mockResolvedValue({ ok: true, value: { missing: [] } });
});

function draftView(parentPrescriptionId: string | null) {
  return {
    ok: true,
    value: {
      id: ID,
      status: "draft",
      version: parentPrescriptionId ? 2 : 1,
      revision: 0,
      rxNo: null,
      amendmentReason: null,
      parentPrescriptionId,
      patient: { id: "p1", name: "Pat", patientNo: 1, allergies: [] },
      visit: {},
      items: [],
    },
  };
}

function finalizedView(status: "finalized" | "amended") {
  return {
    ok: true,
    value: {
      id: ID,
      status,
      version: 1,
      revision: 3,
      rxNo: 7,
      amendmentReason: null,
      parentPrescriptionId: null,
      finalizedAt: new Date("2026-11-12T05:30:00.000Z"),
      patient: { id: "p1", name: "Live Name", patientNo: 1, allergies: ["Penicillin"] },
      visit: {},
      items: [],
    },
  };
}

/** The parts of a loadRxDocument result the page reads. */
function printable(overrides: { patientName?: string; registrationNo?: string | null } = {}) {
  return {
    ok: true,
    value: {
      prescriptionId: ID,
      logo: null,
      signature: null,
      document: {
        snapshotSource: "finalize",
        snapshot: {
          patient: { name: overrides.patientName ?? "Live Name" },
          doctor: { name: "Dr Shah", registrationNo: overrides.registrationNo === undefined ? "MMC-1" : overrides.registrationNo },
          clinic: { timezone: "Asia/Kolkata" },
        },
      },
    },
  };
}

describe("prescription page discard control", () => {
  it("offers Discard draft to a doctor and Withdraw amendment on an amendment draft", async () => {
    mocks.getPrescription.mockResolvedValue(draftView(null));
    const first = render(await PrescriptionPage({ params }));
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeInTheDocument();
    first.unmount();

    mocks.getPrescription.mockResolvedValue(draftView("00000000-0000-4000-8000-000000000009"));
    render(await PrescriptionPage({ params }));
    expect(screen.getByRole("button", { name: "Withdraw amendment" })).toBeInTheDocument();
  });

  it.each(["reception", "nurse", "pharmacist", "accountant"])("shows %s no discard control and no editor", async (role) => {
    mocks.session.role = role;
    mocks.getPrescription.mockResolvedValue(draftView(null));
    render(await PrescriptionPage({ params }));
    expect(screen.queryByRole("button", { name: /discard|withdraw/i })).toBeNull();
    expect(screen.queryByText("editor")).toBeNull();
    expect(screen.getByText("read-only")).toBeInTheDocument();
  });
});

describe("prescription page failed reads", () => {
  it("shows a refresh state (full reload link) for a read conflict, not not-found", async () => {
    mocks.getPrescription.mockResolvedValue({ ok: false, code: "conflict", message: "busy" });
    render(await PrescriptionPage({ params }));
    expect(screen.getByText("This prescription changed while loading.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /refresh/i });
    expect(link).toHaveAttribute("href", `/prescriptions/${ID}`);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it.each(["not_found", "forbidden"])("maps %s to not-found", async (code) => {
    mocks.getPrescription.mockResolvedValue({ ok: false, code, message: "x" });
    await expect(PrescriptionPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("prescription page print panel and notices", () => {
  it("offers print and download on a finalized version and shows the name it was finalized with", async () => {
    mocks.getPrescription.mockResolvedValue(finalizedView("finalized"));
    mocks.loadRxDocument.mockResolvedValue(printable({ patientName: "Frozen Name" }));
    render(await PrescriptionPage({ params }));
    expect(screen.getByRole("link", { name: "Frozen Name" })).toHaveAttribute("href", "/patients/p1");
    expect(screen.getByText(/now recorded as Live Name/)).toBeInTheDocument();
    // The allergy banner is a live safety prompt, not part of the frozen record.
    expect(screen.getByText("Allergies: Penicillin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
    expect(screen.getByText("Not printed or downloaded yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /repeat as new prescription/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start amendment/i })).toBeInTheDocument();
    expect(mocks.loadRxDocument).toHaveBeenCalledWith(mocks.session, ID, { withAssets: false });
  });

  it("marks a superseded version, keeps it printable, and offers no repeat or amendment", async () => {
    mocks.getPrescription.mockResolvedValue(finalizedView("amended"));
    mocks.loadRxDocument.mockResolvedValue(printable());
    mocks.getVersionLinks.mockResolvedValue({ ok: true, value: { supersededBy: { id: "v2-id", version: 2 }, replaces: null } });
    render(await PrescriptionPage({ params }));
    expect(screen.getByText(/Superseded by/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "version 2" })).toHaveAttribute("href", "/prescriptions/v2-id");
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /repeat as new prescription/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /start amendment/i })).toBeNull();
  });

  it("says what a finalized copy prints without", async () => {
    mocks.getPrescription.mockResolvedValue(finalizedView("finalized"));
    mocks.loadRxDocument.mockResolvedValue(printable({ registrationNo: null }));
    render(await PrescriptionPage({ params }));
    expect(screen.getByText(/This copy prints without a registration number/)).toBeInTheDocument();
  });

  it.each(["reception", "nurse", "pharmacist"])("marks a draft as not a prescription for %s and offers only a preview", async (role) => {
    mocks.session.role = role;
    mocks.getPrescription.mockResolvedValue(draftView(null));
    render(await PrescriptionPage({ params }));
    expect(screen.getByText(/This draft is not a prescription yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preview pad" })).toHaveAttribute("href", `/prescriptions/${ID}/document?purpose=preview`);
    expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
    expect(mocks.getPadReadiness).not.toHaveBeenCalled();
  });

  it("warns a prescriber before finalizing: an incomplete profile, or no doctor profile at all", async () => {
    mocks.getPrescription.mockResolvedValue(draftView(null));
    mocks.getPadReadiness.mockResolvedValue({ ok: true, value: { missing: ["registrationNo"] } });
    const first = render(await PrescriptionPage({ params }));
    expect(screen.getByText(/missing your registration number/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complete your profile" })).toHaveAttribute("href", "/settings/profile");
    expect(screen.queryByText(/This draft is not a prescription yet/)).toBeNull();
    first.unmount();

    mocks.session.role = "owner";
    mocks.getPadReadiness.mockResolvedValue({ ok: true, value: { missing: ["noDoctorProfile"] } });
    render(await PrescriptionPage({ params }));
    expect(screen.getByText(/no doctor profile in this clinic/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Complete your profile" })).toBeNull();
  });
});
```

`tests/e2e/rx-output.spec.ts`:

```ts
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, ensureCatalogue, registerClinic, setRole, waitForEditor, type Clinic } from "./helpers";

const clinics: Clinic[] = [];
const gotenbergUrl = process.env.GOTENBERG_URL ?? "http://localhost:3001";

async function gotenbergUp(): Promise<boolean> {
  try {
    return (await fetch(`${gotenbergUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  await ensureCatalogue();
});

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

async function completeProfile(page: Page): Promise<void> {
  await page.goto("/settings/profile");
  await page.getByLabel("Qualifications").fill("MBBS, MD (Medicine)");
  await page.getByLabel("Registration number").fill("MMC/2026/0042");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
}

async function registerPatient(page: Page, name: string): Promise<string> {
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return page.url();
}

async function startDraft(page: Page, patientUrl: string): Promise<string> {
  await page.goto(patientUrl);
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await waitForEditor(page);
  return page.url();
}

/** Types one medicine into the hydrated editor and finalizes; the page refreshes into the finalized view. */
async function finalizeDraft(page: Page, drug: string, heading: RegExp): Promise<string> {
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill(drug);
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
  return page.url();
}

test("print and download a finalized prescription; a reprint keeps the finalized details", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "rxout"));
  await completeProfile(page);
  const patientUrl = await registerPatient(page, "Asha <b>Rao</b>");
  await startDraft(page, patientUrl);
  const rxUrl = await finalizeDraft(page, "Paracetamol", /Rx #1/);
  await expect(page.getByText("Not printed or downloaded yet.")).toBeVisible();

  // Print: the hidden frame loads the pad and the browser's print() is called.
  const [printed] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/document?purpose=print")),
    page.getByRole("button", { name: "Print", exact: true }).click(),
  ]);
  expect(printed.status()).toBe(200);
  const frame = page.frameLocator('iframe[title="Prescription print frame"]');
  await expect(frame.locator("body")).toContainText("MMC/2026/0042");
  await expect(frame.locator("body")).toContainText("Asha <b>Rao</b>");
  await expect(frame.locator("script")).toHaveCount(0);

  const up = await gotenbergUp();
  if (up) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PDF" }).click()]);
    expect(download.suggestedFilename()).toBe("Rx-1-v1.pdf");
    const file = await download.path();
    expect((await readFile(file)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  } else {
    await page.getByRole("button", { name: "Download PDF" }).click();
    // getByText, not getByRole("alert"): Next's route announcer is an alert region too.
    await expect(page.getByText(/PDF service is not reachable/)).toBeVisible();
  }

  await page.reload();
  await expect(page.getByText(up ? /Printed or downloaded 2 times/ : /Printed or downloaded 1 time,/)).toBeVisible();

  // Rename the patient; the finalized pad and the page header keep the name it was finalized with.
  await page.goto(patientUrl);
  await page.getByLabel("Name").fill("Renamed Rao");
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByRole("heading", { name: "Renamed Rao" })).toBeVisible();
  const reprint = await page.request.get(`${rxUrl}/document?purpose=preview`);
  const markup = await reprint.text();
  expect(markup).toContain("Asha &lt;b&gt;Rao&lt;/b&gt;");
  expect(markup).not.toContain("Renamed Rao");
  await page.goto(rxUrl);
  await expect(page.getByRole("link", { name: "Asha <b>Rao</b>" })).toBeVisible();
  await expect(page.getByText(/now recorded as Renamed Rao/)).toBeVisible();
});

test("a draft previews with a watermark, cannot be printed, warns about a missing registration number, and is marked for read-only roles", async ({ page }) => {
  test.setTimeout(120_000);
  const clinic = await registerClinic(page, "rxdraft");
  clinics.push(clinic);
  const draftUrl = await startDraft(page, await registerPatient(page, "Draft Person"));

  await expect(page.getByText(/missing your registration number/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Complete your profile" })).toHaveAttribute("href", "/settings/profile");
  await expect(page.getByRole("button", { name: "Print", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download PDF" })).toHaveCount(0);

  const href = await page.getByRole("link", { name: "Preview pad" }).getAttribute("href");
  expect(href).toMatch(/\/document\?purpose=preview$/);
  const preview = await page.request.get(href ?? "");
  expect(preview.status()).toBe(200);
  expect(await preview.text()).toContain("DRAFT · NOT VALID FOR DISPENSING");

  expect((await page.request.get(`${draftUrl}/document?purpose=print`)).status()).toBe(409);
  const pdf = await page.request.get(`${draftUrl}/pdf`);
  expect(pdf.status()).toBe(409);
  expect(await pdf.json()).toMatchObject({ error: "conflict" });

  // Roles are re-read on every request: a reception user sees the draft marked as not a prescription.
  await setRole(clinic.email, "reception");
  await page.goto(draftUrl);
  await expect(page.getByText(/This draft is not a prescription yet/)).toBeVisible();
  await expect(page.getByLabel("Medicine name")).toHaveCount(0);
});

test("a superseded version is marked, stays printable, and offers no repeat or amendment", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "rxsup"));
  await completeProfile(page);
  await startDraft(page, await registerPatient(page, "Version Person"));
  const v1Url = await finalizeDraft(page, "Amoxicillin", /Rx #1/);

  await page.getByLabel("Reason for amendment").fill("Dose was wrong");
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByRole("heading", { name: /draft amendment/i })).toBeVisible();
  await waitForEditor(page);
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1 v2/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "version 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toBeVisible();

  await page.goto(v1Url);
  await expect(page.getByText(/Superseded by/)).toBeVisible();
  await expect(page.getByRole("link", { name: "version 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /start amendment/i })).toHaveCount(0);

  const old = await page.request.get(`${v1Url}/document?purpose=preview`);
  expect(await old.text()).toContain("SUPERSEDED by version 2");
});

test("signed-out document links go to the login page", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto(`${baseURL}/prescriptions/0190a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b/document?purpose=print`);
  await expect(fresh).toHaveURL(/\/login/);
  await context.close();
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/prescription-page.test.tsx
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/rx-output.spec.ts
```

Expected: FAIL — the eight existing page tests still pass; the seven new ones fail (no "Print" button, no notices, no frozen name); the e2e spec finds no "Print" button and no "Preview pad" link (its signed-out test already passes, because Task 9 added `/prescriptions/:path*` to the middleware matcher).

- [ ] **Step 3: Implement the client actions**

`src/components/rx/output-actions.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Props = { prescriptionId: string; fileName: string };

const PRINT_FAILED = "The prescription could not be prepared for printing. Reload the page and sign in again if asked.";
const SIGNED_OUT = "Your session ended. Reload the page and sign in again.";

export function OutputActions({ prescriptionId, fileName }: Props) {
  const [busy, setBusy] = useState<"print" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  function print() {
    setError(null);
    setBusy("print");
    frameRef.current?.remove();
    const frame = document.createElement("iframe");
    frame.title = "Prescription print frame";
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    frame.addEventListener(
      "load",
      () => {
        const body = frame.contentDocument?.body;
        if (body?.dataset.rx === "ready") {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } else {
          setError(body?.dataset.rx === "error" ? (body.textContent?.trim() ?? PRINT_FAILED) : PRINT_FAILED);
        }
        setBusy(null);
      },
      { once: true },
    );
    frame.src = `/prescriptions/${prescriptionId}/document?purpose=print`;
    document.body.appendChild(frame);
    frameRef.current = frame;
  }

  async function downloadPdf() {
    setError(null);
    setBusy("pdf");
    try {
      const response = await fetch(`/prescriptions/${prescriptionId}/pdf`, { cache: "no-store" });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.includes("application/pdf")) {
        if (response.redirected || type.includes("text/html")) {
          setError(SIGNED_OUT);
          return;
        }
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "The PDF could not be downloaded. Use Print instead.");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setError("You appear to be offline. Use Print, or try again when you are connected.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={print} disabled={busy !== null}>
          {busy === "print" ? "Preparing…" : "Print"}
        </Button>
        <Button type="button" variant="outline" onClick={downloadPdf} disabled={busy !== null}>
          {busy === "pdf" ? "Generating PDF…" : "Download PDF"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

Two notes: while busy, the "Print" button's accessible name is "Preparing…", so the e2e spec clicks it before the state changes; and the iframe keeps the last printed document until the next print (removing it right after `print()` cancels printing in some browsers).

- [ ] **Step 4: Implement the panel**

`src/components/rx/rx-output-panel.tsx` (a server component: no `"use client"`; type-only imports from server modules, so no server code reaches the client bundle):

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { ProfileGap } from "@/server/services/pad-settings";
import type { VersionRef } from "@/server/services/rx-documents";
import type { OutputSummary } from "@/server/services/rx-output";
import { OutputActions } from "./output-actions";

/** What a finalized copy prints without, read from its finalize snapshot. */
export type PrintGap = "doctorName" | "registrationNo";

export type RxOutputPanelProps = {
  prescriptionId: string;
  isDraft: boolean;
  /** The viewer may edit this draft (rx.draft). A draft shown to anyone else is marked as not a prescription. */
  canEdit: boolean;
  fileName: string;
  supersededBy: VersionRef | null;
  replaces: VersionRef | null;
  missingProfile: ProfileGap[];
  printedWithout: PrintGap[];
  outputs: OutputSummary | null;
  timeZone: string;
};

const GAP_TEXT: Record<Exclude<ProfileGap, "noDoctorProfile">, string> = {
  doctorName: "your printed name",
  registrationNo: "your registration number",
};
const PRINT_GAP_TEXT: Record<PrintGap, string> = { doctorName: "a doctor's name", registrationNo: "a registration number" };

const note = "rounded-md border p-3 text-sm";

function lastPrinted(outputs: OutputSummary | null, timeZone: string): string {
  if (!outputs || outputs.count === 0) return "Not printed or downloaded yet.";
  const times = `${outputs.count} time${outputs.count === 1 ? "" : "s"}`;
  if (!outputs.lastAt) return `Printed or downloaded ${times}.`;
  const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone }).format(outputs.lastAt);
  return `Printed or downloaded ${times}, last on ${when}.`;
}

function ProfileWarning({ missing }: { missing: ProfileGap[] }) {
  if (missing.includes("noDoctorProfile")) {
    return (
      <div role="note" className={`${note} border-amber-300 bg-amber-50`}>
        You have no doctor profile in this clinic, so prescriptions you finalize print without a doctor&apos;s name, registration
        number, or signature.
      </div>
    );
  }
  const gaps = missing.filter((gap): gap is Exclude<ProfileGap, "noDoctorProfile"> => gap !== "noDoctorProfile");
  if (gaps.length === 0) return null;
  return (
    <div role="note" className={`${note} border-amber-300 bg-amber-50`}>
      Your doctor profile is missing {gaps.map((gap) => GAP_TEXT[gap]).join(" and ")}. Prescriptions you finalize now will print
      without it.{" "}
      <Link className="font-medium underline" href="/settings/profile">
        Complete your profile
      </Link>
    </div>
  );
}

/** Version and draft notices, profile warnings, preview for drafts, print and download for finalized and superseded versions. */
export function RxOutputPanel(p: RxOutputPanelProps) {
  return (
    <section className="space-y-3">
      {p.supersededBy ? (
        <div role="note" className={`${note} border-red-300 bg-red-50`}>
          Superseded by{" "}
          <Link className="font-medium underline" href={`/prescriptions/${p.supersededBy.id}`}>
            version {p.supersededBy.version}
          </Link>
          . This version is kept as history; printed copies carry a SUPERSEDED marker.
        </div>
      ) : null}
      {p.replaces ? (
        <p className="text-sm text-muted-foreground">
          Replaces{" "}
          <Link className="underline" href={`/prescriptions/${p.replaces.id}`}>
            version {p.replaces.version}
          </Link>
          .
        </p>
      ) : null}
      {p.isDraft && !p.canEdit ? (
        <div role="note" className={`${note} border-amber-300 bg-amber-50`}>
          This draft is not a prescription yet. It is not valid for dispensing until a doctor finalizes it.
        </div>
      ) : null}
      {p.isDraft && p.canEdit ? <ProfileWarning missing={p.missingProfile} /> : null}
      {p.printedWithout.length > 0 ? (
        <div role="note" className={`${note} border-amber-300 bg-amber-50`}>
          {`This copy prints without ${p.printedWithout.map((gap) => PRINT_GAP_TEXT[gap]).join(" and ")}: the doctor profile lacked it when the prescription was finalized.`}
        </div>
      ) : null}
      {p.isDraft ? (
        <Button asChild variant="outline">
          <a href={`/prescriptions/${p.prescriptionId}/document?purpose=preview`} target="_blank" rel="noopener noreferrer">
            Preview pad
          </a>
        </Button>
      ) : (
        <>
          <OutputActions prescriptionId={p.prescriptionId} fileName={p.fileName} />
          <p className="text-xs text-muted-foreground">{lastPrinted(p.outputs, p.timeZone)}</p>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Wire the page**

Replace the whole content of `src/app/(app)/prescriptions/[id]/page.tsx` with the version below. It is the current page (conflict refresh state, not-found mapping, `AllergyBanner`, `ClinicalEditor` with `canFinalize`, `DiscardDraftForm`, finalized-only `AmendForm` and `RepeatForm`) plus the parallel reads, `<RxOutputPanel>`, and the frozen patient name.

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { pdfFileName } from "@/lib/rx-render/format";
import { getPrescription } from "@/server/services/prescriptions";
import { listFavourites } from "@/server/services/catalogue";
import { getPadReadiness } from "@/server/services/pad-settings";
import { getVersionLinks, loadRxDocument } from "@/server/services/rx-documents";
import { listPrescriptionOutputs } from "@/server/services/rx-output";
import { amendAction, discardDraftAction, repeatAction } from "@/server/actions/prescriptions";
import { AllergyBanner } from "@/components/patients/allergy-banner";
import { AmendForm } from "@/components/rx/amend-form";
import { ClinicalEditor } from "@/components/rx/clinical-editor";
import { DiscardDraftForm } from "@/components/rx/discard-draft-form";
import { PrescriptionReadOnly } from "@/components/rx/prescription-view";
import { RepeatForm } from "@/components/rx/repeat-form";
import { RxOutputPanel, type PrintGap } from "@/components/rx/rx-output-panel";

export const dynamic = "force-dynamic";

export default async function PrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  // Forbidden, malformed, unknown and foreign ids all look the same: a plain not-found.
  const result = await getPrescription(session, id);
  if (!result.ok && result.code === "conflict") {
    // A save landed in the middle of the read: not a missing prescription.
    return (
      <div className="max-w-xl space-y-3">
        <h1 className="text-xl font-semibold">This prescription changed while loading.</h1>
        <p className="text-sm text-muted-foreground">It was saved from another window. Refresh to see the latest version.</p>
        {/* A plain link on purpose: a full page load, not a client-side navigation that could reuse this state. */}
        <a className="underline" href={`/prescriptions/${id}`}>
          Refresh
        </a>
      </div>
    );
  }
  if (!result.ok) notFound();
  const rx = result.value;

  const isDraft = rx.status === "draft";
  // Clinical content is editable only by roles with rx.draft (owner, doctor); everyone else reads.
  const canEdit = isDraft && can(session.role, "rx.draft");
  // Independent reads, in parallel. A failed one only drops its notice; it never fails the page.
  const [favourites, links, readiness, outputs, printable] = await Promise.all([
    canEdit ? listFavourites(session) : null,
    getVersionLinks(session, rx.id),
    canEdit ? getPadReadiness(session) : null,
    isDraft ? null : listPrescriptionOutputs(session, rx.id),
    isDraft ? null : loadRxDocument(session, rx.id, { withAssets: false }),
  ]);
  // A finalized version shows the record as finalized (ADR-0032). The allergy banner stays live on purpose:
  // it is a safety prompt for whoever acts on the prescription today.
  const frozen =
    printable?.ok && printable.value.document.snapshotSource === "finalize" ? printable.value.document.snapshot : null;
  const patientName = frozen ? frozen.patient.name : rx.patient.name;
  const printedWithout: PrintGap[] = [];
  if (frozen && !frozen.doctor.name.trim()) printedWithout.push("doctorName");
  if (frozen && !frozen.doctor.registrationNo?.trim()) printedWithout.push("registrationNo");

  const label = rx.rxNo ? `Rx #${rx.rxNo}` : "Prescription";
  const heading = isDraft
    ? rx.version > 1
      ? `Draft amendment (v${rx.version})`
      : "Draft prescription"
    : `${label}${rx.version > 1 ? ` v${rx.version}` : ""}`;

  return (
    <div className="max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{heading}</h1>
        <p className="text-sm text-muted-foreground">
          <Link className="underline" href={`/patients/${rx.patient.id}`}>
            {patientName}
          </Link>
          {frozen && frozen.patient.name !== rx.patient.name ? ` (now recorded as ${rx.patient.name})` : ""}
          {rx.patient.patientNo ? ` · Patient #${rx.patient.patientNo}` : ""} · {rx.status}
        </p>
        <AllergyBanner allergies={rx.patient.allergies} showWhenEmpty />
        {rx.amendmentReason ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Amendment reason: </span>
            {rx.amendmentReason}
          </p>
        ) : null}
      </header>

      <RxOutputPanel
        prescriptionId={rx.id}
        isDraft={isDraft}
        canEdit={canEdit}
        fileName={pdfFileName(rx)}
        supersededBy={links.ok ? links.value.supersededBy : null}
        replaces={links.ok ? links.value.replaces : null}
        missingProfile={readiness?.ok ? readiness.value.missing : []}
        printedWithout={printedWithout}
        outputs={outputs?.ok ? outputs.value : null}
        timeZone={frozen?.clinic.timezone ?? "Asia/Kolkata"}
      />

      {canEdit ? (
        <ClinicalEditor
          key={rx.id}
          prescriptionId={rx.id}
          visit={rx.visit}
          items={rx.items}
          revision={rx.revision}
          favourites={favourites?.ok ? favourites.value : []}
          canAddToClinic={can(session.role, "catalogue.write")}
          canFinalize={can(session.role, "rx.finalize")}
        />
      ) : (
        <PrescriptionReadOnly rx={rx} />
      )}

      {canEdit ? (
        <div className="border-t pt-4">
          <DiscardDraftForm
            action={discardDraftAction.bind(null, rx.id)}
            label={rx.parentPrescriptionId ? "Withdraw amendment" : "Discard draft"}
            warning={
              rx.parentPrescriptionId
                ? "The correction is deleted and the original prescription stays exactly as it is. This cannot be undone."
                : "This draft and everything in it are deleted. This cannot be undone."
            }
          />
        </div>
      ) : null}

      {!isDraft ? (
        <div className="flex flex-wrap items-start gap-6 border-t pt-4">
          {rx.status === "finalized" && can(session.role, "rx.amend") ? (
            <AmendForm action={amendAction.bind(null, rx.id)} />
          ) : null}
          {rx.status === "finalized" && can(session.role, "rx.draft") ? (
            <RepeatForm action={repeatAction.bind(null, rx.id)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
```

The page stays under ~170 lines. `pdfFileName(rx)` reads only `rxNo` and `version` from the `PrescriptionView`. After a successful finalize the editor calls `router.refresh()`, so this server component re-runs and shows the panel with Print and Download for the new version.

- [ ] **Step 6: Run the unit and e2e tests, typecheck, lint**

```powershell
Set-Location E:\projects\clinicpad; npm run typecheck; if ($?) { npm run lint }
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/prescription-page.test.tsx
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/rx-output.spec.ts tests/e2e/prescriptions.spec.ts tests/e2e/clinical-form.spec.ts
```

Run the e2e command twice: once with Gotenberg stopped (`docker compose stop gotenberg`) and once with it running (`docker compose up -d gotenberg`). Expected: `prescription-page.test.tsx` passes 15 tests (8 existing + 7 new); every e2e test PASSES both times (`rx-output.spec.ts` 4, `prescriptions.spec.ts` 6, `clinical-form.spec.ts` 2); the first spec takes its "service down" branch the first time and downloads a real PDF the second time. Plan 1B's prescription specs still pass: Repeat is still offered on the current version, the v1 page still has the heading `Rx #1` with no Repeat or Amend, the patient link on the v2 page still reads "Ravi Sharma", and the reception draft view still has no editor. Troubleshooting without weakening an assertion:
- The print frame never reports content: the document route must send `frame-ancestors 'self'`, not `'none'`, and no `X-Frame-Options: DENY` header may be added for `/prescriptions/*`.
- "Printed or downloaded 2 times" shows 1: the Download click happened while `busy` was still `"print"` (button disabled); wait for the frame assertions first, as the spec does.
- Typing into the editor is lost: a helper skipped `waitForEditor(page)`; the editor's fieldset is disabled until hydration.
- An existing page test fails on a missing mock: the page imports a module the test does not mock; every server service the page calls must be mocked (they import the database client).

- [ ] **Step 7: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/components/rx/output-actions.tsx src/components/rx/rx-output-panel.tsx "src/app/(app)/prescriptions/[id]/page.tsx" tests/unit/prescription-page.test.tsx tests/e2e/rx-output.spec.ts
Set-Location E:\projects\clinicpad; git commit -m "feat: add print, PDF download, draft preview, and version and draft notices to the prescription page" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 11: Visual regression, desktop check, documentation, and the Gate 1C verification

**Files:**
- Create: `tests/e2e/rx-visual.spec.ts`, screenshot baselines under `tests/e2e/rx-visual.spec.ts-snapshots/` (written by `--update-snapshots`, reviewed, committed)
- Modify: `package.json` (`test:visual`), `docs/DECISIONS.md`, `docs/PROGRESS.md`, `docs/SETUP.md`, `AGENTS.md`; `tsconfig.json` only if Step 2 needs it

**Interfaces:**
- Consumes: everything above.
- Produces: an always-on print-layout check in `npm run test:e2e` (embedded font loads, no network requests, rows unsplit, nothing overflows, page counts within bounds) and an opt-in screenshot comparison (`npm run test:visual`); ADR-0032 to ADR-0035; the Phase 1C checklist (`docs/PROGRESS.md` §4.10); a passing gate.

- [ ] **Step 1: Write the visual spec**

`tests/e2e/rx-visual.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { renderPrescription } from "@/lib/rx-render/render";
import type { RxDocument } from "@/lib/rx-render/types";
import { countPdfPages } from "@/server/pdf/engine";
import { loadFontCss } from "@/server/rx-render/fonts";
import { DEVANAGARI, HOSTILE, TINY_PNG, documentFixture, manyItems, snapshot, visit } from "../fixtures/rx-documents";

const fontCss = loadFontCss();
const visual = Boolean(process.env.RX_VISUAL);

type Case = { name: string; doc: RxDocument; pages: [number, number] };

const derma = { template: { kind: "builtin" as const, key: "derma" as const }, labels: "hi" as const };
const CASES: Case[] = [
  { name: "general-a4-en", doc: documentFixture(), pages: [1, 1] },
  { name: "general-a4-30-medicines", doc: documentFixture({ items: manyItems(30) }), pages: [2, 6] },
  {
    name: "paediatric-a5-bilingual",
    doc: documentFixture({ layout: { template: { kind: "builtin", key: "paediatric" }, paperSize: "A5", labels: "bilingual" } }),
    pages: [1, 3],
  },
  {
    name: "derma-a4-hindi",
    doc: documentFixture({
      snapshot: snapshot({ patient: { name: DEVANAGARI.name }, layout: derma }),
      visit: visit({ advice: DEVANAGARI.advice, complaints: [DEVANAGARI.complaint] }),
    }),
    pages: [1, 3],
  },
  {
    name: "general-a5-long-hostile",
    doc: documentFixture({
      layout: { paperSize: "A5" },
      items: manyItems(30),
      visit: visit({ advice: `${HOSTILE.script} ${HOSTILE.longWord} ${DEVANAGARI.advice}` }),
    }),
    pages: [3, 12],
  },
];

for (const c of CASES) {
  test.describe(`pad ${c.name}`, () => {
    test("loads the embedded font, fetches nothing, keeps rows whole, and paginates within bounds", async ({ page }) => {
      const rendered = renderPrescription(c.doc, { logo: TINY_PNG, signature: TINY_PNG, fontCss });
      const requests: string[] = [];
      page.on("request", (request) => {
        if (!request.url().startsWith("data:")) requests.push(request.url());
      });
      await page.setContent(rendered.html, { waitUntil: "load" });

      const faces = await page.evaluate(async () => (await document.fonts.load('12px "Noto Sans Devanagari"', "आशा")).length);
      expect(faces).toBeGreaterThan(0);

      await page.emulateMedia({ media: "print" });
      const layout = await page.evaluate(() => {
        const head = document.querySelector("table.sheet > thead");
        const row = document.querySelector(".meds tbody tr");
        return {
          header: head ? getComputedStyle(head).display : "missing",
          rowBreak: row ? getComputedStyle(row).breakInside : "missing",
          overflowing: Array.from(document.querySelectorAll(".meds td, .block-body")).filter(
            (el) => el.scrollWidth > el.clientWidth + 1,
          ).length,
          scripts: document.querySelectorAll("script").length,
        };
      });
      expect(layout).toEqual({ header: "table-header-group", rowBreak: "avoid", overflowing: 0, scripts: 0 });

      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      const pages = countPdfPages(new Uint8Array(pdf).buffer);
      expect(pages).toBeGreaterThanOrEqual(c.pages[0]);
      expect(pages).toBeLessThanOrEqual(c.pages[1]);
      expect(requests).toEqual([]);
    });

    test("matches the reviewed screenshot", async ({ page }) => {
      test.skip(!visual, "Set RX_VISUAL=1 (npm run test:visual) to compare screenshots; baselines are per platform.");
      const rendered = renderPrescription(c.doc, { logo: TINY_PNG, signature: TINY_PNG, fontCss });
      await page.setViewportSize({ width: c.doc.snapshot.layout.paperSize === "A5" ? 560 : 794, height: 1123 });
      await page.setContent(rendered.html, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.emulateMedia({ media: "print" });
      await expect(page).toHaveScreenshot(`${c.name}.png`, { fullPage: true, maxDiffPixelRatio: 0.002 });
    });
  });
}
```

In `package.json` `scripts`, add after `"test:e2e"`:

```json
    "test:visual": "cross-env RX_VISUAL=1 playwright test tests/e2e/rx-visual.spec.ts",
```

- [ ] **Step 2: Run the layout checks, then create and review the screenshot baselines**

```powershell
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/rx-visual.spec.ts
Set-Location E:\projects\clinicpad; npx cross-env RX_VISUAL=1 playwright test tests/e2e/rx-visual.spec.ts --update-snapshots
Set-Location E:\projects\clinicpad; npm run test:visual
```

Expected: the first run passes five layout tests and skips five screenshot tests with the `RX_VISUAL` message. The second run writes five PNGs under `tests/e2e/rx-visual.spec.ts-snapshots/` (file names end in the platform, e.g. `-chromium-win32.png`). **Open every PNG with the Read tool and check by eye:** header with doctor and clinic, the patient strip, the medicines table with its heading row, Devanagari drawn with real glyphs (no boxes or question marks), the long hostile word wrapped inside the page, the signature block. The third run passes all ten tests.

If the first run fails to resolve `@/lib/...` imports, Playwright needs a base URL for the path alias: add `"baseUrl": "."` to `compilerOptions` in `tsconfig.json` (the `paths` entry stays as it is), then rerun. If `general-a4-en` prints on two pages, tighten spacing in `styles.ts` (margins of `.block`, `.sig`), not the expected range. Baselines are platform-specific; the screenshot test is opt-in for that reason, and the layout test runs everywhere, CI included.

- [ ] **Step 3: Confirm the desktop build is unchanged**

```powershell
Set-Location E:\projects\clinicpad; npm run build:desktop
Set-Location E:\projects\clinicpad; git status --short
```

Expected: the build exits 0; `git status --short` lists only this task's files (nothing stashed, moved, or left behind in `.desktop-stash/`). Every Plan 1C route is under `src/app/(app)/` or `src/app/api/health/`, both in `SERVER_ONLY` in `scripts/build-desktop.mjs` (with `src/middleware.ts`), so `SERVER_ONLY` needs no new entry. If a new path ever appears in the export error, add it to `SERVER_ONLY`.

- [ ] **Step 4: Record the decisions**

Append to `docs/DECISIONS.md`, directly before the `## 19. Open decisions` heading (after ADR-0031, Plan 1B's last). ADR-0032 should be the next free number; if the file already has an ADR-0032, renumber these four consecutively, keep the text, and update the `ADR-0032` references in `src/server/services/render-snapshot.ts`, `src/server/services/prescriptions.ts`, `src/server/services/pad-settings.ts`, and `src/app/(app)/prescriptions/[id]/page.tsx`. Write each `Date` as the day you run this step (`YYYY-MM-DD`).

```md
## ADR-0032 — Printed prescriptions come from a snapshot frozen at finalize, signed by the finalizer

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** A reprint of an old prescription read the patient's name and age, the clinic header, and the doctor's details live, so a later edit (a renamed patient, a moved clinic, a corrected registration number) would change a medico-legal record. The immutability triggers (ADR-0023) forbid writing to a prescription after finalize. An amendment copies the original visit, including its `doctor_id` (ADR-0024), and an owner without a doctor profile can finalize.

**Decision:** `finalizePrescription` writes `prescriptions.render_snapshot` (patient name, number, gender, date of birth, age at the visit, allergies; clinic name, address lines, phone, email, footer lines, logo asset id, timezone; prescribing doctor's name, qualifications, designation, registration number and council, signature asset id; template, paper size, label language) in the same UPDATE that sets `status = 'finalized'`, which the trigger allows while the row is a draft and freezes afterwards. Its lock order, checks, numbering rule, and audit payload are unchanged. The prescriber is the finalizing user: their own doctor profile, or no doctor block at all; never the visit's doctor. The snapshot is versioned (`v: 1`) and parsed with Zod; an unparseable snapshot refuses to print. Drafts and prescriptions finalized before this ADR print from live data (a draft with the visit's doctor, an old finalized row with its finalizer's current profile) and the pad says so. An amendment gets its own snapshot at its own finalize. The prescription page shows the patient name from the snapshot for finalized versions (with the current name when it changed); the on-screen allergy banner stays live as a safety prompt. The draft page warns a prescriber whose profile lacks a name or registration number, or who has no doctor profile; finalize does not block on it.

**Consequences:** Reprints are stable and need no extra trigger. New printed fields must be added to the snapshot schema (bump `v`). Clinic and profile edits apply only to prescriptions finalized afterwards, which the settings pages state. `buildRenderSnapshot` relies on RLS, so it must run inside `withTenant` and never on the admin connection (the demo seed's prescriptions print from live data). Ages use the UTC calendar day until Plan 1D threads the clinic timezone.

**Revisit trigger:** a regulator requires reprints to show current demographics, a clinic must never print without a registration number (add a finalize precondition), or Template Studio needs fields the snapshot lacks.

---

## ADR-0033 — Print and PDF outputs are logged, not cached

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** The data model sketched `printed_at`, `shared_at`, and `rendered_pdf_url` on `prescriptions` (the unused `pdf_url` column exists), but finalized rows cannot be updated, and there is no object storage yet.

**Decision:** Every browser print and PDF download appends a `prescription_outputs` row (tenant, prescription, actor, kind, template, paper size, page count, PDF size, SHA-256 of the exact HTML) and an audit event with ids and counts only. The runtime role can insert and read the table, never update or delete it; a trigger refuses outputs for drafts (`23000`) and for a prescription not visible in the row's tenant (`23503`); the key to `prescriptions` is the composite `(tenant_id, prescription_id)`. PDFs are regenerated on demand from the frozen inputs; the HTML of every reprint is byte-identical (same hash), and PDF bytes differ only in Chromium metadata. A print is logged when its HTML is served to the print frame, whether or not the dialog is then confirmed.

**Consequences:** No stored PHI-bearing files and no retention job yet; one Gotenberg call per download. Plan 1D's sharing log extends the same table.

**Revisit trigger:** Gotenberg load or latency, WhatsApp/email sharing that needs a stored file, or Phase 2 storage (cache keyed by `html_sha256`).

---

## ADR-0034 — One self-contained HTML renderer for print and PDF

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** ADR-0007 chose Gotenberg's Chromium route for HTML → PDF. The same pad must also print from the browser, render Devanagari identically everywhere, and never let user text or Gotenberg reach the network.

**Decision:** `src/lib/rx-render/` is a pure TypeScript renderer that builds HTML only through an auto-escaping `html` tagged template. Built-in templates (General, Paediatric, Derma) are data drawn by one renderer; `TemplateRef.kind` is the seam for Phase 2's DOCX and overlay kinds (which will use `prescriptions.template_version_id`). Documents embed Noto Sans Devanagari (from `@fontsource/noto-sans-devanagari`, pinned) and images as `data:` URIs, carry a `default-src 'none'` CSP, and must pass `checkSelfContained()` before they are served or sent. A repeating outer table header/footer gives a header on every page without JavaScript; "Page X of Y" comes from Gotenberg's footer template. Gotenberg runs with JavaScript disabled behind an injectable `PdfEngine` with timeouts, size and page caps, and a health check; Print uses a hidden iframe and works when Gotenberg is down. Production must also block Gotenberg's network egress. Viewing, previewing, printing, and downloading use `rx.read`; `/prescriptions/:path*` is in the middleware matcher.

**Consequences:** Identical output in Gotenberg and browsers apart from page numbers; ~300–400 KB of fonts per document; tests run without Gotenberg. Pad labels are localized (English, Hindi, bilingual) in `labels.ts`; the app UI stays English until Plan 1D. The legacy `/preview` page remains only for the desktop shell.

**Revisit trigger:** Phase 2 Template Studio, a second script family (Gujarati, Tamil, ...), or a Gotenberg major upgrade (re-run `npm run test:visual`).

---

## ADR-0035 — Clinic images live in Postgres as immutable assets

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** The pad needs a clinic logo and a doctor signature. There is no object storage yet, uploads are hostile (AGENTS.md invariant 8), and a reprint must keep the signature it was finalized with.

**Decision:** `clinic_assets` stores PNG or JPEG bytes (`bytea`, ≤ 512 KB, 16–2000 px per side, type detected from the bytes, nothing after the end marker), de-duplicated by SHA-256 per tenant and kind. The runtime role can insert and read but never update or delete; `clinics.logo_asset_id` and `doctors.signature_asset_id` point at the current asset through composite same-tenant keys (`NO ACTION`), and snapshots record the asset ids. Two actions join the role matrix: `settings.clinic` (owner) for the clinic pad and logo, `settings.profile` (owner, doctor) for one's own doctor profile and signature. Settings text is validated with the shared cleaning helpers (a NUL is refused). No malware scan or EXIF stripping yet: the images are only header-parsed and embedded into JavaScript-free Chromium.

**Consequences:** Data stays in the India-region database; old prescriptions keep their images; the table grows by a few hundred KB per change of logo or signature.

**Revisit trigger:** Phase 2 storage and upload pipeline (ClamAV, re-encoding), or asset volume above a few GB.
```

- [ ] **Step 5: Update `PROGRESS.md`, `SETUP.md`, and `AGENTS.md`**

In `docs/PROGRESS.md`:
- Update **Last updated**, **Current phase** (Phase 1C code complete), and **Overall status**; in section 1 ("Snapshot") update the "Tests passing" and "Build status" rows with the counts the gate in Step 6 prints; in section 2 update the Phase 1 row (1A, 1B, 1C code complete; 1D not started).
- Add a new subsection after section 4.9's follow-up list and before `## 5. In progress`, ticking each item only once its evidence exists (the same evidence rule as 4.9: the commit, the command, the count):

```md
### 4.10 Phase 1C checklist (pad renderer, PDF, print)

- [ ] Data-driven renderer: General, Paediatric, Derma on A4 and A5 with English, Hindi, or bilingual labels (`tests/unit/rx-render.test.ts`, `tests/unit/__golden__/`)
- [ ] Hostile text printed literally; every document self-contained (`tests/unit/self-contained.test.ts`, `rx-render.test.ts`, network probe in `tests/integration/gotenberg-smoke.test.ts`)
- [ ] Finalize freezes the printed details; reprints ignore later patient, clinic, and doctor edits; the finalizer signs, never the visit's doctor (`tests/integration/render-snapshot.test.ts`, `tests/e2e/rx-output.spec.ts`)
- [ ] Clinic pad and doctor profile settings; NUL refused; logo and signature uploads validated from bytes (`tests/integration/pad-settings.test.ts`, `settings-actions.test.ts`, `tests/e2e/pad-settings.spec.ts`)
- [ ] Server PDF through Gotenberg with timeouts, caps, health check, and a clear error state (`tests/unit/gotenberg.test.ts`, `tests/integration/rx-output-routes.test.ts`)
- [ ] Print and download audited with ids and counts; `prescription_outputs` append-only with composite keys (`tests/integration/print-schema.test.ts`, `rx-output-routes.test.ts`)
- [ ] Drafts preview only and are marked for read-only roles; superseded versions marked, printable, never repeated or amended; finalized versions show the frozen patient name; prescribers warned about an incomplete or missing doctor profile (`tests/unit/prescription-page.test.tsx`, `tests/e2e/rx-output.spec.ts`)
- [ ] `/prescriptions/:path*` in the middleware matcher (`rx-output.spec.ts`, signed-out test)
- [ ] Print layout: embedded font, no requests, unsplit rows, page counts in bounds (`tests/e2e/rx-visual.spec.ts`); screenshots reviewed (`npm run test:visual`)
- [ ] Desktop export unchanged (`npm run build:desktop`)
- [ ] `node scripts/verify-gate-0.mjs` PASSED with the Phase 1C tests

**Phase 1C known limitations and follow-ups**

- Page numbers only in the Gotenberg PDF, not in browser print; no automated Safari print check (print one pad from Safari before ticking the Phase 1 exit criterion).
- A native Hindi speaker should review the new pad labels in `src/lib/rx-render/labels.ts`.
- `gotenberg/gotenberg:8.11.0` and its flags were not verified against the registry when the plan was written; `outputFileTracingIncludes` for the fonts is verified only at the first real deployment.
- Demo seed prescriptions have no snapshot and print with the "finalized before print snapshots were recorded" note.
- Ages on the pad use the UTC calendar day (with the DOB item in 4.8; Plan 1D).
- A draft preview is not re-checked against a concurrent save (it may mix two saves for a moment; finalized copies are frozen).
- Every `rx.read` role (reception, nurse, pharmacist) can print and download the full clinical content: part of the data-minimisation decision in 4.9.
- No malware scan or EXIF stripping of uploaded images (Phase 2.1); no PDF cache (ADR-0033).
```

- In section 4.8's follow-up list, append " — resolved in Plan 1C (`<commit>`)" to "Superseded and draft views are unmarked for read-only roles, and the finalized view reads the LIVE patient row (name, allergies); a snapshot at finalization is needed (Plan 1C)." (the allergy banner stays live by decision, ADR-0032) and to "`/prescriptions/:path*` is missing from the middleware matcher (Plan 1C).", using the commits of Tasks 10 and 9. In both 4.8 and 4.9, change "(Plan 1C warns)" in the owner-without-a-doctor-profile item to "(Plan 1C warns before finalizing and prints no doctor block, ADR-0032; the decision itself is still open)".
- In section 5, replace the "**Next:**" line with: "**Next:** Plan 1D (sharing, CSV import, filters, hardening). Plan 1D's ADRs start at ADR-0036; its migrations start at 0015."
- Add a session-log entry in section 11 (same format as the 2026-11-17 entry: Did / Evidence / Blocked by / Next / Gotchas).

In `docs/SETUP.md`:
- In §3.3, delete the `GOTENBERG_URL` row and add to the §3.2 table: `| \`GOTENBERG_URL\` | for PDFs | PDF service (Gotenberg); default \`http://localhost:3001\` |`.
- In §4, replace the sentence "Phase 0 introduces a `docker-compose.yml` for local dependencies. Until then, only the Next.js dev server is required." with "`docker-compose.yml` runs `postgres` (5432) and `gotenberg` (3001, prescription PDFs). Start both with `docker compose up -d`; without Gotenberg the app still works, Print still works, and Download PDF shows an error. On this project's Windows machine Docker Desktop lives under `%LOCALAPPDATA%\Programs\DockerDesktop`."
- After §4.1, add:

```md
### 4.2 Document engine (Gotenberg)

`docker compose up -d gotenberg` starts the pinned Gotenberg image with JavaScript disabled. Check it with `curl http://localhost:3001/health` or the app's `GET /api/health/pdf`. Prescription documents embed their fonts and images, carry a `default-src 'none'` CSP, and are checked before they are sent, so Gotenberg never needs network access: in staging and production run it with no egress (no outbound network from its container). After upgrading the image, run `npm run test:visual` and review the screenshots.
```

- In §5's command list, add `npm run test:visual   # print-layout screenshots (opt-in, per-platform baselines)`.
- In §9's table, replace the row `| PDF conversion timeout | Gotenberg down or file too large | ... |` with `| Download PDF says the PDF service is not reachable | Gotenberg not running | \`docker compose up -d gotenberg\`; then \`curl http://localhost:3001/health\` |`.

In `AGENTS.md`:
- Update **Last updated** to today's date.
- In §2, change the bullet "Hard-coded doctor identity and design in `src/app/(perscription)/preview/page.tsx`." to "Hard-coded doctor identity and design in `src/app/(legacy)/(perscription)/preview/page.tsx` (the legacy desktop shell only; the web app prints from clinic and doctor settings since Plan 1C)." and the bullet "No billing, no appointments, no templates or PDF generation, no sharing, no offline sync for the web app." to "No billing, no appointments, no sharing, no offline sync for the web app; built-in pad templates and PDF exist since Plan 1C, Template Studio does not."
- In §2 "Repository state": change the date and "Phase 0, Phase 1A and Phase 1B are code complete" to include Phase 1C; replace the gate counts with the ones Step 6 prints; change "sections 4.8 and 4.9" to "sections 4.8 to 4.10"; replace "Templates, PDF, sharing, and offline are not built yet. What does not exist: Template Studio and PDF, WhatsApp/email sharing, offline sync, billing, staging." with "Phase 1C adds the prescription pad: a pure renderer (`src/lib/rx-render/`) with General, Paediatric, and Derma templates on A4/A5 with English, Hindi, or bilingual labels; clinic pad and doctor profile settings with validated logo and signature uploads (`clinic_assets`); print details frozen at finalize and signed by the finalizer (`prescriptions.render_snapshot`); browser print and Gotenberg PDF download with an append-only `prescription_outputs` log. What does not exist: Template Studio (DOCX or overlay templates), WhatsApp/email sharing, offline sync, billing, staging."; change "ADR-0019 to ADR-0031" to "ADR-0019 to ADR-0035".
- In the "What must be replaced" table, change the "Hard-coded doctor header" row's replacement to "Done for the web app (clinic pad + doctor profile, Plan 1C); the legacy preview remains for the desktop shell".
- In §6 Commands, add below `npm run db:seed:catalogue …`: `docker compose up -d gotenberg   # PDF service for Download PDF` and `npm run test:visual   # print-layout screenshots (opt-in)`.
- In §8, name Plan 1D (sharing, CSV import, filters, hardening) as the next milestone.
- In §10 "Things that will bite you", replace the three bullets "**Hard-coded Hindi doctor details** in the preview page…", "**Tauri print path manipulates `document.body.innerHTML`.**…", and "**PDF generation today is browser-print based.**…" with:
  - "**Finalized prescriptions print from `render_snapshot`.** Never render a finalized prescription from live patient, clinic, or doctor rows; add new printed fields to the snapshot schema (`src/lib/rx-render/snapshot.ts`) and bump `v`. The finalizer signs the pad: `buildRenderSnapshot` never falls back to the visit's doctor once there is a finalizer, and it must run inside `withTenant` (it relies on RLS; never call it with `adminDb`)."
  - "**Every document must pass `checkSelfContained()`.** Build HTML only with `html`, `userText`, and `raw` (`src/lib/rx-render/html.ts`); no external URLs, scripts, or fonts."
  - "**The legacy `/preview` page still hard-codes a Hindi doctor header and manipulates `document.body.innerHTML` to print.** It serves only the desktop shell until Phase 4; the web app prints through `src/lib/rx-render/`."
  - "**PDFs need Gotenberg** (`docker compose up -d gotenberg`). Without it, Download PDF shows an error and Print still works."

- [ ] **Step 6: Run the full gate**

```powershell
Set-Location E:\projects\clinicpad; docker compose up -d postgres gotenberg
Set-Location E:\projects\clinicpad; node scripts/verify-gate-0.mjs
Set-Location E:\projects\clinicpad; npm run test:visual
```

Expected: `Gate 0 verification PASSED` (lint, typecheck, unit + integration tests with the Gotenberg smoke suite running, web and desktop builds, every e2e spec), then the visual run passes. Counts from the HEAD `4747932` baseline: unit and integration **872 + 250 = 1,122 tests in 62 files** (14 new files; Task-by-task: 24, 38, 25, 34, 11, 62, 10, 23, 16, 7) — plus whatever the Plan 1B final-review fix wave added if it landed (it was uncommitted at reconcile time, with a new `tests/unit/validation-cleaning.test.ts`); use the Prerequisites baseline you recorded. With Gotenberg up, nothing is skipped, except the smoke suite's network probe when this machine's firewall blocks the container from reaching it. E2E: 18 + 2 (`pad-settings`) + 4 (`rx-output`) + 10 (`rx-visual`) = 34 tests, reported as **29 passed, 5 skipped** (the screenshot tests skip without `RX_VISUAL`). Do not tick any checklist box until you have seen this output; then write the real counts into `docs/PROGRESS.md` and `AGENTS.md`.

- [ ] **Step 7: Commit**

```powershell
Set-Location E:\projects\clinicpad; git add tests/e2e/rx-visual.spec.ts tests/e2e/rx-visual.spec.ts-snapshots/general-a4-en-chromium-win32.png tests/e2e/rx-visual.spec.ts-snapshots/general-a4-30-medicines-chromium-win32.png tests/e2e/rx-visual.spec.ts-snapshots/paediatric-a5-bilingual-chromium-win32.png tests/e2e/rx-visual.spec.ts-snapshots/derma-a4-hindi-chromium-win32.png tests/e2e/rx-visual.spec.ts-snapshots/general-a5-long-hostile-chromium-win32.png package.json docs/DECISIONS.md docs/PROGRESS.md docs/SETUP.md AGENTS.md
Set-Location E:\projects\clinicpad; git status --short
Set-Location E:\projects\clinicpad; git commit -m "docs: record Phase 1C decisions (ADR-0032..0035), visual checks, and progress" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

The five PNG names are the ones Step 2 wrote (check them with `Get-ChildItem tests/e2e/rx-visual.spec.ts-snapshots -Name`; a different platform suffix means a different OS wrote them). If Step 2 changed `tsconfig.json`, add it to the `git add` line. `git status --short` before the commit must show nothing else unstaged.

---

## Self-review

**Spec and roadmap coverage**
- 1.5 Template renderer: the legacy preview's content (doctor and clinic header, timings/footer lines, patient name/age/gender/date, vitals line with °F, history/complaints/diagnosis/drug history, examination notes, ℞ mark, M/A/E/N medicine table with SOS, food, periodicity and duration value + unit, investigations with instructions, advice, follow-up date and reason, signature) is drawn from data by `renderPrescription` (Task 4) from the real `ClinicalVisitView` / `ItemView` shapes (`src/server/services/rx-mapping.ts`); three built-in templates as data (Task 4); A4/A5 (Tasks 3–4); English/Hindi/bilingual labels reusing `src/lib/translations.ts` (Task 3); pure, server-usable, HTML string out, same output for print, PDF, and later sharing (Tasks 4, 9); the Phase 2 seam is `TemplateRef.kind` + `RenderedDocument.format` with nothing of Phase 2 built (Tasks 3–4).
- Clinic and doctor profile data replacing the hard-coded header: schema (Task 1), validation on the shared cleaning helpers, services, actions, audit (Task 6), Settings UI with upload constraints (Task 7); storage decision recorded (decisions 15–16, ADR-0035).
- 1.6 Server PDF: Gotenberg Chromium route behind `PdfEngine` with timeouts, size/page caps, health check (Task 8); routes with typed errors and a typed 500, "Download PDF" and "Print" (Tasks 9–10); local Docker service and CI (Task 8); print CSS and repeating header (Task 4); consistency across engines handled by embedded fonts and the PDF as canonical copy, checked by the layout spec and screenshots (Task 11); desktop behaviour stated and verified (decision 19, Task 11 Step 3).
- 1.9 Audit for print/download: `prescription.printed` and `prescription.pdf_downloaded` with ids and counts (Task 9); settings changes audited with field names (Task 6); finalize's audit payload unchanged (Task 5).
- Design problems: (1) print metadata and caching — `prescription_outputs` (composite key, draft trigger), no cache, deterministic HTML hash (Tasks 1, 9; ADR-0033); (2) demographics at finalize — `render_snapshot` written by the finalizing UPDATE of the real `finalizePrescription` (lock order, revision check, numbering by `parentPrescriptionId`, parent flip, `clinicalSummary` audit, `23000` mapping unchanged), signed only by the finalizer, legacy rows render live with a note, the page shows the frozen name (Tasks 5, 10; ADR-0032); (3) hostile text and no fetching — escaping builder, allow-list checker, CSP, JS-disabled Gotenberg, network probe, 30-medicine and Devanagari tests, NUL refused in settings (Tasks 2, 4, 6, 8, 11); (4) tenant isolation and authorization — session-only context, `rx.read`, `settings.clinic`/`settings.profile`, cross-tenant and malformed ids → 404, composite keys checked by the existing guard test (Tasks 1, 5, 6, 9); (5) drafts preview only with watermark and a page notice for read-only roles, superseded versions marked and read-only, Repeat/Amend only on the current version (Tasks 4, 9, 10).
- Plan 1A/1B follow-ups assigned to this plan: middleware matcher (Task 9); unmarked drafts and superseded versions for read-only roles (Task 10); finalized view reading the live patient row (Tasks 5, 10, decision 22); owner without a doctor profile warned (Tasks 6, 10, decision 3).

**Reconciliation with the code at HEAD `4747932`:** migrations are `0013`/`0014` (0012 is the last); ADRs are 0032–0035 (0027–0031 are Plan 1B's); every new tenant-owned key is composite against an existing `*_tenant_id_uq`; `finalizePrescription` is printed as the current function plus three marked changes; the page is printed as the current page (conflict refresh state, `notFound()` for every other failure, `AllergyBanner`, `canFinalize`, `DiscardDraftForm`, `RepeatForm`) plus the panel; `tests/unit/prescription-page.test.tsx` keeps its eight tests; `granted` in `tests/unit/permissions.test.ts` gains the two new actions; settings validation uses `cleanInput`/`cleanOptionalText`/`hasNoNul` so a NUL is refused; e2e helpers wait with `waitForEditor` and use `exact: true`; route handlers follow the catalogue route's typed-500 pattern; `git add` lines name files; commit trailers name the model that wrote them.

**Placeholder scan:** every code step contains complete code and every command has its expected output. The conditional instructions are explicit rules, not gaps: ADR numbers are re-checked (Task 11), ADR dates are the day Task 11 runs, the Gotenberg tag falls back to the newest two-week-old `8.x.y` if `8.11.0` cannot be pulled (Task 8), Playwright's path alias may need `"baseUrl": "."` (Task 11), the clinic/doctor asset keys become deferrable only if tenant offboarding trips them (Task 1), the screenshot file names are the ones Playwright writes (Task 11), and test totals start from the baseline recorded in Prerequisites (a Plan 1B fix wave may add tests first).

**Type consistency:** `RenderSnapshot` (Task 3, inferred from `renderSnapshotSchema`) is what `buildRenderSnapshot` returns and `finalizePrescription` stores (Task 5), what fixtures build (Task 3), and what the page reads for the frozen name and `printedWithout` (Task 10). `RxDocument`, `RxVisit`, `RxItem`, `RenderAssets`, `RenderedDocument`, `PaperSpec`, `ImageAsset` (Task 3) are consumed by `renderPrescription` (Task 4), `loadRxDocument` (Task 5), `PdfEngine` (Task 8), and `rx-output.ts` (Task 9). `RxItem` has exactly the eighteen fields of `ItemView`; `RxVisit` is `ClinicalVisitView` without `id`. `PdfOutcome.pdf` is an `ArrayBuffer` everywhere (engine, fake, route body). `AssetPreview` (Task 5) is used by the settings views (Task 6) and `ImageUploadForm` (Task 7). `SettingsFormState` (Task 6) is the state of every settings form (Task 7). `ProfileGap` (`"noDoctorProfile" | "doctorName" | "registrationNo"`, Task 6), `VersionRef` (Task 5), `OutputSummary` (Task 9), and `PrintGap` (Task 10) are the props of `RxOutputPanel` (Task 10). `sharedFakeEngine`/`resetFakeEngine` (Task 8) are what Task 9's mock returns. `SnapshotSources.prescriberUserId` is `ctx.userId` in finalize and `finalized_by` in live rendering (Task 5). Labels asserted by e2e specs match the components: "Clinic name" … "Label language", "Save pad", "Name on prescriptions" … "Registration council", "Save profile", "Clinic logo", "Signature", "Upload", "Remove", "Saved.", "Image saved.", "Print", "Download PDF", "Preview pad", "Complete your profile", "Prescription print frame", "version 1", "version 2", and the notices "This draft is not a prescription yet", "Superseded by", "now recorded as". The document contract `data-rx="ready" | "error"` is produced in Tasks 4 and 9 and read in Task 10.

**Review Focus coverage:** (1) reprint after edits — `render-snapshot.test.ts` (patient, clinic, logo, doctor, template changed; amendment gets its own) and the e2e rename check (pad and page header); (2) hostile text — `self-contained.test.ts`, `rx-html.test.ts`, the 9-way hostile matrix and bidi/long-word tests in `rx-render.test.ts`, overflow and request checks in `rx-visual.spec.ts`; (3) PDF service failures — every failure mode in `gotenberg.test.ts`, 503/422/500 with no output row in `rx-output-routes.test.ts`, the e2e "down" branch, and a signed-out download handled in `OutputActions`; (4) cross-tenant, malformed, and unauthorized access — `render-snapshot.test.ts`, `pad-settings.test.ts`, `settings-actions.test.ts`, `rx-output-routes.test.ts`, the signed-out e2e; (5) hostile uploads — `image.test.ts`, the upload rows in `pad-settings.test.ts`, `settings-actions.test.ts`, and the SVG-as-PNG e2e step; (6) page and pad truthfulness — "who signs the pad" in `render-snapshot.test.ts`, the NUL and no-profile rows in `pad-settings.test.ts`, the seven new `prescription-page.test.tsx` tests, and the read-only-draft, superseded, and frozen-name steps of `rx-output.spec.ts`.

**Known gaps carried forward (not part of this plan):** page numbers only in the Gotenberg PDF, not in browser print; no automated Safari print check (the project runs Chromium only; a human should print one pad from Safari on a Mac or iPad before the exit criterion "consistent across Chrome, Safari, and the print dialog" is ticked); the signature block follows the content instead of being anchored to the bottom of the last page; `outputFileTracingIncludes` for the fonts is verified only at the first deployment; the new Hindi pad labels need a native speaker's review; ages on the pad use the UTC calendar day (Plan 1D); demo seed prescriptions print from live data with the pre-snapshot note; a draft preview may mix two concurrent saves for a moment; no malware scan or EXIF stripping of uploads (Phase 2.1); no PDF cache (ADR-0033); every `rx.read` role can print full clinical content (the data-minimisation decision of ADR-0030 is still open); an owner without a doctor profile can still finalize (warned, not blocked; a human decision); per-doctor or per-branch template assignment, QR codes, and scripts beyond Devanagari wait for Template Studio; sharing (WhatsApp, email) is Plan 1D.
