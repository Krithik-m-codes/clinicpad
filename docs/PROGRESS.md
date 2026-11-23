# ClinicPad — Progress Tracker

**Last updated:** 2026-11-19
**Current phase:** Phase 1D — Sharing, consent, CSV import, history, hardening (code complete; automated gate passed locally 2026-11-18). Phase 1 is code complete; the exit criteria that need people are open (section 4.11). Phase 0 ops items (staging etc.) still open.
**Overall status:** 🟡 `node scripts/verify-gate-0.mjs` PASSED locally on 2026-11-12, 2026-11-16, 2026-11-17 (Phases 1B and 1C) and 2026-11-18 (Phase 1D: 2,163 tests, 51 e2e); not yet deployed to staging

This is the live source of truth for *what is actually true*. Update it at the end of every work session. Do not mark a task done without evidence (command output, link, screenshot, or commit hash).

---

## 1. Snapshot

| Metric | Value |
|---|---|
| Product stage | pre-alpha / foundation |
| Codebase origin | copy of `doctor-prescription-app` |
| Git initialized | yes (`97a4af0`) |
| Tests passing | 2,760 unit/integration passed + 4 skipped in 157 files, 67 e2e passed (21 opt-in skipped), `npm run test:visual` 42 passed, `npm run test:pdf-frame` 21 passed, on 2026-11-19 (Phase 2A gate, run step by step, not as one `verify-gate-0` command) |
| Build status | `build:web` and `build:desktop` pass with strict type/lint (inside `verify-gate-0` on 2026-11-18; `build:desktop` also run alone afterwards, exit 0, tree clean apart from documentation; `drizzle-kit generate`: no schema changes) |
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
| 1 — Prescription MVP | 🟡 code complete (1A–1D); exit criteria needing design partners open (section 4.11) | 2026-11-12 | — | see sections 4.8 to 4.11; `node scripts/verify-gate-0.mjs` PASSED 2026-11-18 (2,163 tests + 51 e2e passed, 8 skipped) |
| 2 — Template Studio | 🟡 2A (overlay pads) code complete; 2B (DOCX) and 2C not started | 2026-11-18 | — | section 4.12; ADR-0043 to ADR-0048 |
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

- Age label uses the UTC date, and date-of-birth validation uses UTC "today"; both move to the clinic timezone in Plan 1D. — resolved in Plan 1D (`b89284b`)
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
- Patient archive UI and unarchive: only the service `archivePatient` exists (no server action, no screen, no way back). Owner: Plan 1D. — resolved in Plan 1D (`70ffe3e`)
- No way to discard a draft or withdraw an open amendment (Plan 1B) — resolved in Plan 1B (`f4959ad`, tests pinned in `4c3aa62`).
- `repeatPrescription` ignores an open amendment on the source; decide together with discard (Plan 1B) — resolved in Plan 1B (`f4959ad`, ADR-0031).
- Superseded and draft views are unmarked for read-only roles, and the finalized view reads the LIVE patient row (name, allergies); a snapshot at finalization is needed (Plan 1C) — resolved in Plan 1C (`d7f5567`, `75da6e3`; the allergy banner stays live by decision, ADR-0032).
- `/prescriptions/:path*` is missing from the middleware matcher (Plan 1C) — resolved in Plan 1C (`bc4bd07`).
- The app role can `DELETE` from `tenant_counters`; revoke it (Plan 1D). — resolved in Plan 1D (`7fd5657`)
- Triggers: add a BEFORE INSERT guard (`status = 'draft'`), a finalized-child precondition for the `finalized -> amended` flip, and CHECK constraints on the status columns (Plan 1D). — resolved in Plan 1D (`7fd5657`)
- `doctorIdFor` can pick an arbitrary row because `doctors` has no `unique (tenant_id, user_id)` — resolved in Plan 1B (migration 0010, `023e716`).
- e2e `seedPatients` bypasses `tenant_counters` (Plan 1D). — resolved in Plan 1D (`a83e068`)
- The dev database holds leaked test tenants and users from aborted runs; write a sweep script (Plan 1D). — resolved in Plan 1D (`748d627`)
- An owner without a doctor profile can finalize a prescription: a human decision is needed before any pilot (Plan 1C warns before finalizing and prints no doctor block, ADR-0032; the decision itself is still open).
- Date of birth uses the UTC date, so a newborn registered between 00:00 and 05:30 IST is rejected as "in the future" (Plan 1D; must land before paediatric or maternity pilots). — resolved in Plan 1D (`b89284b`)

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

A box is ticked only for evidence seen on 2026-11-17 at commit `4c3aa62` (code) with the documentation edits uncommitted: `npm run lint` 0 errors (3 existing warnings in `use-autosave.ts`, `ui/form.tsx`, `use-toast.ts` at that commit; the `use-autosave.ts` one was fixed in the final fix wave below, so `npm run lint` now reports 2 warnings, in `ui/form.tsx` and `use-toast.ts`), `npm run typecheck` clean, `npm run test` = 48 files, 872 tests passed; `node scripts/verify-gate-0.mjs` ran lint, typecheck, the 872 tests, `build:web`, `build:desktop` and the e2e suite and ended with `18 passed (2.9m)` (smoke 6, patients 4, prescriptions 6, clinical-form 2) and `Gate 0 verification PASSED`; `npm run build:desktop` run alone exited 0 and `git status --short` then listed only the documentation edits (`AGENTS.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md`; no stash or moved files). Per-file counts are from a JSON-reporter run of the same 872 tests. The gate log contains the expected `[auth][error] CredentialsSignin` trace from the wrong-password smoke test.

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

