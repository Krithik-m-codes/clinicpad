# ClinicPad — Progress Tracker

**Last updated:** 2026-11-17
**Current phase:** Phase 1B — Clinical form, medicine catalogue, autosave (code complete; automated gate passed locally 2026-11-17). Phase 1A is code complete too. Phase 0 ops items (staging etc.) still open.
**Overall status:** 🟡 `node scripts/verify-gate-0.mjs` PASSED locally on 2026-11-12, 2026-11-16 (with the Phase 1A tests) and 2026-11-17 (with the Phase 1B tests); not yet deployed to staging

This is the live source of truth for *what is actually true*. Update it at the end of every work session. Do not mark a task done without evidence (command output, link, screenshot, or commit hash).

---

## 1. Snapshot

| Metric | Value |
|---|---|
| Product stage | pre-alpha / foundation |
| Codebase origin | copy of `doctor-prescription-app` |
| Git initialized | yes (`97a4af0`) |
| Tests passing | 872 unit/integration in 48 files + 18 e2e (smoke 6, patients 4, prescriptions 6, clinical-form 2), all passed on 2026-11-17 (`npm run test`; `node scripts/verify-gate-0.mjs`) |
| Build status | `build:web` and `build:desktop` pass with strict type/lint (inside `verify-gate-0` on 2026-11-17; `build:desktop` also run alone, exit 0, 6 legacy routes exported, `git status --short` listed only documentation edits) |
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
| 1 — Prescription MVP | 🟡 in progress (1A patients + prescription core and 1B clinical form, catalogue, autosave code complete; 1C templates/PDF and 1D hardening not started) | 2026-11-12 | — | see sections 4.8 and 4.9; `node scripts/verify-gate-0.mjs` PASSED 2026-11-17 (872 tests + 18 e2e) |
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

A box is ticked only for evidence seen on 2026-11-16 (after migration 0009 landed, commit `4108b90`): `npm run lint` 0 errors (2 existing warnings), `npm run typecheck` clean, `npm run test` = 22 files, 385 tests passed; `npm run build:desktop` exit 0 with a clean `git status --short`; `node scripts/verify-gate-0.mjs` ended with `15 passed (1.5m)` and `Gate 0 verification PASSED` (it re-ran lint, typecheck, the 385 tests, `build:web`, `build:desktop` and the e2e suite). Per-file counts are from an earlier run of the same suite (excluding `tenant-fk.test.ts`, 71 tests).

