# ClinicPad — Progress Tracker

**Last updated:** 2026-11-06
**Current phase:** Phase 0 — Foundation (not started)
**Overall status:** 🟡 Foundation docs complete; code untouched

This is the live source of truth for *what is actually true*. Update it at the end of every work session. Do not mark a task done without evidence (command output, link, screenshot, or commit hash).

---

## 1. Snapshot

| Metric | Value |
|---|---|
| Product stage | pre-alpha / foundation |
| Codebase origin | copy of `doctor-prescription-app` |
| Git initialized | yes (`97a4af0`) |
| Tests passing | 0 (no test suite yet) |
| Build status | legacy static `npm run build` passes; strict dual-build not implemented |
| Paying clinics | 0 |
| Design partners | 0 |
| MRR | ₹0 |
| Current milestone | Phase 0 exit criteria |
| Next gate | Gate 0 — Foundation |

---

## 2. Phase status

| Phase | Status | Started | Completed | Evidence |
|---|---|---|---|---|
| 0 — Foundation | 🔴 not started | — | — | — |
| 1 — Prescription MVP | ⚪ not started | — | — | — |
| 2 — Template Studio | ⚪ not started | — | — | — |
| 3 — Clinic operations | ⚪ not started | — | — | — |
| 4 — Offline + desktop | ⚪ not started | — | — | — |
| 5 — Compliance + international | ⚪ not started | — | — | — |
| 6 — AI + ecosystem | ⚪ not started | — | — | — |

**Legend:** 🔴 blocked/not started · 🟡 in progress · 🟢 done · ⚪ not applicable yet

---

## 3. What has been done (foundation, pre-code)

| Date | Item | Evidence |
|---|---|---|
| 2026-11-06 | Explored original app (Next.js + Tauri + IndexedDB) | notes in `AGENTS.md` §2 |
| 2026-11-06 | Competitive and pricing research | `docs/MARKET_RESEARCH.md` |
| 2026-11-06 | Copied source into `E:\Shubpy\projects\clinicpad` excluding build artefacts | 240 files, ~20.6 MB |
| 2026-11-06 | Wrote product specification | `docs/PRODUCT_SPEC.md` |
| 2026-11-06 | Wrote architecture and data model | `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md` |
| 2026-11-06 | Wrote roadmap and GTM/pricing | `docs/ROADMAP.md`, `docs/GTM_PRICING.md` |
| 2026-11-06 | Wrote decisions log and setup guide | `docs/DECISIONS.md`, `docs/SETUP.md` |
| 2026-11-06 | Project memory for agents | `AGENTS.md`, `CLAUDE.md`, `README.md` |
| 2026-11-06 | Superpowers verification script | `scripts/check-superpowers.ps1` |
| 2026-11-06 | Formal design spec + Phase 0 plan | `docs/superpowers/specs/`, `docs/superpowers/plans/` |
| 2026-11-06 | Minimal rebrand + `.env.example` | `package.json`, `src/app/layout.tsx`, `.env.example` |
| 2026-11-06 | Git initialized with foundation commit | `git log` |

> Replace the last three rows with the actual outcomes if they differ. Keep this honest.

---

## 4. Phase 0 checklist

**Goal:** strict, multi-tenant, deployable skeleton. Exit only when every box is checked with evidence.

### 4.1 Repo and branding

- [ ] Remove `test.txt` and any stray scratch files
- [ ] `package.json` name is `clinicpad`, description updated, version reset to `0.1.0`
- [ ] `src/app/layout.tsx` metadata: title, description, icons, no "Shubpy" references
- [ ] `README.md` quick-start matches reality
- [ ] `.gitignore` covers `.env*`, `.next`, `node_modules`, `src-tauri/target`, `src/.dist`, coverage
- [ ] Git initialized; first commit is foundation docs + source copy
- [ ] CI workflow: install → lint → typecheck → test → build

### 4.2 Build split and strictness