**Phase 1B final fix wave (2026-11-17, whole-branch review):** soft navigation guard while edits are at risk, plus the invalid-halt wording ("Nothing since HH:MM is saved", with the field path such as "medicines 3 · dose" through a new optional `path` on service errors); an unknown finalize outcome refreshes the page only online with nothing unsaved (otherwise it re-checks on the `online` event) and Finalize is disabled offline; a finalize conflict with nothing unsaved enters the conflict halt; the `use-autosave.ts` lint warning is fixed; `cleanText` also removes U+200E, U+200F, U+061C, U+2061-2064, U+180E and the tag block; the amendment reason and patient text fields are cleaned like draft text; a typed generic name survives picking a hit without one; favourite saves lock the doctor row `FOR NO KEY UPDATE`, so they no longer block prescription starts. Evidence: `npm run lint` 0 errors (2 existing warnings), `npm run typecheck` clean, `npm run test` = 51 files, 925 tests passed; e2e `clinical-form`, `prescriptions`, `patients` and `smoke` passed (the first full run had one cold-dev-server timeout in the first clinical-form test; the spec passed 3 of 3 when re-run alone). The full gate and the desktop build were not re-run.

**Phase 1B known limitations and follow-ups** (from the review ledger; "owner" is the plan that should take it)

- The `sample_data` medicine list is unreviewed: spelling errors (for example "Glimepride") and 23 duplicate names with differing generic names (the seed keeps the first). It needs a clinical review before any pilot; it is not a licensed drug database (Phase 6; ADR-0028). The seed test pins some typo-bearing values and will need updating with the data.
- Temperature is stored in °F only (Plan 1D or a locale pass). — decided in Plan 1D: stays °F until Phase 3 (ADR-0041)
- Reception and pharmacist roles now read history, examination notes and vitals through `rx.read`: a data-minimisation decision is needed before any pilot (ADR-0030; Plan 1D).
- An owner without a doctor profile can finalize, and such a prescriber has no favourites (Plan 1C warns before finalizing and prints no doctor block, ADR-0032; the decision itself is still open).
- Autosave limits (ADR-0029; Plan 1D or Phase 4): Next serialises server actions, so a hung finalize delays the resumed autosave and the page refresh; `dispose()` skips the final save while a finalize runs, so edits that exist only in the finalize payload are lost if finalize fails before saving and the doctor navigates away mid-finalize; the ambiguous-conflict text is not set after an `exclusive` unknown outcome; one invalid field blocks the whole snapshot (the status now says everything since the last save is unsaved and names the field, for example "medicines 3 · dose"); a halted, held or failing engine still cannot save on unmount, which is why soft navigation (links, back and forward) now asks "You have changes that are not saved. Leave anyway?" in that state (`src/components/rx/use-leave-guard.ts`; it prompts when something is unsaved and the engine is halted, held, finalizing, retrying, in doubt after an ambiguous failure, or has a save in flight; an edit still in the debounce is sent by `dispose()` and never prompts; the sign-out form is guarded too, via `data-leave-guard`); a finalize conflict with nothing unsaved now enters the conflict halt (Keep / Load); after an unknown finalize outcome the page is re-read (`router.refresh`) only when the browser is online and the flush left nothing unsaved, otherwise (offline) a check runs on the next `online` event; online but unreadable, the text says to use Reload and promises no re-check, and Finalize is disabled while offline; a flush on a timed-out in-flight save retries once and then resolves.
- Discard: no concurrency tests for repeat-vs-amend or withdraw-vs-finalize-of-the-child (analysis in ADR-0023 says safe); a discarded draft cannot be restored (ADR-0031).
- Missing indexes on the new foreign-key columns `visits(tenant_id, doctor_id)`, `visits(tenant_id, branch_id)`, `prescriptions(tenant_id, template_version_id)`, which matter for offboarding scans at scale (Plan 1D). — resolved in Plan 1D (`a83e068`)
- Periodicity, dose ranges and `duration_value > 0` are checked by Zod only, not by database CHECK constraints; CHECKs and policies of migration 0012 exist only in SQL, not in the Drizzle schema (Plan 1D). — resolved in Plan 1D (`a83e068`)
- No catalogue-wide RLS guard test (every table with `tenant_id` has forced RLS and a `tenant_isolation` policy); `tenant_medicines.created_by` has no foreign key (Plan 1D). — resolved in Plan 1D (`7fd5657, a83e068`)
- `tenant_counters` still grants `DELETE` to the app role, and the e2e `seedPatients` still bypasses the counters (Plan 1D, as in 4.8). — resolved in Plan 1D (`7fd5657, a83e068`)
- The development database holds leaked test tenants from aborted runs; a sweep script is still to be written (Plan 1D, as in 4.8). — resolved in Plan 1D (`748d627`)
- The patient archive UI and unarchive remain open (ruled out of Plan 1B; Plan 1D). — resolved in Plan 1D (`70ffe3e`)
- Smaller deferred items: `cleanText` applies NFC before the invisible-character strip; `expectedRevision` is not validated like `baseRevision`; no column-classification guard test for amend/repeat copying (a new visit column could be copied or dropped silently); `getSessionContext` and `requireSession` duplicate logic; an unreviewed seed gap (a wrong-schema CSV header skips every row and exits 0).
- Not built, with their owners: nurse vitals entry (Phase 3, ADR-0030), Hindi labels for the new option codes (Plan 1D), the offline outbox (Phase 4), advice templates and medicine bundles, clinic-learned complaint and diagnosis suggestions, and an undo for discarded drafts (unscheduled; ADR-0031).
- Uploaded logos and signatures are stripped of EXIF/GPS and other metadata at upload (Plan 1C final fix, ADR-0035); assets stored before that are dev data and may still carry it. Assets are capped at 20 logos and 50 signatures per clinic (Plan 1C Task 6 fix round); the cap is checked inside the upload transaction without a lock, so two simultaneous uploads can overshoot by one.

### 4.10 Phase 1C checklist (pad renderer, PDF, print)