- [x] Patients: register, edit, search (name/phone/number), duplicate warning; archive is a service only (`archivePatient`), with no server action, UI or unarchive yet — `tests/integration/patients.test.ts` (57 tests), `tests/unit/{names,phone,age}.test.ts`; e2e `tests/e2e/patients.spec.ts` (4 tests, passed in the 2026-11-16 gate run)
- [x] Prescriptions: draft, save, finalize, amend (versioned, reasoned), repeat — `tests/integration/prescriptions-draft.test.ts` (40), `tests/integration/prescriptions-lifecycle.test.ts` (31); e2e `tests/e2e/prescriptions.spec.ts` (5 tests, passed in the 2026-11-16 gate run)
- [x] Immutability enforced in the database (ADR-0023) — `tests/integration/immutability.test.ts` (22), `tests/integration/immutability-races.test.ts` (24, also re-run alone after warming the writer connection: 24 passed)
- [x] Per-clinic sequential Rx numbers; abandoned drafts leave no gaps; double-finalize burns no number (ADR-0022) — `tests/integration/prescriptions-lifecycle.test.ts` ("abandoned drafts do not consume numbers", "idempotent under a double-click... no burned number", "concurrent finalizes of different drafts"), `tests/integration/numbering-audit.test.ts` (7)
- [x] Audit events for patient created/updated/archived and prescription drafted/finalized/amendment drafted/amended — written in `src/server/services/{patients,prescriptions}.ts` inside the mutation transaction; asserted in `tests/integration/patients.test.ts`, `prescriptions-draft.test.ts`, `prescriptions-lifecycle.test.ts`
- [x] Server-side permissions on every service (ADR-0026) — `tests/unit/permissions.test.ts` (50) and the forbidden-role cases in the integration files above
- [x] Same-tenant references enforced by composite foreign keys (ADR-0025) — migration 0007 (clinical tables) and 0009 (`branches -> clinics`, `doctors.primary_branch_id -> branches` as `ON DELETE SET NULL ("primary_branch_id")`, `template_versions -> templates`); `tests/integration/tenant-fk.test.ts` (71 tests) passed in the 385-test run, guard allowlist empty. Note: composite keys cover every DECLARED relation between tenant-owned tables and the guard test pins that. At that time `visits.doctor_id`, `visits.branch_id` and `prescriptions.template_version_id` had no foreign key; migration 0010 (Plan 1B, section 4.9) added them with `unique (tenant_id, id)` and `unique (tenant_id, user_id)` on `doctors`.
- [x] `npm run build:desktop` still exports the legacy shell with no stashed or modified files left behind — exit 0, 6 routes (`/`, `/manage`, `/patient-infos`, `/prescribe`, `/preview`, `/api/ping`), `git status --short` empty, no `.desktop-stash`; no change to `scripts/build-desktop.mjs` was needed (the new routes live under `src/app/(app)`, already in its list)
- [x] `node scripts/verify-gate-0.mjs` (now including the Phase 1A tests) — `Gate 0 verification PASSED`, 385 tests, `15 passed (1.5m)` e2e, 2026-11-16
- [x] Final fix wave after the whole-branch review (2026-11-16): a NUL character in any prescription free text or the amendment reason, and a follow-up date outside 1900-01-01 to 2100-12-31 (including year 0000), now return `invalid` instead of crashing the save (validation plus a mapping of SQLSTATE 22021/22007/22008 in `saveDraft` and `amendPrescription`; `tests/integration/prescriptions-db-errors.test.ts` bypasses validation to prove the mapping); the prescription screen shows the patient's allergies (`AllergyBanner`); documentation corrected (ADR-0022, ADR-0023, ADR-0025, AGENTS.md). Evidence from the fix run: `npm run lint` 0 errors (2 existing warnings), `npm run typecheck` clean, `npm run test` = 23 files, 413 tests passed; e2e `prescriptions`, `patients` and `smoke` specs = 15 passed. The full gate and the desktop build are re-run by the reviewer.

**Phase 1A known limitations and follow-ups**

- Age label uses the UTC date, and date-of-birth validation uses UTC "today"; both move to the clinic timezone in Plan 1D.
- Phone edge cases: a leading invisible character or `tel:` prefix, and `+0091`, are not normalized.
- Name cleanup strips `\p{Cf}` characters, which also removes zero-width-space separators between words.
- Item ids are not stable across `saveDraft` (items are deleted and re-inserted).
- A blank diagnosis chip rejects the whole save — resolved in Plan 1B (`c5da0f2`; blank phrase entries are dropped, `prescriptions-clinical.test.ts`).
- Drafts are not audited when saved (only creation, finalize and amendment events are).
- An amendment keeps the original `doctorId` and creates a second finalized visit for the same encounter.
- Amend is allowed for an archived patient.
- No autosave (Plan 1B) and no unsaved-changes guard — resolved in Plan 1B (`8ab9734`, hardened in `f8445a5`, `c1610be`).
- e2e tests may be flaky before hydration; they should wait for a hydration signal — resolved in Plan 1B (`8ab9734`; the editor is disabled until hydrated and `waitForEditor` in `tests/e2e/helpers.ts` waits for it).
- Phase 0 carry-overs: staging deploy and restore drill, first CI run on GitHub (a remote exists now), pre-commit hook (needs owner approval to set `core.hooksPath`), 360 px visual check, MFA design note.
- Documented immutability limitations (TRUNCATE, disabled triggers, replica role, insert of an already-finalized row, no successor check on `finalized -> amended`): ADR-0023.
- Patient archive UI and unarchive: only the service `archivePatient` exists (no server action, no screen, no way back). Owner: Plan 1B.
- No way to discard a draft or withdraw an open amendment (Plan 1B) — resolved in Plan 1B (`f4959ad`, tests pinned in `4c3aa62`).
- `repeatPrescription` ignores an open amendment on the source; decide together with discard (Plan 1B) — resolved in Plan 1B (`f4959ad`, ADR-0031).
- Superseded and draft views are unmarked for read-only roles, and the finalized view reads the LIVE patient row (name, allergies); a snapshot at finalization is needed (Plan 1C).
- `/prescriptions/:path*` is missing from the middleware matcher (Plan 1C).
- The app role can `DELETE` from `tenant_counters`; revoke it (Plan 1D).
- Triggers: add a BEFORE INSERT guard (`status = 'draft'`), a finalized-child precondition for the `finalized -> amended` flip, and CHECK constraints on the status columns (Plan 1D).
- `doctorIdFor` can pick an arbitrary row because `doctors` has no `unique (tenant_id, user_id)` — resolved in Plan 1B (migration 0010, `023e716`).
- e2e `seedPatients` bypasses `tenant_counters` (Plan 1D).
- The dev database holds leaked test tenants and users from aborted runs; write a sweep script (Plan 1D).
- An owner without a doctor profile can finalize a prescription: a human decision is needed before any pilot (Plan 1C warns).
- Date of birth uses the UTC date, so a newborn registered between 00:00 and 05:30 IST is rejected as "in the future" (Plan 1D; must land before paediatric or maternity pilots).

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

