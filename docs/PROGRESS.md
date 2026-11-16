# ClinicPad — Progress Tracker

**Last updated:** 2026-11-16
**Current phase:** Phase 1A — Patients and prescription core (code complete; final gate run pending). Phase 0 ops items (staging etc.) still open.
**Overall status:** 🟡 Gate 0 passed locally on 2026-11-12; Phase 1A gate pending final verification; not yet deployed to staging

This is the live source of truth for *what is actually true*. Update it at the end of every work session. Do not mark a task done without evidence (command output, link, screenshot, or commit hash).

---

## 1. Snapshot

| Metric | Value |
|---|---|
| Product stage | pre-alpha / foundation |
| Codebase origin | copy of `doctor-prescription-app` |
| Git initialized | yes (`97a4af0`) |
| Tests passing | 314 unit/integration in 21 files (`npm run test` excluding `tests/integration/tenant-fk.test.ts`, 2026-11-16); 15 e2e tests are written (smoke 6, patients 4, prescriptions 5) but were NOT run on 2026-11-16. Final counts: pending final verification |
| Build status | `build:web` and `build:desktop` passed with strict type/lint at Gate 0 (2026-11-12); not re-run since Phase 1A: pending final verification |
| Paying clinics | 0 |
| Design partners | 0 |
| MRR | ₹0 |
| Current milestone | Phase 0 exit criteria |
| Next gate | Gate 0 — Foundation |

---

## 2. Phase status

| Phase | Status | Started | Completed | Evidence |
|---|---|---|---|---|
| 0 — Foundation | 🟡 in progress | 2026-11-06 | — | `node scripts/verify-gate-0.mjs` PASSED 2026-11-12 |
| 1 — Prescription MVP | 🟡 in progress (1A: patients + prescription core code complete; 1B-1D not started) | 2026-11-12 | — | see section 4.8; Gate 1A run pending final verification |
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

- [x] Remove `test.txt` and any stray scratch files
- [x] `package.json` name is `clinicpad`, description updated, version reset to `0.1.0`
- [x] `src/app/layout.tsx` metadata: title, description, icons, no "Shubpy" references — _title/description set; no custom icons yet; the author email in Cargo.toml is intentional_
- [ ] `README.md` quick-start matches reality
- [x] `.gitignore` covers `.env*`, `.next`, `node_modules`, `src-tauri/target`, `src/.dist`, coverage
- [x] Git initialized; first commit is foundation docs + source copy — _97a4af0_
- [x] CI workflow: install → lint → typecheck → test → build — _.github/workflows/ci.yml written; the same steps pass locally; not yet run on GitHub (no remote configured)_

### 4.2 Build split and strictness

- [x] `next.config.ts` no longer always uses `output: "export"` — _verify-gate-0 PASSED 2026-11-12_
- [x] Web build runs as a normal Next.js server build — _verify-gate-0 PASSED 2026-11-12_
- [x] Desktop build uses a separate config/env flag (e.g. `NEXT_BUILD_TARGET=desktop`) — _verify-gate-0 PASSED 2026-11-12_
- [x] `ignoreBuildErrors` and `ignoreDuringBuilds` removed — _verify-gate-0 PASSED 2026-11-12_
- [x] `npm run build` passes with zero type/lint errors — _verify-gate-0 PASSED 2026-11-12_
- [x] `npm run build:desktop` produces a static export in `src/.dist` — _ADR-0021; 6 legacy routes exported_
- [ ] Tauri installer smoke test deferred until the desktop shell is next touched (Phase 1/4)

### 4.3 Tooling

- [x] `npm run typecheck` (`tsc --noEmit`)
- [x] `npm run test` (Vitest, at least one real test) — _10 files, 31 tests_
- [x] `npm run test:e2e` (Playwright smoke: app loads) — _6 tests incl. full sign-up, sign-out, sign-in and role demotion_
- [ ] Pre-commit hook runs lint + typecheck on staged files
- [x] Drizzle scripts: `db:generate`, `db:migrate`, `db:seed`, `db:studio`

### 4.4 Database and tenancy

