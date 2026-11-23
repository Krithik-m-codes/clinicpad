# AGENTS.md — ClinicPad Project Memory

This file is the single source of truth for any AI agent or developer working on ClinicPad. Read it before touching code. Update it when reality diverges from what is written here.

**Last updated:** 2026-11-19
**Product stage:** pre-alpha / foundation
**Working name:** ClinicPad (verify trademark and domain before public launch)

---

## 1. What we are building

ClinicPad is a **clinic operating system with a prescription-first wedge**.

- A doctor uploads their existing Word or PDF prescription pad.
- ClinicPad turns it into a data-bound template ("Template Studio").
- The doctor then gets patients, prescriptions, appointments, billing, WhatsApp sharing, and analytics around it.
- It works offline, on the web and as a desktop app, and is designed to be sold to clinic owners in India first, then internationally.

**Do not drift into building a generic EMR.** The differentiator is:
1. Bring-your-own-pad (BYOP) template fidelity.
2. Offline-first reliability.
3. WhatsApp-native distribution.
4. Owner-grade business visibility.
5. White-label/reseller distribution.

Read `docs/PRODUCT_SPEC.md` before proposing features. Read `docs/ROADMAP.md` before starting work. Update `docs/PROGRESS.md` when you finish something.

---

## 2. Current state (be honest)

The repo is a copy of the original `doctor-prescription-app`:

- Next.js 15.5 (App Router) + React 19 + Tailwind v4 + shadcn/ui.
- Tauri v2 desktop wrapper (`src-tauri/`).
- Client-only state via `src/contexts/PrescriptionContext.tsx`.
- Persistence via IndexedDB (`src/lib/db/`).
- Hard-coded doctor identity and design in `src/app/(legacy)/(perscription)/preview/page.tsx` (the legacy desktop shell only; the web app prints from clinic and doctor settings since Plan 1C).
- That original app (legacy routes) still exists under `src/app/(legacy)/` and is what the desktop build exports.
- No billing, no appointments, no offline sync for the web app. Sharing exists as consent-gated, expiring links sent through `wa.me` or email (Plan 1D), not through the WhatsApp Cloud API. Built-in pad templates and PDF exist since Plan 1C; Template Studio exists for overlay pads (a background image plus field boxes, Phase 2A); DOCX templates do not.
- `next.config.ts` builds a normal server app for the web; the desktop export is a separate build (`scripts/build-desktop.mjs`, ADR-0021). Build errors are no longer ignored.

**Nothing here is production-safe for patient data yet.** There is no staging deployment, and the legacy IndexedDB data is demo data.