### 4.9 Phase 1B checklist (clinical form, catalogue, autosave)

A box is ticked only for evidence seen on 2026-11-17 at commit `4c3aa62` (code) with the documentation edits uncommitted: `npm run lint` 0 errors (3 existing warnings in `use-autosave.ts`, `ui/form.tsx`, `use-toast.ts`), `npm run typecheck` clean, `npm run test` = 48 files, 872 tests passed; `node scripts/verify-gate-0.mjs` ran lint, typecheck, the 872 tests, `build:web`, `build:desktop` and the e2e suite and ended with `18 passed (2.9m)` (smoke 6, patients 4, prescriptions 6, clinical-form 2) and `Gate 0 verification PASSED`; `npm run build:desktop` run alone exited 0 and `git status --short` then listed only the documentation edits (`AGENTS.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md`; no stash or moved files). Per-file counts are from a JSON-reporter run of the same 872 tests. The gate log contains the expected `[auth][error] CredentialsSignin` trace from the wrong-password smoke test.

- [x] Same-tenant keys for `visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id`; one doctor profile per user per clinic; offboarding still works (migration 0010, `tests/integration/clinical-references.test.ts`, 11 tests; `tenant-fk.test.ts`, 71)
- [x] Clinical form on server data: vitals, complaints, diagnosis, history, drug history, examination, structured medicines, investigations, advice, follow-up (`tests/integration/prescriptions-clinical.test.ts`, 62; `tests/e2e/clinical-form.spec.ts`, 2)
- [x] New clinical data frozen at finalize (including the draft-visit guard) and still cascades on tenant delete (`tests/integration/clinical-schema.test.ts`, 12)
- [x] NUL refused in every new text field; blank phrase entries dropped; Plan 1A NUL/date/db-error tests unchanged (`prescriptions-clinical.test.ts`; `prescriptions-draft.test.ts`, 60, untouched since Plan 1A; `prescriptions-db-errors.test.ts`, 9, only additions)
- [x] Amend copies every clinical field and item column; repeat copies prescribing content only and only from the latest finalized version (`tests/integration/prescriptions-clinical-lifecycle.test.ts`, 8; `prescriptions-lifecycle.test.ts`, 32)
- [x] Global catalogue seeded from sample_data, read-only for the app role (`tests/integration/catalogue-seed.test.ts`, 3; `clinical-schema.test.ts`)
- [x] Medicine search with literal wildcards, clinic medicines, per-doctor favourites with a composite key (`tests/integration/catalogue.test.ts`, 24; `clinical-schema.test.ts`)
- [x] Autosave: one save in flight, stale revision = conflict, offline retry, finalize the seen revision, editor disabled until hydrated, unsaved-changes guard (`tests/unit/autosave.test.ts`, 56; `prescriptions-clinical.test.ts`; `tests/integration/editor-endpoints.test.ts`, 58; `tests/unit/clinical-editor.test.tsx`, 12; `clinical-form.spec.ts`)
- [x] Discard a draft and withdraw an open amendment; repeat refused while a correction is open (`tests/integration/prescriptions-discard.test.ts`, 14, including two tests that hold the row lock; `tests/unit/discard-draft-form.test.tsx`, 3; `discard-draft-action.test.ts`, 3; `prescription-page.test.tsx`, 8; `tests/e2e/prescriptions.spec.ts`, 6)
- [x] Reception, nurse, pharmacist, accountant cannot edit clinical content; Finalize gated on `rx.finalize` (`prescriptions-clinical.test.ts`, `prescription-page.test.tsx`, `prescriptions.spec.ts`)
- [x] Audit: finalize records counts and field names; discard records ids and counts; no free text (`prescriptions-clinical-lifecycle.test.ts`, `prescriptions-discard.test.ts`)
- [x] `npm run build:desktop` exit 0 with `src/app/api/catalogue` stashed and restored; `git status --short` showed only the documentation edits (see above)
- [x] `node scripts/verify-gate-0.mjs` PASSED with the Phase 1B tests (872 tests, `18 passed (2.9m)` e2e)