- [ ] `next.config.ts` no longer always uses `output: "export"`
- [ ] Web build runs as a normal Next.js server build
- [ ] Desktop build uses a separate config/env flag (e.g. `NEXT_BUILD_TARGET=desktop`)
- [ ] `ignoreBuildErrors` and `ignoreDuringBuilds` removed
- [ ] `npm run build` passes with zero type/lint errors
- [ ] `npm run build:desktop` produces a static export in `src/.dist`
- [ ] Tauri installer smoke test deferred until the desktop shell is next touched (Phase 1/4)

### 4.3 Tooling

- [ ] `npm run typecheck` (`tsc --noEmit`)
- [ ] `npm run test` (Vitest, at least one real test)
- [ ] `npm run test:e2e` (Playwright smoke: app loads)
- [ ] Pre-commit hook runs lint + typecheck on staged files
- [ ] Drizzle scripts: `db:generate`, `db:migrate`, `db:seed`, `db:studio`

### 4.4 Database and tenancy

- [ ] Local Postgres via Docker Compose (or documented alternative)
- [ ] Drizzle config points to `DIRECT_URL` for migrations
- [ ] Core tables migrated: tenants, clinics, branches, users, memberships, doctors, patients, visits, prescriptions, prescription_items, templates, template_versions, audit_events
- [ ] Every business table has `tenant_id NOT NULL`
- [ ] RLS enabled and forced on all tenant tables
- [ ] RLS policy uses `app.tenant_id` session setting, never client-supplied tenant
- [ ] Tenant-scoped `withTenant()` is the only DB path used by feature code
- [ ] Automated RLS test: Tenant A cannot select/insert Tenant B rows, and no tenant context returns zero rows
- [ ] Migration rollback tested on a scratch database

### 4.5 Auth and onboarding

- [ ] Sign-up and sign-in with email/password (ADR-0008)
- [ ] Phone OTP scheduled for Phase 1; email verification deferred
- [ ] Session persistence and sign-out
- [ ] Session re-reads membership so role changes take effect
- [ ] MFA design documented; TOTP enforcement scheduled for Phase 1
- [ ] Sign-up creates tenant, clinic, Main Branch, owner membership, and doctor atomically
- [ ] Clinic fields: name, city, timezone, currency (address/logo in Phase 1)
- [ ] Doctor profile row created; editing/signature/stamp in Phase 1
- [ ] Role-aware route guard (Settings owner-only)
- [ ] Trial state and read-only expiry shell deferred to Phase 3 (billing)

### 4.6 App shell

- [ ] Authenticated layout with sidebar and clinic name
- [ ] Role-aware navigation (Settings hidden from non-owners)
- [ ] Root route redirects to dashboard/login
- [ ] Basic loading and error states
- [ ] Mobile sanity check at 360 px width
- [ ] Toast system and global error boundary deferred to Phase 1
- [ ] Keyboard navigation for the prescription form shell deferred to Phase 1

### 4.7 Seed, ops, and docs

- [ ] Seed script: 1 demo clinic, 3 staff users, 50 patients, 20 prescriptions
- [ ] Seed is idempotent (re-run replaces, never duplicates)
- [ ] Health check endpoint
- [ ] Structured logs with request IDs deferred to Phase 1
- [ ] Staging deploy documented and working
- [ ] Backup + restore drill completed on staging
- [ ] `docs/SETUP.md` verified on a clean machine (or fresh clone)
- [ ] `scripts/check-superpowers.ps1` passes
- [ ] ADRs updated with anything that changed during implementation

**Gate 0 evidence block** (fill at review):

```
Date:
Commands run:
Build output:
RLS test output:
Staging URL:
Restore drill:
Exceptions:
Decision: proceed / fix
```

---

## 5. In progress

_Nothing yet. The next action is to execute the Phase 0 plan._

---

## 6. Next 10 tasks (ordered)