- [x] Local Postgres via Docker Compose (or documented alternative) — _migrations 0000-0002; tests/integration/rls.test.ts_
- [x] Drizzle config points to `DIRECT_URL` for migrations — _migrations 0000-0002; tests/integration/rls.test.ts_
- [x] Core tables migrated: tenants, clinics, branches, users, memberships, doctors, patients, visits, prescriptions, prescription_items, templates, template_versions, audit_events — _migrations 0000-0002; tests/integration/rls.test.ts_
- [x] Every business table has `tenant_id NOT NULL` — _migrations 0000-0002; tests/integration/rls.test.ts_
- [x] RLS enabled and forced on all tenant tables — _migrations 0000-0002; tests/integration/rls.test.ts_
- [x] RLS policy uses `app.tenant_id` session setting, never client-supplied tenant — _migrations 0000-0002; tests/integration/rls.test.ts_
- [x] Tenant-scoped `withTenant()` is the only DB path used by feature code — _migrations 0000-0002; tests/integration/rls.test.ts_
- [x] Automated RLS test: Tenant A cannot select/insert Tenant B rows, and no tenant context returns zero rows — _migrations 0000-0002; tests/integration/rls.test.ts_
- [x] Migration rollback tested on a scratch database — _2026-11-12: apply, drop schemas, re-apply = 13 tables each time. Drizzle has no down-migrations, so this is a drop-and-reapply drill_

### 4.5 Auth and onboarding

- [x] Sign-up and sign-in with email/password (ADR-0008) — _tests/integration/{auth,signup}.test.ts + e2e_
- [ ] Phone OTP scheduled for Phase 1; email verification deferred
- [x] Session persistence and sign-out — _tests/integration/{auth,signup}.test.ts + e2e_
- [x] Session re-reads membership so role changes take effect — _tests/integration/{auth,signup}.test.ts + e2e_
- [ ] MFA design documented; TOTP enforcement scheduled for Phase 1
- [x] Sign-up creates tenant, clinic, Main Branch, owner membership, and doctor atomically — _tests/integration/{auth,signup}.test.ts + e2e_
- [x] Clinic fields: name, city, timezone, currency (address/logo in Phase 1) — _tests/integration/{auth,signup}.test.ts + e2e_
- [x] Doctor profile row created; editing/signature/stamp in Phase 1 — _tests/integration/{auth,signup}.test.ts + e2e_
- [x] Role-aware route guard (Settings owner-only) — _tests/integration/{auth,signup}.test.ts + e2e_
- [ ] Trial state and read-only expiry shell deferred to Phase 3 (billing)

### 4.6 App shell

- [x] Authenticated layout with sidebar and clinic name — _commits 8107eea, 54f1fda_
- [x] Role-aware navigation (Settings hidden from non-owners) — _commits 8107eea, 54f1fda_
- [x] Root route redirects to dashboard/login — _commits 8107eea, 54f1fda_
- [x] Basic loading and error states — _commits 8107eea, 54f1fda_
- [ ] Mobile sanity check at 360 px width
- [ ] Toast system and global error boundary deferred to Phase 1
- [ ] Keyboard navigation for the prescription form shell deferred to Phase 1

### 4.7 Seed, ops, and docs

- [x] Seed script: 1 demo clinic, 3 staff users, 50 patients, 20 prescriptions — _`npm run db:seed`_
- [x] Seed is idempotent (re-run replaces, never duplicates) — _two runs gave 1 tenant / 50 patients / 20 rx / 3 users_
- [x] Health check endpoint — _/api/health, covered by e2e_
- [ ] Structured logs with request IDs deferred to Phase 1
- [ ] Staging deploy documented and working
- [ ] Backup + restore drill completed on staging
- [ ] `docs/SETUP.md` verified on a clean machine (or fresh clone)
- [x] `scripts/check-superpowers.ps1` passes — _10/10_
- [x] ADRs updated with anything that changed during implementation — _ADR-0019..0021_

### 4.8 Phase 1A checklist (patients and prescription core)

A box is ticked only for evidence seen in a run on 2026-11-16: `npm run test` excluding `tests/integration/tenant-fk.test.ts` gave 21 files, 314 tests, all passed (that file is being changed by the in-progress migration 0009 work and was red at the time). Playwright, `build:desktop` and `node scripts/verify-gate-0.mjs` were not run in this pass; every e2e reference below is written but unrun, hence "pending final verification". Per-file counts are from the same run.