**Phase 1B known limitations and follow-ups** (from the review ledger; "owner" is the plan that should take it)

- The `sample_data` medicine list is unreviewed: spelling errors (for example "Glimepride") and 23 duplicate names with differing generic names (the seed keeps the first). It needs a clinical review before any pilot; it is not a licensed drug database (Phase 6; ADR-0028). The seed test pins some typo-bearing values and will need updating with the data.
- Temperature is stored in °F only (Plan 1D or a locale pass).
- Reception and pharmacist roles now read history, examination notes and vitals through `rx.read`: a data-minimisation decision is needed before any pilot (ADR-0030; Plan 1D).
- An owner without a doctor profile can finalize, and such a prescriber has no favourites (Plan 1C warns; human decision before a pilot).
- Autosave limits (ADR-0029; Plan 1D or Phase 4): Next serialises server actions, so a hung finalize delays the resumed autosave and the page refresh; `dispose()` skips the final save while a finalize runs, so edits that exist only in the finalize payload are lost if finalize fails before saving and the doctor navigates away mid-finalize; the ambiguous-conflict text is not set after an `exclusive` unknown outcome; there is no conflict UI after a finalize conflict when nothing is unsaved; one invalid field blocks the whole snapshot; a flush on a timed-out in-flight save retries once and then resolves.
- Discard: no concurrency tests for repeat-vs-amend or withdraw-vs-finalize-of-the-child (analysis in ADR-0023 says safe); a discarded draft cannot be restored (ADR-0031).
- Missing indexes on the new foreign-key columns `visits(tenant_id, doctor_id)`, `visits(tenant_id, branch_id)`, `prescriptions(tenant_id, template_version_id)`, which matter for offboarding scans at scale (Plan 1D).
- Periodicity, dose ranges and `duration_value > 0` are checked by Zod only, not by database CHECK constraints; CHECKs and policies of migration 0012 exist only in SQL, not in the Drizzle schema (Plan 1D).
- No catalogue-wide RLS guard test (every table with `tenant_id` has forced RLS and a `tenant_isolation` policy); `tenant_medicines.created_by` has no foreign key (Plan 1D).
- `tenant_counters` still grants `DELETE` to the app role, and the e2e `seedPatients` still bypasses the counters (Plan 1D, as in 4.8).
- The development database holds leaked test tenants from aborted runs; a sweep script is still to be written (Plan 1D, as in 4.8).
- The patient archive UI and unarchive remain open (ruled out of Plan 1B; Plan 1D).
- Smaller deferred items: favourites save locks the doctor row `FOR UPDATE` (switch to `FOR NO KEY UPDATE` if contention appears); `cleanText` applies NFC before the invisible-character strip; `expectedRevision` is not validated like `baseRevision`; no column-classification guard test for amend/repeat copying (a new visit column could be copied or dropped silently); `getSessionContext` and `requireSession` duplicate logic; an unreviewed seed gap (a wrong-schema CSV header skips every row and exits 0).
- Not built, with their owners: nurse vitals entry (Phase 3, ADR-0030), Hindi labels for the new option codes (Plan 1D), the offline outbox (Phase 4), advice templates and medicine bundles, clinic-learned complaint and diagnosis suggestions, and an undo for discarded drafts (unscheduled; ADR-0031).

---

## 5. In progress

Remaining Phase 0 work is the open boxes in section 4: staging deploy and restore drill on staging, pre-commit hook, SETUP.md clean-machine verification, 360 px visual check, MFA design note, first CI run on GitHub.

Phase 1A is code complete and its automated gate passed locally on 2026-11-16 (section 4.8). What is open is the Phase 0 ops list above and the Phase 1A follow-ups in section 4.8; Phase 1 as a whole (1C-1D) is not done.

Phase 1B is code complete and its automated gate passed locally on 2026-11-17 (section 4.9); its follow-ups are listed there.

