# ClinicPad Phase 1B — Clinical Form, Medicine Catalogue, and Draft Autosave

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A doctor writes a real prescription on a server-backed clinical form (vitals, complaints, history, examination, diagnosis, structured medicines with dose schedules, investigations, advice, follow-up), picks medicines from a searchable catalogue with personal favourites, and never loses an edit: the draft autosaves with a visible saved/saving/not-saved state, survives a dropped connection, and refuses to silently overwrite a newer version. An unwanted draft can be discarded and an unwanted correction withdrawn. First, the last tenant-owned references without a foreign key (`visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id`) get composite keys.

**Architecture:** Migration 0010 adds composite same-tenant keys for the doctor, branch, and template-version references and one doctor profile per user per clinic. New clinical content lives in columns on `visits` (text arrays plus typed jsonb) and new columns on `prescription_items`, so Plan 1A's immutability triggers already freeze it. The catalogue is two global read-only reference tables (seeded from `sample_data/*.csv` on the admin connection) plus two tenant tables (clinic medicines, per-doctor favourites with a composite key to `doctors`) under the standard RLS policy. Drafts carry a `draft_revision`; every save sends a full snapshot with the revision it was based on, the server rejects stale revisions with `conflict`, and a pure client-side autosaver keeps exactly one save in flight, retries network failures, and finalizes through the same queue. Typeahead search uses a GET route handler; mutations use thin server actions over services that enforce `can(role, action)` inside `withTenant()`.

**Tech Stack:** Next.js 15.5 (App Router, server actions, route handlers), React 19, TypeScript strict, Drizzle ORM 0.45 + drizzle-kit 0.31, Postgres 16 with forced RLS, Zod 4.1, Vitest 5 + Testing Library (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-clinicpad-platform-design.md` (roles §4, domain model §7, offline §9). Feature detail: `docs/PRODUCT_SPEC.md` §6.3 (visit contents and capabilities). Roadmap: `docs/ROADMAP.md` §3 workstreams 1.3, 1.4, and the autosave part of 1.2. Data model reference: `docs/DATA_MODEL.md` §3.3–3.4 and `formulary_items` in §3.8.

**Code this plan builds on:** Plan 1A **as implemented** on branch `phase-1-prescription-mvp` (HEAD `631f96b` when this plan was reconciled, including the whole-branch review fix wave `549decd`). The implementation deviated from the text of `docs/superpowers/plans/2026-11-12-phase-1a-patients-and-prescription-core.md` in many review rounds; **where that plan's text and the code differ, the code and ADR-0022 to ADR-0026 (`docs/DECISIONS.md`) win.** Read these before Task 1: `src/server/services/prescriptions.ts`, `src/server/services/{context,audit,numbering}.ts`, `src/server/validation/prescription.ts`, `src/server/actions/prescriptions.ts`, `src/lib/{result.ts,domain/permissions.ts,domain/ids.ts}`, `src/server/db/{tenant,errors}.ts`, `src/server/db/schema/{clinical,tenancy}.ts`, `drizzle/0004`–`0009`, `tests/helpers/tenant.ts`, `tests/e2e/helpers.ts`, `tests/e2e/prescriptions.spec.ts`, `src/components/rx/*`, `src/app/(app)/prescriptions/[id]/page.tsx`.

## Prerequisites

Plan 1A must be fully merged before Task 1 starts. Check, from PowerShell:

```powershell
Set-Location E:\projects\clinicpad; Test-Path src/lib/result.ts, src/lib/domain/permissions.ts, src/server/services/prescriptions.ts, src/server/services/audit.ts, src/server/validation/prescription.ts, src/server/validation/text.ts, src/components/rx/draft-editor.tsx, src/components/rx/read-only-view.tsx, src/components/rx/repeat-form.tsx, src/components/patients/allergy-banner.tsx, tests/helpers/tenant.ts, tests/integration/prescriptions-db-errors.test.ts, drizzle/0009_tenant_composite_fks_phase0.sql
Get-ChildItem drizzle -Filter *.sql -Name
npm run test
```

Expected: thirteen `True` lines; the migration list ends with `0009_tenant_composite_fks_phase0.sql` (so this plan's migrations are `0010`, `0011`, and `0012`); a green run (413 tests in 23 files at reconciliation time, more if later work landed). If a later change edited a function this plan replaces (a message, an extra check), keep that behaviour and apply only this plan's additions; every replacement below names the exact function it replaces.

Facts from the Plan 1A implementation that this plan relies on (each is pinned by an existing test; do not weaken it):

- **Immutability (ADR-0023, migrations 0004, 0005, 0006, 0008).** `finalized`/`amended` prescriptions, their items, and finalized visits reject `UPDATE`/`DELETE` with SQLSTATE `23000`, also on the admin connection. The `finalized -> amended` flip may change nothing but `status`/`updated_at`. A draft visit whose prescription is no longer a draft accepts only the plain `draft -> finalized` flip (`status`, `finalized_at`, `updated_at` may change; every other column is compared through `to_jsonb`). Item triggers fail closed (`23503`) on a missing or foreign parent and read the parent `FOR SHARE`. Non-draft rows are deletable only when `tenant_is_erased(tenant_id)`. New **columns** on `visits`, `prescriptions`, and `prescription_items` are therefore covered automatically; a new **child table** holding clinical content of a prescription or visit would need its own trigger in the same style (this plan adds none).
- **Lock rule.** Every writer locks the prescription row `FOR UPDATE` before touching its items or visit (`saveDraft`, `finalizePrescription`, `amendPrescription` do).
- **Same-tenant references (ADR-0025, migrations 0007, 0009).** Every FK into a tenant-owned table is composite `(tenant_id, x_id) -> parent(tenant_id, id)`; `tests/integration/tenant-fk.test.ts` fails on any single-column FK into a table that has a `tenant_id` column (its allowlist is empty). Three tenant-owned references still have **no foreign key at all**: `visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id`. `doctors` has no `(tenant_id, id)` unique key and nothing stops two `doctors` rows for one user in one tenant (so `doctorIdFor` may pick an arbitrary row). Task 2's **first** migration (0010) fixes all of this before anything references `doctors`.
- **Roles (ADR-0026, `src/lib/domain/permissions.ts`).** Nurse is read-only on patients; reception, nurse, and pharmacist read prescriptions; the accountant reads neither; only owner and doctor draft, finalize, amend, and repeat. `tests/unit/permissions.test.ts` checks every role x action cell through a `Record<Action, ...>` map, so adding an action means adding its row there (Task 1).
- **Lifecycle signatures.** `startPrescription(ctx, { patientId })`, `getPrescription(ctx, id)` (its view carries `patient: { id, name, patientNo, allergies: string[] }`), `saveDraft(ctx, id, raw)` (deletes and re-inserts all items, so **item ids are not stable across saves**), `finalizePrescription(ctx, id)` (decides first version vs amendment by `parentPrescriptionId`; an amendment without an `rxNo` is refused with `conflict`), `amendPrescription(ctx, { prescriptionId, reason })` (audit `after: { version, parentPrescriptionId, reasonLength }`, never the reason), `repeatPrescription(ctx, id)` (refuses a draft and a superseded `amended` source with `conflict`), exported `copyItems(tx, ctx, from, to)`. Private helpers `doctorIdFor`, `invalidFromDatabase`, `IMMUTABLE_MESSAGE`, `AMENDMENT_IN_PROGRESS`, `OPEN_AMENDMENT_INDEX`, `prescriptionNotFound`, `patientNotFound` live in `prescriptions.ts`.
- **Lock order of the amendment pair.** Finalizing an amendment locks the **child** (the amendment) first and then flips the parent; `amendPrescription` locks the **parent** and then looks for an open child with a plain `SELECT`. That cannot deadlock only because amend's open-amendment check returns **before any write**. Every rewrite of `amendPrescription` in this plan keeps check-before-write.
- **Text and date validation (Plan 1A review fix wave).** `src/server/validation/text.ts` exports `hasNoNul`, `NUL_MESSAGE`, `blankToUndefined`, `optionalText(max)`; every free-text field of the draft schema and `amendReasonSchema` (exported from `src/server/validation/prescription.ts`) refuses a NUL with `invalid` (a NUL is never silently removed); follow-up dates are bounded to 1900-01-01..2100-12-31; `saveDraft` and `amendPrescription` map Postgres `22021`/`22007`/`22008` to `invalid` through `invalidFromDatabase(error, { text?, date? })`. Tests: `tests/integration/prescriptions-draft.test.ts` ("a NUL character in free text", "follow-up date range"), `tests/integration/prescriptions-db-errors.test.ts` (mocks `draftInputSchema` with a pass-through, so the service must tolerate fields the schema would normally default).
- **UI and actions.** `saveDraftAction` (save-then-finalize via `intent=finalize`) feeds `DraftEditor`; `repeatAction` returns `{ error }` to `RepeatForm`; the prescription page shows `<AllergyBanner allergies={rx.patient.allergies} showWhenEmpty />` (`src/components/patients/allergy-banner.tsx`) in its header for drafts and finalized versions, shows Amend and Repeat only on `finalized` versions, and answers every failed read (forbidden, malformed, unknown, foreign) with `notFound()`. Pages are `force-dynamic`; nothing calls `revalidatePath`.
- **Live patient data.** A finalized prescription page reads the patient row live (name, number, allergies), so a later patient edit changes what an old prescription shows; Plan 1C introduces the frozen snapshot. This plan adds **no** further live patient reads to the finalized view.
- **Test helpers.** `createTestTenant(label)` returns `{ tenantId, as(role), cleanup() }` and is failure-safe; `as("owner")` and `as("doctor")` share one user with a doctor profile, other roles get a random user id. Sign-up (`createClinicAccount`) creates a doctor profile for the owner. e2e: `registerClinic(page, label)`, `cleanupClinic(email)`, `setRole(email, role)`, `withAdminSql(work)`, `seedPatients(email, count)` in `tests/e2e/helpers.ts`.

If the fix wave landed with different names than listed above (helper module, constants), use the real names; the behaviour is what this plan builds on.

Known Plan 1A follow-ups this plan closes (from `docs/PROGRESS.md` §4.8 and the review ledger): the missing keys on `visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id` and the arbitrary `doctorIdFor` row (Task 2 Part A); a blank diagnosis chip rejects the whole save (Task 3 drops blank phrase entries); no autosave and no unsaved-changes guard (Tasks 8 and 10); stale "Saved at" text after later edits (Task 10 status bar); e2e typing before hydration (Task 10 disables the editor until it is live); `DraftFormState.field` unused and index keys on medicine rows (Task 10 removes the old editor; rows use stable client keys); Finalize gated on `rx.draft` instead of `rx.finalize` (Task 10); no way to discard a draft or withdraw an open amendment, and repeat ignoring an open amendment (Task 11). Not taken by this plan although `docs/PROGRESS.md` lists it under Plan 1B: the patient archive UI and unarchive (no ruling or design yet; see the Self-review).

## Where this plan sits in Phase 1

Plan 1A's split table listed the template renderer and PDF under 1B. The split has since been refined to four plans so each one ships independently:

| Plan | Roadmap workstreams | Ships |
|---|---|---|
| 1A (done) | 1.1 core, 1.2 lifecycle, 1.8 list, 1.9 audit | Patients + immutable, audited prescription lifecycle |
| **1B (this plan)** | 1.3 clinical form, 1.4 medicine catalogue, 1.2 draft autosave | The real clinical form on server data, catalogue + favourites, lossless autosave |
| 1C | 1.5 template renderer + 3 built-in templates, 1.6 server PDF + print | A prescription that looks like a pad and prints/downloads |
| 1D | 1.1 rest (CSV import, merge), 1.7 sharing, 1.8 filters, 1.10 hardening (Hindi/English, keyboard flow, empty states) | Pilot-ready for design partners |

Do not pull 1C/1D work into this plan: no template rendering, no PDF or print, no WhatsApp/email, no CSV import UI, no Hindi strings. Plan 1D also owns the date-of-birth UTC/IST rule, `CHECK` constraints on status columns, revoking `DELETE` on `tenant_counters`, the insert guard for already-finalized rows, and the e2e `seedPatients` counter bypass; do not touch those here.

## Decisions made in this plan

Each line: decision — reason — cost if wrong. Tasks 2–11 implement them; Task 12 records the durable ones as ADR-0027 to ADR-0031 (ADR-0022 to ADR-0026 are taken by Plan 1A).

1. **Visit clinical content is stored as columns on `visits`** (`complaints`, `medical_history`, `drug_history` as `text[]`; `examination_notes`, `follow_up_reason` as `text`; `vitals` and `investigations` as typed `jsonb`) instead of new child tables — matches the visit columns in `docs/DATA_MODEL.md` §3.3, is frozen by Plan 1A's `visits_immutable` trigger (including the 0008 guard that compares every column of a draft visit whose prescription is already finalized) with no new trigger, and makes amend a one-row copy — if vitals trends or lab orders with result status are needed later, extract `vitals`/`investigations` tables with a one-off SQL migration **and give each new child table its own ADR-0023-style trigger** (Task 2's test proves the coverage of the columns).
2. **Vitals are one jsonb object per visit; temperature is °F; BMI is computed, not stored; physiologically impossible values are rejected** — India-first convention, BMI is derivable, typos like pulse 720 must not reach a medico-legal record — adding °C later means one optional `temperatureUnit` key.
3. **Global catalogue = two read-only reference tables without `tenant_id` (`global_medicines`, `global_clinical_terms`) plus tenant tables (`tenant_medicines`, `medicine_favourites`)**, not one table with a nullable `tenant_id` — keeps the standard isolation policy untouched on every tenant table; read-only is enforced by revoked privileges and a forced select-only RLS policy — merging into one formulary table later is a data migration.
4. **Favourites belong to a doctor profile: `medicine_favourites.doctor_id` with the composite FK `(tenant_id, doctor_id) -> doctors(tenant_id, id)` `ON DELETE CASCADE`; one saved line per medicine name per doctor (upsert); they double as dose/timing presets; built-in schedule and duration presets are constants in code.** The service resolves the caller's doctor row from the session user (`doctors.user_id`, unique per tenant after migration 0010); a prescriber without a doctor profile (an owner whose profile was removed; sign-up always creates one) sees no favourites and gets `invalid` when saving one — the database itself guarantees a favourite never points at another clinic's doctor (ADR-0025), one concept covers "favourites" and "dose presets", and a double-click cannot create duplicates — several favourites per medicine would need a label column and a different unique key.
5. **Dose schedule is four `numeric(5,2)` slots (morning/afternoon/evening/night, quarter steps) plus the existing free-text `timing` column as a fallback** — the legacy pad prints separate M/A/E/N columns, insulin needs values like 12 and 10, and anything that is not a slot schedule ("every 6 hours") still fits — low.
6. **Duration is `duration_value` + `duration_unit` (days/weeks/months) with the existing `duration_days` kept as derived total days (month = 30); Plan 1A rows are read as days; no backfill** — finalized rows cannot be updated (immutability triggers), so the new shape must coexist with the old — two representations are owned by one service function (`prescriptionItemSchema`).
7. **Autosave concurrency rule: optimistic `draft_revision` + full-snapshot saves + one save in flight per editor.** The server locks the prescription row, rejects a stale `baseRevision` with `conflict` and the current revision; the client never sends two saves at once, retries network failures with backoff (1 s doubling to 30 s), stops on conflict until the user reloads or explicitly keeps their version, and finalizes the exact revision it saved (`expectedRevision`) — no interleaving, no reordering, no silent overwrite — two windows produce a conflict banner instead of a merge.
8. **Autosaves are not audited; the finalize and amended events add a clinical summary (counts and field names) to Plan 1A's payload** (`{ rxNo, version }`, plus `parentPrescriptionId` for `prescription.amended`); the amendment-drafted event keeps Plan 1A's `{ version, parentPrescriptionId, reasonLength }` (the reason text never reaches the log, ADR-0024) — an append-only event every few seconds has no medico-legal value because drafts are not records — add a throttled `prescription.draft_saved` event if an auditor asks.
9. **Only roles with `rx.draft` (owner, doctor) edit any clinical field, vitals included; nurse vitals capture is deferred to the Phase 3 queue flow** — a nurse writing into a doctor's open draft would collide with the doctor's autosave — a later `visit.vitals` action plus a vitals-only service; schema unchanged.
10. **Typeahead search uses a GET route handler (`/api/catalogue/search`), mutations use server actions** — React processes server actions one at a time, so search behind a slow autosave would stall, and server actions cannot be aborted — one more server-only route for `scripts/build-desktop.mjs` to stash.
11. **Complaint, diagnosis, history, and test suggestions come from the global term table seeded from the four small CSVs; free text is always accepted; no clinic-learned terms yet** — fastest path to the legacy form's suggestion UX — add a `tenant_terms` table later.
12. **Catalogue search is ILIKE with escaped wildcards and no trigram index** — ~2,300 global rows; a sequential scan is sub-millisecond — add a `pg_trgm` GIN index when a tenant passes ~20k rows.
13. **"Rich fields" means plain multiline text and chip lists, never HTML or a rich-text editor; all text is cleaned (NFC, CR/CRLF to LF, stray control characters removed) and rendered with React escaping only. A NUL is the exception: validation refuses it (`invalid`, Plan 1A's rule), it is never silently stripped from stored text** — hostile input and the Plan 1C renderer stay simple; a NUL in clinical text means a broken paste the doctor should see — a markdown subset could be added later.
14. **Repeat copies the prescribing content (items, chief complaint, complaints, diagnosis, history, drug history, investigations, advice) but not the old visit's measurements (vitals, examination notes, follow-up); amend copies everything.** Plan 1A's rule stays: only a `finalized` source can be repeated (a draft or a superseded `amended` version is refused with `conflict`, ADR-0026) — vitals and findings belong to the day they were measured; an amendment corrects the same visit — trivial to change in `repeatVisitValues`.
15. **Editor server actions never `redirect()`**; an expired session returns `unauthenticated`, which the autosaver treats as retryable — a redirect would navigate away from unsaved edits — none.
16. **Blank phrase entries are dropped, not rejected** (complaints, diagnosis, history, drug history); a medicine or test row that has content but no name is still rejected with a field error — an empty chip carries nothing, while a half-filled row must not vanish silently (Plan 1A's `z.string().trim().min(1)` made one blank diagnosis chip reject the whole save) — none.
17. **The editor stays disabled until it is live** (a `fieldset` that is `disabled` until the autosaver exists), and a `beforeunload` guard warns while anything is unsaved — text typed into server-rendered inputs before hydration is lost when React hydrates, and the same race made Plan 1A's e2e typing flaky; Playwright waits for enabled fields on its own — a sub-second disabled flash on page load.
18. **The three unkeyed tenant references get composite foreign keys, and a user has at most one doctor profile per clinic** (migration 0010, the first migration of this plan): `UNIQUE (tenant_id, id)` and `UNIQUE (tenant_id, user_id)` on `doctors`, `UNIQUE (tenant_id, id)` on `template_versions`, and `visits.doctor_id -> doctors`, `visits.branch_id -> branches`, `prescriptions.template_version_id -> template_versions`, each `ON DELETE SET NULL (col)` written by hand. Because the immutability triggers reject the `SET NULL` update on a signed row, a doctor, branch, or template version that a finalized record references cannot be deleted (`23000`); deactivate it instead. Tenant offboarding still works: the tenant-level cascades delete the visits and prescriptions before the nested `SET NULL` actions run (pinned by a test) — invariant 1 says the database enforces tenancy, and `doctorIdFor` becomes deterministic — if offboarding ever trips the trigger, the fix is a `tenant_is_erased` exemption for `UPDATE` in the triggers (needs a ruling).
19. **A draft can be discarded and an open amendment withdrawn** (`discardDraft`, owner/doctor): the draft prescription, its items, and its draft visit are deleted after the prescription row is locked; a finalized or amended version is never deleted (`immutable`); the event `prescription.draft_discarded` keeps ids and counts only. **`repeatPrescription` refuses a source with an open amendment draft** (`conflict`: "A correction of this prescription is in progress; finish or withdraw it first.") — abandoned drafts and stuck amendments otherwise clutter the patient's list forever and block new amendments; with withdrawal available, the repeat refusal cannot dead-end the doctor — a discarded draft is gone (drafts are not records, ADR-0029); if clinics want an undo, switch to a `discarded` status.

## Global Constraints

Copied from Plan 1A (still binding):

- Node.js 22+; npm only (commit `package-lock.json`).
- TypeScript strict; no `any`; no `@ts-ignore`.
- Every business table has `tenant_id UUID NOT NULL`; RLS is enabled **and forced** on all of them (new tables included).
- `tenant_id`, `user_id`, and `role` come from the session (`requireSession()` / `getSessionContext()`), never from request input or form fields.
- Feature code reaches tenant data only through `withTenant()`. `adminDb` is for auth, sign-up, seed, and tests.
- Finalized prescriptions are never overwritten: amendments create a new version with a reason (AGENTS.md invariant 3).
- Creating, amending, finalizing, and archiving write an append-only audit event (invariant 2). Audit payloads carry ids, counts, and field **names**, not free-text patient data.
- Dates: store UTC; calendar dates (`dob`, `follow_up_date`) are `YYYY-MM-DD` strings.
- IDs are UUIDv7 (`newId()` / schema `$defaultFn`); human-facing numbers (`patient_no`, `rx_no`) are per-tenant sequences.
- Every service returns `Result<T>` (`{ ok: true, value } | { ok: false, code, message, field? }`); no thrown strings.
- Use existing shadcn/ui primitives (`src/components/ui/*`) and native form elements; do not add a UI kit or new npm dependencies.
- Conventional commits; one logical change per commit. Stage **explicit file paths** (never `git add .` or a whole directory). PowerShell cannot pipe a message into `git commit -F -`, so commit with one `-m` per paragraph: `git commit -m "<subject>" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"`, where `<model>` is the model that actually wrote the commit (for example `Sonnet 5.5`, `Opus 5.5`, `Haiku 4.5`).
- **Windows, PowerShell only.** Every command block below is one PowerShell call that starts with `Set-Location E:\projects\clinicpad;` (UPPERCASE drive letter; a lowercase `e:` cwd makes every vitest file fail with `Cannot read properties of undefined (reading 'config')`). If you split a block into several calls, start each call with `Set-Location E:\projects\clinicpad;`. PowerShell 5.1 has no `&&`; chain with `; if ($?) { ... }`.
- Postgres runs in Docker (`docker compose up -d postgres`, container `clinicpad-postgres`). Docker Desktop on this machine lives at `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`, not under Program Files; start it from there if `docker` cannot connect.
- Before every commit run `npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }` and show the output.
- Write invisible or non-printing characters in source and tests as `\uXXXX` escapes (NUL `\u0000`, BOM `\ufeff`, combining marks such as the nukta `\u093c`), never as raw characters, and prove each one with a code-point assertion (`expect([...s]).toHaveLength(n)` or `codePointAt`). Editors and the Write tool have re-encoded raw invisible characters before.
- Playwright: `getByRole("alert")` also matches Next's route announcer; locate alerts by their text. Before typing into a server-rendered form, wait until its field is editable (`await expect(field).toBeEditable()`); Playwright's `fill` also waits for an enabled field.
- Reviewers skip the generated `drizzle/meta/*_snapshot.json` files (large and machine-written); never hand-edit them.

New in Plan 1B:

- The only tables without `tenant_id` are the global reference tables `global_medicines` and `global_clinical_terms`. `clinicpad_app` has SELECT only on them (INSERT/UPDATE/DELETE/TRUNCATE revoked); they are written only by `seedCatalogue()` on the admin connection.
- **Composite foreign keys (ADR-0025).** Every new foreign key into a tenant-owned table is `(tenant_id, x_id) -> parent(tenant_id, id)` with explicit names under 63 characters, and the parent gets a short explicitly named `UNIQUE (tenant_id, id)` first. A nullable reference uses `ON DELETE SET NULL (col)` (hand-written: drizzle-kit emits a plain `SET NULL`, which would null `tenant_id`). drizzle-kit emits `ADD FOREIGN KEY` before the `UNIQUE` it needs: reorder by hand and record every hand edit in a header comment, as `drizzle/0007` and `drizzle/0009` do. `tests/integration/tenant-fk.test.ts` must stay green with an empty allowlist.
- **Migrations:** Plan 1A ends at `0009`; this plan adds `0010_clinical_references` (generated, hand-edited), `0011_phase1b_clinical` (generated), and `0012_phase1b_catalogue_security` (custom, `--custom`, whose snapshot is a copy of the previous one, like `0008`). Commit each `.sql` together with its `drizzle/meta/NNNN_snapshot.json` and the `drizzle/meta/_journal.json` entry. Migrations never run data backfill `UPDATE`s on `visits`, `prescriptions`, or `prescription_items` (the immutability triggers reject them on finalized rows). New columns are nullable or have a constant default.
- **Immutability.** New clinical content lives in columns of `visits`/`prescriptions`/`prescription_items`, which the existing triggers already freeze. Do not add a child table holding clinical content of a prescription or visit without its own ADR-0023-style trigger (parent lookups `FOR SHARE`, fail closed with `23503`, tenant equality, deletes of non-draft rows only when `tenant_is_erased`). Every writer locks the prescription row `FOR UPDATE` before touching its items or visit, and `amendPrescription` keeps its open-amendment check before any write.
- Clinical content (every visit field, every item field) may be changed only by roles for which `can(role, "rx.draft")` is true (owner, doctor). Reception, nurse, pharmacist, and accountant never edit it. Catalogue search requires `catalogue.read`; adding clinic medicines requires `catalogue.write`; finalizing requires `rx.finalize`.
- All user text passes through `cleanInput()` (`src/server/validation/text.ts`) before validation: `cleanText()` normalizes NFC, turns CR/CRLF into LF, and removes C0 control characters except tab and newline, plus DEL — but a string that contains a NUL is passed through unchanged so `hasNoNul` refuses it with `invalid` (Plan 1A's rule: a NUL is reported, never silently removed). Text is stored as plain text and rendered through React's escaping only; never use `dangerouslySetInnerHTML`.
- Limits (in `RX_LIMITS`): 30 medicines, 30 entries per phrase list, 20 diagnoses, 30 investigations, 200 favourites per doctor, search terms capped at 60 characters. Text lengths: chief complaint 500, advice and examination notes 2,000, phrase 200, test name 120, test instructions 300, remarks 300, medicine name 200, generic name 300.
- The UI never shows "saved" unless the server confirmed that exact snapshot; at most one autosave is in flight per editor; a stale `baseRevision` returns `conflict`, never a silent overwrite.
- Client components fetch data through GET route handlers; server actions are for mutations only. Editor server actions return typed results and never call `redirect()`.
- Keep components under ~250 lines; domain logic lives in `src/lib/` or `src/server/`, not in components.

## Review Focus

Failure modes most likely to hurt a real clinic that happy-path tests would miss. Each is pinned to a test in the owning task.

1. **Two windows, two devices, or a slow save overlapping a newer edit.** The newer content must win or the user must be told; older content must never land on top of newer content, and two saves must never interleave items. → Task 3 (stale revision and simultaneous-save tests), Task 8 (autosaver ordering tests), Task 10 (two-tab e2e).
2. **The connection drops mid-edit.** Edits stay on the page, the status says "not saved", saving resumes by itself, and nothing is shown as saved until the server confirms it. → Task 8 (retry/backoff tests), Task 10 (offline e2e).
3. **Hostile or odd text:** NUL bytes and control characters, `<script>`/`<img onerror>` text, 10,000-character pastes, Devanagari, emoji in a search box. Stored verbatim (minus stray control characters), or rejected with a field error (NUL, over-long); never a 500, never executed. → Task 1 (`cleanText`, `searchTerm`), Task 3 (round-trip, NUL refusal, limits), Task 6 (search input), Task 10 (e2e renders literal text with no dialog).
4. **Catalogue search and favourites leaking or wildcarding:** `%` and `_` must match literally; one clinic's medicines and one doctor's favourites must be invisible to another clinic or doctor; the app role must not be able to modify the shared catalogue. → Task 2 (privileges, RLS, composite keys), Task 6 (search and favourites isolation).
5. **Finalizing content the doctor never saw** (an autosave or another window changed the draft between save and finalize), and **amend/repeat silently dropping the new clinical fields.** → Task 4 (`expectedRevision`, full-copy tests), Task 7 (`finalizeDraftAction` test).
6. **A cross-clinic or dangling reference sneaking into a signed record, or offboarding breaking because of the new keys:** a visit pointing at another clinic's doctor or branch, a prescription at another clinic's template version, a second doctor profile for one user; deleting a doctor or branch must not rewrite a signed visit; deleting a whole tenant must still work. → Task 2 (`clinical-references.test.ts`).
7. **Losing a signed record or a correction through discard:** discarding must never delete a finalized or amended version, must not race a finalize into a half-deleted state, and withdrawing an amendment must free the slot without touching the original; repeat must not copy a prescription whose correction is still open. → Task 11.

---

## File Structure

**Create**
- `src/lib/domain/text.ts` — `cleanText`.
- `src/lib/domain/search.ts` — `escapeLike`, `catalogueKey`, `searchTerm`, `clampLimit`.
- `src/lib/domain/rx-options.ts` — codes, labels, limits, `Vitals`, `Investigation` types.
- `src/lib/domain/rx-format.ts` — `formatSchedule`, `parseSchedule`, `durationToDays`, `formatDuration`, `bmi`, `formatBp`, `vitalsLine`.
- `src/lib/csv.ts` — `parseCsv`, `csvRecords`.
- `src/lib/rx/editor-state.ts` — editor state model, payload conversion, row helpers.
- `src/lib/rx/autosave.ts` — the autosaver (pure, timer-driven) and `outcomeFromResponse`.
- `src/server/db/schema/catalogue.ts` — `globalMedicines`, `globalClinicalTerms`, `tenantMedicines`, `medicineFavourites`.
- `src/server/db/catalogue-seed.ts` — `seedCatalogue()` + CLI entry.
- `src/server/services/rx-mapping.ts` — row ↔ view mapping, copy helpers, audit summary.
- `src/server/services/catalogue.ts` — search, clinic medicines, favourites, term suggestions.
- `src/server/validation/catalogue.ts` — clinic medicine schema.
- `src/server/actions/drafts.ts` — `autosaveDraftAction`, `finalizeDraftAction`.
- `src/server/actions/catalogue.ts` — `saveFavouriteAction`, `removeFavouriteAction`, `addClinicMedicineAction`.
- `src/app/api/catalogue/search/route.ts` — GET typeahead.
- `src/components/rx/use-catalogue-search.ts`, `medicine-combobox.tsx`, `schedule-input.tsx`, `term-list-input.tsx`, `medicine-row.tsx` — editor building blocks.
- `src/components/rx/use-autosave.ts`, `autosave-status.tsx`, `vitals-section.tsx`, `clinical-notes-section.tsx`, `investigations-section.tsx`, `medicines-section.tsx`, `advice-section.tsx`, `clinical-editor.tsx`, `prescription-view.tsx` — the editor and read-only view.
- `src/components/rx/discard-draft-form.tsx` — "Discard draft" / "Withdraw amendment" with an inline confirm step.
- `drizzle/0010_clinical_references.sql` (generated, then hand-edited), `drizzle/0011_phase1b_clinical.sql` (generated), `drizzle/0012_phase1b_catalogue_security.sql` (custom), each with its `drizzle/meta/NNNN_snapshot.json`; `drizzle/meta/_journal.json` gains three entries.
- Tests: `tests/unit/{text,search,csv,rx-format,editor-state,autosave}.test.ts`, `tests/unit/{schedule-input,medicine-combobox,term-list-input,medicine-row,autosave-status}.test.tsx`, `tests/integration/{clinical-references,clinical-schema,prescriptions-clinical,prescriptions-clinical-lifecycle,catalogue-seed,catalogue,editor-endpoints,prescriptions-discard}.test.ts`, `tests/e2e/clinical-form.spec.ts`.

**Modify**
- `src/lib/domain/permissions.ts` — `catalogue.read`, `catalogue.write`; `tests/unit/permissions.test.ts` — their rows in the role x action matrix.
- `src/server/db/schema/tenancy.ts` — `doctors` unique keys.
- `src/server/db/schema/clinical.ts` — composite keys for `visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id`, the `template_versions` unique key, and the new visit, item, and prescription columns.
- `src/server/db/schema/index.ts` — export `./catalogue`.
- `src/server/validation/text.ts` — `cleanInput`, `cleanOptionalText`, `cleanRequiredText` (built on the existing `hasNoNul`/`blankToUndefined`).
- `src/server/validation/prescription.ts` — the full clinical schema (replaces the draft and item schemas; keeps `amendReasonSchema` and the follow-up date bounds).
- `src/server/services/prescriptions.ts` — revisions, views, finalize/amend/repeat, `discardDraft`.
- `src/server/auth/session.ts` — `getSessionContext()`.
- `src/server/actions/prescriptions.ts` — remove the Plan 1A form-save action (`saveDraftAction`, `DraftFormState`); add `discardDraftAction`.
- `src/server/db/seed.ts` — also seed the catalogue when run as a script.
- `src/app/(app)/prescriptions/[id]/page.tsx` — use the new editor and read-only view; Discard button.
- `scripts/build-desktop.mjs` — stash `src/app/api/catalogue`.
- `package.json` — `db:seed:catalogue` script.
- `tests/e2e/helpers.ts` (append `ensureCatalogue`; `setRole` already exists), `tests/e2e/prescriptions.spec.ts` — the new editor's labels, autosave, discard.
- `docs/SETUP.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md`, `AGENTS.md`.

**Delete**
- `src/components/rx/draft-editor.tsx` (Plan 1A's plain editor, replaced by `clinical-editor.tsx`) and `src/components/rx/read-only-view.tsx` (replaced by `prescription-view.tsx`). `amend-form.tsx`, `repeat-form.tsx`, `submit-button.tsx`, `redirect-error.tsx`, and `src/components/patients/allergy-banner.tsx` stay as they are.

---

## Task 1: Clinical domain primitives (pure, TDD)

**Files:**
- Create: `src/lib/domain/text.ts`, `src/lib/domain/search.ts`, `src/lib/domain/rx-options.ts`, `src/lib/domain/rx-format.ts`, `src/lib/csv.ts`
- Modify: `src/lib/domain/permissions.ts`, `tests/unit/permissions.test.ts`
- Test: `tests/unit/text.test.ts`, `tests/unit/search.test.ts`, `tests/unit/csv.test.ts`, `tests/unit/rx-format.test.ts`, `tests/unit/permissions.test.ts`

**Interfaces:**
- Consumes: Plan 1A `can(role, action)`, `type Action = keyof typeof MATRIX` in `src/lib/domain/permissions.ts`, and the role x action matrix test in `tests/unit/permissions.test.ts` (its `granted: Record<Action, readonly string[]>` must list every action, or `npm run typecheck` fails).
- Produces:
  - `cleanText(value: string): string`.
  - `escapeLike(value: string): string`; `catalogueKey(name: string): string`; `searchTerm(raw: unknown, max?: number): string`; `clampLimit(raw: unknown, fallback: number, max: number): number`.
  - Constants and types: `FOOD_RELATIONS`, `FoodRelation`, `FOOD_RELATION_LABELS`, `PERIODICITIES`, `Periodicity`, `PERIODICITY_LABELS`, `DURATION_UNITS`, `DurationUnit`, `DURATION_UNIT_DAYS`, `SCHEDULE_PRESETS`, `TERM_KINDS`, `TermKind`, `RX_LIMITS`, `type Vitals`, `type Investigation`.
  - `type Schedule = { morning: number | null; afternoon: number | null; evening: number | null; night: number | null }`; `formatSchedule(s: Schedule): string`; `parseSchedule(pattern: string): Schedule | null`; `durationToDays(value: number, unit: DurationUnit): number`; `formatDuration(value: number | null, unit: string | null): string`; `bmi(weightKg?: number | null, heightCm?: number | null): number | null`; `formatBp(systolic?: number | null, diastolic?: number | null): string`; `vitalsLine(v: Vitals): string`.
  - `parseCsv(text: string): string[][]`; `csvRecords(text: string): Record<string, string>[]`.
  - New permission actions `"catalogue.read"` (owner, doctor, nurse, pharmacist) and `"catalogue.write"` (owner, doctor).

- [ ] **Step 1: Write the failing tests**

`tests/unit/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cleanText } from "@/lib/domain/text";

describe("cleanText", () => {
  it("removes NUL and other control characters but keeps tabs and newlines", () => {
    expect(cleanText("a\u0000b\u0007c\u001bd\u007fe")).toBe("abcde");
    expect(cleanText("col1\tcol2\nnext")).toBe("col1\tcol2\nnext");
  });

  it("turns Windows and old Mac line endings into LF", () => {
    expect(cleanText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("normalizes to NFC so the same Devanagari text compares equal", () => {
    // U+0958 (precomposed QA) and U+0915 U+093C (KA + nukta) render identically; written as escapes on purpose.
    const precomposed = "\u0958";
    const decomposed = "\u0915\u093c";
    expect([...precomposed]).toHaveLength(1);
    expect([...decomposed]).toHaveLength(2);
    expect(cleanText(precomposed)).toBe(cleanText(decomposed));
    expect(cleanText("आशा राव")).toBe("आशा राव");
  });

  it("leaves HTML-looking text alone (it is stored as plain text)", () => {
    expect(cleanText('<img src=x onerror="alert(1)">')).toBe('<img src=x onerror="alert(1)">');
  });

  it("does not trim", () => {
    expect(cleanText("  padded  ")).toBe("  padded  ");
  });
});
```

`tests/unit/search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { catalogueKey, clampLimit, escapeLike, searchTerm } from "@/lib/domain/search";

describe("escapeLike", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("catalogueKey", () => {
  it("ignores case and spacing but keeps punctuation", () => {
    expect(catalogueKey("  DOLO   650MG ")).toBe("dolo 650mg");
    expect(catalogueKey("CTD T 12.5/20")).not.toBe(catalogueKey("CTD T 125/20"));
  });

  it("treats canonically equivalent Devanagari as the same name", () => {
    expect([..."\u0915\u093c"]).toHaveLength(2);
    expect(catalogueKey("\u0958")).toBe(catalogueKey("\u0915\u093c"));
  });
});

describe("searchTerm", () => {
  it("trims and collapses whitespace", () => {
    expect(searchTerm("  dolo   650 ")).toBe("dolo 650");
  });

  it("returns an empty string for non-strings and blanks", () => {
    expect(searchTerm(undefined)).toBe("");
    expect(searchTerm(42)).toBe("");
    expect(searchTerm("   ")).toBe("");
  });

  it("caps the length in characters without splitting emoji", () => {
    expect(searchTerm("x".repeat(500))).toHaveLength(60);
    const emoji = searchTerm("😀".repeat(100));
    expect(Array.from(emoji)).toHaveLength(60);
    expect(emoji).toBe("😀".repeat(60));
  });

  it("drops control characters such as NUL", () => {
    expect(searchTerm("do\u0000lo")).toBe("dolo");
  });
});

describe("clampLimit", () => {
  it.each([
    [undefined, 20],
    ["abc", 20],
    [Number.NaN, 20],
    [7, 7],
    ["7", 7],
    [7.9, 7],
    [0, 1],
    [-5, 1],
    [100000, 50],
  ])("clamps %j to %i", (raw, expected) => {
    expect(clampLimit(raw, 20, 50)).toBe(expected);
  });
});
```

`tests/unit/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { csvRecords, parseCsv } from "@/lib/csv";

describe("parseCsv", () => {
  it("splits rows and fields with CRLF or LF endings", () => {
    expect(parseCsv("a,b\r\nc,d\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("handles quoted fields with commas, escaped quotes, and newlines", () => {
    expect(parseCsv('name,salt\nANTICRAMP,"Mg 200mg, L-Carnitine"\nQ,"say ""hi"""\nN,"two\nlines"')).toEqual([
      ["name", "salt"],
      ["ANTICRAMP", "Mg 200mg, L-Carnitine"],
      ["Q", 'say "hi"'],
      ["N", "two\nlines"],
    ]);
  });

  it("skips blank lines, a trailing newline, and a UTF-8 BOM", () => {
    const bom = "\ufeff";
    expect(bom.codePointAt(0)).toBe(0xfeff);
    expect(parseCsv(`${bom}name\r\n\r\nFEVER\r\n\r\n`)).toEqual([["name"], ["FEVER"]]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("a,,c\nd,\n")).toEqual([
      ["a", "", "c"],
      ["d", ""],
    ]);
  });

  it("does not throw on an unterminated quote", () => {
    expect(parseCsv('a,"unterminated')).toEqual([["a", "unterminated"]]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("csvRecords", () => {
  it("maps rows to lower-case header keys and trims values", () => {
    expect(csvRecords("name,icdCode\r\n TYPHOID , A01 \r\nMALARIA\r\n")).toEqual([
      { name: "TYPHOID", icdcode: "A01" },
      { name: "MALARIA", icdcode: "" },
    ]);
  });

  it("drops columns beyond the header", () => {
    expect(csvRecords("name\nX,extra")).toEqual([{ name: "X" }]);
  });

  it("returns nothing for an empty file", () => {
    expect(csvRecords("")).toEqual([]);
  });
});
```

`tests/unit/rx-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  bmi,
  durationToDays,
  formatBp,
  formatDuration,
  formatSchedule,
  parseSchedule,
  vitalsLine,
  type Schedule,
} from "@/lib/domain/rx-format";
import { SCHEDULE_PRESETS } from "@/lib/domain/rx-options";

const s = (morning: number | null, afternoon: number | null, evening: number | null, night: number | null): Schedule => ({
  morning,
  afternoon,
  evening,
  night,
});

describe("formatSchedule", () => {
  it.each([
    [s(1, 0, null, 1), "1-0-1"],
    [s(1, 1, 1, 1), "1-1-1-1"],
    [s(0.5, 0, null, 0.5), "½-0-½"],
    [s(1.5, null, null, null), "1½-0-0"],
    [s(0.25, 0.75, 0, 0), "¼-¾-0"],
    [s(12, 0, null, 10), "12-0-10"],
    [s(1, 0, 0, 1), "1-0-1"],
    [s(0.3, 0, null, 0), "0.3-0-0"],
  ])("formats %j as %s", (schedule, expected) => {
    expect(formatSchedule(schedule)).toBe(expected);
  });

  it("is empty when no slot has a dose", () => {
    expect(formatSchedule(s(null, null, null, null))).toBe("");
    expect(formatSchedule(s(0, 0, 0, 0))).toBe("");
  });
});

describe("parseSchedule", () => {
  it.each([
    ["1-0-1", s(1, 0, null, 1)],
    ["1-0-0-1", s(1, 0, 0, 1)],
    ["½-0-½", s(0.5, 0, null, 0.5)],
    ["1/2-0-1/2", s(0.5, 0, null, 0.5)],
    ["1½-0-1", s(1.5, 0, null, 1)],
    [" 1 - 0 - 1 ", s(1, 0, null, 1)],
    ["0.5-0-0.5", s(0.5, 0, null, 0.5)],
  ])("parses %j", (pattern, expected) => {
    expect(parseSchedule(pattern)).toEqual(expected);
  });

  it.each(["", "TDS", "1-0", "1--1", "1-0-1-1-1", "1-0-100", "1-0-1/0", "a-b-c"])("rejects %j", (pattern) => {
    expect(parseSchedule(pattern)).toBeNull();
  });

  it("round-trips every preset", () => {
    for (const preset of SCHEDULE_PRESETS) {
      const parsed = parseSchedule(preset);
      expect(parsed).not.toBeNull();
      expect(formatSchedule(parsed as Schedule)).toBe(preset);
    }
  });
});

describe("durations", () => {
  it("converts to days with 7-day weeks and 30-day months", () => {
    expect(durationToDays(5, "days")).toBe(5);
    expect(durationToDays(2, "weeks")).toBe(14);
    expect(durationToDays(3, "months")).toBe(90);
  });

  it.each([
    [1, "days", "1 day"],
    [5, "days", "5 days"],
    [1, "weeks", "1 week"],
    [2, "weeks", "2 weeks"],
    [3, "months", "3 months"],
    [3, null, "3 days"],
    [3, "fortnights", "3 days"],
  ])("formats %i %s as %s", (value, unit, expected) => {
    expect(formatDuration(value, unit)).toBe(expected);
  });

  it("is empty without a value", () => {
    expect(formatDuration(null, "days")).toBe("");
  });
});

describe("vitals helpers", () => {
  it("computes BMI to one decimal and refuses missing or zero inputs", () => {
    expect(bmi(70, 175)).toBe(22.9);
    expect(bmi(null, 170)).toBeNull();
    expect(bmi(70, 0)).toBeNull();
    expect(bmi(undefined, undefined)).toBeNull();
  });

  it("formats BP only when both numbers exist", () => {
    expect(formatBp(120, 80)).toBe("120/80");
    expect(formatBp(120, undefined)).toBe("");
  });

  it("builds a one-line summary in a fixed order", () => {
    expect(vitalsLine({ bpSystolic: 130, bpDiastolic: 85, pulse: 92, weightKg: 70, heightCm: 175 })).toBe(
      "BP 130/85 mmHg · Pulse 92/min · Weight 70 kg · Height 175 cm · BMI 22.9",
    );
    expect(vitalsLine({ notes: "after a walk", spo2: 97, temperatureF: 100.4 })).toBe(
      "Temp 100.4 °F · SpO₂ 97% · after a walk",
    );
    expect(vitalsLine({})).toBe("");
  });
});
```

`tests/unit/permissions.test.ts` (Plan 1A's file): in the `role x action matrix` block, add these two rows to the `granted` object directly after the `"rx.amend"` row, so every role x action cell of the new actions is pinned (12 new cases):

```ts
    "catalogue.read": ["owner", "doctor", "nurse", "pharmacist"],
    "catalogue.write": ["owner", "doctor"],
```

and add this case at the end of the first `describe("can", ...)` block:

```ts
  it("lets nurses and pharmacists search the catalogue, but only owners and doctors add to it", () => {
    expect(can("nurse", "catalogue.read")).toBe(true);
    expect(can("pharmacist", "catalogue.read")).toBe(true);
    expect(can("reception", "catalogue.read")).toBe(false);
    expect(can("accountant", "catalogue.read")).toBe(false);
    expect(can("nurse", "catalogue.write")).toBe(false);
    expect(can("mystery", "catalogue.read")).toBe(false);
    expect(can(undefined, "catalogue.write")).toBe(false);
  });
```

(Until Step 3 adds the actions to `MATRIX`, `"catalogue.read"` is not an `Action`, so `npm run typecheck` also fails on these lines; that is expected.)

- [ ] **Step 2: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/text.test.ts tests/unit/search.test.ts tests/unit/csv.test.ts tests/unit/rx-format.test.ts tests/unit/permissions.test.ts
```

Expected: FAIL — the new modules cannot be resolved, and the new `permissions.test.ts` cells for `owner`/`doctor`/`nurse`/`pharmacist` fail because `can(..., "catalogue.read")` returns `false` for an unknown action.

- [ ] **Step 3: Implement**

`src/lib/domain/text.ts`:

```ts
function isControl(code: number): boolean {
  // C0 controls except tab (0x09) and line feed (0x0a), plus DEL. Postgres rejects NUL in text.
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;
}

/**
 * Normalizes user-entered text: Unicode NFC (so Devanagari typed on different keyboards
 * compares equal), CR and CRLF to LF, control characters removed. It does not trim and
 * does not touch HTML: text is stored as plain text and escaped when rendered.
 *
 * It removes NUL too, which keeps search terms and catalogue keys safe. Stored clinical
 * text does not rely on that: the validation layer (`cleanInput` in
 * src/server/validation/text.ts) leaves a NUL-containing string unchanged so that
 * `hasNoNul` refuses it, because a NUL is reported, never silently dropped (Plan 1A rule).
 */
export function cleanText(value: string): string {
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n");
  let out = "";
  for (let i = 0; i < normalized.length; i += 1) {
    if (!isControl(normalized.charCodeAt(i))) out += normalized[i];
  }
  return out;
}
```

`src/lib/domain/search.ts`:

```ts
import { cleanText } from "./text";

/** Escapes LIKE wildcards so user input matches literally (Postgres' default escape is "\"). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Key used to de-duplicate catalogue names: case and spacing are ignored, punctuation is
 * kept ("CTD T 12.5/20" and "CTD T 125/20" are different medicines).
 */
export function catalogueKey(name: string): string {
  return cleanText(name).toLowerCase().replace(/\s+/g, " ").trim();
}

/** A search term from untrusted input: cleaned, whitespace collapsed, at most `max` characters. */
export function searchTerm(raw: unknown, max = 60): string {
  if (typeof raw !== "string") return "";
  const collapsed = cleanText(raw).replace(/\s+/g, " ").trim();
  // Array.from splits by code point, so an emoji is never cut in half.
  return Array.from(collapsed).slice(0, max).join("").trim();
}

/** Page size from untrusted input: a whole number between 1 and `max`; `fallback` when unreadable. */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}
```

`src/lib/domain/rx-options.ts`:

```ts
/**
 * Codes and limits shared by validation, services, and the editor UI. Codes are what the
 * database stores; English labels live here. Hindi labels arrive with Plan 1D, keyed by the
 * same codes (they match the legacy keys in src/lib/translations.ts).
 */
export const FOOD_RELATIONS = [
  "before",
  "after",
  "with",
  "without",
  "with_tea",
  "just_for_now",
  "according_to_pain",
] as const;
export type FoodRelation = (typeof FOOD_RELATIONS)[number];

export const FOOD_RELATION_LABELS: Record<FoodRelation, string> = {
  before: "Before food",
  after: "After food",
  with: "With food",
  without: "Empty stomach",
  with_tea: "With tea or snacks",
  just_for_now: "Just for now",
  according_to_pain: "According to pain",
};

export const PERIODICITIES = [
  "daily",
  "alternate_day",
  "twice_weekly",
  "weekly",
  "every_5th_day",
  "fortnightly",
  "monthly",
  "as_needed",
] as const;
export type Periodicity = (typeof PERIODICITIES)[number];

export const PERIODICITY_LABELS: Record<Periodicity, string> = {
  daily: "Daily",
  alternate_day: "Alternate days",
  twice_weekly: "Twice a week",
  weekly: "Weekly",
  every_5th_day: "Every 5th day",
  fortnightly: "Fortnightly",
  monthly: "Monthly",
  as_needed: "As needed",
};

export const DURATION_UNITS = ["days", "weeks", "months"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/** Days per unit for the derived `duration_days` column. A month counts as 30 days. */
export const DURATION_UNIT_DAYS: Record<DurationUnit, number> = { days: 1, weeks: 7, months: 30 };

/** One-click schedules: morning-afternoon-night, or morning-afternoon-evening-night. */
export const SCHEDULE_PRESETS = ["1-0-1", "1-0-0", "0-0-1", "1-1-1", "1-1-1-1", "0-1-0", "½-0-½"] as const;

export const TERM_KINDS = ["complaint", "diagnosis", "history", "test"] as const;
export type TermKind = (typeof TERM_KINDS)[number];

export const RX_LIMITS = {
  medicines: 30,
  phrases: 30,
  diagnoses: 20,
  investigations: 30,
  favouritesPerDoctor: 200,
  searchQuery: 60,
} as const;

/** One set of vitals per visit, stored as jsonb in `visits.vitals`. An absent key was not measured. */
export type Vitals = {
  bpSystolic?: number;
  bpDiastolic?: number;
  pulse?: number;
  temperatureF?: number;
  spo2?: number;
  respiratoryRate?: number;
  weightKg?: number;
  heightCm?: number;
  bloodSugarMgDl?: number;
  notes?: string;
};

/** An ordered test, stored in the jsonb array `visits.investigations`. */
export type Investigation = { name: string; instructions?: string };
```

`src/lib/domain/rx-format.ts`:

```ts
import { DURATION_UNIT_DAYS, type DurationUnit, type Vitals } from "./rx-options";

export type Schedule = {
  morning: number | null;
  afternoon: number | null;
  evening: number | null;
  night: number | null;
};

const GLYPHS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75 };

function formatQty(q: number | null): string {
  if (q === null || q === 0) return "0";
  const whole = Math.trunc(q);
  const frac = Math.round((q - whole) * 100) / 100;
  if (frac === 0) return String(whole);
  const glyph = frac === 0.25 ? "¼" : frac === 0.5 ? "½" : frac === 0.75 ? "¾" : null;
  if (glyph === null) return String(q);
  return whole === 0 ? glyph : `${whole}${glyph}`;
}

/**
 * Indian pad convention: "1-0-1" is morning-afternoon-night. When an evening dose exists,
 * the four-slot form "1-0-1-1" (morning-afternoon-evening-night) is used. Empty when no dose.
 */
export function formatSchedule(s: Schedule): string {
  const slots = [s.morning, s.afternoon, s.evening, s.night];
  if (slots.every((q) => q === null || q === 0)) return "";
  const hasEvening = s.evening !== null && s.evening !== 0;
  const parts = hasEvening ? slots : [s.morning, s.afternoon, s.night];
  return parts.map(formatQty).join("-");
}

function parseQty(token: string): number | null {
  const t = token.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const glyph = /^(\d*)([¼½¾])$/.exec(t);
  if (glyph) return Number(glyph[1] || "0") + GLYPHS[glyph[2]];
  const slash = /^(\d+)\/(\d+)$/.exec(t);
  if (slash && Number(slash[2]) !== 0) return Number(slash[1]) / Number(slash[2]);
  return null;
}

/** Reads "1-0-1" (M-A-N) or "1-0-1-1" (M-A-E-N). Null for anything else ("TDS", "as directed"). */
export function parseSchedule(pattern: string): Schedule | null {
  const parts = pattern.trim().split("-");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const qty: number[] = [];
  for (const part of parts) {
    const q = parseQty(part);
    if (q === null || q > 99) return null;
    qty.push(q);
  }
  return parts.length === 3
    ? { morning: qty[0], afternoon: qty[1], evening: null, night: qty[2] }
    : { morning: qty[0], afternoon: qty[1], evening: qty[2], night: qty[3] };
}

export function durationToDays(value: number, unit: DurationUnit): number {
  return value * DURATION_UNIT_DAYS[unit];
}

const UNIT_WORDS: Record<DurationUnit, [string, string]> = {
  days: ["day", "days"],
  weeks: ["week", "weeks"],
  months: ["month", "months"],
};

/** "5 days", "1 week", "3 months". Unknown or missing units read as days. Empty without a value. */
export function formatDuration(value: number | null, unit: string | null): string {
  if (value === null) return "";
  const words = unit !== null && Object.hasOwn(UNIT_WORDS, unit) ? UNIT_WORDS[unit as DurationUnit] : UNIT_WORDS.days;
  return `${value} ${value === 1 ? words[0] : words[1]}`;
}

export function bmi(weightKg?: number | null, heightCm?: number | null): number | null {
  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) return null;
  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 10) / 10;
}

export function formatBp(systolic?: number | null, diastolic?: number | null): string {
  return systolic && diastolic ? `${systolic}/${diastolic}` : "";
}

/** One-line vitals summary for read-only views and (Plan 1C) templates. */
export function vitalsLine(v: Vitals): string {
  const bp = formatBp(v.bpSystolic, v.bpDiastolic);
  const index = bmi(v.weightKg, v.heightCm);
  const parts = [
    bp ? `BP ${bp} mmHg` : "",
    v.pulse !== undefined ? `Pulse ${v.pulse}/min` : "",
    v.temperatureF !== undefined ? `Temp ${v.temperatureF} °F` : "",
    v.spo2 !== undefined ? `SpO₂ ${v.spo2}%` : "",
    v.respiratoryRate !== undefined ? `RR ${v.respiratoryRate}/min` : "",
    v.weightKg !== undefined ? `Weight ${v.weightKg} kg` : "",
    v.heightCm !== undefined ? `Height ${v.heightCm} cm` : "",
    index !== null ? `BMI ${index}` : "",
    v.bloodSugarMgDl !== undefined ? `Sugar ${v.bloodSugarMgDl} mg/dL` : "",
    v.notes ?? "",
  ];
  return parts.filter((p) => p !== "").join(" · ");
}
```

`src/lib/csv.ts`:

```ts
/**
 * Minimal RFC 4180 parser for the sample_data catalogue files: commas, double-quoted fields
 * with "" escapes and embedded commas/newlines, CRLF or LF endings, an optional UTF-8 BOM.
 * Blank lines are skipped. Never throws: an unterminated quote runs to the end of the input.
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRow();
      i += c === "\r" && input[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Rows as objects keyed by the trimmed, lower-cased header. Extra columns are dropped. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, (row[index] ?? "").trim()])));
}
```

In `src/lib/domain/permissions.ts`, add two entries to the `MATRIX` object directly after the `"rx.amend"` entry (it is the last entry today; Plan 1C appends after `"catalogue.write"`):

```ts
  "catalogue.read": ["owner", "doctor", "nurse", "pharmacist"],
  "catalogue.write": ["owner", "doctor"],
```

Clinical fields keep using the existing `"rx.draft"` action (owner, doctor) and finalizing keeps `"rx.finalize"`. Do not add a separate action for them.

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/text.test.ts tests/unit/search.test.ts tests/unit/csv.test.ts tests/unit/rx-format.test.ts tests/unit/permissions.test.ts
```

Expected: all PASS, including every Plan 1A cell of the matrix. If a `formatSchedule` row fails, fix the code, not the table: `s(1, 0, 0, 1)` is `"1-0-1"` because a zero evening dose uses the three-slot form. Check the escapes survived: `Select-String -Path tests/unit/text.test.ts,tests/unit/search.test.ts,tests/unit/csv.test.ts -Pattern '\\u0958|\\ufeff'` must list the escape lines (written as backslash-u text, not raw characters).

- [ ] **Step 5: Lint, typecheck, full suite, commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/lib/domain/text.ts src/lib/domain/search.ts src/lib/domain/rx-options.ts src/lib/domain/rx-format.ts src/lib/csv.ts src/lib/domain/permissions.ts tests/unit/text.test.ts tests/unit/search.test.ts tests/unit/csv.test.ts tests/unit/rx-format.test.ts tests/unit/permissions.test.ts
git commit -m "feat: add clinical text, search, schedule, CSV, and catalogue permission primitives" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 2: Same-tenant keys first, then the schema, migrations, and database guarantees for the new data

This task has two parts with one commit each. **Part A** (Steps 1–7) is migration `0010`: the composite keys for the three tenant-owned references that have no foreign key today, and one doctor profile per user per clinic (decision 18). It must land before anything references `doctors`. **Part B** (Steps 8–15) adds the clinical columns and the catalogue tables (migrations `0011` and `0012`).

**Files:**
- Modify: `src/server/db/schema/tenancy.ts`, `src/server/db/schema/clinical.ts`, `src/server/db/schema/index.ts`
- Create: `src/server/db/schema/catalogue.ts`; `drizzle/0010_clinical_references.sql` (generated, then hand-edited), `drizzle/0011_phase1b_clinical.sql` (generated), `drizzle/0012_phase1b_catalogue_security.sql` (custom); `drizzle/meta/0010_snapshot.json`, `0011_snapshot.json`, `0012_snapshot.json` and three `drizzle/meta/_journal.json` entries (all written by drizzle-kit)
- Test: `tests/integration/clinical-references.test.ts`, `tests/integration/clinical-schema.test.ts`

**Interfaces:**
- Consumes: the real schema (`patients`, `visits`, `prescriptions`, `prescriptionItems`, `templates`, `templateVersions`, `tenants` in `clinical.ts`; `clinics`, `branches`, `doctors`, `users` in `tenancy.ts`), the immutability triggers (`enforce_rx_immutability`, `enforce_rx_item_immutability`, `enforce_visit_immutability` as last replaced by 0005/0006/0008), `tenant_is_erased`, the tenant-FK guard in `tests/integration/tenant-fk.test.ts`; Task 1 `Vitals`, `Investigation`.
- Produces (Drizzle and SQL):
  - Part A: `doctors` unique keys `doctors_tenant_id_uq (tenant_id, id)` and `doctors_tenant_user_uq (tenant_id, user_id)`; `template_versions_tenant_id_uq (tenant_id, id)`; foreign keys `visits_doctor_fk (tenant_id, doctor_id) -> doctors`, `visits_branch_fk (tenant_id, branch_id) -> branches`, `prescriptions_template_version_fk (tenant_id, template_version_id) -> template_versions`, each `ON DELETE SET NULL (<column>)`.
  - `visits`: `vitals: Vitals | null` (type only, no SQL change), new `complaints`, `medicalHistory`, `drugHistory: string[] | null`, `examinationNotes`, `followUpReason: string | null`, `investigations: Investigation[] | null`.
  - `prescriptions.draftRevision: number` (not null, default 0).
  - `prescriptionItems`: new `genericName: string | null`, `doseMorning`, `doseAfternoon`, `doseEvening`, `doseNight: number | null` (numeric(5,2), mode number), `periodicity: string | null`, `isSos: boolean` (not null, default false), `durationValue: number | null`, `durationUnit: string | null`.
  - Tables `globalMedicines` (`id`, `name`, `genericName`, `nameKey` unique, `createdAt`), `globalClinicalTerms` (`id`, `kind`, `name`, `nameKey`, `icd10Code`, `createdAt`; unique `(kind, nameKey)`), `tenantMedicines` (`id`, `tenantId`, `name`, `genericName`, `nameKey`, `createdBy`, `createdAt`; unique `(tenantId, nameKey)`), `medicineFavourites` (`id`, `tenantId`, `doctorId`, `nameKey`, the item line columns, `createdAt`, `updatedAt`; unique `(tenantId, doctorId, nameKey)`; foreign key `medicine_favourites_doctor_fk (tenant_id, doctor_id) -> doctors(tenant_id, id)` `ON DELETE CASCADE`).
  - Database: forced RLS on all four new tables; tenant isolation policy on the two tenant tables; select-only access for `clinicpad_app` on the two global tables; CHECK constraints on term kinds and duration units. The tenant-FK guard stays green with an empty allowlist (every new key into a tenant-owned table is composite; `tenant_id -> tenants(id)` keys point at the root, which has no `tenant_id`).

### Part A — composite keys for the doctor, branch, and template-version references (migration 0010)

- [ ] **Step 1: Write the failing integration test**

`tests/integration/clinical-references.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  branches,
  clinics,
  doctors,
  patients,
  prescriptions,
  templates,
  templateVersions,
  tenants,
  users,
  visits,
} from "@/server/db/schema";

// Migration 0010: visits.doctor_id, visits.branch_id and prescriptions.template_version_id had no foreign key at
// all, so a row could point at another clinic's doctor, branch or template version. They become composite
// (tenant_id, x_id) keys with ON DELETE SET NULL (x_id), and a user gets at most one doctor profile per clinic.

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let tenantA = "";
let tenantB = "";
const userIds: string[] = [];

type Conn = Pick<typeof adminDb, "insert" | "update">;
const connections: { label: string; run: <T>(fn: (c: Conn) => Promise<T>) => Promise<T> }[] = [
  { label: "the app role (RLS-bound, tenant A)", run: (fn) => withTenant(tenantA, fn) },
  { label: "the admin connection", run: (fn) => fn(adminDb) },
];

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  return pgErrorInfo(error);
}

/** A clinic, branch, doctor, template version and patient, all in one tenant. */
async function world(tenantId: string) {
  const [clinic] = await adminDb.insert(clinics).values({ tenantId, name: "Ref clinic" }).returning();
  const [branch] = await adminDb.insert(branches).values({ tenantId, clinicId: clinic.id, name: "Ref branch" }).returning();
  const [doctor] = await adminDb.insert(doctors).values({ tenantId, regNo: "REF-1" }).returning();
  const [template] = await adminDb.insert(templates).values({ tenantId, name: "Ref template" }).returning();
  const [version] = await adminDb
    .insert(templateVersions)
    .values({ tenantId, templateId: template.id, version: 1 })
    .returning();
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Ref patient" }).returning();
  return { clinic, branch, doctor, template, version, patient };
}
type World = Awaited<ReturnType<typeof world>>;

/** A draft visit and prescription that point at w's doctor, branch and template version. */
async function draftFor(tenantId: string, w: World) {
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId, patientId: w.patient.id, doctorId: w.doctor.id, branchId: w.branch.id, status: "draft" })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId, visitId: visit.id, status: "draft", templateVersionId: w.version.id })
    .returning();
  return { visit, rx };
}

/** Freeze the records the way the services do: the prescription first, then its visit. */
async function finalize(rxId: string, visitId: string) {
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rxId));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));
}

async function newUser(label: string): Promise<string> {
  const [user] = await adminDb
    .insert(users)
    .values({ email: `${label}-${stamp}@example.com`, name: "Dr Ref", passwordHash: "not-a-real-hash" })
    .returning();
  userIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenants).values({ name: "Refs A", slug: `refs-a-${stamp}` }).returning();
  const [b] = await adminDb.insert(tenants).values({ name: "Refs B", slug: `refs-b-${stamp}` }).returning();
  tenantA = a.id;
  tenantB = b.id;
});

afterAll(async () => {
  try {
    await adminDb.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB].filter(Boolean)));
  } finally {
    if (userIds.length > 0) await adminDb.delete(users).where(inArray(users.id, userIds));
  }
});

describe.each(connections)("cross-clinic references through $label", (connection) => {
  it("rejects a visit pointing at another clinic's doctor or branch, as an INSERT and as an UPDATE", async () => {
    const own = await world(tenantA);
    const foreign = await world(tenantB);
    const { visit } = await draftFor(tenantA, own);

    const doctorInsert = await rejection(
      connection.run((c) => c.insert(visits).values({ tenantId: tenantA, patientId: own.patient.id, doctorId: foreign.doctor.id })),
    );
    expect(doctorInsert).toMatchObject({ code: "23503", constraint: "visits_doctor_fk" });
    const branchUpdate = await rejection(
      connection.run((c) => c.update(visits).set({ branchId: foreign.branch.id }).where(eq(visits.id, visit.id))),
    );
    expect(branchUpdate).toMatchObject({ code: "23503", constraint: "visits_branch_fk" });
  });

  it("rejects a prescription pointing at another clinic's template version", async () => {
    const own = await world(tenantA);
    const foreign = await world(tenantB);
    const { visit, rx } = await draftFor(tenantA, own);

    const insert = await rejection(
      connection.run((c) =>
        c.insert(prescriptions).values({ tenantId: tenantA, visitId: visit.id, templateVersionId: foreign.version.id }),
      ),
    );
    expect(insert).toMatchObject({ code: "23503", constraint: "prescriptions_template_version_fk" });
    const update = await rejection(
      connection.run((c) =>
        c.update(prescriptions).set({ templateVersionId: foreign.version.id }).where(eq(prescriptions.id, rx.id)),
      ),
    );
    expect(update).toMatchObject({ code: "23503", constraint: "prescriptions_template_version_fk" });
  });

  it("still accepts same-clinic references and missing ones", async () => {
    const own = await world(tenantA);
    const rows = await connection.run((c) =>
      c
        .insert(visits)
        .values({ tenantId: tenantA, patientId: own.patient.id, doctorId: own.doctor.id, branchId: own.branch.id })
        .returning({ id: visits.id }),
    );
    expect(rows).toHaveLength(1);
    const bare = await connection.run((c) =>
      c.insert(visits).values({ tenantId: tenantA, patientId: own.patient.id }).returning({ id: visits.id }),
    );
    expect(bare).toHaveLength(1);
  });
});

describe("one doctor profile per user per clinic", () => {
  it("refuses a second profile for the same user in the same clinic only", async () => {
    const userId = await newUser("one-profile");
    await adminDb.insert(doctors).values({ tenantId: tenantA, userId });
    const second = await rejection(adminDb.insert(doctors).values({ tenantId: tenantA, userId }));
    expect(second).toMatchObject({ code: "23505", constraint: "doctors_tenant_user_uq" });
    // The same user may be a doctor in another clinic, and profiles without a user do not collide.
    await adminDb.insert(doctors).values({ tenantId: tenantB, userId });
    await adminDb.insert(doctors).values([{ tenantId: tenantA }, { tenantId: tenantA }]);
  });
});

describe("delete rules", () => {
  it("nulls only the reference (never tenant_id) when a doctor, branch, or template of a draft is deleted", async () => {
    const own = await world(tenantA);
    const { visit, rx } = await draftFor(tenantA, own);

    await adminDb.delete(doctors).where(eq(doctors.id, own.doctor.id));
    await adminDb.delete(branches).where(eq(branches.id, own.branch.id));
    await adminDb.delete(templates).where(eq(templates.id, own.template.id)); // cascades to its versions

    const [v] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(v).toMatchObject({ tenantId: tenantA, doctorId: null, branchId: null });
    const [p] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(p).toMatchObject({ tenantId: tenantA, templateVersionId: null });
  });

  it("refuses to delete a doctor, branch, or template version that a finalized record references", async () => {
    const own = await world(tenantA);
    const { visit, rx } = await draftFor(tenantA, own);
    await finalize(rx.id, visit.id);

    // ON DELETE SET NULL is an UPDATE of the signed row, which the immutability triggers refuse.
    expect((await rejection(adminDb.delete(doctors).where(eq(doctors.id, own.doctor.id)))).code).toBe("23000");
    expect((await rejection(adminDb.delete(branches).where(eq(branches.id, own.branch.id)))).code).toBe("23000");
    expect((await rejection(adminDb.delete(templateVersions).where(eq(templateVersions.id, own.version.id)))).code).toBe(
      "23000",
    );

    const [v] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(v).toMatchObject({ doctorId: own.doctor.id, branchId: own.branch.id });
    const [p] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(p.templateVersionId).toBe(own.version.id);
  });

  it("still offboards a tenant whose signed records reference its doctor, branch, and template version", async () => {
    const [t] = await adminDb.insert(tenants).values({ name: "Refs offboard", slug: `refs-off-${stamp}` }).returning();
    const w = await world(t.id);
    const { visit, rx } = await draftFor(t.id, w);
    await finalize(rx.id, visit.id);

    // The tenant-level cascades delete visits and prescriptions before the nested SET NULL actions run.
    await adminDb.delete(tenants).where(eq(tenants.id, t.id));
    expect(await adminDb.select().from(visits).where(eq(visits.tenantId, t.id))).toHaveLength(0);
    expect(await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, t.id))).toHaveLength(0);
    expect(await adminDb.select().from(doctors).where(eq(doctors.tenantId, t.id))).toHaveLength(0);
  });

  it("declares each new key as SET NULL on its own column only", async () => {
    const rows = await adminDb.execute<{ conname: string; on_delete: string; set_cols: string[] | null }>(sql`
      select c.conname::text as conname,
             c.confdeltype::text as on_delete,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(c.confdelsetcols) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as set_cols
        from pg_constraint c
       where c.connamespace = 'public'::regnamespace
         and c.conname in ('visits_doctor_fk', 'visits_branch_fk', 'prescriptions_template_version_fk')
       order by c.conname`);
    expect([...rows]).toEqual([
      { conname: "prescriptions_template_version_fk", on_delete: "n", set_cols: ["template_version_id"] },
      { conname: "visits_branch_fk", on_delete: "n", set_cols: ["branch_id"] },
      { conname: "visits_doctor_fk", on_delete: "n", set_cols: ["doctor_id"] },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/clinical-references.test.ts
```

Expected: FAIL — the cross-clinic inserts and updates succeed (no foreign key exists), the second doctor profile is accepted, deleting a referenced doctor succeeds, and the catalog query finds no constraints.

- [ ] **Step 3: Add the keys to the schema**

In `src/server/db/schema/tenancy.ts`, in the `doctors` table's constraint list, add these two entries directly after `index("doctors_user_idx").on(t.userId),`:

```ts
    // Target of the composite same-tenant foreign keys from visits.doctor_id and medicine_favourites.doctor_id.
    unique("doctors_tenant_id_uq").on(t.tenantId, t.id),
    // One doctor profile per user per clinic, so the user -> doctor lookup (doctorIdFor) is deterministic.
    unique("doctors_tenant_user_uq").on(t.tenantId, t.userId),
```

In `src/server/db/schema/clinical.ts`:

1. Change the import of `./tenancy` to `import { branches, doctors, tenants } from "./tenancy";`.
2. In `visits`, add directly after the `visits_patient_fk` foreign key:

```ts
    // Same-tenant references, both optional. The delete rule is ON DELETE SET NULL (doctor_id) / (branch_id):
    // drizzle-kit cannot express the column list, so migration 0010 is hand-edited; keep it in step. Deleting a
    // doctor or branch that a finalized visit references fails (the SET NULL is an UPDATE the trigger refuses).
    foreignKey({
      name: "visits_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctors.tenantId, doctors.id],
    }).onDelete("set null"),
    foreignKey({
      name: "visits_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("set null"),
```

3. In `prescriptions`, add directly after the `prescriptions_parent_fk` foreign key (`templateVersions` is declared further down the file; the constraint callback runs lazily, so the forward reference is fine):

```ts
    // Same-tenant reference, optional; ON DELETE SET NULL (template_version_id) is hand-written in migration 0010.
    foreignKey({
      name: "prescriptions_template_version_fk",
      columns: [t.tenantId, t.templateVersionId],
      foreignColumns: [templateVersions.tenantId, templateVersions.id],
    }).onDelete("set null"),
```

4. In `templateVersions`, add as the first entry of its constraint list:

```ts
    // Target of the composite same-tenant foreign key from prescriptions.template_version_id.
    unique("template_versions_tenant_id_uq").on(t.tenantId, t.id),
```

- [ ] **Step 4: Generate migration 0010 and hand-edit it**

```powershell
Set-Location E:\projects\clinicpad; npm run db:generate -- --name=clinical_references
```

drizzle-kit writes `drizzle/0010_clinical_references.sql`, `drizzle/meta/0010_snapshot.json`, and a journal entry with `"idx": 10`. The generated SQL contains exactly three `ADD CONSTRAINT ... UNIQUE` and three `ADD CONSTRAINT ... FOREIGN KEY ... ON DELETE set null` statements and nothing else (stop and fix the schema edit if it drops, alters, or recreates anything). It emits the foreign keys before the unique constraints they need and a plain `SET NULL`. Replace the whole file with exactly this (the same statements, reordered, with the column lists added; the snapshot stays as generated):

```sql
-- Same-tenant references for the last tenant-owned columns that had no foreign key at all (AGENTS.md invariant 1),
-- in the composite pattern of 0007 and 0009, plus one doctor profile per user per clinic.
--
-- Hand-edited after `drizzle-kit generate`, nothing else was changed:
--  1. It emitted the ADD FOREIGN KEY statements before the UNIQUE constraints they reference, which cannot be
--     applied. Order here: the unique targets first, then the keys.
--  2. Each key is ON DELETE SET NULL (column) (Postgres 15+). drizzle-kit emits a plain SET NULL, which on a
--     composite key would also try to null tenant_id (NOT NULL).
-- Deleting a doctor, branch or template version that a finalized record references is refused by the immutability
-- triggers (the SET NULL is an UPDATE of a signed row). Tenant offboarding still works: the tenant-level cascades
-- delete the visits and prescriptions before these nested SET NULL actions run
-- (tests/integration/clinical-references.test.ts).
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_tenant_user_uq" UNIQUE("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_template_version_fk" FOREIGN KEY ("tenant_id","template_version_id") REFERENCES "public"."template_versions"("tenant_id","id") ON DELETE set null ("template_version_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE set null ("doctor_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE set null ("branch_id") ON UPDATE no action;
```

- [ ] **Step 5: Check the existing data, then apply 0010**

Adding a foreign key or unique constraint validates every existing row, and the immutability triggers forbid fixing finalized rows with `UPDATE`. Check the dev database **before** migrating (a fresh database, such as CI's or a new clone's, has nothing to check):

```powershell
Set-Location E:\projects\clinicpad; @'
select 'visits.doctor_id' as reference, count(*) as violations from visits v
 where v.doctor_id is not null
   and not exists (select 1 from doctors d where d.tenant_id = v.tenant_id and d.id = v.doctor_id)
union all
select 'visits.branch_id', count(*) from visits v
 where v.branch_id is not null
   and not exists (select 1 from branches b where b.tenant_id = v.tenant_id and b.id = v.branch_id)
union all
select 'prescriptions.template_version_id', count(*) from prescriptions p
 where p.template_version_id is not null
   and not exists (select 1 from template_versions t where t.tenant_id = p.tenant_id and t.id = p.template_version_id)
union all
select 'doctors (tenant_id, user_id) duplicates', count(*) from (
  select tenant_id, user_id from doctors where user_id is not null group by tenant_id, user_id having count(*) > 1
) dup;
'@ | docker exec -i clinicpad-postgres psql -U clinicpad -d clinicpad -v ON_ERROR_STOP=1
```

Expected: four rows, every `violations` value `0` (the demo seed and the test helpers only reference same-tenant doctors and branches, and nothing sets `template_version_id` yet). If a count is not zero, the rows belong to demo or test tenants (no staging or production database exists yet): find their tenants with the same `where` clause selecting `v.tenant_id` (or `p.tenant_id`, or `dup.tenant_id`), delete those tenants as the admin role (`delete from tenants where id = '<id>';`, the cascade removes their signed rows through `tenant_is_erased`), rerun `npm run db:seed` if one of them was the demo clinic, and rerun the check. Never `UPDATE` a clinical row to make the check pass. Then:

```powershell
Set-Location E:\projects\clinicpad; npm run db:migrate
```

Expected: `0010_clinical_references` applies. If it fails, the migration rolls back as a whole; rerun the check above.

- [ ] **Step 6: Run the reference tests and every suite that deletes tenants**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/clinical-references.test.ts tests/integration/tenant-fk.test.ts tests/integration/immutability.test.ts tests/integration/prescriptions-draft.test.ts tests/integration/prescriptions-lifecycle.test.ts tests/integration/seed.test.ts
```

Expected: all PASS; the tenant-FK guard still reports no single-column key. If the offboarding test (or any `afterAll` tenant cleanup) fails with `23000` from `enforce_visit_immutability` or `enforce_rx_immutability`, a nested `SET NULL` ran before the tenant-level cascade removed the row: do not weaken the test or change the delete rule; stop and report (the fix is a `tenant_is_erased` exemption for `UPDATE` in the triggers, which needs a ruling).

- [ ] **Step 7: Full suite and commit Part A**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/server/db/schema/tenancy.ts src/server/db/schema/clinical.ts drizzle/0010_clinical_references.sql drizzle/meta/0010_snapshot.json drizzle/meta/_journal.json tests/integration/clinical-references.test.ts
git commit -m "fix: enforce same-tenant doctor, branch, and template version references" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

### Part B — clinical columns and catalogue tables (migrations 0011 and 0012)

- [ ] **Step 8: Write the failing integration test**

`tests/integration/clinical-schema.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  doctors,
  globalClinicalTerms,
  globalMedicines,
  medicineFavourites,
  patients,
  prescriptionItems,
  prescriptions,
  tenantMedicines,
  tenants,
  visits,
} from "@/server/db/schema";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const globalKey = `zzschema ${stamp}`;
let tenantId = "";
let otherTenantId = "";
let doctorId = "";
let otherDoctorId = "";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

/** A draft visit + prescription + item using every new column. */
async function clinicalDraft() {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Schema Patient" }).returning();
  const [visit] = await adminDb
    .insert(visits)
    .values({
      tenantId,
      patientId: patient.id,
      status: "draft",
      complaints: ["Fever"],
      medicalHistory: ["DM"],
      drugHistory: ["Metformin"],
      examinationNotes: "Throat congested",
      vitals: { pulse: 88, spo2: 97 },
      investigations: [{ name: "CBC", instructions: "Fasting" }],
      followUpReason: "Review reports",
    })
    .returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId, visitId: visit.id, status: "draft" }).returning();
  const [item] = await adminDb
    .insert(prescriptionItems)
    .values({
      tenantId,
      prescriptionId: rx.id,
      drugName: "DOLO 650MG",
      genericName: "Paracetamol 650Mg",
      doseMorning: 1,
      doseAfternoon: 0,
      doseNight: 1,
      periodicity: "daily",
      durationValue: 5,
      durationUnit: "days",
      durationDays: 5,
    })
    .returning();
  return { visit, rx, item };
}

async function finalize(rxId: string, visitId: string) {
  await adminDb
    .update(prescriptions)
    .set({ status: "finalized", finalizedAt: new Date() })
    .where(eq(prescriptions.id, rxId));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));
}

beforeAll(async () => {
  const [t] = await adminDb.insert(tenants).values({ name: "Schema1B", slug: `schema1b-${stamp}` }).returning();
  const [o] = await adminDb.insert(tenants).values({ name: "Schema1B-2", slug: `schema1b2-${stamp}` }).returning();
  tenantId = t.id;
  otherTenantId = o.id;
  const [d] = await adminDb.insert(doctors).values({ tenantId }).returning();
  const [od] = await adminDb.insert(doctors).values({ tenantId: otherTenantId }).returning();
  doctorId = d.id;
  otherDoctorId = od.id;
});

afterAll(async () => {
  // Deleting a tenant must still cascade through finalized records and the new tables.
  await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
  await adminDb.delete(tenants).where(eq(tenants.id, otherTenantId));
  expect(await adminDb.select().from(visits).where(eq(visits.tenantId, tenantId))).toHaveLength(0);
  expect(await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.tenantId, tenantId))).toHaveLength(0);
  expect(await adminDb.select().from(tenantMedicines).where(eq(tenantMedicines.tenantId, tenantId))).toHaveLength(0);
  expect(await adminDb.select().from(medicineFavourites).where(eq(medicineFavourites.tenantId, tenantId))).toHaveLength(0);
});

describe("new clinical columns", () => {
  it("round-trip on a draft and stay editable while it is a draft", async () => {
    const { visit, rx, item } = await clinicalDraft();
    expect(visit.vitals).toEqual({ pulse: 88, spo2: 97 });
    expect(visit.investigations).toEqual([{ name: "CBC", instructions: "Fasting" }]);
    expect(rx.draftRevision).toBe(0);
    expect(item.doseMorning).toBe(1);
    expect(item.doseEvening).toBeNull();
    expect(item.isSos).toBe(false);

    await adminDb.update(visits).set({ complaints: ["Cough"] }).where(eq(visits.id, visit.id));
    await adminDb.update(prescriptionItems).set({ doseMorning: 0.5 }).where(eq(prescriptionItems.id, item.id));
    await adminDb.update(prescriptions).set({ draftRevision: 1 }).where(eq(prescriptions.id, rx.id));
    const [after] = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.id, item.id));
    expect(after.doseMorning).toBe(0.5);
  });

  it("are frozen with the rest of a finalized prescription, even on the admin connection", async () => {
    const { visit, rx, item } = await clinicalDraft();
    await finalize(rx.id, visit.id);

    await expectCode(adminDb.update(visits).set({ complaints: ["Changed"] }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.update(visits).set({ vitals: { pulse: 200 } }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.update(visits).set({ investigations: [] }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(
      adminDb.update(visits).set({ examinationNotes: "x", followUpReason: "y" }).where(eq(visits.id, visit.id)),
      "23000",
    );
    await expectCode(adminDb.update(prescriptionItems).set({ doseNight: 3 }).where(eq(prescriptionItems.id, item.id)), "23000");
    await expectCode(
      adminDb.update(prescriptionItems).set({ isSos: true, durationUnit: "weeks" }).where(eq(prescriptionItems.id, item.id)),
      "23000",
    );
    await expectCode(adminDb.update(prescriptions).set({ draftRevision: 99 }).where(eq(prescriptions.id, rx.id)), "23000");

    const [unchanged] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(unchanged.vitals).toEqual({ pulse: 88, spo2: 97 });
    expect(unchanged.complaints).toEqual(["Fever"]);
  });

  it("are frozen on a still-draft visit as soon as its prescription is finalized (the 0008 visit guard)", async () => {
    const { visit, rx } = await clinicalDraft();
    await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rx.id));

    await expectCode(adminDb.update(visits).set({ complaints: ["Changed"] }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.update(visits).set({ investigations: [] }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.update(visits).set({ vitals: { pulse: 60 } }).where(eq(visits.id, visit.id)), "23000");
    // The plain draft -> finalized flip is still accepted, with every new column unchanged.
    await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visit.id));
    const [flipped] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(flipped).toMatchObject({ status: "finalized", complaints: ["Fever"], vitals: { pulse: 88, spo2: 97 } });
  });

  it("rejects an unknown duration unit at the database", async () => {
    const { rx } = await clinicalDraft();
    await expectCode(
      adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "X", durationUnit: "fortnights" }),
      "23514",
    );
  });
});

describe("tenant catalogue tables", () => {
  it("isolate clinic medicines and favourites by tenant", async () => {
    await withTenant(tenantId, (tx) =>
      tx.insert(tenantMedicines).values({ tenantId, name: "My Clinic Syrup", nameKey: "my clinic syrup" }),
    );
    await withTenant(tenantId, (tx) =>
      tx.insert(medicineFavourites).values({ tenantId, doctorId, nameKey: "my clinic syrup", drugName: "My Clinic Syrup" }),
    );
    expect(await withTenant(tenantId, (tx) => tx.select().from(tenantMedicines))).toHaveLength(1);
    expect(await withTenant(otherTenantId, (tx) => tx.select().from(tenantMedicines))).toHaveLength(0);
    expect(await withTenant(otherTenantId, (tx) => tx.select().from(medicineFavourites))).toHaveLength(0);
  });

  it("refuse a favourite that points at another clinic's doctor (composite key)", async () => {
    const row = { tenantId, doctorId: otherDoctorId, nameKey: "leak", drugName: "Leak" };
    const attempts = [
      async () => {
        await adminDb.insert(medicineFavourites).values(row);
      },
      async () => {
        await withTenant(tenantId, (tx) => tx.insert(medicineFavourites).values(row));
      },
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(pgErrorInfo(error)).toMatchObject({ code: "23503", constraint: "medicine_favourites_doctor_fk" });
    }
  });

  it("delete a doctor's favourites with the doctor", async () => {
    const [extra] = await adminDb.insert(doctors).values({ tenantId }).returning();
    await adminDb.insert(medicineFavourites).values({ tenantId, doctorId: extra.id, nameKey: "gone", drugName: "Gone" });
    await adminDb.delete(doctors).where(eq(doctors.id, extra.id));
    expect(await adminDb.select().from(medicineFavourites).where(eq(medicineFavourites.doctorId, extra.id))).toHaveLength(0);
  });

  it("refuse rows written for another tenant", async () => {
    await expectCode(
      withTenant(otherTenantId, (tx) => tx.insert(tenantMedicines).values({ tenantId, name: "Leak", nameKey: "leak" })),
      "42501",
    );
  });

  it("return nothing when no tenant is set", async () => {
    expect(await db.select().from(tenantMedicines)).toHaveLength(0);
    expect(await db.select().from(medicineFavourites)).toHaveLength(0);
  });
});

describe("global reference tables", () => {
  beforeAll(async () => {
    await adminDb.insert(globalMedicines).values({ name: `ZZSCHEMA ${stamp} TAB`, nameKey: `${globalKey} tab`, genericName: "Testamol" });
    await adminDb.insert(globalClinicalTerms).values({ kind: "complaint", name: `ZZSCHEMA ${stamp} ACHE`, nameKey: `${globalKey} ache` });
  });

  afterAll(async () => {
    await adminDb.delete(globalMedicines).where(like(globalMedicines.nameKey, `${globalKey}%`));
    await adminDb.delete(globalClinicalTerms).where(like(globalClinicalTerms.nameKey, `${globalKey}%`));
  });

  it("are readable by every clinic", async () => {
    for (const id of [tenantId, otherTenantId]) {
      const meds = await withTenant(id, (tx) =>
        tx.select().from(globalMedicines).where(eq(globalMedicines.nameKey, `${globalKey} tab`)),
      );
      expect(meds).toHaveLength(1);
      const terms = await withTenant(id, (tx) =>
        tx.select().from(globalClinicalTerms).where(eq(globalClinicalTerms.nameKey, `${globalKey} ache`)),
      );
      expect(terms).toHaveLength(1);
    }
  });

  it("are read-only for the application role", async () => {
    await expectCode(
      withTenant(tenantId, (tx) => tx.insert(globalMedicines).values({ name: "Injected", nameKey: `${globalKey} injected` })),
      "42501",
    );
    await expectCode(
      withTenant(tenantId, (tx) =>
        tx.update(globalMedicines).set({ genericName: "Tampered" }).where(eq(globalMedicines.nameKey, `${globalKey} tab`)),
      ),
      "42501",
    );
    await expectCode(
      withTenant(tenantId, (tx) => tx.delete(globalMedicines).where(eq(globalMedicines.nameKey, `${globalKey} tab`))),
      "42501",
    );
    await expectCode(
      withTenant(tenantId, (tx) =>
        tx.insert(globalClinicalTerms).values({ kind: "test", name: "Injected", nameKey: `${globalKey} injected` }),
      ),
      "42501",
    );
    await expectCode(db.delete(globalClinicalTerms).where(like(globalClinicalTerms.nameKey, `${globalKey}%`)), "42501");

    const [still] = await adminDb.select().from(globalMedicines).where(eq(globalMedicines.nameKey, `${globalKey} tab`));
    expect(still.genericName).toBe("Testamol");
  });

  it("reject unknown term kinds", async () => {
    await expectCode(
      adminDb.insert(globalClinicalTerms).values({ kind: "spell", name: "X", nameKey: `${globalKey} spell` }),
      "23514",
    );
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/clinical-schema.test.ts
```

Expected: FAIL — `globalMedicines` and the other new tables are not exported from `@/server/db/schema` (and the new columns do not exist).

- [ ] **Step 10: Extend the clinical schema**

In `src/server/db/schema/clinical.ts`:

1. Add `boolean` and `numeric` to the existing `drizzle-orm/pg-core` import list (keep everything already imported), and add this type import below the other imports. The relative path is deliberate: drizzle-kit loads this file directly, and a type-only import is erased.

```ts
import type { Investigation, Vitals } from "../../../lib/domain/rx-options";
```

2. In `visits`, replace the `vitals` line:

```ts
    vitals: jsonb("vitals").$type<Vitals>(),
```

and add these columns directly after `followUpDate: date("follow_up_date"),`:

```ts
    complaints: text("complaints").array(),
    medicalHistory: text("medical_history").array(),
    drugHistory: text("drug_history").array(),
    examinationNotes: text("examination_notes"),
    investigations: jsonb("investigations").$type<Investigation[]>(),
    followUpReason: text("follow_up_reason"),
```

3. In `prescriptions`, add directly after `version: integer("version").notNull().default(1),`:

```ts
    /** Optimistic-concurrency counter for draft saves (Plan 1B). Frozen with the row at finalize. */
    draftRevision: integer("draft_revision").notNull().default(0),
```

4. In `prescriptionItems`, add directly after `remarks: text("remarks"),`:

```ts
    genericName: text("generic_name"),
    doseMorning: numeric("dose_morning", { precision: 5, scale: 2, mode: "number" }),
    doseAfternoon: numeric("dose_afternoon", { precision: 5, scale: 2, mode: "number" }),
    doseEvening: numeric("dose_evening", { precision: 5, scale: 2, mode: "number" }),
    doseNight: numeric("dose_night", { precision: 5, scale: 2, mode: "number" }),
    periodicity: text("periodicity"),
    isSos: boolean("is_sos").notNull().default(false),
    durationValue: integer("duration_value"),
    durationUnit: text("duration_unit"),
```

- [ ] **Step 11: Add the catalogue schema**

`src/server/db/schema/catalogue.ts`:

```ts
import {
  boolean,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { doctors, tenants } from "./tenancy";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const doseSlot = (name: string) => numeric(name, { precision: 5, scale: 2, mode: "number" });

/**
 * Read-only reference medicines shared by every clinic, loaded from sample_data by
 * `npm run db:seed:catalogue`. No tenant_id by design: the app role can only SELECT.
 */
export const globalMedicines = pgTable(
  "global_medicines",
  {
    id: pk(),
    name: text("name").notNull(),
    genericName: text("generic_name"),
    nameKey: text("name_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("global_medicines_name_key_unique").on(t.nameKey)],
);

/** Read-only suggestion lists: kind is complaint | diagnosis | history | test. */
export const globalClinicalTerms = pgTable(
  "global_clinical_terms",
  {
    id: pk(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    icd10Code: text("icd10_code"),
    createdAt: createdAt(),
  },
  (t) => [unique("global_terms_kind_key_unique").on(t.kind, t.nameKey)],
);

/** Medicines a clinic added itself. Visible only inside that clinic (RLS). */
export const tenantMedicines = pgTable(
  "tenant_medicines",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    genericName: text("generic_name"),
    nameKey: text("name_key").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [unique("tenant_medicines_tenant_key_unique").on(t.tenantId, t.nameKey)],
);

/**
 * A doctor's saved default line for one medicine (one per medicine name per doctor profile).
 * The composite key keeps a favourite inside its doctor's clinic (ADR-0025); deleting the
 * doctor profile deletes its favourites.
 */
export const medicineFavourites = pgTable(
  "medicine_favourites",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    doctorId: uuid("doctor_id").notNull(),
    nameKey: text("name_key").notNull(),
    drugName: text("drug_name").notNull(),
    genericName: text("generic_name"),
    strength: text("strength"),
    form: text("form"),
    route: text("route"),
    dose: text("dose"),
    doseMorning: doseSlot("dose_morning"),
    doseAfternoon: doseSlot("dose_afternoon"),
    doseEvening: doseSlot("dose_evening"),
    doseNight: doseSlot("dose_night"),
    timing: text("timing"),
    foodRelation: text("food_relation"),
    periodicity: text("periodicity"),
    isSos: boolean("is_sos").notNull().default(false),
    durationValue: integer("duration_value"),
    durationUnit: text("duration_unit"),
    remarks: text("remarks"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("medicine_favourites_doctor_key_unique").on(t.tenantId, t.doctorId, t.nameKey),
    index("medicine_favourites_doctor_idx").on(t.tenantId, t.doctorId),
    // Same-tenant reference (ADR-0025); doctors_tenant_id_uq exists since migration 0010.
    foreignKey({
      name: "medicine_favourites_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctors.tenantId, doctors.id],
    }).onDelete("cascade"),
  ],
);
```

In `src/server/db/schema/index.ts`, add a line at the end:

```ts
export * from "./catalogue";
```

- [ ] **Step 12: Generate migration 0011 and inspect it**

```powershell
Set-Location E:\projects\clinicpad; npm run db:generate -- --name=phase1b_clinical
```

Expected: `drizzle/0011_phase1b_clinical.sql`, `drizzle/meta/0011_snapshot.json`, and a journal entry with `"idx": 11`. Open the SQL. It must contain only:

- `CREATE TABLE "global_medicines"`, `"global_clinical_terms"`, `"tenant_medicines"`, `"medicine_favourites"`, their `tenant_id` foreign keys to `tenants` (`ON DELETE cascade`), the four unique constraints, `CREATE INDEX "medicine_favourites_doctor_idx"`, and `ALTER TABLE "medicine_favourites" ADD CONSTRAINT "medicine_favourites_doctor_fk" FOREIGN KEY ("tenant_id","doctor_id") REFERENCES "public"."doctors"("tenant_id","id") ON DELETE cascade` (no reordering is needed: the unique key it references was created by 0010);
- `ALTER TABLE "visits" ADD COLUMN` for `complaints text[]`, `medical_history text[]`, `drug_history text[]`, `examination_notes text`, `investigations jsonb`, `follow_up_reason text`;
- `ALTER TABLE "prescriptions" ADD COLUMN "draft_revision" integer DEFAULT 0 NOT NULL`;
- `ALTER TABLE "prescription_items" ADD COLUMN` for `generic_name`, `dose_morning`/`dose_afternoon`/`dose_evening`/`dose_night` (`numeric(5, 2)`), `periodicity`, `is_sos boolean DEFAULT false NOT NULL`, `duration_value integer`, `duration_unit text`.

The `vitals` type change produces no SQL. If drizzle-kit asks whether a column was renamed, answer **no** (create). If the file drops, alters, or recreates any existing column, table, or constraint (in particular the hand-edited `SET NULL (col)` keys of 0009 and 0010), stop and fix the schema edit. Adding columns with constant defaults does not fire the row triggers, so finalized rows are not touched.

- [ ] **Step 13: Create the custom security migration 0012**

```powershell
Set-Location E:\projects\clinicpad; npm run db:generate -- --custom --name=phase1b_catalogue_security
```

drizzle-kit creates an empty `drizzle/0012_phase1b_catalogue_security.sql`, a `drizzle/meta/0012_snapshot.json` identical to 0011's (as 0008's is to 0007's), and journal entry 12. Replace the contents of the SQL file with exactly:

```sql
-- Row-level security, privileges and closed vocabularies for the Plan 1B tables (custom migration).

-- 1. Tenant-owned catalogue tables: the same isolation policy as every other tenant table.
do $$
declare
  t text;
begin
  foreach t in array array['tenant_medicines', 'medicine_favourites']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I for all using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) with check (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
    execute format('grant select, insert, update, delete on %I to clinicpad_app', t);
  end loop;
end $$;

-- 2. Global reference tables: every clinic may read; only the migration/seed role may write.
--    Privileges are the hard barrier (the app role loses INSERT/UPDATE/DELETE/TRUNCATE);
--    forced RLS with a select-only policy for everyone else is defence in depth. The
--    write policy is bound to the role running this migration, which is also the role
--    behind ADMIN_DATABASE_URL in every environment.
do $$
declare
  t text;
begin
  foreach t in array array['global_medicines', 'global_clinical_terms']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy global_read on %I for select using (true)', t);
    execute format('create policy global_owner_write on %I for all to current_user using (true) with check (true)', t);
    execute format('revoke insert, update, delete, truncate on %I from clinicpad_app', t);
    execute format('grant select on %I to clinicpad_app', t);
  end loop;
end $$;

-- 3. Closed vocabularies enforced at the database as well as in Zod.
alter table global_clinical_terms
  add constraint global_terms_kind_check check (kind in ('complaint', 'diagnosis', 'history', 'test'));
alter table prescription_items
  add constraint rx_items_duration_unit_check check (duration_unit is null or duration_unit in ('days', 'weeks', 'months'));
alter table medicine_favourites
  add constraint favourites_duration_unit_check check (duration_unit is null or duration_unit in ('days', 'weeks', 'months'));
```

- [ ] **Step 14: Apply the migrations and run the tests**

```powershell
Set-Location E:\projects\clinicpad; npm run db:migrate
npm run test -- tests/integration/clinical-schema.test.ts tests/integration/clinical-references.test.ts tests/integration/tenant-fk.test.ts tests/integration/immutability.test.ts tests/integration/rls.test.ts
```

Expected: `0011_phase1b_clinical` and `0012_phase1b_catalogue_security` apply; all five files PASS (the tenant-FK guard sees only composite keys into tenant-owned tables). If the "read-only" test gets `23505` or succeeds instead of `42501`, the `revoke` did not run: re-check that `0012_phase1b_catalogue_security` was applied (`drizzle/meta/_journal.json` lists it after `0011_phase1b_clinical`).

- [ ] **Step 15: Whole suite, typecheck, commit Part B**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/server/db/schema/clinical.ts src/server/db/schema/catalogue.ts src/server/db/schema/index.ts drizzle/0011_phase1b_clinical.sql drizzle/0012_phase1b_catalogue_security.sql drizzle/meta/0011_snapshot.json drizzle/meta/0012_snapshot.json drizzle/meta/_journal.json tests/integration/clinical-schema.test.ts
git commit -m "feat: add clinical visit and item columns and the medicine catalogue tables" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

(Until Task 3 changes the service, `npm run typecheck` stays green: the old `itemValues`/`visits` updates in `prescriptions.ts` still compile against the wider tables.)

---

## Task 3: Clinical draft validation, read/write mapping, and draft revisions

**Files:**
- Modify: `src/server/validation/text.ts` (append), `src/server/validation/prescription.ts` (full replacement), `src/server/services/prescriptions.ts` (types, `getPrescription`, `saveDraft`)
- Create: `src/server/services/rx-mapping.ts`
- Test: `tests/integration/prescriptions-clinical.test.ts`

**Interfaces:**
- Consumes: Task 1 (`cleanText`, `durationToDays`, `RX_LIMITS`, code lists), Task 2 columns; Plan 1A `startPrescription(ctx, { patientId })`, `finalizePrescription(ctx, id)`, `createPatient(ctx, raw)` (`value.id`), `Result`/`ok`/`fail`/`invalidFrom`/`Ok`/`ServiceError` (`@/lib/result`), `withTenant`, `pgErrorInfo`, the private `invalidFromDatabase` and `prescriptionNotFound` in `prescriptions.ts`, `hasNoNul`/`NUL_MESSAGE`/`blankToUndefined` (`src/server/validation/text.ts`), `amendReasonSchema` and the follow-up date bounds (`src/server/validation/prescription.ts`), `createTestTenant(label)`.
- Produces:
  - In `src/server/validation/text.ts`: `cleanInput(value: unknown): unknown`, `cleanOptionalText(max: number)`, `cleanRequiredText(max: number, message: string)` (Zod schemas; NUL refused, everything else cleaned).
  - `prescriptionItemSchema` (output `DraftItemInput` has `durationValue: number | null`, `durationUnit: DurationUnit | null`, `durationDays: number | null`, `doseMorning..doseNight: number | null`, `isSos: boolean`, optional text fields), `vitalsSchema` (output `Vitals`), `investigationSchema`, `draftInputSchema`, `amendReasonSchema` (unchanged), `type DraftInput`, `type DraftItemInput`. Plan 1A input shapes (`durationDays`, free-text `timing`) stay valid.
  - `src/server/services/rx-mapping.ts`: `type ItemRow`, `type VisitRow`, `type ItemView`, `type ClinicalVisitView`, `omit(obj, keys)`, `toItemView(row)`, `toVisitView(row)`, `visitColumns(input: DraftInput)`, `itemValues(ctx, prescriptionId, items: DraftItemInput[])`.
  - `PrescriptionView` gains `revision: number` and `visit: ClinicalVisitView`, keeps `patient: { id, name, patientNo, allergies: string[] }`; `ItemView` gains the new item fields (both re-exported from `prescriptions.ts`). Neither carries item ids: `saveDraft` deletes and re-inserts the items, so ids are not stable across saves and nothing in this plan relies on them (the editor keys rows on client-side keys, Task 8).
  - `saveDraft(ctx, id, raw, opts?: { baseRevision?: number }): Promise<SaveDraftResult>` where `type SaveDraftResult = Ok<{ savedAt: Date; revision: number }> | ServiceError | DraftConflict` and `type DraftConflict = ServiceError & { code: "conflict"; currentRevision: number }`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/prescriptions-clinical.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPatient } from "@/server/services/patients";
import {
  finalizePrescription,
  getPrescription,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";
const doctor = () => A.as("doctor");

const fullDraft = () => ({
  visitType: "follow-up",
  chiefComplaint: "Fever for 3 days",
  complaints: ["Fever", "Body ache"],
  diagnosis: ["Viral fever"],
  medicalHistory: ["DM", "HT"],
  drugHistory: ["Metformin 500"],
  examinationNotes: "Throat congested. Chest clear.",
  vitals: {
    bpSystolic: 130,
    bpDiastolic: 85,
    pulse: 92,
    temperatureF: 100.4,
    spo2: 97,
    respiratoryRate: 18,
    weightKg: 72.5,
    heightCm: 170,
    bloodSugarMgDl: 140,
    notes: "RBS",
  },
  investigations: [{ name: "CBC", instructions: "Fasting not needed" }, { name: "Dengue NS1" }],
  advice: "Plenty of fluids",
  followUpDate: "2026-12-01",
  followUpReason: "Review CBC report",
  items: [
    {
      drugName: "DOLO 650MG",
      genericName: "Paracetamol 650Mg",
      strength: "650 mg",
      dose: "1 tab",
      doseMorning: 1,
      doseAfternoon: 0,
      doseEvening: null,
      doseNight: 1,
      foodRelation: "after",
      periodicity: "daily",
      isSos: false,
      durationValue: 5,
      durationUnit: "days",
      remarks: "If fever above 100",
    },
    { drugName: "Cetirizine", doseNight: 0.5, isSos: true, durationValue: 2, durationUnit: "weeks" },
  ],
});

beforeAll(async () => {
  A = await createTestTenant("clina");
  B = await createTestTenant("clinb");
  const p = await createPatient(A.as("reception"), { name: "Clinical Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

async function start(): Promise<string> {
  const r = await startPrescription(doctor(), { patientId });
  if (!r.ok) throw new Error(r.message);
  return r.value.prescriptionId;
}

async function read(id: string) {
  const got = await getPrescription(doctor(), id);
  if (!got.ok) throw new Error(got.message);
  return got.value;
}

describe("saveDraft with the clinical form", () => {
  it("stores and returns every clinical field", async () => {
    const id = await start();
    expect(await saveDraft(doctor(), id, fullDraft())).toMatchObject({ ok: true, value: { revision: 1 } });

    const got = await getPrescription(A.as("nurse"), id); // nurses can read
    if (!got.ok) throw new Error(got.message);
    const rx = got.value;
    expect(rx.revision).toBe(1);
    expect(rx.visit).toMatchObject({
      visitType: "follow-up",
      chiefComplaint: "Fever for 3 days",
      complaints: ["Fever", "Body ache"],
      diagnosis: ["Viral fever"],
      medicalHistory: ["DM", "HT"],
      drugHistory: ["Metformin 500"],
      examinationNotes: "Throat congested. Chest clear.",
      investigations: [{ name: "CBC", instructions: "Fasting not needed" }, { name: "Dengue NS1" }],
      advice: "Plenty of fluids",
      followUpDate: "2026-12-01",
      followUpReason: "Review CBC report",
    });
    expect(rx.visit.vitals).toEqual(fullDraft().vitals);
    expect(rx.items[0]).toEqual({
      drugName: "DOLO 650MG",
      genericName: "Paracetamol 650Mg",
      strength: "650 mg",
      form: null,
      route: null,
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
      remarks: "If fever above 100",
    });
    expect(rx.items[1]).toMatchObject({ doseNight: 0.5, isSos: true, durationValue: 2, durationUnit: "weeks", durationDays: 14 });
  });

  it("still accepts the Plan 1A item shape and reads it as a duration in days", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { items: [{ drugName: "Paracetamol", timing: "TDS", durationDays: 3 }] });
    expect((await read(id)).items[0]).toMatchObject({
      timing: "TDS",
      durationValue: 3,
      durationUnit: "days",
      durationDays: 3,
      isSos: false,
    });
  });

  it("drops repeated phrases ignoring case and keeps the first spelling", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { complaints: ["Fever", "fever", " FEVER ", "Cough"], investigations: [{ name: "CBC" }, { name: "cbc" }] });
    const rx = await read(id);
    expect(rx.visit.complaints).toEqual(["Fever", "Cough"]);
    expect(rx.visit.investigations).toEqual([{ name: "CBC" }]);
  });

  it("stores hostile-looking text verbatim as plain text, minus stray control characters", async () => {
    const id = await start();
    const BELL = "\u0007"; // a stray control character from a paste, written as an escape
    expect([...BELL]).toHaveLength(1);
    await saveDraft(doctor(), id, {
      chiefComplaint: "<script>alert(1)</script>",
      advice: `line1\r\nline2${BELL}`,
      complaints: ["आशा को बुखार"],
      items: [{ drugName: '<img src=x onerror="alert(1)">' }],
    });
    const rx = await read(id);
    expect(rx.visit.chiefComplaint).toBe("<script>alert(1)</script>");
    expect(rx.visit.advice).toBe("line1\nline2");
    expect(rx.visit.complaints).toEqual(["आशा को बुखार"]);
    expect(rx.items[0].drugName).toBe('<img src=x onerror="alert(1)">');
  });

  it("drops blank phrase entries instead of rejecting the whole save", async () => {
    const id = await start();
    const saved = await saveDraft(doctor(), id, {
      diagnosis: ["", "   ", "\u0007", "Viral fever"],
      complaints: [" "],
      drugHistory: ["\t"],
    });
    expect(saved.ok).toBe(true);
    const rx = await read(id);
    expect(rx.visit.diagnosis).toEqual(["Viral fever"]);
    expect(rx.visit.complaints).toEqual([]);
    expect(rx.visit.drugHistory).toEqual([]);
  });

  describe("a NUL character in the new free-text fields", () => {
    // Written as an escape so the file holds no invisible character; the first test proves it is one code point.
    const NUL = "\u0000";
    const bad = `bad${NUL}text`;

    it("is a single code point", () => {
      expect([...NUL]).toHaveLength(1);
      expect(NUL.codePointAt(0)).toBe(0);
    });

    it.each([
      ["a complaint", "complaints", { complaints: ["Fine", bad] }],
      ["a lone NUL complaint", "complaints", { complaints: [NUL] }],
      ["medical history", "medicalHistory", { medicalHistory: [bad] }],
      ["examination notes", "examinationNotes", { examinationNotes: bad }],
      ["vitals notes", "vitals", { vitals: { notes: bad } }],
      ["a test name", "investigations", { investigations: [{ name: bad }] }],
      ["test instructions", "investigations", { investigations: [{ name: "CBC", instructions: bad }] }],
      ["the follow-up reason", "followUpReason", { followUpReason: bad }],
      ["a generic name", "items", { items: [{ drugName: "X", genericName: bad }] }],
    ])("is refused in %s as invalid, never silently stripped", async (_name, field, input) => {
      const id = await start();
      expect((await saveDraft(doctor(), id, { advice: "Before" })).ok).toBe(true);
      expect(await saveDraft(doctor(), id, input)).toMatchObject({ ok: false, code: "invalid", field });
      expect((await read(id)).visit.advice).toBe("Before");
    });
  });

  it("ignores unknown vitals keys and treats a blank vitals form as no vitals", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { vitals: { pulse: 80, evil: "<b>x</b>" } });
    expect((await read(id)).visit.vitals).toEqual({ pulse: 80 });
    await saveDraft(doctor(), id, { vitals: { pulse: "", notes: "  " } });
    expect((await read(id)).visit.vitals).toEqual({});
  });

  it.each([
    [{ advice: "x".repeat(2001) }, "advice"],
    [{ examinationNotes: "x".repeat(2001) }, "examinationNotes"],
    [{ complaints: Array.from({ length: 31 }, (_, i) => `C${i}`) }, "complaints"],
    [{ complaints: ["x".repeat(201)] }, "complaints"],
    [{ diagnosis: Array.from({ length: 21 }, (_, i) => `D${i}`) }, "diagnosis"],
    [{ vitals: { pulse: 720 } }, "vitals"],
    [{ vitals: { pulse: "abc" } }, "vitals"],
    [{ vitals: { pulse: 72.5 } }, "vitals"],
    [{ vitals: { bpSystolic: 120 } }, "vitals"],
    [{ vitals: { bpSystolic: 80, bpDiastolic: 120 } }, "vitals"],
    [{ vitals: { temperatureF: 37.5 } }, "vitals"],
    [{ investigations: [{ name: "" }] }, "investigations"],
    [{ investigations: Array.from({ length: 31 }, (_, i) => ({ name: `T${i}` })) }, "investigations"],
    [{ items: [{ drugName: "X", doseMorning: 0.3 }] }, "items"],
    [{ items: [{ drugName: "X", doseMorning: -1 }] }, "items"],
    [{ items: [{ drugName: "X", doseMorning: "one" }] }, "items"],
    [{ items: [{ drugName: "X", foodRelation: "sometimes" }] }, "items"],
    [{ items: [{ drugName: "X", periodicity: "hourly" }] }, "items"],
    [{ items: [{ drugName: "X", durationValue: 13, durationUnit: "months" }] }, "items"],
    [{ items: [{ drugName: "X", durationValue: 2.5 }] }, "items"],
    [{ items: [{ drugName: "X", durationValue: 1, durationUnit: "years" }] }, "items"],
    [{ items: [{ drugName: "X", isSos: "yes" }] }, "items"],
    [{ items: [{ drugName: "X", genericName: "g".repeat(301) }] }, "items"],
    [{ followUpReason: "y".repeat(301) }, "followUpReason"],
  ])("rejects %j", async (input, field) => {
    const id = await start();
    expect(await saveDraft(doctor(), id, input)).toMatchObject({ ok: false, code: "invalid", field });
  });

  it.each(["reception", "nurse", "pharmacist", "accountant"])("forbids %s from editing clinical fields", async (role) => {
    const id = await start();
    expect(await saveDraft(A.as(role), id, fullDraft())).toMatchObject({ ok: false, code: "forbidden" });
    expect((await read(id)).revision).toBe(0);
  });

  it("does not reveal another clinic's draft", async () => {
    const id = await start();
    expect(await saveDraft(B.as("doctor"), id, fullDraft())).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("draft revisions", () => {
  it("increments on every save and is returned by getPrescription", async () => {
    const id = await start();
    expect((await read(id)).revision).toBe(0);
    expect(await saveDraft(doctor(), id, { advice: "one" }, { baseRevision: 0 })).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(await saveDraft(doctor(), id, { advice: "two" }, { baseRevision: 1 })).toMatchObject({ ok: true, value: { revision: 2 } });
    expect((await read(id)).revision).toBe(2);
  });

  it("rejects a stale base revision with the current revision and leaves the draft untouched", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { advice: "Newer advice" }, { baseRevision: 0 });
    const stale = await saveDraft(doctor(), id, { advice: "Older advice" }, { baseRevision: 0 });
    expect(stale).toMatchObject({ ok: false, code: "conflict", currentRevision: 1 });
    const rx = await read(id);
    expect(rx.visit.advice).toBe("Newer advice");
    expect(rx.revision).toBe(1);
  });

  it("lets exactly one of two simultaneous saves from the same revision win, with no mixed content", async () => {
    const id = await start();
    const payloads = [
      { advice: "Window one", items: [{ drugName: "One A" }, { drugName: "One B" }] },
      { advice: "Window two", items: [{ drugName: "Two A" }] },
    ];
    const results = await Promise.all(payloads.map((p) => saveDraft(doctor(), id, p, { baseRevision: 0 })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: "conflict", currentRevision: 1 });

    const winner = payloads[results.findIndex((r) => r.ok)];
    const rx = await read(id);
    expect(rx.visit.advice).toBe(winner.advice);
    expect(rx.items.map((i) => i.drugName)).toEqual(winner.items.map((i) => i.drugName));
  });

  it("still accepts saves without a base revision (Plan 1A callers: last write wins)", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { advice: "a" }, { baseRevision: 0 });
    expect(await saveDraft(doctor(), id, { advice: "b" })).toMatchObject({ ok: true, value: { revision: 2 } });
  });

  it.each([-1, 1.5, Number.NaN])("rejects a malformed base revision %s", async (baseRevision) => {
    const id = await start();
    expect(await saveDraft(doctor(), id, { advice: "x" }, { baseRevision })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "baseRevision",
    });
  });

  it("reports immutable, not conflict, once the prescription is finalized", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { items: [{ drugName: "Paracetamol" }] }, { baseRevision: 0 });
    expect((await finalizePrescription(doctor(), id)).ok).toBe(true);
    expect(await saveDraft(doctor(), id, { advice: "late" }, { baseRevision: 1 })).toMatchObject({
      ok: false,
      code: "immutable",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/prescriptions-clinical.test.ts
```

Expected: FAIL — `revision` is undefined on the view, the new fields are not stored, `currentRevision` is missing.

- [ ] **Step 3: Add the cleaned-text helpers to the shared validation module**

Append to `src/server/validation/text.ts` (keep its existing exports; `optionalText` stays as it is for the patient schema), and add `import { cleanText } from "@/lib/domain/text";` below its `zod` import:

```ts
/**
 * Plan 1B text cleaning before validation: NFC, CR/CRLF to LF, stray control characters removed
 * (cleanText). A string that contains a NUL is passed through untouched so `hasNoNul` refuses it:
 * a NUL is reported to the user, never silently removed.
 */
export const cleanInput = (value: unknown) =>
  typeof value === "string" && hasNoNul(value) ? cleanText(value) : value;

/** Cleaned, trimmed, length-limited text without NUL; blank (after cleaning) means absent. */
export const cleanOptionalText = (max: number) =>
  z.preprocess(
    (value) => blankToUndefined(cleanInput(value)),
    z.string().trim().max(max, `Keep this under ${max} characters`).refine(hasNoNul, NUL_MESSAGE).optional(),
  );

/** Cleaned, trimmed, length-limited, non-empty text without NUL. */
export const cleanRequiredText = (max: number, message: string) =>
  z.preprocess(
    cleanInput,
    z.string().trim().min(1, message).max(max, `Keep this under ${max} characters`).refine(hasNoNul, NUL_MESSAGE),
  );
```

- [ ] **Step 4: Replace the validation schema**

Replace the whole content of `src/server/validation/prescription.ts` with (the follow-up date bounds and `amendReasonSchema` are kept exactly as the review fix wave wrote them):

```ts
import { z } from "zod";
import {
  DURATION_UNITS,
  FOOD_RELATIONS,
  PERIODICITIES,
  RX_LIMITS,
  type Vitals,
} from "@/lib/domain/rx-options";
import { durationToDays } from "@/lib/domain/rx-format";
import { cleanText } from "@/lib/domain/text";
import {
  blankToUndefined,
  cleanInput,
  cleanOptionalText,
  cleanRequiredText,
  hasNoNul,
  NUL_MESSAGE,
} from "./text";

// Every string is cleaned (NFC, CR/CRLF to LF, stray control characters removed) before any rule
// runs; a NUL is refused with NUL_MESSAGE instead (see cleanInput).
const optionalText = cleanOptionalText;
const requiredText = cleanRequiredText;
/** For closed lists (enums): cleaned, blank means absent. */
const cleanBlank = (value: unknown) => blankToUndefined(cleanInput(value));

const emptyToNull = (value: unknown) => (value === "" || value === undefined ? null : value);
const emptyToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);
const missingToEmptyList = (value: unknown) => (value === undefined || value === null ? [] : value);

/**
 * Blank phrase entries carry no content, so they are dropped: one empty chip must never reject a
 * whole autosave. An entry that contains a NUL is kept, so the NUL rule reports it.
 */
const dropBlankEntries = (value: unknown) => {
  const list = missingToEmptyList(value);
  if (!Array.isArray(list)) return list;
  return list.filter((entry) => !(typeof entry === "string" && hasNoNul(entry) && cleanText(entry).trim() === ""));
};

/** Short phrases (complaints, history...). Blanks and repeats (ignoring case) are dropped; order is kept. */
const phraseList = (maxItems: number, label: string) =>
  z
    .preprocess(
      dropBlankEntries,
      z.array(requiredText(200, `Remove the empty ${label} entry`)).max(maxItems, `At most ${maxItems} ${label}`),
    )
    .transform((list) => list.filter((v, i) => list.findIndex((w) => w.toLowerCase() === v.toLowerCase()) === i));

// Follow-up dates are bounded so that year 0000 (valid in JavaScript, rejected by Postgres) and
// absurd years never reach the database.
const EARLIEST_FOLLOW_UP = "1900-01-01";
const LATEST_FOLLOW_UP = "2100-12-31";

/** A real calendar date from 1900-01-01 to 2100-12-31, as YYYY-MM-DD. */
const followUpDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Enter a real date")
  .refine((v) => v >= EARLIEST_FOLLOW_UP, "Follow-up date cannot be before 1900-01-01")
  .refine((v) => v <= LATEST_FOLLOW_UP, "Follow-up date cannot be after 2100-12-31");

/** A quarter-step dose for one slot of the day. */
const doseQty = z.preprocess(
  emptyToNull,
  z
    .number()
    .min(0, "A dose cannot be negative")
    .max(99, "That dose is too large")
    .multipleOf(0.25, "Use quarter steps (¼, ½, ¾)")
    .nullable(),
);

const vital = (label: string, min: number, max: number, integer = true) =>
  z.preprocess(
    emptyToUndefined,
    (integer ? z.number().int(`${label} must be a whole number`) : z.number())
      .min(min, `${label} must be at least ${min}`)
      .max(max, `${label} must be at most ${max}`)
      .optional(),
  );

export const vitalsSchema = z
  .object({
    bpSystolic: vital("Systolic BP", 50, 260),
    bpDiastolic: vital("Diastolic BP", 30, 160),
    pulse: vital("Pulse", 20, 250),
    temperatureF: vital("Temperature (°F)", 90, 110, false),
    spo2: vital("SpO₂", 50, 100),
    respiratoryRate: vital("Respiratory rate", 5, 80),
    weightKg: vital("Weight (kg)", 0.3, 300, false),
    heightCm: vital("Height (cm)", 20, 250, false),
    bloodSugarMgDl: vital("Blood sugar", 10, 800),
    notes: optionalText(200),
  })
  .superRefine((v, ctx) => {
    const hasSystolic = typeof v.bpSystolic === "number";
    const hasDiastolic = typeof v.bpDiastolic === "number";
    if (hasSystolic !== hasDiastolic) {
      ctx.addIssue({ code: "custom", path: ["bpSystolic"], message: "Enter both systolic and diastolic BP" });
    } else if (hasSystolic && hasDiastolic && (v.bpSystolic as number) <= (v.bpDiastolic as number)) {
      ctx.addIssue({ code: "custom", path: ["bpSystolic"], message: "Systolic BP must be higher than diastolic BP" });
    }
  })
  // Unknown keys are already stripped by z.object; drop the unmeasured ones too.
  .transform((v): Vitals => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Vitals);

export const investigationSchema = z.object({
  name: requiredText(120, "Enter the test name"),
  instructions: optionalText(300),
});

export const prescriptionItemSchema = z
  .object({
    drugName: requiredText(200, "Enter the medicine name"),
    genericName: optionalText(300),
    strength: optionalText(60),
    form: optionalText(40),
    route: optionalText(40),
    dose: optionalText(60),
    doseMorning: doseQty,
    doseAfternoon: doseQty,
    doseEvening: doseQty,
    doseNight: doseQty,
    timing: optionalText(60),
    foodRelation: z.preprocess(
      cleanBlank,
      z.enum(FOOD_RELATIONS, { error: "Choose a food instruction from the list" }).optional(),
    ),
    periodicity: z.preprocess(
      cleanBlank,
      z.enum(PERIODICITIES, { error: "Choose how often from the list" }).optional(),
    ),
    isSos: z.boolean().default(false),
    durationValue: z.preprocess(
      emptyToNull,
      z
        .number()
        .int("Duration must be a whole number")
        .min(1, "Duration must be at least 1")
        .max(365, "Duration is too long")
        .nullable(),
    ),
    durationUnit: z.preprocess(cleanBlank, z.enum(DURATION_UNITS, { error: "Use days, weeks, or months" }).default("days")),
    /** Plan 1A input shape (a number of days). Used only when durationValue is absent. */
    durationDays: z
      .number()
      .int()
      .min(1, "Duration must be at least 1 day")
      .max(365, "Duration cannot exceed 365 days")
      .nullish(),
    remarks: optionalText(300),
  })
  .superRefine((item, ctx) => {
    if (typeof item.durationValue === "number" && durationToDays(item.durationValue, item.durationUnit) > 365) {
      ctx.addIssue({ code: "custom", path: ["durationValue"], message: "Duration cannot exceed one year" });
    }
  })
  .transform((item) => {
    const value = item.durationValue ?? item.durationDays ?? null;
    const unit = item.durationValue !== null ? item.durationUnit : "days";
    return {
      ...item,
      durationValue: value,
      durationUnit: value === null ? null : unit,
      // Derived total days, kept for quantity and refill calculations.
      durationDays: value === null ? null : durationToDays(value, unit),
    };
  });

export const draftInputSchema = z.object({
  visitType: z.enum(["new", "follow-up"]).default("new"),
  chiefComplaint: optionalText(500),
  complaints: phraseList(RX_LIMITS.phrases, "complaints"),
  diagnosis: phraseList(RX_LIMITS.diagnoses, "diagnoses"),
  medicalHistory: phraseList(RX_LIMITS.phrases, "history entries"),
  drugHistory: phraseList(RX_LIMITS.phrases, "drug history entries"),
  examinationNotes: optionalText(2000),
  vitals: z.preprocess((value) => (value === undefined || value === null ? {} : value), vitalsSchema),
  investigations: z
    .preprocess(
      missingToEmptyList,
      z.array(investigationSchema).max(RX_LIMITS.investigations, `At most ${RX_LIMITS.investigations} tests`),
    )
    .transform((list) =>
      list.filter((t, i) => list.findIndex((u) => u.name.toLowerCase() === t.name.toLowerCase()) === i),
    ),
  advice: optionalText(2000),
  followUpDate: z.preprocess(blankToUndefined, followUpDate.optional()),
  followUpReason: optionalText(300),
  items: z
    .array(prescriptionItemSchema)
    .max(RX_LIMITS.medicines, `A prescription can have at most ${RX_LIMITS.medicines} medicines`)
    .default([]),
});

/** Why a finalized prescription is being amended. Stored on the new version, so it is free text. */
export const amendReasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters")
  .max(500, "Keep the reason under 500 characters")
  .refine(hasNoNul, NUL_MESSAGE);

export type DraftInput = z.output<typeof draftInputSchema>;
export type DraftItemInput = z.output<typeof prescriptionItemSchema>;
```

Notes:
- `invalidFrom` (Plan 1A) reports only the first path segment, so an item error is reported as `field: "items"` and a vitals error as `field: "vitals"`; the message names the exact sub-field ("Pulse must be at most 250").
- Every Plan 1A expectation in `tests/integration/prescriptions-draft.test.ts` still holds: a NUL in any item field, the chief complaint, a diagnosis entry, or the advice is `invalid` with the same `field`; `foodRelation` is now a closed list, so `bad<NUL>text` there is refused by the enum instead (still `invalid`, field `items`); the follow-up date bounds are unchanged.

- [ ] **Step 5: Create the mapping module**

`src/server/services/rx-mapping.ts`:

```ts
import { prescriptionItems, visits } from "@/server/db/schema";
import type { Investigation, Vitals } from "@/lib/domain/rx-options";
import type { DraftInput, DraftItemInput } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";

export type ItemRow = typeof prescriptionItems.$inferSelect;
export type VisitRow = typeof visits.$inferSelect;

export type ItemView = {
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

export type ClinicalVisitView = {
  id: string;
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

/** Copy of `obj` without `keys`. Row copies use it so columns added later are copied too. */
export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const drop = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !drop.has(key))) as Omit<T, K>;
}

export function toItemView(row: ItemRow): ItemView {
  // Rows written before Plan 1B have only duration_days: read them as a number of days.
  const legacy = row.durationValue === null && row.durationDays !== null;
  return {
    drugName: row.drugName,
    genericName: row.genericName,
    strength: row.strength,
    form: row.form,
    route: row.route,
    dose: row.dose,
    doseMorning: row.doseMorning,
    doseAfternoon: row.doseAfternoon,
    doseEvening: row.doseEvening,
    doseNight: row.doseNight,
    timing: row.timing,
    foodRelation: row.foodRelation,
    periodicity: row.periodicity,
    isSos: row.isSos,
    durationValue: legacy ? row.durationDays : row.durationValue,
    durationUnit: legacy ? "days" : row.durationUnit,
    durationDays: row.durationDays,
    remarks: row.remarks,
  };
}

export function toVisitView(row: VisitRow): ClinicalVisitView {
  return {
    id: row.id,
    visitType: row.visitType,
    chiefComplaint: row.chiefComplaint,
    complaints: row.complaints ?? [],
    diagnosis: row.diagnosis ?? [],
    medicalHistory: row.medicalHistory ?? [],
    drugHistory: row.drugHistory ?? [],
    examinationNotes: row.examinationNotes,
    vitals: row.vitals ?? {},
    investigations: row.investigations ?? [],
    advice: row.advice,
    followUpDate: row.followUpDate,
    followUpReason: row.followUpReason,
  };
}

/**
 * The visit columns a draft save writes. The schema always fills the lists and `vitals`; the
 * fallbacks matter only to tests/integration/prescriptions-db-errors.test.ts, which replaces the
 * schema with a pass-through to prove the database-error mapping, and must not turn into a crash.
 */
export function visitColumns(input: DraftInput) {
  const vitals = input.vitals ?? {};
  return {
    visitType: input.visitType ?? "new",
    chiefComplaint: input.chiefComplaint ?? null,
    complaints: input.complaints ?? [],
    diagnosis: input.diagnosis ?? [],
    medicalHistory: input.medicalHistory ?? [],
    drugHistory: input.drugHistory ?? [],
    examinationNotes: input.examinationNotes ?? null,
    vitals: Object.keys(vitals).length > 0 ? vitals : null,
    investigations: input.investigations ?? [],
    advice: input.advice ?? null,
    followUpDate: input.followUpDate ?? null,
    followUpReason: input.followUpReason ?? null,
  };
}

/** Item rows for a draft save, in the order the doctor wrote them. */
export function itemValues(ctx: ServiceContext, prescriptionId: string, items: DraftItemInput[]) {
  return items.map((item, index) => ({
    tenantId: ctx.tenantId,
    prescriptionId,
    sortOrder: index,
    drugName: item.drugName,
    genericName: item.genericName ?? null,
    strength: item.strength ?? null,
    form: item.form ?? null,
    route: item.route ?? null,
    dose: item.dose ?? null,
    doseMorning: item.doseMorning ?? null,
    doseAfternoon: item.doseAfternoon ?? null,
    doseEvening: item.doseEvening ?? null,
    doseNight: item.doseNight ?? null,
    timing: item.timing ?? null,
    foodRelation: item.foodRelation ?? null,
    periodicity: item.periodicity ?? null,
    isSos: item.isSos ?? false,
    durationValue: item.durationValue ?? null,
    durationUnit: item.durationUnit ?? null,
    durationDays: item.durationDays ?? null,
    remarks: item.remarks ?? null,
  }));
}
```

- [ ] **Step 6: Update the prescription service (types, read, save)**

In `src/server/services/prescriptions.ts`:

1. Change the `@/lib/result` import to also bring in `Ok` (it already imports `ServiceError`), drop `type DraftItemInput` from the validation import (keep `amendReasonSchema` and `draftInputSchema`), and import the mapping module; keep every other import (`pgErrorInfo` included):

```ts
import { fail, invalidFrom, ok, type Ok, type Result, type ServiceError } from "@/lib/result";
import { amendReasonSchema, draftInputSchema } from "@/server/validation/prescription";
import {
  itemValues,
  toItemView,
  toVisitView,
  visitColumns,
  type ClinicalVisitView,
  type ItemView,
} from "./rx-mapping";
```

2. Delete the existing `export type ItemView = { ... };` block and put this in its place:

```ts
export type { ClinicalVisitView, ItemView } from "./rx-mapping";
```

3. Replace the whole `export type PrescriptionView = { ... };` block with:

```ts
export type PrescriptionView = {
  id: string;
  status: string;
  version: number;
  /** Draft save counter; send it back as `baseRevision`. */
  revision: number;
  rxNo: number | null;
  amendmentReason: string | null;
  parentPrescriptionId: string | null;
  finalizedAt: Date | null;
  /** Read live from the patient row (Plan 1C snapshots it at finalize); allergies are [] when none. */
  patient: { id: string; name: string; patientNo: number | null; allergies: string[] };
  visit: ClinicalVisitView;
  items: ItemView[];
};

/** A save based on an older revision than the one stored. */
export type DraftConflict = ServiceError & { code: "conflict"; currentRevision: number };
export type SaveDraftResult = Ok<{ savedAt: Date; revision: number }> | ServiceError | DraftConflict;
```

4. Replace the whole `getPrescription` function with:

```ts
export async function getPrescription(ctx: ServiceContext, id: string): Promise<Result<PrescriptionView>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        rx: prescriptions,
        visit: visits,
        patient: { id: patients.id, name: patients.name, patientNo: patients.patientNo, allergies: patients.allergies },
      })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .innerJoin(patients, eq(patients.id, visits.patientId))
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!row) return prescriptionNotFound();

    const items = await tx
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, id))
      .orderBy(asc(prescriptionItems.sortOrder));

    return ok<PrescriptionView>({
      id: row.rx.id,
      status: row.rx.status,
      version: row.rx.version,
      revision: row.rx.draftRevision,
      rxNo: row.rx.rxNo,
      amendmentReason: row.rx.amendmentReason,
      parentPrescriptionId: row.rx.parentPrescriptionId,
      finalizedAt: row.rx.finalizedAt,
      patient: { ...row.patient, allergies: row.patient.allergies ?? [] },
      visit: toVisitView(row.visit),
      items: items.map(toItemView),
    });
  });
}
```

5. Delete the existing private `function itemValues(...)` (it now lives in `rx-mapping.ts`), then replace the whole `saveDraft` function with (the `catch` keeps the fix wave's `23000` and `invalidFromDatabase` mapping unchanged):

```ts
/**
 * Saves a full draft snapshot. With `baseRevision` the save succeeds only if the stored
 * draft is still at that revision; otherwise it returns `conflict` with the current
 * revision and changes nothing. The row lock serializes concurrent saves, so of two saves
 * from the same revision exactly one wins and items are never mixed.
 */
export async function saveDraft(
  ctx: ServiceContext,
  id: string,
  raw: unknown,
  opts: { baseRevision?: number } = {},
): Promise<SaveDraftResult> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can edit prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();
  const { baseRevision } = opts;
  if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
    return fail("invalid", "The draft revision is not valid. Reload the page.", "baseRevision");
  }
  const parsed = draftInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<SaveDraftResult> => {
      const [rx] = await tx
        .select({
          id: prescriptions.id,
          status: prescriptions.status,
          visitId: prescriptions.visitId,
          draftRevision: prescriptions.draftRevision,
        })
        .from(prescriptions)
        .where(eq(prescriptions.id, id))
        .limit(1)
        .for("update");
      if (!rx) return prescriptionNotFound();
      if (rx.status !== "draft") {
        return fail("immutable", "This prescription is finalized. Amend it to make changes.");
      }
      if (baseRevision !== undefined && baseRevision !== rx.draftRevision) {
        return {
          ok: false,
          code: "conflict",
          message: "This draft was changed in another window or device.",
          currentRevision: rx.draftRevision,
        };
      }

      // Lock order: the prescription row above, then its visit and items (ADR-0023).
      await tx.update(visits).set(visitColumns(input)).where(eq(visits.id, rx.visitId));
      await tx.delete(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id));
      const items = input.items ?? [];
      if (items.length > 0) {
        await tx.insert(prescriptionItems).values(itemValues(ctx, id, items));
      }
      const [saved] = await tx
        .update(prescriptions)
        .set({ draftRevision: rx.draftRevision + 1, updatedAt: new Date() })
        .where(eq(prescriptions.id, id))
        .returning({ updatedAt: prescriptions.updatedAt, revision: prescriptions.draftRevision });
      return ok({ savedAt: saved.updatedAt, revision: saved.revision });
    });
  } catch (error) {
    // The database refuses changes to finalized records (SQLSTATE 23000); report it as immutable.
    if (pgErrorInfo(error).code === "23000") {
      return fail("immutable", "This prescription is finalized. Amend it to make changes.");
    }
    // The transaction has rolled back, so nothing was written.
    const invalid = invalidFromDatabase(error, { date: "followUpDate" });
    if (invalid) return invalid;
    throw error;
  }
}
```

The existing `saveDraftAction` and `DraftEditor` keep compiling unchanged until Task 10 removes them: `saved.value.savedAt` still exists, and `DraftConflict` is a `ServiceError`, so `saved.field` still type-checks. `src/components/rx/read-only-view.tsx` and the page still compile because `PrescriptionView` only gained fields.

- [ ] **Step 7: Run the new and the Plan 1A prescription tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/prescriptions-clinical.test.ts tests/integration/prescriptions-draft.test.ts tests/integration/prescriptions-lifecycle.test.ts tests/integration/prescriptions-db-errors.test.ts
npm run typecheck
```

Expected: all PASS; typecheck exits 0. Plan 1A's tests must pass unmodified: its `durationDays` inputs, `field: "items"` expectations, the NUL and follow-up date tables in `prescriptions-draft.test.ts`, the allergies test, and every case in `prescriptions-db-errors.test.ts` (which bypasses the schema, so `visitColumns`/`itemValues` must not crash on missing fields). If the simultaneous-save test sees two winners, the `for("update")` lock is missing or the revision check runs before the lock.

- [ ] **Step 8: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/server/validation/text.ts src/server/validation/prescription.ts src/server/services/rx-mapping.ts src/server/services/prescriptions.ts tests/integration/prescriptions-clinical.test.ts
git commit -m "feat: store the full clinical form on drafts with revision-checked saves" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 4: Finalize the revision the doctor saw; amend and repeat copy the whole clinical record

**Files:**
- Modify: `src/server/services/rx-mapping.ts` (append), `src/server/services/prescriptions.ts` (`finalizePrescription`, `amendPrescription`, `repeatPrescription`; remove Plan 1A's `copyItems`)
- Test: `tests/integration/prescriptions-clinical-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 3 (`saveDraft`, `getPrescription`, `omit`, `VisitRow`, `ClinicalVisitView`); the existing `finalizePrescription`, `amendPrescription`, `repeatPrescription` in `src/server/services/prescriptions.ts` and its private helpers `doctorIdFor(tx, userId)`, `invalidFromDatabase(error, fields)`, `IMMUTABLE_MESSAGE`, `AMENDMENT_IN_PROGRESS`, `OPEN_AMENDMENT_INDEX`, `prescriptionNotFound`, `patientNotFound`; `amendReasonSchema`; `allocateNumber(tx, tenantId, "rx")`; `recordAudit(tx, ctx, event)`; `TenantTx`.
- Produces:
  - `finalizePrescription(ctx, id, opts?: { expectedRevision?: number }): Promise<Result<{ rxNo: number; version: number }>>` — `conflict` when the stored revision differs from `expectedRevision`; everything else as today (first version vs amendment decided by `parentPrescriptionId`, an amendment without `rxNo` refused with `conflict`, no number burned on any failure).
  - In `rx-mapping.ts`: `copyItems(tx: TenantTx, ctx: ServiceContext, fromPrescriptionId: string, toPrescriptionId: string): Promise<void>` (copies every column but `id`/`created_at`, so later item columns are copied too), `amendVisitValues(old: VisitRow)`, `repeatVisitValues(old: VisitRow, doctorId: string | null)`, `clinicalSummary(visit: VisitRow, itemCount: number): ClinicalSummary` where `type ClinicalSummary = { itemCount: number; diagnosisCount: number; investigationCount: number; vitalsRecorded: string[]; filledFields: string[] }`.
  - Audit payloads: `prescription.finalized` → `after: { rxNo, version, ...ClinicalSummary }`; `prescription.amended` → `after: { rxNo, version, parentPrescriptionId, ...ClinicalSummary }`; `prescription.amendment_drafted` unchanged → `before: { version }`, `after: { version, parentPrescriptionId, reasonLength }`.
  - `amendPrescription` keeps its order: lock the parent, check for an open amendment, **return before any write** if one exists, write afterwards (ADR-0023's second lock order depends on it). `repeatPrescription` keeps refusing a draft and a superseded (`amended`) source with `conflict`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/prescriptions-clinical-lifecycle.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, tenantCounters } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import {
  amendPrescription,
  finalizePrescription,
  getPrescription,
  repeatPrescription,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let patientId = "";
const doctor = () => A.as("doctor");
const secret = `SECRET${Date.now()}`;

const clinicalDraft = () => ({
  visitType: "new",
  chiefComplaint: `${secret}-chief`,
  complaints: [`${secret}-complaint`, "Cough"],
  diagnosis: ["Viral fever"],
  medicalHistory: [`${secret}-history`],
  drugHistory: ["Metformin"],
  examinationNotes: `${secret}-exam`,
  vitals: { pulse: 96, spo2: 98, bpSystolic: 128, bpDiastolic: 84, notes: `${secret}-vitals` },
  investigations: [{ name: "CBC", instructions: `${secret}-instructions` }, { name: "CRP" }],
  advice: `${secret}-advice`,
  followUpDate: "2026-12-10",
  followUpReason: `${secret}-reason`,
  items: [
    {
      drugName: "DOLO 650MG",
      genericName: "Paracetamol 650Mg",
      doseMorning: 1,
      doseAfternoon: 0,
      doseNight: 1,
      foodRelation: "after",
      periodicity: "daily",
      durationValue: 5,
      durationUnit: "days",
      remarks: `${secret}-remarks`,
    },
    { drugName: "Levocetirizine", doseNight: 1, isSos: true, timing: "if itching", durationValue: 1, durationUnit: "weeks" },
  ],
});

beforeAll(async () => {
  A = await createTestTenant("clla");
  const p = await createPatient(A.as("reception"), { name: "Lifecycle Clinical Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});

afterAll(async () => {
  await A.cleanup();
});

/** Draft saved once (revision 1) with the full clinical form. */
async function savedDraft(): Promise<string> {
  const s = await startPrescription(doctor(), { patientId });
  if (!s.ok) throw new Error(s.message);
  const saved = await saveDraft(doctor(), s.value.prescriptionId, clinicalDraft(), { baseRevision: 0 });
  if (!saved.ok) throw new Error(saved.message);
  return s.value.prescriptionId;
}

async function finalized(): Promise<string> {
  const id = await savedDraft();
  const done = await finalizePrescription(doctor(), id, { expectedRevision: 1 });
  if (!done.ok) throw new Error(done.message);
  return id;
}

async function read(id: string) {
  const got = await getPrescription(doctor(), id);
  if (!got.ok) throw new Error(got.message);
  return got.value;
}

async function auditFor(entityId: string) {
  return withTenant(A.tenantId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.entityId, entityId)));
}

describe("finalizePrescription with revisions", () => {
  it("refuses to finalize a revision the doctor did not see, without burning a number", async () => {
    const id = await savedDraft();
    const before = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
    const beforeRx = before.find((c) => c.name === "rx")?.lastNo ?? 0;

    expect(await finalizePrescription(doctor(), id, { expectedRevision: 0 })).toMatchObject({ ok: false, code: "conflict" });
    expect((await read(id)).status).toBe("draft");
    const after = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
    expect(after.find((c) => c.name === "rx")?.lastNo ?? 0).toBe(beforeRx);

    expect(await finalizePrescription(doctor(), id, { expectedRevision: 1 })).toMatchObject({ ok: true });
  });

  it("still finalizes without an expected revision (Plan 1A callers)", async () => {
    const id = await savedDraft();
    expect((await finalizePrescription(doctor(), id)).ok).toBe(true);
  });

  it("audits counts and field names, never the clinical text", async () => {
    const id = await finalized();
    const event = (await auditFor(id)).find((e) => e.action === "prescription.finalized");
    expect(event?.after).toMatchObject({
      version: 1,
      itemCount: 2,
      diagnosisCount: 1,
      investigationCount: 2,
      vitalsRecorded: ["bpDiastolic", "bpSystolic", "pulse", "spo2"],
    });
    expect((event?.after as { filledFields: string[] }).filledFields).toEqual(
      expect.arrayContaining([
        "chiefComplaint",
        "complaints",
        "diagnosis",
        "medicalHistory",
        "drugHistory",
        "examinationNotes",
        "vitals",
        "investigations",
        "advice",
        "followUpDate",
        "followUpReason",
      ]),
    );
    expect(JSON.stringify(event)).not.toContain(secret);
  });
});

describe("amendPrescription copies the whole clinical record", () => {
  it("copies every visit field and every item column into the new version", async () => {
    const id = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Wrong duration" });
    if (!amended.ok) throw new Error(amended.message);

    const v1 = await read(id);
    const v2 = await read(amended.value.prescriptionId);
    expect(v2.status).toBe("draft");
    expect(v2.revision).toBe(0);
    expect(v2.visit).toEqual({ ...v1.visit, id: v2.visit.id });
    expect(v2.items).toEqual(v1.items);
  });

  it("keeps the reason on the prescription but out of the audit log (Plan 1A payload unchanged)", async () => {
    const id = await finalized();
    const reason = `Patient reported a rash ${secret}`;
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason });
    if (!amended.ok) throw new Error(amended.message);

    expect((await read(amended.value.prescriptionId)).amendmentReason).toBe(reason);
    const event = (await auditFor(amended.value.prescriptionId)).find((e) => e.action === "prescription.amendment_drafted");
    expect(event?.after).toEqual({ version: 2, parentPrescriptionId: id, reasonLength: reason.length });
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("finalizing the amendment audits the same summary shape plus the parent id", async () => {
    const id = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Add a test" });
    if (!amended.ok) throw new Error(amended.message);
    const done = await finalizePrescription(doctor(), amended.value.prescriptionId, { expectedRevision: 0 });
    expect(done).toMatchObject({ ok: true, value: { version: 2 } });
    const event = (await auditFor(amended.value.prescriptionId)).find((e) => e.action === "prescription.amended");
    expect(event?.after).toMatchObject({ version: 2, parentPrescriptionId: id, itemCount: 2, investigationCount: 2 });
    expect(JSON.stringify(event)).not.toContain(secret);
  });
});

describe("repeatPrescription", () => {
  it("copies the prescribing content but not the old visit's measurements", async () => {
    const id = await finalized();
    const repeated = await repeatPrescription(doctor(), id);
    if (!repeated.ok) throw new Error(repeated.message);

    const original = await read(id);
    const copy = await read(repeated.value.prescriptionId);
    expect(copy.items).toEqual(original.items);
    expect(copy.visit).toMatchObject({
      visitType: "follow-up",
      chiefComplaint: original.visit.chiefComplaint,
      complaints: original.visit.complaints,
      diagnosis: original.visit.diagnosis,
      medicalHistory: original.visit.medicalHistory,
      drugHistory: original.visit.drugHistory,
      investigations: original.visit.investigations,
      advice: original.visit.advice,
      vitals: {},
      examinationNotes: null,
      followUpDate: null,
      followUpReason: null,
    });
  });

  it("repeats only the latest version, with that version's clinical content", async () => {
    const id = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Correct the complaints" });
    if (!amended.ok) throw new Error(amended.message);
    const v2Id = amended.value.prescriptionId;
    const saved = await saveDraft(doctor(), v2Id, { ...clinicalDraft(), complaints: ["Corrected complaint"] }, { baseRevision: 0 });
    if (!saved.ok) throw new Error(saved.message);
    expect(await finalizePrescription(doctor(), v2Id, { expectedRevision: 1 })).toMatchObject({ ok: true });

    // Plan 1A's rule: the superseded v1 is refused.
    expect(await repeatPrescription(doctor(), id)).toMatchObject({ ok: false, code: "conflict" });
    const repeated = await repeatPrescription(doctor(), v2Id);
    if (!repeated.ok) throw new Error(repeated.message);
    expect((await read(repeated.value.prescriptionId)).visit.complaints).toEqual(["Corrected complaint"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/prescriptions-clinical-lifecycle.test.ts
```

Expected: FAIL — `expectedRevision` is ignored (the first test finalizes instead of returning `conflict`), the audit summary is missing, and amend and repeat drop the new columns.

- [ ] **Step 3: Add the copy and summary helpers**

In `src/server/services/rx-mapping.ts`, add these imports at the top (merge with the existing ones):

```ts
import { asc, eq } from "drizzle-orm";
import type { TenantTx } from "@/server/db/tenant";
```

and append to the end of the file:

```ts
type VisitInsert = typeof visits.$inferInsert;

/** Copies every item column (amend and repeat). Items are inserted while the target is a draft. */
export async function copyItems(
  tx: TenantTx,
  ctx: ServiceContext,
  fromPrescriptionId: string,
  toPrescriptionId: string,
): Promise<void> {
  const rows = await tx
    .select()
    .from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, fromPrescriptionId))
    .orderBy(asc(prescriptionItems.sortOrder));
  if (rows.length === 0) return;
  await tx.insert(prescriptionItems).values(
    rows.map((row) => ({
      ...omit(row, ["id", "createdAt"] as const),
      tenantId: ctx.tenantId,
      prescriptionId: toPrescriptionId,
    })),
  );
}

/** An amendment corrects the same visit, so it carries every column of the original. */
export function amendVisitValues(old: VisitRow): VisitInsert {
  return { ...omit(old, ["id", "status", "finalizedAt", "createdAt", "updatedAt"] as const), status: "draft" };
}

/**
 * A repeat is a new visit: it copies what was prescribed, not what was measured or found
 * on the old day (vitals, examination notes, follow-up).
 */
export function repeatVisitValues(old: VisitRow, doctorId: string | null): VisitInsert {
  return {
    tenantId: old.tenantId,
    patientId: old.patientId,
    doctorId,
    branchId: old.branchId,
    status: "draft",
    visitType: "follow-up",
    chiefComplaint: old.chiefComplaint,
    complaints: old.complaints,
    diagnosis: old.diagnosis,
    medicalHistory: old.medicalHistory,
    drugHistory: old.drugHistory,
    investigations: old.investigations,
    advice: old.advice,
  };
}

const SUMMARY_FIELDS = [
  "chiefComplaint",
  "complaints",
  "diagnosis",
  "medicalHistory",
  "drugHistory",
  "examinationNotes",
  "vitals",
  "investigations",
  "advice",
  "followUpDate",
  "followUpReason",
] as const;

export type ClinicalSummary = {
  itemCount: number;
  diagnosisCount: number;
  investigationCount: number;
  vitalsRecorded: string[];
  filledFields: string[];
};

/** Audit-safe description of a visit: field names and counts only, never the text itself. */
export function clinicalSummary(visit: VisitRow, itemCount: number): ClinicalSummary {
  const filledFields = SUMMARY_FIELDS.filter((key) => {
    const value: unknown = visit[key];
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return String(value).trim() !== "";
  });
  return {
    itemCount,
    diagnosisCount: visit.diagnosis?.length ?? 0,
    investigationCount: visit.investigations?.length ?? 0,
    vitalsRecorded: Object.keys(visit.vitals ?? {})
      .filter((key) => key !== "notes")
      .sort(),
    filledFields: [...filledFields],
  };
}
```

- [ ] **Step 4: Update finalize, amend, and repeat**

In `src/server/services/prescriptions.ts`:

Each replacement below is the current function with only the Plan 1B additions; keep any later message or check that differs from what is printed here.

1. Delete the existing `export async function copyItems(...) { ... }` (no other module imports it) and extend the `./rx-mapping` import added in Task 3 so it reads:

```ts
import {
  amendVisitValues,
  clinicalSummary,
  copyItems,
  itemValues,
  repeatVisitValues,
  toItemView,
  toVisitView,
  visitColumns,
  type ClinicalVisitView,
  type ItemView,
} from "./rx-mapping";
```

2. Replace the whole `finalizePrescription` function with:

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
      // then sees "finalized"), and it must precede any visit or item write to keep one lock order everywhere.
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
      const now = new Date();

      await tx
        .update(prescriptions)
        .set({ status: "finalized", rxNo, finalizedAt: now, finalizedBy: ctx.userId })
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

3. Replace the whole `amendPrescription` function with (only the visit insert changes, to `amendVisitValues`, and `copyItems` now comes from `rx-mapping.ts`; **the open-amendment check still returns before any write**, which ADR-0023's second lock order relies on):

```ts
export async function amendPrescription(
  ctx: ServiceContext,
  input: { prescriptionId: string; reason: string },
): Promise<Result<{ prescriptionId: string; version: number }>> {
  if (!can(ctx.role, "rx.amend")) return fail("forbidden", "Only doctors can amend prescriptions.");
  if (!isUuid(input.prescriptionId)) return prescriptionNotFound();
  const reason = amendReasonSchema.safeParse(input.reason);
  if (!reason.success) return fail("invalid", reason.error.issues[0].message, "reason");

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ prescriptionId: string; version: number }>> => {
      // Lock the parent first. Every check below returns before any write: finalizing an amendment locks the
      // child and then the parent, so writing here while a child is open could deadlock (ADR-0023).
      const [source] = await tx
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.id, input.prescriptionId))
        .limit(1)
        .for("update");
      if (!source) return prescriptionNotFound();
      if (source.status === "draft") return fail("conflict", "A draft cannot be amended; edit it directly.");
      if (source.status !== "finalized") {
        return fail("conflict", "A newer version of this prescription already exists.");
      }

      const [open] = await tx
        .select({ id: prescriptions.id })
        .from(prescriptions)
        .where(and(eq(prescriptions.parentPrescriptionId, source.id), eq(prescriptions.status, "draft")))
        .limit(1);
      if (open) return fail("conflict", AMENDMENT_IN_PROGRESS);

      // Writes start here. amendVisitValues copies every visit column (the new clinical ones included).
      const [oldVisit] = await tx.select().from(visits).where(eq(visits.id, source.visitId)).limit(1);
      const [newVisit] = await tx.insert(visits).values(amendVisitValues(oldVisit)).returning({ id: visits.id });
      const [rx] = await tx
        .insert(prescriptions)
        .values({
          tenantId: ctx.tenantId,
          visitId: newVisit.id,
          rxNo: source.rxNo,
          version: source.version + 1,
          status: "draft",
          parentPrescriptionId: source.id,
          amendmentReason: reason.data,
          templateVersionId: source.templateVersionId,
        })
        .returning({ id: prescriptions.id, version: prescriptions.version });
      await copyItems(tx, ctx, source.id, rx.id);
      // The reason is free text and lives on the prescription row; the audit log keeps only its length.
      await recordAudit(tx, ctx, {
        action: "prescription.amendment_drafted",
        entityType: "prescription",
        entityId: rx.id,
        before: { version: source.version },
        after: { version: rx.version, parentPrescriptionId: source.id, reasonLength: reason.data.length },
      });
      return ok({ prescriptionId: rx.id, version: rx.version });
    });
  } catch (error) {
    // The partial unique index is the backstop for a race the row lock did not catch. Any other
    // unique violation is a different bug and must surface, not be reported as "in progress".
    const info = pgErrorInfo(error);
    if (info.code === "23505" && info.constraint === OPEN_AMENDMENT_INDEX) {
      return fail("conflict", AMENDMENT_IN_PROGRESS);
    }
    // Only the reason is new free text here (the rest is copied from rows that already passed the database).
    const invalid = invalidFromDatabase(error, { text: "reason" });
    if (invalid) return invalid;
    throw error;
  }
}
```

4. Replace the whole `repeatPrescription` function with (only the visit insert changes, to `repeatVisitValues`; Task 11 adds the open-amendment refusal):

```ts
export async function repeatPrescription(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ prescriptionId: string }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can write prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ prescriptionId: string }>> => {
    const [source] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1);
    if (!source) return prescriptionNotFound();
    if (source.status === "draft") return fail("conflict", "Finalize this draft before repeating it.");
    // A superseded version holds exactly the content an amendment corrected; never copy it forward.
    if (source.status !== "finalized") {
      return fail("conflict", "This prescription was superseded by a later version; repeat the latest version.");
    }

    const [oldVisit] = await tx.select().from(visits).where(eq(visits.id, source.visitId)).limit(1);
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, oldVisit.patientId), isNull(patients.deletedAt)))
      .limit(1);
    if (!patient) return patientNotFound();

    const [newVisit] = await tx
      .insert(visits)
      .values(repeatVisitValues(oldVisit, await doctorIdFor(tx, ctx.userId)))
      .returning({ id: visits.id });
    const [rx] = await tx
      .insert(prescriptions)
      .values({ tenantId: ctx.tenantId, visitId: newVisit.id, status: "draft", version: 1 })
      .returning({ id: prescriptions.id });
    await copyItems(tx, ctx, source.id, rx.id);
    await recordAudit(tx, ctx, {
      action: "prescription.drafted",
      entityType: "prescription",
      entityId: rx.id,
      after: { version: 1, repeatedFrom: source.id },
    });
    return ok({ prescriptionId: rx.id });
  });
}
```

- [ ] **Step 5: Run the new and the Plan 1A lifecycle tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/prescriptions-clinical-lifecycle.test.ts tests/integration/prescriptions-lifecycle.test.ts tests/integration/prescriptions-db-errors.test.ts tests/integration/immutability.test.ts tests/integration/immutability-races.test.ts tests/integration/numbering-audit.test.ts
npm run typecheck
```

Expected: all PASS. Plan 1A's lifecycle tests pass unmodified: they compare audit payloads with `toMatchObject` (the summary keys are additions), and they pin the amendment-without-number refusal, the `23505`-by-constraint-name mapping, the NUL-in-reason refusal, the superseded-repeat refusal and its exact message. If the amend copy test shows a missing field, `amendVisitValues` or `copyItems` is listing columns instead of using `omit`.

- [ ] **Step 6: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/server/services/rx-mapping.ts src/server/services/prescriptions.ts tests/integration/prescriptions-clinical-lifecycle.test.ts
git commit -m "feat: finalize the seen revision and copy all clinical fields on amend and repeat" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 5: Global catalogue seed from `sample_data`

**Files:**
- Create: `src/server/db/catalogue-seed.ts`
- Modify: `package.json` (script), `src/server/db/seed.ts` (script entry), `docs/SETUP.md`
- Test: `tests/integration/catalogue-seed.test.ts`

**Interfaces:**
- Consumes: Task 1 (`csvRecords`, `catalogueKey`, `cleanText`, `TermKind`), Task 2 (`globalMedicines`, `globalClinicalTerms`), `adminDb`.
- Produces: `seedCatalogue(dir?: string): Promise<CatalogueSeedReport>` with `type CatalogueSeedReport = { medicines: number; terms: Record<TermKind, number>; skipped: number }`; npm script `db:seed:catalogue`. Against the real `sample_data` the report is `{ medicines: 1897, terms: { complaint: 139, diagnosis: 119, history: 80, test: 96 }, skipped: 0 }` (1,920 medicine rows, 23 duplicate names).

- [ ] **Step 1: Write the failing test**

`tests/integration/catalogue-seed.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, like } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { globalClinicalTerms, globalMedicines } from "@/server/db/schema";
import { seedCatalogue } from "@/server/db/catalogue-seed";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const P = `ZZSEED${stamp}`;
const key = P.toLowerCase();
let dir = "";

async function writeFixtures(betaGeneric: string) {
  await writeFile(
    path.join(dir, "medicines_template.csv"),
    "\ufeffname,salt\r\n" +
      `${P} ALPHA TAB,Alpha 10mg\r\n` +
      `${key}   alpha tab,Duplicate is ignored\r\n` +
      `"${P} BETA SYRUP","${betaGeneric}"\r\n` +
      ",Salt without a name\r\n" +
      `${P} ${"X".repeat(250)},Name too long\r\n` +
      `${P} आयुर्वेद चूर्ण,Herbal\r\n`,
    "utf8",
  );
  await writeFile(path.join(dir, "complaints_template.csv"), `name\r\n${P} ITCH\r\n${key} itch\r\n`, "utf8");
  await writeFile(path.join(dir, "diagnosis_template.csv"), `name,icdCode\r\n${P} SCABIES,B86\r\n`, "utf8");
  await writeFile(path.join(dir, "medical_history_template.csv"), `name\r\n${P} ASTHMA\r\n`, "utf8");
  await writeFile(path.join(dir, "tests_template.csv"), `name\r\n${P} SKIN SCRAPING\r\n`, "utf8");
}

const fixtureMedicines = () =>
  adminDb.select().from(globalMedicines).where(like(globalMedicines.nameKey, `${key}%`));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "clinicpad-seed-"));
});

afterAll(async () => {
  await adminDb.delete(globalMedicines).where(like(globalMedicines.nameKey, `${key}%`));
  await adminDb.delete(globalClinicalTerms).where(like(globalClinicalTerms.nameKey, `${key}%`));
  await rm(dir, { recursive: true, force: true });
});

describe("seedCatalogue", () => {
  it("loads fixture files, de-duplicating names and skipping blank or oversized rows", async () => {
    await writeFixtures("Gamma 5mg, Delta 2mg");
    const report = await seedCatalogue(dir);
    expect(report).toEqual({
      medicines: 3,
      terms: { complaint: 1, diagnosis: 1, history: 1, test: 1 },
      skipped: 2,
    });

    const rows = await fixtureMedicines();
    expect(rows.map((r) => r.name).sort()).toEqual([`${P} ALPHA TAB`, `${P} BETA SYRUP`, `${P} आयुर्वेद चूर्ण`].sort());
    expect(rows.find((r) => r.name === `${P} ALPHA TAB`)?.genericName).toBe("Alpha 10mg");
    expect(rows.find((r) => r.name === `${P} BETA SYRUP`)?.genericName).toBe("Gamma 5mg, Delta 2mg");

    const [scabies] = await adminDb
      .select()
      .from(globalClinicalTerms)
      .where(and(eq(globalClinicalTerms.kind, "diagnosis"), like(globalClinicalTerms.nameKey, `${key}%`)));
    expect(scabies.icd10Code).toBe("B86");
  });

  it("is idempotent and picks up edited generic names", async () => {
    await writeFixtures("Gamma 7mg");
    await seedCatalogue(dir);
    await seedCatalogue(dir);
    const rows = await fixtureMedicines();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.name === `${P} BETA SYRUP`)?.genericName).toBe("Gamma 7mg");
  });

  it("loads the real sample_data catalogue", async () => {
    const report = await seedCatalogue();
    expect(report).toEqual({
      medicines: 1897,
      terms: { complaint: 139, diagnosis: 119, history: 80, test: 96 },
      skipped: 0,
    });
    const [dolo] = await adminDb.select().from(globalMedicines).where(eq(globalMedicines.nameKey, "dolo 650mg"));
    expect(dolo).toMatchObject({ name: "DOLO 650MG", genericName: "Paracetamol 650Mg" });
    const [anticramp] = await adminDb.select().from(globalMedicines).where(eq(globalMedicines.nameKey, "anticramp tab"));
    expect(anticramp.genericName).toContain("L-Carnitine 500mg");
    const fever = await adminDb
      .select()
      .from(globalClinicalTerms)
      .where(and(eq(globalClinicalTerms.kind, "complaint"), eq(globalClinicalTerms.nameKey, "fever")));
    expect(fever).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/catalogue-seed.test.ts
```

Expected: FAIL — `@/server/db/catalogue-seed` cannot be resolved.

- [ ] **Step 3: Implement the seed**

`src/server/db/catalogue-seed.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { globalClinicalTerms, globalMedicines } from "@/server/db/schema";
import { csvRecords } from "@/lib/csv";
import { catalogueKey } from "@/lib/domain/search";
import { cleanText } from "@/lib/domain/text";
import type { TermKind } from "@/lib/domain/rx-options";

const TERM_FILES: ReadonlyArray<{ kind: TermKind; file: string }> = [
  { kind: "complaint", file: "complaints_template.csv" },
  { kind: "diagnosis", file: "diagnosis_template.csv" },
  { kind: "history", file: "medical_history_template.csv" },
  { kind: "test", file: "tests_template.csv" },
];

const MAX_NAME = 200;
const MAX_GENERIC = 300;
const MAX_ICD = 16;
const CHUNK = 500;

export type CatalogueSeedReport = { medicines: number; terms: Record<TermKind, number>; skipped: number };

function tidy(value: string | undefined): string {
  return cleanText(value ?? "").replace(/\s+/g, " ").trim();
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Loads the global reference catalogue from the sample_data CSVs. Idempotent: rows are
 * keyed by a normalized name, so re-running updates generic names and ICD codes instead
 * of duplicating rows; the first spelling of a duplicated name wins. Uses the admin
 * connection because the app role can only read these tables. Safe in production: this
 * is reference data, not patient data.
 */
export async function seedCatalogue(dir = path.join(process.cwd(), "sample_data")): Promise<CatalogueSeedReport> {
  let skipped = 0;

  const medicines = new Map<string, { name: string; genericName: string | null; nameKey: string }>();
  for (const record of csvRecords(await readFile(path.join(dir, "medicines_template.csv"), "utf8"))) {
    const name = tidy(record.name);
    if (!name || name.length > MAX_NAME) {
      skipped += 1;
      continue;
    }
    const nameKey = catalogueKey(name);
    const generic = tidy(record.salt).slice(0, MAX_GENERIC);
    if (!medicines.has(nameKey)) medicines.set(nameKey, { name, genericName: generic || null, nameKey });
  }
  for (const chunk of chunks([...medicines.values()], CHUNK)) {
    await adminDb
      .insert(globalMedicines)
      .values(chunk)
      .onConflictDoUpdate({
        target: globalMedicines.nameKey,
        set: { name: sql`excluded.name`, genericName: sql`excluded.generic_name` },
      });
  }

  const terms: Record<TermKind, number> = { complaint: 0, diagnosis: 0, history: 0, test: 0 };
  for (const { kind, file } of TERM_FILES) {
    const rows = new Map<string, { kind: TermKind; name: string; nameKey: string; icd10Code: string | null }>();
    for (const record of csvRecords(await readFile(path.join(dir, file), "utf8"))) {
      const name = tidy(record.name);
      if (!name || name.length > MAX_NAME) {
        skipped += 1;
        continue;
      }
      const nameKey = catalogueKey(name);
      const icd = tidy(record.icdcode).slice(0, MAX_ICD);
      if (!rows.has(nameKey)) rows.set(nameKey, { kind, name, nameKey, icd10Code: icd || null });
    }
    for (const chunk of chunks([...rows.values()], CHUNK)) {
      await adminDb
        .insert(globalClinicalTerms)
        .values(chunk)
        .onConflictDoUpdate({
          target: [globalClinicalTerms.kind, globalClinicalTerms.nameKey],
          set: { name: sql`excluded.name`, icd10Code: sql`excluded.icd10_code` },
        });
    }
    terms[kind] = rows.size;
  }

  return { medicines: medicines.size, terms, skipped };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  seedCatalogue()
    .then((report) => {
      console.log(
        `Catalogue seeded: ${report.medicines} medicines; terms ${JSON.stringify(report.terms)}; skipped ${report.skipped} rows`,
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
```

In `package.json`, add this script directly after `"db:seed"`:

```json
    "db:seed:catalogue": "tsx --env-file=.env.local src/server/db/catalogue-seed.ts",
```

In `src/server/db/seed.ts`, add `import { seedCatalogue } from "@/server/db/catalogue-seed";` with the other imports and replace the script-entry block at the bottom of the file with:

```ts
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  seedDemo()
    .then(() => seedCatalogue())
    .then((report) => {
      console.log(`Catalogue: ${report.medicines} medicines`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
```

(`seedDemo()` itself is unchanged, so `tests/integration/seed.test.ts` is unaffected.)

In `docs/SETUP.md`, in the code block that contains `npm run db:seed       # demo clinic: 3 staff, 50 patients, 20 prescriptions`, add this line directly below it:

```bash
npm run db:seed:catalogue   # global medicine and clinical-term lists (idempotent; db:seed also runs it; safe in production)
```

- [ ] **Step 4: Run the test and the script**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/catalogue-seed.test.ts tests/integration/seed.test.ts
npm run db:seed:catalogue
```

Expected: tests PASS; the script prints `Catalogue seeded: 1897 medicines; terms {"complaint":139,"diagnosis":119,"history":80,"test":96}; skipped 0 rows` (re-counted against `sample_data` at reconciliation: 1,920 medicine rows with 1,897 distinct keys; 139, 119, 80, 96 distinct terms). If the real-catalogue counts differ, compare `catalogueKey` with Task 1 (spacing collapsed, case ignored, punctuation kept) before touching the expected numbers. Confirm the fixture BOM is an escape: `Select-String -Path tests/integration/catalogue-seed.test.ts -Pattern '\\ufeff'` finds the line.

- [ ] **Step 5: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/server/db/catalogue-seed.ts src/server/db/seed.ts package.json docs/SETUP.md tests/integration/catalogue-seed.test.ts
git commit -m "feat: seed the global medicine and clinical-term catalogue from sample_data" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 6: Catalogue service — search, clinic medicines, favourites, term suggestions

**Files:**
- Create: `src/server/validation/catalogue.ts`, `src/server/services/catalogue.ts`
- Test: `tests/integration/catalogue.test.ts`

**Interfaces:**
- Consumes: Task 1 (`catalogueKey`, `escapeLike`, `searchTerm`, `clampLimit`, `RX_LIMITS`, `TERM_KINDS`), Task 2 tables (`medicineFavourites.doctorId`, `doctors_tenant_user_uq`), Task 3 `prescriptionItemSchema` and `cleanInput`/`hasNoNul`/`NUL_MESSAGE`/`blankToUndefined` (`src/server/validation/text.ts`), Plan 1A `can`, `isUuid`, `recordAudit`, `withTenant`, `Result` helpers, `createTestTenant`.
- Produces:
  - `type FavouriteView = { id: string; drugName: string; genericName: string | null; strength: string | null; form: string | null; route: string | null; dose: string | null; doseMorning: number | null; doseAfternoon: number | null; doseEvening: number | null; doseNight: number | null; timing: string | null; foodRelation: string | null; periodicity: string | null; isSos: boolean; durationValue: number | null; durationUnit: string | null; remarks: string | null }`.
  - `type MedicineHit = { source: "favourite" | "clinic" | "global"; id: string; name: string; genericName: string | null; favourite: FavouriteView | null }`.
  - `searchMedicines(ctx, opts?: { q?: unknown; limit?: unknown }): Promise<Result<MedicineHit[]>>` — empty query returns the caller's favourites; otherwise favourites first, then prefix matches, clinic before global, then name; de-duplicated by `catalogueKey`; at most 50.
  - `addClinicMedicine(ctx, raw: unknown): Promise<Result<{ id: string; created: boolean }>>` (audited as `medicine.added`, ids only).
  - `listFavourites(ctx): Promise<Result<FavouriteView[]>>`; `saveFavourite(ctx, raw: unknown): Promise<Result<FavouriteView>>` (upsert per medicine name, cap 200, `field: "favourites"` when full); `removeFavourite(ctx, id: string): Promise<Result<null>>`.
  - `suggestTerms(ctx, opts: { kind: unknown; q?: unknown; limit?: unknown }): Promise<Result<string[]>>`.
  - Roles: search and suggestions need `catalogue.read`; `addClinicMedicine` needs `catalogue.write`; favourites need `rx.draft` **and a doctor profile**: they belong to the caller's `doctors` row in this clinic (looked up by `doctors.user_id = ctx.userId`, unique per tenant since migration 0010). Without a profile, `listFavourites` returns `[]`, search shows no favourites, `saveFavourite` returns `invalid` (`field: "favourites"`), and `removeFavourite` returns `not_found`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/catalogue.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, doctors, globalClinicalTerms, globalMedicines, medicineFavourites, users } from "@/server/db/schema";
import {
  addClinicMedicine,
  listFavourites,
  removeFavourite,
  saveFavourite,
  searchMedicines,
  suggestTerms,
} from "@/server/services/catalogue";
import { newId } from "@/lib/domain/ids";
import type { ServiceContext } from "@/server/services/context";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const P = `ZQ${stamp}`;
const key = P.toLowerCase();

let A: TestTenant;
let B: TestTenant;
let secondDoctor: ServiceContext;
const extraUsers: string[] = [];

/** Another prescriber in the same clinic, with a doctor profile of their own. */
async function extraDoctor(tenantId: string, label: string): Promise<{ ctx: ServiceContext; doctorId: string }> {
  const [user] = await adminDb
    .insert(users)
    .values({ email: `${label}-${stamp}@example.com`, name: "Dr Extra", passwordHash: "not-a-real-hash" })
    .returning();
  extraUsers.push(user.id);
  const [doctor] = await adminDb.insert(doctors).values({ tenantId, userId: user.id }).returning();
  return { ctx: { tenantId, userId: user.id, role: "doctor" }, doctorId: doctor.id };
}

beforeAll(async () => {
  A = await createTestTenant("cata");
  B = await createTestTenant("catb");
  secondDoctor = (await extraDoctor(A.tenantId, "cat-second")).ctx;
  await adminDb.insert(globalMedicines).values([
    { name: `${P} PARAMOL 500 TAB`, genericName: "Paracetamol 500mg", nameKey: `${key} paramol 500 tab` },
    { name: `${P} 100% PURE SYRUP`, genericName: null, nameKey: `${key} 100% pure syrup` },
    { name: `${P} 1000 MG TAB`, genericName: null, nameKey: `${key} 1000 mg tab` },
    { name: `${P} AB_C TAB`, genericName: null, nameKey: `${key} ab_c tab` },
    { name: `${P} ABXC TAB`, genericName: null, nameKey: `${key} abxc tab` },
  ]);
  await adminDb.insert(globalClinicalTerms).values([
    { kind: "complaint", name: `${P} FEVER WITH CHILLS`, nameKey: `${key} fever with chills` },
    { kind: "test", name: `${P} CBC`, nameKey: `${key} cbc` },
  ]);
});

afterAll(async () => {
  try {
    await adminDb.delete(globalMedicines).where(like(globalMedicines.nameKey, `${key}%`));
    await adminDb.delete(globalClinicalTerms).where(like(globalClinicalTerms.nameKey, `${key}%`));
    await A.cleanup();
    await B.cleanup();
  } finally {
    if (extraUsers.length > 0) await adminDb.delete(users).where(inArray(users.id, extraUsers));
  }
});

/** Names from a search, limited to rows this test file created. */
async function names(ctx: ServiceContext, q: unknown): Promise<string[]> {
  const result = await searchMedicines(ctx, { q });
  if (!result.ok) throw new Error(result.message);
  return result.value.map((h) => h.name).filter((n) => n.includes(stamp));
}

describe("searchMedicines", () => {
  it("finds global medicines by name and by generic name", async () => {
    expect(await names(A.as("doctor"), `${P} PARA`)).toEqual([`${P} PARAMOL 500 TAB`]);
    expect(await names(A.as("doctor"), "paracetamol 500MG")).toContain(`${P} PARAMOL 500 TAB`);
  });

  it("treats % and _ literally", async () => {
    expect(await names(A.as("doctor"), `${P} 100%`)).toEqual([`${P} 100% PURE SYRUP`]);
    expect(await names(A.as("doctor"), `${P} AB_C`)).toEqual([`${P} AB_C TAB`]);
  });

  it("ranks prefix matches before substring matches", async () => {
    const added = await addClinicMedicine(A.as("doctor"), { name: `PARAMOL ${stamp} DROPS` });
    expect(added.ok).toBe(true);
    const found = await names(A.as("doctor"), "PARAMOL");
    expect(found.indexOf(`PARAMOL ${stamp} DROPS`)).toBeLessThan(found.indexOf(`${P} PARAMOL 500 TAB`));
    expect(found.indexOf(`PARAMOL ${stamp} DROPS`)).toBeGreaterThanOrEqual(0);
  });

  it("keeps clinic medicines inside their clinic and audits ids only", async () => {
    const name = `${P} CLINIC ONLY SYRUP`;
    const first = await addClinicMedicine(A.as("doctor"), { name, genericName: "House blend" });
    const again = await addClinicMedicine(A.as("owner"), { name: `  ${name.toLowerCase()}  ` });
    if (!first.ok || !again.ok) throw new Error("setup failed");
    expect(first.value.created).toBe(true);
    expect(again.value).toEqual({ id: first.value.id, created: false });

    expect(await names(A.as("doctor"), "CLINIC ONLY")).toEqual([name]);
    expect(await names(B.as("doctor"), "CLINIC ONLY")).toEqual([]);

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, first.value.id)),
    );
    expect(audit.map((e) => e.action)).toEqual(["medicine.added"]);
    expect(JSON.stringify(audit)).not.toContain("CLINIC ONLY");
  });

  it("finds Devanagari clinic medicines", async () => {
    await addClinicMedicine(A.as("doctor"), { name: `क्रोसिन ${stamp}` });
    expect(await names(A.as("doctor"), "क्रोसिन")).toEqual([`क्रोसिन ${stamp}`]);
  });

  it("survives hostile search input without errors", async () => {
    for (const q of ["x".repeat(10_000), "\u0000%", "'; drop table patients; --", 123, null, { q: "x" }]) {
      const result = await searchMedicines(A.as("doctor"), { q });
      expect(result.ok).toBe(true);
    }
    const capped = await searchMedicines(A.as("doctor"), { q: "TAB", limit: 100_000 });
    expect(capped.ok && capped.value.length).toBeLessThanOrEqual(50);
  });

  it("enforces roles", async () => {
    expect(await searchMedicines(A.as("reception"), { q: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await searchMedicines(A.as("accountant"), { q: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect((await searchMedicines(A.as("nurse"), { q: "x" })).ok).toBe(true);
    expect((await searchMedicines(A.as("pharmacist"), { q: "x" })).ok).toBe(true);
    expect(await addClinicMedicine(A.as("nurse"), { name: "Nurse Med" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await addClinicMedicine(A.as("reception"), { name: "Desk Med" })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("validates clinic medicine names, refusing a NUL rather than stripping it", async () => {
    const NUL = "\u0000";
    expect([...NUL]).toHaveLength(1);
    expect(await addClinicMedicine(A.as("doctor"), { name: " " })).toMatchObject({ ok: false, code: "invalid", field: "name" });
    expect(await addClinicMedicine(A.as("doctor"), { name: "x".repeat(201) })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "name",
    });
    expect(await addClinicMedicine(A.as("doctor"), { name: `Bad${NUL}Syrup` })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "name",
    });
  });
});

describe("favourites", () => {
  const line = {
    drugName: `${P} PARAMOL 500 TAB`,
    genericName: "Paracetamol 500mg",
    doseMorning: 1,
    doseAfternoon: 0,
    doseNight: 1,
    foodRelation: "after",
    durationValue: 5,
    durationUnit: "days",
  };

  it("saves a prescriber's default line and offers it first in search", async () => {
    const saved = await saveFavourite(A.as("doctor"), line);
    expect(saved).toMatchObject({ ok: true, value: { drugName: line.drugName, doseNight: 1, durationValue: 5 } });

    const result = await searchMedicines(A.as("doctor"), { q: P });
    if (!result.ok) throw new Error(result.message);
    expect(result.value[0]).toMatchObject({ source: "favourite", name: line.drugName, favourite: { foodRelation: "after" } });

    const empty = await searchMedicines(A.as("doctor"), { q: "" });
    expect(empty.ok && empty.value.map((h) => h.name)).toContain(line.drugName);
  });

  it("keeps one favourite per medicine name and updates it", async () => {
    const first = await saveFavourite(A.as("doctor"), line);
    const second = await saveFavourite(A.as("doctor"), { ...line, drugName: `  ${line.drugName.toLowerCase()} `, durationValue: 3 });
    if (!first.ok || !second.ok) throw new Error("setup failed");
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.durationValue).toBe(3);
    const list = await listFavourites(A.as("doctor"));
    expect(list.ok && list.value.filter((f) => f.drugName.includes(stamp))).toHaveLength(1);
  });

  it("keeps favourites private to each prescriber and clinic", async () => {
    const mine = await saveFavourite(A.as("doctor"), line);
    if (!mine.ok) throw new Error(mine.message);
    expect(await listFavourites(secondDoctor)).toEqual({ ok: true, value: [] });
    expect(await listFavourites(B.as("doctor"))).toEqual({ ok: true, value: [] });
    expect(await removeFavourite(secondDoctor, mine.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await removeFavourite(B.as("doctor"), mine.value.id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("validates favourite lines like prescription items", async () => {
    expect(await saveFavourite(A.as("doctor"), { drugName: "" })).toMatchObject({ ok: false, code: "invalid", field: "drugName" });
    expect(await saveFavourite(A.as("doctor"), { drugName: "X", doseMorning: 0.3 })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "doseMorning",
    });
  });

  it("belong to a doctor profile: a prescriber without one has none and cannot save one", async () => {
    const profileless: ServiceContext = { tenantId: A.tenantId, userId: newId(), role: "owner" };
    expect(await listFavourites(profileless)).toEqual({ ok: true, value: [] });
    expect(await saveFavourite(profileless, line)).toMatchObject({ ok: false, code: "invalid", field: "favourites" });
    const search = await searchMedicines(profileless, { q: "" });
    expect(search).toEqual({ ok: true, value: [] });
  });

  it("caps favourites per prescriber but still updates existing ones", async () => {
    const { ctx: third, doctorId } = await extraDoctor(A.tenantId, "cat-third");
    await adminDb.insert(medicineFavourites).values(
      Array.from({ length: 200 }, (_, i) => ({
        tenantId: A.tenantId,
        doctorId,
        nameKey: `cap ${i}`,
        drugName: `Cap ${i}`,
      })),
    );
    expect(await saveFavourite(third, { drugName: "One Too Many" })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "favourites",
    });
    expect(await saveFavourite(third, { drugName: "Cap 7", doseNight: 1 })).toMatchObject({ ok: true });
  });

  it("removes a favourite", async () => {
    const saved = await saveFavourite(secondDoctor, { drugName: `${P} REMOVE ME` });
    if (!saved.ok) throw new Error(saved.message);
    expect(await removeFavourite(secondDoctor, saved.value.id)).toEqual({ ok: true, value: null });
    expect(await removeFavourite(secondDoctor, saved.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await removeFavourite(secondDoctor, "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("is limited to prescribers", async () => {
    expect(await saveFavourite(A.as("nurse"), line)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await listFavourites(A.as("reception"))).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("suggestTerms", () => {
  it("suggests terms of the requested kind only", async () => {
    expect(await suggestTerms(A.as("doctor"), { kind: "complaint", q: `${P} fever` })).toEqual({
      ok: true,
      value: [`${P} FEVER WITH CHILLS`],
    });
    expect(await suggestTerms(A.as("doctor"), { kind: "test", q: `${P} CB` })).toEqual({ ok: true, value: [`${P} CBC`] });
    expect(await suggestTerms(A.as("doctor"), { kind: "complaint", q: `${P} CB` })).toEqual({ ok: true, value: [] });
  });

  it("rejects unknown kinds, returns nothing for blank input, and enforces roles", async () => {
    expect(await suggestTerms(A.as("doctor"), { kind: "spell", q: "x" })).toMatchObject({ ok: false, code: "invalid", field: "kind" });
    expect(await suggestTerms(A.as("doctor"), { kind: "test", q: "   " })).toEqual({ ok: true, value: [] });
    expect(await suggestTerms(A.as("reception"), { kind: "test", q: "cbc" })).toMatchObject({ ok: false, code: "forbidden" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/catalogue.test.ts
```

Expected: FAIL — `@/server/services/catalogue` cannot be resolved.

- [ ] **Step 3: Implement the validation schema**

`src/server/validation/catalogue.ts`:

```ts
import { z } from "zod";
import { cleanInput, cleanOptionalText, hasNoNul, NUL_MESSAGE } from "./text";

export const clinicMedicineInputSchema = z.object({
  name: z.preprocess(
    cleanInput,
    z
      .string()
      .trim()
      .min(2, "Enter the medicine name")
      .max(200, "Keep the name under 200 characters")
      .refine(hasNoNul, NUL_MESSAGE),
  ),
  genericName: cleanOptionalText(300),
});

export type ClinicMedicineInput = z.output<typeof clinicMedicineInputSchema>;
```

- [ ] **Step 4: Implement the service**

`src/server/services/catalogue.ts`:

```ts
import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { RX_LIMITS, TERM_KINDS, type TermKind } from "@/lib/domain/rx-options";
import { catalogueKey, clampLimit, escapeLike, searchTerm } from "@/lib/domain/search";
import { doctors, globalClinicalTerms, globalMedicines, medicineFavourites, tenantMedicines } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { clinicMedicineInputSchema } from "@/server/validation/catalogue";
import { prescriptionItemSchema } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";

export type FavouriteView = {
  id: string;
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
  remarks: string | null;
};

export type MedicineHit = {
  source: "favourite" | "clinic" | "global";
  id: string;
  name: string;
  genericName: string | null;
  favourite: FavouriteView | null;
};

type FavouriteRow = typeof medicineFavourites.$inferSelect;

const SOURCE_RANK: Record<MedicineHit["source"], number> = { favourite: 0, clinic: 1, global: 2 };

function toFavouriteView(row: FavouriteRow): FavouriteView {
  return {
    id: row.id,
    drugName: row.drugName,
    genericName: row.genericName,
    strength: row.strength,
    form: row.form,
    route: row.route,
    dose: row.dose,
    doseMorning: row.doseMorning,
    doseAfternoon: row.doseAfternoon,
    doseEvening: row.doseEvening,
    doseNight: row.doseNight,
    timing: row.timing,
    foodRelation: row.foodRelation,
    periodicity: row.periodicity,
    isSos: row.isSos,
    durationValue: row.durationValue,
    durationUnit: row.durationUnit,
    remarks: row.remarks,
  };
}

const favouriteNotFound = () => fail("not_found", "Favourite not found.");
const NO_DOCTOR_PROFILE = "Favourites belong to a doctor profile, and this account has none in this clinic.";

/**
 * The caller's doctor profile in this clinic, or null. doctors_tenant_user_uq (migration 0010) makes it
 * unique, and RLS limits the lookup to the session's tenant.
 */
async function callerDoctorId(tx: TenantTx, userId: string): Promise<string | null> {
  const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, userId)).limit(1);
  return doctor?.id ?? null;
}

async function favouritesOf(tx: TenantTx, doctorId: string | null): Promise<FavouriteView[]> {
  if (doctorId === null) return [];
  const rows = await tx
    .select()
    .from(medicineFavourites)
    .where(eq(medicineFavourites.doctorId, doctorId))
    .orderBy(asc(medicineFavourites.drugName))
    .limit(RX_LIMITS.favouritesPerDoctor);
  return rows.map(toFavouriteView);
}

export async function searchMedicines(
  ctx: ServiceContext,
  opts: { q?: unknown; limit?: unknown } = {},
): Promise<Result<MedicineHit[]>> {
  if (!can(ctx.role, "catalogue.read")) return fail("forbidden", "You cannot search the medicine list.");
  const term = searchTerm(opts.q, RX_LIMITS.searchQuery);
  const limit = clampLimit(opts.limit, 20, 50);
  const lower = term.toLowerCase();

  return withTenant(ctx.tenantId, async (tx) => {
    // Nurses and pharmacists may search too; they normally have no doctor profile, so no favourites.
    const favourites = await favouritesOf(tx, await callerDoctorId(tx, ctx.userId));

    // Favourites are filtered in memory (at most 200 rows), so wildcards cannot apply here either.
    const favouriteHits: MedicineHit[] = favourites
      .filter(
        (f) =>
          lower === "" ||
          f.drugName.toLowerCase().includes(lower) ||
          (f.genericName ?? "").toLowerCase().includes(lower),
      )
      .map((f) => ({ source: "favourite", id: f.id, name: f.drugName, genericName: f.genericName, favourite: f }));
    if (term === "") return ok(favouriteHits.slice(0, limit));

    const pattern = `%${escapeLike(term)}%`;
    const prefix = `${escapeLike(term)}%`;
    const clinicRows = await tx
      .select({ id: tenantMedicines.id, name: tenantMedicines.name, genericName: tenantMedicines.genericName })
      .from(tenantMedicines)
      .where(or(ilike(tenantMedicines.name, pattern), ilike(tenantMedicines.genericName, pattern)))
      .orderBy(sql`case when ${tenantMedicines.name} ilike ${prefix} then 0 else 1 end`, asc(tenantMedicines.name))
      .limit(limit);
    const globalRows = await tx
      .select({ id: globalMedicines.id, name: globalMedicines.name, genericName: globalMedicines.genericName })
      .from(globalMedicines)
      .where(or(ilike(globalMedicines.name, pattern), ilike(globalMedicines.genericName, pattern)))
      .orderBy(sql`case when ${globalMedicines.name} ilike ${prefix} then 0 else 1 end`, asc(globalMedicines.name))
      .limit(limit);

    // First occurrence of a name wins: favourite, then clinic, then global.
    const hits: MedicineHit[] = [];
    const seen = new Set<string>();
    const add = (hit: MedicineHit) => {
      const k = catalogueKey(hit.name);
      if (seen.has(k)) return;
      seen.add(k);
      hits.push(hit);
    };
    favouriteHits.forEach(add);
    clinicRows.forEach((r) => add({ source: "clinic", ...r, favourite: null }));
    globalRows.forEach((r) => add({ source: "global", ...r, favourite: null }));

    const isPrefix = (hit: MedicineHit) => hit.name.toLowerCase().startsWith(lower);
    hits.sort(
      (a, b) =>
        Number(b.favourite !== null) - Number(a.favourite !== null) ||
        Number(isPrefix(b)) - Number(isPrefix(a)) ||
        SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
        a.name.localeCompare(b.name),
    );
    return ok(hits.slice(0, limit));
  });
}

export async function addClinicMedicine(
  ctx: ServiceContext,
  raw: unknown,
): Promise<Result<{ id: string; created: boolean }>> {
  if (!can(ctx.role, "catalogue.write")) return fail("forbidden", "Only doctors can add medicines to the clinic list.");
  const parsed = clinicMedicineInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const { name, genericName } = parsed.data;
  const nameKey = catalogueKey(name);

  return withTenant(ctx.tenantId, async (tx) => {
    const inserted = await tx
      .insert(tenantMedicines)
      .values({ tenantId: ctx.tenantId, name, genericName: genericName ?? null, nameKey, createdBy: ctx.userId })
      .onConflictDoNothing({ target: [tenantMedicines.tenantId, tenantMedicines.nameKey] })
      .returning({ id: tenantMedicines.id });
    if (inserted.length > 0) {
      await recordAudit(tx, ctx, { action: "medicine.added", entityType: "tenant_medicine", entityId: inserted[0].id });
      return ok({ id: inserted[0].id, created: true });
    }
    const [existing] = await tx
      .select({ id: tenantMedicines.id })
      .from(tenantMedicines)
      .where(eq(tenantMedicines.nameKey, nameKey))
      .limit(1);
    return ok({ id: existing.id, created: false });
  });
}

export async function listFavourites(ctx: ServiceContext): Promise<Result<FavouriteView[]>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only prescribers keep favourites.");
  const favourites = await withTenant(ctx.tenantId, async (tx) => favouritesOf(tx, await callerDoctorId(tx, ctx.userId)));
  return ok(favourites);
}

/** Saves the caller's default line for a medicine; saving the same medicine again updates it. */
export async function saveFavourite(ctx: ServiceContext, raw: unknown): Promise<Result<FavouriteView>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only prescribers keep favourites.");
  const parsed = prescriptionItemSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const item = parsed.data;
  const nameKey = catalogueKey(item.drugName);
  const columns = {
    drugName: item.drugName,
    genericName: item.genericName ?? null,
    strength: item.strength ?? null,
    form: item.form ?? null,
    route: item.route ?? null,
    dose: item.dose ?? null,
    doseMorning: item.doseMorning,
    doseAfternoon: item.doseAfternoon,
    doseEvening: item.doseEvening,
    doseNight: item.doseNight,
    timing: item.timing ?? null,
    foodRelation: item.foodRelation ?? null,
    periodicity: item.periodicity ?? null,
    isSos: item.isSos,
    durationValue: item.durationValue,
    durationUnit: item.durationUnit,
    remarks: item.remarks ?? null,
  };

  return withTenant(ctx.tenantId, async (tx): Promise<Result<FavouriteView>> => {
    const doctorId = await callerDoctorId(tx, ctx.userId);
    if (doctorId === null) return fail("invalid", NO_DOCTOR_PROFILE, "favourites");
    const [existing] = await tx
      .select({ id: medicineFavourites.id })
      .from(medicineFavourites)
      .where(and(eq(medicineFavourites.doctorId, doctorId), eq(medicineFavourites.nameKey, nameKey)))
      .limit(1);
    if (!existing) {
      const [{ value: total }] = await tx
        .select({ value: count() })
        .from(medicineFavourites)
        .where(eq(medicineFavourites.doctorId, doctorId));
      if (total >= RX_LIMITS.favouritesPerDoctor) {
        return fail(
          "invalid",
          `You can keep up to ${RX_LIMITS.favouritesPerDoctor} favourites. Remove one first.`,
          "favourites",
        );
      }
    }
    const [row] = await tx
      .insert(medicineFavourites)
      .values({ tenantId: ctx.tenantId, doctorId, nameKey, ...columns })
      .onConflictDoUpdate({
        target: [medicineFavourites.tenantId, medicineFavourites.doctorId, medicineFavourites.nameKey],
        set: { ...columns, updatedAt: new Date() },
      })
      .returning();
    return ok(toFavouriteView(row));
  });
}

export async function removeFavourite(ctx: ServiceContext, id: string): Promise<Result<null>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only prescribers keep favourites.");
  if (!isUuid(id)) return favouriteNotFound();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<null>> => {
    const doctorId = await callerDoctorId(tx, ctx.userId);
    if (doctorId === null) return favouriteNotFound();
    const removed = await tx
      .delete(medicineFavourites)
      .where(and(eq(medicineFavourites.id, id), eq(medicineFavourites.doctorId, doctorId)))
      .returning({ id: medicineFavourites.id });
    return removed.length > 0 ? ok(null) : favouriteNotFound();
  });
}

export async function suggestTerms(
  ctx: ServiceContext,
  opts: { kind: unknown; q?: unknown; limit?: unknown },
): Promise<Result<string[]>> {
  if (!can(ctx.role, "catalogue.read")) return fail("forbidden", "You cannot search clinical lists.");
  if (typeof opts.kind !== "string" || !(TERM_KINDS as readonly string[]).includes(opts.kind)) {
    return fail("invalid", "Unknown suggestion list.", "kind");
  }
  const kind = opts.kind as TermKind;
  const term = searchTerm(opts.q, RX_LIMITS.searchQuery);
  if (term === "") return ok([]);
  const limit = clampLimit(opts.limit, 15, 50);
  const pattern = `%${escapeLike(term)}%`;
  const prefix = `${escapeLike(term)}%`;

  const rows = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ name: globalClinicalTerms.name })
      .from(globalClinicalTerms)
      .where(and(eq(globalClinicalTerms.kind, kind), ilike(globalClinicalTerms.name, pattern)))
      .orderBy(sql`case when ${globalClinicalTerms.name} ilike ${prefix} then 0 else 1 end`, asc(globalClinicalTerms.name))
      .limit(limit),
  );
  return ok(rows.map((r) => r.name));
}
```

Favourites are personal preferences, not clinical or business records, so they are not audited; clinic medicines are clinic-wide configuration and are (ids only). `callerDoctorId` repeats the three-line lookup of the private `doctorIdFor` in `prescriptions.ts` on purpose: services do not import each other's internals.

- [ ] **Step 5: Run the tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/catalogue.test.ts tests/integration/clinical-schema.test.ts
npm run typecheck
```

Expected: all PASS; typecheck exits 0. If the `%`/`_` test returns extra rows, the pattern is not passed through `escapeLike`; do not loosen the test.

- [ ] **Step 6: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/server/validation/catalogue.ts src/server/services/catalogue.ts tests/integration/catalogue.test.ts
git commit -m "feat: add medicine search, clinic medicines, favourites, and term suggestions" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 7: Search route, editor server actions, and the non-redirecting session helper

**Files:**
- Modify: `src/server/auth/session.ts`, `scripts/build-desktop.mjs`
- Create: `src/app/api/catalogue/search/route.ts`, `src/server/actions/drafts.ts`, `src/server/actions/catalogue.ts`
- Test: `tests/integration/editor-endpoints.test.ts`

**Interfaces:**
- Consumes: Task 3 `saveDraft`, Task 4 `finalizePrescription(ctx, id, { expectedRevision })`, Task 6 catalogue services, existing `auth()` and `SessionContext`.
- Produces:
  - `getSessionContext(): Promise<SessionContext | null>` (no redirect).
  - `GET /api/catalogue/search?kind=medicine|complaint|diagnosis|history|test&q=...` → `200 { medicines: MedicineHit[] }` or `200 { terms: string[] }`; `401 { error: "unauthenticated" }`; `403 { error: "forbidden" }`; `400 { error: "invalid" }`. Always `Cache-Control: private, no-store`.
  - `type ActionFailure = { ok: false; code: string; message: string; field?: string; currentRevision?: number }`; `type AutosaveResponse = { ok: true; revision: number; savedAt: string } | ActionFailure`; `type FinalizeResponse = { ok: true; rxNo: number } | (ActionFailure & { revision?: number; savedAt?: string })`.
  - `autosaveDraftAction(prescriptionId: string, payload: unknown, baseRevision: number): Promise<AutosaveResponse>`; `finalizeDraftAction(prescriptionId: string, payload: unknown, baseRevision: number): Promise<FinalizeResponse>`.
  - `type CatalogueActionResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string; field?: string }`; `saveFavouriteAction(line: unknown): Promise<CatalogueActionResult<FavouriteView>>`; `removeFavouriteAction(id: string): Promise<CatalogueActionResult<null>>`; `addClinicMedicineAction(raw: unknown): Promise<CatalogueActionResult<{ id: string; created: boolean }>>`.
  - A signed-out caller gets `code: "unauthenticated"` from every editor action (never a redirect).

- [ ] **Step 1: Write the failing test**

`tests/integration/editor-endpoints.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));

import { getSessionContext } from "@/server/auth/session";
import { GET } from "@/app/api/catalogue/search/route";
import { autosaveDraftAction, finalizeDraftAction } from "@/server/actions/drafts";
import { addClinicMedicineAction, removeFavouriteAction, saveFavouriteAction } from "@/server/actions/catalogue";
import { createPatient } from "@/server/services/patients";
import { getPrescription, startPrescription } from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let A: TestTenant;
let patientId = "";

beforeAll(async () => {
  A = await createTestTenant("endp");
  const p = await createPatient(A.as("reception"), { name: "Endpoint Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});

afterAll(async () => {
  await A.cleanup();
});

beforeEach(() => {
  session.mockReset();
});

const search = (query: string) => GET(new Request(`http://localhost/api/catalogue/search?${query}`));

async function newDraft(): Promise<string> {
  const r = await startPrescription(A.as("doctor"), { patientId });
  if (!r.ok) throw new Error(r.message);
  return r.value.prescriptionId;
}

describe("GET /api/catalogue/search", () => {
  it("answers 401 without a session", async () => {
    session.mockResolvedValue(null);
    const res = await search("q=dolo");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("answers 403 for roles without catalogue access", async () => {
    session.mockResolvedValue(A.as("reception"));
    expect((await search("q=dolo")).status).toBe(403);
  });

  it("returns medicines for a doctor and is never cached", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const added = await addClinicMedicineAction({ name: `ROUTE${stamp} SYRUP` });
    expect(added.ok).toBe(true);

    const res = await search(`kind=medicine&q=${encodeURIComponent(`route${stamp}`)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { medicines: { name: string; source: string }[] };
    expect(body.medicines).toEqual([expect.objectContaining({ name: `ROUTE${stamp} SYRUP`, source: "clinic" })]);
  });

  it("returns term suggestions, and rejects unknown kinds", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const empty = await search("kind=complaint&q=");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ terms: [] });
    expect((await search("kind=spell&q=x")).status).toBe(400);
  });
});

describe("autosaveDraftAction", () => {
  it("reports a signed-out user instead of redirecting", async () => {
    session.mockResolvedValue(null);
    expect(await autosaveDraftAction(await newDraft(), { advice: "x" }, 0)).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
  });

  it("saves with revisions and reports a stale revision with the current one", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    const first = await autosaveDraftAction(id, { advice: "first" }, 0);
    expect(first).toMatchObject({ ok: true, revision: 1 });
    expect(first.ok && typeof first.savedAt).toBe("string");
    expect(await autosaveDraftAction(id, { advice: "stale" }, 0)).toEqual({
      ok: false,
      code: "conflict",
      message: "This draft was changed in another window or device.",
      currentRevision: 1,
    });
  });

  it("passes field errors through and refuses roles that cannot draft", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    expect(await autosaveDraftAction(id, { vitals: { pulse: 999 } }, 0)).toMatchObject({
      ok: false,
      code: "invalid",
      field: "vitals",
    });
    session.mockResolvedValue(A.as("reception"));
    expect(await autosaveDraftAction(id, { advice: "x" }, 0)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("finalizeDraftAction", () => {
  it("saves the snapshot on screen and finalizes exactly that revision", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    await autosaveDraftAction(id, { advice: "draft" }, 0);
    const done = await finalizeDraftAction(id, { advice: "final", items: [{ drugName: "Paracetamol" }] }, 1);
    expect(done).toMatchObject({ ok: true, rxNo: expect.any(Number) });
    const rx = await getPrescription(A.as("doctor"), id);
    expect(rx.ok && rx.value).toMatchObject({ status: "finalized", visit: { advice: "final" } });
  });

  it("returns the new revision when finalizing fails after the save", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    expect(await finalizeDraftAction(id, { advice: "no medicines" }, 0)).toMatchObject({
      ok: false,
      code: "invalid",
      field: "items",
      revision: 1,
    });
  });

  it("refuses a stale snapshot without finalizing", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    await autosaveDraftAction(id, { items: [{ drugName: "Newer" }] }, 0);
    expect(await finalizeDraftAction(id, { items: [{ drugName: "Older" }] }, 0)).toMatchObject({
      ok: false,
      code: "conflict",
      currentRevision: 1,
    });
    const rx = await getPrescription(A.as("doctor"), id);
    expect(rx.ok && rx.value.status).toBe("draft");
  });
});

describe("catalogue actions", () => {
  it("saves and removes a favourite for the signed-in prescriber", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const saved = await saveFavouriteAction({ drugName: `FAV${stamp}`, doseNight: 1 });
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.value).toMatchObject({ drugName: `FAV${stamp}`, doseNight: 1 });
    expect(await removeFavouriteAction(saved.value.id)).toEqual({ ok: true, value: null });
  });

  it("reports a signed-out user", async () => {
    session.mockResolvedValue(null);
    expect(await saveFavouriteAction({ drugName: "X" })).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await removeFavouriteAction("x")).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await addClinicMedicineAction({ name: "Xyz" })).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/editor-endpoints.test.ts
```

Expected: FAIL — the route and action modules cannot be resolved.

- [ ] **Step 3: Add the non-redirecting session helper**

In `src/server/auth/session.ts`, append:

```ts
/**
 * Like requireSession, but returns null instead of redirecting. For route handlers that
 * answer with JSON and for editor actions, where a redirect would navigate away from
 * unsaved edits.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId || !session.user.role) return null;
  return {
    userId: session.user.id,
    tenantId: session.user.tenantId,
    role: session.user.role,
  };
}
```

- [ ] **Step 4: Add the search route**

`src/app/api/catalogue/search/route.ts`:

```ts
import { getSessionContext } from "@/server/auth/session";
import { searchMedicines, suggestTerms } from "@/server/services/catalogue";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store" };
const STATUS: Record<string, number> = { forbidden: 403, invalid: 400, not_found: 404 };

/**
 * Typeahead for the clinical editor. A GET route rather than a server action because
 * React runs server actions one at a time and they cannot be cancelled.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSessionContext();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401, headers: HEADERS });

  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") ?? "medicine";
  const q = params.get("q") ?? "";

  if (kind === "medicine") {
    const result = await searchMedicines(session, { q, limit: 20 });
    return result.ok
      ? Response.json({ medicines: result.value }, { headers: HEADERS })
      : Response.json({ error: result.code }, { status: STATUS[result.code] ?? 400, headers: HEADERS });
  }

  const result = await suggestTerms(session, { kind, q, limit: 15 });
  return result.ok
    ? Response.json({ terms: result.value }, { headers: HEADERS })
    : Response.json({ error: result.code }, { status: STATUS[result.code] ?? 400, headers: HEADERS });
}
```

- [ ] **Step 5: Add the editor server actions**

`src/server/actions/drafts.ts`:

```ts
"use server";

import { getSessionContext } from "@/server/auth/session";
import { finalizePrescription, saveDraft } from "@/server/services/prescriptions";

export type ActionFailure = {
  ok: false;
  code: string;
  message: string;
  field?: string;
  currentRevision?: number;
};
export type AutosaveResponse = { ok: true; revision: number; savedAt: string } | ActionFailure;
export type FinalizeResponse = { ok: true; rxNo: number } | (ActionFailure & { revision?: number; savedAt?: string });

const SIGNED_OUT: ActionFailure = { ok: false, code: "unauthenticated", message: "You were signed out." };

function failure(result: { code: string; message: string; field?: string; currentRevision?: number }): ActionFailure {
  const out: ActionFailure = { ok: false, code: result.code, message: result.message };
  if (result.field) out.field = result.field;
  if (typeof result.currentRevision === "number") out.currentRevision = result.currentRevision;
  return out;
}

/** Saves a full draft snapshot based on `baseRevision`. Never redirects. */
export async function autosaveDraftAction(
  prescriptionId: string,
  payload: unknown,
  baseRevision: number,
): Promise<AutosaveResponse> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  const result = await saveDraft(session, prescriptionId, payload, { baseRevision });
  if (!result.ok) return failure(result);
  return { ok: true, revision: result.value.revision, savedAt: result.value.savedAt.toISOString() };
}

/**
 * Saves the snapshot the doctor is looking at, then finalizes exactly that revision, so a
 * save from another window in between makes finalize fail instead of finalizing unseen
 * content. Never redirects; the client refreshes the page on success.
 */
export async function finalizeDraftAction(
  prescriptionId: string,
  payload: unknown,
  baseRevision: number,
): Promise<FinalizeResponse> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  const saved = await saveDraft(session, prescriptionId, payload, { baseRevision });
  if (!saved.ok) return failure(saved);
  const done = await finalizePrescription(session, prescriptionId, { expectedRevision: saved.value.revision });
  if (!done.ok) {
    return { ...failure(done), revision: saved.value.revision, savedAt: saved.value.savedAt.toISOString() };
  }
  return { ok: true, rxNo: done.value.rxNo };
}
```

`src/server/actions/catalogue.ts`:

```ts
"use server";

import { getSessionContext } from "@/server/auth/session";
import {
  addClinicMedicine,
  removeFavourite,
  saveFavourite,
  type FavouriteView,
} from "@/server/services/catalogue";

export type CatalogueActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; field?: string };

const SIGNED_OUT = {
  ok: false as const,
  code: "unauthenticated",
  message: "You were signed out. Sign in again, then retry.",
};

export async function saveFavouriteAction(line: unknown): Promise<CatalogueActionResult<FavouriteView>> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  return saveFavourite(session, line);
}

export async function removeFavouriteAction(id: string): Promise<CatalogueActionResult<null>> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  return removeFavourite(session, String(id));
}

export async function addClinicMedicineAction(
  raw: unknown,
): Promise<CatalogueActionResult<{ id: string; created: boolean }>> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  return addClinicMedicine(session, raw);
}
```

- [ ] **Step 6: Keep the desktop build working**

In `scripts/build-desktop.mjs`, add `"src/app/api/catalogue",` to the `SERVER_ONLY` array directly after `"src/app/api/health",`. The route needs a server and Postgres, so it cannot be part of the static export (AGENTS.md §10: a server-only route outside `(app)` must be listed). The route is not covered by `src/middleware.ts` (its matcher lists only `/dashboard`, `/patients`, `/settings`); it authenticates itself through `getSessionContext()` and answers `401` without a session.

- [ ] **Step 7: Run the tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/editor-endpoints.test.ts
npm run typecheck
```

Expected: all PASS; typecheck exits 0. The file runs in the Node environment (first-line comment) so `Request`/`Response` are Node's.

- [ ] **Step 8: Full suite, desktop build, commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
npm run build:desktop
git status --short
git add src/server/auth/session.ts src/app/api/catalogue/search/route.ts src/server/actions/drafts.ts src/server/actions/catalogue.ts scripts/build-desktop.mjs tests/integration/editor-endpoints.test.ts
git commit -m "feat: add catalogue search route and non-redirecting editor actions" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: `build:desktop` exits 0 and `git status --short` shows no stashed or moved files (only the files this task created or changed).

---

## Task 8: Editor state model and the autosave engine (pure, TDD)

**Files:**
- Create: `src/lib/rx/editor-state.ts`, `src/lib/rx/autosave.ts`
- Test: `tests/unit/editor-state.test.ts`, `tests/unit/autosave.test.ts`

**Interfaces:**
- Consumes: Task 1 (`formatSchedule`, `parseSchedule`, `DurationUnit`), Task 3 types `ClinicalVisitView`, `ItemView` (type-only import), Task 6 types `FavouriteView`, `MedicineHit` (type-only import).
- Produces (`src/lib/rx/editor-state.ts`):
  - `VITAL_KEYS`, `type VitalKey`, `type EditorMedicine`, `type EditorInvestigation`, `type EditorState`, `type ItemPayload`, `type DraftPayload`.
  - `newKey(): string`; `emptyMedicine(): EditorMedicine`; `medicineFrom(source: MedicineLike, key?: string): EditorMedicine` (`MedicineLike = Omit<FavouriteView, "id">`, which `ItemView` also satisfies); `applyHit(current: EditorMedicine, hit: MedicineHit): EditorMedicine`; `applySchedulePreset(m: EditorMedicine, pattern: string): EditorMedicine`; `scheduleLabel(m: EditorMedicine): string`; `isBlankMedicine(m: EditorMedicine): boolean`; `numberOrRaw(value: string): number | string | null`; `editorStateFromView(view: { visit: ClinicalVisitView; items: ItemView[] }): EditorState`; `toItemPayload(m: EditorMedicine): ItemPayload`; `toDraftPayload(s: EditorState): DraftPayload`.
- Produces (`src/lib/rx/autosave.ts`):
  - `type SaveOutcome = { kind: "saved"; revision: number; savedAt: string } | { kind: "conflict"; currentRevision: number; message: string } | { kind: "invalid"; message: string; field?: string } | { kind: "locked"; message: string }`.
  - `type AutosaveStatus = { state: "saved"; savedAt: string | null } | { state: "pending" } | { state: "saving" } | { state: "retrying"; message: string; retryInMs: number } | { state: "invalid"; message: string; field?: string } | { state: "conflict"; message: string; currentRevision: number } | { state: "locked"; message: string }`.
  - `class RetryableSaveError extends Error`; `OFFLINE_MESSAGE`; `SIGNED_OUT_MESSAGE`.
  - `createAutosaver<T>(options: { initial: T; initialRevision: number; save: (snapshot: T, baseRevision: number) => Promise<SaveOutcome>; onStatus: (s: AutosaveStatus) => void; debounceMs?: number; maxWaitMs?: number; maxRetryMs?: number }): Autosaver<T>` with methods `update(snapshot)`, `flush(): Promise<void>`, `retryNow()`, `overwrite()`, `exclusive<R>(fn: (snapshot: T, baseRevision: number) => Promise<{ revision: number | null; savedAt?: string; value: R }>): Promise<R>`, `hasUnsavedChanges(): boolean`, `dispose()`.
  - `outcomeFromResponse(res: SaveResponseLike): SaveOutcome` (throws `RetryableSaveError` for `unauthenticated`), where `SaveResponseLike` matches Task 7's `AutosaveResponse`.

**The rule these tests pin (decision 7):** a save is a full snapshot plus the revision it was based on; only one save is in flight; edits made meanwhile are sent next, in order, based on the revision the previous save returned; network failures keep every edit and retry with backoff (1 s doubling to 30 s) while the status says "not saved"; a conflict or a locked prescription stops automatic saving; an invalid snapshot stops saving until the next edit; finalize runs exclusively after the in-flight save.

**Row identity:** the server's item ids change on every save (`saveDraft` deletes and re-inserts the items) and `ItemView` does not carry them, so the editor never uses server ids. Every medicine and test row has a client-side `key` (`init-…` for rows loaded from the server, `new-…` for rows added in the browser) that stays stable for the life of the page and is the React key; this also replaces Plan 1A's index keys.

- [ ] **Step 1: Write the failing tests**

`tests/unit/editor-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyHit,
  applySchedulePreset,
  editorStateFromView,
  emptyMedicine,
  isBlankMedicine,
  medicineFrom,
  numberOrRaw,
  scheduleLabel,
  toDraftPayload,
} from "@/lib/rx/editor-state";
import type { ClinicalVisitView, ItemView } from "@/server/services/rx-mapping";
import type { FavouriteView, MedicineHit } from "@/server/services/catalogue";

const visit: ClinicalVisitView = {
  id: "visit-1",
  visitType: "follow-up",
  chiefComplaint: "Fever",
  complaints: ["Fever"],
  diagnosis: ["Viral fever"],
  medicalHistory: ["DM"],
  drugHistory: [],
  examinationNotes: null,
  vitals: { pulse: 92, bpSystolic: 130, bpDiastolic: 85, notes: "sitting" },
  investigations: [{ name: "CBC" }],
  advice: null,
  followUpDate: "2026-12-01",
  followUpReason: null,
};

const item: ItemView = {
  drugName: "DOLO 650MG",
  genericName: "Paracetamol 650Mg",
  strength: null,
  form: "tablet",
  route: null,
  dose: "1 tab",
  doseMorning: 1,
  doseAfternoon: 0,
  doseEvening: null,
  doseNight: 1,
  timing: null,
  foodRelation: "after",
  periodicity: null,
  isSos: false,
  durationValue: 5,
  durationUnit: "days",
  durationDays: 5,
  remarks: null,
};

const favourite: FavouriteView = {
  id: "fav-1",
  drugName: "AZI OD 500 TAB",
  genericName: "Azithromycin 500Mg",
  strength: null,
  form: null,
  route: null,
  dose: "1 tab",
  doseMorning: 1,
  doseAfternoon: 0,
  doseEvening: null,
  doseNight: 0,
  timing: null,
  foodRelation: "before",
  periodicity: "daily",
  isSos: false,
  durationValue: 3,
  durationUnit: "days",
  remarks: null,
};

describe("editorStateFromView / toDraftPayload", () => {
  it("turns a saved view into form strings and back into the same payload", () => {
    const state = editorStateFromView({ visit, items: [item] });
    expect(state.visitType).toBe("follow-up");
    expect(state.vitals.pulse).toBe("92");
    expect(state.vitals.spo2).toBe("");
    expect(state.vitalsNotes).toBe("sitting");
    expect(state.medicines[0]).toMatchObject({ doseMorning: "1", doseEvening: "", durationValue: "5", form: "tablet" });

    const payload = toDraftPayload(state);
    expect(payload.vitals).toEqual({ bpSystolic: 130, bpDiastolic: 85, pulse: 92, notes: "sitting" });
    expect(payload.items).toEqual([
      expect.objectContaining({
        drugName: "DOLO 650MG",
        genericName: "Paracetamol 650Mg",
        form: "tablet",
        doseMorning: 1,
        doseAfternoon: 0,
        doseEvening: null,
        doseNight: 1,
        durationValue: 5,
        durationUnit: "days",
        foodRelation: "after",
      }),
    ]);
    expect(payload.investigations).toEqual([{ name: "CBC", instructions: "" }]);
    expect(payload.followUpDate).toBe("2026-12-01");
  });

  it("starts an empty prescription with one blank medicine row and sends no items", () => {
    const state = editorStateFromView({ visit: { ...visit, investigations: [] }, items: [] });
    expect(state.medicines).toHaveLength(1);
    expect(isBlankMedicine(state.medicines[0])).toBe(true);
    expect(toDraftPayload(state).items).toEqual([]);
  });

  it("drops blank rows but keeps half-filled ones so the server can flag them", () => {
    const state = editorStateFromView({ visit, items: [] });
    state.medicines = [emptyMedicine(), { ...emptyMedicine(), dose: "1 tab" }, { ...emptyMedicine(), isSos: true }];
    state.investigations = [
      { key: "a", name: "", instructions: "" },
      { key: "b", name: "", instructions: "fasting" },
    ];
    const payload = toDraftPayload(state);
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({ drugName: "", dose: "1 tab" });
    expect(payload.investigations).toEqual([{ name: "", instructions: "fasting" }]);
  });

  it("never silently drops what was typed into a number field", () => {
    expect(numberOrRaw("")).toBeNull();
    expect(numberOrRaw("   ")).toBeNull();
    expect(numberOrRaw("98.6")).toBe(98.6);
    expect(numberOrRaw(" 7 ")).toBe(7);
    expect(numberOrRaw("abc")).toBe("abc");
    const state = editorStateFromView({ visit, items: [] });
    state.vitals.pulse = "9O";
    expect(toDraftPayload(state).vitals.pulse).toBe("9O");
  });
});

describe("medicine row helpers", () => {
  it("applies schedule presets and labels the schedule", () => {
    const m = applySchedulePreset(emptyMedicine(), "½-0-½");
    expect(m).toMatchObject({ doseMorning: "0.5", doseAfternoon: "0", doseEvening: "", doseNight: "0.5" });
    expect(scheduleLabel(m)).toBe("½-0-½");
    expect(applySchedulePreset(m, "TDS")).toBe(m);
    expect(scheduleLabel(emptyMedicine())).toBe("");
  });

  it("fills only the name from a catalogue hit, and the whole line from a favourite", () => {
    const row = { ...emptyMedicine(), dose: "2 tab" };
    const hit: MedicineHit = { source: "global", id: "g1", name: "DOLO 650MG", genericName: "Paracetamol 650Mg", favourite: null };
    expect(applyHit(row, hit)).toMatchObject({ key: row.key, drugName: "DOLO 650MG", genericName: "Paracetamol 650Mg", dose: "2 tab" });

    const fromFavourite = applyHit(row, { ...hit, source: "favourite", name: favourite.drugName, favourite });
    expect(fromFavourite).toMatchObject({
      key: row.key,
      drugName: "AZI OD 500 TAB",
      dose: "1 tab",
      doseNight: "0",
      foodRelation: "before",
      periodicity: "daily",
      durationValue: "3",
    });
  });

  it("copies every field of an item or favourite into a row", () => {
    expect(medicineFrom(favourite, "k-fixed")).toEqual({
      key: "k-fixed",
      drugName: "AZI OD 500 TAB",
      genericName: "Azithromycin 500Mg",
      strength: "",
      form: "",
      route: "",
      dose: "1 tab",
      doseMorning: "1",
      doseAfternoon: "0",
      doseEvening: "",
      doseNight: "0",
      timing: "",
      foodRelation: "before",
      periodicity: "daily",
      isSos: false,
      durationValue: "3",
      durationUnit: "days",
      remarks: "",
    });
  });

  it("gives every new row a key that never collides with rows loaded from the server", () => {
    const loaded = editorStateFromView({ visit, items: [item, item] }).medicines.map((m) => m.key);
    const fresh = Array.from({ length: 50 }, () => emptyMedicine().key);
    expect(new Set([...loaded, ...fresh]).size).toBe(52);
  });

  it("treats an SOS tick alone as content", () => {
    expect(isBlankMedicine({ ...emptyMedicine(), isSos: true })).toBe(false);
  });
});
```

`tests/unit/autosave.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutosaver,
  OFFLINE_MESSAGE,
  outcomeFromResponse,
  RetryableSaveError,
  SIGNED_OUT_MESSAGE,
  type AutosaveStatus,
  type SaveOutcome,
} from "@/lib/rx/autosave";

type Snap = { text: string };
type Call = { snapshot: Snap; base: number; resolve: (o: SaveOutcome) => void; reject: (e: unknown) => void };

function harness(initialRevision = 0) {
  const calls: Call[] = [];
  const statuses: AutosaveStatus[] = [];
  const saver = createAutosaver<Snap>({
    initial: { text: "" },
    initialRevision,
    save: (snapshot, base) =>
      new Promise<SaveOutcome>((resolve, reject) => {
        calls.push({ snapshot, base, resolve, reject });
      }),
    onStatus: (s) => statuses.push(s),
  });
  return { saver, calls, statuses, last: () => statuses[statuses.length - 1] };
}

const saved = (revision: number): SaveOutcome => ({ kind: "saved", revision, savedAt: `2026-11-12T10:00:0${revision}.000Z` });

/** Lets promise callbacks run (fake timers do not fake microtasks). */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createAutosaver", () => {
  it("waits for a pause in typing, then saves the latest snapshot once", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(300);
    h.saver.update({ text: "ab" });
    await vi.advanceTimersByTimeAsync(300);
    h.saver.update({ text: "abc" });
    expect(h.last()).toEqual({ state: "pending" });

    await vi.advanceTimersByTimeAsync(799);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ snapshot: { text: "abc" }, base: 0 });
    expect(h.last()).toEqual({ state: "saving" });
    expect(h.saver.hasUnsavedChanges()).toBe(true);

    h.calls[0].resolve(saved(1));
    await settle();
    expect(h.last()).toEqual({ state: "saved", savedAt: "2026-11-12T10:00:01.000Z" });
    expect(h.saver.hasUnsavedChanges()).toBe(false);
  });

  it("saves at least every 5 seconds during continuous typing", async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      h.saver.update({ text: `t${i}` });
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.calls[0].snapshot.text).toMatch(/^t1[0-9]$|^t[0-9]$/);
  });

  it("never runs two saves at once and sends newer edits next, in order, on the new revision", async () => {
    const h = harness();
    h.saver.update({ text: "one" });
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls).toHaveLength(1);

    h.saver.update({ text: "two" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1); // still in flight: no overlap

    h.calls[0].resolve(saved(1));
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ snapshot: { text: "two" }, base: 1 });

    h.calls[1].resolve(saved(2));
    await settle();
    expect(h.last()).toMatchObject({ state: "saved" });
    expect(h.calls.map((c) => [c.snapshot.text, c.base])).toEqual([
      ["one", 0],
      ["two", 1],
    ]);
  });

  it("keeps edits through a network failure, backs off, and saves the latest snapshot when back", async () => {
    const h = harness();
    h.saver.update({ text: "offline 1" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    expect(h.last()).toEqual({ state: "retrying", message: OFFLINE_MESSAGE, retryInMs: 1000 });
    expect(h.saver.hasUnsavedChanges()).toBe(true);

    h.saver.update({ text: "offline 2" });
    expect(h.last()).toMatchObject({ state: "retrying" }); // still clearly not saved

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].snapshot).toEqual({ text: "offline 2" });
    h.calls[1].reject(new TypeError("Failed to fetch"));
    await settle();
    expect(h.last()).toMatchObject({ state: "retrying", retryInMs: 2000 });

    await vi.advanceTimersByTimeAsync(1999);
    expect(h.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(3);
    h.calls[2].resolve(saved(1));
    await settle();
    expect(h.last()).toMatchObject({ state: "saved" });
    expect(h.calls.every((c) => c.base === 0)).toBe(true);
  });

  it("caps the retry delay at 30 seconds", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      h.calls[i].reject(new TypeError("Failed to fetch"));
      await settle();
      const status = h.last();
      if (status.state !== "retrying") throw new Error("expected retrying");
      delays.push(status.retryInMs);
      await vi.advanceTimersByTimeAsync(status.retryInMs);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("retries at once when asked (the browser came back online)", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new TypeError("Failed to fetch"));
    await settle();
    h.saver.retryNow();
    expect(h.calls).toHaveLength(2);
  });

  it("shows the message of a retryable server error", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].reject(new RetryableSaveError("Signed out, retrying"));
    await settle();
    expect(h.last()).toMatchObject({ state: "retrying", message: "Signed out, retrying" });
  });

  it("stops on a conflict, keeps the local copy, and overwrites only when asked", async () => {
    const h = harness();
    h.saver.update({ text: "mine" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].resolve({ kind: "conflict", currentRevision: 7, message: "Changed elsewhere" });
    await settle();
    expect(h.last()).toEqual({ state: "conflict", message: "Changed elsewhere", currentRevision: 7 });

    h.saver.update({ text: "mine 2" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);
    expect(h.saver.hasUnsavedChanges()).toBe(true);

    h.saver.overwrite();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ snapshot: { text: "mine 2" }, base: 7 });
  });

  it("waits for the next edit after the server rejects the latest snapshot", async () => {
    const h = harness();
    h.saver.update({ text: "bad" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].resolve({ kind: "invalid", message: "Pulse must be at most 250", field: "vitals" });
    await settle();
    expect(h.last()).toEqual({ state: "invalid", message: "Pulse must be at most 250", field: "vitals" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);

    h.saver.update({ text: "fixed" });
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].snapshot).toEqual({ text: "fixed" });
  });

  it("keeps going when an older snapshot is rejected but a newer one is waiting", async () => {
    const h = harness();
    h.saver.update({ text: "bad" });
    await vi.advanceTimersByTimeAsync(800);
    h.saver.update({ text: "fixed" });
    h.calls[0].resolve({ kind: "invalid", message: "Bad value" });
    await settle();
    expect(h.last()).toEqual({ state: "pending" });
    await vi.advanceTimersByTimeAsync(800);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].snapshot).toEqual({ text: "fixed" });
  });

  it("stops for good when the prescription is locked", async () => {
    const h = harness();
    h.saver.update({ text: "late" });
    await vi.advanceTimersByTimeAsync(800);
    h.calls[0].resolve({ kind: "locked", message: "Finalized elsewhere" });
    await settle();
    h.saver.update({ text: "later" });
    h.saver.retryNow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
    expect(h.last()).toEqual({ state: "locked", message: "Finalized elsewhere" });
  });

  it("saves immediately on flush", async () => {
    const h = harness();
    h.saver.update({ text: "now" });
    const flushed = h.saver.flush();
    expect(h.calls).toHaveLength(1);
    h.calls[0].resolve(saved(1));
    await settle();
    await flushed;
    expect(h.last()).toMatchObject({ state: "saved" });
  });

  it("runs finalize exclusively after the in-flight save, with the latest snapshot and revision", async () => {
    const h = harness();
    h.saver.update({ text: "a" });
    await vi.advanceTimersByTimeAsync(800);
    h.saver.update({ text: "b" });

    const fn = vi.fn(async (snapshot: Snap, base: number) => ({ revision: 5, value: `${snapshot.text}@${base}` }));
    const result = h.saver.exclusive(fn);
    await settle();
    expect(fn).not.toHaveBeenCalled();

    h.calls[0].resolve(saved(1));
    await settle();
    expect(await result).toBe("b@1");
    expect(h.calls).toHaveLength(1); // "b" went with the exclusive call, not a separate autosave
    expect(h.last()).toMatchObject({ state: "saved" });
    expect(h.saver.hasUnsavedChanges()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1);
  });

  it("does nothing after dispose", async () => {
    const h = harness();
    h.saver.update({ text: "x" });
    h.saver.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(0);
    expect(h.saver.hasUnsavedChanges()).toBe(false);
  });
});

describe("outcomeFromResponse", () => {
  it("maps server responses to outcomes", () => {
    expect(outcomeFromResponse({ ok: true, revision: 3, savedAt: "t" })).toEqual({ kind: "saved", revision: 3, savedAt: "t" });
    expect(outcomeFromResponse({ ok: false, code: "conflict", message: "m", currentRevision: 4 })).toEqual({
      kind: "conflict",
      currentRevision: 4,
      message: "m",
    });
    expect(outcomeFromResponse({ ok: false, code: "conflict", message: "m" })).toEqual({ kind: "locked", message: "m" });
    expect(outcomeFromResponse({ ok: false, code: "invalid", message: "m", field: "vitals" })).toEqual({
      kind: "invalid",
      message: "m",
      field: "vitals",
    });
    expect(outcomeFromResponse({ ok: false, code: "immutable", message: "m" })).toEqual({ kind: "locked", message: "m" });
    expect(outcomeFromResponse({ ok: false, code: "forbidden", message: "m" })).toEqual({ kind: "locked", message: "m" });
  });

  it("treats a signed-out user as retryable", () => {
    expect(() => outcomeFromResponse({ ok: false, code: "unauthenticated", message: "m" })).toThrow(RetryableSaveError);
    expect(() => outcomeFromResponse({ ok: false, code: "unauthenticated", message: "m" })).toThrow(SIGNED_OUT_MESSAGE);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/editor-state.test.ts tests/unit/autosave.test.ts
```

Expected: FAIL — modules cannot be resolved.

- [ ] **Step 3: Implement the editor state model**

`src/lib/rx/editor-state.ts`:

```ts
import { formatSchedule, parseSchedule } from "@/lib/domain/rx-format";
import type { DurationUnit } from "@/lib/domain/rx-options";
import type { FavouriteView, MedicineHit } from "@/server/services/catalogue";
import type { ClinicalVisitView, ItemView } from "@/server/services/rx-mapping";

export const VITAL_KEYS = [
  "bpSystolic",
  "bpDiastolic",
  "pulse",
  "temperatureF",
  "spo2",
  "respiratoryRate",
  "weightKg",
  "heightCm",
  "bloodSugarMgDl",
] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];

/** One medicine row as the form holds it: every input is a string; `key` is for React only. */
export type EditorMedicine = {
  key: string;
  drugName: string;
  genericName: string;
  strength: string;
  form: string;
  route: string;
  dose: string;
  doseMorning: string;
  doseAfternoon: string;
  doseEvening: string;
  doseNight: string;
  timing: string;
  foodRelation: string;
  periodicity: string;
  isSos: boolean;
  durationValue: string;
  durationUnit: DurationUnit;
  remarks: string;
};

export type EditorInvestigation = { key: string; name: string; instructions: string };

export type EditorState = {
  visitType: "new" | "follow-up";
  chiefComplaint: string;
  complaints: string[];
  diagnosis: string[];
  medicalHistory: string[];
  drugHistory: string[];
  examinationNotes: string;
  vitals: Record<VitalKey, string>;
  vitalsNotes: string;
  investigations: EditorInvestigation[];
  medicines: EditorMedicine[];
  advice: string;
  followUpDate: string;
  followUpReason: string;
};

export type ItemPayload = {
  drugName: string;
  genericName: string;
  strength: string;
  form: string;
  route: string;
  dose: string;
  doseMorning: number | string | null;
  doseAfternoon: number | string | null;
  doseEvening: number | string | null;
  doseNight: number | string | null;
  timing: string;
  foodRelation: string;
  periodicity: string;
  isSos: boolean;
  durationValue: number | string | null;
  durationUnit: DurationUnit;
  remarks: string;
};

export type DraftPayload = {
  visitType: "new" | "follow-up";
  chiefComplaint: string;
  complaints: string[];
  diagnosis: string[];
  medicalHistory: string[];
  drugHistory: string[];
  examinationNotes: string;
  vitals: Record<string, number | string>;
  investigations: { name: string; instructions: string }[];
  items: ItemPayload[];
  advice: string;
  followUpDate: string;
  followUpReason: string;
};

/** Anything with the fields of a prescription line: an ItemView or a FavouriteView. */
export type MedicineLike = Omit<FavouriteView, "id">;

let keySeq = 0;
/** Keys for rows created in the browser. Rows loaded from the server use "init-..." keys. */
export function newKey(): string {
  keySeq += 1;
  return `new-${keySeq}`;
}

const str = (value: string | number | null | undefined) => (value === null || value === undefined ? "" : String(value));
const unitOf = (value: string | null | undefined): DurationUnit =>
  value === "weeks" || value === "months" ? value : "days";

export function emptyMedicine(): EditorMedicine {
  return {
    key: newKey(),
    drugName: "",
    genericName: "",
    strength: "",
    form: "",
    route: "",
    dose: "",
    doseMorning: "",
    doseAfternoon: "",
    doseEvening: "",
    doseNight: "",
    timing: "",
    foodRelation: "",
    periodicity: "",
    isSos: false,
    durationValue: "",
    durationUnit: "days",
    remarks: "",
  };
}

export function medicineFrom(source: MedicineLike, key: string = newKey()): EditorMedicine {
  return {
    key,
    drugName: source.drugName,
    genericName: str(source.genericName),
    strength: str(source.strength),
    form: str(source.form),
    route: str(source.route),
    dose: str(source.dose),
    doseMorning: str(source.doseMorning),
    doseAfternoon: str(source.doseAfternoon),
    doseEvening: str(source.doseEvening),
    doseNight: str(source.doseNight),
    timing: str(source.timing),
    foodRelation: str(source.foodRelation),
    periodicity: str(source.periodicity),
    isSos: source.isSos,
    durationValue: str(source.durationValue),
    durationUnit: unitOf(source.durationUnit),
    remarks: str(source.remarks),
  };
}

/** Picking a catalogue hit fills the name; a favourite also fills its saved dosing. */
export function applyHit(current: EditorMedicine, hit: MedicineHit): EditorMedicine {
  if (hit.favourite) return medicineFrom(hit.favourite, current.key);
  return { ...current, drugName: hit.name, genericName: hit.genericName ?? "" };
}

export function applySchedulePreset(m: EditorMedicine, pattern: string): EditorMedicine {
  const s = parseSchedule(pattern);
  if (!s) return m;
  return {
    ...m,
    doseMorning: str(s.morning),
    doseAfternoon: str(s.afternoon),
    doseEvening: str(s.evening),
    doseNight: str(s.night),
  };
}

function slot(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function scheduleLabel(m: EditorMedicine): string {
  return formatSchedule({
    morning: slot(m.doseMorning),
    afternoon: slot(m.doseAfternoon),
    evening: slot(m.doseEvening),
    night: slot(m.doseNight),
  });
}

export function isBlankMedicine(m: EditorMedicine): boolean {
  if (m.isSos) return false;
  return [
    m.drugName,
    m.genericName,
    m.strength,
    m.form,
    m.route,
    m.dose,
    m.doseMorning,
    m.doseAfternoon,
    m.doseEvening,
    m.doseNight,
    m.timing,
    m.foodRelation,
    m.periodicity,
    m.durationValue,
    m.remarks,
  ].every((v) => v.trim() === "");
}

/** "" is null; a finite number is a number; anything else is sent as typed so the server reports it. */
export function numberOrRaw(value: string): number | string | null {
  const t = value.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

export function editorStateFromView(view: { visit: ClinicalVisitView; items: ItemView[] }): EditorState {
  const v = view.visit;
  const vitals = Object.fromEntries(VITAL_KEYS.map((k) => [k, str(v.vitals[k])])) as Record<VitalKey, string>;
  return {
    visitType: v.visitType === "follow-up" ? "follow-up" : "new",
    chiefComplaint: v.chiefComplaint ?? "",
    complaints: v.complaints,
    diagnosis: v.diagnosis,
    medicalHistory: v.medicalHistory,
    drugHistory: v.drugHistory,
    examinationNotes: v.examinationNotes ?? "",
    vitals,
    vitalsNotes: v.vitals.notes ?? "",
    investigations: v.investigations.map((t, i) => ({ key: `init-t${i}`, name: t.name, instructions: t.instructions ?? "" })),
    medicines: view.items.length > 0 ? view.items.map((item, i) => medicineFrom(item, `init-m${i}`)) : [emptyMedicine()],
    advice: v.advice ?? "",
    followUpDate: v.followUpDate ?? "",
    followUpReason: v.followUpReason ?? "",
  };
}

export function toItemPayload(m: EditorMedicine): ItemPayload {
  return {
    drugName: m.drugName,
    genericName: m.genericName,
    strength: m.strength,
    form: m.form,
    route: m.route,
    dose: m.dose,
    doseMorning: numberOrRaw(m.doseMorning),
    doseAfternoon: numberOrRaw(m.doseAfternoon),
    doseEvening: numberOrRaw(m.doseEvening),
    doseNight: numberOrRaw(m.doseNight),
    timing: m.timing,
    foodRelation: m.foodRelation,
    periodicity: m.periodicity,
    isSos: m.isSos,
    durationValue: numberOrRaw(m.durationValue),
    durationUnit: m.durationUnit,
    remarks: m.remarks,
  };
}

/** The full snapshot sent on every save. Completely blank rows are not sent. */
export function toDraftPayload(s: EditorState): DraftPayload {
  const vitals: Record<string, number | string> = {};
  for (const key of VITAL_KEYS) {
    const value = numberOrRaw(s.vitals[key]);
    if (value !== null) vitals[key] = value;
  }
  if (s.vitalsNotes.trim() !== "") vitals.notes = s.vitalsNotes;
  return {
    visitType: s.visitType,
    chiefComplaint: s.chiefComplaint,
    complaints: s.complaints,
    diagnosis: s.diagnosis,
    medicalHistory: s.medicalHistory,
    drugHistory: s.drugHistory,
    examinationNotes: s.examinationNotes,
    vitals,
    investigations: s.investigations
      .filter((t) => t.name.trim() !== "" || t.instructions.trim() !== "")
      .map((t) => ({ name: t.name, instructions: t.instructions })),
    items: s.medicines.filter((m) => !isBlankMedicine(m)).map(toItemPayload),
    advice: s.advice,
    followUpDate: s.followUpDate,
    followUpReason: s.followUpReason,
  };
}
```

- [ ] **Step 4: Implement the autosaver**

`src/lib/rx/autosave.ts`:

```ts
export type SaveOutcome =
  | { kind: "saved"; revision: number; savedAt: string }
  | { kind: "conflict"; currentRevision: number; message: string }
  | { kind: "invalid"; message: string; field?: string }
  | { kind: "locked"; message: string };

export type AutosaveStatus =
  | { state: "saved"; savedAt: string | null }
  | { state: "pending" }
  | { state: "saving" }
  | { state: "retrying"; message: string; retryInMs: number }
  | { state: "invalid"; message: string; field?: string }
  | { state: "conflict"; message: string; currentRevision: number }
  | { state: "locked"; message: string };

type HaltStatus = Extract<AutosaveStatus, { state: "invalid" | "conflict" | "locked" }>;

/** Thrown by a save function for failures that should be retried (for example a signed-out session). */
export class RetryableSaveError extends Error {}

export const OFFLINE_MESSAGE =
  "Not saved yet: no connection. Your changes are kept on this page and will be retried.";
export const SIGNED_OUT_MESSAGE = "You were signed out. Sign in again in another tab; saving will resume.";

export type AutosaverOptions<T> = {
  initial: T;
  initialRevision: number;
  /** Resolves with the server's answer; rejects (throws) on network failure. */
  save: (snapshot: T, baseRevision: number) => Promise<SaveOutcome>;
  onStatus: (status: AutosaveStatus) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  maxRetryMs?: number;
};

export type Autosaver<T> = {
  update(snapshot: T): void;
  flush(): Promise<void>;
  retryNow(): void;
  /** After a conflict: save the local copy over the newer server version (an explicit user choice). */
  overwrite(): void;
  /** Runs fn with the latest snapshot while automatic saving is paused (finalize uses this). */
  exclusive<R>(fn: (snapshot: T, baseRevision: number) => Promise<{ revision: number | null; savedAt?: string; value: R }>): Promise<R>;
  hasUnsavedChanges(): boolean;
  dispose(): void;
};

/**
 * Debounced, strictly sequential autosave of full snapshots with optimistic revisions.
 * Invariants: at most one save in flight; every save is based on the revision returned by
 * the previous successful save; an edit is never reported as saved until a save that
 * included it succeeded; failures never discard the latest snapshot.
 */
export function createAutosaver<T>(options: AutosaverOptions<T>): Autosaver<T> {
  const debounceMs = options.debounceMs ?? 800;
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const maxRetryMs = options.maxRetryMs ?? 30_000;

  let latest = options.initial;
  let revision = options.initialRevision;
  let editSeq = 0;
  let savedSeq = 0;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirtySince: number | null = null;
  let retryMs = 0;
  let halt: HaltStatus | null = null;
  let paused = 0;
  let disposed = false;

  const emit = (status: AutosaveStatus) => {
    if (!disposed) options.onStatus(status);
  };
  const unsaved = () => savedSeq !== editSeq;
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (delayMs: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, delayMs);
  };
  const debounceDelay = () => {
    const waited = dirtySince === null ? 0 : Date.now() - dirtySince;
    return Math.max(0, Math.min(debounceMs, maxWaitMs - waited));
  };

  function update(snapshot: T): void {
    if (disposed) return;
    latest = snapshot;
    editSeq += 1;
    if (halt?.state === "invalid") halt = null; // the new edit may fix the problem
    if (halt) return; // conflict or locked: keep the edit locally, never save it automatically
    if (dirtySince === null) dirtySince = Date.now();
    if (retryMs > 0) return; // keep showing "retrying"; the retry sends the latest snapshot
    emit({ state: "pending" });
    if (inFlight !== null || paused > 0) return; // re-checked when the current save finishes
    schedule(debounceDelay());
  }

  function apply(outcome: SaveOutcome, seq: number): void {
    switch (outcome.kind) {
      case "saved":
        revision = outcome.revision;
        savedSeq = seq;
        emit(unsaved() ? { state: "pending" } : { state: "saved", savedAt: outcome.savedAt });
        return;
      case "invalid":
        if (seq !== editSeq) {
          emit({ state: "pending" }); // a newer snapshot is waiting and may be fine
          return;
        }
        halt = outcome.field
          ? { state: "invalid", message: outcome.message, field: outcome.field }
          : { state: "invalid", message: outcome.message };
        emit(halt);
        return;
      case "conflict":
        halt = { state: "conflict", message: outcome.message, currentRevision: outcome.currentRevision };
        emit(halt);
        return;
      case "locked":
        halt = { state: "locked", message: outcome.message };
        emit(halt);
        return;
    }
  }

  async function send(snapshot: T, seq: number): Promise<void> {
    try {
      const outcome = await options.save(snapshot, revision);
      retryMs = 0;
      apply(outcome, seq);
    } catch (error) {
      retryMs = retryMs === 0 ? 1_000 : Math.min(retryMs * 2, maxRetryMs);
      const message = error instanceof RetryableSaveError && error.message ? error.message : OFFLINE_MESSAGE;
      emit({ state: "retrying", message, retryInMs: retryMs });
    }
  }

  async function attempt(): Promise<void> {
    if (disposed || halt || paused > 0 || inFlight !== null || !unsaved()) return;
    clearTimer();
    const snapshot = latest;
    const seq = editSeq;
    dirtySince = null;
    emit({ state: "saving" });
    const run = send(snapshot, seq);
    inFlight = run;
    try {
      await run;
    } finally {
      inFlight = null;
    }
    if (disposed || halt || paused > 0) return;
    if (retryMs > 0) schedule(retryMs);
    else if (unsaved()) schedule(debounceDelay());
  }

  async function flush(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      if (inFlight !== null) await inFlight;
      if (disposed || halt || paused > 0 || !unsaved()) return;
      retryMs = 0;
      await attempt();
      if (retryMs > 0) return; // still failing; the status already says so
    }
  }

  function retryNow(): void {
    if (disposed || halt || paused > 0 || inFlight !== null || !unsaved()) return;
    retryMs = 0;
    void attempt();
  }

  function overwrite(): void {
    if (disposed || halt?.state !== "conflict") return;
    revision = halt.currentRevision;
    halt = null;
    savedSeq = -1; // force a save of the local copy even if nothing changed since the conflict
    void attempt();
  }

  async function exclusive<R>(
    fn: (snapshot: T, baseRevision: number) => Promise<{ revision: number | null; savedAt?: string; value: R }>,
  ): Promise<R> {
    paused += 1;
    clearTimer();
    try {
      if (inFlight !== null) await inFlight;
      const seq = editSeq;
      const result = await fn(latest, revision);
      if (result.revision !== null) {
        revision = result.revision;
        savedSeq = seq;
        retryMs = 0;
        halt = null;
        emit(unsaved() ? { state: "pending" } : { state: "saved", savedAt: result.savedAt ?? new Date().toISOString() });
      }
      return result.value;
    } finally {
      paused -= 1;
      if (!disposed && paused === 0 && !halt && unsaved()) schedule(retryMs > 0 ? retryMs : debounceDelay());
    }
  }

  return {
    update,
    flush,
    retryNow,
    overwrite,
    exclusive,
    hasUnsavedChanges: () => !disposed && (unsaved() || inFlight !== null),
    dispose: () => {
      disposed = true;
      clearTimer();
    },
  };
}

/** Matches Task 7's AutosaveResponse without importing server code. */
export type SaveResponseLike =
  | { ok: true; revision: number; savedAt: string }
  | { ok: false; code: string; message: string; field?: string; currentRevision?: number };

export function outcomeFromResponse(res: SaveResponseLike): SaveOutcome {
  if (res.ok) return { kind: "saved", revision: res.revision, savedAt: res.savedAt };
  if (res.code === "unauthenticated") throw new RetryableSaveError(SIGNED_OUT_MESSAGE);
  if (res.code === "conflict" && typeof res.currentRevision === "number") {
    return { kind: "conflict", currentRevision: res.currentRevision, message: res.message };
  }
  if (res.code === "invalid") {
    return res.field ? { kind: "invalid", message: res.message, field: res.field } : { kind: "invalid", message: res.message };
  }
  // immutable, forbidden, not_found, or a conflict without a revision (already finalized).
  return { kind: "locked", message: res.message };
}
```

- [ ] **Step 5: Run the tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/editor-state.test.ts tests/unit/autosave.test.ts
npm run typecheck
```

Expected: all PASS; typecheck exits 0. If an autosave test times out or sees fewer calls than expected, a promise continuation has not run yet: add `await settle()` after resolving or rejecting a call rather than changing the expected numbers. Do not make two saves run concurrently to "speed up" a test.

- [ ] **Step 6: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/lib/rx/editor-state.ts src/lib/rx/autosave.ts tests/unit/editor-state.test.ts tests/unit/autosave.test.ts
git commit -m "feat: add the clinical editor state model and a sequential autosave engine" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 9: Editor building blocks — catalogue search hook, medicine combobox, schedule input, phrase list, medicine row

**Files:**
- Create: `src/components/rx/use-catalogue-search.ts`, `src/components/rx/medicine-combobox.tsx`, `src/components/rx/schedule-input.tsx`, `src/components/rx/term-list-input.tsx`, `src/components/rx/medicine-row.tsx`
- Test: `tests/unit/medicine-combobox.test.tsx`, `tests/unit/schedule-input.test.tsx`, `tests/unit/term-list-input.test.tsx`, `tests/unit/medicine-row.test.tsx`

**Interfaces:**
- Consumes: Task 7 route `GET /api/catalogue/search` (`{ medicines }` / `{ terms }`), Task 8 editor helpers (`applySchedulePreset`, `scheduleLabel`, `EditorMedicine`), Task 1 option lists, Task 6 `MedicineHit` (type only), `Input`, `Button`, `Badge` from `src/components/ui`.
- Produces:
  - `type SearchKind = "medicine" | TermKind`; `useCatalogueSearch(kind: SearchKind, query: string, active: boolean, delayMs?: number): { medicines: MedicineHit[]; terms: string[]; loading: boolean; failed: boolean }` (debounced 200 ms, aborts stale requests, `no-store`).
  - `<MedicineCombobox value onTextChange(value) onPick(hit) onAddToClinic?(name) />` — input labelled "Medicine name", ARIA combobox/listbox, arrow keys + Enter + Escape, an "Add “…” to the clinic list" option when nothing matches exactly.
  - `<ScheduleInput medicine onChange(patch) />` — preset buttons labelled `Schedule <preset>`, inputs labelled "Morning dose", "Afternoon dose", "Evening dose", "Night dose".
  - `<TermListInput label kind values onChange(values) max placeholder? />` — chips with `Remove <term>` buttons; Enter, comma, a suggestion click, or leaving the field adds the typed phrase; Backspace on an empty field removes the last chip; case-insensitive de-duplication; disabled at `max`.
  - `<MedicineRow index medicine canAddToClinic onPatch(patch) onPick(hit) onRemove() onSaveFavourite(): Promise<string> onAddToClinic(name): Promise<string> />` — labels "Generic name", "Strength", "Dose", "Food", "Duration", "Duration unit", "Periodicity", "Other frequency", "Remarks", checkbox "SOS (only if needed)", buttons "Save as favourite" and "Remove".

UI rule: use the shadcn `Input`, `Button`, `Badge` primitives and native `select`/`checkbox`/`input` elements (as Plan 1A does); no new UI library. Labels must be unique per row because Playwright selects by label.

- [ ] **Step 1: Write the failing component tests**

`tests/unit/medicine-combobox.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MedicineCombobox } from "@/components/rx/medicine-combobox";
import type { MedicineHit } from "@/server/services/catalogue";

const hits: MedicineHit[] = [
  { source: "favourite", id: "f1", name: "DOLO 650MG", genericName: "Paracetamol 650Mg", favourite: null },
  { source: "global", id: "g1", name: "DOLO 1000 TAB", genericName: "Paracetamol 1000Mg", favourite: null },
];

let body: { medicines: MedicineHit[] } = { medicines: hits };

beforeEach(() => {
  body = { medicines: hits };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(value = "dol") {
  const props = { onTextChange: vi.fn(), onPick: vi.fn(), onAddToClinic: vi.fn() };
  render(<MedicineCombobox value={value} {...props} />);
  return props;
}

describe("MedicineCombobox", () => {
  it("reports free text as typed", () => {
    const props = setup("");
    fireEvent.change(screen.getByRole("combobox", { name: "Medicine name" }), { target: { value: "Zebra syrup" } });
    expect(props.onTextChange).toHaveBeenCalledWith("Zebra syrup");
  });

  it("shows catalogue suggestions with their source and generic name", async () => {
    setup();
    fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
    const option = await screen.findByRole("option", { name: /DOLO 650MG/ });
    expect(option).toHaveTextContent("Favourite");
    expect(option).toHaveTextContent("Paracetamol 650Mg");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/catalogue/search?kind=medicine&q=dol");
  });

  it("picks with the keyboard", async () => {
    const props = setup();
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /DOLO 1000 TAB/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onPick).toHaveBeenCalledWith(hits[1]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("picks with the mouse and closes on Escape", async () => {
    const props = setup();
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: /DOLO 650MG/ }));
    expect(props.onPick).toHaveBeenCalledWith(hits[0]);

    fireEvent.focus(input);
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("offers to add an unknown medicine to the clinic list", async () => {
    body = { medicines: [] };
    const props = setup("Zebra syrup");
    fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
    fireEvent.click(await screen.findByRole("option", { name: /add “Zebra syrup” to the clinic list/i }));
    expect(props.onAddToClinic).toHaveBeenCalledWith("Zebra syrup");
  });

  it("does not offer to add a name that is already in the list", async () => {
    setup("dolo  650mg");
    fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
    await screen.findByRole("option", { name: /DOLO 650MG/ });
    expect(screen.queryByRole("option", { name: /clinic list/i })).not.toBeInTheDocument();
  });
});
```

`tests/unit/schedule-input.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScheduleInput } from "@/components/rx/schedule-input";
import { emptyMedicine } from "@/lib/rx/editor-state";

describe("ScheduleInput", () => {
  it("fills all four slots from a preset", () => {
    const onChange = vi.fn();
    render(<ScheduleInput medicine={emptyMedicine()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule 1-0-1" }));
    expect(onChange).toHaveBeenCalledWith({ doseMorning: "1", doseAfternoon: "0", doseEvening: "", doseNight: "1" });
  });

  it("edits one slot and shows the schedule summary", () => {
    const onChange = vi.fn();
    render(
      <ScheduleInput
        medicine={{ ...emptyMedicine(), doseMorning: "1", doseAfternoon: "0", doseNight: "0.5" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/1-0-½/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Night dose"), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith({ doseNight: "1" });
  });
});
```

`tests/unit/term-list-input.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { TermListInput } from "@/components/rx/term-list-input";

function Harness({ initial = [] as string[], max = 5 }) {
  const [values, setValues] = useState(initial);
  return <TermListInput label="Complaints" kind="complaint" values={values} onChange={setValues} max={max} />;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ terms: ["FEVER", "FEVER WITH CHILLS"] }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const input = () => screen.getByLabelText("Complaints");

describe("TermListInput", () => {
  it("adds a suggestion on click", async () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "fev" } });
    fireEvent.click(await screen.findByRole("option", { name: "FEVER WITH CHILLS" }));
    expect(screen.getByRole("button", { name: "Remove FEVER WITH CHILLS" })).toBeInTheDocument();
    expect(input()).toHaveValue("");
  });

  it("adds typed text on Enter or comma and ignores repeats in any case", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "Cough" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "cough" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "Cold" } });
    fireEvent.keyDown(input(), { key: "," });
    expect(screen.getAllByRole("button", { name: /^Remove / }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove Cough",
      "Remove Cold",
    ]);
  });

  it("keeps a typed phrase when the field loses focus", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "  Headache  " } });
    fireEvent.blur(input());
    expect(screen.getByRole("button", { name: "Remove Headache" })).toBeInTheDocument();
  });

  it("removes chips with the button or Backspace", () => {
    render(<Harness initial={["A", "B"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove A" }));
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.queryAllByRole("button", { name: /^Remove / })).toHaveLength(0);
  });

  it("stops at the limit", () => {
    render(<Harness initial={["A", "B"]} max={2} />);
    expect(input()).toBeDisabled();
    expect(input()).toHaveAttribute("placeholder", "Limit of 2 reached");
  });
});
```

`tests/unit/medicine-row.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MedicineRow } from "@/components/rx/medicine-row";
import { emptyMedicine, type EditorMedicine } from "@/lib/rx/editor-state";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ medicines: [] }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(medicine: EditorMedicine = emptyMedicine()) {
  const props = {
    onPatch: vi.fn(),
    onPick: vi.fn(),
    onRemove: vi.fn(),
    onSaveFavourite: vi.fn(async () => "Saved as favourite"),
    onAddToClinic: vi.fn(async () => "Added to the clinic list"),
  };
  render(<MedicineRow index={0} medicine={medicine} canAddToClinic {...props} />);
  return props;
}

describe("MedicineRow", () => {
  it("patches the fields it owns", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Schedule 1-1-1" }));
    expect(props.onPatch).toHaveBeenCalledWith({ doseMorning: "1", doseAfternoon: "1", doseEvening: "", doseNight: "1" });
    fireEvent.click(screen.getByLabelText(/SOS/));
    expect(props.onPatch).toHaveBeenCalledWith({ isSos: true });
    fireEvent.change(screen.getByLabelText("Food"), { target: { value: "after" } });
    expect(props.onPatch).toHaveBeenCalledWith({ foodRelation: "after" });
    fireEvent.change(screen.getByLabelText("Duration unit"), { target: { value: "weeks" } });
    expect(props.onPatch).toHaveBeenCalledWith({ durationUnit: "weeks" });
  });

  it("disables saving a favourite until the line has a name", () => {
    setup();
    expect(screen.getByRole("button", { name: /save as favourite/i })).toBeDisabled();
  });

  it("saves a favourite and reports what happened", async () => {
    const props = setup({ ...emptyMedicine(), drugName: "DOLO 650MG" });
    fireEvent.click(screen.getByRole("button", { name: /save as favourite/i }));
    expect(await screen.findByText("Saved as favourite")).toBeInTheDocument();
    expect(props.onSaveFavourite).toHaveBeenCalledTimes(1);
  });

  it("removes the row", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(props.onRemove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/medicine-combobox.test.tsx tests/unit/schedule-input.test.tsx tests/unit/term-list-input.test.tsx tests/unit/medicine-row.test.tsx
```

Expected: FAIL — components cannot be resolved.

- [ ] **Step 3: Implement the search hook**

`src/components/rx/use-catalogue-search.ts`:

```ts
"use client";

import { useEffect, useState } from "react";
import type { TermKind } from "@/lib/domain/rx-options";
import type { MedicineHit } from "@/server/services/catalogue";

export type SearchKind = "medicine" | TermKind;

type SearchState = { medicines: MedicineHit[]; terms: string[]; loading: boolean; failed: boolean };
const EMPTY: SearchState = { medicines: [], terms: [], loading: false, failed: false };

/**
 * Debounced typeahead against GET /api/catalogue/search. Each new query aborts the previous
 * request, so a slow response can never overwrite a newer one. An empty medicine query
 * returns the user's favourites; an empty term query returns nothing.
 */
export function useCatalogueSearch(kind: SearchKind, query: string, active: boolean, delayMs = 200): SearchState {
  const [state, setState] = useState<SearchState>(EMPTY);

  useEffect(() => {
    if (!active) return;
    const q = query.trim();
    if (kind !== "medicine" && q === "") {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, failed: false }));
      try {
        const res = await fetch(`/api/catalogue/search?kind=${kind}&q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const body = (await res.json()) as { medicines?: MedicineHit[]; terms?: string[] };
        if (!controller.signal.aborted) {
          setState({ medicines: body.medicines ?? [], terms: body.terms ?? [], loading: false, failed: false });
        }
      } catch {
        if (!controller.signal.aborted) setState({ ...EMPTY, failed: true });
      }
    }, delayMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [kind, query, active, delayMs]);

  return state;
}
```

- [ ] **Step 4: Implement the medicine combobox**

`src/components/rx/medicine-combobox.tsx`:

```tsx
"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { catalogueKey } from "@/lib/domain/search";
import type { MedicineHit } from "@/server/services/catalogue";
import { useCatalogueSearch } from "./use-catalogue-search";

type Props = {
  value: string;
  onTextChange: (value: string) => void;
  onPick: (hit: MedicineHit) => void;
  onAddToClinic?: (name: string) => void;
};

type Option = { kind: "hit"; hit: MedicineHit } | { kind: "add"; name: string };

const SOURCE_LABEL: Record<MedicineHit["source"], string> = { favourite: "★ Favourite", clinic: "Clinic list", global: "" };

/** Medicine name with catalogue suggestions. Free text is always allowed. */
export function MedicineCombobox({ value, onTextChange, onPick, onAddToClinic }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { medicines, loading, failed } = useCatalogueSearch("medicine", value, open);

  const typed = value.trim();
  const exact = medicines.some((m) => catalogueKey(m.name) === catalogueKey(typed));
  const options: Option[] = [
    ...medicines.map((hit) => ({ kind: "hit" as const, hit })),
    ...(onAddToClinic && typed.length >= 2 && !exact && !loading ? [{ kind: "add" as const, name: typed }] : []),
  ];

  function choose(option: Option) {
    setOpen(false);
    setActive(-1);
    if (option.kind === "hit") onPick(option.hit);
    else onAddToClinic?.(option.name);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && open && active >= 0 && options[active]) {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  const showList = open && (options.length > 0 || loading || failed);

  return (
    <div className="relative">
      <Input
        role="combobox"
        aria-label="Medicine name"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Type a medicine name"
        maxLength={200}
        value={value}
        onChange={(e) => {
          onTextChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-white text-sm shadow-lg">
          {loading && options.length === 0 ? <p className="px-3 py-2 text-muted-foreground">Searching…</p> : null}
          {failed ? <p className="px-3 py-2 text-muted-foreground">Search is unavailable. Type the full name.</p> : null}
          <ul id={listId} role="listbox" aria-label="Medicine suggestions" className="max-h-64 overflow-auto">
            {options.map((option, index) => (
              <li
                key={option.kind === "hit" ? `${option.hit.source}-${option.hit.id}` : "add"}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`cursor-pointer px-3 py-2 ${index === active ? "bg-muted" : "hover:bg-muted"}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
              >
                {option.kind === "hit" ? (
                  <>
                    <span className="font-medium">{option.hit.name}</span>
                    {SOURCE_LABEL[option.hit.source] ? (
                      <span className="ml-2 text-xs text-muted-foreground">{SOURCE_LABEL[option.hit.source]}</span>
                    ) : null}
                    {option.hit.genericName ? (
                      <span className="block text-xs text-muted-foreground">{option.hit.genericName}</span>
                    ) : null}
                  </>
                ) : (
                  <span>Add “{option.name}” to the clinic list</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Implement the schedule input**

`src/components/rx/schedule-input.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SCHEDULE_PRESETS } from "@/lib/domain/rx-options";
import { applySchedulePreset, scheduleLabel, type EditorMedicine } from "@/lib/rx/editor-state";

type SlotKey = "doseMorning" | "doseAfternoon" | "doseEvening" | "doseNight";

const SLOTS: { key: SlotKey; label: string; short: string }[] = [
  { key: "doseMorning", label: "Morning dose", short: "Morning" },
  { key: "doseAfternoon", label: "Afternoon dose", short: "Afternoon" },
  { key: "doseEvening", label: "Evening dose", short: "Evening" },
  { key: "doseNight", label: "Night dose", short: "Night" },
];

type Props = { medicine: EditorMedicine; onChange: (patch: Partial<EditorMedicine>) => void };

/** Doses per time of day (quarter steps) with one-click presets such as 1-0-1. */
export function ScheduleInput({ medicine, onChange }: Props) {
  const summary = scheduleLabel(medicine);
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted-foreground">Schedule{summary ? `: ${summary}` : ""}</legend>
      <div className="flex flex-wrap gap-1">
        {SCHEDULE_PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            aria-label={`Schedule ${preset}`}
            onClick={() => {
              const next = applySchedulePreset(medicine, preset);
              onChange({
                doseMorning: next.doseMorning,
                doseAfternoon: next.doseAfternoon,
                doseEvening: next.doseEvening,
                doseNight: next.doseNight,
              });
            }}
          >
            {preset}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {SLOTS.map((slot) => (
          <div key={slot.key} className="space-y-1">
            <span className="block text-xs text-muted-foreground">{slot.short}</span>
            <Input
              aria-label={slot.label}
              type="number"
              inputMode="decimal"
              min={0}
              max={99}
              step={0.25}
              className="h-9 px-2"
              value={medicine[slot.key]}
              onChange={(e) => {
                const patch: Partial<EditorMedicine> = {};
                patch[slot.key] = e.target.value;
                onChange(patch);
              }}
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}
```

- [ ] **Step 6: Implement the phrase list input**

`src/components/rx/term-list-input.tsx`:

```tsx
"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useCatalogueSearch, type SearchKind } from "./use-catalogue-search";

type Props = {
  label: string;
  kind: SearchKind;
  values: string[];
  onChange: (values: string[]) => void;
  max: number;
  placeholder?: string;
};

/** A list of short phrases (complaints, diagnoses, history...) with suggestions and free text. */
export function TermListInput({ label, kind, values, onChange, max, placeholder }: Props) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { medicines, terms } = useCatalogueSearch(kind, text, open && text.trim() !== "");
  const full = values.length >= max;
  const suggestions = (kind === "medicine" ? medicines.map((m) => m.name) : terms)
    .filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()))
    .slice(0, 10);

  function add(raw: string) {
    const phrase = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    setText("");
    setActive(-1);
    if (!phrase || full || values.some((v) => v.toLowerCase() === phrase.toLowerCase())) return;
    onChange([...values, phrase]);
  }

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if ((e.key === "Enter" || e.key === ",") && text.trim() !== "") {
      e.preventDefault();
      add(active >= 0 && suggestions[active] ? suggestions[active] : text);
    } else if (e.key === "Backspace" && text === "" && values.length > 0) {
      remove(values.length - 1);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && suggestions.length > 0;

  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <div className="flex flex-wrap items-center gap-1 rounded-md border-2 border-gray-200 bg-white p-1">
          {values.map((value, index) => (
            <Badge key={`${value}-${index}`} variant="secondary" className="gap-1 px-2 py-0.5 text-xs">
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                className="rounded hover:bg-gray-300"
                onClick={() => remove(index)}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <input
            id={inputId}
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            className="min-w-[8rem] flex-1 bg-transparent px-2 py-1 text-sm outline-none disabled:cursor-not-allowed"
            placeholder={full ? `Limit of ${max} reached` : (placeholder ?? "Type and press Enter")}
            disabled={full}
            maxLength={200}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // A phrase typed but not confirmed is kept, never silently lost.
              if (text.trim() !== "") add(text);
              setOpen(false);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {showList ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${label} suggestions`}
            className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-white text-sm shadow-lg"
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion}
                role="option"
                aria-selected={index === active}
                className={`cursor-pointer px-3 py-2 ${index === active ? "bg-muted" : "hover:bg-muted"}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(suggestion)}
              >
                {suggestion}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Implement the medicine row**

`src/components/rx/medicine-row.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DURATION_UNITS,
  FOOD_RELATIONS,
  FOOD_RELATION_LABELS,
  PERIODICITIES,
  PERIODICITY_LABELS,
  type DurationUnit,
} from "@/lib/domain/rx-options";
import type { EditorMedicine } from "@/lib/rx/editor-state";
import type { MedicineHit } from "@/server/services/catalogue";
import { MedicineCombobox } from "./medicine-combobox";
import { ScheduleInput } from "./schedule-input";

export const selectClass = "flex h-9 w-full rounded-md border-2 border-gray-200 bg-white px-2 text-sm";

type Props = {
  index: number;
  medicine: EditorMedicine;
  canAddToClinic: boolean;
  onPatch: (patch: Partial<EditorMedicine>) => void;
  onPick: (hit: MedicineHit) => void;
  onRemove: () => void;
  /** Resolves with a short message to show next to the row. */
  onSaveFavourite: () => Promise<string>;
  onAddToClinic: (name: string) => Promise<string>;
};

export function MedicineRow({ index, medicine, canAddToClinic, onPatch, onPick, onRemove, onSaveFavourite, onAddToClinic }: Props) {
  const [note, setNote] = useState("");
  const report = async (task: () => Promise<string>) => {
    setNote("Working…");
    setNote(await task());
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <span className="mt-3 w-6 text-sm text-muted-foreground">{index + 1}.</span>
        <div className="grid flex-1 gap-2 sm:grid-cols-6">
          <div className="sm:col-span-3">
            <MedicineCombobox
              value={medicine.drugName}
              onTextChange={(drugName) => onPatch({ drugName })}
              onPick={onPick}
              onAddToClinic={canAddToClinic ? (name) => void report(() => onAddToClinic(name)) : undefined}
            />
          </div>
          <Input
            aria-label="Generic name"
            placeholder="Generic / salt"
            className="sm:col-span-3"
            maxLength={300}
            value={medicine.genericName}
            onChange={(e) => onPatch({ genericName: e.target.value })}
          />
          <Input
            aria-label="Strength"
            placeholder="Strength"
            className="h-9 sm:col-span-2"
            maxLength={60}
            value={medicine.strength}
            onChange={(e) => onPatch({ strength: e.target.value })}
          />
          <Input
            aria-label="Dose"
            placeholder="Dose (1 tab, 5 ml)"
            className="h-9 sm:col-span-2"
            maxLength={60}
            value={medicine.dose}
            onChange={(e) => onPatch({ dose: e.target.value })}
          />
          <select
            aria-label="Food"
            className={`${selectClass} sm:col-span-2`}
            value={medicine.foodRelation}
            onChange={(e) => onPatch({ foodRelation: e.target.value })}
          >
            <option value="">Food: not stated</option>
            {FOOD_RELATIONS.map((code) => (
              <option key={code} value={code}>
                {FOOD_RELATION_LABELS[code]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <ScheduleInput medicine={medicine} onChange={onPatch} />
        <div className="grid grid-cols-2 content-start gap-2">
          <Input
            aria-label="Duration"
            type="number"
            min={1}
            max={365}
            step={1}
            placeholder="Duration"
            className="h-9"
            value={medicine.durationValue}
            onChange={(e) => onPatch({ durationValue: e.target.value })}
          />
          <select
            aria-label="Duration unit"
            className={selectClass}
            value={medicine.durationUnit}
            onChange={(e) => onPatch({ durationUnit: e.target.value as DurationUnit })}
          >
            {DURATION_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
          <select
            aria-label="Periodicity"
            className={selectClass}
            value={medicine.periodicity}
            onChange={(e) => onPatch({ periodicity: e.target.value })}
          >
            <option value="">How often: not stated</option>
            {PERIODICITIES.map((code) => (
              <option key={code} value={code}>
                {PERIODICITY_LABELS[code]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={medicine.isSos}
              onChange={(e) => onPatch({ isSos: e.target.checked })}
            />
            SOS (only if needed)
          </label>
          <Input
            aria-label="Other frequency"
            placeholder="Other frequency (e.g. every 6 hours)"
            className="col-span-2 h-9"
            maxLength={60}
            value={medicine.timing}
            onChange={(e) => onPatch({ timing: e.target.value })}
          />
        </div>
      </div>

      <Input
        aria-label="Remarks"
        placeholder="Remarks"
        className="h-9"
        maxLength={300}
        value={medicine.remarks}
        onChange={(e) => onPatch({ remarks: e.target.value })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={medicine.drugName.trim() === ""}
          onClick={() => void report(onSaveFavourite)}
        >
          Save as favourite
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
        {note ? (
          <span role="status" className="text-xs text-muted-foreground">
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run the component tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/medicine-combobox.test.tsx tests/unit/schedule-input.test.tsx tests/unit/term-list-input.test.tsx tests/unit/medicine-row.test.tsx
npm run typecheck
npm run lint
```

Expected: all PASS; typecheck exits 0; lint reports 0 errors. If `findByRole("option")` times out, check that the test triggers `focus` or `change` (the list only searches while open) and that the fetch stub returns `{ ok: true, json }`.

- [ ] **Step 9: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/components/rx/use-catalogue-search.ts src/components/rx/medicine-combobox.tsx src/components/rx/schedule-input.tsx src/components/rx/term-list-input.tsx src/components/rx/medicine-row.tsx tests/unit/medicine-combobox.test.tsx tests/unit/schedule-input.test.tsx tests/unit/term-list-input.test.tsx tests/unit/medicine-row.test.tsx
git commit -m "feat: add medicine combobox, schedule input, phrase list, and medicine row" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 10: The clinical editor with autosave, the read-only view, and end-to-end tests

**Files:**
- Create: `src/components/rx/use-autosave.ts`, `src/components/rx/autosave-status.tsx`, `src/components/rx/vitals-section.tsx`, `src/components/rx/clinical-notes-section.tsx`, `src/components/rx/investigations-section.tsx`, `src/components/rx/medicines-section.tsx`, `src/components/rx/advice-section.tsx`, `src/components/rx/clinical-editor.tsx`, `src/components/rx/prescription-view.tsx`, `tests/e2e/clinical-form.spec.ts`
- Modify: `src/app/(app)/prescriptions/[id]/page.tsx` (full replacement), `src/server/actions/prescriptions.ts` (full replacement that removes only `saveDraftAction` and `DraftFormState`), `tests/e2e/helpers.ts` (append `ensureCatalogue`), `tests/e2e/prescriptions.spec.ts` (full replacement that keeps all five Plan 1A scenarios)
- Delete: `src/components/rx/draft-editor.tsx`, `src/components/rx/read-only-view.tsx`
- Keep unchanged: `src/components/rx/amend-form.tsx`, `repeat-form.tsx`, `submit-button.tsx`, `redirect-error.tsx`, `src/components/patients/allergy-banner.tsx`
- Test: `tests/unit/autosave-status.test.tsx`, `tests/e2e/clinical-form.spec.ts`, `tests/e2e/prescriptions.spec.ts`

**Interfaces:**
- Consumes: Task 7 actions (`autosaveDraftAction`, `finalizeDraftAction`, `saveFavouriteAction`, `removeFavouriteAction`, `addClinicMedicineAction`, `FinalizeResponse`), Task 8 (`createAutosaver`, `outcomeFromResponse`, `AutosaveStatus`, editor-state helpers), Task 9 components, Task 6 `listFavourites`, Task 3 `getPrescription`/`PrescriptionView` (with `patient.allergies`), Task 1 formatting helpers, Plan 1A `AmendForm` + `amendAction` (`AmendFormState`), `RepeatForm` + `repeatAction` (returns `RepeatFormState = { error?: string }` on failure, redirects on success), `startPrescriptionAction`, `AllergyBanner`, e2e `registerClinic`, `cleanupClinic`, `setRole(email, role)`, `withAdminSql`.
- Produces:
  - `useAutosave(prescriptionId: string, initial: EditorState, initialRevision: number): { status: AutosaveStatus; ready: boolean; update(state): void; flush(): Promise<void>; retryNow(): void; overwrite(): void; stop(): void; finalize(): Promise<FinalizeResponse> }` (`ready` turns true once the autosaver exists, after hydration); `FINALIZE_OFFLINE_MESSAGE`.
  - `<AutosaveStatusBar status onRetry onOverwrite onReload />`; `<AdviceSection advice followUpDate followUpReason onChange(field, value) />`; `<ClinicalEditor prescriptionId visit items revision favourites canAddToClinic canFinalize />` (the whole editor is a `fieldset` disabled until `ready`; Finalize renders only when `canFinalize`); `<PrescriptionReadOnly rx />`.
  - The page shows `<AllergyBanner allergies={rx.patient.allergies} showWhenEmpty />` for drafts and finalized versions, and reads no other live patient field than Plan 1A does (name, number, allergies; Plan 1C snapshots them).
  - Accessible-name rule: no section or group may carry an `aria-label` that contains a field label used by the e2e specs (Playwright's `getByLabel` also matches `aria-label` and `aria-labelledby`).
  - Editor labels used by tests: "Visit type", "Chief complaint", vitals labels ("BP systolic (mmHg)", "BP diastolic (mmHg)", "Pulse (/min)", "Temperature (°F)", "SpO₂ (%)", "Respiratory rate (/min)", "Weight (kg)", "Height (cm)", "Blood sugar (mg/dL)", "Vitals notes", output "BMI"), phrase lists ("Complaints", "Diagnosis", "Medical history", "Drug history"), "Examination notes", "Add test", "Test name", "Test instructions", "Advice", "Follow-up date", "Follow-up reason", buttons "Add medicine", `Add favourite <name>`, `Remove favourite <name>`, "Save now", "Finalize"; status texts "No unsaved changes", "All changes saved at …", "Unsaved changes…", "Saving…", the offline message, "Not saved: …", conflict buttons "Reload latest version" / "Keep my version".
  - e2e helper `ensureCatalogue(): Promise<void>` (new); `setRole(email, role)` already exists in `tests/e2e/helpers.ts` and is reused, not redefined.

- [ ] **Step 1: Write the failing tests**

`tests/unit/autosave-status.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AutosaveStatusBar } from "@/components/rx/autosave-status";
import { OFFLINE_MESSAGE, type AutosaveStatus } from "@/lib/rx/autosave";

function setup(status: AutosaveStatus) {
  const handlers = { onRetry: vi.fn(), onOverwrite: vi.fn(), onReload: vi.fn() };
  render(<AutosaveStatusBar status={status} {...handlers} />);
  return handlers;
}

describe("AutosaveStatusBar", () => {
  it("says when everything is saved, and when nothing needed saving", () => {
    setup({ state: "saved", savedAt: "2026-11-12T04:30:00.000Z" });
    expect(screen.getByRole("status")).toHaveTextContent(/all changes saved at/i);
  });

  it("says nothing is unsaved right after loading", () => {
    setup({ state: "saved", savedAt: null });
    expect(screen.getByRole("status")).toHaveTextContent("No unsaved changes");
  });

  const progress: [AutosaveStatus, RegExp][] = [
    [{ state: "pending" }, /unsaved changes/i],
    [{ state: "saving" }, /saving/i],
  ];
  it.each(progress)("shows progress for %j", (status, text) => {
    setup(status);
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("shows that changes are not saved while retrying, with a retry button", () => {
    const h = setup({ state: "retrying", message: OFFLINE_MESSAGE, retryInMs: 2000 });
    expect(screen.getByRole("alert")).toHaveTextContent(/not saved yet/i);
    fireEvent.click(screen.getByRole("button", { name: /retry now/i }));
    expect(h.onRetry).toHaveBeenCalled();
  });

  it("explains a rejected save", () => {
    setup({ state: "invalid", message: "Pulse must be at most 250", field: "vitals" });
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved: Pulse must be at most 250");
  });

  it("offers reload or keep-mine on a conflict", () => {
    const h = setup({ state: "conflict", message: "This draft was changed in another window or device.", currentRevision: 3 });
    expect(screen.getByRole("alert")).toHaveTextContent(/your version has not been saved/i);
    fireEvent.click(screen.getByRole("button", { name: /reload latest version/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep my version/i }));
    expect(h.onReload).toHaveBeenCalled();
    expect(h.onOverwrite).toHaveBeenCalled();
  });

  it("offers a reload when the prescription is locked", () => {
    const h = setup({ state: "locked", message: "This prescription is finalized." });
    fireEvent.click(screen.getByRole("button", { name: /^reload$/i }));
    expect(h.onReload).toHaveBeenCalled();
  });
});
```

Append to `tests/e2e/helpers.ts` (add `import { execSync } from "node:child_process";` to the imports at the top; `withAdminSql` and `setRole` already exist in that file — do not add a second `setRole`):

```ts
/** The editor's search needs the global catalogue. Seeds it once if this database lacks it. */
export async function ensureCatalogue(): Promise<void> {
  const seeded = await withAdminSql(async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from global_medicines where name_key = 'dolo 650mg'`;
    return rows[0].n > 0;
  });
  if (!seeded) execSync("npm run db:seed:catalogue", { stdio: "inherit" });
}

/**
 * The clinical editor is disabled until it has hydrated (text typed into server-rendered inputs
 * would be lost). Wait for it before typing.
 */
export async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByLabel("Chief complaint")).toBeEditable({ timeout: 15_000 });
}
```

Replace the whole content of `tests/e2e/prescriptions.spec.ts`. It keeps all five Plan 1A scenarios (including the review fix wave's allergy checks, the superseded-version check, unsaved edits on finalize, hostile text, not-found, reception read-only, accountant not-found), rewritten for the clinical editor's labels and autosave. Each scenario waits for the editor to be editable before typing (the editor is disabled until it has hydrated):

```ts
import { expect, test } from "@playwright/test";
import { cleanupClinic, registerClinic, setRole, waitForEditor, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

test("write, autosave, finalize, amend, and repeat a prescription", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "rx"));

  // A patient to prescribe for.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Ravi Sharma");
  await page.getByLabel("Phone").fill("9822012345");
  await page.getByLabel("Allergies").fill("Penicillin");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Ravi Sharma" })).toBeVisible();

  // Start a draft. The allergy is on the prescription screen, where the doctor chooses medicines.
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page).toHaveURL(/\/prescriptions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByText("Allergies: Penicillin")).toBeVisible();
  await waitForEditor(page);

  // Finalizing an empty draft is refused with a message.
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByText(/at least one medicine/i)).toBeVisible();

  // Fill the form; autosave does the rest.
  await page.getByLabel("Chief complaint").fill("Fever for 2 days");
  const diagnosis = page.getByLabel("Diagnosis", { exact: true });
  await diagnosis.fill("Viral fever");
  await diagnosis.press("Enter");
  await page.getByLabel("Medicine name").first().fill("Paracetamol");
  await page.getByLabel("Dose", { exact: true }).first().fill("1 tablet");
  await page.getByRole("button", { name: "Schedule 1-1-1" }).first().click();
  await page.getByLabel("Duration", { exact: true }).first().fill("3");
  await page.getByRole("button", { name: /add medicine/i }).click();
  await page.getByLabel("Medicine name").nth(1).fill("Cetirizine");
  await expect(page.getByText(/all changes saved/i)).toBeVisible({ timeout: 15_000 });

  // The draft survives a reload.
  await page.reload();
  await waitForEditor(page);
  await expect(page.getByLabel("Chief complaint")).toHaveValue("Fever for 2 days");
  await expect(page.getByRole("button", { name: "Remove Viral fever" })).toBeVisible();
  await expect(page.getByLabel("Medicine name").nth(1)).toHaveValue("Cetirizine");
  await expect(page.getByLabel("Morning dose").first()).toHaveValue("1");

  // Finalize -> read-only view with an Rx number; the allergy stays visible.
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Paracetamol/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /1-1-1/ })).toBeVisible();
  await expect(page.getByText("Allergies: Penicillin")).toBeVisible();
  await expect(page.getByRole("button", { name: /^finalize$/i })).toHaveCount(0);

  // Amend needs a reason and copies the clinical content.
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByText(/at least 5 characters/i)).toBeVisible();
  await page.getByLabel("Reason for amendment").fill("Dose was wrong");
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByRole("heading", { name: /draft amendment/i })).toBeVisible();
  await expect(page.getByText("Dose was wrong")).toBeVisible();
  await waitForEditor(page);
  await expect(page.getByLabel("Morning dose").first()).toHaveValue("1");

  // Finalize straight after an edit: the pending edit is included.
  await page.getByLabel("Dose", { exact: true }).first().fill("2 tablets");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1 v2/ })).toBeVisible();
  await expect(page.getByText(/2 tablets/)).toBeVisible();

  // The patient page lists both versions with their statuses.
  await page.getByRole("link", { name: "Ravi Sharma" }).click();
  await expect(page.getByRole("link", { name: "Rx #1 v1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rx #1 v2" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Rx #1 v1" })).toContainText("amended");
  await expect(page.getByRole("listitem").filter({ hasText: "Rx #1 v2" })).toContainText("finalized");

  // A superseded version offers neither amend nor repeat.
  await page.getByRole("link", { name: "Rx #1 v1" }).click();
  await expect(page.getByRole("heading", { name: /Rx #1$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /start amendment/i })).toHaveCount(0);
  await page.goBack();

  // Repeat creates a new independent draft.
  await page.getByRole("link", { name: "Rx #1 v2" }).click();
  await page.getByRole("button", { name: /repeat as new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await waitForEditor(page);
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("Paracetamol");
});

test("finalize keeps edits autosave has not sent yet, and hostile text stays inert", async ({ page }) => {
  clinics.push(await registerClinic(page, "rxunsaved"));

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Unsaved Edits");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Unsaved Edits" })).toBeVisible();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByText("No known allergies recorded")).toBeVisible();
  await waitForEditor(page);

  // Finalize straight away, before the autosave debounce fires.
  const hostile = "<img src=x onerror=alert(1)>";
  await page.getByLabel("Medicine name").first().fill(hostile);
  await page.getByLabel("Advice").fill("Rest <b>well</b>");
  await page.getByRole("button", { name: /^finalize$/i }).click();

  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText(hostile)).toBeVisible();
  await expect(page.getByText("Rest <b>well</b>")).toBeVisible();
  await expect(page.locator("img[src='x']")).toHaveCount(0);
});

test("a malformed or unknown prescription id is a clean not-found", async ({ page }) => {
  clinics.push(await registerClinic(page, "rxnotfound"));

  for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
    await page.goto(`/prescriptions/${id}`);
    await expect(page.getByText(/could not be found/i)).toBeVisible();
    await expect(page.getByLabel("Chief complaint")).toHaveCount(0);
  }
});

test("a reception user can read but not write prescriptions", async ({ page }) => {
  test.setTimeout(120_000);
  const clinic = await registerClinic(page, "rxperm");
  clinics.push(clinic);

  // The owner finalizes one prescription and leaves a second one as a draft, then is demoted to reception.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Reception Registered");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Reception Registered" })).toBeVisible();
  const patientUrl = page.url();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill("Ibuprofen");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  const rxUrl = page.url();

  await page.goto(patientUrl);
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  const draftUrl = page.url();

  // Roles are re-read per request, so a direct role change takes effect immediately.
  await setRole(clinic.email, "reception");

  await page.goto(rxUrl);
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText("Ibuprofen")).toBeVisible();
  await expect(page.getByRole("button", { name: /start amendment/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toHaveCount(0);

  // A draft is readable, but has no editor and no Finalize.
  await page.goto(draftUrl);
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByLabel("Medicine name")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^finalize$/i })).toHaveCount(0);

  await page.getByRole("link", { name: "Reception Registered" }).click();
  await expect(page.getByRole("heading", { name: "Reception Registered" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rx #1 v1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /new prescription/i })).toHaveCount(0);
});

test("an accountant cannot open a prescription", async ({ page }) => {
  const clinic = await registerClinic(page, "rxacct");
  clinics.push(clinic);

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Hidden Patient");
  await page.getByRole("button", { name: /register patient/i }).click();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  const rxUrl = page.url();

  await setRole(clinic.email, "accountant");

  await page.goto(rxUrl);
  await expect(page.getByText(/could not be found/i)).toBeVisible();
  await expect(page.getByLabel("Chief complaint")).toHaveCount(0);
});
```

`tests/e2e/clinical-form.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, ensureCatalogue, registerClinic, waitForEditor, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.beforeAll(async () => {
  await ensureCatalogue();
});

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

async function newDraft(page: Page, patientName: string): Promise<string> {
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill(patientName);
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: patientName })).toBeVisible();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await waitForEditor(page);
  return page.url();
}

const allSaved = (page: Page) => expect(page.getByText(/all changes saved/i)).toBeVisible({ timeout: 15_000 });

test("clinical form: vitals, catalogue, favourites, tests, and plain-text safety", async ({ page }) => {
  test.setTimeout(180_000);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  clinics.push(await registerClinic(page, "clin"));
  await newDraft(page, "Meera Iyer");

  // Vitals, with BMI computed on the page.
  await page.getByLabel("BP systolic (mmHg)").fill("130");
  await page.getByLabel("BP diastolic (mmHg)").fill("85");
  await page.getByLabel("Pulse (/min)").fill("92");
  await page.getByLabel("Weight (kg)").fill("70");
  await page.getByLabel("Height (cm)").fill("175");
  await expect(page.getByLabel("BMI")).toHaveText("22.9");

  // A complaint from the global list.
  await page.getByLabel("Complaints", { exact: true }).fill("fever with ch");
  await page.getByRole("option", { name: "FEVER WITH CHILLS" }).click();
  await expect(page.getByRole("button", { name: "Remove FEVER WITH CHILLS" })).toBeVisible();

  // A medicine from the global catalogue fills its generic name.
  await page.getByLabel("Medicine name").first().fill("dolo 65");
  await page.getByRole("option", { name: /DOLO 650MG/ }).click();
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("DOLO 650MG");
  await expect(page.getByLabel("Generic name").first()).toHaveValue("Paracetamol 650Mg");
  await page.getByRole("button", { name: "Schedule 1-0-1" }).first().click();
  await page.getByLabel("Food").first().selectOption("after");
  await page.getByLabel("Duration", { exact: true }).first().fill("5");

  // Saved as a favourite for next time.
  await page.getByRole("button", { name: /save as favourite/i }).first().click();
  await expect(page.getByText("Saved as favourite")).toBeVisible();

  // A free-text medicine that no list knows, added to the clinic list.
  await page.getByRole("button", { name: /add medicine/i }).click();
  await page.getByLabel("Medicine name").nth(1).fill("Clinic Special Syrup");
  await page.getByRole("option", { name: /to the clinic list/i }).click();
  await expect(page.getByText("Added to the clinic list")).toBeVisible();

  // An ordered test with instructions.
  const addTest = page.getByLabel("Add test", { exact: true });
  await addTest.fill("CBC");
  await addTest.press("Enter");
  await page.getByLabel("Test instructions").first().fill("Fasting not required");

  // Hostile-looking and Devanagari text is stored and shown as plain text.
  await page.getByLabel("Chief complaint").fill('<img src=x onerror="alert(1)"> fever');
  await page.getByLabel("Advice").fill("आराम करें। Drink fluids.");
  await allSaved(page);

  await page.reload();
  await expect(page.getByLabel("Pulse (/min)")).toHaveValue("92");
  await expect(page.getByLabel("Generic name").first()).toHaveValue("Paracetamol 650Mg");
  await expect(page.getByLabel("Morning dose").first()).toHaveValue("1");
  await expect(page.getByLabel("Night dose").first()).toHaveValue("1");
  await expect(page.getByLabel("Test name").first()).toHaveValue("CBC");
  await expect(page.getByLabel("Advice")).toHaveValue("आराम करें। Drink fluids.");

  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText('<img src=x onerror="alert(1)"> fever')).toBeVisible();
  await expect(page.getByRole("row", { name: /DOLO 650MG/ })).toContainText("1-0-1");
  await expect(page.getByText(/BP 130\/85 mmHg/)).toBeVisible();
  await expect(page.getByText(/CBC \(Fasting not required\)/)).toBeVisible();

  // The favourite pre-fills the next prescription.
  await newDraft(page, "Second Patient");
  await page.getByRole("button", { name: "Add favourite DOLO 650MG" }).click();
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("DOLO 650MG");
  await expect(page.getByLabel("Duration", { exact: true }).first()).toHaveValue("5");
  await expect(page.getByLabel("Food").first()).toHaveValue("after");

  // The clinic medicine is now found by search.
  await page.getByRole("button", { name: /add medicine/i }).click();
  await page.getByLabel("Medicine name").nth(1).fill("clinic spec");
  await expect(page.getByRole("option", { name: /Clinic Special Syrup/ })).toBeVisible();

  expect(dialogs).toEqual([]);
});

test("autosave survives a dropped connection and refuses to overwrite another window", async ({ page, context }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "auto"));
  const url = await newDraft(page, "Autosave Patient");

  await page.getByLabel("Advice").fill("First advice");
  await allSaved(page);

  // Offline: the edit stays on the page, is flagged as not saved, and saves once back online.
  await context.setOffline(true);
  await page.getByLabel("Advice").fill("Written while offline");
  await expect(page.getByText(/not saved yet/i)).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
  await allSaved(page);
  await page.reload();
  await expect(page.getByLabel("Advice")).toHaveValue("Written while offline");

  // A second window on the same draft.
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByLabel("Advice")).toHaveValue("Written while offline");

  await page.getByLabel("Advice").fill("Edited in window one");
  await allSaved(page);

  await other.getByLabel("Advice").fill("Edited in window two");
  await expect(other.getByText(/changed in another window/i)).toBeVisible({ timeout: 15_000 });
  await other.getByRole("button", { name: /reload latest version/i }).click();
  await expect(other.getByLabel("Advice")).toHaveValue("Edited in window one");

  // Window two's edit never reached the saved draft.
  await page.reload();
  await expect(page.getByLabel("Advice")).toHaveValue("Edited in window one");
  await other.close();
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/autosave-status.test.tsx
npm run test:e2e -- tests/e2e/clinical-form.spec.ts
```

Expected: FAIL — `AutosaveStatusBar` cannot be resolved; the e2e cannot find "BP systolic (mmHg)" (the page still renders Plan 1A's plain editor).

- [ ] **Step 3: Implement the autosave hook and status bar**

`src/components/rx/use-autosave.ts`:

```ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createAutosaver, outcomeFromResponse, type Autosaver, type AutosaveStatus } from "@/lib/rx/autosave";
import { toDraftPayload, type EditorState } from "@/lib/rx/editor-state";
import { autosaveDraftAction, finalizeDraftAction, type FinalizeResponse } from "@/server/actions/drafts";

export const FINALIZE_OFFLINE_MESSAGE = "Could not reach the server. Nothing was finalized; your draft is still here.";

/**
 * Connects the pure autosaver to React and the server actions. The saver is created in an
 * effect (not during render) so React Strict Mode's mount/unmount/mount cycle cannot leave
 * a disposed saver in use.
 */
export function useAutosave(prescriptionId: string, initial: EditorState, initialRevision: number) {
  const [status, setStatus] = useState<AutosaveStatus>({ state: "saved", savedAt: null });
  // False on the server and until the saver exists; the editor stays disabled until then, so
  // nothing can be typed into server-rendered inputs before hydration (it would be lost).
  const [ready, setReady] = useState(false);
  const saverRef = useRef<Autosaver<EditorState> | null>(null);
  const seed = useRef({ initial, initialRevision });

  useEffect(() => {
    const saver = createAutosaver<EditorState>({
      initial: seed.current.initial,
      initialRevision: seed.current.initialRevision,
      save: async (snapshot, baseRevision) =>
        outcomeFromResponse(await autosaveDraftAction(prescriptionId, toDraftPayload(snapshot), baseRevision)),
      onStatus: setStatus,
    });
    saverRef.current = saver;
    setReady(true);

    const onOnline = () => saver.retryNow();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!saver.hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onBeforeUnload);
      saver.dispose();
      if (saverRef.current === saver) saverRef.current = null;
    };
  }, [prescriptionId]);

  const update = useCallback((state: EditorState) => saverRef.current?.update(state), []);
  const flush = useCallback(() => saverRef.current?.flush() ?? Promise.resolve(), []);
  const retryNow = useCallback(() => saverRef.current?.retryNow(), []);
  const overwrite = useCallback(() => saverRef.current?.overwrite(), []);
  const stop = useCallback(() => saverRef.current?.dispose(), []);

  /** Saves the latest snapshot and finalizes exactly that revision, after any in-flight save. */
  const finalize = useCallback(async (): Promise<FinalizeResponse> => {
    const saver = saverRef.current;
    if (!saver) return { ok: false, code: "not_ready", message: "The editor is still loading. Try again." };
    return saver.exclusive(async (snapshot, baseRevision) => {
      const res = await finalizeDraftAction(prescriptionId, toDraftPayload(snapshot), baseRevision);
      return res.ok
        ? { revision: null, value: res }
        : { revision: typeof res.revision === "number" ? res.revision : null, savedAt: res.savedAt, value: res };
    });
  }, [prescriptionId]);

  return { status, ready, update, flush, retryNow, overwrite, stop, finalize };
}
```

`src/components/rx/autosave-status.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import type { AutosaveStatus } from "@/lib/rx/autosave";

type Props = {
  status: AutosaveStatus;
  onRetry: () => void;
  onOverwrite: () => void;
  onReload: () => void;
};

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Always tells the truth: "saved" only after the server confirmed the latest snapshot. */
export function AutosaveStatusBar({ status, onRetry, onOverwrite, onReload }: Props) {
  switch (status.state) {
    case "saved":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          {status.savedAt ? `All changes saved at ${time(status.savedAt)}` : "No unsaved changes"}
        </p>
      );
    case "pending":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Unsaved changes…
        </p>
      );
    case "saving":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Saving…
        </p>
      );
    case "retrying":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-800">
          <span>{status.message}</span>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Retry now
          </Button>
        </div>
      );
    case "invalid":
      return (
        <p role="alert" className="text-sm text-destructive">
          Not saved: {status.message}
        </p>
      );
    case "conflict":
      return (
        <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>{status.message} Your version has not been saved.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onReload}>
              Reload latest version
            </Button>
            <Button type="button" size="sm" onClick={onOverwrite}>
              Keep my version
            </Button>
          </div>
        </div>
      );
    case "locked":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{status.message}</span>
          <Button type="button" size="sm" variant="outline" onClick={onReload}>
            Reload
          </Button>
        </div>
      );
  }
}
```

- [ ] **Step 4: Implement the editor sections**

`src/components/rx/vitals-section.tsx`:

```tsx
"use client";

import { Input } from "@/components/ui/input";
import { bmi } from "@/lib/domain/rx-format";
import type { EditorState, VitalKey } from "@/lib/rx/editor-state";

const FIELDS: { key: VitalKey; label: string; step: string }[] = [
  { key: "bpSystolic", label: "BP systolic (mmHg)", step: "1" },
  { key: "bpDiastolic", label: "BP diastolic (mmHg)", step: "1" },
  { key: "pulse", label: "Pulse (/min)", step: "1" },
  { key: "temperatureF", label: "Temperature (°F)", step: "0.1" },
  { key: "spo2", label: "SpO₂ (%)", step: "1" },
  { key: "respiratoryRate", label: "Respiratory rate (/min)", step: "1" },
  { key: "weightKg", label: "Weight (kg)", step: "0.1" },
  { key: "heightCm", label: "Height (cm)", step: "0.1" },
  { key: "bloodSugarMgDl", label: "Blood sugar (mg/dL)", step: "1" },
];

type Props = {
  vitals: EditorState["vitals"];
  notes: string;
  onChange: (key: VitalKey, value: string) => void;
  onNotesChange: (value: string) => void;
};

export function VitalsSection({ vitals, notes, onChange, onNotesChange }: Props) {
  const index = bmi(Number(vitals.weightKg) || null, Number(vitals.heightCm) || null);
  return (
    <section className="space-y-3" aria-labelledby="vitals-heading">
      <h2 id="vitals-heading" className="font-medium">
        Vitals
      </h2>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <label htmlFor={`vital-${field.key}`} className="text-xs text-muted-foreground">
              {field.label}
            </label>
            <Input
              id={`vital-${field.key}`}
              type="number"
              inputMode="decimal"
              step={field.step}
              className="h-9 px-2"
              value={vitals[field.key]}
              onChange={(e) => onChange(field.key, e.target.value)}
            />
          </div>
        ))}
        <div className="space-y-1">
          <span className="block text-xs text-muted-foreground">BMI</span>
          <output aria-label="BMI" className="block h-9 py-2 text-sm">
            {index ?? "—"}
          </output>
        </div>
      </div>
      <div className="space-y-1">
        <label htmlFor="vital-notes" className="text-xs text-muted-foreground">
          Vitals notes
        </label>
        <Input
          id="vital-notes"
          className="h-9"
          maxLength={200}
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
        />
      </div>
    </section>
  );
}
```

`src/components/rx/clinical-notes-section.tsx`:

```tsx
"use client";

import { Textarea } from "@/components/ui/textarea";
import { RX_LIMITS } from "@/lib/domain/rx-options";
import type { EditorState } from "@/lib/rx/editor-state";
import { TermListInput } from "./term-list-input";
import type { SearchKind } from "./use-catalogue-search";

export type PhraseListKey = "complaints" | "diagnosis" | "medicalHistory" | "drugHistory";

const LISTS: { key: PhraseListKey; label: string; kind: SearchKind; max: number }[] = [
  { key: "complaints", label: "Complaints", kind: "complaint", max: RX_LIMITS.phrases },
  { key: "diagnosis", label: "Diagnosis", kind: "diagnosis", max: RX_LIMITS.diagnoses },
  { key: "medicalHistory", label: "Medical history", kind: "history", max: RX_LIMITS.phrases },
  { key: "drugHistory", label: "Drug history", kind: "medicine", max: RX_LIMITS.phrases },
];

type Props = {
  state: Pick<EditorState, PhraseListKey | "examinationNotes">;
  onListChange: (key: PhraseListKey, values: string[]) => void;
  onNotesChange: (value: string) => void;
};

export function ClinicalNotesSection({ state, onListChange, onNotesChange }: Props) {
  return (
    <section className="space-y-4" aria-labelledby="clinical-heading">
      <h2 id="clinical-heading" className="font-medium">
        History and findings
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {LISTS.map((list) => (
          <TermListInput
            key={list.key}
            label={list.label}
            kind={list.kind}
            max={list.max}
            values={state[list.key]}
            onChange={(values) => onListChange(list.key, values)}
          />
        ))}
      </div>
      <div className="space-y-1">
        <label htmlFor="examinationNotes" className="text-sm font-medium">
          Examination notes
        </label>
        <Textarea
          id="examinationNotes"
          rows={3}
          className="min-h-[80px]"
          maxLength={2000}
          value={state.examinationNotes}
          onChange={(e) => onNotesChange(e.target.value)}
        />
      </div>
    </section>
  );
}
```

`src/components/rx/investigations-section.tsx`:

```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RX_LIMITS } from "@/lib/domain/rx-options";
import type { EditorInvestigation } from "@/lib/rx/editor-state";
import { TermListInput } from "./term-list-input";

type Props = {
  items: EditorInvestigation[];
  onAdd: (name: string) => void;
  onPatch: (key: string, patch: Partial<EditorInvestigation>) => void;
  onRemove: (key: string) => void;
};

export function InvestigationsSection({ items, onAdd, onPatch, onRemove }: Props) {
  return (
    <section className="space-y-3" aria-labelledby="tests-heading">
      <h2 id="tests-heading" className="font-medium">
        Investigations
      </h2>
      {/* The phrase input is used only as an adder: each confirmed name becomes a row below. */}
      <TermListInput
        label="Add test"
        kind="test"
        values={[]}
        max={RX_LIMITS.investigations - items.length}
        placeholder="Type a test and press Enter"
        onChange={(values) => values.forEach(onAdd)}
      />
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((test) => (
            <li key={test.key} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Input
                aria-label="Test name"
                className="h-9"
                maxLength={120}
                value={test.name}
                onChange={(e) => onPatch(test.key, { name: e.target.value })}
              />
              <Input
                aria-label="Test instructions"
                className="h-9"
                maxLength={300}
                placeholder="Instructions (optional)"
                value={test.instructions}
                onChange={(e) => onPatch(test.key, { instructions: e.target.value })}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => onRemove(test.key)}>
                Remove test
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
```

`src/components/rx/medicines-section.tsx`:

```tsx
"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RX_LIMITS } from "@/lib/domain/rx-options";
import type { EditorMedicine } from "@/lib/rx/editor-state";
import type { FavouriteView, MedicineHit } from "@/server/services/catalogue";
import { MedicineRow } from "./medicine-row";

type Props = {
  medicines: EditorMedicine[];
  favourites: FavouriteView[];
  canAddToClinic: boolean;
  onPatch: (key: string, patch: Partial<EditorMedicine>) => void;
  onPick: (key: string, hit: MedicineHit) => void;
  onAdd: () => void;
  onAddFavourite: (favourite: FavouriteView) => void;
  onRemove: (key: string) => void;
  onSaveFavourite: (medicine: EditorMedicine) => Promise<string>;
  onRemoveFavourite: (favourite: FavouriteView) => Promise<void>;
  onAddToClinic: (name: string, genericName: string) => Promise<string>;
};

export function MedicinesSection(props: Props) {
  const { medicines, favourites } = props;
  const full = medicines.length >= RX_LIMITS.medicines;
  return (
    <section className="space-y-3" aria-labelledby="medicines-heading">
      <div className="flex items-baseline justify-between">
        <h2 id="medicines-heading" className="font-medium">
          Medicines
        </h2>
        <span className="text-xs text-muted-foreground">
          {medicines.length} of {RX_LIMITS.medicines}
        </span>
      </div>

      {favourites.length > 0 ? (
        <div role="group" aria-label="Favourites" className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Favourites:</span>
          {favourites.map((f) => (
            <span key={f.id} className="inline-flex items-center rounded-full border bg-white text-xs">
              <button
                type="button"
                className="px-2 py-1 hover:underline disabled:opacity-50"
                disabled={full}
                aria-label={`Add favourite ${f.drugName}`}
                onClick={() => props.onAddFavourite(f)}
              >
                ★ {f.drugName}
              </button>
              <button
                type="button"
                className="rounded-full px-1 py-1 hover:bg-muted"
                aria-label={`Remove favourite ${f.drugName}`}
                onClick={() => void props.onRemoveFavourite(f)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {medicines.map((m, index) => (
        <MedicineRow
          key={m.key}
          index={index}
          medicine={m}
          canAddToClinic={props.canAddToClinic}
          onPatch={(patch) => props.onPatch(m.key, patch)}
          onPick={(hit) => props.onPick(m.key, hit)}
          onRemove={() => props.onRemove(m.key)}
          onSaveFavourite={() => props.onSaveFavourite(m)}
          onAddToClinic={(name) => props.onAddToClinic(name, m.genericName)}
        />
      ))}

      <Button type="button" variant="outline" disabled={full} onClick={props.onAdd}>
        Add medicine
      </Button>
    </section>
  );
}
```

`src/components/rx/advice-section.tsx`:

```tsx
"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type AdviceField = "advice" | "followUpDate" | "followUpReason";

type Props = {
  advice: string;
  followUpDate: string;
  followUpReason: string;
  onChange: (field: AdviceField, value: string) => void;
};

export function AdviceSection({ advice, followUpDate, followUpReason, onChange }: Props) {
  // No aria-label on the section: getByLabel("Advice") in the e2e specs must match only the textarea.
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <label htmlFor="advice" className="text-sm font-medium">
          Advice
        </label>
        <Textarea
          id="advice"
          rows={3}
          className="min-h-[80px]"
          maxLength={2000}
          value={advice}
          onChange={(e) => onChange("advice", e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="followUpDate" className="text-sm font-medium">
          Follow-up date
        </label>
        <Input
          id="followUpDate"
          type="date"
          value={followUpDate}
          onChange={(e) => onChange("followUpDate", e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="followUpReason" className="text-sm font-medium">
          Follow-up reason
        </label>
        <Input
          id="followUpReason"
          maxLength={300}
          value={followUpReason}
          onChange={(e) => onChange("followUpReason", e.target.value)}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Implement the editor**

`src/components/rx/clinical-editor.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RX_LIMITS } from "@/lib/domain/rx-options";
import {
  applyHit,
  editorStateFromView,
  emptyMedicine,
  isBlankMedicine,
  medicineFrom,
  newKey,
  toItemPayload,
  type EditorInvestigation,
  type EditorMedicine,
  type EditorState,
} from "@/lib/rx/editor-state";
import { addClinicMedicineAction, removeFavouriteAction, saveFavouriteAction } from "@/server/actions/catalogue";
import type { FavouriteView } from "@/server/services/catalogue";
import type { ClinicalVisitView, ItemView } from "@/server/services/rx-mapping";
import { AdviceSection } from "./advice-section";
import { AutosaveStatusBar } from "./autosave-status";
import { ClinicalNotesSection } from "./clinical-notes-section";
import { InvestigationsSection } from "./investigations-section";
import { MedicinesSection } from "./medicines-section";
import { FINALIZE_OFFLINE_MESSAGE, useAutosave } from "./use-autosave";
import { VitalsSection } from "./vitals-section";

const selectClass = "flex h-11 w-full rounded-md border-2 border-gray-200 bg-white px-3 text-sm";
const NO_CONNECTION = "Could not reach the server. Check your connection and try again.";

type Props = {
  prescriptionId: string;
  visit: ClinicalVisitView;
  items: ItemView[];
  revision: number;
  favourites: FavouriteView[];
  canAddToClinic: boolean;
  /** can(role, "rx.finalize"); editing itself is gated by the page on rx.draft. */
  canFinalize: boolean;
};

export function ClinicalEditor({
  prescriptionId,
  visit,
  items,
  revision,
  favourites: initialFavourites,
  canAddToClinic,
  canFinalize,
}: Props) {
  const router = useRouter();
  const [state, setState] = useState<EditorState>(() => editorStateFromView({ visit, items }));
  const initialState = useRef(state);
  const [favourites, setFavourites] = useState<FavouriteView[]>(initialFavourites);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const autosave = useAutosave(prescriptionId, initialState.current, revision);
  const { update } = autosave;

  // Every edit produces a new state object; each one reaches the autosaver exactly once.
  useEffect(() => {
    if (state !== initialState.current) update(state);
  }, [state, update]);

  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    setState((s) => ({ ...s, [key]: value }));
  const setMedicine = (key: string, fn: (m: EditorMedicine) => EditorMedicine) =>
    setState((s) => ({ ...s, medicines: s.medicines.map((m) => (m.key === key ? fn(m) : m)) }));
  const setInvestigations = (fn: (list: EditorInvestigation[]) => EditorInvestigation[]) =>
    setState((s) => ({ ...s, investigations: fn(s.investigations) }));

  function appendMedicine(line: EditorMedicine, fillBlank: boolean) {
    setState((s) => {
      const blank = fillBlank ? s.medicines.findIndex(isBlankMedicine) : -1;
      if (blank >= 0) return { ...s, medicines: s.medicines.map((m, i) => (i === blank ? line : m)) };
      if (s.medicines.length >= RX_LIMITS.medicines) return s;
      return { ...s, medicines: [...s.medicines, line] };
    });
  }

  function removeMedicine(key: string) {
    setState((s) => {
      const rest = s.medicines.filter((m) => m.key !== key);
      return { ...s, medicines: rest.length > 0 ? rest : [emptyMedicine()] };
    });
  }

  function addInvestigation(name: string) {
    setInvestigations((list) =>
      list.length >= RX_LIMITS.investigations || list.some((t) => t.name.toLowerCase() === name.toLowerCase())
        ? list
        : [...list, { key: newKey(), name, instructions: "" }],
    );
  }

  async function saveFavourite(m: EditorMedicine): Promise<string> {
    try {
      const res = await saveFavouriteAction(toItemPayload(m));
      if (!res.ok) return res.message;
      const saved = res.value;
      setFavourites((list) =>
        [...list.filter((f) => f.id !== saved.id), saved].sort((a, b) => a.drugName.localeCompare(b.drugName)),
      );
      return "Saved as favourite";
    } catch {
      return NO_CONNECTION;
    }
  }

  async function removeFavourite(f: FavouriteView): Promise<void> {
    try {
      const res = await removeFavouriteAction(f.id);
      if (res.ok) setFavourites((list) => list.filter((x) => x.id !== f.id));
    } catch {
      // Nothing changed on the server, so the favourite stays listed.
    }
  }

  async function addToClinic(name: string, genericName: string): Promise<string> {
    try {
      const res = await addClinicMedicineAction({ name, genericName });
      if (!res.ok) return res.message;
      return res.value.created ? "Added to the clinic list" : "Already in the clinic list";
    } catch {
      return NO_CONNECTION;
    }
  }

  async function finalize() {
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const res = await autosave.finalize();
      if (res.ok) {
        autosave.stop();
        router.refresh(); // the page re-renders as the read-only finalized view
        return;
      }
      setFinalizeError(res.message);
    } catch {
      setFinalizeError(FINALIZE_OFFLINE_MESSAGE);
    } finally {
      setFinalizing(false);
    }
  }

  const reload = () => {
    autosave.stop(); // the user chose the server's version: no "unsaved changes" prompt
    window.location.reload();
  };

  return (
    // Disabled until the autosaver is live (after hydration): text typed into server-rendered inputs
    // before that would be wiped by React. Playwright's fill/click wait for enabled controls.
    <fieldset disabled={!autosave.ready} className="min-w-0 space-y-8 border-0 p-0">
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <label htmlFor="visitType" className="text-sm font-medium">
            Visit type
          </label>
          <select
            id="visitType"
            className={selectClass}
            value={state.visitType}
            onChange={(e) => set("visitType", e.target.value === "follow-up" ? "follow-up" : "new")}
          >
            <option value="new">New</option>
            <option value="follow-up">Follow-up</option>
          </select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="chiefComplaint" className="text-sm font-medium">
            Chief complaint
          </label>
          <Input
            id="chiefComplaint"
            maxLength={500}
            value={state.chiefComplaint}
            onChange={(e) => set("chiefComplaint", e.target.value)}
          />
        </div>
      </section>

      <VitalsSection
        vitals={state.vitals}
        notes={state.vitalsNotes}
        onChange={(key, value) => setState((s) => ({ ...s, vitals: { ...s.vitals, [key]: value } }))}
        onNotesChange={(value) => set("vitalsNotes", value)}
      />

      <ClinicalNotesSection
        state={state}
        onListChange={(key, values) => set(key, values)}
        onNotesChange={(value) => set("examinationNotes", value)}
      />

      <MedicinesSection
        medicines={state.medicines}
        favourites={favourites}
        canAddToClinic={canAddToClinic}
        onPatch={(key, patch) => setMedicine(key, (m) => ({ ...m, ...patch }))}
        onPick={(key, hit) => setMedicine(key, (m) => applyHit(m, hit))}
        onAdd={() => appendMedicine(emptyMedicine(), false)}
        onAddFavourite={(f) => appendMedicine(medicineFrom(f), true)}
        onRemove={removeMedicine}
        onSaveFavourite={saveFavourite}
        onRemoveFavourite={removeFavourite}
        onAddToClinic={addToClinic}
      />

      <InvestigationsSection
        items={state.investigations}
        onAdd={addInvestigation}
        onPatch={(key, patch) => setInvestigations((list) => list.map((t) => (t.key === key ? { ...t, ...patch } : t)))}
        onRemove={(key) => setInvestigations((list) => list.filter((t) => t.key !== key))}
      />

      <AdviceSection
        advice={state.advice}
        followUpDate={state.followUpDate}
        followUpReason={state.followUpReason}
        onChange={(field, value) => set(field, value)}
      />

      <footer className="sticky bottom-0 space-y-2 border-t bg-white py-3">
        <AutosaveStatusBar
          status={autosave.status}
          onRetry={autosave.retryNow}
          onOverwrite={autosave.overwrite}
          onReload={reload}
        />
        {finalizeError ? (
          <p role="alert" className="text-sm text-destructive">
            {finalizeError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void autosave.flush()}>
            Save now
          </Button>
          {canFinalize ? (
            <Button type="button" disabled={finalizing} onClick={() => void finalize()}>
              {finalizing ? "Finalizing…" : "Finalize"}
            </Button>
          ) : null}
        </div>
      </footer>
    </fieldset>
  );
}
```

- [ ] **Step 6: Implement the read-only view**

`src/components/rx/prescription-view.tsx` (a server component: no `"use client"`):

```tsx
import { formatDuration, formatSchedule, vitalsLine } from "@/lib/domain/rx-format";
import { FOOD_RELATION_LABELS, PERIODICITY_LABELS } from "@/lib/domain/rx-options";
import type { PrescriptionView } from "@/server/services/prescriptions";

function labelFor(labels: Record<string, string>, code: string | null): string {
  if (!code) return "";
  return Object.hasOwn(labels, code) ? labels[code] : code;
}

/** Finalized (or not-editable) prescription. All text is rendered as plain text by React. */
export function PrescriptionReadOnly({ rx }: { rx: PrescriptionView }) {
  const v = rx.visit;
  const tests = v.investigations.map((t) => (t.instructions ? `${t.name} (${t.instructions})` : t.name)).join(", ");
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Row label="Visit type" value={v.visitType === "follow-up" ? "Follow-up" : "New"} />
        <Row label="Chief complaint" value={v.chiefComplaint} />
        <Row label="Complaints" value={v.complaints.join(", ")} />
        <Row label="Diagnosis" value={v.diagnosis.join(", ")} />
        <Row label="Medical history" value={v.medicalHistory.join(", ")} />
        <Row label="Drug history" value={v.drugHistory.join(", ")} />
        <Row label="Vitals" value={vitalsLine(v.vitals)} />
        <Row label="Examination" value={v.examinationNotes} />
        <Row label="Investigations" value={tests} />
        <Row label="Advice" value={v.advice} />
        <Row label="Follow-up" value={[v.followUpDate, v.followUpReason].filter(Boolean).join(" — ")} />
      </dl>

      {rx.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No medicines.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">#</th>
                <th className="p-2">Medicine</th>
                <th className="p-2">Dose and schedule</th>
                <th className="p-2">Food</th>
                <th className="p-2">Duration</th>
                <th className="p-2">Remarks</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rx.items.map((i, index) => (
                <tr key={index} className="align-top">
                  <td className="p-2 text-muted-foreground">{index + 1}</td>
                  <td className="p-2">
                    <span className="font-medium">{i.drugName}</span>
                    {i.strength ? ` ${i.strength}` : ""}
                    {i.isSos ? <span className="ml-2 rounded bg-amber-100 px-1 text-xs font-semibold">SOS</span> : null}
                    {i.genericName ? <span className="block text-xs text-muted-foreground">{i.genericName}</span> : null}
                  </td>
                  <td className="p-2">
                    {[
                      i.dose,
                      formatSchedule({ morning: i.doseMorning, afternoon: i.doseAfternoon, evening: i.doseEvening, night: i.doseNight }),
                      i.timing,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td className="p-2">{labelFor(FOOD_RELATION_LABELS, i.foodRelation)}</td>
                  <td className="p-2">
                    {[formatDuration(i.durationValue, i.durationUnit), labelFor(PERIODICITY_LABELS, i.periodicity)]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td className="p-2">{i.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{value || "—"}</dd>
    </div>
  );
}
```

- [ ] **Step 7: Wire the page and remove the Plan 1A editor and read-only view**

Replace the whole content of `src/app/(app)/prescriptions/[id]/page.tsx` with. Compared with the current page it swaps `DraftEditor`/`ReadOnlyView` for `ClinicalEditor`/`PrescriptionReadOnly`, loads favourites for editors, gates Finalize on `rx.finalize`, and keeps everything else: every failed read (forbidden, malformed, unknown, foreign, an accountant) is a plain `notFound()`; the allergy banner stays in the header for drafts and finalized versions; Amend and Repeat (`RepeatForm`, which shows `repeatAction`'s `{ error }`) appear only on `finalized` versions. The header reads the same live patient fields as before (name, number, allergies) and nothing more; Plan 1C replaces them with the finalize-time snapshot.

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { getPrescription } from "@/server/services/prescriptions";
import { listFavourites } from "@/server/services/catalogue";
import { amendAction, repeatAction } from "@/server/actions/prescriptions";
import { AllergyBanner } from "@/components/patients/allergy-banner";
import { AmendForm } from "@/components/rx/amend-form";
import { ClinicalEditor } from "@/components/rx/clinical-editor";
import { PrescriptionReadOnly } from "@/components/rx/prescription-view";
import { RepeatForm } from "@/components/rx/repeat-form";

export const dynamic = "force-dynamic";

export default async function PrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  // Forbidden, malformed, unknown and foreign ids all look the same: a plain not-found.
  const result = await getPrescription(session, id);
  if (!result.ok) notFound();
  const rx = result.value;

  const isDraft = rx.status === "draft";
  // Clinical content is editable only by roles with rx.draft (owner, doctor); everyone else reads.
  const canEdit = isDraft && can(session.role, "rx.draft");
  const favourites = canEdit ? await listFavourites(session) : null;
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
            {rx.patient.name}
          </Link>
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

Replace the whole content of `src/server/actions/prescriptions.ts` with (the current actions minus the form-based `saveDraftAction` and its `DraftFormState`, which the autosaving editor replaces; `startPrescriptionAction`, `amendAction` and `repeatAction` are unchanged):

```ts
"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { amendPrescription, repeatPrescription, startPrescription } from "@/server/services/prescriptions";

export type AmendFormState = { error?: string };
export type RepeatFormState = { error?: string };

export async function startPrescriptionAction(patientId: string): Promise<void> {
  const session = await requireSession();
  const result = await startPrescription(session, { patientId });
  if (!result.ok) redirect(`/patients/${encodeURIComponent(patientId)}?error=${result.code}`);
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}

export async function amendAction(
  id: string,
  _prev: AmendFormState,
  formData: FormData,
): Promise<AmendFormState> {
  const session = await requireSession();
  const result = await amendPrescription(session, {
    prescriptionId: id,
    reason: String(formData.get("reason") ?? ""),
  });
  if (!result.ok) return { error: result.message };
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}

export async function repeatAction(id: string): Promise<RepeatFormState> {
  const session = await requireSession();
  const result = await repeatPrescription(session, id);
  if (!result.ok) return { error: result.message };
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}
```

Delete Plan 1A's editor and read-only view:

```powershell
Set-Location E:\projects\clinicpad; git rm src/components/rx/draft-editor.tsx src/components/rx/read-only-view.tsx
```

Then confirm nothing still imports them or the removed action:

```powershell
Set-Location E:\projects\clinicpad; git grep -n -e "draft-editor" -e "read-only-view" -e "ReadOnlyView" -e "saveDraftAction" -e "DraftFormState" -- src tests
```

Expected: no output. No `revalidatePath` is needed anywhere: the prescription and patient pages are `force-dynamic`, and the editor calls `router.refresh()` after finalizing.

- [ ] **Step 8: Run unit tests, typecheck, lint, and the e2e specs**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/unit/autosave-status.test.tsx
npm run typecheck
npm run lint
npm run test:e2e -- tests/e2e/clinical-form.spec.ts tests/e2e/prescriptions.spec.ts tests/e2e/patients.spec.ts tests/e2e/smoke.spec.ts
```

Expected: unit tests PASS; typecheck exits 0; lint 0 errors; all e2e tests PASS (prescriptions 5, clinical-form 2, patients 4, smoke 6). Troubleshooting, without weakening any assertion:
- A strict-mode violation on `getByLabel("Dose")`, `"Duration"`, `"Diagnosis"`, or `"Complaints"` means `{ exact: true }` was dropped ("Morning dose", "Duration unit", and the "… suggestions" listboxes contain the same words).
- Do not locate the status or error banners with `getByRole("alert")`: Next's route announcer also has that role. The specs use text locators.
- If typing seems lost right after navigation, a `waitForEditor(page)` call is missing (the editor is a disabled `fieldset` until it hydrates).
- If the offline test sees the page reload by itself after `setOffline(false)`, the dev server's hot-reload client reconnected with a full reload. Run the spec against a production server instead: in a second PowerShell window run `Set-Location E:\projects\clinicpad; npm run build:web; if ($?) { npm run start }`, then rerun the command above (Playwright reuses a running server).
- If "All changes saved" never appears, open the browser console in the Playwright trace: an `invalid` status ("Not saved: …") means the payload failed validation; fix the editor's payload, not the schema limits.

- [ ] **Step 9: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/components/rx/use-autosave.ts src/components/rx/autosave-status.tsx src/components/rx/vitals-section.tsx src/components/rx/clinical-notes-section.tsx src/components/rx/investigations-section.tsx src/components/rx/medicines-section.tsx src/components/rx/advice-section.tsx src/components/rx/clinical-editor.tsx src/components/rx/prescription-view.tsx "src/app/(app)/prescriptions/[id]/page.tsx" src/server/actions/prescriptions.ts tests/unit/autosave-status.test.tsx tests/e2e/helpers.ts tests/e2e/prescriptions.spec.ts tests/e2e/clinical-form.spec.ts
git status --short
git commit -m "feat: replace the plain draft editor with the autosaving clinical form" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

`git status --short` before the commit must show the two `git rm` deletions as staged (`D`) and nothing unstaged.

---

## Task 11: Discard a draft, withdraw an open amendment, and refuse repeat while a correction is open

**Files:**
- Modify: `src/server/services/prescriptions.ts` (add `discardDraft`; `repeatPrescription` gains the open-amendment refusal), `src/server/actions/prescriptions.ts` (add `DiscardFormState`, `discardDraftAction`), `src/app/(app)/prescriptions/[id]/page.tsx` (Discard / Withdraw control), `tests/e2e/prescriptions.spec.ts` (append one test)
- Create: `src/components/rx/discard-draft-form.tsx`, `tests/integration/prescriptions-discard.test.ts`

**Interfaces:**
- Consumes: Task 4's `finalizePrescription`, `amendPrescription`, `repeatPrescription`; the private helpers `prescriptionNotFound`, `IMMUTABLE_MESSAGE` in `prescriptions.ts`; `recordAudit`; `can(role, "rx.draft")`; the immutability triggers (a draft prescription, its items, and a draft visit may be deleted; a non-draft row may not, `23000`); `prescriptions_visit_fk` and `rx_items_prescription_fk` (`ON DELETE CASCADE`); Task 10's page, `waitForEditor`.
- Produces:
  - `discardDraft(ctx: ServiceContext, id: string): Promise<Result<{ patientId: string; parentPrescriptionId: string | null }>>` — owner/doctor only (`rx.draft`, else `forbidden`); malformed, unknown, or other-clinic id → `not_found`; a `finalized` or `amended` version → `immutable` and nothing changes; otherwise deletes the draft prescription (items cascade) and its draft visit, in one transaction, after locking the prescription row `FOR UPDATE`. Works the same for a first-version draft and for an open amendment (a draft with `parentPrescriptionId`), which frees the parent's one-open-amendment slot; the parent is never touched. Audit: `prescription.draft_discarded`, `entityId` = the discarded id, `before: { version, itemCount }` plus `parentPrescriptionId` for an amendment — ids and counts only.
  - `repeatPrescription` additionally refuses a `finalized` source that has an open amendment draft: `conflict`, "A correction of this prescription is in progress; finish or withdraw it first." It reads the source `FOR SHARE`, so a concurrent `amendPrescription` (which locks the source `FOR UPDATE`) is serialized with it.
  - `type DiscardFormState = { error?: string }`; `discardDraftAction(id: string, _prev: DiscardFormState): Promise<DiscardFormState>` — redirects to `/patients/<patientId>` after discarding a first-version draft and to `/prescriptions/<parentPrescriptionId>` after withdrawing an amendment; returns `{ error }` otherwise. (A page form action, not an editor action: the redirect happens only after the user confirmed throwing the draft away.)
  - `<DiscardDraftForm action label warning />` — a button ("Discard draft" or "Withdraw amendment") that opens an inline confirm step ("Yes, discard draft" / "Yes, withdraw amendment", "Keep it"); no browser dialog.
- Lock order: `discardDraft` locks only the draft it deletes. Against finalize of the same draft both take that row lock first; against `amendPrescription` of the parent it never touches the parent row; against `repeatPrescription` it never touches the source row. No new deadlock pair.

- [ ] **Step 1: Write the failing tests**

`tests/integration/prescriptions-discard.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, prescriptionItems, prescriptions, tenantCounters, visits } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import {
  amendPrescription,
  discardDraft,
  finalizePrescription,
  getPrescription,
  repeatPrescription,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";
import { newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";
const doctor = () => A.as("doctor");

beforeAll(async () => {
  A = await createTestTenant("disca");
  B = await createTestTenant("discb");
  const p = await createPatient(A.as("reception"), { name: "Discard Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

async function draftWithItem(): Promise<{ id: string; visitId: string }> {
  const started = await startPrescription(doctor(), { patientId });
  if (!started.ok) throw new Error(started.message);
  const id = started.value.prescriptionId;
  const saved = await saveDraft(doctor(), id, { items: [{ drugName: "Paracetamol" }] });
  if (!saved.ok) throw new Error(saved.message);
  const [row] = await adminDb.select({ visitId: prescriptions.visitId }).from(prescriptions).where(eq(prescriptions.id, id));
  return { id, visitId: row.visitId };
}

async function finalized(): Promise<string> {
  const { id } = await draftWithItem();
  const done = await finalizePrescription(doctor(), id);
  if (!done.ok) throw new Error(done.message);
  return id;
}

async function rowsOf(id: string, visitId: string) {
  const [rx, items, visit] = await Promise.all([
    adminDb.select().from(prescriptions).where(eq(prescriptions.id, id)),
    adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id)),
    adminDb.select().from(visits).where(eq(visits.id, visitId)),
  ]);
  return { rx: rx.length, items: items.length, visit: visit.length };
}

async function rxCounter(): Promise<number> {
  const rows = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
  return rows.find((c) => c.name === "rx")?.lastNo ?? 0;
}

describe("discardDraft", () => {
  it("deletes a first-version draft with its items and visit, and audits ids and counts only", async () => {
    const { id, visitId } = await draftWithItem();
    expect(await discardDraft(doctor(), id)).toEqual({ ok: true, value: { patientId, parentPrescriptionId: null } });
    expect(await rowsOf(id, visitId)).toEqual({ rx: 0, items: 0, visit: 0 });
    expect(await getPrescription(doctor(), id)).toMatchObject({ ok: false, code: "not_found" });

    const audit = await withTenant(A.tenantId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.entityId, id)));
    const event = audit.find((e) => e.action === "prescription.draft_discarded");
    expect(event?.before).toEqual({ version: 1, itemCount: 1 });
    expect(JSON.stringify(event)).not.toContain("Paracetamol");
  });

  it("withdraws an open amendment, keeps the original, and frees the slot for a new amendment", async () => {
    const original = await finalized();
    const reason = "Wrong patient selected";
    const amended = await amendPrescription(doctor(), { prescriptionId: original, reason });
    if (!amended.ok) throw new Error(amended.message);

    expect(await discardDraft(doctor(), amended.value.prescriptionId)).toEqual({
      ok: true,
      value: { patientId, parentPrescriptionId: original },
    });
    expect(await getPrescription(doctor(), original)).toMatchObject({ ok: true, value: { status: "finalized", version: 1 } });
    // The one-open-amendment slot is free again.
    expect(await amendPrescription(doctor(), { prescriptionId: original, reason: "A real correction" })).toMatchObject({
      ok: true,
      value: { version: 2 },
    });

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, amended.value.prescriptionId)),
    );
    const event = audit.find((e) => e.action === "prescription.draft_discarded");
    expect(event?.before).toEqual({ version: 2, itemCount: 1, parentPrescriptionId: original });
    expect(JSON.stringify(event)).not.toContain(reason);
  });

  it("never deletes a finalized or amended version", async () => {
    const original = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: original, reason: "Correct the dose" });
    if (!amended.ok) throw new Error(amended.message);
    expect(await finalizePrescription(doctor(), amended.value.prescriptionId)).toMatchObject({ ok: true });

    for (const id of [original, amended.value.prescriptionId]) {
      expect(await discardDraft(doctor(), id)).toMatchObject({ ok: false, code: "immutable" });
    }
    expect(await getPrescription(doctor(), original)).toMatchObject({ ok: true, value: { status: "amended" } });
    expect(await getPrescription(doctor(), amended.value.prescriptionId)).toMatchObject({
      ok: true,
      value: { status: "finalized" },
    });
  });

  it.each(["reception", "nurse", "pharmacist", "accountant"])("forbids %s", async (role) => {
    const { id, visitId } = await draftWithItem();
    expect(await discardDraft(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await rowsOf(id, visitId)).toEqual({ rx: 1, items: 1, visit: 1 });
  });

  it("lets an owner discard", async () => {
    const { id } = await draftWithItem();
    expect(await discardDraft(A.as("owner"), id)).toMatchObject({ ok: true });
  });

  it("hides other clinics' drafts, and treats malformed and unknown ids as not found", async () => {
    const { id, visitId } = await draftWithItem();
    expect(await discardDraft(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await discardDraft(doctor(), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
    expect(await discardDraft(doctor(), newId())).toMatchObject({ ok: false, code: "not_found" });
    expect(await rowsOf(id, visitId)).toEqual({ rx: 1, items: 1, visit: 1 });
  });

  it("races a finalize safely: exactly one wins, and no number is burned when the discard wins", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { id, visitId } = await draftWithItem();
      const before = await rxCounter();
      const [discarded, done] = await Promise.all([discardDraft(doctor(), id), finalizePrescription(doctor(), id)]);
      expect([discarded.ok, done.ok].filter(Boolean)).toHaveLength(1);
      if (done.ok) {
        expect(discarded).toMatchObject({ ok: false, code: "immutable" });
        expect(await getPrescription(doctor(), id)).toMatchObject({ ok: true, value: { status: "finalized" } });
      } else {
        expect(done).toMatchObject({ ok: false, code: "not_found" });
        expect(await rowsOf(id, visitId)).toEqual({ rx: 0, items: 0, visit: 0 });
        expect(await rxCounter()).toBe(before);
      }
    }
  });
});

describe("repeatPrescription with an open correction", () => {
  it("refuses while an amendment draft is open, and repeats again once it is withdrawn", async () => {
    const original = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: original, reason: "Check the dose" });
    if (!amended.ok) throw new Error(amended.message);

    const before = await adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.tenantId, A.tenantId));
    expect(await repeatPrescription(doctor(), original)).toEqual({
      ok: false,
      code: "conflict",
      message: "A correction of this prescription is in progress; finish or withdraw it first.",
    });
    const after = await adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.tenantId, A.tenantId));
    expect(after).toHaveLength(before.length);

    expect((await discardDraft(doctor(), amended.value.prescriptionId)).ok).toBe(true);
    const repeated = await repeatPrescription(doctor(), original);
    expect(repeated).toMatchObject({ ok: true });
    if (repeated.ok) {
      const ids = [repeated.value.prescriptionId];
      expect(await adminDb.select().from(prescriptions).where(inArray(prescriptions.id, ids))).toHaveLength(1);
    }
  });
});
```

Append to `tests/e2e/prescriptions.spec.ts`:

```ts
test("discard a draft and withdraw an amendment", async ({ page }) => {
  test.setTimeout(120_000);
  clinics.push(await registerClinic(page, "rxdiscard"));

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Discard Case");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Discard Case" })).toBeVisible();

  // An unwanted draft: Discard asks first; "Keep it" changes nothing; confirming returns to the patient.
  await page.getByRole("button", { name: /new prescription/i }).click();
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill("Unwanted");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("Unwanted");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await page.getByRole("button", { name: /yes, discard draft/i }).click();
  await expect(page.getByRole("heading", { name: "Discard Case" })).toBeVisible();
  await expect(page.getByText("No prescriptions yet.")).toBeVisible();

  // A finalized prescription and a correction that is withdrawn: the original stays and can be amended again.
  await page.getByRole("button", { name: /new prescription/i }).click();
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill("Kept Medicine");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  const rxUrl = page.url();
  await expect(page.getByRole("button", { name: "Discard draft" })).toHaveCount(0);

  await page.getByLabel("Reason for amendment").fill("Wrong patient selected");
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByRole("heading", { name: /draft amendment/i })).toBeVisible();
  await waitForEditor(page);
  await page.getByRole("button", { name: "Withdraw amendment" }).click();
  await page.getByRole("button", { name: /yes, withdraw amendment/i }).click();
  await expect(page).toHaveURL(rxUrl);
  await expect(page.getByRole("heading", { name: /Rx #1$/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Kept Medicine/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /start amendment/i })).toBeVisible();
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/prescriptions-discard.test.ts
```

Expected: FAIL — `discardDraft` is not exported, and repeat succeeds while the amendment is open.

- [ ] **Step 3: Add `discardDraft` and the repeat refusal**

In `src/server/services/prescriptions.ts`, add next to the other message constants:

```ts
const DRAFT_ONLY = "Only a draft can be discarded. A finalized prescription is kept; amend it instead.";
const CORRECTION_IN_PROGRESS = "A correction of this prescription is in progress; finish or withdraw it first.";
```

and add this function after `repeatPrescription`:

```ts
/**
 * Deletes a draft prescription together with its items and its draft visit: a first-version draft, or an
 * open amendment (which frees the parent's one-open-amendment slot; the parent itself is never touched).
 * A finalized or amended version is never deleted. The prescription row is locked first (ADR-0023), so a
 * concurrent finalize either wins (this then sees "finalized") or finds nothing left to finalize.
 */
export async function discardDraft(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ patientId: string; parentPrescriptionId: string | null }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can discard prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  try {
    return await withTenant(
      ctx.tenantId,
      async (tx): Promise<Result<{ patientId: string; parentPrescriptionId: string | null }>> => {
        const [rx] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1).for("update");
        if (!rx) return prescriptionNotFound();
        if (rx.status !== "draft") return fail("immutable", DRAFT_ONLY);

        const [visit] = await tx
          .select({ patientId: visits.patientId })
          .from(visits)
          .where(eq(visits.id, rx.visitId))
          .limit(1);
        const [{ value: itemCount }] = await tx
          .select({ value: count() })
          .from(prescriptionItems)
          .where(eq(prescriptionItems.prescriptionId, id));

        // The items go with the prescription (rx_items_prescription_fk cascades); the triggers allow it
        // because the prescription is a draft.
        await tx.delete(prescriptions).where(eq(prescriptions.id, id));
        // The draft visit goes too, unless another prescription still uses it (one per visit today).
        const [{ value: others }] = await tx
          .select({ value: count() })
          .from(prescriptions)
          .where(eq(prescriptions.visitId, rx.visitId));
        if (others === 0) await tx.delete(visits).where(eq(visits.id, rx.visitId));

        await recordAudit(tx, ctx, {
          action: "prescription.draft_discarded",
          entityType: "prescription",
          entityId: id,
          before: rx.parentPrescriptionId
            ? { version: rx.version, itemCount, parentPrescriptionId: rx.parentPrescriptionId }
            : { version: rx.version, itemCount },
        });
        return ok({ patientId: visit.patientId, parentPrescriptionId: rx.parentPrescriptionId });
      },
    );
  } catch (error) {
    // A visit that is no longer a draft refuses the delete (23000); the whole transaction rolled back.
    if (pgErrorInfo(error).code === "23000") return fail("immutable", DRAFT_ONLY);
    throw error;
  }
}
```

In `repeatPrescription`, change the source read to take a share lock, and add the open-amendment check directly after the superseded-version check:

```ts
    const [source] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1).for("share");
```

```ts
    // A correction in progress may change exactly what would be copied; finish or withdraw it first.
    const [open] = await tx
      .select({ id: prescriptions.id })
      .from(prescriptions)
      .where(and(eq(prescriptions.parentPrescriptionId, source.id), eq(prescriptions.status, "draft")))
      .limit(1);
    if (open) return fail("conflict", CORRECTION_IN_PROGRESS);
```

The order of checks stays draft → superseded → open correction → archived patient, so Plan 1A's exact-message test for the superseded refusal is unchanged.

- [ ] **Step 4: Run the service tests**

```powershell
Set-Location E:\projects\clinicpad; npm run test -- tests/integration/prescriptions-discard.test.ts tests/integration/prescriptions-lifecycle.test.ts tests/integration/prescriptions-clinical-lifecycle.test.ts tests/integration/immutability.test.ts
npm run typecheck
```

Expected: all PASS. If the race test ever sees both succeed, the `for("update")` lock is missing from `discardDraft`; if a discarded amendment leaves `amendPrescription` reporting "already in progress", the delete did not commit (check that no error after the delete was swallowed).

- [ ] **Step 5: Add the action, the confirm form, and the page control**

In `src/server/actions/prescriptions.ts`, add `discardDraft` to the services import and append:

```ts
export type DiscardFormState = { error?: string };

/** Discards a draft or withdraws an open amendment after the user confirmed it in the form. */
export async function discardDraftAction(id: string, _prev: DiscardFormState): Promise<DiscardFormState> {
  const session = await requireSession();
  const result = await discardDraft(session, id);
  if (!result.ok) return { error: result.message };
  redirect(
    result.value.parentPrescriptionId
      ? `/prescriptions/${result.value.parentPrescriptionId}`
      : `/patients/${result.value.patientId}`,
  );
}
```

`src/components/rx/discard-draft-form.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DiscardFormState } from "@/server/actions/prescriptions";

type Props = {
  action: (prev: DiscardFormState, formData: FormData) => Promise<DiscardFormState>;
  /** "Discard draft" or "Withdraw amendment". */
  label: string;
  /** What will happen, shown in the confirm step. */
  warning: string;
};

/** A destructive action behind an inline confirm step (no browser dialog). */
export function DiscardDraftForm({ action, label, warning }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as DiscardFormState);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
          {label}
        </Button>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="max-w-xl space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm">
      <p>{warning}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? "Working…" : `Yes, ${label.toLowerCase()}`}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
      {state.error ? (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
```

In `src/app/(app)/prescriptions/[id]/page.tsx`, add the imports

```tsx
import { discardDraftAction } from "@/server/actions/prescriptions";
import { DiscardDraftForm } from "@/components/rx/discard-draft-form";
```

(merge `discardDraftAction` into the existing `@/server/actions/prescriptions` import), and add this block directly after the `{canEdit ? (<ClinicalEditor … />) : (<PrescriptionReadOnly rx={rx} />)}` block:

```tsx
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
```

The control is shown only to roles with `rx.draft` on a draft (the service checks the role again). A pending autosave that lands after the discard gets `not_found` and is dropped with the unmounted editor; the user has just confirmed throwing the draft away.

- [ ] **Step 6: Run the e2e spec, then the full suite, and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/prescriptions.spec.ts
npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
git add src/server/services/prescriptions.ts src/server/actions/prescriptions.ts src/components/rx/discard-draft-form.tsx "src/app/(app)/prescriptions/[id]/page.tsx" tests/integration/prescriptions-discard.test.ts tests/e2e/prescriptions.spec.ts
git commit -m "feat: discard drafts, withdraw open amendments, and refuse repeat while a correction is open" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: the six prescriptions e2e tests PASS, then lint, typecheck, and the full suite are green.

---

## Task 12: Decisions, progress, and the Gate 1B verification

**Files:**
- Modify: `docs/DECISIONS.md`, `docs/PROGRESS.md`, `AGENTS.md`

**Interfaces:**
- Consumes: everything above; the current `docs/DECISIONS.md` (ADR-0001 to ADR-0026, then `## 19. Open decisions`), `docs/PROGRESS.md` (section 4.8 is the Phase 1A checklist with its "Phase 1A known limitations and follow-ups" list), `AGENTS.md` (§2 repository state, §6 commands, §8 next milestone, §10 things that will bite you).
- Produces: ADR-0027 to ADR-0031, an update note on ADR-0025, a Phase 1B checklist (section 4.9) with evidence, updated follow-up list, and a passing full gate. Plan 1C's ADRs then start at ADR-0032.

- [ ] **Step 1: Record the decisions**

Append to `docs/DECISIONS.md`, directly before the `## 19. Open decisions` heading. ADR-0022 to ADR-0026 belong to Plan 1A; if the file shows a different last number, renumber these consecutively and keep the text. Use the date the work lands.

```md
## ADR-0027 — Visit clinical content lives in columns on `visits`

- **Status:** accepted
- **Date:** <date>

**Context:** The clinical form adds complaints, medical and drug history, examination notes, vitals, ordered investigations, and a follow-up reason. `DATA_MODEL.md` sketches separate `vitals` and `investigations` tables. Everything that belongs to a finalized prescription must be immutable (ADR-0023) and copied by amend (ADR-0024).

**Decision:** Store them on `visits`: `text[]` for phrase lists, typed `jsonb` for `vitals` (one object per visit, temperature in °F, BMI computed not stored) and `investigations` (array of `{ name, instructions }`). Prescription items gain a generic name, four dose slots (`numeric(5,2)`, quarter steps), periodicity, SOS, and duration value + unit, with `duration_days` kept as derived total days. Plan 1A rows are read as durations in days; no data backfill (migration 0011). Blank phrase entries are dropped; a NUL in any text is refused (`invalid`), other stray control characters are removed (`cleanInput`, `src/server/validation/text.ts`).

**Consequences:** The existing visit and item immutability triggers, including the 0008 guard on a draft visit whose prescription is already finalized, cover the new columns with no new trigger (`tests/integration/clinical-schema.test.ts`). Amend copies every visit and item column through `omit()`, so later columns are copied too; repeat copies the prescribing content only. A future child table with clinical content (vitals history, lab orders) needs its own ADR-0023-style trigger.

**Revisit trigger:** vitals trend charts, lab orders with result status, or ICD-coded diagnosis analytics.

---

## ADR-0028 — Medicine catalogue: global reference tables plus clinic tables

- **Status:** accepted
- **Date:** <date>

**Context:** Doctors need fast medicine and clinical-term suggestions from day one, plus their own medicines and favourite dosing. A single table with a nullable `tenant_id` would need a special RLS policy on a tenant table.

**Decision:** `global_medicines` and `global_clinical_terms` have no `tenant_id`, are loaded from `sample_data/*.csv` by `npm run db:seed:catalogue` on the admin connection, and are SELECT-only for `clinicpad_app` (INSERT/UPDATE/DELETE/TRUNCATE revoked; RLS forced with a select-only policy for everyone except the migration role; migration 0012). Clinic additions go to `tenant_medicines`; default lines go to `medicine_favourites`, which belong to a doctor profile through the composite key `(tenant_id, doctor_id) -> doctors(tenant_id, id)` (`ON DELETE CASCADE`), one per medicine per doctor, upserted, at most 200. Search is a GET route handler (`/api/catalogue/search`) with escaped LIKE wildcards; no trigram index yet.

**Consequences:** Every tenant table keeps the standard isolation policy and the tenant-FK guard stays empty. No request path can modify the shared catalogue. A prescriber without a doctor profile has no favourites. The seed data is reference text, not a licensed drug database; it carries no clinical decision support.

**Revisit trigger:** a licensed drug database (Phase 6), a tenant above ~20k catalogue rows, or demand for clinic-learned complaint and diagnosis lists.

---

## ADR-0029 — Draft autosave with optimistic revisions

- **Status:** accepted
- **Date:** <date>

**Context:** Drafts must save automatically without losing or reordering edits when saves overlap, the network drops, or the same draft is open twice. The offline outbox is Phase 4.

**Decision:** Every save sends the full draft snapshot and the `draft_revision` it was based on. The server locks the prescription row, rejects a stale revision with `conflict` and the current revision, and otherwise writes and increments the revision. The client keeps exactly one save in flight, debounces 800 ms (at most 5 s during continuous typing), retries network failures with backoff from 1 s doubling to 30 s while showing "not saved", stops on a conflict until the user reloads or explicitly keeps their version, and finalizes through the same queue with `expectedRevision`, so content the doctor never saw is never finalized. The editor is disabled until it has hydrated and warns before unload while anything is unsaved. Editor server actions never redirect. Autosaves are not audited; `prescription.finalized` and `prescription.amended` add a clinical summary (counts and field names only) to Plan 1A's payload.

**Consequences:** No interleaved or reordered writes; two windows get a visible conflict instead of a merge. The Phase 4 outbox can reuse the revision contract as its idempotency and conflict check.

**Revisit trigger:** Phase 4 sync design, or users regularly editing one draft from two devices.

---

## ADR-0030 — Who may edit clinical content and use the catalogue

- **Status:** accepted
- **Date:** <date>

**Context:** The platform spec gives nurses vitals entry, but a nurse writing into a doctor's open draft would race the doctor's autosave. ADR-0026 holds the Plan 1A matrix.

**Decision:** Every clinical field, vitals included, is edited only by roles with `rx.draft` (owner, doctor); finalizing needs `rx.finalize`. Two actions join the matrix in `src/lib/domain/permissions.ts`: `catalogue.read` (owner, doctor, nurse, pharmacist) for medicine and term search, and `catalogue.write` (owner, doctor) for adding clinic medicines. Reception and accountants have neither. Nurse vitals capture moves to the Phase 3 queue flow as its own action and service.

**Consequences:** One writer per draft. Clinics that want nurses to record vitals wait for Phase 3.

**Revisit trigger:** design-partner feedback that nurse vitals entry is needed before Phase 3.

---

## ADR-0031 — Discarding drafts and withdrawing amendments

- **Status:** accepted
- **Date:** <date>

**Context:** Abandoned drafts stayed on the patient's list forever, and an open amendment could be neither finished nor abandoned, which blocked every further correction (one open amendment per prescription, ADR-0024). Repeat copied a prescription even while its correction was in progress.

**Decision:** `discardDraft` (owner, doctor) deletes a draft prescription with its items and its draft visit, after locking the prescription row: a first-version draft, or an open amendment, which frees its parent's slot without touching the parent. A finalized or amended version is never deleted (`immutable`; the triggers refuse it anyway). The event `prescription.draft_discarded` records ids and counts only. `repeatPrescription` refuses a source with an open amendment draft (`conflict`) and reads the source `FOR SHARE`. The page offers "Discard draft" / "Withdraw amendment" behind an inline confirm step.

**Consequences:** Drafts are not records (ADR-0029), so a discarded draft is gone; only its audit event remains. Doctors can always get out of an unwanted correction.

**Revisit trigger:** a clinic asking to restore a discarded draft (switch to a `discarded` status).
```

At the end of ADR-0025's **Decision** paragraph, append this sentence (an update note, not a new ADR):

```md
**Update (Plan 1B, migration `drizzle/0010_clinical_references.sql`):** `doctors` now has `UNIQUE (tenant_id, id)` and `UNIQUE (tenant_id, user_id)`, `template_versions` has `UNIQUE (tenant_id, id)`, and the three columns that had no foreign key are composite keys: `visits_doctor_fk`, `visits_branch_fk`, `prescriptions_template_version_fk`, each `ON DELETE SET NULL (column)`, hand-written. Deleting a doctor, branch, or template version that a finalized record references is refused by the immutability triggers; tenant offboarding still works (`tests/integration/clinical-references.test.ts`).
```

In ADR-0025's **Consequences**, replace the sentence that begins "The three columns listed above are not covered until the Plan 1B migration lands." with "Since migration 0010 the three columns listed above are covered too."

- [ ] **Step 2: Update `PROGRESS.md` and `AGENTS.md`**

In `docs/PROGRESS.md`, add a section `### 4.9 Phase 1B checklist (clinical form, catalogue, autosave)` directly after the Phase 1A block (after its "Gate 0 evidence block"). Tick an item only after its evidence exists (test name or command output), state the evidence run at the top as section 4.8 does, add a session-log entry for the date, and update the snapshot test counts:

```md
### 4.9 Phase 1B checklist (clinical form, catalogue, autosave)

- [ ] Same-tenant keys for `visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id`; one doctor profile per user per clinic; offboarding still works (migration 0010, `tests/integration/clinical-references.test.ts`)
- [ ] Clinical form on server data: vitals, complaints, diagnosis, history, drug history, examination, structured medicines, investigations, advice, follow-up (`tests/integration/prescriptions-clinical.test.ts`, `tests/e2e/clinical-form.spec.ts`)
- [ ] New clinical data frozen at finalize (including the draft-visit guard) and still cascades on tenant delete (`tests/integration/clinical-schema.test.ts`)
- [ ] NUL refused in every new text field; blank phrase entries dropped; Plan 1A NUL/date/db-error tests unchanged (`prescriptions-clinical.test.ts`, `prescriptions-draft.test.ts`, `prescriptions-db-errors.test.ts`)
- [ ] Amend copies every clinical field and item column; repeat copies prescribing content only and only from the latest finalized version (`tests/integration/prescriptions-clinical-lifecycle.test.ts`)
- [ ] Global catalogue seeded from sample_data, read-only for the app role (`tests/integration/catalogue-seed.test.ts`, `clinical-schema.test.ts`)
- [ ] Medicine search with literal wildcards, clinic medicines, per-doctor favourites with a composite key (`tests/integration/catalogue.test.ts`, `clinical-schema.test.ts`)
- [ ] Autosave: one save in flight, stale revision = conflict, offline retry, finalize the seen revision, editor disabled until hydrated, unsaved-changes guard (`tests/unit/autosave.test.ts`, `prescriptions-clinical.test.ts`, `editor-endpoints.test.ts`, `clinical-form.spec.ts`)
- [ ] Discard a draft and withdraw an open amendment; repeat refused while a correction is open (`tests/integration/prescriptions-discard.test.ts`, `prescriptions.spec.ts`)
- [ ] Reception, nurse, pharmacist, accountant cannot edit clinical content; Finalize gated on `rx.finalize` (`prescriptions-clinical.test.ts`, `prescriptions.spec.ts`)
- [ ] Audit: finalize records counts and field names; discard records ids and counts; no free text (`prescriptions-clinical-lifecycle.test.ts`, `prescriptions-discard.test.ts`)
- [ ] `npm run build:desktop` exit 0 with `src/app/api/catalogue` stashed and restored; `git status --short` clean
- [ ] `node scripts/verify-gate-0.mjs` PASSED with the Phase 1B tests
```

In the "Phase 1A known limitations and follow-ups" list of section 4.8, mark as resolved by Plan 1B (append " — resolved in Plan 1B" and the commit) only the items this plan closed, once their tests are green: "A blank diagnosis chip rejects the whole save", "No autosave (Plan 1B) and no unsaved-changes guard", "e2e tests may be flaky before hydration", "No way to discard a draft or withdraw an open amendment", "`repeatPrescription` ignores an open amendment on the source", "`doctorIdFor` can pick an arbitrary row". Leave the patient archive UI line as it is (not taken by Plan 1B) and every 1C/1D item. In section 5 ("In progress"), replace the ADR-renumbering note with: "Plan 1C's ADRs start at ADR-0032; its migrations start at 0013." In section 2, update the Phase 1 row.

In `AGENTS.md`:
- Update **Last updated** to today's date.
- In §2 "Repository state", append: "Phase 1B adds the server-backed clinical form (vitals, history, investigations, structured medicines with dose schedules), the global + clinic medicine catalogue with per-doctor favourites (`npm run db:seed:catalogue`), revision-checked draft autosave, and discarding drafts / withdrawing amendments. Templates, PDF, sharing, and offline are not built yet." and change "ADR-0019 to ADR-0026" to "ADR-0019 to ADR-0031".
- In §6 Commands, add below `npm run db:seed`: `npm run db:seed:catalogue   # global medicine and clinical-term lists (idempotent)`.
- In §8, name Plan 1C (templates, server PDF, print) as the next milestone.
- In §10 "Things that will bite you": in the "Composite-FK pattern" bullet, replace the sentences about `doctors` having no unique key and the three unkeyed columns with "Migration 0010 added `unique (tenant_id, id)` and `unique (tenant_id, user_id)` on `doctors` and composite keys for `visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id`; a doctor, branch, or template version referenced by a signed record cannot be deleted." and add three bullets:
  - "**Migrations cannot backfill clinical rows.** The immutability triggers reject `UPDATE` on finalized `visits`, `prescriptions`, and `prescription_items`; add nullable columns or constant defaults and read old rows with a fallback."
  - "**Server actions run one at a time.** Use GET route handlers for anything a client component fetches while typing (see `/api/catalogue/search`)."
  - "**A NUL is refused, never stripped.** Validate free text through `cleanInput`/`cleanOptionalText`/`cleanRequiredText` (`src/server/validation/text.ts`); `cleanText` alone strips NUL and is meant for search terms and keys."

- [ ] **Step 3: Desktop build and the full gate**

```powershell
Set-Location E:\projects\clinicpad; npm run build:desktop
git status --short
node scripts/verify-gate-0.mjs
```

Expected: the desktop build exits 0 and `git status --short` lists only the documentation edits from Steps 1–2 (nothing stashed or moved, no `.desktop-stash`); the gate prints `Gate 0 verification PASSED`, which now includes every unit, integration, and e2e test from Plans 1A and 1B. Do not tick any checklist box until you have seen this output. The gate log contains an expected `[auth][error] CredentialsSignin` trace from the wrong-password smoke test.

- [ ] **Step 4: Commit**

```powershell
Set-Location E:\projects\clinicpad; git add docs/DECISIONS.md docs/PROGRESS.md AGENTS.md
git commit -m "docs: record Phase 1B decisions (ADR-0027..0031) and progress" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## What Plan 1C expects from 1B

The template renderer and PDF pipeline (Plan 1C) read clinical data only through `getPrescription(ctx, id)`, whose `PrescriptionView` shape is stable after this plan (unchanged from the original 1B contract except where marked **new**):

- **Record:** `id`, `status`, `version`, `revision`, `rxNo`, `amendmentReason`, `parentPrescriptionId`, `finalizedAt`, `patient { id, name, patientNo, allergies }` (**new:** `allergies: string[]`, added by Plan 1A's review fix wave and read live).
- **Visit (`ClinicalVisitView`):** `id`, `visitType` (`new` | `follow-up`), `chiefComplaint`, `complaints[]`, `diagnosis[]`, `medicalHistory[]`, `drugHistory[]`, `examinationNotes`, `vitals` (`Vitals`: optional `bpSystolic`, `bpDiastolic`, `pulse`, `temperatureF`, `spo2`, `respiratoryRate`, `weightKg`, `heightCm`, `bloodSugarMgDl`, `notes`; an absent key was not measured), `investigations[] { name, instructions? }`, `advice`, `followUpDate` (`YYYY-MM-DD`), `followUpReason`. Arrays are never null.
- **Items (`ItemView[]`, in prescribing order, no ids):** `drugName`, `genericName`, `strength`, `form`, `route`, `dose`, `doseMorning`/`doseAfternoon`/`doseEvening`/`doseNight` (numbers or null), `timing` (free-text frequency), `foodRelation` and `periodicity` (codes from `src/lib/domain/rx-options.ts`), `isSos`, `durationValue` + `durationUnit` (`days` | `weeks` | `months`; Plan 1A rows arrive as days), `durationDays` (derived), `remarks`.
- **Formatting helpers to reuse (pure, tested):** `formatSchedule` ("1-0-1" or "1-0-1-1"), `formatDuration`, `formatBp`, `bmi`, `vitalsLine`, `FOOD_RELATION_LABELS`, `PERIODICITY_LABELS`. Placeholder mapping for `PRODUCT_SPEC.md` §7.3: `{{vitals.bp}}` = `formatBp(...)`, `{{complaints}}`/`{{diagnosis}}` = arrays joined with ", ", `{{#medicines}}` = items with `name`, `dose`, `timing` (`formatSchedule` or `timing`), per-slot quantities for pads with M/A/E/N columns, `duration` (`formatDuration`), food and periodicity labels, `sos`, `remarks`; `{{#tests}}` = investigations.
- **Text is untrusted plain text:** it may contain `<`, `&`, quotes, newlines, and Devanagari; it never contains a NUL (refused at validation). The renderer must escape it (React or docxtemplater escaping) and bundle Devanagari fonts; never inject it as HTML. `cleanText` (`src/lib/domain/text.ts`) still strips NUL; a schema that must report a NUL uses `cleanInput` + `hasNoNul` from `src/server/validation/text.ts` (**new** helpers).
- **Size limits for overflow tests:** up to 30 medicines, 30 investigations, 30 entries per phrase list, 2,000-character advice and examination notes.
- **Service and UI surface Plan 1C edits:** `finalizePrescription(ctx, id, opts?: { expectedRevision?: number })` (keeps Plan 1A's first-version vs amendment rule; audit payload `{ rxNo, version[, parentPrescriptionId], ...ClinicalSummary }`); `getSessionContext()` in `src/server/auth/session.ts`; `listFavourites(ctx)`; the page `src/app/(app)/prescriptions/[id]/page.tsx` renders `<ClinicalEditor … canAddToClinic canFinalize />` (**new** prop `canFinalize`), `<PrescriptionReadOnly rx />`, `<AllergyBanner … showWhenEmpty />`, Amend and `RepeatForm` (not a bare form) only for `finalized` versions, and `<DiscardDraftForm>` for drafts (**new**, Task 11); `tests/e2e/helpers.ts` exports `ensureCatalogue` and `waitForEditor` (**new**) next to the existing `registerClinic`, `cleanupClinic`, `setRole`. The last `MATRIX` entry is `"catalogue.write"`; whoever adds an action must also add its row to `granted` in `tests/unit/permissions.test.ts`.
- **Numbering:** this plan's migrations are `0010`–`0012`, so Plan 1C's start at `0013`; its ADRs start at ADR-0032. `doctors` has `UNIQUE (tenant_id, id)` (migration 0010), so a Plan 1C table may reference doctors with a composite key directly.
- **Two facts Plan 1C must design around:**
  1. Plan 1A's trigger rejects every `UPDATE` to a finalized prescription except the `finalized → amended` status flip, so `printed_at`, `shared_at`, or a cached `pdf_url` cannot be written onto the `prescriptions` row after finalize. Print/render/share records need their own append-only table (plus audit events).
  2. Patient name, number, and allergies, and the clinic and doctor details, are read live, not snapshotted at finalize; this plan adds no further live reads to the finalized view. Plan 1C must decide whether a reprint of an old prescription shows today's patient details or a snapshot taken at finalize.

---

## Self-review

**Spec and roadmap coverage**
- 1.3 Clinical form (medicines, vitals, diagnosis, tests/investigations, advice, follow-up, rich fields; `MedicalForm` migration): schema Task 2, validation and storage Task 3, UI Tasks 9–10, e2e Task 10. The legacy `MedicalForm` UX carried over: searchable medicine dropdown with keyboard navigation (Task 9 combobox), per-slot tablet quantities, food timing, SOS, periodicity, duration with unit, multi-select phrase lists with suggestions (Task 9 `TermListInput`), tests with instructions. The legacy IndexedDB repositories are not used.
- 1.4 Medicines (searchable catalogue tenant-scoped + global seed, favourites, dose/timing presets, free-text fallback): Tasks 2, 5, 6, 7, 9; presets are `SCHEDULE_PRESETS` (Task 1) and favourites carry full default dosing (decision 4); free text always accepted (combobox `onTextChange`, Task 3 schema).
- 1.2 Draft autosave with visible state and no lost edits: Tasks 3 (revision), 4 (`expectedRevision`), 7 (actions), 8 (engine), 10 (hook, status bar, hydration gate, unload guard, e2e offline and two-window tests); draft lifecycle completed by Task 11 (discard, withdraw).
- Hard requirements: (1) tenant isolation, composite keys, and read-only global seed — Task 2 (both parts) and Task 6; (2) immutability of new clinical data plus cascade — Task 2 (columns covered by the existing triggers including the 0008 visit guard, proven by direct admin SQL), Task 11 (discard never deletes a signed row); (3) amend/repeat copy every new field — Task 4; (4) audit payloads ids/counts/field names — Tasks 4, 6, 11; (5) Zod at every boundary with limits and hostile input, NUL refused, literal `%`/`_` — Tasks 1, 3, 6; (6) `can()` in services, reception cannot edit, Finalize on `rx.finalize` — Tasks 1, 3, 6, 10, 11; (7) overlapping autosaves — Tasks 3 and 8; (8) lock order (prescription row first; amend checks before it writes) — Tasks 3, 4, 11; (9) small files, existing primitives — File Structure and Task 9's UI rule.
- Out of scope and not included: template renderer, PDF/print, sharing, CSV import UI, merge, filters, Hindi strings, appointments, billing, DOCX; the Plan 1D items (DOB UTC/IST, status CHECKs, `tenant_counters` DELETE revoke, insert guard, `seedPatients` counter bypass, leaked-test-tenant sweep); and the patient archive UI/unarchive, which `docs/PROGRESS.md` lists under Plan 1B but which has no ruling or design yet (needs a decision: add a task here, or move it to 1D).

**Reconciliation with the Plan 1A implementation (HEAD `631f96b`):** every function this plan replaces is printed as the current function plus the 1B additions (`finalizePrescription` keeps the `parentPrescriptionId` rule and the no-number refusal; `amendPrescription` keeps `amendReasonSchema`, the constraint-name `23505` match, `invalidFromDatabase`, and check-before-write; `repeatPrescription` keeps the superseded refusal; `saveDraft` keeps the `23000` and `invalidFromDatabase` mapping; `getPrescription` keeps `patient.allergies`). The page keeps `notFound()` for every failed read, `RepeatForm`, `AllergyBanner`, and finalized-only Amend/Repeat; `repeatAction` keeps returning `{ error }`. The e2e rewrite keeps all five Plan 1A scenarios. `setRole` and `withAdminSql` are reused, not redefined.

**Placeholder scan:** every code step contains complete code; every command has expected output. Migration numbers (0010–0012) and ADR numbers (0027–0031) are exact for HEAD `631f96b`; the only parameter is `<model>` in commit trailers and `<date>` in the ADRs, both with an exact rule.

**Type consistency:** `SaveDraftResult`/`DraftConflict` (Task 3) are what `autosaveDraftAction` maps (Task 7) into `AutosaveResponse`, which `SaveResponseLike` (Task 8) mirrors structurally; `FinalizeResponse` (Task 7) is what `useAutosave().finalize` returns (Task 10). `ItemView`/`ClinicalVisitView` (Task 3) feed `editorStateFromView` (Task 8), `ClinicalEditor` props and `PrescriptionReadOnly` (Task 10). `FavouriteView`/`MedicineHit` (Task 6) are used by `applyHit`/`medicineFrom` (Task 8), the combobox (Task 9), and the editor (Task 10). `finalizePrescription(ctx, id, { expectedRevision })` (Task 4) is called by `finalizeDraftAction` (Task 7). `copyItems` moves from `prescriptions.ts` to `rx-mapping.ts` in Task 4 and Task 4 deletes the old copy. `cleanInput`/`cleanOptionalText`/`cleanRequiredText` (Task 3, `src/server/validation/text.ts`) are used by the prescription schema (Task 3) and the clinic-medicine schema (Task 6). `discardDraft` (Task 11) returns `{ patientId, parentPrescriptionId }`, which `discardDraftAction` turns into the redirect. `RX_LIMITS` keys (`medicines`, `phrases`, `diagnoses`, `investigations`, `favouritesPerDoctor`, `searchQuery`) are used with the same names in Tasks 3, 6, 9, 10. Labels asserted by the e2e specs match the components in Tasks 9–11 ("Medicine name", "Dose", "Duration", "Morning dose", "Generic name", "Food", "Complaints", "Diagnosis", "Add test", "Test name", "Test instructions", "Advice", "Pulse (/min)", "BMI", "Discard draft", "Withdraw amendment", "Keep it").

**Review Focus coverage:** (1) overlapping saves and two windows — Task 3 stale and simultaneous-save tests, Task 8 ordering tests, Task 10 two-window e2e; (2) dropped connection — Task 8 retry/backoff tests, Task 10 offline e2e; (3) hostile text — Task 1 `cleanText`/`searchTerm`, Task 3 round-trip, NUL and limit tables, Task 6 hostile search and NUL name, Task 10 e2e with no dialog; (4) wildcard and cross-tenant/cross-doctor leaks, read-only catalogue — Task 2 and Task 6; (5) finalizing unseen content and amend/repeat dropping fields — Task 4 and Task 7; (6) cross-clinic references and offboarding — Task 2 Part A; (7) discard safety, slot release, repeat during a correction — Task 11.

**Known gaps carried forward (not part of this plan):** nurse vitals entry (ADR-0030), advice templates and medicine bundles ("cold kit"), clinic-learned complaint/diagnosis suggestions, Hindi labels for the new codes (Plan 1D), the offline outbox (Phase 4), a clinical review of the sample_data catalogue text (it contains spelling errors such as "Glimepride" and is not a licensed drug database), temperature in °F only, and an undo for discarded drafts.