A box is ticked only for evidence seen on 2026-11-17 at commit `38fdb5d` (the code; documentation edits uncommitted when the gate ran): `npm run lint` 0 errors (2 existing warnings in `ui/form.tsx` and `use-toast.ts`), `npm run typecheck` clean, `npm run test` = 70 files, 1,604 passed + 1 skipped (the engine-required placeholder in `gotenberg-smoke.test.ts`), with Gotenberg up; `node scripts/verify-gate-0.mjs` (fourth run) ran lint, typecheck, those tests, `build:web`, `build:desktop` and the e2e suite and ended with `41 passed (4.7m)`, `8 skipped` (the screenshot tests, which need `RX_VISUAL`) and `Gate 0 verification PASSED`; `npm run test:visual` = 24 passed; `npm run build:desktop` run alone after the last code change exited 0 and `git status --short` was clean. Three earlier gate runs failed: the first two on the e2e print stub (the frame now outlives `print()`, so the stub has to fire `afterprint`; fixed in `177fe07` and `38fdb5d`), the third on a cold-dev-server timeout in the first `clinical-form` test (passed 3 of 3 alone and on the full re-run). Per-file counts are from a JSON-reporter run.

- [x] Data-driven renderer: General, Paediatric, Derma on A4 and A5 with English, Hindi, or bilingual labels (`tests/unit/rx-render.test.ts`, 92; `tests/unit/__golden__/`, 5 files; `rx-labels` and `rx-format` tests)
- [x] Hostile text printed literally; every document self-contained (`tests/unit/self-contained.test.ts`, 111; `rx-render.test.ts`; beacon probe, positive control and config-drift check in `tests/integration/gotenberg-smoke.test.ts`, 10 passed + 1 skipped)
- [x] Finalize freezes the printed details; reprints ignore later patient, clinic, and doctor edits; the finalizer signs, never the visit's doctor (`tests/integration/render-snapshot.test.ts`, 24; `tests/e2e/rx-output.spec.ts`, 4)
- [x] Clinic pad and doctor profile settings; NUL refused; logo and signature uploads validated from bytes (`tests/integration/pad-settings.test.ts`, 61; `settings-actions.test.ts`, 12; `tests/unit/settings-forms.test.tsx`, 9; `tests/e2e/pad-settings.spec.ts`, 2)
- [x] Server PDF through Gotenberg with timeouts, caps, health check, and a clear error state (`tests/unit/gotenberg.test.ts`, 30; `tests/integration/rx-output-routes.test.ts`, 32)
- [x] Print and download audited with ids and counts; non-draft previews audited as `prescription.previewed`; `prescription_outputs` append-only with composite keys (`tests/integration/print-schema.test.ts`, 31; `rx-output-routes.test.ts`)
- [x] Drafts preview only and are marked for read-only roles; superseded versions marked, printable, never repeated or amended; finalized versions show the frozen patient name; prescribers warned about an incomplete or missing doctor profile (`tests/unit/prescription-page.test.tsx`, 21; `tests/unit/output-actions.test.tsx`, 18; `tests/e2e/rx-output.spec.ts`)
- [x] `/prescriptions/:path*` in the middleware matcher (`rx-output.spec.ts`, signed-out test)
- [x] Print layout: embedded font, no requests, unsplit rows, one `.closing` wrapper, page counts in bounds, through Chromium and through the real Gotenberg engine (`tests/e2e/rx-visual.spec.ts`, 8 cases x 3 tests); screenshots and real PDFs reviewed by eye (`npm run test:visual`, 24 passed; findings below)
- [x] Desktop export unchanged (`npm run build:desktop`, exit 0, clean tree)
- [x] `node scripts/verify-gate-0.mjs` PASSED with the Phase 1C tests (41 passed, 8 skipped)

**Visual review (2026-11-17).** The Chromium screenshots and the real Gotenberg PDFs were read page by page (PDF pages rendered with PyMuPDF; `pdftoppm` is not installed here). Confirmed: the patient strip and column headings repeat on every page, including A5 bilingual with logo, banner and 30 medicines (7 pages); Devanagari draws with real glyphs; a 2,000-character word wraps inside the page; the signature always prints with the last section (`.closing`), never alone. Defects found and fixed in this review: the PDF footer printed "Rx 12 v1Page 1 of 7" together at the left (Chromium shrink-wraps the footer; now a full-width footer, pinned by a unit test and verified from the PDF word positions), and the four dose-slot headings split mid-word on A5 bilingual ("Mo r", "Nig ht"; slot columns widened, heading font reduced). Observations left as they are: the A5 bilingual watermark wraps to three or four lines and crosses the text (legible); A5 bilingual medicine rows are tall (the Food and Frequency cells wrap to four lines), so a 30-medicine pad needs 7 pages; a page can hold only the last section and the signature (Derma Hindi, page 2).

**Phase 1C known limitations and follow-ups** (from the review ledger; "owner" is the plan that should take it)

- Page numbers only in the Gotenberg PDF, not in browser print; no automated Safari print check (print one pad from Safari before ticking the Phase 1 exit criterion; human).
- A native Hindi speaker should review the pad labels in `src/lib/rx-render/labels.ts` and the Hindi status labels (human, before a pilot).
- The round-2 `checkSelfContained()` was never run against live-browser exploit payloads in the build session; defense in depth (CSP, JavaScript off, deny-list, re-check at serve time, the smoke probe) is the mitigation (whole-branch review).
- `outputFileTracingIncludes` for the fonts is verified only at the first real deployment; the CI workflow's Gotenberg job has not run on GitHub; production must block Gotenberg's network egress (staging plan).
- Demo seed prescriptions have no snapshot and print with the "finalized before print snapshots were recorded" note.
- A draft preview is not re-checked against a concurrent save (it may mix two saves for a moment; finalized copies are frozen).
- Every `rx.read` role (reception, nurse, pharmacist) can print and download the full clinical content: part of the data-minimisation decision in 4.9 (Plan 1D).
- The PDF concurrency limiter is per process and has no fairness or abort plumbing (Plan 1D, with sharing). A print counts when its HTML is served, not when the dialog is confirmed (ADR-0033). — abort plumbing resolved in Plan 1D (`d63435a`, `9cbc9f6`); still per process
- The asset cap (20 logos, 50 signatures per clinic) can overshoot by one under two simultaneous uploads; no malware scan of uploaded images (Phase 2.1); no PDF cache (ADR-0033).
- A Next dev-server `TypeError: controller[kState].transformAlgorithm is not a function` is logged once during the `pad-settings` role e2e test; the test passes and the cause is not investigated (Plan 1D). — resolved in Plan 1D: dev-only, 0 of 12 under `next start` (`1984351`)
- "Page x of y" in the PDF footer is English only (no Devanagari font in the footer template; Plan 1D). — decided in Plan 1D: stays English (ADR-0041)