- [x] Patients: register, edit, search (name/phone/number), duplicate warning, archive — `tests/integration/patients.test.ts` (57 tests), `tests/unit/{names,phone,age}.test.ts`; e2e `tests/e2e/patients.spec.ts` (4 tests): pending final verification
- [x] Prescriptions: draft, save, finalize, amend (versioned, reasoned), repeat — `tests/integration/prescriptions-draft.test.ts` (40), `tests/integration/prescriptions-lifecycle.test.ts` (31); e2e `tests/e2e/prescriptions.spec.ts` (5 tests): pending final verification
- [x] Immutability enforced in the database (ADR-0023) — `tests/integration/immutability.test.ts` (22), `tests/integration/immutability-races.test.ts` (24, also re-run alone after warming the writer connection: 24 passed)
- [x] Per-clinic sequential Rx numbers; abandoned drafts leave no gaps; double-finalize burns no number (ADR-0022) — `tests/integration/prescriptions-lifecycle.test.ts` ("abandoned drafts do not consume numbers", "idempotent under a double-click... no burned number", "concurrent finalizes of different drafts"), `tests/integration/numbering-audit.test.ts` (7)
- [x] Audit events for patient created/updated/archived and prescription drafted/finalized/amendment drafted/amended — written in `src/server/services/{patients,prescriptions}.ts` inside the mutation transaction; asserted in `tests/integration/patients.test.ts`, `prescriptions-draft.test.ts`, `prescriptions-lifecycle.test.ts`
- [x] Server-side permissions on every service (ADR-0026) — `tests/unit/permissions.test.ts` (50) and the forbidden-role cases in the integration files above
- [ ] Same-tenant references enforced by composite foreign keys (ADR-0025) — migration 0007 landed; migration 0009 and `tests/integration/tenant-fk.test.ts` are in progress, so this stays open until the final run
- [ ] `npm run build:desktop` still exports the legacy shell with no stashed or modified files left behind — pending final verification (the new routes live under `src/app/(app)`, which the script already stashes; not yet confirmed)
- [ ] `node scripts/verify-gate-0.mjs` (now including the Phase 1A tests) shows `Gate 0 verification PASSED` — pending final verification

**Phase 1A known limitations and follow-ups**

- Age label uses the UTC date, and date-of-birth validation uses UTC "today"; both move to the clinic timezone in Plan 1D.
- Phone edge cases: a leading invisible character or `tel:` prefix, and `+0091`, are not normalized.
- Name cleanup strips `\p{Cf}` characters, which also removes zero-width-space separators between words.
- Item ids are not stable across `saveDraft` (items are deleted and re-inserted).
- A blank diagnosis chip rejects the whole save.
- Drafts are not audited when saved (only creation, finalize and amendment events are).
- An amendment keeps the original `doctorId` and creates a second finalized visit for the same encounter.
- Amend is allowed for an archived patient.
- No autosave (Plan 1B) and no unsaved-changes guard.
- e2e tests may be flaky before hydration; they should wait for a hydration signal.
- Phase 0 carry-overs: staging deploy and restore drill, first CI run on GitHub (a remote exists now), pre-commit hook (needs owner approval to set `core.hooksPath`), 360 px visual check, MFA design note.
- Documented immutability limitations (TRUNCATE, disabled triggers, replica role, insert of an already-finalized row, no successor check on `finalized -> amended`): ADR-0023.

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

Remaining Phase 0 work is the open boxes in section 4: staging deploy and restore drill on staging, pre-commit hook, SETUP.md clean-machine verification, 360 px visual check, MFA design note, first CI run on GitHub.

Phase 1A is code complete; what is open is the final verification (migration 0009 composite foreign keys, desktop build check, `verify-gate-0`, e2e) tracked in section 4.8.

**Next:** Plan 1B (clinical form, autosave). ADR numbers 0022-0026 are now taken by Phase 1A, so the planned ADR numbers in the Plan 1B and 1C drafts must be renumbered: 1B's draft ADRs (0025-0029) become 0027-0031 and 1C's (0030-0033) become 0032-0035.

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