**Repository state (2026-11-18):** Phase 0 and Phase 1A–1D are code complete on branch `phase-1-prescription-mvp`; the automated gate (`node scripts/verify-gate-0.mjs`: 2,121 unit/integration tests passed + 1 skipped in 103 files, 51 e2e passed and 8 opt-in screenshot tests skipped; `npm run test:visual` 24 passed) passed on 2026-11-18 (see `docs/PROGRESS.md` sections 4.8 to 4.11). What exists: Auth.js credentials login and clinic sign-up, Postgres with row-level security (forced policies) and composite same-tenant foreign keys, a role matrix enforced in services, patients (register, edit, search, duplicate warning, archive and restore), the prescription lifecycle (draft, save, finalize, amend with a reason, repeat) with database-enforced immutability, per-clinic Rx numbering, an append-only audit log, Vitest unit/integration tests and Playwright e2e. Phase 1B adds the server-backed clinical form (vitals, history, investigations, structured medicines with dose schedules), the global + clinic medicine catalogue with per-doctor favourites (`npm run db:seed:catalogue`), revision-checked draft autosave, and discarding drafts / withdrawing amendments. Phase 1C adds the prescription pad: a pure renderer (`src/lib/rx-render/`) with General, Paediatric, and Derma templates on A4/A5 with English, Hindi, or bilingual labels; clinic pad and doctor profile settings with validated logo and signature uploads (`clinic_assets`); print details frozen at finalize and signed by the finalizer (`prescriptions.render_snapshot`); browser print and Gotenberg PDF download with an append-only `prescription_outputs` log. Phase 1D adds DPDP-style consent (`patient_consents`), hashed expiring share links with a public `/s/<token>` route and a masked share log, WhatsApp `wa.me` and email sharing behind a per-clinic switch, patient CSV import with a validation report and duplicate decisions, patient history filters, archive and restore, clinic-timezone dates, and database hardening (rows born as drafts, CHECKs mirrored in the schema, an RLS guard); Next is on 15.5.29 with a vendored React patch (ADR-0042). What does not exist: DOCX templates, the WhatsApp Cloud API and delivery status, offline sync, billing, staging. **Phase 2A (overlay pads, 2026-11-19, migrations 0024 to 0028, ADR-0043 to ADR-0048):** Template Studio for overlay pads. A doctor or owner uploads a photo, scan, PNG/JPEG or PDF (read only in a sandboxed browser frame), places field boxes and one flow region, previews with sample or real data, publishes an immutable version, assigns it to the clinic or a doctor, and finalizes prescriptions that freeze the pad (snapshot v2, content hash). Uploads are scanned by ClamAV before anything is stored. A `designer` role (templates only, expiring membership) exists, provisioned by raw SQL today. What does not exist: DOCX pads (2B), object storage, a designer invite UI (2C), a stored as-issued PDF, a per-printer print-time offset (the offset is in the definition today). Firefox and Safari print overlay pads through the Gotenberg PDF until a human confirms browser print there. Decisions: `docs/DECISIONS.md` (ADR-0019 to ADR-0048 cover the current state).

### What is reusable