**Plan 1C pilot follow-ups (added in the final fix wave)**

- HUMAN DECISION: an owner without a doctor profile can finalize (the pad then prints no doctor block); decide whether finalize must require a doctor profile with a name and registration number before any pilot.
- HUMAN DECISION: data minimisation for reception and pharmacist, who can print and download full clinical content (part of 4.9).
- Ops: production Gotenberg on a private network with no egress and `GOTENBERG_URL` set; run the CI Gotenberg job on GitHub; verify `outputFileTracingIncludes` (fonts) at the first deployment.
- Bug (Plan 1D): a date of birth is read as UTC midnight and shown or aged in IST in places; fix the UTC/IST handling. — resolved in Plan 1D (`b89284b`)
- HUMAN: Hindi label review, an actual Safari print check, and clinical review of the sample medicine list.
- Plan 1D: reproduce the dev-server `TransformStream` TypeError under `next start` to see whether it is dev-only. — resolved in Plan 1D (`1984351`): dev-only
- Optional: run a corpus of hostile payloads against `checkSelfContained()` in a real browser.
- Presentation is not frozen (templates, labels, CSS, fonts); each output records `renderer_version` (ADR-0032), so bump `RENDERER_VERSION` when printed output changes.

### 4.11 Phase 1D checklist (sharing, consent, CSV import, history, hardening)

A box is ticked only for evidence seen on 2026-11-18 at commit `4eb54f1` (the last code commit; the later commits are documentation): `node scripts/verify-gate-0.mjs` ended `Gate 0 verification PASSED` after `npm run lint` (0 errors, 2 existing warnings), `npm run typecheck` clean, `npm run test` = `Test Files 103 passed (103)`, `Tests 2121 passed | 1 skipped (2122)`, `build:web` and `build:desktop` OK, and the e2e suite `51 passed`, `8 skipped` (the opt-in screenshot tests). Then `npm run test:visual` = `24 passed` with no baseline change, `npm run build:desktop` exit 0 with `git status --short` showing only documentation edits (no `.desktop-stash`, `src/app/s` restored), and `npx drizzle-kit generate` = "No schema changes, nothing to migrate". Migrations 0017 to 0023.

- [x] Rows born as drafts; superseding needs a finalized successor; status vocabularies; counter DELETE/TRUNCATE revoked; RLS forced and tenant-scoped on every tenant table (`tests/integration/integrity-1d.test.ts`, `rls-guard.test.ts`)
- [x] Every CHECK declared in the Drizzle schema; periodicity, dose and duration checks; FK-column indexes; `tenant_medicines.created_by` composite key; test-tenant sweep (`schema-checks.test.ts`, `tenant-fk.test.ts`, `tests/unit/sweep-rules.test.ts`, `sweep-test-tenants.test.ts`)
- [x] DOB and ages on the clinic's calendar; a newborn at 00:30 IST registers (`tests/unit/clinic-date.test.ts`, `tests/integration/patients-dates.test.ts`)
- [x] Patient history: date, doctor, status and text filters, pages, Open / Print / Download / Repeat; archive and restore (`patient-history.test.ts`, `patient-archive.test.ts`, `tests/unit/prescription-history.test.tsx`, `tests/e2e/patient-history.spec.ts`)
- [x] CSV import: decoding, delimiters, mapping, Excel repairs, validation report, duplicate decisions, idempotent and concurrent-safe commit, formula-safe problem-row download (`tests/unit/{csv,csv-decode,patient-import-rows}.test.ts`, `patient-import.test.ts`, `patient-import-hardening.test.ts`, `patient-imports-schema.test.ts`, `tests/unit/import-wizard.test.tsx`, `tests/e2e/patient-import.spec.ts`)
- [x] Consent log with version and method; withdrawal and archive revoke links; per-clinic sharing switch, off by default (`sharing-schema.test.ts`, `consent.test.ts`, `tests/unit/consent-card.test.tsx`)
- [x] Share links hashed, 7 days, 10 opens, revocable; public interstitial and PDF; uniform 404; previews never count; rate limits; PDF abort (`tests/unit/{share-token,rate-limit,share-snapshot}.test.ts`, `share-links.test.ts`, `share-route.test.ts`, `rx-output-http.test.ts`, `gotenberg.test.ts`)
- [x] WhatsApp `wa.me` link and email provider behind consent; masked share log; Share panel; nurses and pharmacists cannot share (`tests/unit/{recipient,wa-link,email-provider,share-panel}.test.ts(x)`, `sharing.test.ts`, `prescription-page.test.tsx`, `tests/e2e/sharing.spec.ts`; the e2e opens the link in real Chromium and the form POST returns the PDF)
- [x] Hindi option labels in one place (printed output unchanged); in-app not-found; skip link; keyboard-only registration (`tests/unit/rx-option-labels.test.ts`, `tests/e2e/keyboard.spec.ts`)
- [x] Vendored React patch and Next 15.5.29 (`tests/unit/vendored-react-ping.test.ts`; `pad-settings` 12 of 12 under `next start`, ADR-0042)
- [x] Desktop export unchanged with `src/app/s` stashed (`npm run build:desktop`, clean tree)
- [x] `node scripts/verify-gate-0.mjs` PASSED with the Phase 1D tests; `npm run test:visual` 24 passed, no baseline changed

**Phase 1 exit criteria: evidence so far**

