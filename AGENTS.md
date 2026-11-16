# AGENTS.md — ClinicPad Project Memory

This file is the single source of truth for any AI agent or developer working on ClinicPad. Read it before touching code. Update it when reality diverges from what is written here.

**Last updated:** 2026-11-16
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
- Hard-coded doctor identity and design in `src/app/(perscription)/preview/page.tsx`.
- That original app (legacy routes) still exists under `src/app/(legacy)/` and is what the desktop build exports.
- No billing, no appointments, no templates or PDF generation, no sharing, no offline sync for the web app.
- `next.config.ts` builds a normal server app for the web; the desktop export is a separate build (`scripts/build-desktop.mjs`, ADR-0021). Build errors are no longer ignored.

**Nothing here is production-safe for patient data yet.** There is no staging deployment, and the legacy IndexedDB data is demo data.

**Repository state (2026-11-16):** Phase 0 and Phase 1A are code complete on branch `phase-1-prescription-mvp`; the automated gate (`node scripts/verify-gate-0.mjs`: 385 unit/integration tests, 15 e2e) passed on 2026-11-16 (see `docs/PROGRESS.md` section 4.8). What exists: Auth.js credentials login and clinic sign-up, Postgres with row-level security (forced policies) and composite same-tenant foreign keys, a role matrix enforced in services, patients (register, edit, search, duplicate warning, archive), the prescription lifecycle (draft, save, finalize, amend with a reason, repeat) with database-enforced immutability, per-clinic Rx numbering, an append-only audit log, Vitest unit/integration tests and Playwright e2e. What does not exist: Template Studio and PDF, WhatsApp/email sharing, offline sync, billing, staging. Decisions: `docs/DECISIONS.md` (ADR-0019 to ADR-0026 cover the current state).

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
| Hard-coded doctor header | Clinic/doctor profile + template variables |
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

See `docs/PROGRESS.md` for the live tracker. Phase 0 (foundation) is code complete and Phase 1A (patients and prescription core) is code complete; the open items are the Phase 0 ops carry-overs (staging, CI on GitHub, pre-commit hook, 360 px check, MFA note). The next milestone is Plan 1B (clinical form, autosave). Read `docs/ROADMAP.md` before starting it.

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

- **The desktop build is a static export and cannot contain server routes.** `scripts/build-desktop.mjs` stashes server-only routes (everything under `src/app/(app)`, auth, API) and exports the legacy shell only. A new server-only route directory outside `(app)` must be added to its list (ADR-0021).
- **Prescription lock order.** Lock the prescription row `FOR UPDATE` before touching its items or its visit. Another order can deadlock (`40P01`) against a finalize. The immutability triggers (ADR-0023) reject edits of finalized records with SQLSTATE `23000` even on the admin connection; do not work around them.
- **Composite-FK pattern for new tenant tables.** The parent gets `UNIQUE (tenant_id, id)`; the child references `(tenant_id, x_id)`. `doctors` has no `(tenant_id, id)` unique key yet; the first table that references it must add one. Name constraints explicitly (under 63 characters), and use `ON DELETE SET NULL (col)` for nullable parents. A guard test in `tests/integration/tenant-fk.test.ts` fails on a single-column key into a tenant-owned table (ADR-0025). drizzle-kit emits the foreign key before the unique constraint it needs; reorder by hand.
- **`repeatPrescription` refuses superseded (`amended`) versions** and drafts; only the latest `finalized` version can be repeated (ADR-0026).
- **Windows vitest needs an UPPERCASE drive letter** in the working directory (`E:\...`). A lowercase `e:` loads two vitest instances and every test fails.
- **Docker Desktop on this machine lives under `%LOCALAPPDATA%\Programs\DockerDesktop`**, not Program Files.
- **Playwright `getByRole("alert")` also matches Next's route announcer.** Scope the locator or use a test id.
- **Hard-coded Hindi doctor details** in the preview page. Extract to data before any real clinic uses it.
- **IndexedDB repositories are client-only.** They cannot be called from server components.
- **Tauri print path manipulates `document.body.innerHTML`.** Fragile; replace with the template renderer.
- **PDF generation today is browser-print based.** Server-side PDF is required for WhatsApp/email and consistent output.
- **No test coverage of the legacy preview page.** The new app has unit, integration and e2e tests; the legacy routes do not. Add tests before refactoring the preview page.