| Area | Reuse |
|---|---|
| Prescription form UX | `src/components/prescription/MedicalForm.tsx`, `DataMultiSelect`, `SearchableMedicineDropdown` |
| Domain types | `src/types/index.ts` (extend, don't rewrite) |
| Print/preview layout | `src/app/(perscription)/preview/page.tsx` (extract into a template renderer) |
| CSV import | `src/app/manage/page.tsx` + `sample_data/*.csv` |
| UI kit | `src/components/ui/*` |
| Tauri shell | `src-tauri/*` |
| Hindi/English strings | `src/lib/translations.ts` |

### What must be replaced

| Area | Replacement |
|---|---|
| IndexedDB-only data | Server Postgres + local-first sync (Phase 4) |
| Hard-coded doctor header | Done for the web app (clinic pad + doctor profile, Plan 1C); the legacy preview remains for the desktop shell |
| Single prescription design | Template Studio (built-in + DOCX) |
| `alert()` / `window.location` flows | Proper app shell, toasts, routing |
| Static export-only config | Dual build: web (server) + desktop (static/Tauri) |

---

## 3. Non-negotiable invariants

These are product and legal constraints, not preferences.

1. **Tenant isolation.** Every clinical/business row carries `tenant_id`. Postgres RLS must enforce it. Never trust a client-supplied tenant ID.
2. **Audit everything clinical.** Creating, amending, printing, sharing, or deleting a prescription must write an append-only audit event.
3. **Never overwrite a signed prescription.** Amendments create a new version with a reason. Medico-legal record integrity is more important than convenience.
4. **Patient data stays in the region.** India tenant data in India (ap-south-1 / Mumbai). No cross-border processing without an explicit legal basis.
5. **Consent is explicit.** Capture DPDP-style consent (purpose, version, timestamp) before sharing records with third parties.
6. **No medical diagnosis by AI.** AI features are documentation assistants. Never present AI output as a diagnosis or treatment recommendation.
7. **Secrets never enter the repo.** Use `.env.local` / deployment secrets. `.env*` is git-ignored.
8. **Uploads are hostile.** Validate type/size, scan for malware, strip macros, run conversions in a sandbox with no network.
9. **Offline must not lose data.** Writes go to a durable local outbox before the UI confirms success.
10. **No claim of compliance until certified.** "ABDM-ready" is acceptable only when the integration is actually built and tested. Do not market HIPAA/GDPR compliance before controls and agreements exist.

---

## 4. Architecture in one screen

```
Web (Next.js on Vercel bom1) ──┐
Desktop (Tauri + SQLite) ──────┼──> API / Server Actions ──> Postgres (Supabase Mumbai, RLS)
PWA (IndexedDB) ───────────────┘         │                    ├─ Storage (S3-compatible)
                                         │                    ├─ Redis / queue
                                         ├─ Doc engine (Gotenberg + LibreOffice + pdf2docx + OCR)
                                         ├─ WhatsApp Cloud API
                                         ├─ Razorpay / Stripe
                                         └─ Email (Resend)
```

Full detail: `docs/ARCHITECTURE.md`. Data model: `docs/DATA_MODEL.md`.

**Decisions already made (see `docs/DECISIONS.md`):**
- Next.js App Router + TypeScript + Tailwind + shadcn/ui.
- Postgres with row-level security for multi-tenancy.
- Supabase for MVP (Mumbai), with self-host path.
- Drizzle ORM.
- Gotenberg + LibreOffice for DOCX→PDF; `pdf2docx` + OCRmyPDF/Tesseract for PDF→DOCX.
- docxtemplater for DOCX placeholder rendering.
- Tauri v2 + SQLite for desktop; IndexedDB/PWA for web offline.
- Razorpay (India) + Stripe (international).
- WhatsApp Cloud API behind a provider abstraction.

---

## 5. Conventions

### Code
- TypeScript strict. Do not add `any`; if unavoidable, isolate and comment.
- Prefer server components; use client components only for interactivity.
- Keep files focused. If a component exceeds ~250 lines, extract.
- Domain logic lives in `src/lib/` or `src/server/`, not in components.
- Use the existing shadcn/ui primitives; do not introduce a second UI kit.
- Use Zod schemas at every boundary (API input, forms, imports).
- Dates: store UTC ISO strings; render in clinic timezone (default `Asia/Kolkata`).
- IDs: UUIDv7 for new records.
- Money: integer paise, never floats. Currency code on every amount.
- Every mutation returns a typed result; no thrown strings.

### Naming
- Database: `snake_case`, plural tables, `tenant_id` / `branch_id` columns.
- TypeScript: `camelCase` values, `PascalCase` types/components.
- Files: `kebab-case.tsx` for components, `camelCase.ts` for modules (match the existing repo where practical).

### Git
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- One logical change per commit. Run `npm run lint` and `npm run typecheck` before committing once those scripts exist.
- Never commit `.env*`, build output, `node_modules`, `src-tauri/target`, or `src/.dist`.

### Testing
- Unit: Vitest.
- Component: Testing Library.
- E2E: Playwright (critical flows: login → patient → Rx → PDF).
- Template rendering: visual regression snapshots (Playwright screenshot diff).
- Clinical calculations: property-based tests where practical.
- TDD is required for new domain logic (see the `test-driven-development` skill).

---

## 6. Commands

```bash
npm install
npm run dev            # Next.js dev server
npm run build          # static export (legacy Tauri build)
npm run lint           # ESLint
npm run tauri:dev      # desktop dev
npm run tauri:build    # desktop installer

# after Phase 0 adds them:
npm run typecheck
npm run test
npm run test:e2e
npm run db:generate
npm run db:migrate
npm run db:seed
npm run db:seed:catalogue   # global medicine and clinical-term lists (idempotent)
npm run db:sweep-test-tenants   # dev only: leftover test tenants (add -- --apply)
docker compose up -d gotenberg   # PDF service for Download PDF
docker compose up -d clamav       # upload scanner (needed by uploads and the pad e2e)
npm run test:pdf-frame            # opt-in: PDF intake frame in Chromium, Firefox and WebKit
npm run test:visual   # print-layout screenshots (opt-in)
```

Environment: Node 22+, npm 11+, Git 2.5x, Docker Desktop (for Postgres/Gotenberg), Rust (desktop only).

---

## 7. Workflow (Superpowers)

Use the installed skills in this order:

1. **`brainstorming`** — for any new feature or ambiguous request. Do not write code before the design is approved.
2. **`writing-plans`** — turn an approved design into a phased implementation plan in `docs/superpowers/plans/`.
3. **`executing-plans`** or **`subagent-driven-development`** — implement.
4. **`test-driven-development`** — write the failing test first for domain logic.
5. **`systematic-debugging`** — for any bug or unexpected behavior.
6. **`verification-before-completion`** — run the verification commands and show output before claiming done.
7. **`requesting-code-review`** / **`receiving-code-review`** — before merging significant work.

Skills live at `~/.agents/skills` (OpenCode) and `~/.claude/skills` (Claude Code). Verify with `scripts/check-superpowers.ps1`.

**Do not skip the design gate** for new subsystems. Small, well-scoped fixes can use the bounded path (short design in chat + approval).

---

## 8. Where we are / what is next

See `docs/PROGRESS.md` for the live tracker. Phase 0 (foundation) is code complete and Phase 1A (patients and prescription core) is code complete; the open items are the Phase 0 ops carry-overs (staging, CI on GitHub, pre-commit hook, 360 px check, MFA note). Plan 1B (clinical form, medicine catalogue, autosave, discard) is code complete as well. Plan 1C (pad renderer, server PDF, print, clinic pad and profile settings) and Plan 1D (sharing, consent, CSV import, history, hardening) are code complete too. Phase 1 (1A–1D) is code complete. Phase 2A (overlay pads) is code complete too (docs/PROGRESS.md section 4.12). Next: staging and a design-partner pilot (human decisions in sections 4.11 and 4.12). Phase 2B (DOCX) starts only after pilot evidence, Gate 1, the S3 finding (`docs/spikes/2026-11-18-s3-docxtemplater.md`) and staging with the document-conversion container egress-blocked; its ADRs start at ADR-0049 and its migrations at 0029. Read `docs/ROADMAP.md` before starting it.

---

## 9. Key product questions still open

Track answers in `docs/DECISIONS.md`:

- Final product name and domain.
- India-first vs India + international from day one (current assumption: India first, international after Phase 5).
- Supabase cloud vs self-hosted Postgres for the first 100 clinics.
- WhatsApp: direct Meta Cloud API vs a BSP for faster onboarding.
- Whether to offer a free tier (current assumption: yes, capped at 100 Rx/month with branding).
- Desktop-first vs web-first for the beachhead (current assumption: web-first, desktop in Phase 4).
- Pricing: ₹499 vs ₹799 solo entry (current assumption: ₹499 annual / ₹599 monthly).

---

## 10. Things that will bite you

- **The desktop build is a static export and cannot contain server routes.** `scripts/build-desktop.mjs` stashes server-only routes (everything under `src/app/(app)`, auth, API, and the public share route `src/app/s`) and exports the legacy shell only. A new server-only route directory outside `(app)` must be added to its list (ADR-0021).
- **Prescription lock order (there are two).** Lock the prescription row `FOR UPDATE` before touching its items or its visit. Another order can deadlock (`40P01`) against a finalize. Finalizing an amendment locks the child (the amendment draft) first and then the parent (`finalizePrescription`), while `amendPrescription` locks the parent. That is safe only because amend's open-amendment check returns before it writes anything; any rewrite of `amendPrescription` must keep that order (check first, write after) (ADR-0023). The immutability triggers (ADR-0023) reject edits of finalized records with SQLSTATE `23000` even on the admin connection; do not work around them.
- **Composite-FK pattern for new tenant tables.** The parent gets `UNIQUE (tenant_id, id)`; the child references `(tenant_id, x_id)`. Composite keys cover every DECLARED relation between tenant-owned tables, and the guard test pins that. Migration 0010 added `unique (tenant_id, id)` and `unique (tenant_id, user_id)` on `doctors` and composite keys for `visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id`; a doctor, branch, or template version referenced by a signed record cannot be deleted. Name constraints explicitly (under 63 characters), and use `ON DELETE SET NULL (col)` for nullable parents. A guard test in `tests/integration/tenant-fk.test.ts` fails on a single-column key into a tenant-owned table (ADR-0025). drizzle-kit emits the foreign key before the unique constraint it needs; reorder by hand.
- **`repeatPrescription` refuses superseded (`amended`) versions** and drafts; only the latest `finalized` version can be repeated (ADR-0026). It also refuses a source with an open amendment draft, and reads the source `FOR SHARE` (ADR-0031).
- **Discard locks only the draft row.** `discardDraft` never locks the parent; amend's plain select of the open child is safe against a pending discard, and `repeatPrescription` never locks a child (ADR-0023, ADR-0031).
- **Migrations cannot backfill clinical rows.** The immutability triggers reject `UPDATE` on finalized `visits`, `prescriptions`, and `prescription_items`; add nullable columns or constant defaults and read old rows with a fallback.
- **Server actions run one at a time.** Use GET route handlers for anything a client component fetches while typing (see `/api/catalogue/search`).
- **A NUL is refused, never stripped.** Validate free text through `cleanInput`/`cleanOptionalText`/`cleanRequiredText` (`src/server/validation/text.ts`); `cleanText` alone strips NUL and is meant for search terms and keys.
- **Windows vitest needs an UPPERCASE drive letter** in the working directory (`E:\...`). A lowercase `e:` loads two vitest instances and every test fails.
- **Docker Desktop on this machine lives under `%LOCALAPPDATA%\Programs\DockerDesktop`**, not Program Files.
- **Playwright `getByRole("alert")` also matches Next's route announcer.** Scope the locator or use a test id.
- **The React that Next 15.5 bundles is patched on install.** Its `pingSuspendedRoot` drops a ping that arrives during the render, which left server actions with `revalidatePath` stuck on "Saving…"/"Uploading…" in production builds (upstream fix facebook/react#36134, not in any Next 15.x). `postinstall` runs `scripts/patch-react-ping.mjs` on `node_modules/next/dist/compiled/react-dom*`; `npm install --ignore-scripts` skips it, but every build (`prebuild`, `prebuild:web`, `prebuild:desktop`) runs `node scripts/patch-react-ping.mjs --check`, which patches and fails the build if the bundle is neither patched nor recognised (ADR-0042; Next is on 15.5.29, which still needs it). `tests/unit/vendored-react-ping.test.ts` fails while the installed bundle has the bug; after a Next upgrade where the script warns that it does not recognise the code and that test passes, the bundled React has the fix and the script can go.
- **`next start` locally needs `AUTH_TRUST_HOST=true`** (Auth.js refuses the host otherwise), and production-mode sharing and PDF need an https `NEXT_PUBLIC_APP_URL` and `GOTENBERG_URL`, so the sharing and rx-output e2e specs only pass against `npm run dev` locally.
- **`/s/<token>` is the only route without a session.** It finds the link through `withShareToken` (policy `share_link_by_token`) and does everything else in `withTenant`; never `adminDb`, never patient or clinic details on the interstitial, and every unusable link answers the same 404 (ADR-0037). The token is in the URL path, so logs must not retain it; the public rate limits are per process and key on `SHARE_CLIENT_IP_HEADER` only.
- **Lock the patient row before writing that patient's share links**: `FOR SHARE` to create one, `FOR UPDATE` (or the patient `UPDATE`) to withdraw consent or archive (ADR-0036). No sharing path locks a prescription. `createShareLinkIn` trusts its caller for the `rx.share` permission; only `src/server/services/sharing.ts` calls it.
- **Rows are born as drafts (0017).** Insert visits and prescriptions as drafts and finalize by UPDATE (prescription, then visit); a `finalized -> amended` flip needs a finalized child first, and `draft -> amended` is refused. Test fixtures that flip a parent must finalize a version 2 first.
- **Every CHECK constraint is declared in the Drizzle schema too** (`tests/integration/schema-checks.test.ts`). A new CHECK on a table with existing rows goes in `NOT VALID` and is validated in the same migration (see 0017/0018); run `npm run db:sweep-test-tenants` on a dirty development database.
- **Patient import commits under a per-tenant advisory lock and numbers patients with `allocateNumbers`** (one block); keep both, or a double-click imports twice or burns numbers (ADR-0039).
- **Tests never send email or call providers.** Pass `createFakeEmailProvider()` (`tests/helpers/fake-email.ts`); `getEmailProvider()` is null without `RESEND_API_KEY`. Resend click tracking must stay off (ADR-0038).
- **`as(role)` in `createTestTenant` returns a fresh random user id for every role except owner and doctor.** Capture one context when a test asserts on the actor.
- **Finalized prescriptions print from `render_snapshot` and, for overlay pads, from their frozen template version.** Never render a finalized prescription from live patient, clinic, or doctor rows, nor with a template's current version; add new printed fields to the snapshot schema (`src/lib/rx-render/snapshot.ts`) and bump `v`. Built-in pads keep `v: 1`; only overlay pads are `v: 2`. The finalizer signs the pad: `buildRenderSnapshot` never falls back to the visit's doctor once there is a finalizer, and it must run inside `withTenant` (it relies on RLS; never call it with `adminDb`). Finalize fails closed (no clinic row, an unparseable snapshot, or a damaged pad) and burns no Rx number (ADR-0032). The overlay definition schema v1 and its geometry rules are FROZEN (ADR-0044): the content hash is the SHA-256 of the canonical JSON of the definition AS STORED (services store `parseOverlayDefinition` output; never hash raw jsonb), a literal golden hash is pinned in a unit test, and a reprint (`loadOverlayIn`) parses with the frozen v1 parser, re-hashes bytes and definition, skips the publish-time geometry rules, and refuses on any mismatch (`TEMPLATE_DAMAGED_MESSAGE`). Binding (identity, bound doctor) is per template VERSION, never per template. The renderer code, Chromium and fonts are NOT frozen; only the renderer version is recorded per output.
- **Every document must pass `checkSelfContained()`.** Build HTML only with `html`, `userText`, and `raw` (`src/lib/rx-render/html.ts`); no external URLs, scripts, fonts, CSS comments, or raw markup inside attributes (the `html` tag throws). Changing the checker or the Gotenberg flags means re-running `tests/integration/gotenberg-smoke.test.ts` with Gotenberg up (ADR-0034).
- **PDF layout needs a human look after template or CSS changes.** Run `npm run test:visual`, then read the PNGs and the real Gotenberg PDFs it writes to `test-results/rx-visual-pdf/` (Chromium footers shrink-wrap without `html{width:100%}`, narrow table headings split mid-word, and screenshots do not show page breaks).
- **The legacy `/preview` page still hard-codes a Hindi doctor header and manipulates `document.body.innerHTML` to print.** It serves only the desktop shell until Phase 4; the web app prints through `src/lib/rx-render/`.
- **PDFs need Gotenberg** (`docker compose up -d gotenberg`; `GOTENBERG_URL` is mandatory in production). Without it, Download PDF shows an error. Print still works for built-in pads, and for overlay pads in Chromium browsers; **for overlay pads in Firefox and Safari, Print goes through the Gotenberg PDF** (`OVERLAY_BROWSER_PRINT` in `src/lib/templates/print-support.ts`), so it fails without Gotenberg there. The pad's own page numbers need Gotenberg's footer.
- **A finalized overlay prescription prints only from its frozen template version, verified by hash** (see the `render_snapshot` bullet). A template with a published version cannot be deleted (archive it); published versions and every template file are frozen on every connection. Lock order: `lockTemplateQuota` (advisory) first, then the template row (`FOR UPDATE` to change it or its versions, `FOR SHARE` to assign it), then clinic or doctor rows; finalize takes no template lock (ADR-0043).
- **Uploads go through route handlers with `readCapped`, never server actions (1 MB).** Scan before any transaction; a scanner that is down refuses the upload. `CLAMAV_DISABLED_FOR_DEVELOPMENT=1` is development only and also needs `CLAMAV_DISABLED_ACK`. Never commit the EICAR string: tests decode it from base64 (`tests/helpers/eicar.ts`) because Windows Defender quarantines the file otherwise (ADR-0045).
- **The ClamAV container (`docker compose up -d clamav`) is part of the gate.** `CLAMAV_REQUIRED=1` or `CI=true` turns the scanner smoke test from a skip into a failure; it needs about 2.5 GB of memory and runs with `CLAMAV_NO_FRESHCLAMD=true` (signatures come from the image; `clamav-update` is the only container that may have egress). Run `pad-settings` and `templates` e2e with it up.
- **PyMuPDF is a test-only dependency (AGPL).** `overlay-spacer-pdf.test.ts` needs `pip install pymupdf==1.28.0`; with `CI=true` or `GOTENBERG_REQUIRED=1` it FAILS when PyMuPDF is missing, locally it skips. Never import it from `src/` or install it on a server.
- **Run e2e against `next dev --turbopack`** (the project default). Webpack dev exhausts Postgres connections ("too many clients"). A cold compile of `/templates/[id]` or `/pdf-frame` can exceed 15 s, so the e2e specs warm them. Sharing and overlay specs need `NEXT_PUBLIC_APP_URL` and `AUTH_URL` set to the test server's origin (a temporary Playwright config on a free port).
- **`NEXT_PUBLIC_APP_URL` is also the PDF frame's origin.** `/pdf-frame/*` builds its CSP and message-origin check from it and answers 503 in production without it; reaching the app on both `www.` and the apex domain breaks the frame on one of them (ADR-0046). `PDF_INTAKE=off` is the kill switch.
- **pdf.js runs only inside `/pdf-frame/*`** (an opaque-origin sandboxed iframe, `pdfjs-dist` pinned exactly); app code never imports `pdfjs-dist` (tests may, in Node). `src/app/pdf-frame` is in `SERVER_ONLY` of `scripts/build-desktop.mjs` (the desktop export stashes it). After any pdfjs upgrade run `npm run test:pdf-frame`.
- **Designer accounts are provisioned by raw SQL today** and MUST carry `memberships.expires_at` (a CHECK refuses otherwise; the e2e helper `setRole` uses seven days). An audited provisioning script with expiry is required before a real clinic uses a designer (ADR-0048). A designer sees templates only.
- **drizzle-kit asks about renames** when one generate both drops and adds columns of a table: generate the drop alone first (0024). A new enum value cannot be used as an enum literal in the same migration run (all pending migrations share one transaction): compare `role::text` (0028).
- **Tests simulate tampering with `set local session_replication_role = replica`** on the admin connection (superuser only), which skips the immutability triggers; CHECK constraints still apply.
- **Gotenberg is pinned to 8.40.0 by digest** in `docker-compose.yml`, `ci.yml` and the smoke test (`engine-pins.test.ts` keeps them equal). After any engine bump run `npm run test:visual` and review the PNGs and the real PDFs.
- **IndexedDB repositories are client-only.** They cannot be called from server components.
- **No test coverage of the legacy preview page.** The new app has unit, integration and e2e tests; the legacy routes do not. Add tests before refactoring the preview page.