| Exit criterion (ROADMAP §3) | Automated evidence | What still needs people | Status |
|---|---|---|---|
| A repeat prescription is finalized, printed and shared in under 60 seconds (5 real users) | `prescriptions.spec.ts` (repeat), `rx-output.spec.ts` (print), `sharing.spec.ts` (WhatsApp link), `patient-history.spec.ts` (repeat from the list) | Time it with 5 real users at design-partner clinics; open a shared link from Android Chrome and the WhatsApp in-app browser | open |
| A new patient is registered in under 30 seconds by a receptionist | `keyboard.spec.ts` (keyboard-only registration; printed 1.0 s in the gate run, in automation) | Time it with receptionists | open |
| PDF output is visually consistent across Chrome, Safari and the print dialog | `rx-visual.spec.ts` (Chromium and Gotenberg, 24 screenshots passed against the reviewed baselines) | Print one pad from Safari | open |
| Finalized prescriptions are immutable; amendments create v2 with a reason and an audit event | `immutability.test.ts`, `immutability-races.test.ts`, `integrity-1d.test.ts`, `prescriptions-lifecycle.test.ts` | none | met (automated) |
| 5 design-partner clinics use it for 10 working days with no data-loss incident | none | The pilot itself (needs staging, see section 5) | open |
| Render failure rate < 1%; p95 finalize < 800 ms online | Local tests only | Staging metrics under real use | open |
| CSV import of the existing `sample_data/*.csv` shape works with a validation report | `patient-import.test.ts`, `import-wizard.test.tsx`, `patient-import.spec.ts` (patients, `sample_data/patients_template.csv`); `catalogue-seed.test.ts` (the catalogue lists) | none | met (automated) |

Final fix wave (after the whole-branch review): the individual gate steps were run on 2026-11-18 (lint and typecheck clean, `npm run test` 2,163 passed + 1 skipped in 107 files, `build:web` and `build:desktop` exit 0, e2e 51 passed and 8 skipped, `npm run test:visual` 24 passed). Port 3000 and 3100 were held by other projects' servers on this machine, so the e2e and visual runs used a temporary Playwright config on port 3217 instead of `verify-gate-0.mjs` itself; the commands and specs are the same.

**Phase 1D known limitations and follow-ups**

