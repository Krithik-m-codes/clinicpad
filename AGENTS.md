# AGENTS.md — ClinicPad Project Memory

This file is the single source of truth for any AI agent or developer working on ClinicPad. Read it before touching code. Update it when reality diverges from what is written here.

**Last updated:** 2026-11-06
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
- No authentication, no multi-tenancy, no server database, no billing, no appointments.
- `next.config.ts` uses static export for Tauri and currently ignores TypeScript/ESLint build errors.

**Nothing here is production-safe for patient data yet.** Treat all existing data as demo data.

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

See `docs/PROGRESS.md` for the live tracker. The next milestone is **Phase 0 — Foundation**:

1. Rebrand metadata and package name.
2. Add lint/typecheck/test scripts and make the build strict.
3. Add Postgres + Drizzle + RLS skeleton.
4. Add auth and clinic onboarding.
5. Add the app shell and role-aware navigation.
6. Seed demo clinic data.

Do not start Phase 1 (prescription MVP) until Phase 0 exits cleanly.

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

- **`next.config.ts` has `output: "export"`.** Server features (auth callbacks, API routes that need a server) will not work in that mode. Phase 0 must split web and desktop builds.
- **`ignoreBuildErrors: true`.** Hidden type errors are accumulating. Turn this off in Phase 0.
- **Hard-coded Hindi doctor details** in the preview page. Extract to data before any real clinic uses it.
- **IndexedDB repositories are client-only.** They cannot be called from server components.
- **Tauri print path manipulates `document.body.innerHTML`.** Fragile; replace with the template renderer.
- **PDF generation today is browser-print based.** Server-side PDF is required for WhatsApp/email and consistent output.
- **No test coverage.** Add tests before refactoring the preview page.