**Next:** Plan 1C (templates, server PDF, print). Plan 1C's ADRs start at ADR-0032; its migrations start at 0013.

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
- Did: shipped Phase 1A. Patients (register, edit, search by name/phone/number, duplicate warning; archive exists as a service only); prescription lifecycle (draft, save, finalize, amend with a reason and version + 1, repeat) with per-clinic Rx numbers assigned at finalization (ADR-0022); database-level immutability through triggers (ADR-0023, migrations 0004-0006, 0008); amendments that copy the visit (ADR-0024); composite same-tenant foreign keys (ADR-0025, migrations 0007 and 0009); audit events for every patient and prescription mutation; server-side role matrix (ADR-0026). The work went through 14 reviewed commit ranges (one review per range, diffs kept under `.superpowers/sdd/`), which produced the hardening migrations 0005, 0006 and 0008, the superseded-version rule for repeat, and the race tests. This session also quieted the dotenv banner in `drizzle.config.ts` and `playwright.config.ts` and warmed the writer connection in `tests/integration/immutability-races.test.ts`.
- Evidence (after migration 0009, commit `4108b90`): `npm run lint` 0 errors (2 existing warnings); `npm run typecheck` clean; `npm run test` = 22 files, 385 tests passed; `npm run build:desktop` exit 0, `git status --short` empty; `node scripts/verify-gate-0.mjs` = `15 passed (1.5m)` and `Gate 0 verification PASSED`. `npx vitest run tests/integration/immutability-races.test.ts` = 24 passed after the warm-up edit.
- Blocked by: nothing for the automated gate. Staging, CI on GitHub, pre-commit hook, 360 px check and MFA note remain open (Phase 0 carry-overs).
- Next: Plan 1B (see "Next" in section 5 for the ADR renumbering).
- Gotchas: on Windows run vitest from an uppercase drive letter. Docker Desktop on this machine lives under `%LOCALAPPDATA%\Programs\DockerDesktop`. In Playwright, `getByRole("alert")` also matches Next's route announcer.

### 2026-11-17 — Phase 1B: clinical form, medicine catalogue, autosave, discard
- Did: shipped Phase 1B in 23 commits on `phase-1-prescription-mvp` (`c69f3be` plan to `4c3aa62`), each range reviewed. Migrations 0010 (same-tenant keys for doctor, branch and template version), 0011 (clinical visit and item columns, `draft_revision`, catalogue tables) and 0012 (catalogue security). The server-backed clinical form (vitals, history, investigations, structured medicines with dose schedules), the global and clinic medicine catalogue with per-doctor favourites (`npm run db:seed:catalogue`), revision-checked autosave with conflict handling and an unsaved-changes guard, and discarding drafts / withdrawing amendments. Decisions ADR-0027 to ADR-0031 and an update note on ADR-0025; lock-order notes in ADR-0023 now cover discard and repeat. Final chores in `4c3aa62`: deterministic discard-vs-finalize tests that hold the row lock (removing the lock in `discardDraft` or `finalizePrescription`, or the status check in `discardDraft`, fails them; checked on a scratch copy of the repo), a page refresh and "changed or discarded elsewhere" message after a failed discard, focus on "Keep it" with a polite live region, and a corrected corrupt-state message.
- Evidence: see section 4.9 (`npm run test` 48 files / 872 tests; `node scripts/verify-gate-0.mjs` PASSED with `18 passed (2.9m)` e2e; `npm run build:desktop` exit 0, tree clean apart from documentation).
- Blocked by: nothing for the automated gate. Staging, CI on GitHub, pre-commit hook, 360 px check and MFA note remain open (Phase 0 carry-overs).
- Next: Plan 1C (templates, server PDF, print). Before any pilot: clinical review of the sample medicine list and the reception/pharmacist data-minimisation decision (section 4.9).
- Gotchas: a `"use server"` module may only export async functions and types (a message constant in `src/server/actions/prescriptions.ts` stays private). Next serialises server actions, so use GET route handlers for typing-time fetches.

---

## 12. How to update this file

1. Change the **Last updated** date and snapshot.
2. Move finished checklist items to `[x]` and add the evidence link/command.
3. Keep **Next 10 tasks** short; if it grows past 10, move extras into the phase plan.
4. Add a session log entry — one per session, not per commit.
5. Never mark a gate passed without the evidence block filled in.