- HUMAN DECISION (still open): may an owner without a doctor profile finalize (sections 4.8–4.10)?
- HUMAN DECISION (still open): data minimisation for reception and pharmacists (`rx.read` unchanged; `rx.share` excludes nurses and pharmacists by default).
- HUMAN DECISION: WhatsApp Cloud API vs a BSP (ADR-0010, open decision #2). Not built; `wa.me` manual send only, delivery status unknown ("prepared").
- HUMAN: legal review of the English consent text and native-speaker review of every Hindi string (pad labels, option labels, consent text, share pages) before any clinic turns sharing on; sharing stays off per clinic until then.
- HUMAN DECISION: the email provider's data residency and legal basis for cross-border processing (Resend); the email carries clinic name, Rx number and link, no clinical text (ADR-0038).
- HUMAN/OPS: a Resend account and sender-domain DNS for email sharing. Click and open tracking is a Resend domain setting and MUST be off (a tracking redirect hands the token to the provider).
- HUMAN DECISION: links to a superseded version stay valid for their 7 days and show a SUPERSEDED marker (no automatic revocation on amend).
- HUMAN CHECK: open a shared link from Android Chrome and from the WhatsApp in-app browser before ticking the sharing exit criteria. Scanners that submit forms spend an open (cap 10); an Android WebView downloader may save the interstitial instead of the PDF (ADR-0037).
- OPS: the share token is in the URL path, so host, proxy, CDN and analytics logs must not retain `/s/*` URLs. `NEXT_PUBLIC_APP_URL` must be an https origin and `GOTENBERG_URL` set in production. Set `SHARE_CLIENT_IP_HEADER` on non-Vercel hosts. Add an edge rate limit in front of `/s/`; the public-route limits and the PDF limiter are per process. Verify at the first deployment that `/s/<token>` renders the Devanagari fonts (`outputFileTracingIncludes`). Install with lifecycle scripts enabled (ADR-0042).
- `createShareLinkIn` checks the clinic switch, the current consent, the archived state and the finalized snapshot itself and relies on its caller only for the `rx.share` permission; only `src/server/services/sharing.ts` calls it (ADR-0037). Link creation takes a KEY SHARE lock on the consent, prescription and patient rows (ADR-0036).
- Import rows that match an existing patient or an earlier row by name only (the phone differs or is missing) are skip-only: neither "add missing details" nor "register as new" is offered, and the report shows the basis of each match. "Add missing details" needs a phone match, or a patient without a phone and equal recorded birth dates. Whether the owner may register such rows from the wizard (twins, namesakes) is a human decision; today they use the patient form (ADR-0039).
- Import commit sends only the rows the owner changed (8-hex fingerprint each) and a bitmap of the duplicate rows, so 5,000 duplicates commit and the worst case is under 80 KB (ADR-0039).
- Sharing by email writes a `prepared` log row before the provider is called and an outcome row after (two rows per attempt); the daily cap counts attempts. If the outcome row cannot be written after a real send, the send is still reported and only the `prepared` row remains (ADR-0038).
- WhatsApp numbers: a `+` with ten digits starting 6-9 and no country code set apart, and a number with a leading 0 shaped like an STD landline, are refused with no suggested digits; the Share panel shows the full number and the patient's name before "Open WhatsApp" (ADR-0038). Each link ended by a consent withdrawal or an archive also gets a `share.revoked` system audit event.
- Builds (`npm run build`, `build:web`, `build:desktop`) run `scripts/patch-react-ping.mjs --check` first and fail when the bundled React is neither patched nor recognised (ADR-0042). The public-route rate limit reads `X-Real-IP` only when `SHARE_CLIENT_IP_HEADER` names it.
- Two simultaneous shares can overshoot the per-user or per-prescription link limits by one, and two emails the daily email limit (no lock).
- Dates in imports are always read day-first; a US-formatted file with days of 12 or less is read wrongly unless the owner notices the preview.
- Temperature stays °F and "Page x of y" stays English (ADR-0041).
- TransformStream dev-server error (`controller[kState].transformAlgorithm is not a function`): dev-only, 0 of 12 runs under `next start` (Task 11, `1984351`). Its production look-alike (stuck saves) was a real React bug, fixed in `9009c9d` (ADR-0042).
- `npm audit` reports 25 vulnerabilities in other packages (follow-up; not addressed in 1D).
- Ops: a Docker Desktop restart stops the project containers; run `docker compose up -d postgres gotenberg` before any gate run.
- Other columns that hold a user id without a key (`patients.created_by`, `clinic_assets.created_by`, `prescription_outputs.actor_user_id`, `audit_events.actor_user_id`, `prescriptions.finalized_by`, the new `*_by` columns) are unchanged; only `tenant_medicines.created_by` was asked for.

---

### 4.12 Phase 2A checklist (overlay pads)

Evidence rule: a box is ticked only for evidence seen on 2026-11-19 at the commit named in "Gate run". Items marked PENDING were not seen (or need a person). Gate run: code at `72e98eb` (docs-only commits on top); lint, typecheck and the visual, pdf-frame, e2e, build and drizzle steps ran in one scripted session, vitest was re-run with `--maxWorkers=4` (see below)

- [x] Spikes S1 to S5 with findings: `docs/spikes/2026-11-18-s1-overlay-print.md` (GO-WITH-FALLBACK), `s2-pdfjs-frame.md` (GO-WITH-FALLBACK, pdfjs-dist 6.5.438 after the addendum), `s3-docxtemplater.md` (GO, input for 2B), `s4-clamav.md` (GO), `s5-gotenberg-upgrade.md` (GO); commits `ab8d278`, `4e3dda3`, `72496c9`, `658a9c6`, `47f9628`, `fd82ca4`
- [x] Gotenberg 8.40.0 pin across compose, CI and the smoke test (`3b33501`; `engine-pins.test.ts`)
- [x] Template schema and guarantees: migrations 0024 to 0028 (`b3710a2`, `f413126`, `2aa5f99`); immutability, per-version binding, quotas, RLS, composite keys, CHECKs in Drizzle (`tests/integration/templates-schema*.test.ts`, `schema-checks.test.ts`, `tenant-fk.test.ts`)
- [x] Scanner and container: ClamAV 1.4.6 pinned, hardened, drift-checked (`31d0913`; `clamav-smoke.test.ts` ran against the real container in the vitest run below)
- [x] Upload pipeline: route handler, caps, scan of original and stripped bytes, quotas, GC, audit (`e9209b8`, `5ab8f09`)
- [x] Field catalogue and sample data (`cc3bdd6`, `d25f823`); overlay definition schema v1 and geometry rules with a pinned golden hash (`07901c2`)
- [x] Overlay renderer and goldens; real Gotenberg spacer PDF test with PyMuPDF 1.28.0 (`c022cc4`, `c5076df`)
- [x] Snapshot v2 and resolution; hash check at reprint; output plumbing (`f413126`, `976af90`)
- [x] Roles and designer role, migration 0028 (`2aa5f99`, `8a0a8b9`)
- [x] Template Studio: list, wizard (photo, image, PDF through the sandboxed frame), editor, previews, publish with omitted-section acknowledgement, assign, history and rollback (`7c3e9ce`, `cd3286d`, `eda35c8`, `8e99199`, `6168a6c`, `72e98eb`)
- [x] Print modes, offset, alignment page, per-browser print default (`3495355`)
- [x] Cross-tenant sweep: 56 tests plus a completeness guard, no leak found (`39df089`)
- [x] Overlay visual cases (6 new baselines, 3 renderings each) (`cfb3d8f`)
- [x] Template Studio e2e flow (`c8925f4`, `f8c71f7`, `51323a0`)
- [x] `npm run lint`, `npm run typecheck`: lint 0 errors and 2 existing warnings, typecheck clean (both exit 0)
- [x] `npm run test` (CLAMAV_REQUIRED=1 CI=true GOTENBERG_REQUIRED=1): 157 files, 2,760 passed + 4 skipped (`npx vitest run --maxWorkers=4`, 424 s, real clamd and Gotenberg, PyMuPDF 1.28.0). With the default worker count two earlier runs lost 6 and 9 test files to `Failed to start forks worker ... Timeout waiting for worker to respond` (machine load: a different set of files each time, 151 and 148 files ran and passed); the capped run is the evidence, and the timeout is an environment issue, not a test failure
- [x] `npm run test:visual`: 42 passed (24 existing baselines untouched + 18 new overlay renderings), real Gotenberg 8.40.0
- [x] `npm run test:pdf-frame`: 21 passed in Chromium, Firefox and WebKit (scan, CCITT, JBIG2, JPEG 2000, Devanagari fixtures)
- [x] e2e (temporary Playwright config, `next dev --turbopack`): 67 passed, 21 skipped (opt-in visual and pdf-frame specs), 0 failed; specs: smoke, patients, patient-history, patient-import, prescriptions, rx-output, sharing, pad-settings, clinical-form, keyboard, templates; Chromium only, port 3481, `next dev --turbopack`
- [x] `build:web`, `build:desktop`: `npm run build:web` exit 0 (2m39s) and `npm run build:desktop` exit 0 (2m05s)
- [x] `npx drizzle-kit generate`: `No schema changes, nothing to migrate`
- [ ] Visual PDF review by a person (name, date): PENDING. The implementer read rasterized PDFs for the overlay cases (task report 20b/c) but a human review of the real PDFs in `test-results/rx-visual-pdf/` has not happened.
- [ ] `node scripts/verify-gate-0.mjs` as ONE command: NOT run as one command (its e2e step needs port 3000 and the default Playwright config; the steps were run individually, e2e through a temporary config on port 3481 with a matching `NEXT_PUBLIC_APP_URL` and `AUTH_URL`). Port 3000 was not touched.

**Phase 2A exit criteria (spec section 4.3): evidence**

| Exit criterion | Evidence | Status |
|---|---|---|
| A photo, scan or PDF pad prints with real data | `templates.spec.ts` (upload, place, preview, publish, finalize, print, PDF, share), `template-*.test.ts` | met (automated) |
| Hindi patient name and labels | overlay goldens, `overlay-a5-12-medicines-hindi` visual, Devanagari PDF fixture in e2e | met (automated); native-speaker review PENDING |
| Missing signature | unit tests, `overlay-a4-draft-no-signature` visual | met (automated) |
| A4 and A5 | visual cases (A5 bilingual 12 medicines) | met (automated); A5 bilingual age/gender wrapping needs a human look |
| 12 medicines overflow with repeated header and repeated patient boxes | visual cases and `overlay-spacer-pdf.test.ts` (text per page, real Gotenberg) | met (automated); last-page spill of follow-up and signature is a human decision |
| No cross-tenant read | `template-cross-tenant.test.ts` | met (automated) |
| Median setup time on design partners under 10 minutes | scripted baseline is unusable (the e2e's setup-seconds is dominated by cold dev compile); a warm-build timing figure is PENDING | PENDING (needs staging and the pilot) |

Funnel query for when staging exists:

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

(The action names are the plan's; check them against the audit writers before relying on the query.)

**Open human decisions (Phase 2A)**

- Printer offset in the content hash (ADR-0047): decide before any clinic publishes a non-zero offset; recommended per-clinic or per-printer print-time adjustment recorded on each output row. Acceptable for the pilot only while offsets are zero.
- Letterhead lock: strict default (bound pads) and an explicit server-side confirmation for `dynamic` ("this letterhead shows no doctor") (Q6/Q10).
- Last-page spill: the follow-up and signature block can land alone on a last page.
- A5 bilingual header crowding and a default split of the age and gender box.
- Print the Rx number and "Page x of y" when output spans pages (consider).
- Screenshot tolerance for overlay baselines (`maxDiffPixelRatio` 0.001, provisional, Q9) and an as-issued PDF store (Q16).
- Designer accounts: an audited provisioning script with expiry instead of raw SQL, before any clinic hires a designer.
- Hosting: AWS ap-south-1, private subnet with no egress; `clamav-update` as the only egress, scheduled a few times a day, with an alarm on signature age.
- ClamAV is GPL-2.0 (fine over a socket for SaaS); legal review before bundling it into the desktop build. PyMuPDF (AGPL) stays test-only.
- Whether the 10-clinic time-to-first-prescription criterion is measured at staging with design partners.

**Pending human checks (none done)**

- Print an overlay pad from Firefox, Safari and iOS (`OVERLAY_BROWSER_PRINT` stays chromium-only until then) and open the PDFs in Adobe and phone viewers.
- Real printers on pre-printed stationery (offset calibration; alignment page prints from HTML while Firefox and Safari print from the PDF).
- Side-by-side Gotenberg 8.11 vs 8.40.0 PDFs.
- Real Word "Save as PDF", real scanner JBIG2 (arithmetic and symbol modes) and encrypted PDFs through the frame.
- Screen reader pass and touch drag on the editor (Backspace delete without undo, live-region noise and Alt+Arrow vs browser Back are known and not fixed).
- Native-speaker review of the Hindi in overlay labels and sample data.
- Warm-build timing figure for the 10-minute criterion.

**Phase 2A carried minors and deferred items**

- Deferred by ruling: a database check that the snapshot hash, paper and labels equal the version's (needs a migration); an engine version column on output rows; the race between file GC and a dedupe reuse; `lockTemplate` loads every version; no log of a damaged pad on share open; `templates.kind` is not frozen once published; the PDF_TOO_LARGE message gives the wrong advice to someone already printing through the PDF; untested guards (archived pad publish, un-archive over quota, version quota) and a weak finalize-versus-publish test; neutral draft-preview wording; designer redirect and rollback wording polish.
- Known quirks: the screen preview shows the footer band mid-page after page 1; webpack `next dev` exhausts Postgres connections (use `--turbopack`); a server-side `transformAlgorithm is not a function` stream error appeared once in dev on an aborted request (dev noise); flaky `template-upload-route` "audits 413" passed alone once; `prescriptions-clinical` has a pre-existing flaky read under load.
- `tests/integration/editor-endpoints.test.ts` was left alone by instruction.

---

## 5. In progress

Remaining Phase 0 work is the open boxes in section 4: staging deploy and restore drill on staging, pre-commit hook, SETUP.md clean-machine verification, 360 px visual check, MFA design note, first CI run on GitHub.

Phase 1A is code complete and its automated gate passed locally on 2026-11-16 (section 4.8). What is open is the Phase 0 ops list above and the Phase 1A follow-ups in section 4.8; Phase 1 as a whole (1C-1D) is not done.

Phase 1B is code complete and its automated gate passed locally on 2026-11-17 (section 4.9); its follow-ups are listed there.

Phase 1C is code complete and its automated gate passed locally on 2026-11-17 (section 4.10); its follow-ups are listed there.

Phase 2A (overlay pads) is code complete; see section 4.12 for the gate evidence and the pending human checks.

**Next:** a design-partner pilot needs staging (Phase 0 carry-overs) and the human decisions in sections 4.11 and 4.12. Phase 2B (DOCX) needs pilot evidence, Gate 1, the S3 finding and staging with the conversion container egress-blocked; its ADRs start at ADR-0049 and its migrations at 0029.

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

### 2026-11-17 — Phase 1C: pad renderer, server PDF, print, clinic pad and profile settings
- Did: shipped Phase 1C on `phase-1-prescription-mvp` (plan commit `b034109` to `38fdb5d`), each task reviewed. Migrations 0013 (render snapshot, `prescription_outputs`, `clinic_assets`), 0014 (their security) and 0015 (outputs allow-list trigger, admin-level immutability, integrity checks). A pure renderer with General, Paediatric and Derma templates on A4/A5 and English, Hindi or bilingual labels; a deny-by-default self-contained checker; a hardened Gotenberg engine (loopback, digest-pinned, JavaScript off, deny-list); print details frozen at finalize and signed by the finalizer; Print (hidden frame, removed on `afterprint`) and Download PDF with an append-only output log and audit events; clinic pad and doctor profile settings with validated logo and signature uploads. Decisions ADR-0032 to ADR-0035. Task 11 also folded in the review minors (print frame lifetime, image upload status messages, settings form tests, PDF engine guard tests, smoke tests that fail instead of skipping when Gotenberg is required, Derma route printed once) and added the visual spec, which found and fixed two real PDF defects (footer alignment, dose-slot headings).
- Evidence: see section 4.10 (`npm run test` 70 files / 1,604 passed + 1 skipped; `node scripts/verify-gate-0.mjs` PASSED with `41 passed`, `8 skipped`; `npm run test:visual` 24 passed; `npm run build:desktop` exit 0, clean tree).
- Blocked by: nothing for the automated gate. Staging, CI on GitHub, pre-commit hook, 360 px check and MFA note remain open (Phase 0 carry-overs).
- Next: Plan 1D (sharing, CSV import, filters, hardening). Human decisions before any pilot: Hindi label review, a Safari print check, owner finalizing without a doctor profile, reception/pharmacist reading and printing clinical content, clinical review of the sample medicine list.
- Gotchas: Gotenberg must be up for the e2e PDF checks (`docker compose up -d gotenberg`); with `GOTENBERG_REQUIRED=1` or `CI=true` the smoke tests fail instead of skipping. Run vitest from an uppercase drive letter (a bash shell started as `/e/...` makes every test fail). `pdftoppm` is not installed here: read PDF pages through PyMuPDF. Chromium footer templates need `html{width:100%}` or the two footer spans sit side by side. A print frame that is sandboxed without `allow-scripts` never runs timers, so an e2e `print()` stub must dispatch `afterprint` synchronously.

- Plan 1D, production-only stuck saves (debug after Task 11): under `next start`, saving the pad or uploading a logo sometimes stayed on "Saving…"/"Uploading…" forever. Root cause: a React bug in the build Next 15.5.2 bundles (a ping that arrives during the render is dropped, facebook/react#36134), hit when a `revalidatePath` action response streams in. Fixed by `scripts/patch-react-ping.mjs` on `postinstall`, guarded by `tests/unit/vendored-react-ping.test.ts`. Evidence: pad-settings 5 of 12 runs failed before, 24 of 24 passed after under `next start`, 12 of 12 under dev; full dev e2e 51 passed, 8 skipped; `npm run test` 2,121 passed + 1 skipped. Task 12 should record this as an ADR. Report: `.superpowers/sdd/2026-11-17-phase-1d-sharing-import-hardening/debug-pad-settings-report.md`.

- Plan 1D, public share route (Task 9b fix round): verify at the first deployment that `/s/<token>` renders a PDF with the Devanagari fonts on the host (`outputFileTracingIncludes` lists the font files for `/s/**` as for `/prescriptions/**`; it cannot be proven by a local build), and set `SHARE_CLIENT_IP_HEADER` if the host is not Vercel (production logs once when no client address header arrives).

### 2026-11-18 — Phase 1D: sharing, consent, CSV import, history, hardening
- Did: shipped Phase 1D on `phase-1-prescription-mvp` (`7fd5657` to `4eb54f1`): database hardening (migrations 0017 to 0023: rows born as drafts, successor check, CHECKs mirrored in the schema, RLS guard, sweep script), clinic-timezone dates, patient history filters with archive and restore, patient CSV import with duplicate decisions, an append-only consent log, hashed expiring share links with the public `/s/<token>` route, `wa.me` and email sharing behind a per-clinic switch with a masked share log, Hindi option labels, in-app not-found, skip link, and a Next 15.5.29 upgrade with a vendored React patch (stuck server actions under `next start`). Decisions ADR-0036 to ADR-0042.
- Evidence: see section 4.11 (`npm run test` 107 files / 2,163 passed + 1 skipped; `node scripts/verify-gate-0.mjs` PASSED, e2e 51 passed and 8 skipped; `npm run test:visual` 24 passed; `npm run build:desktop` exit 0).
- Blocked by: nothing for the automated gate. Staging, CI on GitHub, pre-commit hook, 360 px check and MFA note remain open; the human decisions in section 4.11 gate any pilot.
- Next: staging and a design-partner pilot, then Phase 2 (ADRs from ADR-0043, migrations from 0024).
- Gotchas: rows are born as drafts (insert then UPDATE to finalize); a `finalized -> amended` flip needs a finalized child first; every CHECK must also be declared in the Drizzle schema; `as("reception")` returns a new random user per call (capture one context when asserting on it); `/s/` is outside the middleware and must stay session-less; the e2e sharing spec needs Gotenberg up for its PDF branch; production-mode sharing needs an https app URL and `GOTENBERG_URL`; `npm install --ignore-scripts` skips the React patch; a Docker Desktop restart stops the containers.

### 2026-11-19 — Phase 2A: overlay pads (Template Studio)
- Did: shipped Phase 2A on `phase-1-prescription-mvp` (`ab8d278` to `72e98eb`, docs `17e7a8e`, `381f643` and this one): five spikes, Gotenberg 8.40.0, template schema (migrations 0024 to 0028), hostile-upload pipeline with ClamAV, sandboxed PDF intake frame, overlay renderer and snapshot v2, Template Studio UI, print modes, designer role, omitted-section acknowledgement, cross-tenant sweep, overlay visuals and e2e. ADR-0043 to ADR-0048.
- Evidence: see section 4.12 (code at `72e98eb` (docs-only commits on top); lint, typecheck and the visual, pdf-frame, e2e, build and drizzle steps ran in one scripted session, vitest was re-run with `--maxWorkers=4` (see below)).
- Blocked by: staging and the human decisions and checks in section 4.12.
- Next: staging and a design-partner pilot; Phase 2B only after pilot evidence.
- Gotchas: ClamAV container and PyMuPDF are gate dependencies; run e2e with `next dev --turbopack` on a free port with matching `NEXT_PUBLIC_APP_URL` and `AUTH_URL`; Firefox and Safari print overlay pads through Gotenberg; designer accounts are raw SQL today.

---

## 12. How to update this file

1. Change the **Last updated** date and snapshot.
2. Move finished checklist items to `[x]` and add the evidence link/command.
3. Keep **Next 10 tasks** short; if it grows past 10, move extras into the phase plan.
4. Add a session log entry — one per session, not per commit.
5. Never mark a gate passed without the evidence block filled in.