### 2026-11-12 — Auth, sign-up, app shell, seed, e2e, Gate 0 script
- Did: finished Tasks 8-12 of the Phase 0 plan. Auth.js credentials with tenant/role in the session and a per-request membership re-read; atomic clinic sign-up; role-aware app shell; idempotent demo seed; Playwright flow; CI workflow; `scripts/verify-gate-0.mjs`. Deviations from the plan are recorded in ADR-0019/20/21: auth lookups via the admin connection with an edge-safe middleware config; legacy app moved to a `(legacy)` route group (form now at `/prescribe`); desktop export builds via a stash script.
- Evidence: `node scripts/verify-gate-0.mjs` PASSED (lint, typecheck, 31 tests, build:web, build:desktop, 6 e2e). Local restore drill: pg_dump then pg_restore gave identical counts (2 tenants / 50 patients / 20 rx / 21 audit at the time). Rollback drill: 13, 0, 13 tables. Commits a52637b, 090afc6, 8107eea, ff2b5ba, 18cee06, 7c96ace, 54f1fda.
- Blocked by: no Supabase/Vercel project (staging); no git remote (CI unrun on GitHub). The pre-commit hook is not installed: the environment denied writing `core.hooksPath`, so the owner has to approve it.
- Next: create staging (Supabase Mumbai + Vercel bom1), deploy, repeat sign-up and health checks there, run the restore drill on staging, then fill the Gate 0 evidence block.
- Gotcha: on Windows run vitest from a path with an uppercase drive letter (`E:\`). A lowercase `e:` cwd loads two vitest instances and every test fails with "Cannot read properties of undefined (reading 'config')".

---

### 2026-11-16 — Phase 1A: patients, prescription lifecycle, immutability, audit
- Did: shipped Phase 1A. Patients (register, edit, search by name/phone/number, duplicate warning, archive); prescription lifecycle (draft, save, finalize, amend with a reason and version + 1, repeat) with per-clinic Rx numbers assigned at finalization (ADR-0022); database-level immutability through triggers (ADR-0023, migrations 0004-0006, 0008); amendments that copy the visit (ADR-0024); composite same-tenant foreign keys (ADR-0025, migration 0007; 0009 in progress); audit events for every patient and prescription mutation; server-side role matrix (ADR-0026). The work went through 14 reviewed commit ranges (one review per range, diffs kept under `.superpowers/sdd/`), which produced the hardening migrations 0005, 0006 and 0008, the superseded-version rule for repeat, and the race tests. This session also quieted the dotenv banner in `drizzle.config.ts` and `playwright.config.ts` and warmed the writer connection in `tests/integration/immutability-races.test.ts`.
- Evidence: `npm run typecheck` clean; `npm run lint` 0 errors (2 existing warnings); `npm run test` excluding `tenant-fk.test.ts` = 21 files, 314 tests passed; `npx vitest run tests/integration/immutability-races.test.ts` = 24 passed after the warm-up edit. With `tenant-fk.test.ts` included the run showed 15 failures, all in that file, while migration 0009 was being written by a parallel task.
- Blocked by: migration 0009 and its test not landed at the time of writing; desktop build check, `verify-gate-0` and Playwright deliberately not run in this pass.
- Next: when 0009 lands, run `npm run build:desktop`, `node scripts/verify-gate-0.mjs` and the e2e suite, then update section 4.8 and the snapshot. Then Plan 1B (see "Next" in section 5 for the ADR renumbering).
- Gotchas: on Windows run vitest from an uppercase drive letter. Docker Desktop on this machine lives under `%LOCALAPPDATA%\Programs\DockerDesktop`. In Playwright, `getByRole("alert")` also matches Next's route announcer.

---

## 12. How to update this file

1. Change the **Last updated** date and snapshot.
2. Move finished checklist items to `[x]` and add the evidence link/command.
3. Keep **Next 10 tasks** short; if it grows past 10, move extras into the phase plan.
4. Add a session log entry — one per session, not per commit.
5. Never mark a gate passed without the evidence block filled in.