| # | Task | Owner | Est. | Status |
|---|---|---|---|---|
| 1 | Initialize git, add `.gitignore` audit, commit foundation | founder | 30 min | ⚪ |
| 2 | Remove `test.txt`; rebrand `package.json` + layout metadata | founder | 30 min | ⚪ |
| 3 | Add `.env.example` and `docs/SETUP.md` verification | founder | 1 h | ⚪ |
| 4 | Split web vs desktop Next.js config; remove `ignoreBuildErrors` | founder | 0.5 day | ⚪ |
| 5 | Add Vitest + Playwright + scripts | founder | 1 day | ⚪ |
| 6 | Add Postgres Docker Compose + Drizzle config | founder | 0.5 day | ⚪ |
| 7 | Write core schema migration (tenants → audit_events) | founder | 2 days | ⚪ |
| 8 | Add RLS policies + tenant-scoped client + RLS test | founder | 2 days | ⚪ |
| 9 | Integrate auth provider and session middleware | founder | 2 days | ⚪ |
| 10 | Build onboarding wizard + app shell | founder | 3 days | ⚪ |

---

## 7. Blockers and risks

| # | Blocker/risk | Impact | Owner | Next action | Status |
|---|---|---|---|---|---|
| 1 | No git history in the copied repo | Cannot roll back; no CI | founder | `git init` + first commit | open |
| 2 | Static export config blocks server auth/API | Phase 0 cannot start features | founder | Split build configs | open |
| 3 | No Supabase project/credentials yet | Staging DB unavailable | founder | Create Mumbai project; store secrets | open |
| 4 | Auth provider not chosen | Blocks onboarding | founder | Decide ADR-0008 | open |
| 5 | No design partner commitments | Phase 1 exit at risk | founder | Recruit 5 clinics during Phase 0 | open |
| 6 | WhatsApp business verification lead time | Phase 3 delay | founder | Start verification in Phase 1 | open |

---

## 8. Decisions made this period

| ADR | Decision | Date |
|---|---|---|
| 0001 | Working name ClinicPad; verify trademark/domain | 2026-11-06 |
| 0002 | India-first, international after Phase 5 | 2026-11-06 |
| 0003 | Next.js + TypeScript + Tailwind + shadcn/ui | 2026-11-06 |
| 0004 | Postgres + RLS multi-tenancy | 2026-11-06 |
| 0005 | Supabase Mumbai for MVP | 2026-11-06 |
| 0006 | Drizzle ORM | 2026-11-06 |
| 0007 | Gotenberg/LibreOffice + pdf2docx + OCR pipeline | 2026-11-06 |
| 0008 | Auth.js v5 credentials; phone OTP in Phase 1 | 2026-11-06 |
| 0009 | Razorpay + Stripe | 2026-11-06 |
| 0010 | WhatsApp Cloud API behind abstraction | 2026-11-06 |
| 0011 | Free tier capped at 100 Rx/mo | 2026-11-06 |

Full text: `docs/DECISIONS.md`.

---

## 9. Metrics log

| Week ending | Trials | Activated | Paying | MRR | Churn | Notes |
|---|---|---|---|---|---|---|
| 2026-11-06 | 0 | 0 | 0 | ₹0 | — | Foundation only |

Add a row every Friday once trials start.

---

## 10. Session log format

Append to §11 at the end of each working session:

```md
### YYYY-MM-DD — <short title>
- Did:
- Evidence:
- Blocked by:
- Next:
```

---

## 11. Session log

### 2026-11-06 — Foundation and planning
- Did: explored the original app, researched the market, copied the source, wrote product/architecture/data/roadmap/GTM/decision/setup docs, created the formal platform spec and Phase 0 plan, added Superpowers verification, rebranded package metadata, removed `test.txt`, and initialized git.
- Evidence: `docs/*`, `AGENTS.md`, `scripts/check-superpowers.ps1` (10/10 pass), `npm run typecheck` exit 0, `npm run build` exit 0 (legacy static export), commit `97a4af0`.
- Blocked by: nothing.
- Next: execute Phase 0 plan (`docs/superpowers/plans/2026-11-06-phase-0-foundation.md`), starting with Task 1 verification and Task 2 dual build.

---

## 12. How to update this file

1. Change the **Last updated** date and snapshot.
2. Move finished checklist items to `[x]` and add the evidence link/command.
3. Keep **Next 10 tasks** short; if it grows past 10, move extras into the phase plan.
4. Add a session log entry — one per session, not per commit.
5. Never mark a gate passed without the evidence block filled in.
