# ClinicPad Phase 1D — Sharing, Consent, CSV Import, Patient History, and Pilot Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Phase 1 pilot-ready: a finalized prescription can be shared with the patient through WhatsApp (a `wa.me` message carrying a short-lived, revocable, audited link) or email, but only after DPDP-style consent is on record; a clinic can import its patient list from CSV with a mapping step, a dry-run validation report, and explicit duplicate decisions; each patient page lists that patient's prescriptions with filters and pagination, and owners can archive and restore patients; and the database, dates, and core screens get the hardening that Plans 1A–1C left for 1D.

**Architecture:** Sharing adds three tenant tables (`patient_consents`, `share_links`, `prescription_shares`; append-only except a narrow, trigger-guarded update path on `share_links`) and one public route, `/s/<token>`, outside the authenticated app. The token is 32 random bytes; only its SHA-256 is stored. The public route finds the link through one dedicated RLS policy keyed on the token hash (`withShareToken`), then does everything else through `withTenant`. A GET shows an interstitial page with no patient data (link previews and mail scanners never consume or render anything), and a POST renders the frozen finalized PDF through the existing renderer, limiter, and `PdfEngine`, counts one open, and logs a `prescription_outputs` row plus an audit event. Delivery sits behind small interfaces: WhatsApp is a `wa.me` deep link the clinic sends from its own WhatsApp; email goes through an `EmailProvider` (a fake in tests, a Resend adapter built only when credentials exist). CSV import is stateless: the browser keeps the file, and the server re-parses it for a dry-run and again for the commit, which runs in one transaction under a per-tenant advisory lock with a block of patient numbers and per-row idempotency keys. History is one filtered, paginated query in the clinic's timezone. Hardening is two migrations (triggers and grants; mirrored CHECKs, indexes, a composite key) and a timezone-correct date helper.

**Tech Stack:** Next.js 15.5 (App Router, route handlers, server actions), React 19, TypeScript strict, Drizzle ORM 0.45 + drizzle-kit 0.31, Postgres 16 with forced RLS, Zod 4, Vitest 5 (+ Testing Library, jsdom), Playwright, Node `crypto` (`randomBytes`, `createHash`), `TextDecoder`. **No new npm dependencies.**

**Spec:** `docs/ROADMAP.md` §3 (Phase 1) workstreams 1.1 (CSV import with mapping), 1.7 (sharing), 1.8 (patient history), 1.9 (share audit), 1.10 (pilot hardening) and the Phase 1 exit criteria; `docs/PRODUCT_SPEC.md` §6.2 (import, duplicates, consent with purpose/version/timestamp/revocation), §6.3 (share WhatsApp/email, history filters), §6.8 (provider abstraction, delivery log); `docs/DATA_MODEL.md` §3.2 (`patient_consents`), §3.7 (`messages`, audit); `docs/DECISIONS.md` ADR-0010 (WhatsApp behind an abstraction), ADR-0015 (dates), ADR-0016 (residency), ADR-0022 to ADR-0035 (what this plan builds on); `AGENTS.md` §3 invariants 1, 2, 3, 5, 7, 8 and §10. The follow-ups this plan owns are the items marked "Plan 1D" in `docs/PROGRESS.md` §4.8, §4.9 and §4.10 (listed under "Scope" below). This plan was written against the **code** at HEAD `bedd1ff` (branch `phase-1-prescription-mvp`); where the code and earlier plans differ, the code wins.

## Prerequisites

Plans 1A, 1B and 1C are merged on `phase-1-prescription-mvp` (HEAD `bedd1ff` or later). From PowerShell:

```powershell
Set-Location E:\projects\clinicpad; git log --oneline -1
Set-Location E:\projects\clinicpad; Get-ChildItem drizzle -Filter *.sql | Select-Object -Last 3 -ExpandProperty Name
Set-Location E:\projects\clinicpad; Test-Path src/server/services/rx-output.ts, src/server/services/rx-documents.ts, src/server/services/render-snapshot.ts, src/server/pdf/limiter.ts, src/server/http/response.ts, src/lib/csv.ts, src/lib/domain/phone.ts, src/components/rx/output-actions.tsx, src/components/rx/discard-draft-form.tsx, tests/helpers/tenant.ts, tests/helpers/fake-pdf-engine.ts, tests/e2e/helpers.ts
Set-Location E:\projects\clinicpad; docker compose up -d postgres gotenberg
Set-Location E:\projects\clinicpad; npm run test
```

Expected: HEAD `bedd1ff` (or a later commit on top of it); the last migrations are `0014_phase1c_print_security.sql`, `0015_print_hardening.sql`, `0016_renderer_version.sql` (so this plan's migrations are **0017 to 0022**; `docs/PROGRESS.md` §5 still says "start at 0016", which is stale and is corrected in Task 12); twelve `True` lines; `npm run test` reports **71 files, 1,625 passed + 1 skipped** (the Plan 1C final fix wave; write down the counts you see — they are the baseline for the totals in Task 12). The e2e suite has 49 tests (41 run, 8 opt-in screenshot tests skipped). If Postgres is not running, start Docker Desktop from `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`, then rerun `docker compose up -d postgres gotenberg`.

What the code at HEAD looks like, and what this plan relies on (checked file by file):

- **Results and context.** `Result<T>` / `ok` / `fail(code, message, field?)` / `invalidFrom(zodError)` in `src/lib/result.ts`; `ErrorCode` is `"forbidden" | "not_found" | "invalid" | "conflict" | "immutable" | "unavailable" | "timeout"`. `ServiceContext` = `{ userId, tenantId, role }` (`src/server/services/context.ts`). `recordAudit(tx, ctx, { action, entityType, entityId?, before?, after? })` in `src/server/services/audit.ts` inserts one `audit_events` row with `actorUserId: ctx.userId`.
- **Tenancy.** `withTenant(tenantId, fn)` (`src/server/db/tenant.ts`) opens a transaction on the RLS-bound `db` and sets `app.tenant_id` locally; `TenantTx` is its transaction type. `adminDb` (`src/server/db/admin.ts`) bypasses RLS and is for auth, sign-up, seed, scripts and tests only. Every tenant table has a policy keyed on `nullif(current_setting('app.tenant_id', true), '')::uuid` (migrations 0002, 0004, 0012, 0014); `tenants` has `tenant_self`.
- **Immutability (ADR-0023).** `public.enforce_rx_immutability()` is the **0005** version: a non-draft prescription is frozen except the `finalized -> amended` flip that changes only `status` and `updated_at`; deletes of non-draft rows only when `tenant_is_erased(tenant_id)`. Items (0008) read their parent `FOR SHARE` and fail closed; visits (0008) accept only the plain `draft -> finalized` flip once a prescription of the visit is not a draft. There is **no** INSERT guard: an INSERT of an already-finalized row is a documented limitation, and the demo seed (`src/server/db/seed.ts`, `seedDemo`) inserts its visits with `status: "finalized"` directly. `public.enforce_print_rows_immutable()` (0015) is a reusable admin-level append-only trigger function (refuses UPDATE/DELETE with `23000` unless the tenant is erased; its message uses `tg_table_name`).
- **Status values** are free text today: `prescriptions.status` (`draft | finalized | amended`) and `visits.status` (`draft | finalized`) have no CHECK. `tests/integration/print-schema.test.ts` sets a draft to `"void"` to prove the outputs trigger uses an allow-list; three tests flip `finalized -> amended` with no successor (`tests/integration/immutability.test.ts:117`, `tests/integration/print-schema.test.ts:240` and `:276`). Task 1 changes exactly those.
- **Counters.** `tenant_counters` (PK `(tenant_id, name)`, names `patient` and `rx`) grants `select, insert, update, delete` to `clinicpad_app` (0004). `allocateNumber(tx, tenantId, name)` (`src/server/services/numbering.ts`) upserts `last_no + 1`.
- **CHECK constraints** exist only in SQL: 0012 (`global_terms_kind_check`, `rx_items_duration_unit_check`, `favourites_duration_unit_check`), 0014 (`clinic_assets_{kind,mime,size,dimensions,sha256}_check`, `clinics_rx_{template,paper_size,labels}_check`, `rx_outputs_{kind,paper_size,page_count,byte_size,sha256}_check`), 0015 (`clinic_assets_hash_matches_check`, `rx_outputs_template_key_check`). No Drizzle table declares `check(...)`.
- **Composite keys (ADR-0025).** The guard in `tests/integration/tenant-fk.test.ts` ("has no single-column key into a tenant-owned table") accepts only keys whose child columns are `(tenant_id, x)` and whose parent columns are exactly `tenant_id,id`. `memberships` has `unique("memberships_tenant_user_unique").on(tenantId, userId)`. `tenant_medicines.created_by` has no key. `createTestTenant(label)` (`tests/helpers/tenant.ts`) inserts a tenant, one user, a doctor row, and a clinic row, but **no membership**; `as("owner")`/`as("doctor")` share that user, other roles get a random user id.
- **Patients.** `patientInputSchema` (`src/server/validation/patient.ts`) refuses a DOB after **UTC** today (`new Date().toISOString().slice(0, 10)`), so a newborn registered between 00:00 and 05:30 IST is refused. `createPatient(ctx, raw, { allowDuplicate? })` returns `duplicate_candidates` on a normalized-phone match among active patients; `toColumns(input)` (private) maps input to columns; `searchPatients`, `getPatient(ctx, id)` (active only), `updatePatient`, `archivePatient(ctx, id)` (owner; sets `deleted_at`; audit `patient.archived`) exist. There is no unarchive, no archive action or UI. The patient pages call `ageLabel(p.dob, new Date())` — the **UTC** calendar day. `clinicLocalDate(at, timeZone)` exists in `src/server/services/render-snapshot.ts` (used for the frozen age); `DEFAULT_TIME_ZONE` and `isValidTimeZone` live in `src/lib/rx-render/format.ts`; `primaryClinic(tx, tenantId, lock?)` is in `render-snapshot.ts`.
- **Phones.** `normalizePhone(raw)` (`src/lib/domain/phone.ts`) returns 10 national digits for Indian numbers (`+91 …`, `91…`, `0…`, `0091 …`), full digits for other `+`/`00` numbers, and does not handle `tel:` or `+0091` (a Plan 1A follow-up).
- **History.** `listPrescriptionsForPatient(ctx, patientId)` (`src/server/services/prescriptions.ts`) returns every prescription of a patient unfiltered and unpaginated; the patient page renders it as a plain list.
- **Output path (ADR-0033/0034).** `src/server/services/rx-output.ts`: private `render(bundle)` runs `renderPrescription` and `checkSelfContained` on both parts; `recordOutput` writes `prescription_outputs` + audit in one `withTenant`; `renderPrescriptionPdf(ctx, id, engine = getPdfEngine(), limiter = renderLimiter)`; `listPrescriptionOutputs(ctx, id)` counts every output row. `loadRxDocument(ctx, id, { withAssets? })` (`src/server/services/rx-documents.ts`) does the `rx.read` check, then everything inside one `withTenant`. `prescription_outputs.kind` is `pdf_download | browser_print`; `actor_user_id` is nullable. `createLimiter({ concurrency, maxQueue })` returns `{ run(task) }` with `LimiterResult<T> = { busy: true } | { busy: false; value: T }` and no abort handling (a Plan 1C follow-up). `PdfEngine.render(doc)` takes no options; Gotenberg's fetch uses `AbortSignal.timeout`.
- **HTTP helpers** (`src/server/http/response.ts`): `statusForError`, `publicMessage`, `publicCode`, `crossSiteRefusal(request)` (allows absent, `same-origin`, `none`), `headNotAllowed()`, `contentDisposition(type, fileName)`. `escapeHtml` is in `src/lib/rx-render/html.ts`.
- **Middleware** (`src/middleware.ts`) matches `/dashboard`, `/patients`, `/prescriptions`, `/settings` only, so a new top-level `/s/...` route is public. `scripts/build-desktop.mjs` `SERVER_ONLY` lists `src/app/(app)`, `src/app/(auth)`, `src/app/api/{auth,health,catalogue,clean-data}`, `src/app/page.tsx`, `src/middleware.ts`; a new server route outside these must be added.
- **CSV.** `parseCsv(text)` / `csvRecords(text)` (`src/lib/csv.ts`) parse comma-only RFC 4180 with an optional BOM; used by `src/server/db/catalogue-seed.ts`. `sample_data/` holds only catalogue lists (`medicines_template.csv` `name,salt`; complaints/diagnosis/history/tests `name[,icdCode]`), loaded globally by `npm run db:seed:catalogue`. There is **no patient CSV sample**.
- **UI.** `DiscardDraftForm({ action, label, warning })` (`src/components/rx/discard-draft-form.tsx`) is a generic inline-confirm form (focus on "Keep it", polite live region); `OutputActions({ prescriptionId, fileName })` renders Print and Download PDF; `RepeatForm({ action })`; `PatientForm({ action, initial?, submitLabel, allowDuplicateConfirm? })`. Client components import server actions directly (tests mock the actions module). The settings page is owner-only (`settings.clinic`).
- **Roles** (`src/lib/domain/permissions.ts`): `patient.read` (owner, doctor, reception, nurse), `patient.write` (owner, doctor, reception), `patient.archive` (owner), `rx.read` (owner, doctor, reception, nurse, pharmacist), `rx.draft`/`rx.finalize`/`rx.amend` (owner, doctor), `catalogue.read`, `catalogue.write`, `settings.clinic` (owner), `settings.profile` (owner, doctor). `tests/unit/permissions.test.ts` has a typed `granted: Record<Action, readonly string[]>`, so every new action needs a row there or typecheck fails.
- **Environment.** `.env.example` has `NEXT_PUBLIC_APP_URL=http://localhost:3000`, `AUTH_SECRET=`, `RESEND_API_KEY=` (empty), `EMAIL_FROM=no-reply@example.com`, and WhatsApp Cloud API placeholders. Playwright (`playwright.config.ts`) starts `npm run dev` and reuses an existing server outside CI.

## Where this plan sits in Phase 1

| Plan | Roadmap workstreams | Ships |
|---|---|---|
| 1A (done) | 1.1 core, 1.2 lifecycle, 1.8 list, 1.9 audit | Patients + immutable, audited prescription lifecycle |
| 1B (done) | 1.3 clinical form, 1.4 catalogue, 1.2 autosave | Server-backed clinical form, catalogue, lossless autosave |
| 1C (done) | 1.5 renderer, 1.6 PDF + print, 1.9 print audit | A prescription that looks like a pad, prints, downloads as PDF |
| **1D (this plan)** | 1.7 sharing, 1.1 CSV import + duplicate decisions, 1.8 history filters, 1.9 share audit, 1.10 pilot hardening | Pilot-ready for design partners (pending the human decisions below) |

Out of scope (do not build here): the WhatsApp Cloud API or any BSP integration (needs Meta business verification and credentials, ADR-0010; the provider interface is ready for it), delivery-status webhooks, SMS, a patient merge tool beyond "fill empty fields", importing anything other than patients, DOCX/overlay templates, offline, billing, an app-UI language switch, a temperature unit setting (decision 22), and Template Studio.

## Scope: the Plan 1D follow-ups and where they land

| Follow-up (`docs/PROGRESS.md`) | Task |
|---|---|
| 4.8 / 4.10: DOB uses the UTC date (newborn 00:00–05:30 IST refused); age label on UTC day; "DOB read as UTC midnight and shown/aged in IST" | 3 |
| 4.8 / 4.9: `tenant_counters` DELETE grant; BEFORE INSERT draft guard; finalized-child precondition for `finalized -> amended`; CHECKs on status columns | 1 |
| 4.9: CHECKs for periodicity, dose ranges, `duration_value > 0`; 0012 CHECKs only in SQL | 2 |
| 4.9: indexes on `visits(tenant_id, doctor_id)`, `visits(tenant_id, branch_id)`, `prescriptions(tenant_id, template_version_id)` | 2 |
| 4.9: catalogue-wide RLS guard test | 1 |
| 4.9: `tenant_medicines.created_by` has no key | 2 |
| 4.8 / 4.9: e2e `seedPatients` bypasses `tenant_counters` | 2 |
| 4.8 / 4.9: dev database leaked test tenants (sweep script) | 2 |
| 4.8 / 4.9: patient archive UI and unarchive | 4 |
| 4.9: temperature unit (°C/°F) | deferred with reason (decision 22, Task 12 records it) |
| 4.9: Hindi labels for the new option codes | 11 |
| 4.10: "Page x of y" English only | decided (decision 23, Task 12 records it) |
| 4.10: PDF limiter has no abort plumbing | 9 |
| 4.10: Next dev `TypeError: controller[kState].transformAlgorithm is not a function` | 11 (investigation, recorded finding) |
| 1.10: empty states, error states, keyboard flow | 4, 7, 10, 11 |
| 4.8: phone edge cases (`tel:`, `+0091`) | 5 |

## Decisions made in this plan

Each line: decision — reason — cost if wrong. Task 12 records the durable ones as ADR-0036 to ADR-0041 (ADR-0035 is Plan 1C's last; re-check that ADR-0036 is still the next free number before writing them).

1. **Consent is an append-only event log, `patient_consents`** (`purpose = 'sharing'`, `version` such as `sharing-v1`, `granted` true or false, `method` `verbal | written`, `captured_by`, `created_at`); the current state is the latest event per patient and purpose; withdrawal inserts `granted = false` — DPDP evidence needs history, and append-only rows need no update path — one extra row per change.
2. **Consent is required before every share, whoever the recipient is** — WhatsApp and the email provider are third-party processors even when the recipient is the patient — the clinic records consent once per patient (not per share).
3. **Withdrawing consent and archiving a patient revoke that patient's active share links in the same transaction** (`revoke_reason` `consent_withdrawn` / `patient_archived`) — DPDP withdrawal means stop processing; an archived patient is usually a duplicate or has left — a patient who wants a link again needs consent recorded again.
4. **Share links:** 32 random bytes, base64url (43 characters); only the SHA-256 hex is stored (`share_links.token_hash`, unique); lifetime 7 days, at most 10 opens, revocable; only the current `finalized` version can be shared (a draft is refused, a superseded version is refused). A link to a version that is superseded later keeps opening, and the pad then carries the SUPERSEDED marker the renderer already prints — the record stays truthful and the patient sees it is replaced — a pharmacist could ignore the watermark; the panel tells staff to send the new version.
5. **The public route `/s/<token>` is two-step.** GET answers an interstitial HTML page (no patient name, no clinic name, no clinical text; `noindex`) with an "Open prescription (PDF)" form button; POST renders the PDF, counts one open, and logs it. Link previews (WhatsApp, Telegram, Slack) and mail scanners only GET, so they never consume an open, render a PDF, or see PHI — one extra tap for the patient.
6. **One uniform "not found" answer** (same status 404, same body, same headers) for a malformed, unknown, expired, revoked, used-up, or sharing-switched-off link; tokens are format-checked before any query; a POST from another site (`Sec-Fetch-Site: cross-site` or `same-site`) gets the same 404. A failed PDF render answers 503 and burns no open — no tenant or state can be probed — a confused patient sees one generic message ("ask the clinic to send it again").
7. **The token lookup runs without a tenant, through one narrow RLS policy:** `share_link_by_token` on `share_links`, `FOR SELECT TO clinicpad_app USING (token_hash = current_setting('app.share_token_hash'))`, reached only through `withShareToken(hash, fn)` (`src/server/db/share-token.ts`); everything after the lookup runs in `withTenant(link.tenantId)`. No `SECURITY DEFINER` function, no `adminDb` on a public path; the RLS guard test allow-lists exactly this policy — knowing the 256-bit hash is equivalent to holding the token.
8. **Sharing is off per clinic until the owner turns it on** (`clinics.sharing_enabled boolean not null default false`, Settings). Turning it off makes every link of the clinic answer the uniform 404 at once (a kill switch) — safe by default while consent wording and the Hindi text await human review — one owner click per clinic before a pilot.
9. **WhatsApp = a `wa.me` deep link the clinic sends itself:** `https://wa.me/<international digits>?text=<message>`; the message holds the clinic name, the Rx number, the link and its expiry date — never the patient's name or clinical text. The link is opened by a real click on an anchor (`target="_blank" rel="noopener noreferrer"`), never `window.open` after an `await` (popup blockers), and works on phones and on desktop (WhatsApp Desktop or Web). No WhatsApp Cloud API: it needs Meta business verification, templates and credentials — the channel interface (`shareByWhatsApp`) is the seam for it.
10. **Email = an expiring link, not a PDF attachment,** through `EmailProvider` (`send(message) -> EmailOutcome`, never throws). `createResendProvider` posts to Resend with an injected `fetch`; `getEmailProvider()` returns `null` unless `RESEND_API_KEY` and a valid `EMAIL_FROM` are both set, and the UI then says email is not set up. Tests use `createFakeEmailProvider` and never touch the network — a link is revocable and its opens are audited; an attachment would sit in mailboxes forever — patients without data on their phone cannot open a link offline.
11. **The share log `prescription_shares` is append-only** (channel, masked recipient, link, provider, status `prepared | sent | failed`, provider message id, error code). Recipients are stored **masked only** (`+91******3210`, `a***@example.com`); the full number or address exists only in the request and the provider call. No hash: an unkeyed hash of a 10-digit phone is reversible by brute force, and a keyed one needs a managed secret — revisit with delivery reconciliation (Phase 3).
12. **Rate limits:** database-counted — at most 60 links per user per hour, 10 active links per prescription, 5 emails per prescription per 24 hours; in memory — 20 public-route requests per client IP per minute (per process; production adds edge limits), on top of the shared PDF limiter. Two simultaneous shares can overshoot a database limit by one (no lock; same trade-off as the asset caps, ADR-0035).
13. **Lock rule for share links:** lock the patient row before writing that patient's links — `FOR SHARE` to create a link, `FOR UPDATE` (or the patient `UPDATE` itself) to withdraw consent or archive. The public open updates only its own link row. No prescription row is locked by any sharing path, so ADR-0023's two lock orders are untouched.
14. **Roles:** new actions `rx.share` (owner, doctor, reception — reception prints and shares, ADR-0026), `consent.capture` (owner, doctor, reception), `patient.import` (owner). Archive and restore keep `patient.archive` (owner). Nurses and pharmacists cannot share — the default while the data-minimisation decision is open.
15. **CSV import is stateless:** the browser keeps the file and sends it twice (dry-run, commit); the commit refuses when the file's SHA-256 differs from the dry-run's. No PHI staging table — the file travels twice (at most 1 MB).
16. **Import caps and encodings:** at most 1,000,000 bytes (Next's server-action body limit is 1 MB; the browser checks first, the server again), 5,000 data rows, 40 columns, 2,000 characters per mapped cell. Accepted: UTF-8 (BOM stripped) and UTF-16 LE/BE **with** a BOM (Excel "Unicode Text", tab-separated); refused with a specific message: `.xlsx`/`.xls` workbooks, UTF-16 without a BOM or binary data, and any byte sequence that is not valid UTF-8 (Excel's ANSI/Windows-1252 "CSV") — no silent mojibake. The delimiter is detected from the header line among `,`, `;` and tab.
17. **Import mapping and row rules:** headers are matched to fields by aliases (the user can change every choice; each column maps to at most one field; a name column is required); every row goes through the same `patientInputSchema` as the form, after Excel repairs: dates `YYYY-MM-DD`, `D/M/YYYY`, `D-M-YYYY`, `D.M.YYYY` (day first, as in India), and Excel serial numbers; a two-digit year or a month above 12 in the second position is refused, not guessed; phones in scientific notation (`9.87654E+09`) are refused (Excel already destroyed the digits); a leading `'` and a trailing `.0` are removed; a NUL in a mapped cell refuses the row (never stripped). An "Age" column is reported as not imported — a birth date is never invented from an age.
18. **Duplicates:** a row is a duplicate when its normalized phone matches an active patient or an earlier row of the file. Per row the owner chooses `skip` (default), `create` (register a separate patient — families share phones), or `fill` (add only the missing details of the matched patient: DOB, gender if unknown, address, allergies if none, notes; never overwrite), offered only when exactly one active patient matches by phone **and** `sameName` agrees. An exact repeat inside the file (same name, phone and DOB) can only be skipped. Decisions are re-checked at commit; a row that became a duplicate since the dry-run is skipped.
19. **Import idempotency:** every imported patient stores `import_row_key` = SHA-256 of `nameKey(name) | normalized phone | dob` (partial unique index per tenant); a re-run reports those rows as "already imported" and writes nothing for them. The commit takes `pg_advisory_xact_lock` per tenant, allocates patient numbers as one block (`allocateNumbers`), and writes `patient_imports` (append-only job row: actor, file SHA-256, counts), one `patient.created` audit event per patient with `importId`, `patient.updated` for each fill with field names, and `patient_import.committed` — a re-run, a double-click, or two tabs never duplicate patients or burn numbers.
20. **The validation report** lists every problem row (row number as Excel shows it, field, message) and every duplicate; "Download problem rows" builds a CSV in the browser with `serializeCsv`, which prefixes `'` to any cell starting with `=`, `+`, `-`, `@`, tab or CR (formula injection) and writes a UTF-8 BOM so Excel shows Devanagari — a phone like `+91…` shows as `'+91…` in that report.
21. **Sample data:** the ROADMAP criterion "CSV import of the existing `sample_data/*.csv` shape" — those files are the catalogue lists that `npm run db:seed:catalogue` already loads (idempotent, Plan 1B); for patients this plan adds `sample_data/patients_template.csv` (synthetic people) as the documented shape, and the import page offers the same template for download. No clinic-level medicine import (clinic medicines are added in the editor; YAGNI).
22. **Temperature unit (°C/°F) is deferred:** it changes the frozen snapshot (`v` bump), the autosave payload, the renderer and five golden files; it belongs with Phase 3 nurse vitals — °F only until then.
23. **"Page x of y" stays English, with Western digits, in every label language:** Gotenberg's footer template cannot rely on the embedded Devanagari font, and Western digits are normal on Indian pads; listed for the Hindi reviewer.
24. **Hindi labels for the option codes have one source,** `FOOD_RELATION_LABELS_HI` and `PERIODICITY_LABELS_HI` in `src/lib/domain/rx-options.ts`, imported by `src/lib/rx-render/labels.ts`; printed output stays byte-identical (golden files unchanged, `RENDERER_VERSION` unchanged); marked NEEDS NATIVE-SPEAKER REVIEW. The app UI stays English (no UI language switch in Phase 1).
25. **Database hardening (Tasks 1–2):** an INSERT guard (rows are born `draft`), the `finalized -> amended` flip requires a finalized successor of the same tenant, status CHECKs, `tenant_counters` DELETE/TRUNCATE revoked, value CHECKs on items and favourites, every CHECK also declared in the Drizzle schema (guard test), indexes on the 0010 foreign-key columns, `tenant_medicines (tenant_id, created_by) -> memberships (tenant_id, user_id) ON DELETE SET NULL (created_by)`, and a schema-wide RLS guard test. New CHECKs are added `NOT VALID` and validated in the same migration when every row passes, so a development database with leftover test rows still migrates (the sweep script removes those rows). RLS policies, grants and triggers stay in custom SQL (Drizzle's policy support would make drizzle-kit own them).
26. **Clinic-timezone dates:** a DOB may be up to "today in the clinic's timezone"; the Zod schema keeps a structural bound (the latest calendar date on Earth, UTC+14) and the services apply the clinic's day; patient ages on screen use the clinic's day; history date filters are clinic-local calendar days.
27. **PDF limiter abort:** `Limiter.run(task, { signal })` drops a queued task whose request was aborted (it never takes a slot) and answers `{ busy: false, aborted: true }`; the engine's fetch combines its timeout with the caller's signal. The PDF route and the public share route pass `request.signal`.
28. **Patient history:** `listPatientPrescriptions(ctx, patientId, filters)` — clinic-local `from`/`to` days on `coalesce(finalized_at, created_at)`, doctor (the visit's doctor), status, and text (diagnosis or chief complaint, escaped `ILIKE`); 20 per page with a total order; malformed filter values are ignored, not errors. Each row offers Open, Print and Download PDF (`OutputActions`, non-drafts) and Repeat (`RepeatForm`, current finalized versions, `rx.draft`).
29. **Archive and restore:** owner-only, behind the inline confirm; an archived patient is hidden from search, cannot get new prescriptions or shares, keeps every record, and is listed under "Show archived" on the Patients page for the owner, where it can be restored; audit `patient.archived` (with `revokedLinks`) and `patient.unarchived`.

## Human decisions this plan does not make (and the safe default meanwhile)

| Decision | Owner | Safe default in code |
|---|---|---|
| May an owner without a doctor profile finalize? (open since Plan 1A) | founder / clinical | Unchanged: finalize warns and prints no doctor block (ADR-0032). Sharing such a prescription is allowed (it is the finalized record). |
| Data minimisation: should reception and pharmacists read, print, download, and (reception) share full clinical content? | founder / legal | `rx.read` unchanged; `rx.share` is owner, doctor, reception only; nurses and pharmacists cannot share. |
| WhatsApp channel: Meta Cloud API directly or a BSP (ADR-0010, open decision #2) | founder | Not built. `wa.me` manual send only; no message leaves ClinicPad's servers. |
| Consent wording (English) — legal review; the Hindi consent text, interstitial line and pad labels — native-speaker review | founder / legal / native speaker | `clinics.sharing_enabled` defaults to **false**; nothing can be shared until the owner turns it on in Settings. The consent version (`sharing-v1`) is stored with every grant, so a reworded text becomes `sharing-v2` without losing evidence. |
| Link lifetime (7 days) and open limit (10) | product | Constants in `SHARE_LIMITS` (`src/server/services/share-links.ts`). |
| Email sending account (Resend) and sender domain DNS | ops | `getEmailProvider()` is `null` without `RESEND_API_KEY` + `EMAIL_FROM`; the email form is hidden. |
| Phase 1 exit measurements: 60-second repeat-and-share, 30-second registration (5 real users), Safari print parity, 5 clinics × 10 days | founder with design partners | Automated evidence only (Task 12's table); the boxes stay unticked until a human measures. |

## Global Constraints

Copied from Plans 1A–1C (still binding):

- Node.js 22+; npm only (commit `package-lock.json` only if it changes; this plan adds no dependency).
- TypeScript strict; no `any`; no `@ts-ignore`.
- Every business table has `tenant_id UUID NOT NULL`; RLS is enabled **and forced** on all of them (new tables included).
- `tenant_id`, `user_id`, and `role` come from the session (`requireSession()` / `getSessionContext()`), never from request input or form fields.
- Feature code reaches tenant data only through `withTenant()`. `adminDb` is for auth, sign-up, seed, scripts, and tests. **New in 1D:** the one session-less query path is `withShareToken()` (decision 7).
- Finalized prescriptions are never overwritten; amendments create a new version with a reason (AGENTS.md invariant 3).
- Creating, amending, finalizing, archiving, restoring, printing, downloading, **sharing, opening a shared link, revoking a link, recording or withdrawing consent, and importing** write an append-only audit event (invariant 2). Audit payloads carry ids, counts, codes, and field **names** — never names, phone numbers, email addresses, tokens, URLs, or clinical text.
- Dates: store UTC; calendar dates are `YYYY-MM-DD` strings; render in the clinic timezone (default `Asia/Kolkata`; an unknown zone falls back to `Asia/Kolkata`, never UTC).
- IDs are UUIDv7 (`newId()` / schema `$defaultFn`); human-facing numbers are per-tenant sequences.
- Every service returns `Result<T>`; no thrown strings.
- Use existing shadcn/ui primitives (`src/components/ui/*`) and native form elements; no new UI kit.
- All user free text is validated through `cleanInput` / `cleanOptionalText(max)` / `cleanRequiredText(max, message)` and `hasNoNul` + `NUL_MESSAGE` (`src/server/validation/text.ts`): a NUL is refused with a field error, never stripped. `cleanText` alone is for search terms and keys.
- Migrations never run data backfill `UPDATE`s on `visits`, `prescriptions`, or `prescription_items`.
- **Lock order (ADR-0023):** lock the prescription row `FOR UPDATE` before touching its items or its visit; finalizing an amendment locks the child, then flips the parent. Nothing in this plan locks a prescription row.
- Client components fetch data through GET route handlers or receive it from server components; server actions are for mutations (Next runs server actions one at a time). Route handlers catch unexpected errors and answer a typed 500 with `Cache-Control: private, no-store`, logging the error class only (`error instanceof Error ? error.name : typeof error`).
- Keep components under ~250 lines; domain logic lives in `src/lib/` or `src/server/`, not in components.
- Conventional commits; one logical change per commit; `git add` names explicit file paths (never a bare directory or `-A`).
- **Windows:** run every vitest and Playwright command from PowerShell with the working directory `E:\projects\clinicpad` (UPPERCASE drive letter); start **every** command with `Set-Location E:\projects\clinicpad;`. PowerShell 5.1 has no `&&`; chain with `; if ($?) { ... }`.
- Before every commit run `Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }` and keep the output.
- **Playwright:** `getByRole("alert")` also matches Next's route announcer; labels overlap, so use `{ exact: true }` and scoping; wait for the clinical editor with `waitForEditor(page)` before typing into it. A link named "Patients" is clicked in existing specs, so **no new link on the Patients page or dashboard may contain the word "patients"** (use "Show archived", "Import from CSV", "Register your first patient").
- Reviewers skip `drizzle/meta/*_snapshot.json` (generated).
- **Commit command:** `git commit -m "<subject>" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"`, where `<model>` is the model that actually wrote the commit (for example `Sonnet 5.5`).
- **Invisible or non-printing characters in tests** are written as `\uXXXX` escapes (or byte arrays), never pasted, and each such test asserts the code point it relies on. After writing such a file, check it with `Select-String -Path <file> -Pattern '[\u0000-\u0008\u200B-\u200F\u202A-\u202E\u2028\u2029\uFEFF]'` (no output expected).
- **Tests never require Gotenberg** (fake engine `tests/helpers/fake-pdf-engine.ts`); e2e steps that need a real PDF check Gotenberg's `/health` first and take the "service down" branch cleanly.
- Test files that use `Request`, `Response`, `FormData`, `File`, `Blob` bytes, or `fetch` against Node APIs start with `// @vitest-environment node`.

New in Plan 1D:

- **No new npm dependencies.** CSV parsing stays in `src/lib/csv.ts`; email goes through `fetch`.
- **No real network calls in tests.** Providers take an injected `fetch`; tests never set `RESEND_API_KEY`; `getEmailProvider()` is only called when a test passes nothing, and then returns `null`.
- **No PHI in share URLs** (the URL holds only the token), in WhatsApp or email text (no patient name, no clinical text), on the interstitial page, in logs, in audit payloads, or in file names. Recipients are stored masked only.
- **The public route** (`src/app/s/[token]/route.ts`) never uses `adminDb`, answers the uniform 404 for every unusable link, and sends `Cache-Control: no-store, private, max-age=0`, `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff` on every response.
- **Lock rule for share links (decision 13):** lock the patient row before writing that patient's links.
- **Migrations 0017 to 0022 are created in task order (Tasks 1, 2, 6, 8). Tasks that create migrations never run in parallel with each other.** Each migration is followed by `npx drizzle-kit generate`, which must answer "No schema changes".
- **Every CHECK constraint is declared in the Drizzle schema too** (guard test from Task 2); RLS policies, grants and triggers live in custom SQL migrations (guard test from Task 1).
- **Every new tenant table:** forced RLS, composite same-tenant keys with explicit names under 63 characters, append-only for the runtime role unless the task says otherwise, admin-level immutability through `public.enforce_print_rows_immutable()` or a table-specific trigger.

## Review Focus

The five input classes most likely to break this software for a real clinic that no happy-path test would catch. Each is pinned to a test in the owning task.

1. **Phone numbers in every format staff type or paste:** `+91 98765 43210`, `098765-43210`, `0091 98765 43210`, `+0091 98765 43210`, `tel:+91…`, `91 98765 43210`, a leading U+200E or U+202A, a landline `080 2345 6789`, `+1 415 555 0100`, `+971 50 123 4567`, a bare foreign number without `+`, letters, Excel's `9.87654E+09` and `9876543210.0`. Expected: `wa.me` gets exactly the right international digits, or a clear refusal that says what to type; a wrong number is never produced; an import cell is repaired or refused the same way. → Task 5 (`phone.test.ts`, `patient-import-rows.test.ts`), Task 10 (`recipient.test.ts`).
2. **A WhatsApp link opened on desktop, previewed by a bot, or scanned by a mail filter:** the generated link is the universal `https://wa.me/…` form (not `whatsapp://`), opened from a real anchor click in a new tab; WhatsApp's link-preview fetcher, a Slack unfurl, or a Safe Links scanner GETs the share URL and gets the interstitial only — no open is counted, no PDF is rendered, no patient data is shown; a cross-site POST gets the uniform 404. → Task 9 (`share-route.test.ts`), Task 10 (`share-panel.test.tsx`, `wa-link.test.ts`, `sharing.spec.ts`).
3. **Expired, revoked, used-up, switched-off, superseded, and malformed links:** identical 404s (status, body, headers) for every unusable state, no counter change and no audit for them; a superseded version opens with the SUPERSEDED marker; withdrawing consent or archiving the patient kills the links at once; a PDF engine failure answers 503 and does not burn an open. → Task 8 (`consent.test.ts`), Task 9 (`share-links.test.ts`, `share-route.test.ts`).
4. **CSV files as Excel and phones actually produce them:** UTF-8 with BOM, UTF-16 "Unicode Text" with tabs, Windows-1252 "CSV" (refused, with what to do), a `.xlsx` renamed to `.csv`, `;` delimiters, `15/08/1990` and Excel serial dates, `08/15/1990` (refused, not swapped), scientific-notation phones, leading apostrophes, quoted newlines, blank trailing rows, formula cells (`=HYPERLINK(…)`) echoed into the problem-row CSV, a file over 1 MB, more than 5,000 rows, a NUL byte. → Task 5 (`csv.test.ts`, `csv-decode.test.ts`, `patient-import-rows.test.ts`), Task 6 (`patient-import.test.ts`), Task 7 (`import-wizard.test.tsx`, `patient-import.spec.ts`).
5. **Duplicate patients that share a phone:** a family on one mobile, the same row twice in the file, a re-run of yesterday's file, a double-click on Import, two tabs importing at once, a patient registered by reception between the dry-run and the commit. Expected: never silently merged, never duplicated by a re-run, `fill` offered only when phone **and** name match exactly one patient, patient numbers consecutive with no gaps. → Task 6 (`patient-import.test.ts`).

Also pinned, because they are listed follow-ups rather than open questions: clinic timezone differences — a newborn registered at 00:30 IST, a clinic in `America/New_York`, history date filters at day boundaries (Task 3 `patients-dates.test.ts`, `clinic-date.test.ts`; Task 4 `patient-history.test.ts`).

---

## File Structure

**Create**
- `drizzle/0017_phase1d_integrity.sql` (custom) — insert guards, the superseding precondition, status CHECKs, counter grants. (Task 1)
- `drizzle/0018_phase1d_schema_checks.sql` (generated, hand-edited) — value CHECKs, FK-column indexes, `tenant_medicines_created_by_fk`. (Task 2)
- `drizzle/0019_phase1d_patient_import.sql` (generated) and `drizzle/0020_phase1d_patient_import_security.sql` (custom). (Task 6)
- `drizzle/0021_phase1d_sharing.sql` (generated) and `drizzle/0022_phase1d_sharing_security.sql` (custom). (Task 8)
- Each with its `drizzle/meta/00NN_snapshot.json` and `_journal.json` entry (generated).
- `src/lib/domain/clinic-date.ts` — `clinicLocalDate`, `latestCalendarDate`. (Task 3)
- `src/server/services/clinic.ts` — `clinicTimeZoneIn`, `getClinicTimeZone`, `getClinicSharing`, `setClinicSharing`. (Tasks 3, 8)
- `src/server/services/patient-history.ts` — `historyFiltersSchema`, `listPatientPrescriptions`. (Task 4)
- `src/components/patients/prescription-history.tsx`, `src/components/patients/history-filters.tsx`. (Task 4)
- `src/server/db/sweep-rules.ts`, `src/server/db/sweep-test-tenants.ts`. (Task 2)
- `src/lib/import/decode.ts`, `src/lib/import/patient-columns.ts`, `src/lib/import/patient-rows.ts`, `sample_data/patients_template.csv` (generated from `PATIENT_TEMPLATE_ROWS`). (Task 5)
- `src/server/db/schema/imports.ts` — `patientImports`. (Task 6)
- `src/server/services/patient-import.ts`, `src/server/actions/patient-import.ts`. (Task 6)
- `src/app/(app)/patients/import/page.tsx`, `src/components/patients/import-wizard.tsx`, `src/components/patients/import-mapping.tsx`, `src/components/patients/import-report.tsx`. (Task 7)
- `src/server/db/schema/sharing.ts` — `patientConsents`, `shareLinks`, `prescriptionShares`. (Task 8)
- `src/lib/domain/consent.ts`, `src/server/services/consent.ts`, `src/server/services/share-revocation.ts`, `src/server/actions/consent.ts`, `src/components/patients/consent-card.tsx`, `src/components/settings/sharing-form.tsx`. (Task 8)
- `src/server/sharing/token.ts`, `src/server/sharing/config.ts`, `src/server/db/share-token.ts`, `src/server/services/share-links.ts`, `src/server/http/rate-limit.ts`, `src/server/http/share-pages.ts`, `src/server/http/share-route.ts`, `src/app/s/[token]/route.ts`. (Task 9)
- `src/lib/domain/recipient.ts`, `src/server/messaging/whatsapp.ts`, `src/server/messaging/email.ts`, `src/server/services/sharing.ts`, `src/server/actions/sharing.ts`, `src/components/rx/share-panel.tsx`, `src/components/rx/share-links-list.tsx`. (Task 10)
- `src/app/(app)/not-found.tsx`. (Task 11)
- Tests: `tests/integration/{integrity-1d,rls-guard}.test.ts` (1); `tests/integration/schema-checks.test.ts`, `tests/unit/sweep-rules.test.ts`, `tests/integration/sweep-test-tenants.test.ts` (2); `tests/unit/clinic-date.test.ts`, `tests/integration/patients-dates.test.ts` (3); `tests/integration/{patient-history,patient-archive}.test.ts`, `tests/unit/prescription-history.test.tsx`, `tests/e2e/patient-history.spec.ts` (4); `tests/unit/{csv-decode,patient-import-rows}.test.ts` (5); `tests/integration/patient-import.test.ts`, `tests/helpers/csv-files.ts` (6); `tests/unit/import-wizard.test.tsx`, `tests/e2e/patient-import.spec.ts` (7); `tests/integration/{sharing-schema,consent}.test.ts`, `tests/unit/consent-card.test.tsx` (8); `tests/unit/{share-token,rate-limit}.test.ts`, `tests/integration/{share-links,share-route}.test.ts`, `tests/helpers/share.ts` (9); `tests/unit/{recipient,wa-link,email-provider,share-panel}.test.ts(x)`, `tests/integration/sharing.test.ts`, `tests/helpers/fake-email.ts`, `tests/e2e/sharing.spec.ts` (10); `tests/unit/rx-option-labels.test.ts`, `tests/e2e/keyboard.spec.ts` (11).

**Modify**
- `src/server/db/seed.ts` — visits are inserted as drafts and flipped (Task 1).
- `src/server/db/schema/{clinical,tenancy,catalogue}.ts` — CHECKs declared, indexes, `tenant_medicines_created_by_fk` (2); `patients.importId`/`importRowKey` (6); `clinics.sharingEnabled`, `prescriptionOutputs.shareLinkId` + kind check (8). `src/server/db/schema/index.ts` exports the new schema files (6, 8).
- `src/server/services/numbering.ts` — `allocateNumbers` (6).
- `src/server/services/patients.ts` — clinic-day DOB check (3), `getPatient` `includeArchived`, `searchPatients` `archived`, `unarchivePatient`, exported `toPatientColumns` (4, 6), archive revokes links (9).
- `src/server/validation/patient.ts` — UTC+14 structural bound, `DOB_FUTURE_MESSAGE` (3).
- `src/server/services/render-snapshot.ts` — re-exports `clinicLocalDate` from the new module (3).
- `src/server/services/rx-documents.ts` — `loadRxDocumentIn` extracted (9).
- `src/server/services/rx-output.ts` — `renderDocument` exported, abort-aware PDF path, output counter excludes shared opens (9).
- `src/server/services/audit.ts` — `recordAuditMany`, `recordSystemAudit` (6, 9).
- `src/server/pdf/{limiter,engine,gotenberg}.ts`, `src/app/(app)/prescriptions/[id]/pdf/route.ts` — abort plumbing (9).
- `src/lib/csv.ts` — delimiter option, line numbers, `detectDelimiter`, `csvCell`, `serializeCsv` (5). `src/lib/domain/phone.ts` — `tel:` and `+00` prefixes (5).
- `src/lib/domain/permissions.ts` + `tests/unit/permissions.test.ts` — `patient.import` (6), `consent.capture`, `rx.share` (8).
- `src/server/actions/patients.ts` — archive and restore actions (4).
- `src/app/(app)/patients/page.tsx`, `src/app/(app)/patients/[id]/page.tsx`, `src/app/(app)/patients/new/page.tsx`, `src/components/patients/patient-form.tsx` — clinic-day ages and `max` date (3), history, archive, restore, show-archived (4), import link (7), consent card (8), name autofocus (11).
- `src/app/(app)/settings/page.tsx` — sharing switch (8).
- `src/app/(app)/prescriptions/[id]/page.tsx` + `tests/unit/prescription-page.test.tsx` — share panel (10).
- `src/app/(app)/layout.tsx` (skip link), `src/app/(app)/dashboard/page.tsx` (empty state, safe zone), `src/lib/domain/rx-options.ts`, `src/lib/rx-render/labels.ts` (Hindi labels single source) (11).
- `tests/integration/{immutability,print-schema}.test.ts` (1); `tests/integration/tenant-fk.test.ts`, `tests/helpers/tenant.ts`, `tests/e2e/helpers.ts`, `tests/e2e/patients.spec.ts` (2); `tests/unit/{phone,csv}.test.ts` (5); `tests/unit/rx-output-http.test.ts`, `tests/unit/gotenberg.test.ts`, `tests/helpers/fake-pdf-engine.ts` (9).
- `scripts/build-desktop.mjs` — `src/app/s` stashed (9).
- `package.json` — `db:sweep-test-tenants` (2).
- `.env.example`, `docs/DECISIONS.md`, `docs/PROGRESS.md`, `docs/SETUP.md`, `AGENTS.md` (12).

## Task order and parallelism

`T1 → T2 → (T3 ∥ T5) → T4 → T6 → T7 → T8 → T9 → (T10 ∥ T11) → T12`

- Tasks 1, 2, 6 and 8 create migrations (0017; 0018; 0019–0020; 0021–0022) and must run **in that order, never in parallel with each other**.
- T3 and T5 touch disjoint files (`clinic-date`, patient validation/services/pages vs `src/lib/csv.ts`, `src/lib/import/*`, `src/lib/domain/phone.ts`).
- T10 and T11 touch disjoint files (prescription page, sharing services, share panel vs labels, options, layout, dashboard, not-found, patient form).
- Parallel implementers commit with explicit paths only.

---

## Task 1: Database integrity — rows born as drafts, superseding needs a successor, status vocabularies, counter grants, and a schema-wide RLS guard

**Files:**
- Create: `drizzle/0017_phase1d_integrity.sql` (custom, via drizzle-kit), `drizzle/meta/0017_snapshot.json` and the `_journal.json` entry (generated)
- Create: `tests/integration/integrity-1d.test.ts`, `tests/integration/rls-guard.test.ts`
- Modify: `src/server/db/seed.ts` (the visits insert and the finalize step, lines ~131–196)
- Modify: `tests/integration/immutability.test.ts` (the test "allows only the finalized -> amended status flip and nothing else"), `tests/integration/print-schema.test.ts` (a `supersede` helper; the tests "is frozen with the rest of a finalized prescription, and the amended flip still works" and "accepts amended (superseded) prescriptions but refuses any other status")

**Interfaces:**
- Consumes: `public.enforce_rx_immutability()` (0005 body, printed below with the one change), `public.tenant_is_erased(uuid)` (0005/0006), the 0008 visit guard, `allocateNumber` (`src/server/services/numbering.ts`), `seedDemo()` (`src/server/db/seed.ts`), `pgErrorInfo` (`src/server/db/errors.ts`).
- Produces (database):
  - `public.enforce_insert_as_draft()` and triggers `prescriptions_insert_draft`, `visits_insert_draft` (BEFORE INSERT): a row whose `status` is not `'draft'` is refused with SQLSTATE `23000` on every connection.
  - `public.enforce_rx_immutability()` now refuses the `finalized -> amended` flip with `23000` unless a prescription with `parent_prescription_id = old.id`, the same `tenant_id`, and `status = 'finalized'` exists.
  - `prescriptions_status_check` (`status in ('draft','finalized','amended')`) and `visits_status_check` (`status in ('draft','finalized')`), SQLSTATE `23514`; validated when every existing row passes.
  - `clinicpad_app` has no `DELETE` or `TRUNCATE` on `tenant_counters`.
  - `tests/integration/rls-guard.test.ts` exports nothing; it holds `NON_TENANT_POLICIES: Record<string, string>` (empty here; Task 8 adds exactly one entry).

- [ ] **Step 1: Write the failing integrity test**

`tests/integration/integrity-1d.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { patients, prescriptionItems, prescriptions, tenantCounters, tenants, visits } from "@/server/db/schema";
import { allocateNumber } from "@/server/services/numbering";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let T = "";
let nextRxNo = 700;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

/** A patient, a draft visit, a draft prescription and one item. */
async function draftRecords(rxNo: number | null = null) {
  const [patient] = await adminDb.insert(patients).values({ tenantId: T, name: "Integrity Patient" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId: T, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId: T, visitId: visit.id, rxNo, status: "draft" }).returning();
  await adminDb.insert(prescriptionItems).values({ tenantId: T, prescriptionId: rx.id, drugName: "Paracetamol" });
  return { patient, visit, rx };
}

/** Freeze the way the services do: the prescription first, then its visit. */
async function finalize(rxId: string, visitId: string) {
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rxId));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));
}

/** A finalized version 1 and an amendment draft (version 2) that points at it. */
async function versionOneWithAmendmentDraft() {
  nextRxNo += 1;
  const v1 = await draftRecords(nextRxNo);
  await finalize(v1.rx.id, v1.visit.id);
  const [childVisit] = await adminDb.insert(visits).values({ tenantId: T, patientId: v1.patient.id, status: "draft" }).returning();
  const [child] = await adminDb
    .insert(prescriptions)
    .values({ tenantId: T, visitId: childVisit.id, rxNo: nextRxNo, version: 2, status: "draft", parentPrescriptionId: v1.rx.id, amendmentReason: "Dose correction" })
    .returning();
  return { parent: v1.rx, child, childVisit };
}

beforeAll(async () => {
  const [t] = await adminDb.insert(tenants).values({ name: "Integrity 1D", slug: `integrity-${stamp}` }).returning();
  T = t.id;
});

afterAll(async () => {
  // Offboarding still erases frozen records with the new triggers in place.
  await adminDb.delete(tenants).where(eq(tenants.id, T));
  expect(await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, T))).toHaveLength(0);
});

describe("tenant_counters", () => {
  it("lets the application role create and increment a counter", async () => {
    const first = await withTenant(T, (tx) => allocateNumber(tx, T, "patient"));
    const second = await withTenant(T, (tx) => allocateNumber(tx, T, "patient"));
    expect(second).toBe(first + 1);
  });

  it("refuses DELETE and TRUNCATE for the application role (42501)", async () => {
    await expectCode(withTenant(T, (tx) => tx.delete(tenantCounters)), "42501");
    await expectCode(withTenant(T, (tx) => tx.execute(sql`truncate tenant_counters`)), "42501");
    const [row] = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, T));
    expect(row.lastNo).toBeGreaterThan(0);
  });
});

describe("rows are born as drafts", () => {
  it.each(["finalized", "amended"])("refuses a prescription inserted as %s, on every connection (23000)", async (status) => {
    const { visit } = await draftRecords();
    await expectCode(adminDb.insert(prescriptions).values({ tenantId: T, visitId: visit.id, status }), "23000");
    await expectCode(withTenant(T, (tx) => tx.insert(prescriptions).values({ tenantId: T, visitId: visit.id, status })), "23000");
  });

  it("refuses a visit inserted as finalized (23000)", async () => {
    const { patient } = await draftRecords();
    await expectCode(adminDb.insert(visits).values({ tenantId: T, patientId: patient.id, status: "finalized" }), "23000");
    await expectCode(withTenant(T, (tx) => tx.insert(visits).values({ tenantId: T, patientId: patient.id, status: "finalized" })), "23000");
  });

  it("still accepts drafts, including an amendment draft that carries its parent's number", async () => {
    const { child } = await versionOneWithAmendmentDraft();
    expect(child.status).toBe("draft");
    expect(child.rxNo).toBe(nextRxNo);
  });
});

describe("status vocabularies", () => {
  it("refuses an unknown prescription or visit status (23514)", async () => {
    const { rx, visit } = await draftRecords();
    await expectCode(adminDb.update(prescriptions).set({ status: "void" }).where(eq(prescriptions.id, rx.id)), "23514");
    await expectCode(adminDb.update(visits).set({ status: "closed" }).where(eq(visits.id, visit.id)), "23514");
  });

  it("installs both constraints under their names", async () => {
    const rows = await adminDb.execute<{ conname: string }>(sql`
      select conname::text as conname from pg_constraint
       where connamespace = 'public'::regnamespace and conname in ('prescriptions_status_check', 'visits_status_check')
       order by 1`);
    expect(rows.map((r) => r.conname)).toEqual(["prescriptions_status_check", "visits_status_check"]);
  });
});

describe("a version is superseded only by a finalized successor", () => {
  it("refuses the finalized -> amended flip when no amendment exists (23000)", async () => {
    nextRxNo += 1;
    const { rx, visit } = await draftRecords(nextRxNo);
    await finalize(rx.id, visit.id);
    await expectCode(adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, rx.id)), "23000");
  });

  it("refuses it while the amendment is still a draft (23000)", async () => {
    const { parent } = await versionOneWithAmendmentDraft();
    await expectCode(adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, parent.id)), "23000");
    await expectCode(withTenant(T, (tx) => tx.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, parent.id))), "23000");
  });

  it("allows it once the amendment is finalized, in the same order finalizePrescription uses", async () => {
    const { parent, child, childVisit } = await versionOneWithAmendmentDraft();
    await finalize(child.id, childVisit.id);
    await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, parent.id));
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, parent.id));
    expect(row.status).toBe("amended");
  });

  it("does not count another prescription's finalized amendment", async () => {
    const other = await versionOneWithAmendmentDraft();
    await finalize(other.child.id, other.childVisit.id);
    nextRxNo += 1;
    const lonely = await draftRecords(nextRxNo);
    await finalize(lonely.rx.id, lonely.visit.id);
    await expectCode(adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, lonely.rx.id)), "23000");
  });
});
```

- [ ] **Step 2: Write the schema-wide RLS guard test**

`tests/integration/rls-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";

/**
 * Policies on tenant tables that are NOT scoped by app.tenant_id, as "table.policy" -> reason. Keep this list
 * short and justified: every other policy on a table with a tenant_id must compare it with the session tenant.
 */
const NON_TENANT_POLICIES: Record<string, string> = {};

type TableRow = { table_name: string; rls: boolean; forced: boolean };
type PolicyRow = { table_name: string; policy: string; cmd: string; qual: string | null; with_check: string | null };

async function tenantTables(): Promise<TableRow[]> {
  return adminDb.execute<TableRow>(sql`
    select c.relname::text as table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
     order by 1`);
}

async function policies(): Promise<PolicyRow[]> {
  return adminDb.execute<PolicyRow>(sql`
    select tablename::text as table_name, policyname::text as policy, cmd::text as cmd, qual, with_check
      from pg_policies where schemaname = 'public' order by 1, 2`);
}

const scoped = (p: PolicyRow) => `${p.qual ?? ""} ${p.with_check ?? ""}`.includes("app.tenant_id");

describe("row-level security across the whole schema", () => {
  it("sees the known tenant tables, so it cannot pass vacuously", async () => {
    const names = (await tenantTables()).map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "audit_events",
        "clinic_assets",
        "medicine_favourites",
        "patients",
        "prescription_items",
        "prescription_outputs",
        "prescriptions",
        "tenant_counters",
        "tenant_medicines",
        "visits",
      ]),
    );
  });

  it("enables and forces RLS on every table that has a tenant_id", async () => {
    const weak = (await tenantTables()).filter((r) => !r.rls || !r.forced).map((r) => r.table_name);
    expect(weak).toEqual([]);
  });

  it("gives every tenant table a policy and scopes every policy by app.tenant_id", async () => {
    const tables = (await tenantTables()).map((r) => r.table_name);
    const rows = await policies();
    expect(tables.filter((t) => !rows.some((p) => p.table_name === t))).toEqual([]);
    const unscoped = rows
      .filter((p) => tables.includes(p.table_name) && !scoped(p))
      .map((p) => `${p.table_name}.${p.policy}`)
      .filter((key) => !Object.hasOwn(NON_TENANT_POLICIES, key));
    expect(unscoped).toEqual([]);
  });

  it("keeps every allow-listed exception real (no stale entries)", async () => {
    const keys = (await policies()).map((p) => `${p.table_name}.${p.policy}`);
    expect(Object.keys(NON_TENANT_POLICIES).filter((key) => !keys.includes(key))).toEqual([]);
  });

  it("keeps tenants itself forced and scoped to the session's tenant", async () => {
    const [table] = await adminDb.execute<TableRow>(sql`
      select relname::text as table_name, relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class where oid = 'public.tenants'::regclass`);
    expect(table).toMatchObject({ rls: true, forced: true });
    const rows = (await policies()).filter((p) => p.table_name === "tenants");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(scoped)).toBe(true);
  });

  it("never grants the application role TRUNCATE on any table, or anything on users", async () => {
    const [row] = await adminDb.execute<{ truncatable: string[] | null; users_select: boolean }>(sql`
      select (select array_agg(c.relname::text order by c.relname) from pg_class c
               where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                 and has_table_privilege('clinicpad_app', c.oid, 'TRUNCATE')) as truncatable,
             has_table_privilege('clinicpad_app', 'public.users', 'SELECT') as users_select`);
    expect(row.truncatable).toBeNull();
    expect(row.users_select).toBe(false);
  });

  it("keeps the global catalogue read-only for the application role", async () => {
    for (const table of ["global_medicines", "global_clinical_terms"]) {
      const [row] = await adminDb.execute<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; forced: boolean }>(sql`
        select has_table_privilege('clinicpad_app', ${`public.${table}`}, 'SELECT') as sel,
               has_table_privilege('clinicpad_app', ${`public.${table}`}, 'INSERT') as ins,
               has_table_privilege('clinicpad_app', ${`public.${table}`}, 'UPDATE') as upd,
               has_table_privilege('clinicpad_app', ${`public.${table}`}, 'DELETE') as del,
               (select relforcerowsecurity from pg_class where oid = ${`public.${table}`}::regclass) as forced`);
      expect(row, table).toEqual({ sel: true, ins: false, upd: false, del: false, forced: true });
    }
  });
});
```

- [ ] **Step 3: Run both tests to see the integrity test fail**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/integrity-1d.test.ts tests/integration/rls-guard.test.ts
```

Expected: `rls-guard.test.ts` passes already (7 tests — it pins today's schema; if it fails, stop and report the table or policy it names: that is a real gap, not a test bug). `integrity-1d.test.ts` fails: the DELETE on `tenant_counters` succeeds, both "born as drafts" inserts succeed, `"void"` and `"closed"` are accepted, the constraint list is empty, and the flips without a finalized successor succeed (9 of 12 tests fail; "lets the application role create and increment", "still accepts drafts" and "allows it once the amendment is finalized" pass).

- [ ] **Step 4: Create the custom migration**

```powershell
Set-Location E:\projects\clinicpad; npx drizzle-kit generate --custom --name=phase1d_integrity
```

Expected: `drizzle/0017_phase1d_integrity.sql` (empty), `drizzle/meta/0017_snapshot.json` (a copy of 0016's), and a journal entry `0017_phase1d_integrity`. Replace the file's content with:

```sql
-- Plan 1D database integrity (custom migration). Forward-only: 0004-0016 are applied and tracked.

-- 1. tenant_counters: the runtime role reads, creates and increments counters (ADR-0022); it never deletes them.
revoke delete, truncate on tenant_counters from clinicpad_app;
--> statement-breakpoint

-- 2. Rows are born as drafts. An INSERT of an already-finalized row was a documented gap of ADR-0023: it would
--    create a frozen record that never passed finalize (no number check, no snapshot, no audit). Every writer,
--    the admin connection and the demo seed included, now inserts drafts and finalizes them by UPDATE.
create or replace function public.enforce_insert_as_draft() returns trigger language plpgsql as $$
begin
  if new.status is distinct from 'draft' then
    raise exception 'IMMUTABLE: % rows must be inserted as drafts', tg_table_name using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger prescriptions_insert_draft before insert on prescriptions
  for each row execute function public.enforce_insert_as_draft();
--> statement-breakpoint
create trigger visits_insert_draft before insert on visits
  for each row execute function public.enforce_insert_as_draft();
--> statement-breakpoint

-- 3. A version is superseded only by a finalized successor of the same tenant (the other gap ADR-0023 listed).
--    finalizePrescription updates the child to 'finalized' before it flips the parent, in one transaction, so the
--    check sees the child. Under RLS the lookup runs as the caller and sees only the caller's tenant. Everything
--    else is the 0005 body unchanged.
create or replace function public.enforce_rx_immutability() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      if not public.tenant_is_erased(old.tenant_id) then
        raise exception 'IMMUTABLE: finalized prescriptions cannot be deleted' using errcode = '23000';
      end if;
    end if;
    return old;
  end if;
  if old.status = 'draft' then return new; end if;
  if old.status = 'finalized' and new.status = 'amended'
     and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at') then
    if exists (select 1 from public.prescriptions c
                where c.parent_prescription_id = old.id and c.tenant_id = old.tenant_id and c.status = 'finalized') then
      return new;
    end if;
    raise exception 'IMMUTABLE: a prescription is superseded only by a finalized amendment' using errcode = '23000';
  end if;
  raise exception 'IMMUTABLE: finalized prescriptions cannot be changed' using errcode = '23000';
end $$;
--> statement-breakpoint

-- 4. Closed status vocabularies. NOT VALID first so a development database with leftover test rows still migrates;
--    each constraint is validated at once when every existing row passes (always true for rows the services wrote).
--    A constraint left NOT VALID still refuses every new or changed row. `npm run db:sweep-test-tenants` (Plan 1D
--    Task 2) removes leftover test tenants; the next migration that validates will then succeed.
alter table prescriptions add constraint prescriptions_status_check
  check (status in ('draft', 'finalized', 'amended')) not valid;
--> statement-breakpoint
alter table visits add constraint visits_status_check
  check (status in ('draft', 'finalized')) not valid;
--> statement-breakpoint
do $$
declare
  c record;
begin
  for c in
    select conrelid::regclass::text as tbl, conname::text as name
      from pg_constraint
     where connamespace = 'public'::regnamespace and contype = 'c' and not convalidated
       and conname in ('prescriptions_status_check', 'visits_status_check')
  loop
    begin
      execute format('alter table %s validate constraint %I', c.tbl, c.name);
    exception when check_violation then
      raise notice '% stays NOT VALID: existing rows break it (development data; run npm run db:sweep-test-tenants)', c.name;
    end;
  end loop;
end $$;
```

- [ ] **Step 5: Insert the demo seed's visits as drafts**

In `src/server/db/seed.ts`, the visits insert sets `status: "finalized"` and `finalizedAt: now`. Replace that object (inside `Array.from({ length: PRESCRIPTION_COUNT }, (_, i) => ({ ... }))`) so it reads:

```ts
        Array.from({ length: PRESCRIPTION_COUNT }, (_, i) => ({
          tenantId,
          patientId: patientRows[i].id,
          doctorId: primaryDoctorId,
          branchId: mainBranch.id,
          // Born as a draft (0017's insert guard); finalized below the way the services do it.
          status: "draft",
          visitType: i % 3 === 0 ? "follow-up" : "new",
          chiefComplaint: "Fever and body ache",
          diagnosis: ["Viral fever"],
          advice: "Rest, fluids, review if fever persists beyond 3 days.",
        })),
```

and directly after the existing prescription flip

```ts
    // Items go in while draft; the immutability trigger forbids adding them afterwards.
    await tx
      .update(prescriptions)
      .set({ status: "finalized", finalizedAt: now, finalizedBy: ownerId })
      .where(eq(prescriptions.tenantId, tenantId));
```

add:

```ts
    // Then the visits: once a prescription is finalized, a draft visit accepts only this plain flip (0008).
    await tx.update(visits).set({ status: "finalized", finalizedAt: now }).where(eq(visits.tenantId, tenantId));
```

(`visits` is already imported in `seed.ts`; `now` is the existing `const now = new Date();`.)

- [ ] **Step 6: Update the three existing tests that flip without a successor or use an unknown status**

In `tests/integration/immutability.test.ts`, replace the test `"allows only the finalized -> amended status flip and nothing else"` with:

```ts
  it("allows only the finalized -> amended status flip, once a finalized amendment exists, and nothing else", async () => {
    const { rx, visit, patient } = await draftRx(102);
    await finalize(rx.id, visit.id);

    await expectCode(
      adminDb.update(prescriptions).set({ status: "amended", rxNo: 555 }).where(eq(prescriptions.id, rx.id)),
      "23000",
    );
    // No finalized successor yet: superseding is refused (0017).
    await expectCode(adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, rx.id)), "23000");

    const [childVisit] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
    const [child] = await adminDb
      .insert(prescriptions)
      .values({ tenantId, visitId: childVisit.id, rxNo: 102, version: 2, status: "draft", parentPrescriptionId: rx.id, amendmentReason: "Dose correction" })
      .returning();
    await finalize(child.id, childVisit.id);

    await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, rx.id));
    const [flipped] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(flipped.status).toBe("amended");

    // Once amended it is still frozen.
    await expectCode(adminDb.update(prescriptions).set({ status: "draft" }).where(eq(prescriptions.id, rx.id)), "23000");
  });
```

(`draftRx`, `finalize`, `expectCode`, `tenantId`, `visits`, `prescriptions` already exist in that file; `draftRx` returns `{ patient, visit, rx, item }`.)

In `tests/integration/print-schema.test.ts`, add this helper below `prescriptionIn`:

```ts
/** Supersedes a finalized prescription the way finalizing an amendment does: a finalized version 2 first, then the flip (0017). */
async function supersede(tenantId: string, parentId: string): Promise<void> {
  const [parent] = await adminDb
    .select({ rxNo: prescriptions.rxNo, visitId: prescriptions.visitId })
    .from(prescriptions)
    .where(eq(prescriptions.id, parentId));
  const [parentVisit] = await adminDb.select({ patientId: visits.patientId }).from(visits).where(eq(visits.id, parent.visitId));
  const [visit] = await adminDb.insert(visits).values({ tenantId, patientId: parentVisit.patientId, status: "draft" }).returning();
  const [child] = await adminDb
    .insert(prescriptions)
    .values({ tenantId, visitId: visit.id, rxNo: parent.rxNo, version: 2, status: "draft", parentPrescriptionId: parentId, amendmentReason: "Schema test" })
    .returning();
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, child.id));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visit.id));
  await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, parentId));
}
```

then, in `"is frozen with the rest of a finalized prescription, and the amended flip still works"`, replace `await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, id));` with `await supersede(A, id);`; in `"accepts amended (superseded) prescriptions but refuses any other status"`, replace `await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, amended));` with `await supersede(A, amended);` and replace the last three lines (the `odd` draft moved to `"void"` and the output insert) with:

```ts
    // status is a closed vocabulary since 0017, so an unknown status never reaches the outputs trigger; its
    // allow-list (0015) stays as defence in depth.
    const odd = await prescriptionIn(A, "draft");
    await expectCode(adminDb.update(prescriptions).set({ status: "void" }).where(eq(prescriptions.id, odd)), "23514");
```

- [ ] **Step 7: Apply the migration and run the focused tests**

```powershell
Set-Location E:\projects\clinicpad; npm run db:migrate
Set-Location E:\projects\clinicpad; npx drizzle-kit generate
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/integrity-1d.test.ts tests/integration/rls-guard.test.ts tests/integration/immutability.test.ts tests/integration/print-schema.test.ts tests/integration/seed.test.ts tests/integration/prescriptions-lifecycle.test.ts tests/integration/immutability-races.test.ts
```

Expected: the migration applies (it may print a `NOTICE ... stays NOT VALID` on a development database with leftover test rows: that is fine and is resolved after Task 2's sweep); `drizzle-kit generate` answers **"No schema changes, nothing to migrate"**; all listed files pass (integrity-1d 12, rls-guard 7, the rest with their previous counts; `seed.test.ts` proves the seed still builds 20 finalized prescriptions; `prescriptions-lifecycle.test.ts` proves the service-level amend flow still flips the parent).

- [ ] **Step 8: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add drizzle/0017_phase1d_integrity.sql drizzle/meta/0017_snapshot.json drizzle/meta/_journal.json src/server/db/seed.ts tests/integration/integrity-1d.test.ts tests/integration/rls-guard.test.ts tests/integration/immutability.test.ts tests/integration/print-schema.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(db): rows born as drafts, superseding needs a finalized successor, status checks, counter grants, RLS guard" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: lint 0 errors (2 existing warnings), typecheck clean, the suite at the baseline + 19 tests, all passing.

---

## Task 2: Schema hardening — every CHECK in the Drizzle schema, clinical value checks, foreign-key indexes, `tenant_medicines.created_by`, and test-data hygiene

**Files:**
- Modify: `src/server/db/schema/tenancy.ts` (`clinicAssets`, `clinics` table configs), `src/server/db/schema/clinical.ts` (`visits`, `prescriptions`, `prescriptionItems`, `prescriptionOutputs` configs), `src/server/db/schema/catalogue.ts` (`globalClinicalTerms`, `tenantMedicines`, `medicineFavourites` configs)
- Create: `drizzle/0018_phase1d_schema_checks.sql` (generated, then hand-edited), `drizzle/meta/0018_snapshot.json`, `_journal.json` entry
- Create: `src/server/db/sweep-rules.ts`, `src/server/db/sweep-test-tenants.ts`
- Modify: `package.json` (script `db:sweep-test-tenants`)
- Modify: `tests/helpers/tenant.ts` (owner membership), `tests/integration/tenant-fk.test.ts` (guard predicate and delete rules), `tests/e2e/helpers.ts` (`seedPatients` through the counter), `tests/e2e/patients.spec.ts` (one new test)
- Test: `tests/integration/schema-checks.test.ts`, `tests/unit/sweep-rules.test.ts`, `tests/integration/sweep-test-tenants.test.ts`

**Interfaces:**
- Consumes: the 18 CHECK constraints of 0012/0014/0015 and the two of 0017 (names listed in Prerequisites), `memberships_tenant_user_unique (tenant_id, user_id)`, `PERIODICITIES` (`src/lib/domain/rx-options.ts`).
- Produces:
  - Drizzle: every table declares its CHECKs with `check(name, sql\`...\`)`; new ones: `rx_items_periodicity_check`, `rx_items_dose_slots_check`, `rx_items_duration_value_check`, `rx_items_duration_days_check`, `favourites_periodicity_check`, `favourites_dose_slots_check`, `favourites_duration_value_check`; indexes `visits_tenant_doctor_idx`, `visits_tenant_branch_idx`, `prescriptions_tenant_template_version_idx`; `tenant_medicines_created_by_fk (tenant_id, created_by) -> memberships (tenant_id, user_id) ON DELETE SET NULL (created_by)`.
  - `tests/integration/schema-checks.test.ts` "the schema declares every CHECK constraint" — the rule later tasks keep.
  - `createTestTenant` now also inserts `memberships { tenantId, userId, role: "owner" }` for its user.
  - `isLeakedTestTenant(t: TenantFacts, now: Date, minAgeMinutes: number): boolean`, `isLocalDatabaseUrl(url: string | undefined): boolean`, `TEST_EMAIL_DOMAIN = "@example.com"`, `PROTECTED_SLUGS = ["demo-clinic"]` (`src/server/db/sweep-rules.ts`).
  - `sweepTestTenants(opts: { apply: boolean; olderThanMinutes: number; now?: Date }): Promise<SweepReport>` with `SweepReport = { tenants: { id: string; slug: string }[]; users: number; applied: boolean }`; `npm run db:sweep-test-tenants -- [--apply] [--older-than=60]`.
  - e2e `seedPatients(email, count)` reserves its numbers in `tenant_counters`.

- [ ] **Step 1: Write the failing schema test**

`tests/integration/schema-checks.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/server/db/schema";
import { adminDb } from "@/server/db/admin";
import { pgErrorInfo } from "@/server/db/errors";
import { doctors, medicineFavourites, memberships, patients, prescriptionItems, prescriptions, tenantMedicines, users, visits } from "@/server/db/schema";
import { PERIODICITIES } from "@/lib/domain/rx-options";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let draftId = "";
let doctorA = "";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

beforeAll(async () => {
  A = await createTestTenant("checks-a");
  B = await createTestTenant("checks-b");
  const [patient] = await adminDb.insert(patients).values({ tenantId: A.tenantId, name: "Checks Patient" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId: A.tenantId, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId: A.tenantId, visitId: visit.id, status: "draft" }).returning();
  draftId = rx.id;
  const [doc] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, A.tenantId)).limit(1);
  doctorA = doc.id;
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

const item = (values: Partial<typeof prescriptionItems.$inferInsert>) =>
  adminDb.insert(prescriptionItems).values({ tenantId: A.tenantId, prescriptionId: draftId, drugName: "Check drug", ...values });
const favourite = (key: string, values: Partial<typeof medicineFavourites.$inferInsert>) =>
  adminDb.insert(medicineFavourites).values({ tenantId: A.tenantId, doctorId: doctorA, nameKey: key, drugName: key, ...values });

describe("clinical value checks (the same rules as src/server/validation/prescription.ts)", () => {
  it.each([
    ["an unknown periodicity", { periodicity: "hourly" }],
    ["a dose that is not a quarter step", { doseMorning: 0.3 }],
    ["a negative dose", { doseEvening: -1 }],
    ["a dose above 99", { doseNight: 99.25 }],
    ["a zero duration", { durationValue: 0 }],
    ["a duration above 365", { durationValue: 366 }],
    ["more than 365 total days", { durationDays: 400 }],
  ])("refuses %s on a prescription item, even on the admin connection (23514)", async (_label, values) => {
    await expectCode(item(values), "23514");
  });

  it("accepts every periodicity the editor offers, quarter-step doses, and the Plan 1A day count", async () => {
    for (const periodicity of PERIODICITIES) await item({ periodicity });
    await item({ doseMorning: 0.25, doseAfternoon: 0.5, doseEvening: 0.75, doseNight: 99 });
    await item({ durationValue: 12, durationUnit: "months", durationDays: 360 });
    await item({ durationDays: 365 });
  });

  it.each([
    ["an unknown periodicity", { periodicity: "hourly" }],
    ["a dose that is not a quarter step", { doseAfternoon: 1.1 }],
    ["a zero duration", { durationValue: 0 }],
  ])("refuses %s on a favourite (23514)", async (label, values) => {
    await expectCode(favourite(`fav-${label}`, values), "23514");
  });
});

describe("indexes on the 0010 foreign-key columns", () => {
  it("exist under their names", async () => {
    const rows = await adminDb.execute<{ indexname: string }>(sql`
      select indexname::text as indexname from pg_indexes
       where schemaname = 'public'
         and indexname in ('visits_tenant_doctor_idx', 'visits_tenant_branch_idx', 'prescriptions_tenant_template_version_idx')
       order by 1`);
    expect(rows.map((r) => r.indexname)).toEqual([
      "prescriptions_tenant_template_version_idx",
      "visits_tenant_branch_idx",
      "visits_tenant_doctor_idx",
    ]);
  });
});

describe("tenant_medicines.created_by", () => {
  it("must name a member of the same clinic (23503), or nobody", async () => {
    const own = A.as("doctor").userId;
    const foreign = B.as("doctor").userId;
    await adminDb.insert(tenantMedicines).values({ tenantId: A.tenantId, name: "Own Med", nameKey: "own med", createdBy: own });
    await adminDb.insert(tenantMedicines).values({ tenantId: A.tenantId, name: "Nobody Med", nameKey: "nobody med", createdBy: null });
    await expectCode(
      adminDb.insert(tenantMedicines).values({ tenantId: A.tenantId, name: "Foreign Med", nameKey: "foreign med", createdBy: foreign }),
      "23503",
    );
  });

  it("is cleared, and tenant_id kept, when the member leaves the clinic", async () => {
    const [user] = await adminDb.insert(users).values({ email: `leaver-${Date.now()}@example.com`, name: "Leaver" }).returning();
    try {
      await adminDb.insert(memberships).values({ tenantId: A.tenantId, userId: user.id, role: "doctor" });
      const [med] = await adminDb
        .insert(tenantMedicines)
        .values({ tenantId: A.tenantId, name: "Leaver Med", nameKey: "leaver med", createdBy: user.id })
        .returning();
      await adminDb.delete(memberships).where(eq(memberships.userId, user.id));
      const [after] = await adminDb.select().from(tenantMedicines).where(eq(tenantMedicines.id, med.id));
      expect(after).toMatchObject({ tenantId: A.tenantId, createdBy: null });
    } finally {
      await adminDb.delete(users).where(eq(users.id, user.id));
    }
  });
});

describe("the schema declares every CHECK constraint", () => {
  it("lists exactly the CHECK constraints that exist in the database", async () => {
    const declared = Object.values(schema)
      .filter((value): value is PgTable => is(value, PgTable))
      .flatMap((table) => getTableConfig(table).checks.map((c) => c.name))
      .sort();
    const rows = await adminDb.execute<{ conname: string }>(sql`
      select conname::text as conname from pg_constraint
       where contype = 'c' and connamespace = 'public'::regnamespace order by 1`);
    expect(declared).toEqual(rows.map((r) => r.conname).sort());
    expect(declared.length).toBeGreaterThanOrEqual(27);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/schema-checks.test.ts
```

Expected: FAIL — the seven "refuses" item cases insert successfully, the favourite cases insert, the index list is empty, the foreign `createdBy` is accepted, and `declared` is `[]` while the database lists 20 CHECKs. (The "accepts" test passes.)

- [ ] **Step 3: Declare the CHECKs, indexes and key in the Drizzle schema**

`src/server/db/schema/tenancy.ts`: add `check` to the `drizzle-orm/pg-core` import and `import { sql } from "drizzle-orm";`. In `clinicAssets`' config array, after `unique("clinic_assets_dedupe_key")...`, add:

```ts
    // Declared here as well as in SQL (0014, 0015) so drizzle-kit knows them; tests/integration/schema-checks.test.ts pins the list.
    check("clinic_assets_kind_check", sql`kind in ('logo', 'signature')`),
    check("clinic_assets_mime_check", sql`mime in ('image/png', 'image/jpeg')`),
    check("clinic_assets_size_check", sql`byte_size between 1 and 524288 and octet_length(bytes) = byte_size`),
    check("clinic_assets_dimensions_check", sql`width between 16 and 2000 and height between 16 and 2000`),
    check("clinic_assets_sha256_check", sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check("clinic_assets_hash_matches_check", sql`sha256 = encode(sha256(bytes), 'hex')`),
```

In `clinics`' config array, after `clinics_logo_asset_fk`, add:

```ts
    check("clinics_rx_template_check", sql`rx_template in ('general', 'paediatric', 'derma')`),
    check("clinics_rx_paper_size_check", sql`rx_paper_size in ('A4', 'A5')`),
    check("clinics_rx_labels_check", sql`rx_labels in ('en', 'hi', 'bilingual')`),
```

`src/server/db/schema/clinical.ts`: add `check` to the `drizzle-orm/pg-core` import (`sql` is already imported). In `visits`' config array, after `index("visits_tenant_patient_idx")...`, add:

```ts
    // Offboarding and history scans by doctor or branch (Plan 1D).
    index("visits_tenant_doctor_idx").on(t.tenantId, t.doctorId),
    index("visits_tenant_branch_idx").on(t.tenantId, t.branchId),
    check("visits_status_check", sql`status in ('draft', 'finalized')`),
```

In `prescriptions`' config array, after `index("prescriptions_visit_idx")...`, add:

```ts
    index("prescriptions_tenant_template_version_idx").on(t.tenantId, t.templateVersionId),
    check("prescriptions_status_check", sql`status in ('draft', 'finalized', 'amended')`),
```

In `prescriptionItems`' config array, after `rx_items_prescription_fk`, add:

```ts
    // The database refuses what Zod refuses (src/server/validation/prescription.ts); 0012 and 0018.
    check("rx_items_duration_unit_check", sql`duration_unit is null or duration_unit in ('days', 'weeks', 'months')`),
    check(
      "rx_items_periodicity_check",
      sql`periodicity is null or periodicity in ('daily', 'alternate_day', 'twice_weekly', 'weekly', 'every_5th_day', 'fortnightly', 'monthly', 'as_needed')`,
    ),
    check(
      "rx_items_dose_slots_check",
      sql`(dose_morning is null or (dose_morning between 0 and 99 and dose_morning * 4 = trunc(dose_morning * 4))) and (dose_afternoon is null or (dose_afternoon between 0 and 99 and dose_afternoon * 4 = trunc(dose_afternoon * 4))) and (dose_evening is null or (dose_evening between 0 and 99 and dose_evening * 4 = trunc(dose_evening * 4))) and (dose_night is null or (dose_night between 0 and 99 and dose_night * 4 = trunc(dose_night * 4)))`,
    ),
    check("rx_items_duration_value_check", sql`duration_value is null or duration_value between 1 and 365`),
    check("rx_items_duration_days_check", sql`duration_days is null or duration_days between 1 and 365`),
```

In `prescriptionOutputs`' config array, after `index("rx_outputs_prescription_idx")...`, add:

```ts
    check("rx_outputs_kind_check", sql`kind in ('pdf_download', 'browser_print')`),
    check("rx_outputs_paper_size_check", sql`paper_size in ('A4', 'A5')`),
    check("rx_outputs_page_count_check", sql`page_count is null or page_count between 1 and 50`),
    check("rx_outputs_byte_size_check", sql`byte_size is null or byte_size >= 0`),
    check("rx_outputs_sha256_check", sql`html_sha256 ~ '^[0-9a-f]{64}$'`),
    check("rx_outputs_template_key_check", sql`template_key in ('general', 'paediatric', 'derma')`),
```

`src/server/db/schema/catalogue.ts`: add `check` to the `drizzle-orm/pg-core` import, `import { sql } from "drizzle-orm";`, and import `memberships` next to `doctors, tenants` from `./tenancy`. Change `globalClinicalTerms`' config to:

```ts
  (t) => [
    unique("global_terms_kind_key_unique").on(t.kind, t.nameKey),
    check("global_terms_kind_check", sql`kind in ('complaint', 'diagnosis', 'history', 'test')`),
  ],
```

`tenantMedicines`' config to:

```ts
  (t) => [
    unique("tenant_medicines_tenant_key_unique").on(t.tenantId, t.nameKey),
    // Same-tenant reference to the member who added it (ADR-0025 pattern on memberships' (tenant_id, user_id) key).
    // The delete rule is ON DELETE SET NULL (created_by), hand-written in 0018: a plain composite SET NULL would null tenant_id.
    foreignKey({
      name: "tenant_medicines_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete("set null"),
  ],
```

and in `medicineFavourites`' config array, after `medicine_favourites_doctor_fk`, add:

```ts
    check("favourites_duration_unit_check", sql`duration_unit is null or duration_unit in ('days', 'weeks', 'months')`),
    check(
      "favourites_periodicity_check",
      sql`periodicity is null or periodicity in ('daily', 'alternate_day', 'twice_weekly', 'weekly', 'every_5th_day', 'fortnightly', 'monthly', 'as_needed')`,
    ),
    check(
      "favourites_dose_slots_check",
      sql`(dose_morning is null or (dose_morning between 0 and 99 and dose_morning * 4 = trunc(dose_morning * 4))) and (dose_afternoon is null or (dose_afternoon between 0 and 99 and dose_afternoon * 4 = trunc(dose_afternoon * 4))) and (dose_evening is null or (dose_evening between 0 and 99 and dose_evening * 4 = trunc(dose_evening * 4))) and (dose_night is null or (dose_night between 0 and 99 and dose_night * 4 = trunc(dose_night * 4)))`,
    ),
    check("favourites_duration_value_check", sql`duration_value is null or duration_value between 1 and 365`),
```

- [ ] **Step 4: Generate the migration and replace its body**

```powershell
Set-Location E:\projects\clinicpad; npx drizzle-kit generate --name=phase1d_schema_checks
```

Expected: `drizzle/0018_phase1d_schema_checks.sql` with three `CREATE INDEX`, one `ADD CONSTRAINT "tenant_medicines_created_by_fk"` and 27 `ADD CONSTRAINT ... CHECK` statements, plus `drizzle/meta/0018_snapshot.json`. Twenty of those CHECKs already exist (0012, 0014, 0015, 0017). **Keep the snapshot as generated** and replace the SQL file's content with:

```sql
-- Plan 1D schema hardening (generated by drizzle-kit, then edited by hand). The Drizzle schema now declares every CHECK
-- constraint; this file adds only the NEW ones (the other twenty already exist from 0012, 0014, 0015 and 0017).

-- 1. Indexes on the foreign-key columns added in 0010 (offboarding scans, history filters by doctor).
CREATE INDEX IF NOT EXISTS "visits_tenant_doctor_idx" ON "visits" USING btree ("tenant_id","doctor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "visits_tenant_branch_idx" ON "visits" USING btree ("tenant_id","branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescriptions_tenant_template_version_idx" ON "prescriptions" USING btree ("tenant_id","template_version_id");--> statement-breakpoint

-- 2. Clinical value checks: the database refuses what Zod refuses. NOT VALID first, validated below when every row passes.
ALTER TABLE "prescription_items" ADD CONSTRAINT "rx_items_periodicity_check" CHECK (periodicity is null or periodicity in ('daily', 'alternate_day', 'twice_weekly', 'weekly', 'every_5th_day', 'fortnightly', 'monthly', 'as_needed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "rx_items_dose_slots_check" CHECK ((dose_morning is null or (dose_morning between 0 and 99 and dose_morning * 4 = trunc(dose_morning * 4))) and (dose_afternoon is null or (dose_afternoon between 0 and 99 and dose_afternoon * 4 = trunc(dose_afternoon * 4))) and (dose_evening is null or (dose_evening between 0 and 99 and dose_evening * 4 = trunc(dose_evening * 4))) and (dose_night is null or (dose_night between 0 and 99 and dose_night * 4 = trunc(dose_night * 4)))) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "rx_items_duration_value_check" CHECK (duration_value is null or duration_value between 1 and 365) NOT VALID;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "rx_items_duration_days_check" CHECK (duration_days is null or duration_days between 1 and 365) NOT VALID;--> statement-breakpoint
ALTER TABLE "medicine_favourites" ADD CONSTRAINT "favourites_periodicity_check" CHECK (periodicity is null or periodicity in ('daily', 'alternate_day', 'twice_weekly', 'weekly', 'every_5th_day', 'fortnightly', 'monthly', 'as_needed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "medicine_favourites" ADD CONSTRAINT "favourites_dose_slots_check" CHECK ((dose_morning is null or (dose_morning between 0 and 99 and dose_morning * 4 = trunc(dose_morning * 4))) and (dose_afternoon is null or (dose_afternoon between 0 and 99 and dose_afternoon * 4 = trunc(dose_afternoon * 4))) and (dose_evening is null or (dose_evening between 0 and 99 and dose_evening * 4 = trunc(dose_evening * 4))) and (dose_night is null or (dose_night between 0 and 99 and dose_night * 4 = trunc(dose_night * 4)))) NOT VALID;--> statement-breakpoint
ALTER TABLE "medicine_favourites" ADD CONSTRAINT "favourites_duration_value_check" CHECK (duration_value is null or duration_value between 1 and 365) NOT VALID;--> statement-breakpoint
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass::text AS tbl, conname::text AS name
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND contype = 'c' AND NOT convalidated
       AND conname IN ('rx_items_periodicity_check', 'rx_items_dose_slots_check', 'rx_items_duration_value_check',
                       'rx_items_duration_days_check', 'favourites_periodicity_check', 'favourites_dose_slots_check',
                       'favourites_duration_value_check', 'prescriptions_status_check', 'visits_status_check')
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.name);
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE '% stays NOT VALID: existing rows break it (development data; run npm run db:sweep-test-tenants)', c.name;
    END;
  END LOOP;
END $$;--> statement-breakpoint

-- 3. tenant_medicines.created_by: same-tenant reference to the member who added the medicine. Rows naming someone who
--    is not (or no longer) a member of that clinic are cleared first (tenant_medicines has no immutability trigger).
UPDATE "tenant_medicines" t SET "created_by" = NULL
 WHERE "created_by" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."tenant_id" = t."tenant_id" AND m."user_id" = t."created_by");--> statement-breakpoint
ALTER TABLE "tenant_medicines" ADD CONSTRAINT "tenant_medicines_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE SET NULL ("created_by") ON UPDATE no action;
```

(The DO block also retries the two 0017 status constraints, so a database that was swept between the two migrations validates them here.)

- [ ] **Step 5: Give test tenants a membership, and widen the composite-key guard to memberships' key**

In `tests/helpers/tenant.ts`, add `memberships` to the schema import and, directly after `await adminDb.insert(doctors).values({ tenantId: tenant.id, userId: user.id });`, add:

```ts
    // Real users act inside a clinic they belong to; keys such as tenant_medicines_created_by_fk rely on it.
    await adminDb.insert(memberships).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
```

In `tests/integration/tenant-fk.test.ts`, change the filter inside `"has no single-column key into a tenant-owned table"` to:

```ts
    const singleColumn = rows
      // Composite same-tenant keys: (tenant_id, x) -> parent (tenant_id, y), where y is id or, for memberships, user_id.
      .filter((r) => !(r.child_cols.length === 2 && r.child_cols[0] === "tenant_id" && r.parent_cols.length === 2 && r.parent_cols[0] === "tenant_id"))
      .map((r) => r.conname)
      .sort();
```

and add `tenant_medicines_created_by_fk: "SET NULL",` to the `toMatchObject` map in `"keeps each converted key's delete rule"`, plus a sibling of `"nulls only primary_branch_id (not tenant_id) when a branch is deleted"`:

```ts
  it("nulls only created_by (not tenant_id) when a member leaves", async () => {
    const [row] = await adminDb.execute<{ set_cols: string[] | null }>(sql`
      select (select array_agg(a.attname::text order by k.ord)
                from unnest(c.confdelsetcols) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as set_cols
        from pg_constraint c
       where c.conname = 'tenant_medicines_created_by_fk' and c.connamespace = 'public'::regnamespace`);
    expect(row?.set_cols).toEqual(["created_by"]);
  });
```

- [ ] **Step 6: Apply and run the focused tests**

```powershell
Set-Location E:\projects\clinicpad; npm run db:migrate
Set-Location E:\projects\clinicpad; npx drizzle-kit generate
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/schema-checks.test.ts tests/integration/tenant-fk.test.ts tests/integration/catalogue.test.ts tests/integration/prescriptions-clinical.test.ts tests/integration/clinical-schema.test.ts
```

Expected: migrate applies (a `NOTICE ... stays NOT VALID` is possible on a dirty development database; Step 9 deals with it); `generate` answers "No schema changes, nothing to migrate"; `schema-checks.test.ts` passes (15 tests), `tenant-fk.test.ts` gains one, and the catalogue and clinical files pass unchanged (`addClinicMedicine` now writes a `created_by` that has a membership, through `createTestTenant`).

- [ ] **Step 7: Write the sweep rules test, then the rules and the script**

`tests/unit/sweep-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isLeakedTestTenant, isLocalDatabaseUrl, type TenantFacts } from "@/server/db/sweep-rules";

const now = new Date("2026-11-17T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const tenant = (overrides: Partial<TenantFacts> = {}): TenantFacts => ({
  id: "t",
  slug: "t-label-1763380000000-abc",
  createdAt: hoursAgo(3),
  memberEmails: [],
  ...overrides,
});

describe("isLeakedTestTenant", () => {
  it("sweeps an old tenant with no members (integration-test tenants before Plan 1D)", () => {
    expect(isLeakedTestTenant(tenant(), now, 60)).toBe(true);
  });

  it("sweeps an old tenant whose members all use the reserved example.com domain", () => {
    expect(isLeakedTestTenant(tenant({ memberEmails: ["pat-1@example.com", "x@EXAMPLE.COM"] }), now, 60)).toBe(true);
  });

  it("keeps a tenant with any real member", () => {
    expect(isLeakedTestTenant(tenant({ memberEmails: ["pat-1@example.com", "doctor@clinic.in"] }), now, 60)).toBe(false);
  });

  it("keeps the demo clinic whatever its members", () => {
    expect(isLeakedTestTenant(tenant({ slug: "demo-clinic" }), now, 60)).toBe(false);
  });

  it("keeps anything younger than the threshold, so a running test suite is never disturbed", () => {
    expect(isLeakedTestTenant(tenant({ createdAt: hoursAgo(0.5) }), now, 60)).toBe(false);
  });

  it("does not treat look-alike domains as test domains", () => {
    expect(isLeakedTestTenant(tenant({ memberEmails: ["a@example.com.evil.in"] }), now, 60)).toBe(false);
    expect(isLeakedTestTenant(tenant({ memberEmails: ["a@notexample.com"] }), now, 60)).toBe(false);
  });
});

describe("isLocalDatabaseUrl", () => {
  it.each([
    ["postgresql://clinicpad:clinicpad@localhost:5432/clinicpad", true],
    ["postgresql://u:p@127.0.0.1:5432/db", true],
    ["postgresql://u:p@[::1]:5432/db", true],
    ["postgresql://u:p@postgres:5432/db", true],
    ["postgresql://u:p@db.abcd.supabase.co:5432/postgres", false],
    ["not a url", false],
    [undefined, false],
  ])("%s -> %s", (url, expected) => {
    expect(isLocalDatabaseUrl(url)).toBe(expected);
  });
});
```

`src/server/db/sweep-rules.ts`:

```ts
/**
 * Which tenants in a DEVELOPMENT database are leftovers of aborted test runs. Pure; the script that deletes
 * them (sweep-test-tenants.ts) refuses to run against anything but a local database.
 */

/** RFC 2606 reserves example.com: no real user can have an address there. Tests use it for every user. */
export const TEST_EMAIL_DOMAIN = "@example.com";

/** Never swept, whatever its members (the demo seed re-creates it anyway). */
export const PROTECTED_SLUGS: readonly string[] = ["demo-clinic"];

export type TenantFacts = { id: string; slug: string; createdAt: Date; memberEmails: string[] };

/** A test tenant: older than the threshold, not protected, and every member (if any) has a test address. */
export function isLeakedTestTenant(t: TenantFacts, now: Date, minAgeMinutes: number): boolean {
  if (PROTECTED_SLUGS.includes(t.slug)) return false;
  if (now.getTime() - t.createdAt.getTime() < minAgeMinutes * 60_000) return false;
  return t.memberEmails.every((email) => email.toLowerCase().endsWith(TEST_EMAIL_DOMAIN));
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/** True only for a database on this machine or the docker-compose service. */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
```

`src/server/db/sweep-test-tenants.ts`:

```ts
import { pathToFileURL } from "node:url";
import { inArray, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { tenants } from "@/server/db/schema";
import { isLeakedTestTenant, isLocalDatabaseUrl, TEST_EMAIL_DOMAIN, type TenantFacts } from "./sweep-rules";

export type SweepReport = { tenants: { id: string; slug: string }[]; users: number; applied: boolean };

/**
 * Lists (and with apply, deletes) tenants left behind by aborted test runs, then test users that belong to no
 * clinic. Deleting a tenant row erases its records through the cascades (tenant_is_erased, ADR-0023).
 */
export async function sweepTestTenants(opts: { apply: boolean; olderThanMinutes: number; now?: Date }): Promise<SweepReport> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.olderThanMinutes * 60_000);
  const rows = await adminDb.execute<{ id: string; slug: string; created_at: Date | string; emails: string[] | null }>(sql`
    select t.id::text as id, t.slug, t.created_at, array_remove(array_agg(u.email::text), null) as emails
      from tenants t
      left join memberships m on m.tenant_id = t.id
      left join users u on u.id = m.user_id
     group by t.id, t.slug, t.created_at`);
  const facts: TenantFacts[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    createdAt: new Date(r.created_at),
    memberEmails: r.emails ?? [],
  }));
  const leaked = facts.filter((t) => isLeakedTestTenant(t, now, opts.olderThanMinutes));
  const pattern = `%${TEST_EMAIL_DOMAIN}`;

  if (!opts.apply) {
    const [count] = await adminDb.execute<{ n: number }>(sql`
      select count(*)::int as n from users u
       where lower(u.email) like ${pattern} and u.created_at < ${cutoff}
         and not exists (select 1 from memberships m where m.user_id = u.id)`);
    return { tenants: leaked.map(({ id, slug }) => ({ id, slug })), users: count.n, applied: false };
  }

  for (let i = 0; i < leaked.length; i += 100) {
    await adminDb.delete(tenants).where(inArray(tenants.id, leaked.slice(i, i + 100).map((t) => t.id)));
  }
  const removed = await adminDb.execute<{ id: string }>(sql`
    delete from users u
     where lower(u.email) like ${pattern} and u.created_at < ${cutoff}
       and not exists (select 1 from memberships m where m.user_id = u.id)
    returning u.id::text as id`);
  return { tenants: leaked.map(({ id, slug }) => ({ id, slug })), users: removed.length, applied: true };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const older = args.find((a) => a.startsWith("--older-than="));
  const olderThanMinutes = older ? Number(older.split("=")[1]) : 60;
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!Number.isInteger(olderThanMinutes) || olderThanMinutes < 10) {
    console.error("--older-than must be a whole number of minutes, at least 10.");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" || !isLocalDatabaseUrl(url)) {
    console.error("Refusing to sweep: this script only runs against a local development database.");
    process.exit(1);
  }
  sweepTestTenants({ apply, olderThanMinutes })
    .then((report) => {
      console.log(`${report.applied ? "Deleted" : "Would delete"} ${report.tenants.length} test tenants and ${report.users} test users.`);
      for (const t of report.tenants.slice(0, 50)) console.log(`  ${t.slug}`);
      if (!report.applied) console.log("Run again with --apply to delete them.");
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.name : typeof error);
      process.exit(1);
    });
}
```

In `package.json` `scripts`, after `"db:seed:catalogue"`, add:

```json
    "db:sweep-test-tenants": "tsx --env-file=.env.local src/server/db/sweep-test-tenants.ts",
```

`tests/integration/sweep-test-tenants.test.ts` (dry run only: a real sweep would also remove other runs' leftovers):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { memberships, tenants, users } from "@/server/db/schema";
import { sweepTestTenants } from "@/server/db/sweep-test-tenants";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ids: string[] = [];
let realUser = "";

beforeAll(async () => {
  const old = new Date(Date.now() - 3 * 3_600_000);
  const [stale] = await adminDb.insert(tenants).values({ name: "Stale", slug: `sweep-stale-${stamp}`, createdAt: old }).returning();
  const [fresh] = await adminDb.insert(tenants).values({ name: "Fresh", slug: `sweep-fresh-${stamp}` }).returning();
  const [real] = await adminDb.insert(tenants).values({ name: "Real", slug: `sweep-real-${stamp}`, createdAt: old }).returning();
  ids.push(stale.id, fresh.id, real.id);
  const [user] = await adminDb.insert(users).values({ email: `owner-${stamp}@clinic.test`, name: "Real Owner" }).returning();
  realUser = user.id;
  await adminDb.insert(memberships).values({ tenantId: real.id, userId: user.id, role: "owner" });
});

afterAll(async () => {
  for (const id of ids) await adminDb.delete(tenants).where(eq(tenants.id, id));
  await adminDb.delete(users).where(eq(users.id, realUser));
});

describe("sweepTestTenants (dry run)", () => {
  it("lists an old memberless tenant, never a fresh one or one with a real member, and deletes nothing", async () => {
    const report = await sweepTestTenants({ apply: false, olderThanMinutes: 60 });
    const slugs = report.tenants.map((t) => t.slug);
    expect(slugs).toContain(`sweep-stale-${stamp}`);
    expect(slugs).not.toContain(`sweep-fresh-${stamp}`);
    expect(slugs).not.toContain(`sweep-real-${stamp}`);
    expect(slugs).not.toContain("demo-clinic");
    expect(report.applied).toBe(false);
    expect(await adminDb.select().from(tenants).where(eq(tenants.id, ids[0]))).toHaveLength(1);
  });
});
```

- [ ] **Step 8: Make the e2e `seedPatients` reserve its numbers through the counter, and prove it**

In `tests/e2e/helpers.ts`, replace `seedPatients` with:

```ts
/**
 * Inserts `count` patients straight into the clinic (newest = highest number) for paging tests. The numbers are
 * reserved through tenant_counters, exactly like allocateNumbers, so a patient registered afterwards continues the sequence.
 */
export async function seedPatients(email: string, count: number): Promise<void> {
  await withAdminSql(async (sql) => {
    await sql.begin(async (tx) => {
      const [member] = await tx<{ tenant_id: string }[]>`
        select m.tenant_id from memberships m join users u on u.id = m.user_id where u.email = ${email} limit 1`;
      if (!member) throw new Error("seedPatients: no clinic for that email");
      const [counter] = await tx<{ last_no: number }[]>`
        insert into tenant_counters (tenant_id, name, last_no) values (${member.tenant_id}, 'patient', ${count})
        on conflict (tenant_id, name) do update set last_no = tenant_counters.last_no + ${count}
        returning last_no`;
      const first = counter.last_no - count + 1;
      await tx`insert into patients (id, tenant_id, patient_no, name, created_at)
        select gen_random_uuid(), ${member.tenant_id}, ${first}::int - 1 + g, 'Seed Patient ' || lpad(g::text, 3, '0'),
               now() - ((${count}::int - g) * interval '1 minute')
          from generate_series(1, ${count}::int) as g`;
    });
  });
}
```

In `tests/e2e/patients.spec.ts`, add after the paging test:

```ts
test("a patient registered after seeded ones continues the number sequence", async ({ page }) => {
  const clinic = await newClinic(page, "seqno");
  await seedPatients(clinic.email, 3);
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Sequence Check");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Sequence Check" })).toBeVisible();
  await expect(page.getByText(/Patient #4\b/)).toBeVisible();
});
```

- [ ] **Step 9: Sweep the development database and re-validate, then run everything**

```powershell
Set-Location E:\projects\clinicpad; npm run db:sweep-test-tenants
Set-Location E:\projects\clinicpad; npm run db:sweep-test-tenants -- --apply
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/sweep-rules.test.ts tests/integration/sweep-test-tenants.test.ts tests/integration/schema-checks.test.ts
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/patients.spec.ts
```

Expected: the first run lists the leftover tenants without deleting (record the count in your report), the second deletes them; the unit file passes (13 tests), the dry-run file (1) and schema checks (15) pass; the patients spec passes 5 tests. Then list any constraint that is still NOT VALID and validate it on the swept database:

```powershell
Set-Location E:\projects\clinicpad; docker compose exec -T postgres psql -U clinicpad -d clinicpad -At -c "select conrelid::regclass || ' ' || conname from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c' and not convalidated"
```

Expected: no output. For each line it prints (`<table> <constraint>`), run `docker compose exec -T postgres psql -U clinicpad -d clinicpad -v ON_ERROR_STOP=1 -c "alter table <table> validate constraint <constraint>"`; it must succeed. If one still fails, a non-test row breaks a rule: stop and report the table and constraint; never edit rows by hand.

- [ ] **Step 10: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/db/schema/tenancy.ts src/server/db/schema/clinical.ts src/server/db/schema/catalogue.ts drizzle/0018_phase1d_schema_checks.sql drizzle/meta/0018_snapshot.json drizzle/meta/_journal.json src/server/db/sweep-rules.ts src/server/db/sweep-test-tenants.ts package.json tests/integration/schema-checks.test.ts tests/integration/tenant-fk.test.ts tests/integration/sweep-test-tenants.test.ts tests/unit/sweep-rules.test.ts tests/helpers/tenant.ts tests/e2e/helpers.ts tests/e2e/patients.spec.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(db): declare every CHECK in the schema, clinical value checks, FK indexes, created_by key, test-tenant sweep" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: lint 0 errors, typecheck clean, suite passing at Task 1's count + 30.

---

## Task 3: Clinic-timezone dates — a newborn can be registered after midnight IST, and ages use the clinic's day

**Files:**
- Create: `src/lib/domain/clinic-date.ts`, `src/server/services/clinic.ts`
- Modify: `src/server/services/render-snapshot.ts` (move `clinicLocalDate` out, re-export it), `src/server/validation/patient.ts` (structural UTC+14 bound, `DOB_FUTURE_MESSAGE`), `src/server/services/patients.ts` (`createPatient`, `updatePatient`: clinic-day check), `src/app/(app)/patients/page.tsx`, `src/app/(app)/patients/[id]/page.tsx`, `src/app/(app)/patients/new/page.tsx`, `src/components/patients/patient-form.tsx` (`maxDob` prop)
- Test: `tests/unit/clinic-date.test.ts`, `tests/integration/patients-dates.test.ts`; modify `tests/integration/patients.test.ts` (the UTC "after today" test)

**Interfaces:**
- Consumes: `DEFAULT_TIME_ZONE`, `isValidTimeZone` (`src/lib/rx-render/format.ts`); `primaryClinic(tx, tenantId)` (`src/server/services/render-snapshot.ts`); `ageLabel(dob, now: Date | "YYYY-MM-DD")` (`src/lib/domain/age.ts`); `createTestTenant`.
- Produces:
  - `clinicLocalDate(at: Date, timeZone: string | null | undefined): string` and `latestCalendarDate(at: Date): string` in `src/lib/domain/clinic-date.ts` (`render-snapshot.ts` keeps exporting `clinicLocalDate` for existing importers).
  - `clinicTimeZoneIn(tx: TenantTx, tenantId: string): Promise<string>` and `getClinicTimeZone(ctx: ServiceContext): Promise<string>` in `src/server/services/clinic.ts` (always a valid IANA zone; `Asia/Kolkata` fallback). Task 8 adds `getClinicSharing` / `setClinicSharing` to the same file.
  - `DOB_FUTURE_MESSAGE = "Date of birth cannot be in the future"` exported from `src/server/validation/patient.ts` (Task 6 uses it).
  - `createPatient` / `updatePatient` return `{ ok: false, code: "invalid", field: "dob", message: DOB_FUTURE_MESSAGE }` when the DOB is after today in the clinic's zone.
  - `PatientForm` gains an optional `maxDob?: string` prop (the date input's `max`).

- [ ] **Step 1: Write the failing unit test**

`tests/unit/clinic-date.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clinicLocalDate, latestCalendarDate } from "@/lib/domain/clinic-date";
import { ageLabel } from "@/lib/domain/age";

// 2026-11-16T19:00:00Z is 00:30 on 17 November in India (UTC+05:30) and 14:00 on 16 November in New York.
const halfPastMidnightIst = new Date("2026-11-16T19:00:00.000Z");

describe("clinicLocalDate", () => {
  it("returns the clinic's calendar day, not UTC's", () => {
    expect(clinicLocalDate(halfPastMidnightIst, "Asia/Kolkata")).toBe("2026-11-17");
    expect(clinicLocalDate(halfPastMidnightIst, "UTC")).toBe("2026-11-16");
    expect(clinicLocalDate(halfPastMidnightIst, "America/New_York")).toBe("2026-11-16");
    expect(clinicLocalDate(halfPastMidnightIst, "Asia/Dubai")).toBe("2026-11-16");
  });

  it("falls back to Asia/Kolkata (never UTC) for a missing or damaged zone", () => {
    for (const zone of [null, undefined, "", "Mars/Olympus", "Asia/Kolkata\u0000"]) {
      expect(clinicLocalDate(halfPastMidnightIst, zone)).toBe("2026-11-17");
    }
  });
});

describe("latestCalendarDate", () => {
  it("is the date at UTC+14, the first place on Earth where a day starts", () => {
    expect(latestCalendarDate(new Date("2026-11-16T09:59:59.000Z"))).toBe("2026-11-16");
    expect(latestCalendarDate(new Date("2026-11-16T10:00:00.000Z"))).toBe("2026-11-17");
  });

  it("is never earlier than any clinic's day", () => {
    for (const zone of ["Pacific/Kiritimati", "Asia/Kolkata", "UTC", "Pacific/Pago_Pago"]) {
      expect(latestCalendarDate(halfPastMidnightIst) >= clinicLocalDate(halfPastMidnightIst, zone)).toBe(true);
    }
  });
});

describe("a newborn's age at 00:30 IST", () => {
  it("is 0 days on the clinic's day, where the UTC day would print nothing (the born-in-the-future bug)", () => {
    expect(ageLabel("2026-11-17", clinicLocalDate(halfPastMidnightIst, "Asia/Kolkata"))).toBe("0 d");
    expect(ageLabel("2026-11-17", halfPastMidnightIst)).toBe("");
  });
});
```

`tests/integration/patients-dates.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics } from "@/server/db/schema";
import { createPatient, updatePatient } from "@/server/services/patients";
import { getClinicTimeZone } from "@/server/services/clinic";
import { DOB_FUTURE_MESSAGE } from "@/server/validation/patient";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let IST: TestTenant;
let NYC: TestTenant;
// 00:30 on 17 November in India; still 16 November in New York.
const NOW = new Date("2026-11-16T19:00:00.000Z");

beforeAll(async () => {
  IST = await createTestTenant("dates-ist");
  NYC = await createTestTenant("dates-nyc");
  await adminDb.update(clinics).set({ timezone: "America/New_York" }).where(eq(clinics.tenantId, NYC.tenantId));
});

afterAll(async () => {
  await IST.cleanup();
  await NYC.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Only Date is faked: timers and I/O keep running, so database calls behave normally. */
function at(now: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

describe("date of birth on the clinic's calendar", () => {
  it("registers a baby born today, 00:30 IST, in an Indian clinic", async () => {
    at(NOW);
    const created = await createPatient(IST.as("reception"), { name: "Baby Rao", dob: "2026-11-17" });
    expect(created).toMatchObject({ ok: true });
  });

  it("refuses the same date in a New York clinic, where it is still 16 November", async () => {
    at(NOW);
    const created = await createPatient(NYC.as("reception"), { name: "Baby Doe", dob: "2026-11-17" });
    expect(created).toEqual({ ok: false, code: "invalid", message: DOB_FUTURE_MESSAGE, field: "dob" });
  });

  it("refuses tomorrow everywhere, before any database work (the structural UTC+14 bound)", async () => {
    at(NOW);
    const created = await createPatient(IST.as("reception"), { name: "Baby Later", dob: "2026-11-18" });
    expect(created).toMatchObject({ ok: false, code: "invalid", field: "dob" });
  });

  it("applies the same rule when a patient is edited", async () => {
    at(NOW);
    const created = await createPatient(NYC.as("reception"), { name: "Edit Doe" });
    if (!created.ok) throw new Error(created.message);
    const updated = await updatePatient(NYC.as("reception"), created.value.id, { name: "Edit Doe", dob: "2026-11-17" });
    expect(updated).toEqual({ ok: false, code: "invalid", message: DOB_FUTURE_MESSAGE, field: "dob" });
    const fine = await updatePatient(NYC.as("reception"), created.value.id, { name: "Edit Doe", dob: "2026-11-16" });
    expect(fine).toMatchObject({ ok: true });
  });
});

describe("getClinicTimeZone", () => {
  it("returns the clinic's zone, or Asia/Kolkata when the stored zone is damaged", async () => {
    expect(await getClinicTimeZone(NYC.as("nurse"))).toBe("America/New_York");
    await adminDb.update(clinics).set({ timezone: "Not/AZone" }).where(eq(clinics.tenantId, IST.tenantId));
    try {
      expect(await getClinicTimeZone(IST.as("nurse"))).toBe("Asia/Kolkata");
    } finally {
      await adminDb.update(clinics).set({ timezone: "Asia/Kolkata" }).where(eq(clinics.tenantId, IST.tenantId));
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/clinic-date.test.ts tests/integration/patients-dates.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/domain/clinic-date'`, `'@/server/services/clinic'`, and `DOB_FUTURE_MESSAGE` is not exported.

- [ ] **Step 3: Write the date module and move `clinicLocalDate` into it**

`src/lib/domain/clinic-date.ts`:

```ts
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";

/** "YYYY-MM-DD" for `at` on the calendar of `timeZone` (the clinic's own day, not UTC's). An unknown zone uses Asia/Kolkata, never UTC. */
export function clinicLocalDate(at: Date, timeZone: string | null | undefined): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The calendar date at UTC+14 (Kiribati), where each day starts first. A date after this is in the future for
 * every clinic on Earth, so validation that does not know the clinic yet can use it as a structural bound.
 */
export function latestCalendarDate(at: Date): string {
  return new Date(at.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);
}
```

In `src/server/services/render-snapshot.ts`, delete the `clinicLocalDate` function (its doc comment and body) and add after the imports:

```ts
import { clinicLocalDate } from "@/lib/domain/clinic-date";

// Moved to src/lib/domain/clinic-date.ts (Plan 1D); re-exported for existing importers.
export { clinicLocalDate };
```

Remove `DEFAULT_TIME_ZONE` and `isValidTimeZone` from its `@/lib/rx-render/format` import only if nothing else in the file uses them (`buildRenderSnapshot` still validates the clinic timezone with `isValidTimeZone`; keep what is used — `npm run lint` reports unused imports).

- [ ] **Step 4: Write the clinic service**

`src/server/services/clinic.ts`:

```ts
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";

/** The clinic's IANA timezone, always valid: a missing or damaged value reads as Asia/Kolkata. */
export async function clinicTimeZoneIn(tx: TenantTx, tenantId: string): Promise<string> {
  const clinic = await primaryClinic(tx, tenantId);
  return clinic && isValidTimeZone(clinic.timezone) ? clinic.timezone : DEFAULT_TIME_ZONE;
}

/** Any member may know the clinic's timezone: it is configuration, not patient data. */
export async function getClinicTimeZone(ctx: ServiceContext): Promise<string> {
  return withTenant(ctx.tenantId, (tx) => clinicTimeZoneIn(tx, ctx.tenantId));
}
```

- [ ] **Step 5: Validate the DOB against UTC+14 in Zod and the clinic's day in the services**

In `src/server/validation/patient.ts`, add `import { latestCalendarDate } from "@/lib/domain/clinic-date";`, export the message, and change the last refine of `isoDate`:

```ts
export const DOB_FUTURE_MESSAGE = "Date of birth cannot be in the future";
```

```ts
  // Structural bound only (no clinic known here): nothing after the latest calendar date on Earth. The services
  // apply the clinic's own day (createPatient, updatePatient, the CSV import), so a baby born today in India
  // can be registered at 00:30 IST.
  .refine((v) => v <= latestCalendarDate(new Date()), DOB_FUTURE_MESSAGE);
```

and change the doc comment above `isoDate` to `/** YYYY-MM-DD for a real calendar date between 1900-01-01 and the latest calendar date anywhere (see DOB_FUTURE_MESSAGE). */`.

In `src/server/services/patients.ts`, add the imports:

```ts
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { DOB_FUTURE_MESSAGE } from "@/server/validation/patient";
import { clinicTimeZoneIn } from "./clinic";
```

(`patientInputSchema` and `PatientInput` are already imported from `@/server/validation/patient`; merge the import lines.) Add this helper below `toColumns`:

```ts
/** A DOB after today on the clinic's own calendar is refused (the Zod bound is only UTC+14). */
async function dobInClinicFuture(tx: TenantTx, tenantId: string, dob: string | null): Promise<boolean> {
  if (!dob) return false;
  return dob > clinicLocalDate(new Date(), await clinicTimeZoneIn(tx, tenantId));
}
```

and `import type { TenantTx } from "@/server/db/tenant";` next to the `withTenant` import (`import { withTenant, type TenantTx } from "@/server/db/tenant";`). In `createPatient`, make the first statement inside `withTenant(ctx.tenantId, async (tx): Promise<CreatePatientResult> => {`:

```ts
    if (await dobInClinicFuture(tx, ctx.tenantId, columns.dob)) return fail("invalid", DOB_FUTURE_MESSAGE, "dob");
```

and in `updatePatient`, the first statement inside its `withTenant` callback:

```ts
    if (await dobInClinicFuture(tx, ctx.tenantId, next.dob)) return fail("invalid", DOB_FUTURE_MESSAGE, "dob");
```

- [ ] **Step 6: Show ages on the clinic's day and cap the date picker**

In `src/components/patients/patient-form.tsx`, add `maxDob?: string` to `Props` (doc comment: `/** Latest selectable date of birth: today on the clinic's calendar. */`), destructure it, and change the date input to:

```tsx
          <Input id="dob" name="dob" type="date" max={maxDob} defaultValue={v.dob ?? ""} {...invalidProps(state, "dob")} />
```

In `src/app/(app)/patients/new/page.tsx`, add the imports `import { clinicLocalDate } from "@/lib/domain/clinic-date";` and `import { getClinicTimeZone } from "@/server/services/clinic";`, compute `const today = clinicLocalDate(new Date(), await getClinicTimeZone(session));` after the permission check, and pass `maxDob={today}` to `PatientForm`.

In `src/app/(app)/patients/page.tsx`, add the same two imports, replace `const now = new Date();` with `const today = clinicLocalDate(new Date(), await getClinicTimeZone(session));`, and change the age cell to `{p.dob ? ageLabel(p.dob, today) || "—" : "—"}`.

In `src/app/(app)/patients/[id]/page.tsx`, add the same two imports, replace `const age = p.dob ? ageLabel(p.dob, new Date()) : "";` with:

```tsx
  const today = clinicLocalDate(new Date(), await getClinicTimeZone(session));
  const age = p.dob ? ageLabel(p.dob, today) : "";
```

and pass `maxDob={today}` to the edit `PatientForm`.

The existing test `"rejects a date of birth after today but accepts today (UTC)"` in `tests/integration/patients.test.ts` uses UTC tomorrow, which **is** today in India between 18:30 and 24:00 UTC, so it would now fail every evening. Replace it with (and add `import { clinicLocalDate } from "@/lib/domain/clinic-date";`; delete the `utcDate` helper if nothing else in the file uses it):

```ts
  it("rejects a date of birth after today on the clinic's calendar but accepts today", async () => {
    // createTestTenant's clinic uses the default zone, Asia/Kolkata.
    const today = clinicLocalDate(new Date(), "Asia/Kolkata");
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const future = await createPatient(A.as("owner"), { name: "Future Person", dob: tomorrow });
    expect(future).toMatchObject({ ok: false, code: "invalid", field: "dob" });
    expect(future.ok === false && future.message).toMatch(/future/i);

    expect((await createPatient(A.as("owner"), { name: "Newborn Person", dob: today })).ok).toBe(true);
  });
```

- [ ] **Step 7: Run the focused tests**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/clinic-date.test.ts tests/integration/patients-dates.test.ts tests/integration/patients.test.ts tests/integration/render-snapshot.test.ts tests/unit/age.test.ts
```

Expected: PASS — clinic-date 5, patients-dates 5, and the existing patients, render-snapshot and age suites with their previous counts (the frozen age still uses the clinic's day through the re-export).

- [ ] **Step 8: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/domain/clinic-date.ts src/server/services/clinic.ts src/server/services/render-snapshot.ts src/server/validation/patient.ts src/server/services/patients.ts "src/app/(app)/patients/page.tsx" "src/app/(app)/patients/[id]/page.tsx" "src/app/(app)/patients/new/page.tsx" src/components/patients/patient-form.tsx tests/unit/clinic-date.test.ts tests/integration/patients-dates.test.ts tests/integration/patients.test.ts
Set-Location E:\projects\clinicpad; git commit -m "fix(patients): date of birth and ages on the clinic's calendar, not UTC" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 4: Patient history with filters and pagination, and archive / restore

**Files:**
- Create: `src/server/services/patient-history.ts`, `src/components/patients/prescription-history.tsx`, `src/components/patients/history-filters.tsx`
- Modify: `src/server/services/patients.ts` (`getPatient` option, `searchPatients` option, `unarchivePatient`), `src/server/actions/patients.ts` (`archivePatientAction`, `restorePatientAction`), `src/app/(app)/patients/[id]/page.tsx` (full replacement below), `src/app/(app)/patients/page.tsx` (archived view and notice)
- Test: `tests/integration/patient-history.test.ts`, `tests/integration/patient-archive.test.ts`, `tests/unit/prescription-history.test.tsx`, `tests/e2e/patient-history.spec.ts`

**Interfaces:**
- Consumes: `clinicTimeZoneIn` (Task 3), `clinicLocalDate` (Task 3), `escapeLike` (`src/lib/domain/search.ts`), `cleanText`, `isUuid`, `pdfFileName({ rxNo, version, status })`, `OutputActions({ prescriptionId, fileName })`, `RepeatForm({ action })`, `repeatAction(id)` (`src/server/actions/prescriptions.ts`), `DiscardDraftForm({ action, label, warning })`, `startPrescriptionAction`, `saveDraftNow` / `finalizeNow` (`tests/helpers/rx.ts`), `archivePatient`.
- Produces:
  - `HISTORY_PAGE_SIZE = 20`; `type HistoryStatus = "draft" | "finalized" | "amended"`; `type HistoryFilters = { from?: string; to?: string; doctor?: string; status?: HistoryStatus; q?: string; offset: number }`; `parseHistoryFilters(raw: unknown): HistoryFilters`; `type HistoryRow = { id; rxNo: number | null; version: number; status: string; chiefComplaint: string | null; diagnosis: string[]; doctorName: string | null; createdAt: Date; finalizedAt: Date | null }`; `type HistoryDoctor = { id: string; name: string }`; `type HistoryPage = { rows: HistoryRow[]; hasMore: boolean; filters: HistoryFilters; doctors: HistoryDoctor[]; timeZone: string }`; `listPatientPrescriptions(ctx, patientId: string, raw: unknown): Promise<Result<HistoryPage>>` (`rx.read`; an archived patient only for `patient.archive`).
  - `getPatient(ctx, id, opts: { includeArchived?: boolean } = {})` (archived rows only when the caller may archive); `searchPatients(ctx, { q?, limit?, offset?, archived? })` (`archived: true` needs `patient.archive`, else `forbidden`); `unarchivePatient(ctx, id): Promise<Result<null>>` (audit `patient.unarchived`).
  - Actions: `type ArchiveFormState = { error?: string }`; `archivePatientAction(id: string, prev: ArchiveFormState): Promise<ArchiveFormState>` (redirects to `/patients?notice=archived`); `restorePatientAction(id: string): Promise<void>` (redirects to `/patients/<id>`, or back with `?error=<code>`).
  - `PrescriptionHistory({ patientId, page, canRepeat })`, `historyHref(patientId, filters, offset)`, `HistoryFiltersForm({ patientId, filters, doctors })`.

- [ ] **Step 1: Write the failing history test**

`tests/integration/patient-history.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics, doctors, patients, prescriptions, visits } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { amendPrescription, startPrescription } from "@/server/services/prescriptions";
import { HISTORY_PAGE_SIZE, listPatientPrescriptions, parseHistoryFilters } from "@/server/services/patient-history";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";
let secondDoctorId = "";
const ids: Record<"fever" | "migraine" | "superseded" | "current" | "other", string> = {
  fever: "",
  migraine: "",
  superseded: "",
  current: "",
  other: "",
};

async function draft(content: Record<string, unknown>): Promise<string> {
  const started = await startPrescription(A.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraftNow(A.as("doctor"), started.value.prescriptionId, content);
  if (!saved.ok) throw new Error(saved.message);
  return started.value.prescriptionId;
}

async function finalized(content: Record<string, unknown>): Promise<string> {
  const id = await draft(content);
  const done = await finalizeNow(A.as("doctor"), id);
  if (!done.ok) throw new Error(done.message);
  return id;
}

const list = (raw: unknown = {}, role = "doctor") => listPatientPrescriptions(A.as(role), patientId, raw);
const idsOf = async (raw: unknown = {}) => {
  const page = await list(raw);
  if (!page.ok) throw new Error(page.message);
  return page.value.rows.map((r) => r.id);
};

beforeAll(async () => {
  A = await createTestTenant("history-a");
  B = await createTestTenant("history-b");
  const created = await createPatient(A.as("owner"), { name: "History Patient" });
  if (!created.ok) throw new Error(created.message);
  patientId = created.value.id;

  ids.fever = await finalized({ chiefComplaint: "Fever 50% better", diagnosis: ["Viral fever"], items: [{ drugName: "Paracetamol" }] });
  // A draft from January: 2026-01-10T20:00Z is 11 January in India.
  ids.migraine = await draft({ diagnosis: ["Migraine"], items: [{ drugName: "Naproxen" }] });
  await adminDb.update(prescriptions).set({ createdAt: new Date("2026-01-10T20:00:00.000Z") }).where(eq(prescriptions.id, ids.migraine));
  // Version 1 superseded by version 2.
  ids.superseded = await finalized({ diagnosis: ["Gastritis"], items: [{ drugName: "Pantoprazole" }] });
  const amendment = await amendPrescription(A.as("doctor"), { prescriptionId: ids.superseded, reason: "Dose correction" });
  if (!amendment.ok) throw new Error(amendment.message);
  const v2 = await finalizeNow(A.as("doctor"), amendment.value.prescriptionId);
  if (!v2.ok) throw new Error(v2.message);
  ids.current = amendment.value.prescriptionId;
  // A draft opened for another doctor.
  const [second] = await adminDb.insert(doctors).values({ tenantId: A.tenantId, displayName: "Dr Second" }).returning();
  secondDoctorId = second.id;
  ids.other = await draft({ diagnosis: ["Sprain"], items: [{ drugName: "Ibuprofen" }] });
  const [otherRx] = await adminDb.select({ visitId: prescriptions.visitId }).from(prescriptions).where(eq(prescriptions.id, ids.other));
  await adminDb.update(visits).set({ doctorId: secondDoctorId }).where(eq(visits.id, otherRx.visitId));
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("listPatientPrescriptions", () => {
  it("lists every version of the patient, newest first by finalized-or-created time", async () => {
    const rows = await idsOf();
    expect(rows).toHaveLength(5);
    expect(rows.at(-1)).toBe(ids.migraine); // January
    const page = await list();
    if (!page.ok) throw new Error(page.message);
    expect(page.value.hasMore).toBe(false);
    expect(page.value.timeZone).toBe("Asia/Kolkata");
  });

  it("filters by status", async () => {
    expect(await idsOf({ status: "amended" })).toEqual([ids.superseded]);
    expect((await idsOf({ status: "finalized" })).sort()).toEqual([ids.current, ids.fever].sort());
    expect((await idsOf({ status: "draft" })).sort()).toEqual([ids.migraine, ids.other].sort());
  });

  it("filters by the visit's doctor and lists each doctor once", async () => {
    expect(await idsOf({ doctor: secondDoctorId })).toEqual([ids.other]);
    const page = await list();
    if (!page.ok) throw new Error(page.message);
    expect(page.value.doctors.map((d) => d.name)).toContain("Dr Second");
    expect(new Set(page.value.doctors.map((d) => d.id)).size).toBe(page.value.doctors.length);
  });

  it("finds text in the diagnosis or the chief complaint, with wildcards taken literally", async () => {
    expect(await idsOf({ q: "viral" })).toEqual([ids.fever]);
    expect(await idsOf({ q: "50%" })).toEqual([ids.fever]);
    expect(await idsOf({ q: "%" })).toEqual([ids.fever]);
    expect(await idsOf({ q: "_" })).toEqual([]);
    expect(await idsOf({ q: "gastr" })).toEqual(expect.arrayContaining([ids.superseded, ids.current]));
  });

  it("uses the clinic's calendar days for date filters", async () => {
    expect(await idsOf({ from: "2026-01-11", to: "2026-01-11" })).toEqual([ids.migraine]);
    expect(await idsOf({ from: "2026-01-10", to: "2026-01-10" })).toEqual([]);
    await adminDb.update(clinics).set({ timezone: "UTC" }).where(eq(clinics.tenantId, A.tenantId));
    try {
      expect(await idsOf({ from: "2026-01-10", to: "2026-01-10" })).toEqual([ids.migraine]);
    } finally {
      await adminDb.update(clinics).set({ timezone: "Asia/Kolkata" }).where(eq(clinics.tenantId, A.tenantId));
    }
  });

  it("swaps a reversed range and ignores malformed values instead of failing", async () => {
    expect(await idsOf({ from: "2026-01-12", to: "2026-01-11" })).toEqual([ids.migraine]);
    expect(parseHistoryFilters({ from: "2026-13-45", to: "yesterday", status: "void", doctor: "nope", q: ["fever", "x"], offset: "-1" })).toEqual({
      from: undefined,
      to: undefined,
      doctor: undefined,
      status: undefined,
      q: "fever",
      offset: 0,
    });
    expect((await idsOf({ status: "void", offset: "abc" })).length).toBe(5);
  });

  it("pages through more than one page with no row repeated or skipped", async () => {
    for (let i = 0; i < HISTORY_PAGE_SIZE; i += 1) await draft({ items: [{ drugName: `Page drug ${i}` }] });
    const first = await list();
    const second = await list({ offset: String(HISTORY_PAGE_SIZE) });
    if (!first.ok || !second.ok) throw new Error("list failed");
    expect(first.value.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.value.hasMore).toBe(true);
    expect(second.value.rows).toHaveLength(5);
    expect(second.value.hasMore).toBe(false);
    const all = [...first.value.rows, ...second.value.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(HISTORY_PAGE_SIZE + 5);
  });

  it("is refused to roles without rx.read and never shows another clinic's patient", async () => {
    expect(await list({}, "accountant")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await list({}, "reception")).toMatchObject({ ok: true });
    expect(await listPatientPrescriptions(B.as("owner"), patientId, {})).toMatchObject({ ok: false, code: "not_found" });
    expect(await listPatientPrescriptions(A.as("doctor"), "not-a-uuid", {})).toMatchObject({ ok: false, code: "not_found" });
  });

  it("shows an archived patient's history only to the owner", async () => {
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, patientId));
    try {
      expect(await list({}, "doctor")).toMatchObject({ ok: false, code: "not_found" });
      expect(await list({}, "owner")).toMatchObject({ ok: true });
    } finally {
      await adminDb.update(patients).set({ deletedAt: null }).where(eq(patients.id, patientId));
    }
  });
});
```

`tests/integration/patient-archive.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents } from "@/server/db/schema";
import { archivePatient, createPatient, getPatient, searchPatients, unarchivePatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

async function patient(name: string): Promise<string> {
  const created = await createPatient(A.as("reception"), { name });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

beforeAll(async () => {
  A = await createTestTenant("archive-a");
  B = await createTestTenant("archive-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("archive and restore", () => {
  it("hides an archived patient from search and getPatient, except in the owner's archived view", async () => {
    const id = await patient("Archive Hidden");
    expect(await archivePatient(A.as("owner"), id)).toEqual({ ok: true, value: null });
    const active = await searchPatients(A.as("reception"), { q: "Archive Hidden" });
    expect(active.ok && active.value.map((p) => p.id)).toEqual([]);
    expect(await getPatient(A.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPatient(A.as("doctor"), id, { includeArchived: true })).toMatchObject({ ok: false, code: "not_found" });
    const owner = await getPatient(A.as("owner"), id, { includeArchived: true });
    expect(owner.ok && owner.value.deletedAt).toBeInstanceOf(Date);
    const archived = await searchPatients(A.as("owner"), { q: "Archive Hidden", archived: true });
    expect(archived.ok && archived.value.map((p) => p.id)).toEqual([id]);
  });

  it("lists archived patients only for roles that may archive", async () => {
    for (const role of ["doctor", "reception", "nurse"]) {
      expect(await searchPatients(A.as(role), { archived: true })).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("lets only the owner archive or restore", async () => {
    const id = await patient("Archive Roles");
    for (const role of ["doctor", "reception", "nurse", "pharmacist", "accountant"]) {
      expect(await archivePatient(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
    }
    await archivePatient(A.as("owner"), id);
    for (const role of ["doctor", "reception", "nurse"]) {
      expect(await unarchivePatient(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("restores a patient, audits both events with ids only, and allows new prescriptions again", async () => {
    const id = await patient("Archive Restore");
    await archivePatient(A.as("owner"), id);
    expect(await startPrescription(A.as("doctor"), { patientId: id })).toMatchObject({ ok: false, code: "not_found" });
    expect(await unarchivePatient(A.as("owner"), id)).toEqual({ ok: true, value: null });
    expect(await getPatient(A.as("doctor"), id)).toMatchObject({ ok: true });
    expect(await startPrescription(A.as("doctor"), { patientId: id })).toMatchObject({ ok: true });
    const events = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.entityId, id)));
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["patient.archived", "patient.unarchived"]));
    const restored = events.find((e) => e.action === "patient.unarchived");
    expect(JSON.stringify(restored)).not.toContain("Archive Restore");
  });

  it("answers not_found for restoring an active patient, a malformed id, or another clinic's patient", async () => {
    const id = await patient("Archive Active");
    expect(await unarchivePatient(A.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await unarchivePatient(A.as("owner"), "x")).toMatchObject({ ok: false, code: "not_found" });
    await archivePatient(A.as("owner"), id);
    expect(await unarchivePatient(B.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await archivePatient(A.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/patient-history.test.ts tests/integration/patient-archive.test.ts
```

Expected: FAIL — `Cannot find module '@/server/services/patient-history'` and `unarchivePatient` is not exported.

- [ ] **Step 3: Write the history service**

`src/server/services/patient-history.ts`:

```ts
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { escapeLike } from "@/lib/domain/search";
import { cleanText } from "@/lib/domain/text";
import { fail, ok, type Result } from "@/lib/result";
import { doctors, patients, prescriptions, visits } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { clinicTimeZoneIn } from "./clinic";
import type { ServiceContext } from "./context";

export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_STATUSES = ["draft", "finalized", "amended"] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];
export type HistoryFilters = { from?: string; to?: string; doctor?: string; status?: HistoryStatus; q?: string; offset: number };
export type HistoryRow = {
  id: string;
  rxNo: number | null;
  version: number;
  status: string;
  chiefComplaint: string | null;
  diagnosis: string[];
  doctorName: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
};
export type HistoryDoctor = { id: string; name: string };
export type HistoryPage = { rows: HistoryRow[]; hasMore: boolean; filters: HistoryFilters; doctors: HistoryDoctor[]; timeZone: string };

const MAX_OFFSET = 10_000;
const MAX_QUERY = 60;
/** A repeated query parameter arrives as an array: use the first value. */
const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
const realDay = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= "1900-01-01" && v <= "2100-12-31";
};
const day = z.preprocess(first, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDay).optional()).catch(undefined);

/** URL filters. A malformed value is ignored (treated as absent), never an error: these come from the address bar. */
const historyFiltersSchema = z.object({
  from: day,
  to: day,
  doctor: z.preprocess(first, z.string().refine(isUuid).optional()).catch(undefined),
  status: z.preprocess(first, z.enum(HISTORY_STATUSES).optional()).catch(undefined),
  // cleanText is the search-term cleaner (it removes NUL and controls; a search term is not stored).
  q: z.preprocess(first, z.string().transform((v) => cleanText(v).trim().slice(0, MAX_QUERY)).optional()).catch(undefined),
  offset: z.preprocess(first, z.coerce.number().int().min(0).max(MAX_OFFSET).optional()).catch(undefined),
});

export function parseHistoryFilters(raw: unknown): HistoryFilters {
  const parsed = historyFiltersSchema.safeParse(raw !== null && typeof raw === "object" ? raw : {});
  const f = parsed.success ? parsed.data : {};
  let from = f.from;
  let to = f.to;
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to, doctor: f.doctor, status: f.status, q: f.q ? f.q : undefined, offset: f.offset ?? 0 };
}

/**
 * One patient's prescriptions, every version, newest first by finalize time (drafts by creation time), filtered and
 * paginated. Date filters are calendar days in the clinic's timezone. An archived patient is visible only to roles
 * that may archive (the owner), like getPatient.
 */
export async function listPatientPrescriptions(ctx: ServiceContext, patientId: string, raw: unknown): Promise<Result<HistoryPage>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(patientId)) return fail("not_found", "Patient not found.");
  const filters = parseHistoryFilters(raw);

  return withTenant(ctx.tenantId, async (tx): Promise<Result<HistoryPage>> => {
    const [patient] = await tx
      .select({ id: patients.id, deletedAt: patients.deletedAt })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, patientId)))
      .limit(1);
    if (!patient || (patient.deletedAt !== null && !can(ctx.role, "patient.archive"))) return fail("not_found", "Patient not found.");

    const timeZone = await clinicTimeZoneIn(tx, ctx.tenantId);
    const when = sql`coalesce(${prescriptions.finalizedAt}, ${prescriptions.createdAt})`;
    const conditions: SQL[] = [eq(prescriptions.tenantId, ctx.tenantId), eq(visits.patientId, patientId)];
    // Local midnight of the day, as an instant: (date)::timestamp AT TIME ZONE zone.
    if (filters.from) conditions.push(sql`${when} >= (${filters.from}::date)::timestamp at time zone ${timeZone}`);
    if (filters.to) conditions.push(sql`${when} < ((${filters.to}::date) + 1)::timestamp at time zone ${timeZone}`);
    if (filters.doctor) conditions.push(eq(visits.doctorId, filters.doctor));
    if (filters.status) conditions.push(eq(prescriptions.status, filters.status));
    if (filters.q) {
      const pattern = `%${escapeLike(filters.q)}%`;
      conditions.push(or(ilike(visits.chiefComplaint, pattern), sql`array_to_string(${visits.diagnosis}, ' ') ilike ${pattern}`) as SQL);
    }

    const rows = await tx
      .select({
        id: prescriptions.id,
        rxNo: prescriptions.rxNo,
        version: prescriptions.version,
        status: prescriptions.status,
        chiefComplaint: visits.chiefComplaint,
        diagnosis: visits.diagnosis,
        doctorName: doctors.displayName,
        createdAt: prescriptions.createdAt,
        finalizedAt: prescriptions.finalizedAt,
      })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .leftJoin(doctors, eq(doctors.id, visits.doctorId))
      .where(and(...conditions))
      // Total order, so offset pages never repeat or skip a row.
      .orderBy(desc(when), desc(prescriptions.id))
      .limit(HISTORY_PAGE_SIZE + 1)
      .offset(filters.offset);

    const doctorRows = await tx
      .selectDistinct({ id: doctors.id, name: doctors.displayName })
      .from(visits)
      .innerJoin(doctors, eq(doctors.id, visits.doctorId))
      .where(and(eq(visits.tenantId, ctx.tenantId), eq(visits.patientId, patientId)));

    return ok({
      rows: rows.slice(0, HISTORY_PAGE_SIZE).map((r) => ({ ...r, diagnosis: r.diagnosis ?? [] })),
      hasMore: rows.length > HISTORY_PAGE_SIZE,
      filters,
      doctors: doctorRows
        .map((d) => ({ id: d.id, name: d.name?.trim() ? d.name.trim() : "Doctor without a printed name" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      timeZone,
    });
  });
}
```

- [ ] **Step 4: Extend the patient service with the archived view and restore**

In `src/server/services/patients.ts`, add `isNotNull` to the `drizzle-orm` import. Replace `searchPatients`' signature and its `conditions` line with:

```ts
export async function searchPatients(
  ctx: ServiceContext,
  opts: { q?: string; limit?: number; offset?: number; archived?: boolean } = {},
): Promise<Result<PatientListItem[]>> {
  if (!can(ctx.role, "patient.read")) return fail("forbidden", "You cannot view patients.");
  // The archived list is the owner's restore screen (patient.archive).
  if (opts.archived && !can(ctx.role, "patient.archive")) return fail("forbidden", "Only the clinic owner can see archived patients.");
```

and

```ts
  const conditions = [opts.archived ? isNotNull(patients.deletedAt) : isNull(patients.deletedAt)];
```

(keep the rest of the function; for the archived list the empty-query order stays newest first). Add to the doc comment: `` * - `archived: true` lists archived patients instead (owner only). ``

Replace `getPatient` with:

```ts
/** An active patient; with includeArchived, also an archived one, but only for roles that may archive (the owner). */
export async function getPatient(
  ctx: ServiceContext,
  id: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Result<PatientRecord>> {
  if (!can(ctx.role, "patient.read")) return fail("forbidden", "You cannot view patients.");
  if (!isUuid(id)) return notFound();
  const withArchived = opts.includeArchived === true && can(ctx.role, "patient.archive");
  const [row] = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select()
      .from(patients)
      .where(withArchived ? eq(patients.id, id) : and(eq(patients.id, id), isNull(patients.deletedAt)))
      .limit(1),
  );
  return row ? ok(row) : notFound();
}
```

and add after `archivePatient`:

```ts
/** Brings an archived patient back into search and the active list. Owner only (patient.archive). */
export async function unarchivePatient(ctx: ServiceContext, id: string): Promise<Result<null>> {
  if (!can(ctx.role, "patient.archive")) return fail("forbidden", "Only the clinic owner can restore patients.");
  if (!isUuid(id)) return notFound();
  return withTenant(ctx.tenantId, async (tx) => {
    const restored = await tx
      .update(patients)
      .set({ deletedAt: null })
      .where(and(eq(patients.id, id), isNotNull(patients.deletedAt)))
      .returning({ id: patients.id });
    if (restored.length === 0) return notFound();
    await recordAudit(tx, ctx, { action: "patient.unarchived", entityType: "patient", entityId: id });
    return ok(null);
  });
}
```

- [ ] **Step 5: Run the service tests**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/patient-history.test.ts tests/integration/patient-archive.test.ts tests/integration/patients.test.ts
```

Expected: PASS — patient-history 9, patient-archive 5, patients unchanged.

- [ ] **Step 6: Write the failing component test**

`tests/unit/prescription-history.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/components/rx/output-actions", () => ({
  OutputActions: ({ fileName }: { fileName: string }) => <div data-testid="output-actions">{fileName}</div>,
}));
vi.mock("@/components/rx/repeat-form", () => ({ RepeatForm: () => <div data-testid="repeat" /> }));
vi.mock("@/server/actions/prescriptions", () => ({ repeatAction: vi.fn() }));

import { PrescriptionHistory, historyHref } from "@/components/patients/prescription-history";
import type { HistoryPage, HistoryRow } from "@/server/services/patient-history";

const row = (overrides: Partial<HistoryRow>): HistoryRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  rxNo: 7,
  version: 1,
  status: "finalized",
  chiefComplaint: "Fever",
  diagnosis: ["Viral fever"],
  doctorName: "Dr Shah",
  createdAt: new Date("2026-11-16T18:00:00.000Z"),
  finalizedAt: new Date("2026-11-16T19:00:00.000Z"),
  ...overrides,
});

const page = (overrides: Partial<HistoryPage> = {}): HistoryPage => ({
  rows: [],
  hasMore: false,
  filters: { offset: 0 },
  doctors: [{ id: "00000000-0000-4000-8000-0000000000d1", name: "Dr Shah" }],
  timeZone: "Asia/Kolkata",
  ...overrides,
});

describe("PrescriptionHistory", () => {
  it("says there are none yet, or that none match the filters with a way back", () => {
    const first = render(<PrescriptionHistory patientId="p1" page={page()} canRepeat />);
    expect(screen.getByText("No prescriptions yet.")).toBeInTheDocument();
    first.unmount();
    render(<PrescriptionHistory patientId="p1" page={page({ filters: { status: "amended", offset: 0 } })} canRepeat />);
    expect(screen.getByText("No prescriptions match these filters.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/patients/p1");
  });

  it("offers print and download for signed versions, and repeat only for the current version to prescribers", () => {
    const rows = [
      row({ id: "00000000-0000-4000-8000-00000000000a", status: "finalized", version: 2 }),
      row({ id: "00000000-0000-4000-8000-00000000000b", status: "amended" }),
      row({ id: "00000000-0000-4000-8000-00000000000c", status: "draft", rxNo: null, finalizedAt: null }),
    ];
    const view = render(<PrescriptionHistory patientId="p1" page={page({ rows })} canRepeat />);
    const items = view.getAllByRole("listitem");
    expect(within(items[0]).getByRole("link", { name: "Rx #7 v2" })).toHaveAttribute("href", `/prescriptions/${rows[0].id}`);
    expect(within(items[0]).getByTestId("output-actions")).toHaveTextContent("Rx-7-v2.pdf");
    expect(within(items[0]).getByTestId("repeat")).toBeInTheDocument();
    expect(within(items[1]).getByText("Superseded")).toBeInTheDocument();
    expect(within(items[1]).queryByTestId("repeat")).toBeNull();
    expect(within(items[2]).getByRole("link", { name: "Draft" })).toBeInTheDocument();
    expect(within(items[2]).queryByTestId("output-actions")).toBeNull();
    view.unmount();
    render(<PrescriptionHistory patientId="p1" page={page({ rows: [rows[0]] })} canRepeat={false} />);
    expect(screen.queryByTestId("repeat")).toBeNull();
  });

  it("shows dates on the clinic's calendar", () => {
    render(<PrescriptionHistory patientId="p1" page={page({ rows: [row({})] })} canRepeat />);
    // 2026-11-16T19:00Z is 17 November in India.
    expect(screen.getByText("17 Nov 2026")).toBeInTheDocument();
  });

  it("keeps the filters in the pagination links and echoes them in the form", () => {
    const filters = { status: "finalized" as const, q: "fever", from: "2026-11-01", offset: 20 };
    render(<PrescriptionHistory patientId="p1" page={page({ rows: [row({})], hasMore: true, filters })} canRepeat />);
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("href", "/patients/p1?from=2026-11-01&status=finalized&q=fever&offset=40");
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute("href", "/patients/p1?from=2026-11-01&status=finalized&q=fever");
    expect(screen.getByLabelText("Diagnosis or complaint")).toHaveValue("fever");
    expect(screen.getByLabelText("Status")).toHaveValue("finalized");
  });

  it("builds hrefs with only the set filters", () => {
    expect(historyHref("p1", { offset: 0 }, 0)).toBe("/patients/p1");
    expect(historyHref("p1", { doctor: "d", q: "a&b", offset: 0 }, 20)).toBe("/patients/p1?doctor=d&q=a%26b&offset=20");
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/prescription-history.test.tsx` — expected: FAIL, module not found.

- [ ] **Step 7: Write the two components**

`src/components/patients/history-filters.tsx`:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HistoryDoctor, HistoryFilters } from "@/server/services/patient-history";

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

/** A plain GET form: filters live in the URL, so they survive reloads and can be shared inside the clinic. */
export function HistoryFiltersForm({ patientId, filters, doctors }: { patientId: string; filters: HistoryFilters; doctors: HistoryDoctor[] }) {
  return (
    <form method="get" action={`/patients/${patientId}`} aria-label="Filter prescriptions" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3 lg:grid-cols-6">
      <div className="space-y-1">
        <Label htmlFor="history-from">From</Label>
        <Input id="history-from" name="from" type="date" defaultValue={filters.from ?? ""} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="history-to">To</Label>
        <Input id="history-to" name="to" type="date" defaultValue={filters.to ?? ""} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="history-doctor">Doctor</Label>
        <select id="history-doctor" name="doctor" defaultValue={filters.doctor ?? ""} className={selectClass}>
          <option value="">Any doctor</option>
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="history-status">Status</Label>
        <select id="history-status" name="status" defaultValue={filters.status ?? ""} className={selectClass}>
          <option value="">Any status</option>
          <option value="finalized">Finalized</option>
          <option value="amended">Superseded</option>
          <option value="draft">Draft</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="history-q">Diagnosis or complaint</Label>
        <Input id="history-q" name="q" defaultValue={filters.q ?? ""} maxLength={60} />
      </div>
      <div className="flex items-end gap-3">
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Link className="pb-2 text-sm underline" href={`/patients/${patientId}`}>
          Clear
        </Link>
      </div>
    </form>
  );
}
```

`src/components/patients/prescription-history.tsx`:

```tsx
import Link from "next/link";
import { pdfFileName } from "@/lib/rx-render/format";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import type { HistoryFilters, HistoryPage, HistoryRow } from "@/server/services/patient-history";
import { HISTORY_PAGE_SIZE } from "@/server/services/patient-history";
import { repeatAction } from "@/server/actions/prescriptions";
import { OutputActions } from "@/components/rx/output-actions";
import { RepeatForm } from "@/components/rx/repeat-form";
import { Button } from "@/components/ui/button";
import { HistoryFiltersForm } from "./history-filters";

type Props = { patientId: string; page: HistoryPage; canRepeat: boolean };

const STATUS_TEXT: Record<string, string> = { draft: "Draft", finalized: "Finalized", amended: "Superseded" };

/** The patient page URL for these filters at `offset` (only set filters are written). */
export function historyHref(patientId: string, filters: HistoryFilters, offset: number): string {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "doctor", "status", "q"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `/patients/${patientId}?${query}` : `/patients/${patientId}`;
}

function label(row: HistoryRow): string {
  if (row.status === "draft") return row.version > 1 ? `Draft amendment (v${row.version})` : "Draft";
  return `Rx #${row.rxNo ?? "?"}${row.version > 1 ? ` v${row.version}` : ""}`;
}

function dateText(row: HistoryRow, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(row.finalizedAt ?? row.createdAt);
}

/** One patient's prescriptions: filters, the list with Open / Print / Download / Repeat, and pagination. */
export function PrescriptionHistory({ patientId, page, canRepeat }: Props) {
  const { rows, hasMore, filters, doctors, timeZone } = page;
  const filtered = Boolean(filters.from || filters.to || filters.doctor || filters.status || filters.q);
  const empty = filtered ? "No prescriptions match these filters." : filters.offset > 0 ? "No more prescriptions." : "No prescriptions yet.";

  return (
    <section className="space-y-3" aria-labelledby="history-heading">
      <h2 id="history-heading" className="font-medium">
        Prescriptions
      </h2>
      <HistoryFiltersForm patientId={patientId} filters={filters} doctors={doctors} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {empty}{" "}
          {filtered ? (
            <Link className="underline" href={`/patients/${patientId}`}>
              Clear filters
            </Link>
          ) : null}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r.id} className="space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link className="font-medium underline-offset-2 hover:underline" href={`/prescriptions/${r.id}`}>
                  {label(r)}
                </Link>
                <span className="text-muted-foreground">{dateText(r, timeZone)}</span>
                <span className="rounded bg-muted px-2 py-0.5 text-xs">{STATUS_TEXT[r.status] ?? r.status}</span>
              </div>
              <p className="text-muted-foreground">
                {[r.doctorName, r.diagnosis.slice(0, 3).join(", ") || null, r.chiefComplaint].filter(Boolean).join(" · ")}
              </p>
              {r.status !== "draft" ? (
                <div className="flex flex-wrap items-start gap-3">
                  <OutputActions prescriptionId={r.id} fileName={pdfFileName(r)} />
                  {canRepeat && r.status === "finalized" ? <RepeatForm action={repeatAction.bind(null, r.id)} /> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {filters.offset > 0 || hasMore ? (
        <nav aria-label="Prescription pages" className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{rows.length > 0 ? `Showing ${filters.offset + 1}-${filters.offset + rows.length}` : ""}</span>
          <span className="flex gap-2">
            {filters.offset > 0 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={historyHref(patientId, filters, Math.max(0, filters.offset - HISTORY_PAGE_SIZE))}>Previous</Link>
              </Button>
            ) : null}
            {hasMore ? (
              <Button asChild variant="outline" size="sm">
                <Link href={historyHref(patientId, filters, filters.offset + HISTORY_PAGE_SIZE)}>Next</Link>
              </Button>
            ) : null}
          </span>
        </nav>
      ) : null}
    </section>
  );
}
```

(Merge the two `@/lib/rx-render/format` imports into one line, and the two `patient-history` imports into one, when you write the file.)

- [ ] **Step 8: Add the archive and restore actions**

In `src/server/actions/patients.ts`, change the services import to `import { archivePatient, createPatient, unarchivePatient, updatePatient, type DuplicateCandidate } from "@/server/services/patients";` and append:

```ts
export type ArchiveFormState = { error?: string };

/** Archives a patient after the owner confirmed it in the inline confirm form. */
export async function archivePatientAction(id: string, _prev: ArchiveFormState): Promise<ArchiveFormState> {
  void _prev; // useActionState passes the previous state first; it is not needed here.
  const session = await requireSession();
  const result = await archivePatient(session, id);
  if (!result.ok) return { error: result.code === "not_found" ? "This patient was changed or archived elsewhere." : result.message };
  redirect("/patients?notice=archived");
}

/** Restores an archived patient (a plain form button; failures come back as ?error=<code>). */
export async function restorePatientAction(id: string): Promise<void> {
  const session = await requireSession();
  const result = await unarchivePatient(session, id);
  if (!result.ok) redirect(`/patients/${encodeURIComponent(id)}?error=${result.code}`);
  redirect(`/patients/${encodeURIComponent(id)}`);
}
```

- [ ] **Step 9: Replace the patient page**

`src/app/(app)/patients/[id]/page.tsx` (full replacement; it keeps Task 3's clinic-day age and `maxDob`):

```tsx
import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ageLabel } from "@/lib/domain/age";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { getPatient } from "@/server/services/patients";
import { getClinicTimeZone } from "@/server/services/clinic";
import { listPatientPrescriptions } from "@/server/services/patient-history";
import { archivePatientAction, restorePatientAction, updatePatientAction } from "@/server/actions/patients";
import { startPrescriptionAction } from "@/server/actions/prescriptions";
import { PatientForm } from "@/components/patients/patient-form";
import { AllergyBanner } from "@/components/patients/allergy-banner";
import { PrescriptionHistory } from "@/components/patients/prescription-history";
import { DiscardDraftForm } from "@/components/rx/discard-draft-form";
import { RedirectError } from "@/components/rx/redirect-error";
import { SubmitButton } from "@/components/rx/submit-button";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const firstOf = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function PatientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const session = await requireSession();
  if (!can(session.role, "patient.read")) redirect("/dashboard");

  const { id } = await params;
  const search = await searchParams;
  const canArchive = can(session.role, "patient.archive");
  const result = await getPatient(session, id, { includeArchived: canArchive });
  if (!result.ok) notFound();
  const p = result.value;
  const archived = p.deletedAt !== null;
  const timeZone = await getClinicTimeZone(session);
  const today = clinicLocalDate(new Date(), timeZone);
  const age = p.dob ? ageLabel(p.dob, today) : "";
  const canWrite = can(session.role, "patient.write") && !archived;
  const history = can(session.role, "rx.read") ? await listPatientPrescriptions(session, p.id, search) : null;

  return (
    <div className="space-y-6">
      <RedirectError code={firstOf(search.error)} />
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[p.patientNo ? `Patient #${p.patientNo}` : null, age, p.gender && p.gender !== "unknown" ? p.gender : null, p.phone]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {archived ? (
          <div role="note" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <p>
              Archived on {clinicLocalDate(p.deletedAt as Date, timeZone)}. This patient is hidden from search and cannot get new
              prescriptions. Their records are kept.
            </p>
            <form action={restorePatientAction.bind(null, p.id)} className="mt-2">
              <SubmitButton variant="outline">Restore patient</SubmitButton>
            </form>
          </div>
        ) : null}
        <AllergyBanner allergies={p.allergies} />
        {!archived && can(session.role, "rx.draft") ? (
          <form action={startPrescriptionAction.bind(null, p.id)}>
            <SubmitButton>New prescription</SubmitButton>
          </form>
        ) : null}
      </header>

      {canWrite ? (
        <section className="space-y-3">
          <h2 className="font-medium">Details</h2>
          <PatientForm
            action={updatePatientAction.bind(null, p.id)}
            submitLabel="Save changes"
            maxDob={today}
            initial={{
              name: p.name,
              phone: p.phone ?? "",
              gender: p.gender ?? "unknown",
              dob: p.dob ?? "",
              address: p.address ?? "",
              allergies: (p.allergies ?? []).join(", "),
              notes: p.notes ?? "",
            }}
          />
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="font-medium">Details</h2>
          <dl className="grid max-w-xl gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Date of birth</dt>
            <dd>{p.dob ? `${p.dob}${age ? ` (${age})` : ""}` : "—"}</dd>
            <dt className="text-muted-foreground">Address</dt>
            <dd>{p.address || "—"}</dd>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-wrap">{p.notes || "—"}</dd>
          </dl>
        </section>
      )}

      {history?.ok ? <PrescriptionHistory patientId={p.id} page={history.value} canRepeat={!archived && can(session.role, "rx.draft")} /> : null}

      {canArchive && !archived ? (
        <section className="space-y-2 border-t pt-4">
          <DiscardDraftForm
            action={archivePatientAction.bind(null, p.id)}
            label="Archive patient"
            warning="The patient is hidden from search and cannot get new prescriptions. Every record is kept, and you can restore the patient later from Show archived on the Patients page."
          />
        </section>
      ) : null}
    </div>
  );
}
```

(`DiscardDraftForm` is the generic inline confirm: its button reads "Yes, archive patient" and the safe choice "Keep it" gets focus.)

- [ ] **Step 10: Add the archived view and the notice to the Patients page**

In `src/app/(app)/patients/page.tsx`:
- add `archived?: RawParam; notice?: RawParam` to the `searchParams` type;
- after `const offset = parseOffset(params.offset);` add `const showArchived = firstParam(params.archived) === "1" && can(session.role, "patient.archive");`;
- pass `archived: showArchived` to `searchPatients(session, { q, limit: PAGE_SIZE + 1, offset, archived: showArchived })`;
- change `pageHref` to take and keep the flag:

```ts
function pageHref(q: string | undefined, offset: number, archived: boolean): string {
  const params = new URLSearchParams();
  if (archived) params.set("archived", "1");
  if (q) params.set("q", q);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query ? `/patients?${query}` : "/patients";
}
```

  and pass `showArchived` in both `pageHref(...)` calls;
- change the heading to `{showArchived ? "Archived patients" : "Patients"}`, and next to the New patient button add, for owners:

```tsx
        {can(session.role, "patient.archive") ? (
          <Link className="text-sm underline" href={showArchived ? "/patients" : "/patients?archived=1"}>
            {showArchived ? "Back to the active list" : "Show archived"}
          </Link>
        ) : null}
```

- inside the search form add `{showArchived ? <input type="hidden" name="archived" value="1" /> : null}`;
- above the error line add:

```tsx
      {firstParam(params.notice) === "archived" ? (
        <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">
          Patient archived. The owner can restore them from Show archived.
        </p>
      ) : null}
```

- in the empty state, use `"No archived patients."` when `showArchived` and nothing matched.

- [ ] **Step 11: Write the e2e flow**

`tests/e2e/patient-history.spec.ts`:

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

async function newDraft(page: Page, patientUrl: string): Promise<void> {
  await page.goto(patientUrl);
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await waitForEditor(page);
}

test("filter a patient's prescriptions, repeat from the list, archive and restore", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "history"));
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Meena History");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Meena History" })).toBeVisible();
  const patientUrl = page.url();

  // One finalized prescription and one draft.
  await newDraft(page, patientUrl);
  await page.getByLabel("Medicine name").first().fill("Paracetamol");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible({ timeout: 15_000 });
  await newDraft(page, patientUrl);

  await page.goto(patientUrl);
  const history = page.getByRole("region", { name: "Prescriptions" });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await history.getByLabel("Status").selectOption("finalized");
  await history.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/status=finalized/);
  await expect(history.getByRole("listitem")).toHaveCount(1);
  await expect(history.getByRole("link", { name: "Rx #1" })).toBeVisible();
  await expect(history.getByRole("button", { name: "Print" })).toBeVisible();

  // Repeat from the list opens a new draft.
  await history.getByRole("button", { name: /repeat as new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();

  // Archive: gone from the list, back through Show archived.
  await page.goto(patientUrl);
  await page.getByRole("button", { name: "Archive patient" }).click();
  await page.getByRole("button", { name: "Yes, archive patient" }).click();
  await expect(page).toHaveURL(/\/patients\?notice=archived/);
  await expect(page.getByText("Patient archived.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Meena History" })).toHaveCount(0);
  await page.getByRole("link", { name: "Show archived" }).click();
  await page.getByRole("link", { name: "Meena History" }).click();
  await expect(page.getByText(/^Archived on/)).toBeVisible();
  await expect(page.getByRole("button", { name: /new prescription/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore patient" }).click();
  await expect(page.getByRole("button", { name: /new prescription/i })).toBeVisible();
});
```

- [ ] **Step 12: Run the focused tests, then the full suite, and commit**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/prescription-history.test.tsx tests/integration/patient-history.test.ts tests/integration/patient-archive.test.ts
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/patient-history.spec.ts tests/e2e/patients.spec.ts
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/services/patient-history.ts src/server/services/patients.ts src/server/actions/patients.ts src/components/patients/prescription-history.tsx src/components/patients/history-filters.tsx "src/app/(app)/patients/[id]/page.tsx" "src/app/(app)/patients/page.tsx" tests/integration/patient-history.test.ts tests/integration/patient-archive.test.ts tests/unit/prescription-history.test.tsx tests/e2e/patient-history.spec.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(patients): prescription history with filters and pages, archive and restore" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: unit 5 and integration 14 new tests pass; both e2e specs pass (patients 5, patient-history 1); lint, typecheck and the suite are clean.

---

## Task 5: CSV primitives (pure) — decoding, delimiters, Excel row numbers, formula-safe output, patient column mapping, and Excel cell repairs

**Files:**
- Modify: `src/lib/csv.ts` (delimiter option, `parseCsvRows` with row numbers, `detectDelimiter`, `csvCell`, `serializeCsv`), `src/lib/domain/phone.ts` (`tel:`, format characters, `+00`)
- Create: `src/lib/import/decode.ts`, `src/lib/import/patient-columns.ts`, `src/lib/import/patient-rows.ts`, `sample_data/patients_template.csv` (generated in Step 6)
- Test: `tests/unit/csv.test.ts` (appended), `tests/unit/phone.test.ts` (appended), `tests/unit/csv-decode.test.ts`, `tests/unit/patient-import-rows.test.ts`

**Interfaces:**
- Consumes: nothing new (pure modules; `zod` only).
- Produces:
  - `src/lib/csv.ts`: `type CsvDelimiter = "," | ";" | "\t"`; `type CsvRecord = { row: number; cells: string[] }` (`row` is the 1-based spreadsheet row the record starts on; blank lines count, a quoted line break does not); `parseCsvRows(text, opts?: { delimiter?: CsvDelimiter }): CsvRecord[]`; `parseCsv(text, opts?)` (unchanged results for commas); `detectDelimiter(text): CsvDelimiter`; `csvCell(value: string): string`; `serializeCsv(rows: readonly (readonly string[])[]): string` (UTF-8 BOM, CRLF, formula cells neutralised).
  - `src/lib/import/decode.ts`: `type DecodedCsv = { ok: true; text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" } | { ok: false; message: string }`; `decodeCsvBytes(bytes: Uint8Array): DecodedCsv`; `DECODE_MESSAGES`.
  - `src/lib/import/patient-columns.ts`: `IMPORT_FIELDS = ["name","phone","dob","gender","address","allergies","notes"] as const`; `type ImportField`; `type ColumnMapping = Record<ImportField, number | null>`; `IMPORT_FIELD_LABELS`; `headerKey(header)`; `suggestMapping(headers): ColumnMapping`; `ageColumns(headers, mapping): string[]`; `checkMapping(raw: unknown, headerCount: number): { ok: true; mapping: ColumnMapping } | { ok: false; message: string }`; `PATIENT_TEMPLATE_ROWS`.
  - `src/lib/import/patient-rows.ts`: `IMPORT_LIMITS = { maxBytes: 1_000_000, maxRows: 5_000, maxColumns: 40, maxCellChars: 2_000 }`; `IMPORT_MESSAGES`; `type ImportTable = { headers: string[]; rows: CsvRecord[]; delimiter: CsvDelimiter }`; `parseImportTable(text): { ok: true; table: ImportTable } | { ok: false; message: string }`; `type CellResult = { ok: true; value: string } | { ok: false; message: string }`; `dateCell`, `phoneCell`, `genderCell`; `type RawPatientRow = Record<ImportField, string>`; `rowValues(cells, mapping): { ok: true; values: RawPatientRow } | { ok: false; field: ImportField; message: string }`.
  - `normalizePhone` also accepts `tel:` prefixes, Unicode format characters (bidi marks, zero-width), and `+00…`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/csv.test.ts` (and change its import to `import { csvCell, csvRecords, detectDelimiter, parseCsv, parseCsvRows, serializeCsv } from "@/lib/csv";`):

```ts
describe("parseCsv with another delimiter", () => {
  it("splits on semicolons or tabs and keeps commas inside fields", () => {
    expect(parseCsv("name;address\nAsha;12, MG Road", { delimiter: ";" })).toEqual([
      ["name", "address"],
      ["Asha", "12, MG Road"],
    ]);
    expect(parseCsv("name\tphone\nRavi\t98765", { delimiter: "\t" })).toEqual([
      ["name", "phone"],
      ["Ravi", "98765"],
    ]);
  });
});

describe("parseCsvRows", () => {
  it("numbers records the way a spreadsheet numbers rows: blank lines count, quoted line breaks do not", () => {
    const rows = parseCsvRows('name,notes\r\nAsha,"line one\nline two"\r\n\r\nRavi,x\r\n');
    expect(rows).toEqual([
      { row: 1, cells: ["name", "notes"] },
      { row: 2, cells: ["Asha", "line one\nline two"] },
      { row: 4, cells: ["Ravi", "x"] },
    ]);
  });
});

describe("detectDelimiter", () => {
  it.each([
    ["name,phone,dob\n", ","],
    ["name;phone;dob\n", ";"],
    ["name\tphone\tdob\n", "\t"],
    ['"a;b",c\n', ","],
    ["single\n", ","],
    ["\ufeffname;phone\r\n", ";"],
  ] as const)("%j -> %j", (text, expected) => {
    expect(detectDelimiter(text)).toBe(expected);
  });
});

describe("serializeCsv", () => {
  it("neutralises formula cells (= + - @ tab CR) so a spreadsheet shows them as text", () => {
    expect(csvCell("=HYPERLINK(\"http://x\",\"y\")")).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csvCell("+91 98765 43210")).toBe("'+91 98765 43210");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("\"'\t=1\"");
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
    expect(csvCell("Asha Rao")).toBe("Asha Rao");
  });

  it("quotes commas, quotes and line breaks, starts with a BOM and ends rows with CRLF", () => {
    const out = serializeCsv([
      ["name", "notes"],
      ["आशा", 'said "hi", left\nearly'],
    ]);
    expect(out.codePointAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toBe('name,notes\r\nआशा,"said ""hi"", left\nearly"\r\n');
  });

  it("round-trips through parseCsv except for the neutralising apostrophe", () => {
    const rows = [["a,b", "c\"d", "=1"]];
    expect(parseCsv(serializeCsv(rows))).toEqual([["a,b", 'c"d', "'=1"]]);
  });
});
```

Append to `tests/unit/phone.test.ts` (it already imports `normalizePhone`):

```ts
describe("normalizePhone dialling noise (Plan 1D)", () => {
  it.each([
    ["tel:+91 98765 43210", "9876543210"],
    ["TEL:9876543210", "9876543210"],
    ["+0091 98765 43210", "9876543210"],
    ["\u200E+91 98765 43210", "9876543210"],
    ["\u202A+1 415 555 0100\u202C", "14155550100"],
    ["tel:+1-415-555-0100", "14155550100"],
    ["98765\u200B43210", "9876543210"],
  ])("%j -> %j", (raw, expected) => {
    expect(Array.from(raw).some((ch) => /\p{Cf}/u.test(ch)) || /tel:|\+00/i.test(raw)).toBe(true);
    expect(normalizePhone(raw)).toBe(expected);
  });
});
```

`tests/unit/csv-decode.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DECODE_MESSAGES, decodeCsvBytes } from "@/lib/import/decode";

const utf8 = (text: string) => new TextEncoder().encode(text);
function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out[2 * i + (littleEndian ? 0 : 1)] = unit & 0xff;
    out[2 * i + (littleEndian ? 1 : 0)] = unit >> 8;
  }
  return out;
}
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const NAME = "आशा देवी";

describe("decodeCsvBytes", () => {
  it("reads UTF-8 with or without a BOM", () => {
    expect(decodeCsvBytes(join(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`name\n${NAME}`)))).toEqual({ ok: true, text: `name\n${NAME}`, encoding: "utf-8" });
    expect(decodeCsvBytes(utf8(`name\n${NAME}`))).toEqual({ ok: true, text: `name\n${NAME}`, encoding: "utf-8" });
  });

  it("reads Excel's Unicode Text (UTF-16 little-endian with a BOM, tab-separated) and big-endian UTF-16", () => {
    expect(decodeCsvBytes(join(new Uint8Array([0xff, 0xfe]), utf16(`name\tphone\n${NAME}\t1`, true)))).toEqual({
      ok: true,
      text: `name\tphone\n${NAME}\t1`,
      encoding: "utf-16le",
    });
    expect(decodeCsvBytes(join(new Uint8Array([0xfe, 0xff]), utf16(`name\n${NAME}`, false)))).toEqual({ ok: true, text: `name\n${NAME}`, encoding: "utf-16be" });
  });

  it("refuses an Excel workbook, new (.xlsx, a zip) or old (.xls)", () => {
    expect(decodeCsvBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toEqual({ ok: false, message: DECODE_MESSAGES.workbook });
    expect(decodeCsvBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toEqual({ ok: false, message: DECODE_MESSAGES.workbook });
  });

  it("refuses Windows-1252 text instead of garbling names", () => {
    // "José" saved by Excel as ANSI: 0xE9 is not valid UTF-8 on its own.
    expect(decodeCsvBytes(new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]))).toEqual({ ok: false, message: DECODE_MESSAGES.notUtf8 });
  });

  it("refuses UTF-16 without a BOM and other binary data", () => {
    expect(decodeCsvBytes(utf16("name\nAsha Rao\n", true))).toEqual({ ok: false, message: DECODE_MESSAGES.unreadable });
  });

  it("refuses an empty file", () => {
    expect(decodeCsvBytes(new Uint8Array())).toEqual({ ok: false, message: DECODE_MESSAGES.empty });
  });
});
```

`tests/unit/patient-import-rows.test.ts`:

```ts
// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeCsv } from "@/lib/csv";
import { NUL_MESSAGE } from "@/server/validation/text";
import { ageColumns, checkMapping, PATIENT_TEMPLATE_ROWS, suggestMapping, type ColumnMapping } from "@/lib/import/patient-columns";
import { dateCell, genderCell, IMPORT_LIMITS, IMPORT_MESSAGES, parseImportTable, phoneCell, rowValues } from "@/lib/import/patient-rows";

const mapping = (overrides: Partial<ColumnMapping> = {}): ColumnMapping => ({
  name: 0,
  phone: 1,
  dob: 2,
  gender: 3,
  address: null,
  allergies: null,
  notes: null,
  ...overrides,
});

describe("parseImportTable", () => {
  it("detects the delimiter, names blank headers, skips empty rows and keeps spreadsheet row numbers", () => {
    const parsed = parseImportTable("Name;Mobile;;\r\nAsha;98765;;\r\n;;;\r\nRavi;12345;;\r\n");
    expect(parsed).toMatchObject({ ok: true, table: { delimiter: ";", headers: ["Name", "Mobile", "Column 3", "Column 4"] } });
    expect(parsed.ok && parsed.table.rows.map((r) => r.row)).toEqual([2, 4]);
  });

  it.each([
    ["", IMPORT_MESSAGES.empty],
    ["name,phone\r\n", IMPORT_MESSAGES.noRows],
    ["name,phone\r\n,\r\n , \r\n", IMPORT_MESSAGES.noRows],
    [`${Array.from({ length: 41 }, (_, i) => `c${i}`).join(",")}\nx`, IMPORT_MESSAGES.tooManyColumns],
    [`name\n${Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => `P${i}`).join("\n")}`, IMPORT_MESSAGES.tooManyRows],
  ])("refuses %#", (text, message) => {
    expect(parseImportTable(text)).toEqual({ ok: false, message });
  });

  it("accepts exactly the row cap", () => {
    const text = `name\n${Array.from({ length: IMPORT_LIMITS.maxRows }, (_, i) => `P${i}`).join("\n")}`;
    expect(parseImportTable(text).ok).toBe(true);
  });
});

describe("suggestMapping", () => {
  it("maps the legacy and common spreadsheet headers, never one column twice, and reports Age as not imported", () => {
    const headers = ["Patient Name", "Mobile No.", "D.O.B", "Sex", "Age", "Address", "Drug allergy", "Remarks"];
    const m = suggestMapping(headers);
    expect(m).toEqual({ name: 0, phone: 1, dob: 2, gender: 3, address: 5, allergies: 6, notes: 7 });
    expect(ageColumns(headers, m)).toEqual(["Age"]);
  });

  it("maps Hindi headers and leaves unknown ones unmapped", () => {
    expect(suggestMapping(["नाम", "मोबाइल", "Ward"])).toMatchObject({ name: 0, phone: 1, dob: null, notes: null });
  });

  it("takes the first matching column when two look alike", () => {
    expect(suggestMapping(["Phone", "Mobile"])).toMatchObject({ phone: 0 });
  });
});

describe("checkMapping", () => {
  it("accepts a complete mapping", () => {
    expect(checkMapping(mapping(), 4)).toEqual({ ok: true, mapping: mapping() });
  });

  it.each([
    [{ ...mapping(), name: null }, "Choose the column that holds the patient's name."],
    [{ ...mapping(), phone: 0 }, "Each column can be used for one detail only."],
    [{ ...mapping(), notes: 9 }, "A chosen column does not exist in this file."],
    [{ ...mapping(), extra: 1 }, "Choose which column holds each detail."],
    [{ ...mapping(), dob: -1 }, "Choose which column holds each detail."],
    ["not an object", "Choose which column holds each detail."],
  ])("refuses %#", (raw, message) => {
    expect(checkMapping(raw, 4)).toEqual({ ok: false, message });
  });
});

describe("dateCell", () => {
  it.each([
    ["1990-08-15", "1990-08-15"],
    ["15/08/1990", "1990-08-15"],
    ["5/8/1990", "1990-08-05"],
    ["15-08-1990", "1990-08-15"],
    ["15.08.1990", "1990-08-15"],
    ["15/08/1990 00:00", "1990-08-15"],
    ["1990-08-15T00:00:00Z", "1990-08-15"],
    ["'15/08/1990", "1990-08-15"],
    ["33100", "1990-08-15"],
    ["", ""],
    ["  ", ""],
  ])("reads %j as %j", (raw, value) => {
    expect(dateCell(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ["08/15/1990", IMPORT_MESSAGES.monthFirst],
    ["15/08/90", IMPORT_MESSAGES.twoDigitYear],
    ["31/02/1990", IMPORT_MESSAGES.noSuchDate],
    ["1990", IMPORT_MESSAGES.yearOnly],
    ["15 Aug 1990", IMPORT_MESSAGES.badDate],
    ["50", IMPORT_MESSAGES.badDate],
  ])("refuses %j rather than guessing", (raw, message) => {
    expect(dateCell(raw)).toEqual({ ok: false, message });
  });
});

describe("phoneCell", () => {
  it.each([
    ["+91 98765 43210", "+91 98765 43210"],
    ["'9876543210", "9876543210"],
    ["9876543210.0", "9876543210"],
    ["", ""],
  ])("keeps or repairs %j", (raw, value) => {
    expect(phoneCell(raw)).toEqual({ ok: true, value });
  });

  it.each(["9.87654E+09", "9.876543210e9", "9.88E+9"])("refuses Excel's scientific notation %j (digits are lost)", (raw) => {
    expect(phoneCell(raw)).toEqual({ ok: false, message: IMPORT_MESSAGES.sciPhone });
  });
});

describe("genderCell", () => {
  it.each([
    ["F", "female"],
    ["Female", "female"],
    ["m.", "male"],
    ["MALE", "male"],
    ["other", "other"],
    ["", "unknown"],
    ["N/A", "unknown"],
  ])("%j -> %j", (raw, value) => {
    expect(genderCell(raw)).toEqual({ ok: true, value });
  });

  it("refuses anything else", () => {
    expect(genderCell("robot")).toEqual({ ok: false, message: IMPORT_MESSAGES.gender });
  });
});

describe("rowValues", () => {
  it("repairs cells and leaves validation of the result to patientInputSchema", () => {
    const result = rowValues(["  Asha   Rao ", "'98765 43210", "15/08/1990", "F", "12 MG Road\nPune", "Penicillin; Sulfa | Dust", " note "], {
      ...mapping(),
      address: 4,
      allergies: 5,
      notes: 6,
    });
    expect(result).toEqual({
      ok: true,
      values: {
        name: "Asha Rao",
        phone: "98765 43210",
        dob: "1990-08-15",
        gender: "female",
        address: "12 MG Road, Pune",
        allergies: "Penicillin, Sulfa , Dust",
        notes: "note",
      },
    });
  });

  it("refuses a NUL in a mapped cell with the same message the form uses, and ignores unmapped cells", () => {
    expect(IMPORT_MESSAGES.nul).toBe(NUL_MESSAGE);
    const nul = "Asha\u0000Rao";
    expect(nul.codePointAt(4)).toBe(0);
    expect(rowValues([nul, "", "", ""], mapping())).toEqual({ ok: false, field: "name", message: NUL_MESSAGE });
    expect(rowValues(["Asha", "", "", "", nul], mapping())).toMatchObject({ ok: true });
  });

  it("refuses an over-long mapped cell and pads a short row with blanks", () => {
    expect(rowValues(["x".repeat(IMPORT_LIMITS.maxCellChars + 1)], mapping())).toEqual({ ok: false, field: "name", message: IMPORT_MESSAGES.tooLong });
    expect(rowValues(["Only Name"], mapping())).toMatchObject({ ok: true, values: { name: "Only Name", phone: "", dob: "", gender: "unknown" } });
  });

  it("names the field of a repair that failed", () => {
    expect(rowValues(["Asha", "9.8E+09", "", ""], mapping())).toEqual({ ok: false, field: "phone", message: IMPORT_MESSAGES.sciPhone });
    expect(rowValues(["Asha", "", "31/02/1990", ""], mapping())).toEqual({ ok: false, field: "dob", message: IMPORT_MESSAGES.noSuchDate });
  });
});

describe("the patient template", () => {
  it("is the file in sample_data, byte for byte, and parses back to the same rows", () => {
    const file = readFileSync(path.join(process.cwd(), "sample_data", "patients_template.csv"), "utf8");
    expect(file).toBe(serializeCsv(PATIENT_TEMPLATE_ROWS));
    const parsed = parseImportTable(file);
    expect(parsed.ok && [parsed.table.headers, ...parsed.table.rows.map((r) => r.cells)]).toEqual(PATIENT_TEMPLATE_ROWS);
    expect(parsed.ok && suggestMapping(parsed.table.headers)).toEqual({ name: 0, phone: 1, dob: 2, gender: 3, address: 4, allergies: 5, notes: 6 });
  });
});
```

After writing these files, run the invisible-character check from Global Constraints on all four (no output expected; the escapes must stay escapes).

- [ ] **Step 2: Run them to see them fail**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/csv.test.ts tests/unit/phone.test.ts tests/unit/csv-decode.test.ts tests/unit/patient-import-rows.test.ts
```

Expected: FAIL — `parseCsvRows`, `detectDelimiter`, `csvCell`, `serializeCsv` are not exported; `+0091 98765 43210` normalizes to `00919876543210` (the other new phone cases already give the right digits by accident of digit extraction; they pin the behaviour Task 10 relies on); the two `@/lib/import/*` modules do not exist. The existing `csv.test.ts` and `phone.test.ts` cases still pass.

- [ ] **Step 3: Extend `src/lib/csv.ts`**

Replace the file with:

```ts
export type CsvDelimiter = "," | ";" | "\t";

/** One record and the 1-based spreadsheet row it starts on: blank lines count as rows, a quoted line break does not. */
export type CsvRecord = { row: number; cells: string[] };

/**
 * Minimal RFC 4180 parser: one delimiter (comma by default), double-quoted fields with "" escapes and embedded
 * delimiters/newlines, CRLF or LF endings, an optional UTF-8 BOM. Blank lines are skipped. Never throws: an
 * unterminated quote runs to the end of the input. Linear in the input length.
 */
export function parseCsvRows(text: string, opts: { delimiter?: CsvDelimiter } = {}): CsvRecord[] {
  const delimiter = opts.delimiter ?? ",";
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let rowNo = 1;

  const endRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) records.push({ row: rowNo, cells: row });
    row = [];
    rowNo += 1;
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
    if (c === delimiter) {
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
  return records;
}

/** Rows of cells (see parseCsvRows). */
export function parseCsv(text: string, opts: { delimiter?: CsvDelimiter } = {}): string[][] {
  return parseCsvRows(text, opts).map((r) => r.cells);
}

/** Rows as objects keyed by the trimmed, lower-cased header. Extra columns are dropped. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, (row[index] ?? "").trim()])));
}

/**
 * The delimiter of a spreadsheet export, read from its first line (outside quotes): Excel writes ";" in locales
 * that use a decimal comma and tabs for "Unicode Text". Ties go to the comma.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  const end = Math.min(text.length, 64_000);
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < end; i += 1) {
    const c = text[i];
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (c === "\n" || c === "\r") break;
    if (c === "," || c === ";" || c === "\t") counts[c] += 1;
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

/** A cell that a spreadsheet would run as a formula (OWASP CSV injection): = + - @ tab CR. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, safe to open in a spreadsheet: a formula start is neutralised with a leading ', then RFC 4180 quoting. */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",;\t\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A CSV file for spreadsheets: UTF-8 BOM (so Excel shows Devanagari), CRLF line ends, every cell through csvCell. */
export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return `\uFEFF${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
```

- [ ] **Step 4: Harden `normalizePhone`**

In `src/lib/domain/phone.ts`, replace the first lines of `normalizePhone` (from `const trimmed = raw.trim();` to the end of the `if (!international && digits.startsWith("00")) { ... }` block) with:

```ts
  // Dialling noise, not part of the number: Unicode format characters (bidi marks, zero-width spaces pasted
  // from chat apps) and a "tel:" prefix copied from a link.
  const trimmed = raw.replace(/\p{Cf}/gu, "").trim().replace(/^tel:/i, "").trim();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  // "+" or the "00" dialling prefix marks an international number ("+00 91 ..." is a typing slip for "+91").
  let international = trimmed.startsWith("+");
  if (digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
```

and extend the doc comment with: `` "tel:+91 …", "+0091 …" and numbers carrying invisible format characters normalize the same way. ``

- [ ] **Step 5: Write the three import modules**

`src/lib/import/decode.ts`:

```ts
export type DecodedCsv = { ok: true; text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" } | { ok: false; message: string };

export const DECODE_MESSAGES = {
  empty: "The file is empty.",
  workbook: "This is an Excel workbook, not a CSV file. In Excel choose File > Save As > CSV UTF-8 (Comma delimited), then upload that file.",
  notUtf8: "This file is not saved as UTF-8, so names would come out garbled. In Excel choose CSV UTF-8 (Comma delimited) when you save, then upload it again.",
  unreadable: "This file could not be read as text. Save it as CSV UTF-8 (Comma delimited) and upload it again.",
} as const;

const fail = (message: string): DecodedCsv => ({ ok: false, message });

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function utf16le(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) throw new Error("odd length");
  return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
}
function swapPairs(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1];
    out[i + 1] = bytes[i];
  }
  if (bytes.length % 2 !== 0) out[bytes.length - 1] = bytes[bytes.length - 1];
  return out;
}

/**
 * Text of an uploaded spreadsheet export. UTF-8 (with or without BOM) and UTF-16 with a BOM (Excel "Unicode Text")
 * are read; workbooks, BOM-less UTF-16 or binary data, and any byte sequence that is not valid UTF-8 (Excel's ANSI
 * "CSV", Windows-1252) are refused with a message that says what to do. Nothing is ever decoded "best effort".
 */
export function decodeCsvBytes(bytes: Uint8Array): DecodedCsv {
  if (bytes.length === 0) return fail(DECODE_MESSAGES.empty);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return fail(DECODE_MESSAGES.workbook);
  }
  try {
    if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return { ok: true, text: utf8(bytes.subarray(3)), encoding: "utf-8" };
    if (startsWith(bytes, [0xff, 0xfe])) return { ok: true, text: utf16le(bytes.subarray(2)), encoding: "utf-16le" };
    if (startsWith(bytes, [0xfe, 0xff])) return { ok: true, text: utf16le(swapPairs(bytes.subarray(2))), encoding: "utf-16be" };
  } catch {
    return fail(DECODE_MESSAGES.unreadable);
  }
  // Text never has many NUL bytes; UTF-16 without a BOM (or a binary file) does.
  const sample = bytes.subarray(0, 4096);
  let zeros = 0;
  for (const b of sample) if (b === 0) zeros += 1;
  if (zeros * 10 > sample.length) return fail(DECODE_MESSAGES.unreadable);
  try {
    return { ok: true, text: utf8(bytes), encoding: "utf-8" };
  } catch {
    return fail(DECODE_MESSAGES.notUtf8);
  }
}
```

`src/lib/import/patient-columns.ts`:

```ts
import { z } from "zod";

export const IMPORT_FIELDS = ["name", "phone", "dob", "gender", "address", "allergies", "notes"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** Which column (0-based) holds each field; null = not imported. */
export type ColumnMapping = Record<ImportField, number | null>;

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  name: "Name",
  phone: "Phone",
  dob: "Date of birth",
  gender: "Gender",
  address: "Address",
  allergies: "Allergies",
  notes: "Notes",
};

/** Header spellings seen in clinic spreadsheets and the legacy app (compared with headerKey). */
const ALIASES: Record<ImportField, readonly string[]> = {
  name: ["name", "patientname", "fullname", "patient", "nameofpatient", "naam", "नाम"],
  phone: ["phone", "phoneno", "phonenumber", "mobile", "mobileno", "mobilenumber", "contact", "contactno", "contactnumber", "whatsapp", "whatsappno", "cell", "मोबाइल", "फोन"],
  dob: ["dob", "dateofbirth", "birthdate", "birthday", "dobddmmyyyy"],
  gender: ["gender", "sex", "लिंग"],
  address: ["address", "addr", "fulladdress", "residence", "पता"],
  allergies: ["allergies", "allergy", "drugallergy", "drugallergies", "allergic"],
  notes: ["notes", "note", "remarks", "remark", "comments", "comment"],
};
const AGE_ALIASES: readonly string[] = ["age", "ageyears", "ageinyears", "उम्र", "आयु"];

/** Case, spaces and punctuation ignored: "Mobile No." and "mobile_no" both read "mobileno". */
export function headerKey(header: string): string {
  return header.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

/** A first guess at the mapping: each field takes the first unused column whose header it recognises. */
export function suggestMapping(headers: readonly string[]): ColumnMapping {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const mapping: ColumnMapping = { name: null, phone: null, dob: null, gender: null, address: null, allergies: null, notes: null };
  for (const field of IMPORT_FIELDS) {
    const index = keys.findIndex((key, i) => !used.has(i) && ALIASES[field].includes(key));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  }
  return mapping;
}

/** Unmapped columns that hold an age: reported, because a birth date is never invented from an age. */
export function ageColumns(headers: readonly string[], mapping: ColumnMapping): string[] {
  const mapped = new Set(Object.values(mapping));
  return headers.filter((header, i) => !mapped.has(i) && AGE_ALIASES.includes(headerKey(header)));
}

const column = z.number().int().min(0).nullable();
const mappingSchema = z.strictObject({ name: column, phone: column, dob: column, gender: column, address: column, allergies: column, notes: column });

/** A mapping sent back by the browser: every field present, a name column chosen, existing columns, each used once. */
export function checkMapping(raw: unknown, headerCount: number): { ok: true; mapping: ColumnMapping } | { ok: false; message: string } {
  const parsed = mappingSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Choose which column holds each detail." };
  const mapping = parsed.data;
  if (mapping.name === null) return { ok: false, message: "Choose the column that holds the patient's name." };
  const used = IMPORT_FIELDS.map((f) => mapping[f]).filter((i): i is number => i !== null);
  if (used.some((i) => i >= headerCount)) return { ok: false, message: "A chosen column does not exist in this file." };
  if (new Set(used).size !== used.length) return { ok: false, message: "Each column can be used for one detail only." };
  return { ok: true, mapping };
}

/** The documented import shape (sample_data/patients_template.csv is serializeCsv of this). Synthetic people only. */
export const PATIENT_TEMPLATE_ROWS: readonly (readonly string[])[] = [
  ["name", "phone", "dob", "gender", "address", "allergies", "notes"],
  ["Asha Rao", "90000 00001", "15/08/1990", "female", "12 MG Road, Pune", "Penicillin; Sulfa", ""],
  ["Ravi Kumar", "90000 00002", "1985-01-20", "male", "", "", "Diabetic, on insulin"],
  ["आशा देवी", "90000 00003", "", "female", "", "", ""],
];
```

`src/lib/import/patient-rows.ts`:

```ts
import { detectDelimiter, parseCsvRows, type CsvDelimiter, type CsvRecord } from "@/lib/csv";
import { IMPORT_FIELDS, type ColumnMapping, type ImportField } from "./patient-columns";

export const IMPORT_LIMITS = { maxBytes: 1_000_000, maxRows: 5_000, maxColumns: 40, maxCellChars: 2_000 } as const;

export const IMPORT_MESSAGES = {
  empty: "The file is empty.",
  noRows: "The file has a header row but no patients.",
  tooManyRows: "The file has more than 5,000 patients. Split it into smaller files.",
  tooManyColumns: "The file has more than 40 columns. Remove the columns you do not need.",
  // Identical to NUL_MESSAGE (src/server/validation/text.ts); tests/unit/patient-import-rows.test.ts pins that.
  nul: "Text contains an invalid character",
  tooLong: "This cell is longer than 2,000 characters.",
  sciPhone: "Excel turned this phone number into a number like 9.88E+09, which loses digits. Format the column as Text in Excel and export again.",
  twoDigitYear: "Use a four-digit year, for example 15/08/1990.",
  monthFirst: "This looks like month/day/year. Write dates as day/month/year, for example 15/08/1990.",
  yearOnly: "Enter the full date of birth, not only the year.",
  badDate: "Write the date as day/month/year, for example 15/08/1990.",
  noSuchDate: "This date does not exist.",
  gender: "Write female, male, or other.",
} as const;

export type ImportTable = { headers: string[]; rows: CsvRecord[]; delimiter: CsvDelimiter };
export type CellResult = { ok: true; value: string } | { ok: false; message: string };
export type RawPatientRow = Record<ImportField, string>;

const good = (value: string): CellResult => ({ ok: true, value });
const bad = (message: string): CellResult => ({ ok: false, message });
const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** Header and data rows of an import file, with caps applied. Rows whose cells are all blank are dropped. */
export function parseImportTable(text: string): { ok: true; table: ImportTable } | { ok: false; message: string } {
  const delimiter = detectDelimiter(text);
  const records = parseCsvRows(text, { delimiter });
  if (records.length === 0) return { ok: false, message: IMPORT_MESSAGES.empty };
  const [header, ...data] = records;
  if (header.cells.length > IMPORT_LIMITS.maxColumns) return { ok: false, message: IMPORT_MESSAGES.tooManyColumns };
  const headers = header.cells.map((h, i) => singleLine(h) || `Column ${i + 1}`);
  const rows = data.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (rows.length === 0) return { ok: false, message: IMPORT_MESSAGES.noRows };
  if (rows.length > IMPORT_LIMITS.maxRows) return { ok: false, message: IMPORT_MESSAGES.tooManyRows };
  return { ok: true, table: { headers, rows, delimiter } };
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

function calendarDay(y: string, m: string, d: string): CellResult {
  const ymd = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === ymd ? good(ymd) : bad(IMPORT_MESSAGES.noSuchDate);
}

/**
 * A date cell as YYYY-MM-DD ("" when blank). Day first, as in India: 15/08/1990, 15-08-1990, 15.08.1990, an ISO
 * date, or an Excel serial number (61 = 1900-03-01). Ambiguous input is refused, never guessed: a two-digit year, a
 * second part above 12 (month/day/year), a bare year.
 */
export function dateCell(raw: string): CellResult {
  const text = raw.trim().replace(/^'/, "").replace(/[T ]00:00(?::00(?:\.0+)?)?Z?$/i, "").trim();
  if (text === "") return good("");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return calendarDay(m[1], m[2], m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (m) {
    if (Number(m[2]) > 12 && Number(m[1]) <= 12) return bad(IMPORT_MESSAGES.monthFirst);
    return calendarDay(m[3], m[2], m[1]);
  }
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(text)) return bad(IMPORT_MESSAGES.twoDigitYear);
  if (/^\d{4}$/.test(text) && Number(text) >= 1900 && Number(text) <= 2100) return bad(IMPORT_MESSAGES.yearOnly);
  if (/^\d{2,5}$/.test(text)) {
    const serial = Number(text);
    if (serial >= 61 && serial <= 73050) return good(new Date(EXCEL_EPOCH + serial * DAY_MS).toISOString().slice(0, 10));
  }
  return bad(IMPORT_MESSAGES.badDate);
}

/** A phone cell with Excel's damage repaired (a leading ' text marker, a trailing .0) or refused (scientific notation). */
export function phoneCell(raw: string): CellResult {
  const text = raw.trim().replace(/^'/, "");
  if (text === "") return good("");
  if (/^\d+(?:\.\d+)?e\+?\d+$/i.test(text)) return bad(IMPORT_MESSAGES.sciPhone);
  return good(text.replace(/\.0+$/, ""));
}

const GENDERS: Record<string, "female" | "male" | "other" | "unknown"> = {
  f: "female",
  female: "female",
  woman: "female",
  girl: "female",
  m: "male",
  male: "male",
  man: "male",
  boy: "male",
  o: "other",
  other: "other",
  t: "other",
  transgender: "other",
  u: "unknown",
  unknown: "unknown",
  na: "unknown",
  "n/a": "unknown",
  "-": "unknown",
};

export function genderCell(raw: string): CellResult {
  const key = raw.trim().toLowerCase().replace(/\.$/, "");
  if (key === "") return good("unknown");
  return Object.hasOwn(GENDERS, key) ? good(GENDERS[key]) : bad(IMPORT_MESSAGES.gender);
}

/**
 * The raw patient-form values of one row (validated afterwards by patientInputSchema, like the form). A NUL in any
 * mapped cell refuses the row (never stripped); unmapped cells are ignored entirely.
 */
export function rowValues(
  cells: readonly string[],
  mapping: ColumnMapping,
): { ok: true; values: RawPatientRow } | { ok: false; field: ImportField; message: string } {
  const cell = (field: ImportField): string => {
    const index = mapping[field];
    return index === null ? "" : (cells[index] ?? "");
  };
  for (const field of IMPORT_FIELDS) {
    const value = cell(field);
    if (value.includes("\u0000")) return { ok: false, field, message: IMPORT_MESSAGES.nul };
    if (value.length > IMPORT_LIMITS.maxCellChars) return { ok: false, field, message: IMPORT_MESSAGES.tooLong };
  }
  const phone = phoneCell(cell("phone"));
  if (!phone.ok) return { ok: false, field: "phone", message: phone.message };
  const dob = dateCell(cell("dob"));
  if (!dob.ok) return { ok: false, field: "dob", message: dob.message };
  const gender = genderCell(cell("gender"));
  if (!gender.ok) return { ok: false, field: "gender", message: gender.message };
  return {
    ok: true,
    values: {
      name: singleLine(cell("name")),
      phone: phone.value,
      dob: dob.value,
      gender: gender.value,
      address: cell("address").replace(/\s*[\r\n]+\s*/g, ", ").trim(),
      allergies: cell("allergies").replace(/[;|]/g, ","),
      notes: cell("notes").trim(),
    },
  };
}
```

- [ ] **Step 6: Generate the sample template from the constant**

```powershell
Set-Location E:\projects\clinicpad; npx tsx -e "import { writeFileSync } from 'node:fs'; import { serializeCsv } from './src/lib/csv'; import { PATIENT_TEMPLATE_ROWS } from './src/lib/import/patient-columns'; writeFileSync('sample_data/patients_template.csv', serializeCsv(PATIENT_TEMPLATE_ROWS), 'utf8');"
```

Expected: `sample_data/patients_template.csv` exists, starts with the bytes `EF BB BF`, and has CRLF line ends (`git` must not convert them: if `.gitattributes` normalizes `*.csv`, add `sample_data/patients_template.csv -text` to it).

- [ ] **Step 7: Run the tests**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/csv.test.ts tests/unit/phone.test.ts tests/unit/csv-decode.test.ts tests/unit/patient-import-rows.test.ts tests/integration/catalogue-seed.test.ts
```

Expected: PASS — csv +11, phone +7, csv-decode 6, patient-import-rows 54 (the `it.each` rows count individually), and `catalogue-seed.test.ts` unchanged (it still parses comma files through `csvRecords`).

- [ ] **Step 8: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/csv.ts src/lib/domain/phone.ts src/lib/import/decode.ts src/lib/import/patient-columns.ts src/lib/import/patient-rows.ts sample_data/patients_template.csv tests/unit/csv.test.ts tests/unit/phone.test.ts tests/unit/csv-decode.test.ts tests/unit/patient-import-rows.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(import): CSV decoding, delimiters, row numbers, formula-safe output, patient column mapping and Excel repairs" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

(Add `.gitattributes` to the `git add` line if Step 6 changed it.)

---

## Task 6: Patient import service — schema, dry-run, duplicate decisions, idempotent commit, and actions

**Files:**
- Create: `src/server/db/schema/imports.ts`, `src/server/services/patient-import.ts`, `src/server/actions/patient-import.ts`, `tests/helpers/csv-files.ts`
- Create: `drizzle/0019_phase1d_patient_import.sql` (generated), `drizzle/0020_phase1d_patient_import_security.sql` (custom), their snapshots and journal entries
- Modify: `src/server/db/schema/index.ts` (export `./imports`), `src/server/db/schema/clinical.ts` (`patients.importId`, `patients.importRowKey`, key, index, check), `src/server/services/numbering.ts` (`allocateNumbers`), `src/server/services/audit.ts` (`recordAuditMany`), `src/server/services/patients.ts` (export `toPatientColumns`), `src/lib/domain/permissions.ts` (`patient.import`), `tests/unit/permissions.test.ts`
- Test: `tests/integration/patient-import.test.ts`

**Interfaces:**
- Consumes: Task 5's `decodeCsvBytes`, `parseImportTable`, `rowValues`, `suggestMapping`, `checkMapping`, `ageColumns`, `IMPORT_LIMITS`, `IMPORT_FIELDS`, `ColumnMapping`, `ImportField`, `ImportTable`; Task 3's `clinicLocalDate`, `clinicTimeZoneIn`, `DOB_FUTURE_MESSAGE`; `patientInputSchema`, `PatientInput`, `normalizePhone`, `nameKey`, `sameName`, `invalidFrom`, `recordAudit`, `allocateNumber`'s upsert pattern, `public.enforce_print_rows_immutable()`.
- Produces:
  - Drizzle `patientImports` (`patient_imports`: `id`, `tenantId`, `actorUserId`, `fileSha256`, `rowCount`, `createdCount`, `filledCount`, `skippedCount`, `alreadyImportedCount`, `invalidCount`, `createdAt`; unique `patient_imports_tenant_id_uq`); `patients.importId: string | null` (composite key `patients_import_fk`), `patients.importRowKey: string | null` (partial unique index `patients_import_row_key_uq` on `(tenant_id, import_row_key)`).
  - `allocateNumbers(tx, tenantId, name: SequenceName, count: number): Promise<number>` — the first number of a block of `count` consecutive numbers.
  - `recordAuditMany(tx, ctx, events: readonly AuditInput[]): Promise<void>`.
  - `toPatientColumns(input: PatientInput)` (was the private `toColumns`).
  - `can(role, "patient.import")` — owner only.
  - Types: `ImportDecision = "skip" | "create" | "fill"`; `DuplicateMatch = { patientNo: number | null; name: string; sameName: boolean }`; `ImportRowReport` (`new` with `name`, `dob`; `already_imported` with `name`; `duplicate` with `name`, `matches`, `duplicateOfRow`, `canFill`, `canCreate`; `invalid` with `field: ImportField | "row"`, `message`, `cells`); `ImportTotals = { rows; new; duplicate; alreadyImported; invalid }`; `ImportReport = { fileSha256; headers; mapping; ageColumns; needsName; totals; rows }`; `CommitSummary = { importId; created; filled; skipped; alreadyImported; invalid; firstPatientNo; lastPatientNo }`; `NEW_ROW_PREVIEW = 20`.
  - `importRowKey(name: string, phone: string | null, dob: string | null): string`.
  - `dryRunPatientImport(ctx, file: { bytes: Uint8Array }, rawMapping?: unknown): Promise<Result<ImportReport>>`.
  - `commitPatientImport(ctx, file: { bytes: Uint8Array }, input: { mapping: unknown; decisions: unknown; expectedSha256: unknown }): Promise<Result<CommitSummary>>`.
  - Actions: `type DryRunState = { report?: ImportReport; error?: string; field?: string }`, `type CommitState = { summary?: CommitSummary; error?: string; field?: string }`, `dryRunImportAction(formData: FormData): Promise<DryRunState>` (fields `file`, optional `mapping` JSON), `commitImportAction(formData: FormData): Promise<CommitState>` (fields `file`, `mapping` JSON, `decisions` JSON `{ "<row>": decision }`, `sha`).

- [ ] **Step 1: Add the action to the role matrix (test first)**

In `tests/unit/permissions.test.ts`, add `"patient.import": ["owner"],` to `granted` (after `"patient.archive"`) and a case in the first `describe`:

```ts
  it("restricts patient import to owners", () => {
    expect(can("owner", "patient.import")).toBe(true);
    for (const role of ["doctor", "reception", "nurse", "pharmacist", "accountant"]) expect(can(role, "patient.import")).toBe(false);
  });
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/permissions.test.ts` — expected: typecheck-level failure on the unknown key in `granted` and the new case fails. Then add `"patient.import": ["owner"],` after `"patient.archive"` in `MATRIX` (`src/lib/domain/permissions.ts`) and rerun: PASS.

- [ ] **Step 2: Write the failing import test**

`tests/helpers/csv-files.ts`:

```ts
/** Bytes of an import file as a spreadsheet would save it. */
export const utf8File = (text: string): Uint8Array => new TextEncoder().encode(text);

export const utf8BomFile = (text: string): Uint8Array => {
  const body = utf8File(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
};

/** Excel "Unicode Text": UTF-16 little-endian with a BOM. */
export const utf16LeFile = (text: string): Uint8Array => {
  const out = new Uint8Array(2 + text.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out[2 + 2 * i] = unit & 0xff;
    out[3 + 2 * i] = unit >> 8;
  }
  return out;
};

export const csv = (lines: string[]): string => `${lines.join("\r\n")}\r\n`;
```

`tests/integration/patient-import.test.ts`:

```ts
// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, patientImports, patients, tenantCounters } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { commitPatientImport, dryRunPatientImport, type ImportReport } from "@/server/services/patient-import";
import { DECODE_MESSAGES } from "@/lib/import/decode";
import { IMPORT_LIMITS, IMPORT_MESSAGES } from "@/lib/import/patient-rows";
import { NUL_MESSAGE } from "@/server/validation/text";
import { csv, utf16LeFile, utf8BomFile, utf8File } from "../helpers/csv-files";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
const owner = () => A.as("owner");

async function dryRun(bytes: Uint8Array, mapping?: unknown): Promise<ImportReport> {
  const result = await dryRunPatientImport(owner(), { bytes }, mapping);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

async function commit(bytes: Uint8Array, decisions: Record<string, string> = {}, mapping?: unknown) {
  const report = await dryRun(bytes, mapping);
  return commitPatientImport(owner(), { bytes }, { mapping: report.mapping, decisions, expectedSha256: report.fileSha256 });
}

async function counter(tenantId: string): Promise<number> {
  const [row] = await adminDb.select().from(tenantCounters).where(and(eq(tenantCounters.tenantId, tenantId), eq(tenantCounters.name, "patient")));
  return row?.lastNo ?? 0;
}

beforeAll(async () => {
  A = await createTestTenant("import-a");
  B = await createTestTenant("import-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("who may import", () => {
  it("is the owner only, for the dry-run and the commit", async () => {
    const bytes = utf8File(csv(["name", "Role Test"]));
    for (const role of ["doctor", "reception", "nurse", "pharmacist", "accountant"]) {
      expect(await dryRunPatientImport(A.as(role), { bytes })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await commitPatientImport(A.as(role), { bytes }, { mapping: null, decisions: {}, expectedSha256: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    }
  });
});

describe("the sample template", () => {
  const template = readFileSync(path.join(process.cwd(), "sample_data", "patients_template.csv"));
  const bytes = new Uint8Array(template);

  it("checks clean, then imports with numbers that continue the clinic's sequence, audited by id", async () => {
    const before = await createPatient(owner(), { name: "Registered First" });
    if (!before.ok) throw new Error(before.message);
    const report = await dryRun(bytes);
    expect(report.totals).toEqual({ rows: 3, new: 3, duplicate: 0, alreadyImported: 0, invalid: 0 });
    expect(report.mapping).toEqual({ name: 0, phone: 1, dob: 2, gender: 3, address: 4, allergies: 5, notes: 6 });
    expect(report.rows.map((r) => r.status === "new" && r.dob)).toEqual(["1990-08-15", "1985-01-20", null]);

    const done = await commitPatientImport(owner(), { bytes }, { mapping: report.mapping, decisions: {}, expectedSha256: report.fileSha256 });
    expect(done).toMatchObject({ ok: true, value: { created: 3, filled: 0, skipped: 0, alreadyImported: 0, invalid: 0 } });
    if (!done.ok) return;
    expect(done.value.firstPatientNo).toBe(before.value.patientNo + 1);
    expect(done.value.lastPatientNo).toBe(before.value.patientNo + 3);

    const rows = await adminDb.select().from(patients).where(eq(patients.importId, done.value.importId));
    expect(rows.map((r) => r.name).sort()).toEqual(["Asha Rao", "Ravi Kumar", "आशा देवी"].sort());
    expect(rows.find((r) => r.name === "Asha Rao")).toMatchObject({ phoneNormalized: "9000000001", dob: "1990-08-15", gender: "female", allergies: ["Penicillin", "Sulfa"] });
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.importRowKey ?? ""))).toBe(true);

    const [job] = await adminDb.select().from(patientImports).where(eq(patientImports.id, done.value.importId));
    expect(job).toMatchObject({ rowCount: 3, createdCount: 3, actorUserId: owner().userId });
    const events = await adminDb.select().from(auditEvents).where(eq(auditEvents.tenantId, A.tenantId));
    const created = events.filter((e) => e.action === "patient.created" && (e.after as { importId?: string } | null)?.importId === done.value.importId);
    expect(created).toHaveLength(3);
    expect(events.filter((e) => e.action === "patient_import.committed" && e.entityId === done.value.importId)).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/Asha|Ravi|आशा|9000000001/);
  });

  it("is idempotent: a re-run reports every row as already imported, writes nothing, and burns no number", async () => {
    const lastNo = await counter(A.tenantId);
    const report = await dryRun(bytes);
    expect(report.totals).toMatchObject({ new: 0, alreadyImported: 3 });
    const done = await commitPatientImport(owner(), { bytes }, { mapping: report.mapping, decisions: {}, expectedSha256: report.fileSha256 });
    expect(done).toMatchObject({ ok: true, value: { created: 0, alreadyImported: 3, firstPatientNo: null } });
    expect(await counter(A.tenantId)).toBe(lastNo);
  });
});

describe("two commits at once (a double-click, or two tabs)", () => {
  it("creates each patient once: the second waits for the first and finds its rows", async () => {
    const bytes = utf8File(csv(["name,phone", "Twin One,9000000101", "Twin Two,9000000102"]));
    const report = await dryRun(bytes);
    const input = { mapping: report.mapping, decisions: {}, expectedSha256: report.fileSha256 };
    const [first, second] = await Promise.all([commitPatientImport(owner(), { bytes }, input), commitPatientImport(owner(), { bytes }, input)]);
    const created = [first, second].map((r) => (r.ok ? r.value.created : -1)).sort();
    expect(created).toEqual([0, 2]);
    const rows = await adminDb.select().from(patients).where(and(eq(patients.tenantId, A.tenantId), inArray(patients.name, ["Twin One", "Twin Two"])));
    expect(rows).toHaveLength(2);
  });
});

describe("duplicates", () => {
  const file = utf8File(
    csv([
      "name,phone,dob,gender,address,notes",
      "Meera Shah,+91 91234 56780,01/02/1980,F,5 Lake Road,Overwrite me?",
      "Kiran Shah,9123456780,,M,,",
      "Meera Shah,+91 91234 56780,01/02/1980,F,5 Lake Road,Overwrite me?",
    ]),
  );
  let meeraId = "";

  beforeAll(async () => {
    const meera = await createPatient(owner(), { name: "Meera Shah", phone: "91234 56780", notes: "Keep me" });
    if (!meera.ok) throw new Error(meera.message);
    meeraId = meera.value.id;
  });

  it("flags phone matches, a family member on the same phone, and an exact repeat inside the file", async () => {
    const report = await dryRun(file);
    expect(report.totals).toMatchObject({ rows: 3, duplicate: 3, new: 0 });
    const [meera, kiran, repeat] = report.rows;
    expect(meera).toMatchObject({ row: 2, status: "duplicate", canFill: true, canCreate: true, duplicateOfRow: null });
    expect(meera.status === "duplicate" && meera.matches).toEqual([{ patientNo: expect.any(Number), name: "Meera Shah", sameName: true }]);
    expect(kiran).toMatchObject({ row: 3, status: "duplicate", canFill: false, canCreate: true, duplicateOfRow: 2 });
    expect(repeat).toMatchObject({ row: 4, status: "duplicate", canFill: false, canCreate: false, duplicateOfRow: 2 });
  });

  it("skips every duplicate by default", async () => {
    expect(await commit(file)).toMatchObject({ ok: true, value: { created: 0, filled: 0, skipped: 3 } });
  });

  it("fills only empty details, never overwrites, creates a family member on request, and never creates an exact repeat", async () => {
    const done = await commit(file, { "2": "fill", "3": "create", "4": "create" });
    expect(done).toMatchObject({ ok: true, value: { created: 1, filled: 1, skipped: 1 } });
    const [meera] = await adminDb.select().from(patients).where(eq(patients.id, meeraId));
    expect(meera).toMatchObject({ name: "Meera Shah", dob: "1980-02-01", gender: "female", address: "5 Lake Road", notes: "Keep me" });
    const kirans = await adminDb.select().from(patients).where(and(eq(patients.tenantId, A.tenantId), eq(patients.name, "Kiran Shah")));
    expect(kirans).toHaveLength(1);
    const [fillEvent] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, meeraId), eq(auditEvents.action, "patient.updated")));
    expect(fillEvent.after).toMatchObject({ changedFields: ["dob", "gender", "address"] });
  });

  it("ignores a fill request where filling is not offered", async () => {
    const other = utf8File(csv(["name,phone", "Someone Else,91234 56780"]));
    expect(await commit(other, { "2": "fill" })).toMatchObject({ ok: true, value: { filled: 0, created: 0, skipped: 1 } });
  });

  it("matches only this clinic's patients", async () => {
    const theirs = await createPatient(B.as("owner"), { name: "Other Clinic", phone: "9000000777" });
    if (!theirs.ok) throw new Error(theirs.message);
    const report = await dryRun(utf8File(csv(["name,phone", "Other Clinic,9000000777"])));
    expect(report.totals).toMatchObject({ new: 1, duplicate: 0 });
  });

  it("skips a row that became a duplicate after the check", async () => {
    const bytes = utf8File(csv(["name,phone", "Late Comer,9000011111"]));
    const report = await dryRun(bytes);
    expect(report.totals.new).toBe(1);
    await createPatient(A.as("reception"), { name: "Late Comer", phone: "9000011111" });
    const done = await commitPatientImport(owner(), { bytes }, { mapping: report.mapping, decisions: {}, expectedSha256: report.fileSha256 });
    expect(done).toMatchObject({ ok: true, value: { created: 0, skipped: 1 } });
  });
});

describe("problem rows", () => {
  it("reports each problem with the spreadsheet row, the field, the message and the original cells", async () => {
    const nulName = "Bad\u0000Name";
    expect(nulName.codePointAt(3)).toBe(0);
    const report = await dryRun(
      utf8File(
        csv([
          "name,phone,dob,gender",
          `${nulName},,,`,
          "Future Baby,,01/01/2999,",
          "Sci Phone,9.87654E+09,,",
          "Robot,,,robot",
          ",9000000999,,",
          '"=HYPERLINK(""http://evil"")",,,',
        ]),
      ),
    );
    const problems = report.rows.filter((r) => r.status === "invalid");
    expect(problems.map((r) => r.status === "invalid" && [r.row, r.field, r.message])).toEqual([
      [2, "name", NUL_MESSAGE],
      [3, "dob", "Date of birth cannot be in the future"],
      [4, "phone", IMPORT_MESSAGES.sciPhone],
      [5, "gender", IMPORT_MESSAGES.gender],
      [6, "name", "Enter the patient's name"],
    ]);
    expect(problems[0].status === "invalid" && problems[0].cells).toEqual([nulName, "", "", ""]);
    // A formula-looking name is just text to ClinicPad; the problem-row download neutralises it (Task 7).
    expect(report.totals).toMatchObject({ rows: 6, invalid: 5, new: 1 });
  });
});

describe("file checks", () => {
  it.each([
    ["an empty file", new Uint8Array(), "Choose a CSV file first."],
    ["a file over 1 MB", new Uint8Array(IMPORT_LIMITS.maxBytes + 1).fill(0x41), "The file is larger than 1 MB. Split it into smaller files."],
    ["an Excel workbook", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), DECODE_MESSAGES.workbook],
    ["Windows-1252 text", new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]), DECODE_MESSAGES.notUtf8],
  ])("refuses %s with a message on the file field", async (_label, bytes, message) => {
    expect(await dryRunPatientImport(owner(), { bytes })).toEqual({ ok: false, code: "invalid", message, field: "file" });
  });

  it("reads Excel's Unicode Text (UTF-16, tab-separated) and keeps Devanagari intact", async () => {
    const bytes = utf16LeFile("Name\tMobile\r\nसुनीता वर्मा\t9000000201\r\n");
    const done = await commit(bytes);
    expect(done).toMatchObject({ ok: true, value: { created: 1 } });
    const [row] = await adminDb.select().from(patients).where(and(eq(patients.tenantId, A.tenantId), eq(patients.phoneNormalized, "9000000201")));
    expect(row.name).toBe("सुनीता वर्मा");
  });

  it("reads a semicolon file with a BOM", async () => {
    const report = await dryRun(utf8BomFile(csv(["Name;Phone", "Semi Colon;9000000301"])));
    expect(report.totals).toMatchObject({ new: 1 });
  });
});

describe("mapping, decisions and the file fingerprint", () => {
  it("asks for a name column when none is recognised, then uses the chosen one", async () => {
    const bytes = utf8File(csv(["Col A,Col B", "Unnamed Person,9000000401"]));
    const first = await dryRun(bytes);
    expect(first).toMatchObject({ needsName: true, rows: [], totals: { rows: 0 } });
    const second = await dryRun(bytes, { name: 0, phone: 1, dob: null, gender: null, address: null, allergies: null, notes: null });
    expect(second).toMatchObject({ needsName: false, totals: { new: 1 } });
  });

  it("refuses a changed file, a broken mapping, and broken decisions", async () => {
    const bytes = utf8File(csv(["name", "Fingerprint Person"]));
    const report = await dryRun(bytes);
    const changed = utf8File(csv(["name", "Fingerprint Persons"]));
    expect(await commitPatientImport(owner(), { bytes: changed }, { mapping: report.mapping, decisions: {}, expectedSha256: report.fileSha256 })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(await commitPatientImport(owner(), { bytes }, { mapping: { name: 5 }, decisions: {}, expectedSha256: report.fileSha256 })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "mapping",
    });
    expect(await commitPatientImport(owner(), { bytes }, { mapping: report.mapping, decisions: { "2": "merge" }, expectedSha256: report.fileSha256 })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "decisions",
    });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/patient-import.test.ts
```

Expected: FAIL — `@/server/services/patient-import` does not exist and `patientImports` is not exported from the schema.

- [ ] **Step 4: Add the schema**

`src/server/db/schema/imports.ts`:

```ts
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { tenants } from "./tenancy";

/**
 * One row per committed patient import: who, when, the file's SHA-256 and the outcome counts. Append-only for the
 * runtime role and immutable on every connection (0020). Imported patients point at it (patients.import_id).
 */
export const patientImports = pgTable(
  "patient_imports",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    fileSha256: text("file_sha256").notNull(),
    rowCount: integer("row_count").notNull(),
    createdCount: integer("created_count").notNull(),
    filledCount: integer("filled_count").notNull(),
    skippedCount: integer("skipped_count").notNull(),
    alreadyImportedCount: integer("already_imported_count").notNull(),
    invalidCount: integer("invalid_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target of the composite same-tenant key from patients.import_id.
    unique("patient_imports_tenant_id_uq").on(t.tenantId, t.id),
    index("patient_imports_tenant_created_idx").on(t.tenantId, t.createdAt),
    check("patient_imports_sha256_check", sql`file_sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      "patient_imports_counts_check",
      sql`row_count between 0 and 5000 and created_count >= 0 and filled_count >= 0 and skipped_count >= 0 and already_imported_count >= 0 and invalid_count >= 0 and created_count + filled_count + skipped_count + already_imported_count + invalid_count = row_count`,
    ),
  ],
);
```

In `src/server/db/schema/index.ts` add `export * from "./imports";`. In `src/server/db/schema/clinical.ts`, add `import { patientImports } from "./imports";`, add the columns to `patients` after `notes`:

```ts
    /** The import that created this patient (Plan 1D), and the row key that makes a re-run idempotent. */
    importId: uuid("import_id"),
    importRowKey: text("import_row_key"),
```

and to `patients`' config array:

```ts
    // Same-tenant reference to the import job (ADR-0025 pattern). NO ACTION: import rows are never deleted while the tenant exists.
    foreignKey({
      name: "patients_import_fk",
      columns: [t.tenantId, t.importId],
      foreignColumns: [patientImports.tenantId, patientImports.id],
    }),
    // A re-run of the same file finds its rows here instead of creating them again.
    uniqueIndex("patients_import_row_key_uq").on(t.tenantId, t.importRowKey).where(sql`${t.importRowKey} is not null`),
    check("patients_import_row_key_check", sql`import_row_key is null or import_row_key ~ '^[0-9a-f]{64}$'`),
```

- [ ] **Step 5: Generate the table migration, then the security migration**

```powershell
Set-Location E:\projects\clinicpad; npx drizzle-kit generate --name=phase1d_patient_import
Set-Location E:\projects\clinicpad; npx drizzle-kit generate --custom --name=phase1d_patient_import_security
```

Expected: `drizzle/0019_phase1d_patient_import.sql` creates `patient_imports` (with `patient_imports_tenant_id_uq` inside `CREATE TABLE`), adds the two `patients` columns, `patients_import_fk`, `patients_import_row_key_uq` and the three CHECKs. If drizzle-kit wrote `patients_import_fk` before the `CREATE TABLE "patient_imports"`, move the foreign key below it (AGENTS.md §10). Then `drizzle/0020_phase1d_patient_import_security.sql` (empty); replace its content with:

```sql
-- Plan 1D patient import (custom migration): forced RLS and append-only rows for patient_imports.

alter table patient_imports enable row level security;
--> statement-breakpoint
alter table patient_imports force row level security;
--> statement-breakpoint
create policy tenant_read on patient_imports
  for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on patient_imports
  for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- 0002's default privileges granted UPDATE/DELETE on every new table; take them back.
grant select, insert on patient_imports to clinicpad_app;
--> statement-breakpoint
revoke update, delete, truncate on patient_imports from clinicpad_app;
--> statement-breakpoint
-- Immutable on every connection while the tenant exists (the 0015 function; offboarding may delete).
create trigger patient_imports_immutable before update or delete on patient_imports
  for each row execute function public.enforce_print_rows_immutable();
```

Apply and confirm:

```powershell
Set-Location E:\projects\clinicpad; npm run db:migrate
Set-Location E:\projects\clinicpad; npx drizzle-kit generate
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/rls-guard.test.ts tests/integration/tenant-fk.test.ts tests/integration/schema-checks.test.ts
```

Expected: "No schema changes"; the three guards pass with the new table (RLS forced and scoped, `patients_import_fk` composite, the three new CHECKs declared).

- [ ] **Step 6: Add the helpers the service needs**

`src/server/services/numbering.ts` — append:

```ts
/**
 * The first number of a block of `count` consecutive numbers, reserved in one upsert (bulk import). Same locking and
 * rollback behaviour as allocateNumber: concurrent callers queue on the counter row; a rolled-back block is released.
 */
export async function allocateNumbers(tx: TenantTx, tenantId: string, name: SequenceName, count: number): Promise<number> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("count must be a positive whole number");
  const [row] = await tx
    .insert(tenantCounters)
    .values({ tenantId, name, lastNo: count })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.name],
      set: { lastNo: sql`${tenantCounters.lastNo} + ${count}` },
    })
    .returning({ value: tenantCounters.lastNo });
  return row.value - count + 1;
}
```

`src/server/services/audit.ts` — append:

```ts
/** Several events in one statement, inside the caller's transaction (bulk import). Same payload rules as recordAudit. */
export async function recordAuditMany(tx: TenantTx, ctx: ServiceContext, events: readonly AuditInput[]): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(auditEvents).values(
    events.map((event) => ({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      before: event.before,
      after: event.after,
    })),
  );
}
```

`src/server/services/patients.ts` — rename `function toColumns(input: PatientInput)` to `export function toPatientColumns(input: PatientInput)` and update its two call sites (`createPatient`, `updatePatient`) and Task 3's `dobInClinicFuture` caller, if any, to the new name.

- [ ] **Step 7: Write the import service**

`src/server/services/patient-import.ts`:

```ts
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "@/lib/domain/permissions";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { nameKey, sameName } from "@/lib/domain/names";
import { normalizePhone } from "@/lib/domain/phone";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { decodeCsvBytes } from "@/lib/import/decode";
import { ageColumns, checkMapping, IMPORT_FIELDS, suggestMapping, type ColumnMapping, type ImportField } from "@/lib/import/patient-columns";
import { IMPORT_LIMITS, parseImportTable, rowValues, type ImportTable } from "@/lib/import/patient-rows";
import { patientImports, patients } from "@/server/db/schema";
import { pgErrorInfo } from "@/server/db/errors";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { DOB_FUTURE_MESSAGE, patientInputSchema, type PatientInput } from "@/server/validation/patient";
import { recordAudit, recordAuditMany } from "./audit";
import { clinicTimeZoneIn } from "./clinic";
import type { ServiceContext } from "./context";
import { allocateNumbers } from "./numbering";
import { toPatientColumns } from "./patients";

export type ImportDecision = "skip" | "create" | "fill";
export type DuplicateMatch = { patientNo: number | null; name: string; sameName: boolean };
export type ImportRowReport =
  | { row: number; status: "new"; name: string; dob: string | null }
  | { row: number; status: "already_imported"; name: string }
  | { row: number; status: "duplicate"; name: string; matches: DuplicateMatch[]; duplicateOfRow: number | null; canFill: boolean; canCreate: boolean }
  | { row: number; status: "invalid"; field: ImportField | "row"; message: string; cells: string[] };
export type ImportTotals = { rows: number; new: number; duplicate: number; alreadyImported: number; invalid: number };
export type ImportReport = {
  fileSha256: string;
  headers: string[];
  mapping: ColumnMapping;
  /** Unmapped age columns: shown as "not imported" (a birth date is never invented from an age). */
  ageColumns: string[];
  /** No name column recognised: the owner must choose one; nothing was analysed. */
  needsName: boolean;
  totals: ImportTotals;
  /** Every problem, every duplicate, every already-imported row, and the first NEW_ROW_PREVIEW new rows. */
  rows: ImportRowReport[];
};
export type CommitSummary = {
  importId: string;
  created: number;
  filled: number;
  skipped: number;
  alreadyImported: number;
  invalid: number;
  firstPatientNo: number | null;
  lastPatientNo: number | null;
};

export const NEW_ROW_PREVIEW = 20;
const MAX_MATCHES = 3;
const CHUNK = 500;
const FORBIDDEN = "Only the clinic owner can import patients.";
const NO_FILE = "Choose a CSV file first.";
const TOO_LARGE = "The file is larger than 1 MB. Split it into smaller files.";
const FILE_CHANGED = "The file changed since it was checked. Check it again before importing.";
const CONCURRENT = "Patients changed while importing. Check the file again.";
const BAD_DECISIONS = "The duplicate choices are not valid. Check the file again.";

const decisionsSchema = z
  .record(z.string().regex(/^\d{1,6}$/), z.enum(["skip", "create", "fill"]))
  .refine((d) => Object.keys(d).length <= IMPORT_LIMITS.maxRows);

type Prepared = { row: number; input: PatientInput; phone: string | null; key: string };
type Match = DuplicateMatch & { id: string };
type Invalid = { row: number; status: "invalid"; field: ImportField | "row"; message: string; cells: string[] };
type Analysed =
  | (Prepared & { status: "new" })
  | (Prepared & { status: "already_imported" })
  | (Prepared & { status: "duplicate"; matches: Match[]; duplicateOfRow: number | null; exactRepeat: boolean })
  | Invalid;
type Duplicate = Extract<Analysed, { status: "duplicate" }>;

const FIELD_NAMES = new Set<string>(IMPORT_FIELDS);
const asField = (field: string | undefined): ImportField | "row" => (field !== undefined && FIELD_NAMES.has(field) ? (field as ImportField) : "row");
const canFill = (r: Duplicate) => r.duplicateOfRow === null && r.matches.length === 1 && r.matches[0].sameName;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** The same person in the same file or on a re-run: name key, normalized phone, DOB. Stored on the patient. */
export function importRowKey(name: string, phone: string | null, dob: string | null): string {
  return createHash("sha256").update(`${nameKey(name)}\u001f${phone ?? ""}\u001f${dob ?? ""}`, "utf8").digest("hex");
}

function loadTable(bytes: Uint8Array): Result<{ table: ImportTable; sha256: string }> {
  if (bytes.byteLength === 0) return fail("invalid", NO_FILE, "file");
  if (bytes.byteLength > IMPORT_LIMITS.maxBytes) return fail("invalid", TOO_LARGE, "file");
  const decoded = decodeCsvBytes(bytes);
  if (!decoded.ok) return fail("invalid", decoded.message, "file");
  const parsed = parseImportTable(decoded.text);
  if (!parsed.ok) return fail("invalid", parsed.message, "file");
  return ok({ table: parsed.table, sha256: createHash("sha256").update(bytes).digest("hex") });
}

/** No mapping sent (first check): the suggestion. Otherwise the owner's mapping, checked against the file. */
function mappingFor(raw: unknown, table: ImportTable): Result<ColumnMapping> {
  if (raw === undefined || raw === null) return ok(suggestMapping(table.headers));
  const checked = checkMapping(raw, table.headers.length);
  return checked.ok ? ok(checked.mapping) : fail("invalid", checked.message, "mapping");
}

/** One row through the Excel repairs, the patient form's own schema, and the clinic-day DOB rule. */
function prepare(record: { row: number; cells: string[] }, mapping: ColumnMapping, today: string): Prepared | Invalid {
  const invalid = (field: ImportField | "row", message: string): Invalid => ({ row: record.row, status: "invalid", field, message, cells: record.cells });
  const values = rowValues(record.cells, mapping);
  if (!values.ok) return invalid(values.field, values.message);
  const parsed = patientInputSchema.safeParse(values.values);
  if (!parsed.success) {
    const error = invalidFrom(parsed.error);
    return invalid(asField(error.field), error.message);
  }
  const input = parsed.data;
  if (input.dob && input.dob > today) return invalid("dob", DOB_FUTURE_MESSAGE);
  const phone = input.phone ? normalizePhone(input.phone) : null;
  return { row: record.row, input, phone, key: importRowKey(input.name, phone, input.dob ?? null) };
}

/** Classifies every row against this clinic's patients and the earlier rows of the file. Reads only. */
async function analyse(tx: TenantTx, tenantId: string, table: ImportTable, mapping: ColumnMapping, today: string): Promise<Analysed[]> {
  const prepared = table.rows.map((r) => prepare(r, mapping, today));
  const valid = prepared.filter((r): r is Prepared => !("status" in r));

  const imported = new Set<string>();
  for (const keys of chunks([...new Set(valid.map((r) => r.key))])) {
    const rows = await tx
      .select({ key: patients.importRowKey })
      .from(patients)
      .where(and(eq(patients.tenantId, tenantId), inArray(patients.importRowKey, keys)));
    for (const r of rows) if (r.key) imported.add(r.key);
  }

  const byPhone = new Map<string, Omit<Match, "sameName">[]>();
  for (const phones of chunks([...new Set(valid.map((r) => r.phone).filter((p): p is string => p !== null))])) {
    const rows = await tx
      .select({ id: patients.id, patientNo: patients.patientNo, name: patients.name, phone: patients.phoneNormalized })
      .from(patients)
      .where(and(eq(patients.tenantId, tenantId), isNull(patients.deletedAt), inArray(patients.phoneNormalized, phones)))
      .orderBy(desc(patients.createdAt), desc(patients.id));
    for (const r of rows) {
      if (!r.phone) continue;
      byPhone.set(r.phone, [...(byPhone.get(r.phone) ?? []), { id: r.id, patientNo: r.patientNo, name: r.name }]);
    }
  }

  const firstByKey = new Map<string, number>();
  const firstByPhone = new Map<string, number>();
  return prepared.map((r): Analysed => {
    if ("status" in r) return r;
    if (imported.has(r.key)) return { ...r, status: "already_imported" };
    const repeatOf = firstByKey.get(r.key) ?? null;
    const phoneRepeatOf = r.phone !== null ? (firstByPhone.get(r.phone) ?? null) : null;
    if (repeatOf === null) firstByKey.set(r.key, r.row);
    if (r.phone !== null && phoneRepeatOf === null) firstByPhone.set(r.phone, r.row);
    const matches = (r.phone !== null ? (byPhone.get(r.phone) ?? []) : []).map((m) => ({ ...m, sameName: sameName(m.name, r.input.name) }));
    const duplicateOfRow = repeatOf ?? phoneRepeatOf;
    if (matches.length === 0 && duplicateOfRow === null) return { ...r, status: "new" };
    return { ...r, status: "duplicate", matches, duplicateOfRow, exactRepeat: repeatOf !== null };
  });
}

function emptyTotals(): ImportTotals {
  return { rows: 0, new: 0, duplicate: 0, alreadyImported: 0, invalid: 0 };
}

function buildReport(sha256: string, table: ImportTable, mapping: ColumnMapping, rows: Analysed[]): ImportReport {
  const totals = { ...emptyTotals(), rows: rows.length };
  const out: ImportRowReport[] = [];
  let preview = 0;
  for (const r of rows) {
    if (r.status === "invalid") {
      totals.invalid += 1;
      out.push(r);
    } else if (r.status === "already_imported") {
      totals.alreadyImported += 1;
      out.push({ row: r.row, status: r.status, name: r.input.name });
    } else if (r.status === "duplicate") {
      totals.duplicate += 1;
      out.push({
        row: r.row,
        status: "duplicate",
        name: r.input.name,
        matches: r.matches.slice(0, MAX_MATCHES).map((m) => ({ patientNo: m.patientNo, name: m.name, sameName: m.sameName })),
        duplicateOfRow: r.duplicateOfRow,
        canFill: canFill(r),
        canCreate: !r.exactRepeat,
      });
    } else {
      totals.new += 1;
      if (preview < NEW_ROW_PREVIEW) {
        preview += 1;
        out.push({ row: r.row, status: "new", name: r.input.name, dob: r.input.dob ?? null });
      }
    }
  }
  return { fileSha256: sha256, headers: table.headers, mapping, ageColumns: ageColumns(table.headers, mapping), needsName: false, totals, rows: out };
}

/** Checks a file without writing anything: mapping (suggested on the first call), problems, duplicates, new rows. */
export async function dryRunPatientImport(ctx: ServiceContext, file: { bytes: Uint8Array }, rawMapping?: unknown): Promise<Result<ImportReport>> {
  if (!can(ctx.role, "patient.import")) return fail("forbidden", FORBIDDEN);
  const loaded = loadTable(file.bytes);
  if (!loaded.ok) return loaded;
  const { table, sha256 } = loaded.value;
  const mapping = mappingFor(rawMapping, table);
  if (!mapping.ok) return mapping;
  if (mapping.value.name === null) {
    return ok({ fileSha256: sha256, headers: table.headers, mapping: mapping.value, ageColumns: [], needsName: true, totals: emptyTotals(), rows: [] });
  }
  return withTenant(ctx.tenantId, async (tx) => {
    const today = clinicLocalDate(new Date(), await clinicTimeZoneIn(tx, ctx.tenantId));
    return ok(buildReport(sha256, table, mapping.value, await analyse(tx, ctx.tenantId, table, mapping.value, today)));
  });
}

type FillPlan = { patientId: string; set: Partial<typeof patients.$inferInsert>; changedFields: string[] };

/** Only empty details of the matched patient are filled; nothing that is already recorded is ever overwritten. */
async function planFill(tx: TenantTx, tenantId: string, patientId: string, input: PatientInput): Promise<FillPlan> {
  const plan: FillPlan = { patientId, set: {}, changedFields: [] };
  const [current] = await tx
    .select()
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId), isNull(patients.deletedAt)))
    .limit(1)
    .for("update");
  if (!current) return plan;
  const next = toPatientColumns(input);
  if (!current.dob && next.dob) {
    plan.set.dob = next.dob;
    plan.changedFields.push("dob");
  }
  if ((current.gender ?? "unknown") === "unknown" && next.gender !== "unknown") {
    plan.set.gender = next.gender;
    plan.changedFields.push("gender");
  }
  if (!current.address && next.address) {
    plan.set.address = next.address;
    plan.changedFields.push("address");
  }
  if ((current.allergies ?? []).length === 0 && next.allergies.length > 0) {
    plan.set.allergies = next.allergies;
    plan.changedFields.push("allergies");
  }
  if (!current.notes && next.notes) {
    plan.set.notes = next.notes;
    plan.changedFields.push("notes");
  }
  return plan;
}

/**
 * Imports the checked file in ONE transaction, under a per-clinic advisory lock (a double-click or a second tab
 * waits, then finds the rows as already imported). Rows are re-classified now; a duplicate is created or filled only
 * when the owner chose so and the choice is still allowed; everything else is skipped. Patient numbers come as one
 * block; every patient gets a `patient.created` event carrying the import id, every fill a `patient.updated` event
 * with field names, and the job a `patient_import.committed` event with counts.
 */
export async function commitPatientImport(
  ctx: ServiceContext,
  file: { bytes: Uint8Array },
  input: { mapping: unknown; decisions: unknown; expectedSha256: unknown },
): Promise<Result<CommitSummary>> {
  if (!can(ctx.role, "patient.import")) return fail("forbidden", FORBIDDEN);
  const loaded = loadTable(file.bytes);
  if (!loaded.ok) return loaded;
  const { table, sha256 } = loaded.value;
  if (input.expectedSha256 !== sha256) return fail("conflict", FILE_CHANGED, "file");
  const mapping = mappingFor(input.mapping ?? {}, table);
  if (!mapping.ok) return mapping;
  const decisions = decisionsSchema.safeParse(input.decisions ?? {});
  if (!decisions.success) return fail("invalid", BAD_DECISIONS, "decisions");
  const choice = (row: number): ImportDecision => decisions.data[String(row)] ?? "skip";

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<CommitSummary>> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`clinicpad:patient-import:${ctx.tenantId}`}, 0))`);
      const today = clinicLocalDate(new Date(), await clinicTimeZoneIn(tx, ctx.tenantId));
      const rows = await analyse(tx, ctx.tenantId, table, mapping.value, today);

      const toCreate = rows.filter(
        (r): r is Extract<Analysed, { status: "new" | "duplicate" }> =>
          r.status === "new" || (r.status === "duplicate" && !r.exactRepeat && choice(r.row) === "create"),
      );
      const plans: FillPlan[] = [];
      for (const r of rows) {
        if (r.status === "duplicate" && canFill(r) && choice(r.row) === "fill") plans.push(await planFill(tx, ctx.tenantId, r.matches[0].id, r.input));
      }
      const fills = plans.filter((p) => p.changedFields.length > 0);
      const alreadyImported = rows.filter((r) => r.status === "already_imported").length;
      const invalid = rows.filter((r) => r.status === "invalid").length;
      const skipped = rows.length - toCreate.length - fills.length - alreadyImported - invalid;

      const [job] = await tx
        .insert(patientImports)
        .values({
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          fileSha256: sha256,
          rowCount: rows.length,
          createdCount: toCreate.length,
          filledCount: fills.length,
          skippedCount: skipped,
          alreadyImportedCount: alreadyImported,
          invalidCount: invalid,
        })
        .returning({ id: patientImports.id });

      let first: number | null = null;
      if (toCreate.length > 0) {
        const start = await allocateNumbers(tx, ctx.tenantId, "patient", toCreate.length);
        first = start;
        const values = toCreate.map((r, i) => ({
          ...toPatientColumns(r.input),
          tenantId: ctx.tenantId,
          patientNo: start + i,
          createdBy: ctx.userId,
          importId: job.id,
          importRowKey: r.key,
        }));
        for (const chunk of chunks(values)) {
          const inserted = await tx.insert(patients).values(chunk).returning({ id: patients.id, patientNo: patients.patientNo });
          await recordAuditMany(
            tx,
            ctx,
            inserted.map((p) => ({ action: "patient.created", entityType: "patient", entityId: p.id, after: { patientNo: p.patientNo, importId: job.id } })),
          );
        }
      }
      for (const plan of fills) {
        await tx.update(patients).set(plan.set).where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, plan.patientId)));
        await recordAudit(tx, ctx, { action: "patient.updated", entityType: "patient", entityId: plan.patientId, after: { changedFields: plan.changedFields, importId: job.id } });
      }
      const summary = { created: toCreate.length, filled: fills.length, skipped, alreadyImported, invalid };
      await recordAudit(tx, ctx, { action: "patient_import.committed", entityType: "patient_import", entityId: job.id, after: { rowCount: rows.length, ...summary } });
      return ok({
        importId: job.id,
        ...summary,
        firstPatientNo: first,
        lastPatientNo: first === null ? null : first + toCreate.length - 1,
      });
    });
  } catch (error) {
    // The advisory lock serializes imports; a unique violation means someone else wrote the same rows anyway.
    if (pgErrorInfo(error).code === "23505") return fail("conflict", CONCURRENT);
    throw error;
  }
}
```

- [ ] **Step 8: Write the actions**

`src/server/actions/patient-import.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/server/auth/session";
import { IMPORT_LIMITS } from "@/lib/import/patient-rows";
import { commitPatientImport, dryRunPatientImport, type CommitSummary, type ImportReport } from "@/server/services/patient-import";

export type DryRunState = { report?: ImportReport; error?: string; field?: string };
export type CommitState = { summary?: CommitSummary; error?: string; field?: string };

// Plain module constants: a "use server" file may export only async functions and types.
const INTERNAL = "Something went wrong. Please try again.";
const MAX_JSON = 400_000;

/** The size is checked before the bytes are read; decodeCsvBytes decides what the bytes are. The file name and type are never read. */
async function readFile(formData: FormData): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const value = formData.get("file");
  if (!(value instanceof File) || value.size === 0) return { ok: false, error: "Choose a CSV file first." };
  if (value.size > IMPORT_LIMITS.maxBytes) return { ok: false, error: "The file is larger than 1 MB. Split it into smaller files." };
  return { ok: true, bytes: new Uint8Array(await value.arrayBuffer()) };
}

/** A JSON form field; anything unreadable becomes a value the service refuses (never a thrown error). */
function jsonField(formData: FormData, name: string): unknown {
  const value = formData.get(name);
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_JSON) return "unreadable";
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return "unreadable";
  }
}

export async function dryRunImportAction(formData: FormData): Promise<DryRunState> {
  const session = await requireSession();
  try {
    const file = await readFile(formData);
    if (!file.ok) return { error: file.error, field: "file" };
    const result = await dryRunPatientImport(session, { bytes: file.bytes }, jsonField(formData, "mapping"));
    return result.ok ? { report: result.value } : { error: result.message, field: result.field };
  } catch (error) {
    console.error("dryRunImportAction failed", error instanceof Error ? error.name : typeof error);
    return { error: INTERNAL };
  }
}

export async function commitImportAction(formData: FormData): Promise<CommitState> {
  const session = await requireSession();
  try {
    const file = await readFile(formData);
    if (!file.ok) return { error: file.error, field: "file" };
    const result = await commitPatientImport(session, { bytes: file.bytes }, {
      mapping: jsonField(formData, "mapping"),
      decisions: jsonField(formData, "decisions"),
      expectedSha256: formData.get("sha"),
    });
    if (!result.ok) return { error: result.message, field: result.field };
    revalidatePath("/patients");
    return { summary: result.value };
  } catch (error) {
    console.error("commitImportAction failed", error instanceof Error ? error.name : typeof error);
    return { error: INTERNAL };
  }
}
```

- [ ] **Step 9: Run the tests, the full suite, and commit**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/patient-import.test.ts tests/integration/patients.test.ts tests/unit/permissions.test.ts
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/db/schema/imports.ts src/server/db/schema/index.ts src/server/db/schema/clinical.ts drizzle/0019_phase1d_patient_import.sql drizzle/0020_phase1d_patient_import_security.sql drizzle/meta/0019_snapshot.json drizzle/meta/0020_snapshot.json drizzle/meta/_journal.json src/server/services/numbering.ts src/server/services/audit.ts src/server/services/patients.ts src/server/services/patient-import.ts src/server/actions/patient-import.ts src/lib/domain/permissions.ts tests/unit/permissions.test.ts tests/helpers/csv-files.ts tests/integration/patient-import.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(import): patient CSV dry-run and idempotent commit with duplicate decisions, numbers in one block, audit" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: patient-import 19 tests pass (the `it.each` file checks count four); `patients.test.ts` and `permissions.test.ts` pass; lint, typecheck and the suite are clean.

---

## Task 7: Patient import screen — choose a file, map columns, read the report, decide on duplicates, import

**Files:**
- Create: `src/app/(app)/patients/import/page.tsx`, `src/components/patients/import-wizard.tsx`, `src/components/patients/import-mapping.tsx`, `src/components/patients/import-report.tsx`
- Modify: `src/app/(app)/patients/page.tsx` (an "Import from CSV" link for `patient.import`)
- Test: `tests/unit/import-wizard.test.tsx`, `tests/e2e/patient-import.spec.ts`

**Interfaces:**
- Consumes: `dryRunImportAction(formData)`, `commitImportAction(formData)`, `DryRunState`, `CommitState` (Task 6); `ImportReport`, `ImportRowReport`, `ImportDecision`, `CommitSummary` (Task 6, type-only imports); `serializeCsv` (Task 5); `PATIENT_TEMPLATE_ROWS`, `IMPORT_FIELDS`, `IMPORT_FIELD_LABELS`, `ColumnMapping` (Task 5); `IMPORT_LIMITS` (Task 5); `can(role, "patient.import")`.
- Produces: `ImportWizard()` (client, no props); `ImportMapping({ headers, mapping, onChange, disabled })`; `ImportReportView({ report, decisions, onDecide, onDownloadProblems, disabled, headingRef })`; `downloadCsv(fileName: string, text: string): void` (exported from `import-wizard.tsx` for tests). Visible labels the e2e relies on: "CSV file", "Check file", "Check again", "Download the template", "N ready to import", "N possible duplicates", "N already imported", "N with problems", "Download problem rows", "Import N patients" / "Nothing to import", "Imported N patients".

- [ ] **Step 1: Write the failing component test**

`tests/unit/import-wizard.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ImportReport } from "@/server/services/patient-import";
import { serializeCsv } from "@/lib/csv";
import { PATIENT_TEMPLATE_ROWS } from "@/lib/import/patient-columns";
import { IMPORT_LIMITS } from "@/lib/import/patient-rows";

const actions = vi.hoisted(() => ({ dryRunImportAction: vi.fn(), commitImportAction: vi.fn() }));
vi.mock("@/server/actions/patient-import", () => actions);

import { ImportWizard } from "@/components/patients/import-wizard";

const REPORT: ImportReport = {
  fileSha256: "a".repeat(64),
  headers: ["Patient Name", "Mobile", "DOB", "Age"],
  mapping: { name: 0, phone: 1, dob: 2, gender: null, address: null, allergies: null, notes: null },
  ageColumns: ["Age"],
  needsName: false,
  totals: { rows: 4, new: 1, duplicate: 2, alreadyImported: 0, invalid: 1 },
  rows: [
    { row: 2, status: "new", name: "Asha Rao", dob: "1990-08-15" },
    { row: 3, status: "duplicate", name: "Meera Shah", matches: [{ patientNo: 7, name: "Meera Shah", sameName: true }], duplicateOfRow: null, canFill: true, canCreate: true },
    { row: 4, status: "duplicate", name: "Meera Shah", matches: [], duplicateOfRow: 3, canFill: false, canCreate: false },
    { row: 5, status: "invalid", field: "name", message: "Enter the patient's name", cells: ['=HYPERLINK("http://evil")', "+91 1", "", ""] },
  ],
};

const blobs: Blob[] = [];
function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(() => {
  actions.dryRunImportAction.mockReset();
  actions.commitImportAction.mockReset();
  blobs.length = 0;
  Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => (blobs.push(b), "blob:test")), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

function chooseFile(size = 100) {
  const file = new File(["x".repeat(size)], "patients.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
  return file;
}

describe("ImportWizard", () => {
  it("refuses a file over 1 MB in the browser, before anything is sent", () => {
    render(<ImportWizard />);
    chooseFile(IMPORT_LIMITS.maxBytes + 1);
    expect(screen.getByText("The file is larger than 1 MB. Split it into smaller files.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    expect(actions.dryRunImportAction).not.toHaveBeenCalled();
  });

  it("checks the file, shows the report, and imports with the owner's duplicate choices", async () => {
    actions.dryRunImportAction.mockResolvedValue({ report: REPORT });
    actions.commitImportAction.mockResolvedValue({
      summary: { importId: "i", created: 2, filled: 0, skipped: 1, alreadyImported: 0, invalid: 1, firstPatientNo: 8, lastPatientNo: 9 },
    });
    render(<ImportWizard />);
    const file = chooseFile();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    });
    const sent = actions.dryRunImportAction.mock.calls[0][0] as FormData;
    expect(sent.get("file")).toBe(file);
    expect(sent.get("mapping")).toBeNull();

    expect(await screen.findByText("1 ready to import")).toBeInTheDocument();
    expect(screen.getByText("2 possible duplicates")).toBeInTheDocument();
    expect(screen.getByText("1 with problems")).toBeInTheDocument();
    expect(screen.getByText(/Not imported: Age/)).toBeInTheDocument();
    expect(screen.getByText("Enter the patient's name")).toBeInTheDocument();
    expect(screen.getByLabelText("Name (required)")).toHaveValue("0");
    // An exact repeat in the file can only be skipped; filling is offered only for a single same-name match.
    expect(screen.getByRole("radio", { name: /Row 4.*Register as a new patient/ })).toBeDisabled();
    expect(screen.queryByRole("radio", { name: /Row 4.*Add the missing details/ })).toBeNull();

    expect(screen.getByRole("button", { name: "Import 1 patient" })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: /Row 3.*Register as a new patient/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import 2 patients" }));
    });
    const committed = actions.commitImportAction.mock.calls[0][0] as FormData;
    expect(JSON.parse(String(committed.get("decisions")))).toEqual({ "3": "create" });
    expect(JSON.parse(String(committed.get("mapping")))).toEqual(REPORT.mapping);
    expect(committed.get("sha")).toBe(REPORT.fileSha256);
    expect(await screen.findByText(/Imported 2 patients \(#8 to #9\)/)).toBeInTheDocument();
  });

  it("marks the report stale when the mapping changes, and checks again with the new mapping", async () => {
    actions.dryRunImportAction.mockResolvedValue({ report: REPORT });
    render(<ImportWizard />);
    chooseFile();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    });
    await screen.findByText("1 ready to import");
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "" } });
    expect(screen.queryByRole("button", { name: /^Import \d/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    });
    const sent = actions.dryRunImportAction.mock.calls[1][0] as FormData;
    expect(JSON.parse(String(sent.get("mapping")))).toMatchObject({ name: 0, phone: null });
  });

  it("downloads the problem rows as a formula-safe CSV with a BOM", async () => {
    actions.dryRunImportAction.mockResolvedValue({ report: REPORT });
    render(<ImportWizard />);
    chooseFile();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Download problem rows" }));
    const bytes = await readBytes(blobs[0]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text.split("\r\n")[0]).toBe("Patient Name,Mobile,DOB,Age,Row,Problem");
    expect(text).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(text).toContain("'+91 1");
    expect(text).toContain("Name: Enter the patient's name");
  });

  it("offers the template as a download", async () => {
    render(<ImportWizard />);
    fireEvent.click(screen.getByRole("button", { name: "Download the template" }));
    const bytes = await readBytes(blobs[0]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(serializeCsv(PATIENT_TEMPLATE_ROWS));
  });

  it("shows a server error and keeps the chosen file", async () => {
    actions.dryRunImportAction.mockResolvedValue({ error: "This file is not saved as UTF-8.", field: "file" });
    render(<ImportWizard />);
    chooseFile();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    });
    await waitFor(() => expect(screen.getByText("This file is not saved as UTF-8.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Check file" })).toBeEnabled();
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/import-wizard.test.tsx` — expected: FAIL, module not found.

- [ ] **Step 2: Write the mapping and report components**

`src/components/patients/import-mapping.tsx`:

```tsx
"use client";

import { Label } from "@/components/ui/label";
import { IMPORT_FIELDS, IMPORT_FIELD_LABELS, type ColumnMapping } from "@/lib/import/patient-columns";

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

type Props = { headers: string[]; mapping: ColumnMapping; onChange: (mapping: ColumnMapping) => void; disabled: boolean };

/** One select per patient field: which column of the file holds it, or "Not imported". */
export function ImportMapping({ headers, mapping, onChange, disabled }: Props) {
  return (
    <fieldset className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
      <legend className="px-1 font-medium">Which column holds what</legend>
      {IMPORT_FIELDS.map((field) => (
        <div key={field} className="space-y-1">
          <Label htmlFor={`map-${field}`}>
            {IMPORT_FIELD_LABELS[field]}
            {field === "name" ? " (required)" : ""}
          </Label>
          <select
            id={`map-${field}`}
            className={selectClass}
            disabled={disabled}
            value={mapping[field] === null ? "" : String(mapping[field])}
            onChange={(event) => onChange({ ...mapping, [field]: event.target.value === "" ? null : Number(event.target.value) })}
          >
            <option value="">Not imported</option>
            {headers.map((header, index) => (
              <option key={index} value={index}>
                {header}
              </option>
            ))}
          </select>
        </div>
      ))}
    </fieldset>
  );
}
```

`src/components/patients/import-report.tsx`:

```tsx
"use client";

import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { IMPORT_FIELD_LABELS } from "@/lib/import/patient-columns";
import type { ImportDecision, ImportReport, ImportRowReport } from "@/server/services/patient-import";

type Props = {
  report: ImportReport;
  decisions: Record<string, ImportDecision>;
  onDecide: (row: number, decision: ImportDecision) => void;
  onDownloadProblems: () => void;
  disabled: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
};

type Duplicate = Extract<ImportRowReport, { status: "duplicate" }>;
type Invalid = Extract<ImportRowReport, { status: "invalid" }>;
type Fresh = Extract<ImportRowReport, { status: "new" }>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fieldLabel = (field: Invalid["field"]) => (field === "row" ? "Row" : IMPORT_FIELD_LABELS[field]);

function matchText(r: Duplicate): string {
  const parts = r.matches.map((m) => `Patient #${m.patientNo ?? "?"} ${m.name}`);
  if (r.duplicateOfRow !== null) parts.push(`row ${r.duplicateOfRow} of this file`);
  return parts.join("; ");
}

function DecisionChoice({ r, value, onDecide, disabled }: { r: Duplicate; value: ImportDecision; onDecide: Props["onDecide"]; disabled: boolean }) {
  const options: { decision: ImportDecision; label: string; allowed: boolean }[] = [
    { decision: "skip", label: "Skip", allowed: true },
    { decision: "create", label: "Register as a new patient", allowed: r.canCreate },
    ...(r.canFill ? [{ decision: "fill" as const, label: "Add the missing details to the existing patient", allowed: true }] : []),
  ];
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="sr-only">{`Row ${r.row}: ${r.name}`}</legend>
      {options.map((o) => (
        <label key={o.decision} className="flex items-center gap-1">
          <input
            type="radio"
            name={`decision-${r.row}`}
            aria-label={`Row ${r.row}: ${o.label}`}
            checked={value === o.decision}
            disabled={disabled || !o.allowed}
            onChange={() => onDecide(r.row, o.decision)}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/** The dry-run result: totals, problems (downloadable), duplicates with a decision each, and a preview of new rows. */
export function ImportReportView({ report, decisions, onDecide, onDownloadProblems, disabled, headingRef }: Props) {
  const problems = report.rows.filter((r): r is Invalid => r.status === "invalid");
  const duplicates = report.rows.filter((r): r is Duplicate => r.status === "duplicate");
  const fresh = report.rows.filter((r): r is Fresh => r.status === "new");
  const { totals } = report;

  return (
    <section aria-labelledby="import-report-heading" className="space-y-4">
      <h2 id="import-report-heading" ref={headingRef} tabIndex={-1} className="text-lg font-medium">
        Check result
      </h2>
      <ul className="grid gap-2 text-sm sm:grid-cols-4">
        <li className="rounded border p-2">{plural(totals.new, "ready to import", "ready to import")}</li>
        <li className="rounded border p-2">{plural(totals.duplicate, "possible duplicate", "possible duplicates")}</li>
        <li className="rounded border p-2">{plural(totals.alreadyImported, "already imported", "already imported")}</li>
        <li className="rounded border p-2">{plural(totals.invalid, "with problems", "with problems")}</li>
      </ul>
      <p className="text-sm text-muted-foreground">Dates are read as day/month/year. Check the dates below before importing.</p>
      {report.ageColumns.length > 0 ? (
        <p role="note" className="text-sm">
          Not imported: {report.ageColumns.join(", ")}. ClinicPad needs a date of birth and never guesses one from an age.
        </p>
      ) : null}

      {problems.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium">Rows with problems (not imported)</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Row</th>
                <th className="p-2">Field</th>
                <th className="p-2">Problem</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {problems.map((r) => (
                <tr key={r.row}>
                  <td className="p-2">{r.row}</td>
                  <td className="p-2">{fieldLabel(r.field)}</td>
                  <td className="p-2">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button type="button" variant="outline" onClick={onDownloadProblems}>
            Download problem rows
          </Button>
        </div>
      ) : null}

      {duplicates.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium">Possible duplicates (skipped unless you choose otherwise)</h3>
          <ul className="divide-y rounded border text-sm">
            {duplicates.map((r) => (
              <li key={r.row} className="space-y-1 p-2">
                <p>
                  Row {r.row}: <span className="font-medium">{r.name}</span> — same phone as {matchText(r)}
                </p>
                <DecisionChoice r={r} value={decisions[String(r.row)] ?? "skip"} onDecide={onDecide} disabled={disabled} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {fresh.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-medium">New patients{totals.new > fresh.length ? ` (first ${fresh.length} of ${totals.new})` : ""}</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Row</th>
                <th className="p-2">Name</th>
                <th className="p-2">Date of birth</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {fresh.map((r) => (
                <tr key={r.row}>
                  <td className="p-2">{r.row}</td>
                  <td className="p-2">{r.name}</td>
                  <td className="p-2">{r.dob ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 3: Write the wizard**

`src/components/patients/import-wizard.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { serializeCsv } from "@/lib/csv";
import { PATIENT_TEMPLATE_ROWS, IMPORT_FIELD_LABELS, type ColumnMapping } from "@/lib/import/patient-columns";
import { IMPORT_LIMITS } from "@/lib/import/patient-rows";
import { commitImportAction, dryRunImportAction } from "@/server/actions/patient-import";
import type { CommitSummary, ImportDecision, ImportReport } from "@/server/services/patient-import";
import { ImportMapping } from "./import-mapping";
import { ImportReportView } from "./import-report";

const TOO_LARGE = "The file is larger than 1 MB. Split it into smaller files.";
const NO_FILE = "Choose a CSV file first.";
const FAILED = "Something went wrong. Please try again.";

/** Hands a CSV to the browser as a download (no server round trip; the text never leaves the page). */
export function downloadCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const same = (a: ColumnMapping | null, b: ColumnMapping | null) => JSON.stringify(a) === JSON.stringify(b);

function summaryText(s: CommitSummary): string {
  const parts = [
    `Imported ${s.created} patient${s.created === 1 ? "" : "s"}${s.firstPatientNo !== null ? ` (#${s.firstPatientNo} to #${s.lastPatientNo})` : ""}.`,
  ];
  if (s.filled > 0) parts.push(`Added missing details to ${s.filled}.`);
  if (s.skipped > 0) parts.push(`Skipped ${s.skipped}.`);
  if (s.alreadyImported > 0) parts.push(`${s.alreadyImported} were already imported.`);
  if (s.invalid > 0) parts.push(`${s.invalid} rows with problems were not imported.`);
  return parts.join(" ");
}

/**
 * Stateless import: the browser keeps the file and sends it to the dry-run and again to the commit, which refuses
 * a different file (SHA-256). Nothing is written until "Import".
 */
export function ImportWizard() {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>({});
  const [summary, setSummary] = useState<CommitSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const stale = report !== null && !same(mapping, report.mapping);
  const creates = report
    ? report.totals.new +
      report.rows.filter((r) => r.status === "duplicate" && r.canCreate && decisions[String(r.row)] === "create").length
    : 0;
  const fills = report ? report.rows.filter((r) => r.status === "duplicate" && r.canFill && decisions[String(r.row)] === "fill").length : 0;

  function choose(next: File | null) {
    setFile(next);
    setReport(null);
    setMapping(null);
    setDecisions({});
    setSummary(null);
    setError(next && next.size > IMPORT_LIMITS.maxBytes ? TOO_LARGE : null);
  }

  function check(withMapping: ColumnMapping | null) {
    if (!file) return setError(NO_FILE);
    if (file.size > IMPORT_LIMITS.maxBytes) return setError(TOO_LARGE);
    const form = new FormData();
    form.set("file", file);
    if (withMapping) form.set("mapping", JSON.stringify(withMapping));
    startTransition(async () => {
      const result = await dryRunImportAction(form);
      if (!result.report) {
        setError(result.error ?? FAILED);
        return;
      }
      setError(null);
      setReport(result.report);
      setMapping(result.report.mapping);
      setDecisions({});
      setSummary(null);
      requestAnimationFrame(() => headingRef.current?.focus());
    });
  }

  function commit() {
    if (!file || !report || !mapping) return;
    const form = new FormData();
    form.set("file", file);
    form.set("mapping", JSON.stringify(mapping));
    form.set("decisions", JSON.stringify(decisions));
    form.set("sha", report.fileSha256);
    startTransition(async () => {
      const result = await commitImportAction(form);
      if (!result.summary) {
        setError(result.error ?? FAILED);
        return;
      }
      setError(null);
      setSummary(result.summary);
    });
  }

  function downloadProblems() {
    if (!report) return;
    const rows = report.rows.flatMap((r) =>
      r.status === "invalid" ? [[...r.cells, String(r.row), `${r.field === "row" ? "Row" : IMPORT_FIELD_LABELS[r.field]}: ${r.message}`]] : [],
    );
    downloadCsv("import-problems.csv", serializeCsv([[...report.headers, "Row", "Problem"], ...rows]));
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="import-file">CSV file</Label>
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv,.txt,text/plain"
          className="block text-sm"
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
          aria-describedby="import-file-hint"
        />
        <p id="import-file-hint" className="text-xs text-muted-foreground">
          In Excel choose File, Save As, CSV UTF-8 (Comma delimited). Up to 1 MB and 5,000 patients. Dates as day/month/year.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => check(stale ? mapping : null)} disabled={pending || !file}>
            {stale ? "Check again" : "Check file"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => downloadCsv("patients-template.csv", serializeCsv(PATIENT_TEMPLATE_ROWS))}>
            Download the template
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {report && mapping ? (
        <>
          <ImportMapping headers={report.headers} mapping={mapping} onChange={setMapping} disabled={pending || summary !== null} />
          {report.needsName ? <p className="text-sm">Choose the column that holds the patient&apos;s name, then check again.</p> : null}
          {!report.needsName && !stale ? (
            <ImportReportView
              report={report}
              decisions={decisions}
              onDecide={(row, decision) => setDecisions((d) => ({ ...d, [String(row)]: decision }))}
              onDownloadProblems={downloadProblems}
              disabled={pending || summary !== null}
              headingRef={headingRef}
            />
          ) : null}
          {!report.needsName && !stale && summary === null ? (
            <Button type="button" onClick={commit} disabled={pending || creates + fills === 0}>
              {creates + fills === 0 ? "Nothing to import" : `Import ${creates} patient${creates === 1 ? "" : "s"}${fills > 0 ? ` and update ${fills}` : ""}`}
            </Button>
          ) : null}
        </>
      ) : null}

      {summary ? (
        <div role="status" className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
          <p>{summaryText(summary)}</p>
          <Link className="underline" href="/patients">
            Open the patient list
          </Link>
        </div>
      ) : null}
    </div>
  );
}
```

`src/app/(app)/patients/import/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ImportWizard } from "@/components/patients/import-wizard";

export const dynamic = "force-dynamic";

export default async function ImportPatientsPage() {
  const session = await requireSession();
  if (!can(session.role, "patient.import")) redirect("/patients");
  return (
    <div className="max-w-4xl space-y-4">
      <h1 className="text-2xl font-semibold">Import from CSV</h1>
      <p className="text-sm text-muted-foreground">
        Upload your patient list. ClinicPad checks every row first and imports nothing until you press Import. Patients who
        share a phone number with someone already registered are skipped unless you choose otherwise. Running the same file
        again never creates duplicates.
      </p>
      <ImportWizard />
    </div>
  );
}
```

In `src/app/(app)/patients/page.tsx`, next to the New patient button, add:

```tsx
        {can(session.role, "patient.import") && !showArchived ? (
          <Button asChild variant="outline">
            <Link href="/patients/import">Import from CSV</Link>
          </Button>
        ) : null}
```

(`showArchived` comes from Task 4.)

- [ ] **Step 4: Run the component test**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/import-wizard.test.tsx
```

Expected: PASS (6 tests). If `requestAnimationFrame` is missing in jsdom, it is not: jsdom provides it when `pretendToBeVisual` is on, which Vitest enables; if a test logs `requestAnimationFrame is not defined`, replace the call with `setTimeout(() => headingRef.current?.focus(), 0)`.

- [ ] **Step 5: Write the e2e flow**

`tests/e2e/patient-import.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, registerClinic, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

// Excel's "CSV UTF-8" export: a BOM, CRLF, an Age column, a Devanagari name, a date that does not exist.
const FILE = [
  "\uFEFFPatient Name,Mobile,DOB,Sex,Age",
  "Asha Import,98765 00001,15/08/1990,F,35",
  "सुनीता इम्पोर्ट,98765 00002,,F,",
  "Bad Date,98765 00003,31/02/1990,M,",
  "",
].join("\r\n");

async function upload(page: Page): Promise<void> {
  await page.goto("/patients/import");
  await page.getByLabel("CSV file").setInputFiles({ name: "patients.csv", mimeType: "text/csv", buffer: Buffer.from(FILE, "utf8") });
  await page.getByRole("button", { name: "Check file" }).click();
}

test("import a spreadsheet export with a validation report; a re-run imports nothing", async ({ page }) => {
  test.setTimeout(120_000);
  clinics.push(await registerClinic(page, "import"));
  await page.goto("/patients");
  await page.getByRole("link", { name: "Import from CSV" }).click();
  await expect(page.getByRole("heading", { name: "Import from CSV" })).toBeVisible();

  await upload(page);
  await expect(page.getByText("2 ready to import")).toBeVisible();
  await expect(page.getByText("1 with problems")).toBeVisible();
  await expect(page.getByText("This date does not exist.")).toBeVisible();
  await expect(page.getByText(/Not imported: Age/)).toBeVisible();
  await expect(page.getByRole("cell", { name: "1990-08-15" })).toBeVisible();

  await page.getByRole("button", { name: "Import 2 patients" }).click();
  await expect(page.getByText(/Imported 2 patients \(#1 to #2\)/)).toBeVisible();

  await page.goto("/patients");
  await expect(page.getByRole("link", { name: "Asha Import" })).toBeVisible();
  await expect(page.getByRole("link", { name: "सुनीता इम्पोर्ट" })).toBeVisible();

  await upload(page);
  await expect(page.getByText("2 already imported")).toBeVisible();
  await expect(page.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
});

test("non-owners cannot open the import page", async ({ page }) => {
  const clinic = await registerClinic(page, "import-role");
  clinics.push(clinic);
  const { setRole } = await import("./helpers");
  await setRole(clinic.email, "reception");
  await page.goto("/patients/import");
  await expect(page).toHaveURL(/\/patients$/);
  await expect(page.getByRole("link", { name: "Import from CSV" })).toHaveCount(0);
});
```

(Move `setRole` into the top-level import instead of the dynamic import when you write the file; it is shown inline here only to keep the second test self-explanatory.)

- [ ] **Step 6: Run the e2e, the full suite, and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/patient-import.spec.ts tests/e2e/patients.spec.ts
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add "src/app/(app)/patients/import/page.tsx" "src/app/(app)/patients/page.tsx" src/components/patients/import-wizard.tsx src/components/patients/import-mapping.tsx src/components/patients/import-report.tsx tests/unit/import-wizard.test.tsx tests/e2e/patient-import.spec.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(import): CSV import screen with column mapping, validation report, duplicate choices, problem-row download" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: patient-import e2e 2 passed, patients 5 passed; the suite clean.

---

## Task 8: Consent and the sharing schema — `patient_consents`, `share_links`, `prescription_shares`, the token policy, the clinic switch, and the consent card

**Files:**
- Create: `src/server/db/schema/sharing.ts`, `src/lib/domain/consent.ts`, `src/server/services/consent.ts`, `src/server/services/share-revocation.ts`, `src/server/actions/consent.ts`, `src/components/patients/consent-card.tsx`, `src/components/settings/sharing-form.tsx`
- Create: `drizzle/0021_phase1d_sharing.sql` (generated), `drizzle/0022_phase1d_sharing_security.sql` (custom), snapshots, journal entries
- Modify: `src/server/db/schema/index.ts` (export `./sharing`), `src/server/db/schema/tenancy.ts` (`clinics.sharingEnabled`), `src/server/db/schema/clinical.ts` (`prescriptionOutputs.shareLinkId`, its key, the kind CHECKs), `src/server/services/clinic.ts` (`getClinicSharing`, `setClinicSharing`), `src/server/actions/settings.ts` (`saveSharingAction`), `src/app/(app)/settings/page.tsx`, `src/app/(app)/patients/[id]/page.tsx` (consent card), `src/lib/domain/permissions.ts` + `tests/unit/permissions.test.ts` (`consent.capture`, `rx.share`), `tests/integration/rls-guard.test.ts` (the one allow-listed policy), `tests/unit/settings-forms.test.tsx` (a `SharingForm` case)
- Test: `tests/integration/sharing-schema.test.ts`, `tests/integration/consent.test.ts`, `tests/unit/consent-card.test.tsx`

**Interfaces:**
- Consumes: `patients`, `prescriptions`, `visits`, `clinics`, `prescriptionOutputs`; `primaryClinic(tx, tenantId, lock)`; `recordAudit`; `public.enforce_print_rows_immutable()` and `public.tenant_is_erased(uuid)`; `finalizeNow` / `saveDraftNow` (`tests/helpers/rx.ts`); `DiscardDraftForm` pattern; the settings actions' `asSession` helper and `SettingsFormState`.
- Produces:
  - Drizzle (exported from `@/server/db/schema`): `patientConsents` (`id`, `tenantId`, `patientId`, `purpose`, `version`, `granted`, `method`, `capturedBy`, `createdAt`), `shareLinks` (`id`, `tenantId`, `prescriptionId`, `consentId`, `tokenHash`, `channel`, `createdBy`, `createdAt`, `expiresAt`, `maxOpens`, `openCount`, `lastOpenedAt`, `revokedAt`, `revokedBy`, `revokeReason`), `prescriptionShares` (`id`, `tenantId`, `prescriptionId`, `shareLinkId`, `channel`, `recipientMasked`, `provider`, `status`, `providerMessageId`, `errorCode`, `actorUserId`, `createdAt`); `clinics.sharingEnabled: boolean` (default false); `prescriptionOutputs.shareLinkId: string | null`; output kind `"shared_pdf"`.
  - Database: forced RLS on the three tables; consents and shares append-only (select + insert; admin-level immutable); share links insert/select/update for the runtime role, never delete; trigger `share_links_rules` (only `open_count` +1, `last_opened_at`, and a one-time revocation may change); trigger `share_links_target` (only a `finalized` prescription of the same tenant, `23000` / `23503`); policy `share_link_by_token` (`FOR SELECT TO clinicpad_app USING (token_hash = nullif(current_setting('app.share_token_hash', true), ''))`).
  - `SHARING_CONSENT_VERSION = "sharing-v1"`, `CONSENT_METHODS = ["verbal","written"]`, `type ConsentMethod`, `CONSENT_TEXT` (`src/lib/domain/consent.ts`).
  - `type ConsentView = { id: string; granted: boolean; version: string; method: ConsentMethod; recordedAt: Date }`; `currentSharingConsentIn(tx, tenantId, patientId): Promise<ConsentView | null>`; `getSharingConsent(ctx, patientId): Promise<Result<ConsentView | null>>` (`patient.read`); `recordSharingConsent(ctx, patientId, raw: unknown): Promise<Result<ConsentView>>` (`consent.capture`; `{ method, confirmed: true }`); `withdrawSharingConsent(ctx, patientId, raw: unknown): Promise<Result<{ revokedLinks: number }>>` (`consent.capture`; `{ method }`).
  - `type RevokeReason = "user" | "consent_withdrawn" | "patient_archived" | "send_failed"`; `revokeActiveLinksForPatient(tx, tenantId, patientId, reason, actorUserId: string | null): Promise<number>` (`src/server/services/share-revocation.ts`; the caller holds the patient row lock).
  - `getClinicSharing(ctx): Promise<Result<{ enabled: boolean }>>`, `setClinicSharing(ctx, enabled: unknown): Promise<Result<{ enabled: boolean; changed: boolean }>>` (`settings.clinic`; audit `clinic.sharing_changed`).
  - Actions: `type ConsentFormState = { error?: string; field?: string; saved?: boolean }`; `recordConsentAction(patientId, prev, formData)` (fields `method`, `confirmed=yes`); `withdrawConsentAction(patientId, prev, formData)` (field `method`); `saveSharingAction(prev: SettingsFormState, formData)` (field `sharingEnabled=on`).
  - Components: `ConsentCard({ patientId, consent, canCapture, archived, timeZone })`; `SharingForm({ enabled })`.
  - Roles: `consent.capture` and `rx.share` = owner, doctor, reception.

- [ ] **Step 1: Add the two actions to the role matrix (test first)**

In `tests/unit/permissions.test.ts`, add to `granted`:

```ts
    "consent.capture": ["owner", "doctor", "reception"],
    "rx.share": ["owner", "doctor", "reception"],
```

and a case:

```ts
  it("lets owners, doctors and reception record consent and share; never nurses, pharmacists or accountants", () => {
    for (const action of ["consent.capture", "rx.share"] as const) {
      for (const role of ["owner", "doctor", "reception"]) expect(can(role, action)).toBe(true);
      for (const role of ["nurse", "pharmacist", "accountant", "mystery"]) expect(can(role, action)).toBe(false);
    }
  });
```

Then add the same two entries to `MATRIX` in `src/lib/domain/permissions.ts` (after `"rx.amend"`). Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/permissions.test.ts` — PASS.

- [ ] **Step 2: Write the failing schema test**

`tests/integration/sharing-schema.test.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { clinics, patientConsents, prescriptionOutputs, prescriptionShares, shareLinks } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientA = "";
let finalizedA = "";
let draftA = "";
let finalizedB = "";
let consentA = "";
let consentB = "";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const DAY = 86_400_000;

function linkValues(tenantId: string, prescriptionId: string, consentId: string, overrides: Partial<typeof shareLinks.$inferInsert> = {}) {
  const now = new Date();
  return { tenantId, prescriptionId, consentId, tokenHash: hash(), channel: "whatsapp", createdAt: now, expiresAt: new Date(now.getTime() + 7 * DAY), maxOpens: 10, ...overrides };
}

async function prescription(T: TestTenant, patientId: string, finalize: boolean): Promise<string> {
  const started = await startPrescription(T.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraftNow(T.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Schema Drug" }] });
  if (!saved.ok) throw new Error(saved.message);
  if (finalize) {
    const done = await finalizeNow(T.as("doctor"), started.value.prescriptionId);
    if (!done.ok) throw new Error(done.message);
  }
  return started.value.prescriptionId;
}

beforeAll(async () => {
  A = await createTestTenant("sharing-a");
  B = await createTestTenant("sharing-b");
  const pa = await createPatient(A.as("owner"), { name: "Share Schema A" });
  const pb = await createPatient(B.as("owner"), { name: "Share Schema B" });
  if (!pa.ok || !pb.ok) throw new Error("patients");
  patientA = pa.value.id;
  finalizedA = await prescription(A, patientA, true);
  draftA = await prescription(A, patientA, false);
  finalizedB = await prescription(B, pb.value.id, true);
  const [ca] = await adminDb
    .insert(patientConsents)
    .values({ tenantId: A.tenantId, patientId: patientA, purpose: "sharing", version: "sharing-v1", granted: true, method: "verbal" })
    .returning();
  const [cb] = await adminDb
    .insert(patientConsents)
    .values({ tenantId: B.tenantId, patientId: pb.value.id, purpose: "sharing", version: "sharing-v1", granted: true, method: "verbal" })
    .returning();
  consentA = ca.id;
  consentB = cb.id;
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("clinics.sharing_enabled", () => {
  it("is off by default", async () => {
    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(clinic.sharingEnabled).toBe(false);
  });
});

describe("patient_consents", () => {
  it("is tenant-isolated and append-only for the application role, and immutable for the admin connection", async () => {
    const [row] = await withTenant(A.tenantId, (tx) =>
      tx.insert(patientConsents).values({ tenantId: A.tenantId, patientId: patientA, purpose: "sharing", version: "sharing-v1", granted: false, method: "written" }).returning(),
    );
    expect(await withTenant(B.tenantId, (tx) => tx.select().from(patientConsents).where(eq(patientConsents.id, row.id)))).toHaveLength(0);
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(patientConsents).set({ granted: true }).where(eq(patientConsents.id, row.id))), "42501");
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(patientConsents).where(eq(patientConsents.id, row.id))), "42501");
    await expectCode(adminDb.update(patientConsents).set({ granted: true }).where(eq(patientConsents.id, row.id)), "23000");
    await expectCode(adminDb.delete(patientConsents).where(eq(patientConsents.id, row.id)), "23000");
  });

  it.each([
    ["an unknown purpose", { purpose: "marketing" }],
    ["an unknown method", { method: "sms" }],
    ["a malformed version", { version: "v1" }],
  ])("refuses %s (23514)", async (_label, overrides) => {
    await expectCode(
      adminDb.insert(patientConsents).values({ tenantId: A.tenantId, patientId: patientA, purpose: "sharing", version: "sharing-v1", granted: true, method: "verbal", ...overrides }),
      "23514",
    );
  });

  it("belongs to a patient of the same clinic (23503)", async () => {
    const [foreign] = await adminDb.select({ patientId: patientConsents.patientId }).from(patientConsents).where(eq(patientConsents.id, consentB));
    await expectCode(
      adminDb.insert(patientConsents).values({ tenantId: A.tenantId, patientId: foreign.patientId, purpose: "sharing", version: "sharing-v1", granted: true, method: "verbal" }),
      "23503",
    );
  });
});

describe("share_links", () => {
  it("accepts a link to a finalized prescription and refuses a draft (23000) or another clinic's prescription (23503)", async () => {
    await withTenant(A.tenantId, (tx) => tx.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)));
    await expectCode(withTenant(A.tenantId, (tx) => tx.insert(shareLinks).values(linkValues(A.tenantId, draftA, consentA))), "23000");
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedB, consentA)), "23503");
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentB)), "23503");
  });

  it("lets only the open counter move up by one and a single revocation happen; never a delete", async () => {
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)).returning();
    const where = eq(shareLinks.id, link.id);
    await withTenant(A.tenantId, (tx) => tx.update(shareLinks).set({ openCount: 1, lastOpenedAt: new Date() }).where(where));
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(shareLinks).set({ openCount: 3 }).where(where)), "23000");
    await expectCode(adminDb.update(shareLinks).set({ tokenHash: hash() }).where(where), "23000");
    await expectCode(adminDb.update(shareLinks).set({ expiresAt: new Date(Date.now() + 9 * DAY) }).where(where), "23000");
    await withTenant(A.tenantId, (tx) => tx.update(shareLinks).set({ revokedAt: new Date(), revokeReason: "user" }).where(where));
    await expectCode(adminDb.update(shareLinks).set({ openCount: 2 }).where(where), "23000");
    await expectCode(adminDb.update(shareLinks).set({ revokedAt: null, revokeReason: null }).where(where), "23000");
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(shareLinks).where(where)), "42501");
    await expectCode(adminDb.delete(shareLinks).where(where), "23000");
  });

  it.each([
    ["an unknown channel", { channel: "sms" }],
    ["no allowed opens", { maxOpens: 0 }],
    ["an expiry before creation", { expiresAt: new Date(Date.now() - DAY) }],
    ["an expiry over 31 days away", { expiresAt: new Date(Date.now() + 40 * DAY) }],
    ["a malformed token hash", { tokenHash: "abc" }],
    ["a revocation without a reason", { revokedAt: new Date() }],
  ])("refuses %s (23514)", async (_label, overrides) => {
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA, overrides)), "23514");
  });

  it("keeps token hashes unique (23505)", async () => {
    const tokenHash = hash();
    await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA, { tokenHash }));
    await expectCode(adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA, { tokenHash })), "23505");
  });
});

describe("the share-token policy", () => {
  it("lets a session with no tenant read exactly the link whose token hash it names, and nothing else", async () => {
    const tokenHash = hash();
    const [link] = await adminDb.insert(shareLinks).values(linkValues(B.tenantId, finalizedB, consentB, { tokenHash })).returning();
    const lookup = (value: string | null) =>
      db.transaction(async (tx) => {
        if (value !== null) await tx.execute(sql`select set_config('app.share_token_hash', ${value}, true)`);
        return tx.select({ id: shareLinks.id, tenantId: shareLinks.tenantId }).from(shareLinks);
      });
    expect(await lookup(tokenHash)).toEqual([{ id: link.id, tenantId: B.tenantId }]);
    expect(await lookup(hash())).toEqual([]);
    expect(await lookup(null)).toEqual([]);
    // SELECT only: the same session cannot change the link.
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.share_token_hash', ${tokenHash}, true)`);
      return tx.update(shareLinks).set({ openCount: 1 }).where(eq(shareLinks.id, link.id)).returning({ id: shareLinks.id });
    });
    expect(updated).toEqual([]);
  });
});

describe("prescription_shares", () => {
  it("is append-only and refuses unknown values", async () => {
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)).returning();
    const share = { tenantId: A.tenantId, prescriptionId: finalizedA, shareLinkId: link.id, channel: "whatsapp", recipientMasked: "+91******3210", provider: "wa_link", status: "prepared" };
    const [row] = await withTenant(A.tenantId, (tx) => tx.insert(prescriptionShares).values(share).returning());
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(prescriptionShares).set({ status: "sent" }).where(eq(prescriptionShares.id, row.id))), "42501");
    await expectCode(adminDb.update(prescriptionShares).set({ status: "sent" }).where(eq(prescriptionShares.id, row.id)), "23000");
    await expectCode(adminDb.insert(prescriptionShares).values({ ...share, status: "delivered" }), "23514");
    await expectCode(adminDb.insert(prescriptionShares).values({ ...share, provider: "twilio" }), "23514");
    await expectCode(adminDb.insert(prescriptionShares).values({ ...share, errorCode: "Bad Things!" }), "23514");
  });
});

describe("prescription_outputs from a share link", () => {
  it("needs a link for kind shared_pdf, and only then", async () => {
    const [link] = await adminDb.insert(shareLinks).values(linkValues(A.tenantId, finalizedA, consentA)).returning();
    const output = { tenantId: A.tenantId, prescriptionId: finalizedA, templateKey: "general", paperSize: "A4", htmlSha256: "b".repeat(64) };
    await adminDb.insert(prescriptionOutputs).values({ ...output, kind: "shared_pdf", shareLinkId: link.id, actorUserId: null });
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...output, kind: "shared_pdf" }), "23514");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...output, kind: "browser_print", shareLinkId: link.id }), "23514");
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/sharing-schema.test.ts` — expected: FAIL (the tables and columns do not exist).

- [ ] **Step 3: Write the schema**

`src/server/db/schema/sharing.ts`:

```ts
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
// patients and prescriptions are only used inside the lazy config callbacks below, so the import cycle with
// clinical.ts (which references shareLinks the same way) is safe.
import { patients, prescriptions } from "./clinical";
import { tenants } from "./tenancy";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * DPDP-style consent as an append-only event log (Plan 1D): the latest row per patient and purpose is the current
 * state; withdrawal is a row with granted = false. Never updated or deleted (0022).
 */
export const patientConsents = pgTable(
  "patient_consents",
  {
    id: pk(),
    tenantId: tenantId(),
    patientId: uuid("patient_id").notNull(),
    purpose: text("purpose").notNull(),
    version: text("version").notNull(),
    granted: boolean("granted").notNull(),
    method: text("method").notNull(),
    capturedBy: uuid("captured_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("patient_consents_tenant_id_uq").on(t.tenantId, t.id),
    index("patient_consents_patient_idx").on(t.tenantId, t.patientId, t.purpose, t.createdAt),
    foreignKey({ name: "patient_consents_patient_fk", columns: [t.tenantId, t.patientId], foreignColumns: [patients.tenantId, patients.id] }),
    check("patient_consents_purpose_check", sql`purpose in ('sharing')`),
    check("patient_consents_method_check", sql`method in ('verbal', 'written')`),
    check("patient_consents_version_check", sql`version ~ '^[a-z]+-v[0-9]{1,3}$'`),
  ],
);

/**
 * A short-lived public link to one finalized prescription. Only the SHA-256 of the token is stored. The runtime role
 * may count an open (+1) and revoke once; nothing else changes and nothing is deleted (0022).
 */
export const shareLinks = pgTable(
  "share_links",
  {
    id: pk(),
    tenantId: tenantId(),
    prescriptionId: uuid("prescription_id").notNull(),
    consentId: uuid("consent_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    channel: text("channel").notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxOpens: integer("max_opens").notNull(),
    openCount: integer("open_count").notNull().default(0),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    unique("share_links_tenant_id_uq").on(t.tenantId, t.id),
    unique("share_links_token_hash_uq").on(t.tokenHash),
    index("share_links_prescription_idx").on(t.tenantId, t.prescriptionId, t.createdAt),
    index("share_links_creator_idx").on(t.tenantId, t.createdBy, t.createdAt),
    index("share_links_consent_idx").on(t.tenantId, t.consentId),
    foreignKey({
      name: "share_links_prescription_fk",
      columns: [t.tenantId, t.prescriptionId],
      foreignColumns: [prescriptions.tenantId, prescriptions.id],
    }).onDelete("cascade"),
    foreignKey({ name: "share_links_consent_fk", columns: [t.tenantId, t.consentId], foreignColumns: [patientConsents.tenantId, patientConsents.id] }),
    check("share_links_channel_check", sql`channel in ('whatsapp', 'email')`),
    check("share_links_token_hash_check", sql`token_hash ~ '^[0-9a-f]{64}$'`),
    check("share_links_opens_check", sql`max_opens between 1 and 50 and open_count between 0 and max_opens`),
    check("share_links_expiry_check", sql`expires_at > created_at and expires_at <= created_at + interval '31 days'`),
    check(
      "share_links_revocation_check",
      sql`(revoked_at is null) = (revoke_reason is null) and (revoke_reason is null or revoke_reason in ('user', 'consent_withdrawn', 'patient_archived', 'send_failed'))`,
    ),
  ],
);

/** Append-only share log: one row per WhatsApp message prepared or email sent/failed. Recipients are masked, never stored in full. */
export const prescriptionShares = pgTable(
  "prescription_shares",
  {
    id: pk(),
    tenantId: tenantId(),
    prescriptionId: uuid("prescription_id").notNull(),
    shareLinkId: uuid("share_link_id").notNull(),
    channel: text("channel").notNull(),
    recipientMasked: text("recipient_masked").notNull(),
    provider: text("provider").notNull(),
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    actorUserId: uuid("actor_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("rx_shares_prescription_idx").on(t.tenantId, t.prescriptionId, t.createdAt),
    index("rx_shares_link_idx").on(t.tenantId, t.shareLinkId),
    foreignKey({
      name: "rx_shares_prescription_fk",
      columns: [t.tenantId, t.prescriptionId],
      foreignColumns: [prescriptions.tenantId, prescriptions.id],
    }).onDelete("cascade"),
    foreignKey({ name: "rx_shares_link_fk", columns: [t.tenantId, t.shareLinkId], foreignColumns: [shareLinks.tenantId, shareLinks.id] }).onDelete("cascade"),
    check("rx_shares_channel_check", sql`channel in ('whatsapp', 'email')`),
    check("rx_shares_provider_check", sql`provider in ('wa_link', 'resend', 'fake')`),
    check("rx_shares_status_check", sql`status in ('prepared', 'sent', 'failed')`),
    check("rx_shares_recipient_check", sql`char_length(recipient_masked) between 1 and 64`),
    check("rx_shares_error_check", sql`error_code is null or error_code ~ '^[a-z_]{1,40}$'`),
    check("rx_shares_message_id_check", sql`provider_message_id is null or char_length(provider_message_id) <= 200`),
  ],
);
```

In `src/server/db/schema/index.ts` add `export * from "./sharing";`. In `src/server/db/schema/tenancy.ts`, add `boolean` is already imported; add to `clinics` after `logoAssetId`:

```ts
    /** Sharing by link (WhatsApp, email) is off until the owner turns it on (Plan 1D). Turning it off kills every link of the clinic. */
    sharingEnabled: boolean("sharing_enabled").notNull().default(false),
```

In `src/server/db/schema/clinical.ts`, add `import { shareLinks } from "./sharing";`, add to `prescriptionOutputs` after `rendererVersion`:

```ts
    /** Set only for kind 'shared_pdf': the link the patient opened (no actor then). */
    shareLinkId: uuid("share_link_id"),
```

and in its config array replace the `rx_outputs_kind_check` line with:

```ts
    check("rx_outputs_kind_check", sql`kind in ('pdf_download', 'browser_print', 'shared_pdf')`),
    check("rx_outputs_share_link_check", sql`(kind = 'shared_pdf') = (share_link_id is not null)`),
    foreignKey({
      name: "rx_outputs_share_link_fk",
      columns: [t.tenantId, t.shareLinkId],
      foreignColumns: [shareLinks.tenantId, shareLinks.id],
    }),
```

- [ ] **Step 4: Generate the table migration and write the security migration**

```powershell
Set-Location E:\projects\clinicpad; npx drizzle-kit generate --name=phase1d_sharing
Set-Location E:\projects\clinicpad; npx drizzle-kit generate --custom --name=phase1d_sharing_security
```

Expected: `drizzle/0021_phase1d_sharing.sql` creates the three tables (their `*_tenant_id_uq` and `share_links_token_hash_uq` inside `CREATE TABLE`), adds `clinics.sharing_enabled` and `prescription_outputs.share_link_id`, drops and re-adds `rx_outputs_kind_check`, adds `rx_outputs_share_link_check`, the keys and indexes. **Check the order by hand:** every `ADD CONSTRAINT ... FOREIGN KEY` must come after the `CREATE TABLE` of the table it references (`patient_consents` before `share_links` before `prescription_shares`, and `share_links` before `rx_outputs_share_link_fk`); move statements if drizzle-kit did not. Then replace the content of `drizzle/0022_phase1d_sharing_security.sql` with:

```sql
-- Plan 1D sharing (custom migration): RLS, privileges, the share-token lookup policy, and the link rules.

-- 1. Consents and the share log: forced RLS, append-only for the runtime role, immutable on every connection.
alter table patient_consents enable row level security;
--> statement-breakpoint
alter table patient_consents force row level security;
--> statement-breakpoint
alter table prescription_shares enable row level security;
--> statement-breakpoint
alter table prescription_shares force row level security;
--> statement-breakpoint
create policy tenant_read on patient_consents for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on patient_consents for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_read on prescription_shares for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on prescription_shares for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on patient_consents, prescription_shares to clinicpad_app;
--> statement-breakpoint
revoke update, delete, truncate on patient_consents, prescription_shares from clinicpad_app;
--> statement-breakpoint
create trigger patient_consents_immutable before update or delete on patient_consents
  for each row execute function public.enforce_print_rows_immutable();
--> statement-breakpoint
create trigger prescription_shares_immutable before update or delete on prescription_shares
  for each row execute function public.enforce_print_rows_immutable();
--> statement-breakpoint

-- 2. Share links: the runtime role reads, creates and updates its own tenant's links (open counter, revocation), never deletes.
alter table share_links enable row level security;
--> statement-breakpoint
alter table share_links force row level security;
--> statement-breakpoint
create policy tenant_read on share_links for select using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_insert on share_links for insert with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
create policy tenant_update on share_links for update
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- The one policy without app.tenant_id (allow-listed in tests/integration/rls-guard.test.ts): the public link route
-- (withShareToken, src/server/db/share-token.ts) sets app.share_token_hash to the SHA-256 of the token in the URL
-- and may read exactly that row, to learn its tenant. Knowing a 256-bit hash is equivalent to holding the token.
create policy share_link_by_token on share_links for select to clinicpad_app
  using (token_hash = nullif(current_setting('app.share_token_hash', true), ''));
--> statement-breakpoint
grant select, insert, update on share_links to clinicpad_app;
--> statement-breakpoint
revoke delete, truncate on share_links from clinicpad_app;
--> statement-breakpoint

-- 3. Only the open counter (+1 at a time) and a single revocation may change; a revoked link never changes again.
create or replace function public.enforce_share_link_rules() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    -- Prescriptions are deleted only as drafts, and drafts are never shared: this is tenant offboarding only.
    if public.tenant_is_erased(old.tenant_id) then return old; end if;
    raise exception 'IMMUTABLE: share links cannot be deleted' using errcode = '23000';
  end if;
  if old.revoked_at is not null and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'IMMUTABLE: a withdrawn share link stays withdrawn and is never opened again' using errcode = '23000';
  end if;
  if (to_jsonb(new) - 'open_count' - 'last_opened_at' - 'revoked_at' - 'revoked_by' - 'revoke_reason')
     is distinct from (to_jsonb(old) - 'open_count' - 'last_opened_at' - 'revoked_at' - 'revoked_by' - 'revoke_reason') then
    raise exception 'IMMUTABLE: only the open counter and the revocation of a share link can change' using errcode = '23000';
  end if;
  if new.open_count not in (old.open_count, old.open_count + 1) then
    raise exception 'IMMUTABLE: a share link is opened one at a time' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger share_links_rules before update or delete on share_links
  for each row execute function public.enforce_share_link_rules();
--> statement-breakpoint

-- 4. A link points only at a finalized prescription of its own tenant (23503 for a missing or foreign one first,
--    then 23000 for any other status; the lookup runs as the caller, so RLS applies).
create or replace function public.enforce_share_link_target() returns trigger language plpgsql as $$
declare
  rx_status text;
begin
  select status into rx_status from public.prescriptions where id = new.prescription_id and tenant_id = new.tenant_id;
  if rx_status is null then
    raise exception 'prescription not found for this tenant' using errcode = '23503';
  end if;
  if rx_status <> 'finalized' then
    raise exception 'IMMUTABLE: only a finalized prescription can be shared' using errcode = '23000';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger share_links_target before insert on share_links
  for each row execute function public.enforce_share_link_target();
```

Apply:

```powershell
Set-Location E:\projects\clinicpad; npm run db:migrate
Set-Location E:\projects\clinicpad; npx drizzle-kit generate
```

Expected: applied; "No schema changes".

- [ ] **Step 5: Allow-list the token policy in the RLS guard, pinned to SELECT by the application role**

In `tests/integration/rls-guard.test.ts`, set:

```ts
const NON_TENANT_POLICIES: Record<string, string> = {
  "share_links.share_link_by_token":
    "The public link route reads one row by the SHA-256 of its token to learn the tenant (Plan 1D decision 7); SELECT only, clinicpad_app only.",
};
```

and add:

```ts
  it("keeps the share-token policy SELECT-only, for the application role, keyed on the token hash", async () => {
    const [p] = await adminDb.execute<{ cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(sql`
      select cmd::text as cmd, roles::text[] as roles, qual, with_check from pg_policies
       where schemaname = 'public' and tablename = 'share_links' and policyname = 'share_link_by_token'`);
    expect(p).toMatchObject({ cmd: "SELECT", roles: ["clinicpad_app"], with_check: null });
    expect(p.qual).toContain("app.share_token_hash");
    expect(p.qual).not.toContain("app.tenant_id");
  });
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/sharing-schema.test.ts tests/integration/rls-guard.test.ts tests/integration/tenant-fk.test.ts tests/integration/schema-checks.test.ts tests/integration/print-schema.test.ts` — expected: PASS (sharing-schema 18; rls-guard 8; the FK guard sees only composite keys; every new CHECK is declared; print-schema unchanged with the widened kind check).

- [ ] **Step 6: Write the failing consent test**

`tests/integration/consent.test.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, patientConsents, patients, shareLinks } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { getSharingConsent, recordSharingConsent, withdrawSharingConsent } from "@/server/services/consent";
import { getClinicSharing, setClinicSharing } from "@/server/services/clinic";
import { SHARING_CONSENT_VERSION } from "@/lib/domain/consent";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

async function patient(name: string, T: TestTenant = A): Promise<string> {
  const created = await createPatient(T.as("reception"), { name });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

async function finalizedFor(patientId: string): Promise<string> {
  const started = await startPrescription(A.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  await saveDraftNow(A.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Consent Drug" }] });
  const done = await finalizeNow(A.as("doctor"), started.value.prescriptionId);
  if (!done.ok) throw new Error(done.message);
  return started.value.prescriptionId;
}

async function linkFor(prescriptionId: string, consentId: string): Promise<string> {
  const now = new Date();
  const [row] = await adminDb
    .insert(shareLinks)
    .values({
      tenantId: A.tenantId,
      prescriptionId,
      consentId,
      tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      channel: "whatsapp",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      maxOpens: 10,
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  A = await createTestTenant("consent-a");
  B = await createTestTenant("consent-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("recordSharingConsent", () => {
  it("records the current consent version, by whom and how, and audits ids only", async () => {
    const id = await patient("Consent Asha");
    // as("reception") returns a new random user id on every call: keep one context for the call and the assertion.
    const reception = A.as("reception");
    const recorded = await recordSharingConsent(reception, id, { method: "verbal", confirmed: true });
    expect(recorded).toMatchObject({ ok: true, value: { granted: true, version: SHARING_CONSENT_VERSION, method: "verbal" } });
    if (!recorded.ok) return;
    const [row] = await adminDb.select().from(patientConsents).where(eq(patientConsents.id, recorded.value.id));
    expect(row).toMatchObject({ purpose: "sharing", capturedBy: reception.userId });
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "patient.consent_recorded"), eq(auditEvents.entityId, id)));
    expect(event.after).toEqual({ consentId: recorded.value.id, purpose: "sharing", version: SHARING_CONSENT_VERSION, method: "verbal" });
    expect(JSON.stringify(event)).not.toContain("Consent Asha");
  });

  it("does not write a second row while the same consent is already recorded", async () => {
    const id = await patient("Consent Twice");
    const first = await recordSharingConsent(A.as("doctor"), id, { method: "written", confirmed: true });
    const second = await recordSharingConsent(A.as("doctor"), id, { method: "written", confirmed: true });
    expect(first.ok && second.ok && second.value.id).toBe(first.ok ? first.value.id : "");
    expect(await adminDb.select().from(patientConsents).where(eq(patientConsents.patientId, id))).toHaveLength(1);
  });

  it.each([
    [{ method: "verbal", confirmed: false }, "confirmed"],
    [{ method: "verbal" }, "confirmed"],
    [{ method: "sms", confirmed: true }, "method"],
  ])("refuses %j (field %s)", async (raw, field) => {
    const id = await patient("Consent Invalid");
    expect(await recordSharingConsent(A.as("owner"), id, raw)).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("is refused to nurses, pharmacists and accountants, and for unknown, archived or foreign patients", async () => {
    const id = await patient("Consent Roles");
    for (const role of ["nurse", "pharmacist", "accountant"]) {
      expect(await recordSharingConsent(A.as(role), id, { method: "verbal", confirmed: true })).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await recordSharingConsent(A.as("owner"), "x", { method: "verbal", confirmed: true })).toMatchObject({ ok: false, code: "not_found" });
    expect(await recordSharingConsent(B.as("owner"), id, { method: "verbal", confirmed: true })).toMatchObject({ ok: false, code: "not_found" });
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, id));
    expect(await recordSharingConsent(A.as("owner"), id, { method: "verbal", confirmed: true })).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("getSharingConsent", () => {
  it("is null without a record, and the latest event otherwise", async () => {
    const id = await patient("Consent Latest");
    expect(await getSharingConsent(A.as("nurse"), id)).toEqual({ ok: true, value: null });
    await recordSharingConsent(A.as("owner"), id, { method: "verbal", confirmed: true });
    await withdrawSharingConsent(A.as("owner"), id, { method: "written" });
    expect(await getSharingConsent(A.as("nurse"), id)).toMatchObject({ ok: true, value: { granted: false, method: "written" } });
    expect(await getSharingConsent(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("withdrawSharingConsent", () => {
  it("records the withdrawal and revokes every open link of that patient, and only that patient", async () => {
    const id = await patient("Consent Withdraw");
    const other = await patient("Consent Other");
    const granted = await recordSharingConsent(A.as("owner"), id, { method: "verbal", confirmed: true });
    const otherGranted = await recordSharingConsent(A.as("owner"), other, { method: "verbal", confirmed: true });
    if (!granted.ok || !otherGranted.ok) throw new Error("consent");
    const rx = await finalizedFor(id);
    const otherRx = await finalizedFor(other);
    const mine = [await linkFor(rx, granted.value.id), await linkFor(rx, granted.value.id)];
    const theirs = await linkFor(otherRx, otherGranted.value.id);

    expect(await withdrawSharingConsent(A.as("reception"), id, { method: "verbal" })).toEqual({ ok: true, value: { revokedLinks: 2 } });
    const rows = await adminDb.select().from(shareLinks).where(eq(shareLinks.tenantId, A.tenantId));
    for (const linkId of mine) expect(rows.find((r) => r.id === linkId)).toMatchObject({ revokeReason: "consent_withdrawn" });
    expect(rows.find((r) => r.id === theirs)).toMatchObject({ revokedAt: null });
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "patient.consent_withdrawn"), eq(auditEvents.entityId, id)));
    expect(event.after).toMatchObject({ purpose: "sharing", revokedLinks: 2 });
  });

  it("answers conflict when no consent is on record", async () => {
    const id = await patient("Consent None");
    expect(await withdrawSharingConsent(A.as("owner"), id, { method: "verbal" })).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("the clinic sharing switch", () => {
  it("is owner-only, refuses non-booleans, and audits only a real change", async () => {
    expect(await getClinicSharing(A.as("owner"))).toEqual({ ok: true, value: { enabled: false } });
    expect(await setClinicSharing(A.as("doctor"), true)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setClinicSharing(A.as("owner"), "yes")).toMatchObject({ ok: false, code: "invalid" });
    expect(await setClinicSharing(A.as("owner"), true)).toEqual({ ok: true, value: { enabled: true, changed: true } });
    expect(await setClinicSharing(A.as("owner"), true)).toEqual({ ok: true, value: { enabled: true, changed: false } });
    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(clinic.sharingEnabled).toBe(true);
    const events = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "clinic.sharing_changed")));
    expect(events.map((e) => e.after)).toEqual([{ enabled: true }]);
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/consent.test.ts` — expected: FAIL, modules not found.

- [ ] **Step 7: Write the consent text, the services, and the revocation helper**

`src/lib/domain/consent.ts`:

```ts
/** The version key stored with every grant. A reworded text gets a new key; old grants keep theirs. */
export const SHARING_CONSENT_VERSION = "sharing-v1";
export const CONSENT_METHODS = ["verbal", "written"] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/*
 * NEEDS LEGAL REVIEW (English) and NATIVE-SPEAKER REVIEW (Hindi) before any clinic turns sharing on (Plan 1D, human
 * decision). Sharing is off per clinic until then (clinics.sharing_enabled).
 */
export const CONSENT_TEXT: Record<typeof SHARING_CONSENT_VERSION, { en: string; hi: string }> = {
  "sharing-v1": {
    en: "I agree that the clinic may send my prescription to me, or to a person I name, through WhatsApp or email, as a link that stops working after a few days. I understand that these services are run by other companies, and that I can withdraw this agreement at the clinic at any time.",
    hi: "मैं सहमत हूँ कि क्लिनिक मेरा पर्चा मुझे, या मेरे बताए व्यक्ति को, व्हाट्सऐप या ईमेल से एक ऐसे लिंक के रूप में भेज सकता है जो कुछ दिनों बाद काम करना बंद कर देता है। मैं समझता/समझती हूँ कि ये सेवाएँ दूसरी कंपनियाँ चलाती हैं, और मैं क्लिनिक में कभी भी यह सहमति वापस ले सकता/सकती हूँ।",
  },
};
```

`src/server/services/share-revocation.ts`:

```ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import { prescriptions, shareLinks, visits } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";

export type RevokeReason = "user" | "consent_withdrawn" | "patient_archived" | "send_failed";

/**
 * Withdraws every not-yet-withdrawn link to any prescription of the patient (expired and used-up ones too, so the
 * record says why each link ended). The caller must hold the patient row lock (Plan 1D decision 13), so a link
 * created concurrently either committed before (and is revoked here) or waits and then sees the new state.
 */
export async function revokeActiveLinksForPatient(
  tx: TenantTx,
  tenantId: string,
  patientId: string,
  reason: RevokeReason,
  actorUserId: string | null,
): Promise<number> {
  const ofPatient = tx
    .select({ id: prescriptions.id })
    .from(prescriptions)
    .innerJoin(visits, eq(visits.id, prescriptions.visitId))
    .where(and(eq(visits.tenantId, tenantId), eq(visits.patientId, patientId)));
  const revoked = await tx
    .update(shareLinks)
    .set({ revokedAt: new Date(), revokedBy: actorUserId, revokeReason: reason })
    .where(and(eq(shareLinks.tenantId, tenantId), isNull(shareLinks.revokedAt), inArray(shareLinks.prescriptionId, ofPatient)))
    .returning({ id: shareLinks.id });
  return revoked.length;
}
```

`src/server/services/consent.ts`:

```ts
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { CONSENT_METHODS, SHARING_CONSENT_VERSION, type ConsentMethod } from "@/lib/domain/consent";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { patientConsents, patients } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { revokeActiveLinksForPatient } from "./share-revocation";

export type ConsentView = { id: string; granted: boolean; version: string; method: ConsentMethod; recordedAt: Date };

const PURPOSE = "sharing";
const notFound = () => fail("not_found", "Patient not found.");
const method = z.enum(CONSENT_METHODS, { error: "Choose how the patient gave consent." });
const recordSchema = z.object({
  method,
  confirmed: z.literal(true, { error: "Confirm that the patient agreed to the text above." }),
});
const withdrawSchema = z.object({ method: z.enum(CONSENT_METHODS, { error: "Choose how the patient withdrew consent." }) });

function view(row: typeof patientConsents.$inferSelect): ConsentView {
  return { id: row.id, granted: row.granted, version: row.version, method: row.method as ConsentMethod, recordedAt: row.createdAt };
}

/** The latest sharing-consent event of a patient, or null. */
export async function currentSharingConsentIn(tx: TenantTx, tenantId: string, patientId: string): Promise<ConsentView | null> {
  const [row] = await tx
    .select()
    .from(patientConsents)
    .where(and(eq(patientConsents.tenantId, tenantId), eq(patientConsents.patientId, patientId), eq(patientConsents.purpose, PURPOSE)))
    .orderBy(desc(patientConsents.createdAt), desc(patientConsents.id))
    .limit(1);
  return row ? view(row) : null;
}

export async function getSharingConsent(ctx: ServiceContext, patientId: string): Promise<Result<ConsentView | null>> {
  if (!can(ctx.role, "patient.read")) return fail("forbidden", "You cannot view patients.");
  if (!isUuid(patientId)) return notFound();
  return withTenant(ctx.tenantId, async (tx) => ok(await currentSharingConsentIn(tx, ctx.tenantId, patientId)));
}

/**
 * Records that the patient agreed to the current consent text (SHARING_CONSENT_VERSION), how, and by whom. The
 * patient row is locked first (decision 13). Recording again while the same version is granted writes nothing.
 */
export async function recordSharingConsent(ctx: ServiceContext, patientId: string, raw: unknown): Promise<Result<ConsentView>> {
  if (!can(ctx.role, "consent.capture")) return fail("forbidden", "You cannot record consent.");
  if (!isUuid(patientId)) return notFound();
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<ConsentView>> => {
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, patientId), isNull(patients.deletedAt)))
      .limit(1)
      .for("update");
    if (!patient) return notFound();
    const current = await currentSharingConsentIn(tx, ctx.tenantId, patientId);
    if (current?.granted && current.version === SHARING_CONSENT_VERSION) return ok(current);
    const [row] = await tx
      .insert(patientConsents)
      .values({ tenantId: ctx.tenantId, patientId, purpose: PURPOSE, version: SHARING_CONSENT_VERSION, granted: true, method: parsed.data.method, capturedBy: ctx.userId })
      .returning();
    await recordAudit(tx, ctx, {
      action: "patient.consent_recorded",
      entityType: "patient",
      entityId: patientId,
      after: { consentId: row.id, purpose: PURPOSE, version: SHARING_CONSENT_VERSION, method: parsed.data.method },
    });
    return ok(view(row));
  });
}

/**
 * Records a withdrawal and revokes every open share link of the patient in the same transaction (DPDP: stop
 * processing). Allowed for archived patients too: withdrawing must always be possible.
 */
export async function withdrawSharingConsent(ctx: ServiceContext, patientId: string, raw: unknown): Promise<Result<{ revokedLinks: number }>> {
  if (!can(ctx.role, "consent.capture")) return fail("forbidden", "You cannot record consent.");
  if (!isUuid(patientId)) return notFound();
  const parsed = withdrawSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ revokedLinks: number }>> => {
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, patientId)))
      .limit(1)
      .for("update");
    if (!patient) return notFound();
    const current = await currentSharingConsentIn(tx, ctx.tenantId, patientId);
    if (!current?.granted) return fail("conflict", "No sharing consent is on record for this patient.");
    const [row] = await tx
      .insert(patientConsents)
      .values({ tenantId: ctx.tenantId, patientId, purpose: PURPOSE, version: current.version, granted: false, method: parsed.data.method, capturedBy: ctx.userId })
      .returning({ id: patientConsents.id });
    const revokedLinks = await revokeActiveLinksForPatient(tx, ctx.tenantId, patientId, "consent_withdrawn", ctx.userId);
    await recordAudit(tx, ctx, {
      action: "patient.consent_withdrawn",
      entityType: "patient",
      entityId: patientId,
      after: { consentId: row.id, purpose: PURPOSE, version: current.version, method: parsed.data.method, revokedLinks },
    });
    return ok({ revokedLinks });
  });
}
```

Append to `src/server/services/clinic.ts` (add `import { eq } from "drizzle-orm";`, `import { can } from "@/lib/domain/permissions";`, `import { fail, ok, type Result } from "@/lib/result";`, `import { clinics } from "@/server/db/schema";`, `import { recordAudit } from "./audit";`):

```ts
export async function getClinicSharing(ctx: ServiceContext): Promise<Result<{ enabled: boolean }>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", "Only the clinic owner can change sharing.");
  return withTenant(ctx.tenantId, async (tx) => {
    const clinic = await primaryClinic(tx, ctx.tenantId);
    return clinic ? ok({ enabled: clinic.sharingEnabled }) : fail("not_found", "Clinic not found.");
  });
}

/** Turns sharing by link on or off for the clinic. Off makes every existing link answer "not found" at once. */
export async function setClinicSharing(ctx: ServiceContext, enabled: unknown): Promise<Result<{ enabled: boolean; changed: boolean }>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", "Only the clinic owner can change sharing.");
  if (typeof enabled !== "boolean") return fail("invalid", "Choose whether sharing is on or off.", "sharingEnabled");
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ enabled: boolean; changed: boolean }>> => {
    const clinic = await primaryClinic(tx, ctx.tenantId, true);
    if (!clinic) return fail("not_found", "Clinic not found.");
    if (clinic.sharingEnabled === enabled) return ok({ enabled, changed: false });
    await tx.update(clinics).set({ sharingEnabled: enabled }).where(eq(clinics.id, clinic.id));
    await recordAudit(tx, ctx, { action: "clinic.sharing_changed", entityType: "clinic", entityId: clinic.id, after: { enabled } });
    return ok({ enabled, changed: true });
  });
}
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/consent.test.ts` — expected: PASS (10).

- [ ] **Step 8: Actions, the consent card, the settings switch, and the patient page**

`src/server/actions/consent.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/server/auth/session";
import { recordSharingConsent, withdrawSharingConsent } from "@/server/services/consent";

export type ConsentFormState = { error?: string; field?: string; saved?: boolean };

function refresh(): void {
  // The card is shown on the patient page and inside the prescription page's share panel.
  revalidatePath("/patients/[id]", "page");
  revalidatePath("/prescriptions/[id]", "page");
}

export async function recordConsentAction(patientId: string, _prev: ConsentFormState, formData: FormData): Promise<ConsentFormState> {
  const session = await requireSession();
  const result = await recordSharingConsent(session, patientId, { method: formData.get("method"), confirmed: formData.get("confirmed") === "yes" });
  if (!result.ok) return { error: result.message, field: result.field };
  refresh();
  return { saved: true };
}

export async function withdrawConsentAction(patientId: string, _prev: ConsentFormState, formData: FormData): Promise<ConsentFormState> {
  const session = await requireSession();
  const result = await withdrawSharingConsent(session, patientId, { method: formData.get("method") });
  if (!result.ok) return { error: result.message, field: result.field };
  refresh();
  return { saved: true };
}
```

`src/components/patients/consent-card.tsx`:

```tsx
"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CONSENT_TEXT, SHARING_CONSENT_VERSION } from "@/lib/domain/consent";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { recordConsentAction, withdrawConsentAction, type ConsentFormState } from "@/server/actions/consent";
import type { ConsentView } from "@/server/services/consent";

type Props = { patientId: string; consent: ConsentView | null; canCapture: boolean; archived: boolean; timeZone: string };

function dateText(d: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(d);
}

function MethodChoice({ name, legend }: { name: string; legend: string }) {
  return (
    <fieldset className="flex flex-wrap gap-4 text-sm">
      <legend className="mb-1 text-muted-foreground">{legend}</legend>
      <label className="flex items-center gap-1">
        <input type="radio" name={name} value="verbal" defaultChecked /> Verbal
      </label>
      <label className="flex items-center gap-1">
        <input type="radio" name={name} value="written" /> Written
      </label>
    </fieldset>
  );
}

/** Sharing consent: what is on record, recording it (with the exact text shown), and withdrawing it behind a confirm step. */
export function ConsentCard({ patientId, consent, canCapture, archived, timeZone }: Props) {
  const [recordState, record, recording] = useActionState(recordConsentAction.bind(null, patientId), {} as ConsentFormState);
  const [withdrawState, withdraw, withdrawing] = useActionState(withdrawConsentAction.bind(null, patientId), {} as ConsentFormState);
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const text = CONSENT_TEXT[SHARING_CONSENT_VERSION];

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  const granted = consent !== null && consent.granted;
  return (
    <section aria-labelledby={`consent-${patientId}`} className="space-y-2 rounded-lg border p-3 text-sm">
      <h2 id={`consent-${patientId}`} className="font-medium">
        Consent to share by WhatsApp or email
      </h2>
      <p role="status">
        {consent === null
          ? "Not recorded. Nothing can be shared until the patient agrees."
          : consent.granted
            ? `Given (${consent.method}) on ${dateText(consent.recordedAt, timeZone)}.`
            : `Withdrawn on ${dateText(consent.recordedAt, timeZone)}. Nothing can be shared until consent is recorded again.`}
      </p>

      {canCapture && !archived && !granted ? (
        <form action={record} className="space-y-2">
          <blockquote className="space-y-1 border-l-2 pl-3">
            <p>{text.en}</p>
            <p lang="hi">{text.hi}</p>
          </blockquote>
          <MethodChoice name="method" legend="How the patient agreed" />
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirmed" value="yes" aria-invalid={recordState.field === "confirmed" || undefined} />
            The patient (or their guardian) agreed to this text.
          </label>
          <Button type="submit" disabled={recording}>
            Record consent
          </Button>
          {recordState.error ? <p className="text-destructive">{recordState.error}</p> : null}
        </form>
      ) : null}

      {canCapture && granted ? (
        <div className="space-y-2">
          <div aria-live="polite">{confirming ? "Every link already sent for this patient stops working at once." : null}</div>
          {confirming ? (
            <form action={withdraw} className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
              <MethodChoice name="method" legend="How the patient withdrew" />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="destructive" disabled={withdrawing}>
                  Yes, withdraw consent
                </Button>
                <Button ref={keepRef} type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={withdrawing}>
                  Keep it
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
              Withdraw consent
            </Button>
          )}
          {withdrawState.error ? <p className="text-destructive">{withdrawState.error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
```

`src/components/settings/sharing-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { saveSharingAction, type SettingsFormState } from "@/server/actions/settings";

/** Owner switch for sharing by link. Off by default; turning it off stops every link the clinic has sent. */
export function SharingForm({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(saveSharingAction, {} as SettingsFormState);
  return (
    <form action={action} className="space-y-2 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" name="sharingEnabled" defaultChecked={enabled} className="mt-1" />
        <span>
          Allow sharing prescriptions as links by WhatsApp and email. Staff must record each patient&apos;s consent first. Turning
          this off stops every link already sent.
        </span>
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        Save sharing
      </Button>
      {state.saved ? <p role="status">Saved.</p> : null}
      {state.error ? <p className="text-destructive">{state.error}</p> : null}
    </form>
  );
}
```

In `src/server/actions/settings.ts`, add `import { setClinicSharing } from "@/server/services/clinic";` and:

```ts
export async function saveSharingAction(_prev: SettingsFormState, formData: FormData): Promise<SettingsFormState> {
  return asSession("saveSharingAction", async (session) => {
    const result = await setClinicSharing(session, formData.get("sharingEnabled") === "on");
    if (!result.ok) return { error: result.message, field: result.field };
    revalidatePath("/settings");
    return { saved: true };
  });
}
```

In `src/app/(app)/settings/page.tsx`, import `getClinicSharing` (from `@/server/services/clinic`) and `SharingForm`, read `const sharing = await getClinicSharing(session);` next to `pad`, and add after the Logo section:

```tsx
      {sharing.ok ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Sharing</h2>
          <SharingForm enabled={sharing.value.enabled} />
        </section>
      ) : null}
```

In `src/app/(app)/patients/[id]/page.tsx` (Task 4's version), import `getSharingConsent` and `ConsentCard`, read `const consent = await getSharingConsent(session, p.id);` after `history`, and render between the details section and the history:

```tsx
      {consent.ok ? (
        <ConsentCard patientId={p.id} consent={consent.value} canCapture={can(session.role, "consent.capture")} archived={archived} timeZone={timeZone} />
      ) : null}
```

- [ ] **Step 9: Component tests for the card and the switch**

`tests/unit/consent-card.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({ recordConsentAction: vi.fn(), withdrawConsentAction: vi.fn() }));
vi.mock("@/server/actions/consent", () => actions);

import { ConsentCard } from "@/components/patients/consent-card";
import { CONSENT_TEXT } from "@/lib/domain/consent";

const ID = "00000000-0000-4000-8000-0000000000a1";

beforeEach(() => {
  actions.recordConsentAction.mockReset();
  actions.withdrawConsentAction.mockReset();
});

describe("ConsentCard", () => {
  it("shows the exact consent text in English and Hindi and sends the method and the confirmation", async () => {
    actions.recordConsentAction.mockResolvedValue({ saved: true });
    render(<ConsentCard patientId={ID} consent={null} canCapture archived={false} timeZone="Asia/Kolkata" />);
    expect(screen.getByText("Not recorded. Nothing can be shared until the patient agrees.")).toBeInTheDocument();
    expect(screen.getByText(CONSENT_TEXT["sharing-v1"].en)).toBeInTheDocument();
    expect(screen.getByText(CONSENT_TEXT["sharing-v1"].hi)).toHaveAttribute("lang", "hi");
    fireEvent.click(screen.getByLabelText("Written"));
    fireEvent.click(screen.getByLabelText("The patient (or their guardian) agreed to this text."));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record consent" }));
    });
    const [patientId, , formData] = actions.recordConsentAction.mock.calls[0] as [string, unknown, FormData];
    expect(patientId).toBe(ID);
    expect(formData.get("method")).toBe("written");
    expect(formData.get("confirmed")).toBe("yes");
  });

  it("withdraws only after the confirm step, with focus on Keep it", async () => {
    actions.withdrawConsentAction.mockResolvedValue({ saved: true });
    render(
      <ConsentCard
        patientId={ID}
        consent={{ id: "c", granted: true, version: "sharing-v1", method: "verbal", recordedAt: new Date("2026-11-16T19:00:00Z") }}
        canCapture
        archived={false}
        timeZone="Asia/Kolkata"
      />,
    );
    expect(screen.getByText("Given (verbal) on 17 Nov 2026.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw consent" }));
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, withdraw consent" }));
    });
    await waitFor(() => expect(actions.withdrawConsentAction).toHaveBeenCalledTimes(1));
  });

  it("shows only the status to roles that cannot capture consent, and no record form for archived patients", () => {
    const first = render(<ConsentCard patientId={ID} consent={null} canCapture={false} archived={false} timeZone="Asia/Kolkata" />);
    expect(screen.queryByRole("button", { name: "Record consent" })).toBeNull();
    first.unmount();
    render(<ConsentCard patientId={ID} consent={null} canCapture archived timeZone="Asia/Kolkata" />);
    expect(screen.queryByRole("button", { name: "Record consent" })).toBeNull();
  });
});
```

Append to `tests/unit/settings-forms.test.tsx` (add `saveSharingAction: vi.fn()` to its hoisted `actions` object and `import { SharingForm } from "@/components/settings/sharing-form";`):

```tsx
describe("SharingForm", () => {
  it("sends the switch state and confirms the save", async () => {
    actions.saveSharingAction.mockResolvedValue({ saved: true } satisfies SettingsFormState);
    render(<SharingForm enabled={false} />);
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save sharing" }));
    });
    const formData = actions.saveSharingAction.mock.calls[0][1] as FormData;
    expect(formData.get("sharingEnabled")).toBe("on");
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
  });
});
```

- [ ] **Step 10: Run, full suite, commit**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/consent-card.test.tsx tests/unit/settings-forms.test.tsx tests/integration/consent.test.ts tests/integration/sharing-schema.test.ts tests/integration/rls-guard.test.ts
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/server/db/schema/sharing.ts src/server/db/schema/index.ts src/server/db/schema/tenancy.ts src/server/db/schema/clinical.ts drizzle/0021_phase1d_sharing.sql drizzle/0022_phase1d_sharing_security.sql drizzle/meta/0021_snapshot.json drizzle/meta/0022_snapshot.json drizzle/meta/_journal.json src/lib/domain/consent.ts src/lib/domain/permissions.ts src/server/services/consent.ts src/server/services/share-revocation.ts src/server/services/clinic.ts src/server/actions/consent.ts src/server/actions/settings.ts src/components/patients/consent-card.tsx src/components/settings/sharing-form.tsx "src/app/(app)/settings/page.tsx" "src/app/(app)/patients/[id]/page.tsx" tests/unit/permissions.test.ts tests/unit/consent-card.test.tsx tests/unit/settings-forms.test.tsx tests/integration/sharing-schema.test.ts tests/integration/consent.test.ts tests/integration/rls-guard.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(sharing): consent log, share link and share log tables with token policy and link rules, clinic sharing switch" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

---

## Task 9: Share links — tokens, the link lifecycle, the public `/s/<token>` route, rate limits, and PDF abort plumbing

**Files:**
- Create: `src/server/sharing/token.ts`, `src/server/sharing/config.ts`, `src/server/db/share-token.ts`, `src/server/services/share-links.ts`, `src/server/http/rate-limit.ts`, `src/server/http/share-pages.ts`, `src/server/http/share-route.ts`, `src/app/s/[token]/route.ts`, `tests/helpers/share.ts`
- Modify: `src/server/services/rx-documents.ts` (extract `loadRxDocumentIn`), `src/server/services/rx-output.ts` (export `renderDocument`, abort-aware PDF, output counter), `src/server/services/audit.ts` (`recordSystemAudit`), `src/server/services/patients.ts` (`archivePatient` revokes links), `src/server/pdf/limiter.ts`, `src/server/pdf/engine.ts`, `src/server/pdf/gotenberg.ts`, `tests/helpers/fake-pdf-engine.ts`, `src/app/(app)/prescriptions/[id]/pdf/route.ts`, `scripts/build-desktop.mjs`
- Test: `tests/unit/share-token.test.ts`, `tests/unit/rate-limit.test.ts`, `tests/unit/rx-output-http.test.ts` (limiter abort, appended), `tests/unit/gotenberg.test.ts` (signal, appended), `tests/integration/share-links.test.ts`, `tests/integration/share-route.test.ts`

**Interfaces:**
- Consumes: Task 8's tables, `currentSharingConsentIn`, `revokeActiveLinksForPatient`; `primaryClinic`; `renderPrescription` pipeline in `rx-output.ts` (`htmlSha256`, `RENDERER_VERSION`, `checkSelfContained`); `getPdfEngine`, `renderLimiter`; `pdfFileName`; `escapeHtml`; `contentDisposition`; `DEFAULT_TIME_ZONE`, `isValidTimeZone`; `createFakePdfEngine`.
- Produces:
  - `src/server/sharing/token.ts`: `SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/`, `newShareToken(): string`, `isShareToken(value: unknown): value is string`, `shareTokenHash(token: string): string`.
  - `src/server/sharing/config.ts`: `resolveAppUrl(env: { NODE_ENV?: string; NEXT_PUBLIC_APP_URL?: string }): string | null`, `shareUrl(token: string, baseUrl: string): string`.
  - `src/server/db/share-token.ts`: `withShareToken<T>(tokenHash: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>`.
  - `src/server/services/share-links.ts`: `SHARE_LIMITS = { ttlDays: 7, maxOpens: 10, linksPerUserPerHour: 60, activeLinksPerPrescription: 10 }`; `type ShareChannel = "whatsapp" | "email"`; `type ShareLinkStatus = "active" | "expired" | "used_up" | "revoked"`; `type ShareLinkView = { id; channel: ShareChannel; recipientMasked: string | null; createdAt: Date; expiresAt: Date; openCount: number; maxOpens: number; status: ShareLinkStatus; revokeReason: string | null }`; `type CreatedLink = { linkId; token; expiresAt: Date; prescriptionId; patientId; rxNo: number; version: number }`; `linkStatus(link, now): ShareLinkStatus`; `createShareLinkIn(tx, ctx, input: { prescriptionId: string; channel: ShareChannel }, now: Date): Promise<Result<CreatedLink>>`; `listShareLinksIn(tx, tenantId, prescriptionId, now): Promise<ShareLinkView[]>`; `listShareLinks(ctx, prescriptionId)`; `revokeShareLink(ctx, linkId): Promise<Result<null>>`; `type ShareLinkSummary = { linkId; tenantId; expiresAt: Date; remainingOpens: number; timeZone: string }`; `resolveShareLink(token, now?): Promise<Result<ShareLinkSummary>>`; `openSharedPrescription(token, deps?: { engine?: PdfEngine; limiter?: Limiter; signal?: AbortSignal; now?: Date }): Promise<Result<{ pdf: ArrayBuffer; fileName: string }>>`.
  - `loadRxDocumentIn(tx, tenantId, id, viewer: { userId: string | null; canFinalize: boolean }, opts?)` and `type DocumentViewer`; `loadRxDocument` keeps its signature.
  - `renderDocument(bundle: RxDocumentBundle): RenderedDocument` (exported); `renderPrescriptionPdf(ctx, id, engine?, limiter?, signal?)`.
  - `recordSystemAudit(tx, tenantId, event: AuditInput): Promise<void>` (actor null).
  - `LimiterResult<T> = { busy: true } | { busy: false; aborted: true; value?: undefined } | { busy: false; aborted?: false; value: T }`; `Limiter.run(task, opts?: { signal?: AbortSignal })`; `PdfEngine.render(doc, opts?: { signal?: AbortSignal })`; `FakePdfEngine.signals: (AbortSignal | null)[]`.
  - `createRateLimiter({ windowMs, max, maxKeys? }): RateLimiter` (`hit(key, now?) => boolean`, `reset()`), `clientKey(request): string`.
  - `share-pages.ts`: `SHARE_COMMON_HEADERS`, `notFoundPage()`, `unavailablePage()`, `tooManyPage()`, `interstitialPage(summary)`, `pdfResponse(pdf, fileName)`, `methodNotAllowed()`.
  - `share-route.ts`: `type ShareRouteDeps = { limiter?: RateLimiter; engine?: PdfEngine; pdfLimiter?: Limiter; now?: () => Date }`; `shareRouteLimiter`; `handleShareGet(request, token, deps?)`; `handleSharePost(request, token, deps?)`.
  - The route `/s/[token]`: `GET`, `POST`, `HEAD` (405).
  - `archivePatient` revokes the patient's links (`revoke_reason = 'patient_archived'`) and its audit event carries `revokedLinks`.

- [ ] **Step 1: Write the failing unit tests (token, rate limiter, limiter abort, engine signal)**

`tests/unit/share-token.test.ts`:

```ts
// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isShareToken, newShareToken, shareTokenHash } from "@/server/sharing/token";
import { resolveAppUrl, shareUrl } from "@/server/sharing/config";

describe("share tokens", () => {
  it("are 32 random bytes in base64url: 43 URL-safe characters, never repeated", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => newShareToken()));
    expect(tokens.size).toBe(2000);
    for (const t of tokens) expect(isShareToken(t)).toBe(true);
  });

  it("are stored only as their SHA-256 hex digest", () => {
    const token = newShareToken();
    expect(shareTokenHash(token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(shareTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    "",
    "short",
    "a".repeat(42),
    "a".repeat(44),
    `${"a".repeat(42)}=`,
    `${"a".repeat(42)}+`,
    `${"a".repeat(42)}/`,
    `${"a".repeat(41)}%2F`,
    ` ${"a".repeat(42)}`,
    `${"a".repeat(42)}\u0430`,
    null,
    42,
  ])("refuses %j before any lookup", (value) => {
    expect(isShareToken(value)).toBe(false);
  });
});

describe("resolveAppUrl", () => {
  it.each([
    [{ NEXT_PUBLIC_APP_URL: "https://app.clinicpad.in/" }, "https://app.clinicpad.in"],
    [{ NEXT_PUBLIC_APP_URL: "http://localhost:3000", NODE_ENV: "development" }, "http://localhost:3000"],
    [{ NODE_ENV: "development" }, "http://localhost:3000"],
    [{ NODE_ENV: "production" }, null],
    [{ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://app.clinicpad.in" }, null],
    [{ NEXT_PUBLIC_APP_URL: "https://app.clinicpad.in/path" }, null],
    [{ NEXT_PUBLIC_APP_URL: "javascript:alert(1)" }, null],
  ])("%j -> %j", (env, expected) => {
    expect(resolveAppUrl(env)).toBe(expected);
  });

  it("builds a share URL that carries nothing but the token", () => {
    expect(shareUrl("abc", "https://app.clinicpad.in")).toBe("https://app.clinicpad.in/s/abc");
  });
});
```

`tests/unit/rate-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clientKey, createRateLimiter } from "@/server/http/rate-limit";

describe("createRateLimiter", () => {
  it("allows max hits per key per window, then refuses until the window passes", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
    expect([1, 2, 3, 4].map(() => limiter.hit("a", 0))).toEqual([true, true, true, false]);
    expect(limiter.hit("b", 0)).toBe(true);
    expect(limiter.hit("a", 999)).toBe(false);
    expect(limiter.hit("a", 1000)).toBe(true);
  });

  it("never holds more than maxKeys windows", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, maxKeys: 3 });
    for (const k of ["a", "b", "c", "d", "e"]) expect(limiter.hit(k, 0)).toBe(true);
    // The map was cleared to stay bounded; a cleared key starts a fresh window.
    expect(limiter.hit("a", 0)).toBe(true);
  });
});

describe("clientKey", () => {
  it("uses the first X-Forwarded-For entry, then X-Real-IP, then 'unknown', capped at 64 characters", () => {
    expect(clientKey(new Request("http://x", { headers: { "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" } }))).toBe("203.0.113.9");
    expect(clientKey(new Request("http://x", { headers: { "x-real-ip": "198.51.100.4" } }))).toBe("198.51.100.4");
    expect(clientKey(new Request("http://x"))).toBe("unknown");
    expect(clientKey(new Request("http://x", { headers: { "x-forwarded-for": "z".repeat(100) } }))).toHaveLength(64);
  });
});
```

Append to the `describe("createLimiter", ...)` block of `tests/unit/rx-output-http.test.ts`:

```ts
  it("drops a queued task whose request was aborted: it never runs and frees its place in the queue", async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
    const g = gate();
    const first = limiter.run(() => g.promise);
    const controller = new AbortController();
    let ran = false;
    const queued = limiter.run(
      async () => {
        ran = true;
      },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await queued).toEqual({ busy: false, aborted: true });
    // The aborted task no longer holds the only queue place.
    const next = limiter.run(async () => "next");
    g.open();
    await first;
    expect(await next).toEqual({ busy: false, value: "next" });
    expect(ran).toBe(false);
  });

  it("answers aborted at once for an already aborted signal, without taking a slot", async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 0 });
    const controller = new AbortController();
    controller.abort();
    expect(await limiter.run(async () => 1, { signal: controller.signal })).toEqual({ busy: false, aborted: true });
    expect(await limiter.run(async () => 2)).toEqual({ busy: false, value: 2 });
  });
```

Append to `tests/unit/gotenberg.test.ts` (inside `describe("createGotenbergEngine.render", ...)`):

```ts
  it("passes the caller's abort signal through to the request, combined with the timeout", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(1));
    const controller = new AbortController();
    await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).render(rendered, { signal: controller.signal });
    const signal = calls[0].init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
```

Run them: `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/share-token.test.ts tests/unit/rate-limit.test.ts tests/unit/rx-output-http.test.ts tests/unit/gotenberg.test.ts` — expected: FAIL (missing modules; the limiter runs the aborted task; the engine ignores the signal).

- [ ] **Step 2: Tokens, the app URL, the rate limiter**

`src/server/sharing/token.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes in base64url without padding. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Checked before any lookup, so malformed input never reaches the database. */
export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_PATTERN.test(value);
}

/** Only this digest is stored (share_links.token_hash); the token itself exists only in the URL. */
export function shareTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
```

`src/server/sharing/config.ts`:

```ts
const DEV_URL = "http://localhost:3000";

/**
 * The public base URL for share links, from NEXT_PUBLIC_APP_URL (never from request headers, which a client can
 * forge). An origin only (no path); https in production. Missing in production means sharing is unavailable.
 */
export function resolveAppUrl(env: { NODE_ENV?: string; NEXT_PUBLIC_APP_URL?: string }): string | null {
  const raw = (env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (raw === "") return env.NODE_ENV === "production" ? null : DEV_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (env.NODE_ENV === "production" && url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function shareUrl(token: string, baseUrl: string): string {
  return `${baseUrl}/s/${token}`;
}
```

`src/server/http/rate-limit.ts`:

```ts
export type RateLimiter = { hit(key: string, now?: number): boolean; reset(): void };

/**
 * Fixed-window counter per key, in memory, per process (best effort: production also limits at the edge). The map
 * is bounded: past maxKeys, expired windows are dropped, and if that is not enough the map is cleared.
 */
export function createRateLimiter({ windowMs, max, maxKeys = 10_000 }: { windowMs: number; max: number; maxKeys?: number }): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key, now = Date.now()) {
      const current = windows.get(key);
      if (!current || now - current.start >= windowMs) {
        if (!current && windows.size >= maxKeys) {
          for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
          if (windows.size >= maxKeys) windows.clear();
        }
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= max;
    },
    reset() {
      windows.clear();
    },
  };
}

/**
 * The client address as the hosting platform reports it: the first X-Forwarded-For entry, then X-Real-IP. A client
 * can forge these headers, which only moves it to another bucket; it never grants access.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  return (forwarded || real || "unknown").slice(0, 64);
}
```

- [ ] **Step 3: Abort plumbing in the limiter and the engine**

`src/server/pdf/limiter.ts` — replace the type and `run`:

```ts
export type LimiterResult<T> = { busy: true } | { busy: false; aborted: true; value?: undefined } | { busy: false; aborted?: false; value: T };

export type Limiter = {
  run<T>(task: () => Promise<T>, opts?: { signal?: AbortSignal }): Promise<LimiterResult<T>>;
};
```

and inside `createLimiter`:

```ts
    async run<T>(task: () => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<LimiterResult<T>> {
      const { signal } = opts;
      // The caller is gone (closed tab, cancelled request): do not take a slot for a result nobody will read.
      if (signal?.aborted) return { busy: false, aborted: true };
      if (active >= concurrency) {
        if (waiting.length >= maxQueue) return { busy: true };
        const admitted = await new Promise<boolean>((resolve) => {
          const onAbort = () => {
            const index = waiting.indexOf(admit);
            if (index >= 0) waiting.splice(index, 1);
            resolve(false);
          };
          const admit = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
          };
          waiting.push(admit);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
        // A waiter removed by abort never received the slot, so there is nothing to release.
        if (!admitted) return { busy: false, aborted: true };
      } else {
        active += 1;
      }
      try {
        return { busy: false, value: await task() };
      } finally {
        release();
      }
    },
```

Update the doc comment: `` * A queued task whose `signal` aborts leaves the queue without running and without taking a slot. ``

`src/server/pdf/engine.ts`: change the interface method to `render(doc: RenderedDocument, opts?: { signal?: AbortSignal }): Promise<PdfOutcome>;` and its comment to `/** Turns a rendered document into a PDF. Injected so tests never need the real service. `signal` cancels the request when the caller goes away. */`.

`src/server/pdf/gotenberg.ts`: change `postHtmlToGotenberg(options: GotenbergOptions, form: FormData)` to `postHtmlToGotenberg(options: GotenbergOptions, form: FormData, signal?: AbortSignal)`, and its fetch option to:

```ts
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(options.renderTimeoutMs ?? PDF_LIMITS.renderTimeoutMs), signal])
        : AbortSignal.timeout(options.renderTimeoutMs ?? PDF_LIMITS.renderTimeoutMs),
```

and in `createGotenbergEngine`, `async render(doc)` becomes `async render(doc, opts)` and its last line `return await postHtmlToGotenberg(options, gotenbergForm(doc), opts?.signal);`. Leave `health()` unchanged.

`tests/helpers/fake-pdf-engine.ts`: add `signals: (AbortSignal | null)[];` to `FakePdfEngine`, `signals: [],` to the object, make `render` `async render(doc, opts) { engine.calls.push(doc); engine.signals.push(opts?.signal ?? null); ... }`, and add `engine.signals.length = 0;` to `resetFakeEngine`.

`src/server/services/rx-output.ts`:
- rename the private `function render(bundle: RxDocumentBundle): RenderedDocument` to `export function renderDocument(bundle: RxDocumentBundle): RenderedDocument` and update its two call sites;
- add `export const ABORTED_MESSAGE = "The download was cancelled.";`;
- change `renderPrescriptionPdf`'s signature and limiter call:

```ts
export async function renderPrescriptionPdf(
  ctx: ServiceContext,
  id: string,
  engine: PdfEngine = getPdfEngine(),
  limiter: Limiter = renderLimiter,
  signal?: AbortSignal,
): Promise<Result<{ pdf: ArrayBuffer; fileName: string; pageCount: number }>> {
  const loaded = await loadRxDocument(ctx, id);
  if (!loaded.ok) return loaded;
  const { document } = loaded.value;
  if (document.status === "draft") return fail("conflict", DRAFT_OUTPUT_MESSAGE);
  const rendered = renderDocument(loaded.value);
  const run = await limiter.run(() => engine.render(rendered, { signal }), { signal });
  if (run.busy) return fail("unavailable", BUSY_MESSAGE);
  if (run.aborted === true) return fail("unavailable", ABORTED_MESSAGE);
  const outcome = run.value;
```

  (the rest of the function is unchanged);
- in `listPrescriptionOutputs`, count only prints and downloads (shared opens are shown by the share panel): change the `where` to `and(eq(prescriptionOutputs.prescriptionId, id), inArray(prescriptionOutputs.kind, ["pdf_download", "browser_print"]))` and add `and, inArray` to the `drizzle-orm` import.

`src/app/(app)/prescriptions/[id]/pdf/route.ts`: change the service call to `const result = await renderPrescriptionPdf(session, id, undefined, undefined, request.signal);`.

Run the four unit files again — expected: PASS (share-token 3 + 12 + 8 = 23, rate-limit 3, rx-output-http +2, gotenberg +1). Also run `npx vitest run tests/integration/rx-output-routes.test.ts` — unchanged.

- [ ] **Step 4: The session-less lookup, the document loader split, the system audit**

`src/server/db/share-token.ts`:

```ts
import { sql } from "drizzle-orm";
import { db } from "./client";
import type { TenantTx } from "./tenant";

/**
 * The ONLY query path that runs without app.tenant_id (Plan 1D decision 7). It sets app.share_token_hash for this
 * transaction, which the policy share_link_by_token (0022) matches against share_links.token_hash: the caller can
 * read exactly the one link whose token it holds, and nothing else, in any table. Everything after the lookup
 * belongs in withTenant(link.tenantId).
 */
export async function withShareToken<T>(tokenHash: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error("tokenHash must be a SHA-256 hex digest");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.share_token_hash', ${tokenHash}, true)`);
    return fn(tx);
  });
}
```

`src/server/services/audit.ts` — append:

```ts
/** An event with no signed-in actor (a patient opening a shared link). Same payload rules as recordAudit. */
export async function recordSystemAudit(tx: TenantTx, tenantId: string, event: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId,
    actorUserId: null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    before: event.before,
    after: event.after,
  });
}
```

`src/server/services/rx-documents.ts` — split `loadRxDocument`:

```ts
/** Who is looking at a document: it matters only for a draft (who may be named as its would-be signer). */
export type DocumentViewer = { userId: string | null; canFinalize: boolean };

export async function loadRxDocument(
  ctx: ServiceContext,
  id: string,
  opts: { withAssets?: boolean } = {},
): Promise<Result<RxDocumentBundle>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return notFound();
  return withTenant(ctx.tenantId, (tx) =>
    loadRxDocumentIn(tx, ctx.tenantId, id, { userId: ctx.userId, canFinalize: can(ctx.role, "rx.finalize") }, opts),
  );
}

/**
 * The body of loadRxDocument inside the caller's transaction (also used by the public share route, which has no
 * session: it passes a viewer with no user and only ever loads finalized or amended versions).
 */
export async function loadRxDocumentIn(
  tx: TenantTx,
  tenantId: string,
  id: string,
  viewer: DocumentViewer,
  opts: { withAssets?: boolean } = {},
): Promise<Result<RxDocumentBundle>> {
```

Move the current body of the `withTenant(ctx.tenantId, async (tx) => { ... })` callback into `loadRxDocumentIn` unchanged except: the first query gets `.where(and(eq(prescriptions.tenantId, tenantId), eq(prescriptions.id, id)))`; `tenantId: ctx.tenantId` becomes `tenantId`; `prescriberUserId: status === "draft" ? (can(ctx.role, "rx.finalize") ? ctx.userId : null) : row.rx.finalizedBy` becomes `prescriberUserId: status === "draft" ? (viewer.canFinalize ? viewer.userId : null) : row.rx.finalizedBy`; and `loadImageAssets(tx, ctx.tenantId, ...)` becomes `loadImageAssets(tx, tenantId, ...)`. Keep the long doc comment on `loadRxDocument`.

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/render-snapshot.test.ts tests/integration/rx-output-routes.test.ts` — expected: PASS unchanged (pure refactor).

- [ ] **Step 5: Write the failing share-links test**

`tests/helpers/share.ts`:

```ts
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { recordSharingConsent } from "@/server/services/consent";
import { createPatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { createShareLinkIn, type CreatedLink, type ShareChannel } from "@/server/services/share-links";
import { finalizeNow, saveDraftNow } from "./rx";
import type { TestTenant } from "./tenant";

/** Sharing switched on, a patient with consent on record, and one finalized prescription. */
export async function shareablePrescription(T: TestTenant, name: string, phone = "98765 43210") {
  await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, T.tenantId));
  const patient = await createPatient(T.as("owner"), { name, phone }, { allowDuplicate: true });
  if (!patient.ok) throw new Error(patient.message);
  const consent = await recordSharingConsent(T.as("owner"), patient.value.id, { method: "verbal", confirmed: true });
  if (!consent.ok) throw new Error(consent.message);
  const prescriptionId = await finalizedPrescription(T, patient.value.id);
  return { patientId: patient.value.id, consentId: consent.value.id, prescriptionId };
}

export async function finalizedPrescription(T: TestTenant, patientId: string): Promise<string> {
  const started = await startPrescription(T.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraftNow(T.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Share Drug", doseMorning: 1 }] });
  if (!saved.ok) throw new Error(saved.message);
  const done = await finalizeNow(T.as("doctor"), started.value.prescriptionId);
  if (!done.ok) throw new Error(done.message);
  return started.value.prescriptionId;
}

/** A link created the way the sharing service creates one (Task 10 adds the share log around it). */
export async function linkFor(T: TestTenant, prescriptionId: string, channel: ShareChannel = "whatsapp", role = "doctor"): Promise<CreatedLink> {
  const ctx = T.as(role);
  const created = await withTenant(T.tenantId, (tx) => createShareLinkIn(tx, ctx, { prescriptionId, channel }, new Date()));
  if (!created.ok) throw new Error(`${created.code}: ${created.message}`);
  return created.value;
}
```

`tests/integration/share-links.test.ts`:

```ts
// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, clinics, patients, prescriptionOutputs, shareLinks } from "@/server/db/schema";
import { amendPrescription, startPrescription } from "@/server/services/prescriptions";
import { archivePatient } from "@/server/services/patients";
import { withdrawSharingConsent } from "@/server/services/consent";
import { listPrescriptionOutputs } from "@/server/services/rx-output";
import {
  createShareLinkIn,
  listShareLinks,
  openSharedPrescription,
  resolveShareLink,
  revokeShareLink,
  SHARE_LIMITS,
} from "@/server/services/share-links";
import { createLimiter } from "@/server/pdf/limiter";
import { createFakePdfEngine } from "../helpers/fake-pdf-engine";
import { finalizeNow } from "../helpers/rx";
import { finalizedPrescription, linkFor, shareablePrescription } from "../helpers/share";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
const DAY = 86_400_000;
const engine = createFakePdfEngine(1);
const open = (token: string, extra: Parameters<typeof openSharedPrescription>[1] = {}) =>
  openSharedPrescription(token, { engine, limiter: createLimiter({ concurrency: 2, maxQueue: 5 }), ...extra });
const create = (T: TestTenant, prescriptionId: string, role = "doctor") =>
  withTenant(T.tenantId, (tx) => createShareLinkIn(tx, T.as(role), { prescriptionId, channel: "whatsapp" }, new Date()));
const row = async (linkId: string) => (await adminDb.select().from(shareLinks).where(eq(shareLinks.id, linkId)))[0];

beforeAll(async () => {
  A = await createTestTenant("links-a");
  B = await createTestTenant("links-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("creating a link", () => {
  it("stores only the token's hash, expires in 7 days with 10 opens, and audits without the token", async () => {
    const s = await shareablePrescription(A, "Link Asha");
    const before = Date.now();
    const link = await linkFor(A, s.prescriptionId);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await row(link.linkId);
    expect(stored.tokenHash).toBe(createHash("sha256").update(link.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(link.token);
    expect(stored).toMatchObject({ maxOpens: SHARE_LIMITS.maxOpens, openCount: 0, channel: "whatsapp", consentId: s.consentId });
    expect(stored.expiresAt.getTime() - before).toBeGreaterThanOrEqual(7 * DAY - 5_000);
    expect(stored.expiresAt.getTime() - before).toBeLessThanOrEqual(7 * DAY + 5_000);
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "prescription.share_link_created"), eq(auditEvents.entityId, s.prescriptionId)));
    expect(event.after).toMatchObject({ linkId: link.linkId, channel: "whatsapp", maxOpens: 10 });
    expect(JSON.stringify(event)).not.toContain(link.token);
  });

  it("is refused while sharing is off, without consent, or after withdrawal", async () => {
    const s = await shareablePrescription(A, "Link Refusals");
    await adminDb.update(clinics).set({ sharingEnabled: false }).where(eq(clinics.tenantId, A.tenantId));
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: false, code: "unavailable" });
    await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, A.tenantId));
    await withdrawSharingConsent(A.as("owner"), s.patientId, { method: "verbal" });
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: false, code: "conflict", field: "consent" });
  });

  it("is refused for a draft, a superseded version, an archived patient, and another clinic's prescription", async () => {
    const s = await shareablePrescription(A, "Link States");
    const draft = await startPrescription(A.as("doctor"), { patientId: s.patientId });
    if (!draft.ok) throw new Error(draft.message);
    expect(await create(A, draft.value.prescriptionId)).toMatchObject({ ok: false, code: "conflict" });
    const amendment = await amendPrescription(A.as("doctor"), { prescriptionId: s.prescriptionId, reason: "Dose correction" });
    if (!amendment.ok) throw new Error(amendment.message);
    await finalizeNow(A.as("doctor"), amendment.value.prescriptionId);
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: false, code: "conflict", message: expect.stringMatching(/latest version/) });
    expect(await create(B, amendment.value.prescriptionId)).toMatchObject({ ok: false, code: "not_found" });
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, s.patientId));
    expect(await create(A, amendment.value.prescriptionId)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("allows at most 10 active links per prescription, and a revoked one frees a place", async () => {
    const s = await shareablePrescription(A, "Link Active Cap");
    const links = [];
    for (let i = 0; i < SHARE_LIMITS.activeLinksPerPrescription; i += 1) links.push(await linkFor(A, s.prescriptionId));
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await revokeShareLink(A.as("reception"), links[0].linkId)).toEqual({ ok: true, value: null });
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: true });
  });

  it("allows at most 60 links per user per hour", async () => {
    const s = await shareablePrescription(A, "Link Hourly Cap");
    const other = await finalizedPrescription(A, s.patientId);
    // A user of its own (as("reception") is a fresh random user per call): the doctor's later links stay under the cap.
    const busy = A.as("reception");
    const now = new Date();
    await adminDb.insert(shareLinks).values(
      Array.from({ length: SHARE_LIMITS.linksPerUserPerHour }, () => ({
        tenantId: A.tenantId,
        prescriptionId: other,
        consentId: s.consentId,
        tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        channel: "whatsapp",
        createdBy: busy.userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + DAY),
        maxOpens: 10,
        revokedAt: now,
        revokeReason: "user",
      })),
    );
    const capped = await withTenant(A.tenantId, (tx) => createShareLinkIn(tx, busy, { prescriptionId: s.prescriptionId, channel: "whatsapp" }, new Date()));
    expect(capped).toMatchObject({ ok: false, code: "unavailable" });
    expect(await create(A, s.prescriptionId)).toMatchObject({ ok: true });
  });
});

describe("listing and revoking", () => {
  it("lists links with their state and lets rx.share roles withdraw one, once", async () => {
    const s = await shareablePrescription(A, "Link List");
    const active = await linkFor(A, s.prescriptionId);
    const revoked = await linkFor(A, s.prescriptionId);
    await revokeShareLink(A.as("doctor"), revoked.linkId);
    expect(await revokeShareLink(A.as("doctor"), revoked.linkId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await revokeShareLink(A.as("nurse"), active.linkId)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await revokeShareLink(B.as("owner"), active.linkId)).toMatchObject({ ok: false, code: "not_found" });
    const listed = await listShareLinks(A.as("reception"), s.prescriptionId);
    expect(listed.ok && listed.value.map((l) => [l.id, l.status])).toEqual(
      expect.arrayContaining([
        [active.linkId, "active"],
        [revoked.linkId, "revoked"],
      ]),
    );
    expect(await listShareLinks(A.as("pharmacist"), s.prescriptionId)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("resolving and opening a link", () => {
  it("opens the frozen PDF, counts one open, logs an output with no actor, and audits it", async () => {
    const s = await shareablePrescription(A, "Link Open");
    const link = await linkFor(A, s.prescriptionId);
    const outputsBefore = await listPrescriptionOutputs(A.as("doctor"), s.prescriptionId);
    expect(await resolveShareLink(link.token)).toMatchObject({ ok: true, value: { remainingOpens: 10, timeZone: "Asia/Kolkata" } });
    const opened = await open(link.token);
    expect(opened).toMatchObject({ ok: true, value: { fileName: expect.stringMatching(/^Rx-\d+-v1\.pdf$/) } });
    expect((await row(link.linkId)).openCount).toBe(1);
    const [output] = await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.shareLinkId, link.linkId));
    expect(output).toMatchObject({ kind: "shared_pdf", actorUserId: null, prescriptionId: s.prescriptionId });
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "prescription.share_opened"), eq(auditEvents.entityId, s.prescriptionId)));
    expect(event).toMatchObject({ actorUserId: null, after: { linkId: link.linkId, outputId: output.id, openCount: 1 } });
    // Shared opens are not prints: the page's "printed N times" stays the same.
    expect(await listPrescriptionOutputs(A.as("doctor"), s.prescriptionId)).toEqual(outputsBefore);
  });

  it("stops after the last allowed open", async () => {
    const s = await shareablePrescription(A, "Link Used Up");
    const link = await linkFor(A, s.prescriptionId);
    for (let i = 0; i < SHARE_LIMITS.maxOpens; i += 1) expect((await open(link.token)).ok).toBe(true);
    expect(await open(link.token)).toMatchObject({ ok: false, code: "not_found" });
    expect(await resolveShareLink(link.token)).toMatchObject({ ok: false, code: "not_found" });
    expect((await row(link.linkId)).openCount).toBe(SHARE_LIMITS.maxOpens);
  });

  it("answers the same not_found for a malformed, unknown, expired, revoked or switched-off link", async () => {
    const s = await shareablePrescription(A, "Link Gone");
    const link = await linkFor(A, s.prescriptionId);
    const gone = { ok: false, code: "not_found", message: "This link is not valid." };
    expect(await resolveShareLink("not-a-token")).toEqual(gone);
    expect(await resolveShareLink("a".repeat(43))).toEqual(gone);
    expect(await resolveShareLink(link.token, new Date(Date.now() + 8 * DAY))).toEqual(gone);
    expect(await open(link.token, { now: new Date(Date.now() + 8 * DAY) })).toEqual(gone);
    await adminDb.update(clinics).set({ sharingEnabled: false }).where(eq(clinics.tenantId, A.tenantId));
    expect(await open(link.token)).toEqual(gone);
    await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, A.tenantId));
    expect((await open(link.token)).ok).toBe(true);
    await revokeShareLink(A.as("owner"), link.linkId);
    expect(await open(link.token)).toEqual(gone);
  });

  it("does not burn an open when the PDF cannot be made, or when the request was already cancelled", async () => {
    const s = await shareablePrescription(A, "Link Engine Down");
    const link = await linkFor(A, s.prescriptionId);
    engine.failWith = "pdf_unavailable";
    try {
      expect(await open(link.token)).toMatchObject({ ok: false, code: "unavailable" });
    } finally {
      engine.failWith = null;
    }
    const controller = new AbortController();
    controller.abort();
    expect(await open(link.token, { signal: controller.signal })).toMatchObject({ ok: false, code: "unavailable" });
    expect((await row(link.linkId)).openCount).toBe(0);
    expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.shareLinkId, link.linkId))).toHaveLength(0);
  });

  it("keeps opening a version that was superseded later, marked SUPERSEDED on the pad", async () => {
    const s = await shareablePrescription(A, "Link Superseded");
    const link = await linkFor(A, s.prescriptionId);
    const amendment = await amendPrescription(A.as("doctor"), { prescriptionId: s.prescriptionId, reason: "Dose correction" });
    if (!amendment.ok) throw new Error(amendment.message);
    await finalizeNow(A.as("doctor"), amendment.value.prescriptionId);
    const calls = engine.calls.length;
    expect((await open(link.token)).ok).toBe(true);
    expect(engine.calls[calls].html).toContain("SUPERSEDED");
  });

  it("stops every link of a patient who is archived or withdraws consent", async () => {
    const archivedCase = await shareablePrescription(A, "Link Archived");
    const archivedLink = await linkFor(A, archivedCase.prescriptionId);
    await archivePatient(A.as("owner"), archivedCase.patientId);
    expect(await open(archivedLink.token)).toMatchObject({ ok: false, code: "not_found" });
    expect((await row(archivedLink.linkId)).revokeReason).toBe("patient_archived");
    const [archivedEvent] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "patient.archived"), eq(auditEvents.entityId, archivedCase.patientId)));
    expect(archivedEvent.after).toEqual({ revokedLinks: 1 });

    const withdrawn = await shareablePrescription(A, "Link Withdrawn");
    const withdrawnLink = await linkFor(A, withdrawn.prescriptionId);
    await withdrawSharingConsent(A.as("reception"), withdrawn.patientId, { method: "verbal" });
    expect(await open(withdrawnLink.token)).toMatchObject({ ok: false, code: "not_found" });
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/share-links.test.ts` — expected: FAIL, `@/server/services/share-links` not found.

- [ ] **Step 6: Write the share-links service and make archiving revoke links**

`src/server/services/share-links.ts`:

```ts
import { and, count, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, ok, type Result } from "@/lib/result";
import { pdfFileName } from "@/lib/rx-render/format";
import { RENDERER_VERSION } from "@/lib/rx-render/render";
import { patients, prescriptionOutputs, prescriptionShares, prescriptions, shareLinks, visits } from "@/server/db/schema";
import { withShareToken } from "@/server/db/share-token";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { getPdfEngine } from "@/server/pdf";
import type { PdfEngine } from "@/server/pdf/engine";
import { renderLimiter, type Limiter } from "@/server/pdf/limiter";
import { isShareToken, newShareToken, shareTokenHash } from "@/server/sharing/token";
import { recordAudit, recordSystemAudit } from "./audit";
import { currentSharingConsentIn } from "./consent";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";
import { htmlSha256, renderDocument } from "./rx-output";
import { loadRxDocumentIn } from "./rx-documents";

export const SHARE_LIMITS = { ttlDays: 7, maxOpens: 10, linksPerUserPerHour: 60, activeLinksPerPrescription: 10 } as const;
export type ShareChannel = "whatsapp" | "email";
export type ShareLinkStatus = "active" | "expired" | "used_up" | "revoked";
export type ShareLinkView = {
  id: string;
  channel: ShareChannel;
  recipientMasked: string | null;
  createdAt: Date;
  expiresAt: Date;
  openCount: number;
  maxOpens: number;
  status: ShareLinkStatus;
  revokeReason: string | null;
};
export type CreatedLink = { linkId: string; token: string; expiresAt: Date; prescriptionId: string; patientId: string; rxNo: number; version: number };
export type ShareLinkSummary = { linkId: string; tenantId: string; expiresAt: Date; remainingOpens: number; timeZone: string };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MESSAGES = {
  notFound: "Prescription not found.",
  draft: "Finalize this prescription before sharing it.",
  superseded: "This version was replaced by a newer one. Share the latest version.",
  off: "Sharing is turned off for this clinic. The owner can turn it on in Settings.",
  consent: "Record the patient's consent to sharing first.",
  tooManyActive: "This prescription already has 10 active links. Withdraw one first.",
  tooManyRecent: "Too many links were created in the last hour. Try again later.",
  linkNotFound: "Link not found.",
  alreadyRevoked: "This link was already withdrawn.",
  unavailable: "The prescription cannot be shown right now.",
} as const;

/** One message for every unusable link, whatever the reason (decision 6). */
const linkGone = () => fail("not_found", "This link is not valid.");

export function linkStatus(link: { revokedAt: Date | null; expiresAt: Date; openCount: number; maxOpens: number }, now: Date): ShareLinkStatus {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt.getTime() <= now.getTime()) return "expired";
  if (link.openCount >= link.maxOpens) return "used_up";
  return "active";
}

/**
 * Creates a link inside the caller's transaction (the sharing service writes its share-log row in the same one).
 * Order: the prescription (finalized only), the patient row FOR SHARE (decision 13: a concurrent consent withdrawal
 * or archive, which lock it FOR UPDATE, either ran first or waits for this transaction), the clinic switch, the
 * consent, the rate limits, the insert. The caller has checked rx.share.
 */
export async function createShareLinkIn(
  tx: TenantTx,
  ctx: ServiceContext,
  input: { prescriptionId: string; channel: ShareChannel },
  now: Date,
): Promise<Result<CreatedLink>> {
  const [rx] = await tx
    .select({ id: prescriptions.id, status: prescriptions.status, rxNo: prescriptions.rxNo, version: prescriptions.version, patientId: visits.patientId })
    .from(prescriptions)
    .innerJoin(visits, eq(visits.id, prescriptions.visitId))
    .where(and(eq(prescriptions.tenantId, ctx.tenantId), eq(prescriptions.id, input.prescriptionId)))
    .limit(1);
  if (!rx) return fail("not_found", MESSAGES.notFound);
  if (rx.status === "draft") return fail("conflict", MESSAGES.draft);
  if (rx.status !== "finalized" || rx.rxNo === null) return fail("conflict", MESSAGES.superseded);

  const [patient] = await tx
    .select({ id: patients.id })
    .from(patients)
    .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, rx.patientId), isNull(patients.deletedAt)))
    .limit(1)
    .for("share");
  if (!patient) return fail("not_found", "Patient not found.");
  const clinic = await primaryClinic(tx, ctx.tenantId);
  if (!clinic?.sharingEnabled) return fail("unavailable", MESSAGES.off);
  const consent = await currentSharingConsentIn(tx, ctx.tenantId, rx.patientId);
  if (!consent?.granted) return fail("conflict", MESSAGES.consent, "consent");

  const [{ value: recent }] = await tx
    .select({ value: count() })
    .from(shareLinks)
    .where(and(eq(shareLinks.tenantId, ctx.tenantId), eq(shareLinks.createdBy, ctx.userId), gte(shareLinks.createdAt, new Date(now.getTime() - HOUR_MS))));
  if (recent >= SHARE_LIMITS.linksPerUserPerHour) return fail("unavailable", MESSAGES.tooManyRecent);
  const [{ value: active }] = await tx
    .select({ value: count() })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.tenantId, ctx.tenantId),
        eq(shareLinks.prescriptionId, rx.id),
        isNull(shareLinks.revokedAt),
        gt(shareLinks.expiresAt, now),
        lt(shareLinks.openCount, shareLinks.maxOpens),
      ),
    );
  if (active >= SHARE_LIMITS.activeLinksPerPrescription) return fail("conflict", MESSAGES.tooManyActive);

  const token = newShareToken();
  const expiresAt = new Date(now.getTime() + SHARE_LIMITS.ttlDays * DAY_MS);
  const [link] = await tx
    .insert(shareLinks)
    .values({
      tenantId: ctx.tenantId,
      prescriptionId: rx.id,
      consentId: consent.id,
      tokenHash: shareTokenHash(token),
      channel: input.channel,
      createdBy: ctx.userId,
      createdAt: now,
      expiresAt,
      maxOpens: SHARE_LIMITS.maxOpens,
    })
    .returning({ id: shareLinks.id });
  await recordAudit(tx, ctx, {
    action: "prescription.share_link_created",
    entityType: "prescription",
    entityId: rx.id,
    after: { linkId: link.id, channel: input.channel, expiresAt: expiresAt.toISOString(), maxOpens: SHARE_LIMITS.maxOpens },
  });
  return ok({ linkId: link.id, token, expiresAt, prescriptionId: rx.id, patientId: rx.patientId, rxNo: rx.rxNo, version: rx.version });
}

/** The links of one prescription, newest first, each with the masked recipient of its latest share-log row. */
export async function listShareLinksIn(tx: TenantTx, tenantId: string, prescriptionId: string, now: Date): Promise<ShareLinkView[]> {
  const links = await tx
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.tenantId, tenantId), eq(shareLinks.prescriptionId, prescriptionId)))
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
  if (links.length === 0) return [];
  const shares = await tx
    .select({ linkId: prescriptionShares.shareLinkId, recipientMasked: prescriptionShares.recipientMasked })
    .from(prescriptionShares)
    .where(and(eq(prescriptionShares.tenantId, tenantId), inArray(prescriptionShares.shareLinkId, links.map((l) => l.id))))
    .orderBy(desc(prescriptionShares.createdAt));
  const recipient = new Map<string, string>();
  for (const s of shares) if (!recipient.has(s.linkId)) recipient.set(s.linkId, s.recipientMasked);
  return links.map((l) => ({
    id: l.id,
    channel: l.channel as ShareChannel,
    recipientMasked: recipient.get(l.id) ?? null,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    openCount: l.openCount,
    maxOpens: l.maxOpens,
    status: linkStatus(l, now),
    revokeReason: l.revokeReason,
  }));
}

export async function listShareLinks(ctx: ServiceContext, prescriptionId: string): Promise<Result<ShareLinkView[]>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", "You cannot share prescriptions.");
  if (!isUuid(prescriptionId)) return fail("not_found", MESSAGES.notFound);
  return withTenant(ctx.tenantId, async (tx) => ok(await listShareLinksIn(tx, ctx.tenantId, prescriptionId, new Date())));
}

/** Withdraws one link at once (the patient's copy stops opening). */
export async function revokeShareLink(ctx: ServiceContext, linkId: string): Promise<Result<null>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", "You cannot share prescriptions.");
  if (!isUuid(linkId)) return fail("not_found", MESSAGES.linkNotFound);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<null>> => {
    const [link] = await tx
      .select({ id: shareLinks.id, prescriptionId: shareLinks.prescriptionId, revokedAt: shareLinks.revokedAt })
      .from(shareLinks)
      .where(and(eq(shareLinks.tenantId, ctx.tenantId), eq(shareLinks.id, linkId)))
      .limit(1);
    if (!link) return fail("not_found", MESSAGES.linkNotFound);
    if (link.revokedAt !== null) return fail("conflict", MESSAGES.alreadyRevoked);
    const updated = await tx
      .update(shareLinks)
      .set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: "user" })
      .where(and(eq(shareLinks.id, linkId), isNull(shareLinks.revokedAt)))
      .returning({ id: shareLinks.id });
    if (updated.length === 0) return fail("conflict", MESSAGES.alreadyRevoked);
    await recordAudit(tx, ctx, { action: "prescription.share_revoked", entityType: "prescription", entityId: link.prescriptionId, after: { linkId } });
    return ok(null);
  });
}

/** For the public GET: is this token a usable link right now? Reads only; never counts an open. */
export async function resolveShareLink(token: string, now: Date = new Date()): Promise<Result<ShareLinkSummary>> {
  if (!isShareToken(token)) return linkGone();
  const hash = shareTokenHash(token);
  const [link] = await withShareToken(hash, (tx) => tx.select().from(shareLinks).where(eq(shareLinks.tokenHash, hash)).limit(1));
  if (!link || linkStatus(link, now) !== "active") return linkGone();
  return withTenant(link.tenantId, async (tx) => {
    const clinic = await primaryClinic(tx, link.tenantId);
    if (!clinic?.sharingEnabled) return linkGone();
    return ok({ linkId: link.id, tenantId: link.tenantId, expiresAt: link.expiresAt, remainingOpens: link.maxOpens - link.openCount, timeZone: clinic.timezone });
  });
}

/**
 * For the public POST: renders the frozen pad as a PDF and only then counts the open, logs a prescription_outputs
 * row (kind shared_pdf, no actor) and audits it, in one transaction whose UPDATE re-checks every condition. A
 * failed render, a busy engine or a cancelled request burns nothing. Every unusable state answers linkGone().
 */
export async function openSharedPrescription(
  token: string,
  deps: { engine?: PdfEngine; limiter?: Limiter; signal?: AbortSignal; now?: Date } = {},
): Promise<Result<{ pdf: ArrayBuffer; fileName: string }>> {
  const now = deps.now ?? new Date();
  const resolved = await resolveShareLink(token, now);
  if (!resolved.ok) return resolved;
  const { linkId, tenantId } = resolved.value;

  const loaded = await withTenant(tenantId, async (tx) => {
    const [link] = await tx
      .select({ prescriptionId: shareLinks.prescriptionId })
      .from(shareLinks)
      .where(and(eq(shareLinks.tenantId, tenantId), eq(shareLinks.id, linkId)))
      .limit(1);
    if (!link) return linkGone();
    return loadRxDocumentIn(tx, tenantId, link.prescriptionId, { userId: null, canFinalize: false });
  });
  if (!loaded.ok || loaded.value.document.status === "draft") return linkGone();
  const bundle = loaded.value;

  const rendered = renderDocument(bundle);
  const engine = deps.engine ?? getPdfEngine();
  const run = await (deps.limiter ?? renderLimiter).run(() => engine.render(rendered, { signal: deps.signal }), { signal: deps.signal });
  if (run.busy || run.aborted === true) return fail("unavailable", MESSAGES.unavailable);
  const outcome = run.value;
  if (!outcome.ok) {
    console.warn(`[share] shared PDF failed: ${outcome.code}`);
    return fail(outcome.code === "pdf_timeout" ? "timeout" : "unavailable", MESSAGES.unavailable);
  }

  const counted = await withTenant(tenantId, async (tx) => {
    const [updated] = await tx
      .update(shareLinks)
      .set({ openCount: sql`${shareLinks.openCount} + 1`, lastOpenedAt: now })
      .where(
        and(
          eq(shareLinks.tenantId, tenantId),
          eq(shareLinks.id, linkId),
          isNull(shareLinks.revokedAt),
          gt(shareLinks.expiresAt, now),
          lt(shareLinks.openCount, shareLinks.maxOpens),
        ),
      )
      .returning({ openCount: shareLinks.openCount });
    if (!updated) return false;
    const [output] = await tx
      .insert(prescriptionOutputs)
      .values({
        tenantId,
        prescriptionId: bundle.prescriptionId,
        actorUserId: null,
        kind: "shared_pdf",
        shareLinkId: linkId,
        templateKey: bundle.document.snapshot.layout.template.key,
        paperSize: rendered.paper.size,
        pageCount: outcome.pageCount,
        byteSize: outcome.pdf.byteLength,
        htmlSha256: htmlSha256(rendered.html),
        rendererVersion: RENDERER_VERSION,
      })
      .returning({ id: prescriptionOutputs.id });
    await recordSystemAudit(tx, tenantId, {
      action: "prescription.share_opened",
      entityType: "prescription",
      entityId: bundle.prescriptionId,
      after: { linkId, outputId: output.id, version: bundle.document.version, openCount: updated.openCount },
    });
    return true;
  });
  if (!counted) return linkGone();
  return ok({ pdf: outcome.pdf, fileName: pdfFileName(bundle.document) });
}
```

In `src/server/services/patients.ts`, import `revokeActiveLinksForPatient` from `./share-revocation`, and in `archivePatient` replace the audit line with:

```ts
    // The UPDATE above locked the patient row, so no link can be created for this patient meanwhile (decision 13).
    const revokedLinks = await revokeActiveLinksForPatient(tx, ctx.tenantId, id, "patient_archived", ctx.userId);
    await recordAudit(tx, ctx, { action: "patient.archived", entityType: "patient", entityId: id, after: { revokedLinks } });
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/share-links.test.ts tests/integration/patient-archive.test.ts tests/integration/patients.test.ts` — expected: PASS (share-links 12).

- [ ] **Step 7: Write the failing route test**

`tests/integration/share-route.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, shareLinks } from "@/server/db/schema";
import { revokeShareLink } from "@/server/services/share-links";
import { createRateLimiter } from "@/server/http/rate-limit";
import { handleShareGet, handleSharePost, type ShareRouteDeps } from "@/server/http/share-route";
import { GET, HEAD } from "@/app/s/[token]/route";
import { createLimiter } from "@/server/pdf/limiter";
import { createFakePdfEngine } from "../helpers/fake-pdf-engine";
import { linkFor, shareablePrescription } from "../helpers/share";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const engine = createFakePdfEngine(1);
const PATIENT = "Route Patient आशा";
let deps: ShareRouteDeps;
const DAY = 86_400_000;

const url = (token: string) => `http://localhost:3000/s/${encodeURIComponent(token)}`;
const get = (token: string, headers: Record<string, string> = {}, extra: Partial<ShareRouteDeps> = {}) =>
  handleShareGet(new Request(url(token), { headers }), token, { ...deps, ...extra });
const post = (token: string, headers: Record<string, string> = {}, extra: Partial<ShareRouteDeps> = {}) =>
  handleSharePost(new Request(url(token), { method: "POST", headers }), token, { ...deps, ...extra });
const opens = async (linkId: string) => (await adminDb.select().from(shareLinks).where(eq(shareLinks.id, linkId)))[0].openCount;
const headerMap = (res: Response) => Object.fromEntries([...res.headers.entries()].filter(([k]) => k !== "date"));

beforeAll(async () => {
  A = await createTestTenant("route");
});

afterAll(async () => {
  await A.cleanup();
});

beforeEach(() => {
  engine.failWith = null;
  deps = { limiter: createRateLimiter({ windowMs: 60_000, max: 1000 }), engine, pdfLimiter: createLimiter({ concurrency: 2, maxQueue: 5 }) };
});

describe("GET /s/<token>", () => {
  it("shows an interstitial with no patient or clinic details, safe headers, and a POST button; it counts nothing", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const res = await get(link.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store, private, max-age=0");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('<form method="post">');
    expect(body).toContain("Open prescription (PDF)");
    expect(body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(body).not.toContain("Route Patient");
    expect(body).not.toContain("Test clinic");
    expect(await opens(link.linkId)).toBe(0);
  });

  it.each([
    ["WhatsApp's link preview", "WhatsApp/2.23.20.0 A"],
    ["Facebook's crawler", "facebookexternalhit/1.1"],
    ["Slack's unfurler", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"],
    ["a mail link scanner", "Mozilla/5.0 (compatible; MSIE 10.0) SafeLinks"],
  ])("gives %s the interstitial only: no open counted, no PDF rendered, nothing audited", async (_who, agent) => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const calls = engine.calls.length;
    const res = await get(link.token, { "user-agent": agent });
    expect(res.status).toBe(200);
    expect(await opens(link.linkId)).toBe(0);
    expect(engine.calls.length).toBe(calls);
    const events = await adminDb.select().from(auditEvents).where(eq(auditEvents.action, "prescription.share_opened"));
    expect(events.filter((e) => (e.after as { linkId?: string } | null)?.linkId === link.linkId)).toHaveLength(0);
  });

  it("answers the same 404 (status, body, headers) for every unusable link", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const expired = await linkFor(A, s.prescriptionId);
    const revoked = await linkFor(A, s.prescriptionId);
    await revokeShareLink(A.as("owner"), revoked.linkId);
    const usedUp = await linkFor(A, s.prescriptionId);
    await adminDb.update(shareLinks).set({ openCount: 1 }).where(eq(shareLinks.id, usedUp.linkId));
    for (let i = 2; i <= 10; i += 1) await adminDb.update(shareLinks).set({ openCount: i }).where(eq(shareLinks.id, usedUp.linkId));

    const answers = [
      await get("short"),
      await get("a".repeat(43)),
      await get(`${"a".repeat(41)}%2F`),
      await get(expired.token, {}, { now: () => new Date(Date.now() + 8 * DAY) }),
      await get(revoked.token),
      await get(usedUp.token),
    ];
    await adminDb.update(clinics).set({ sharingEnabled: false }).where(eq(clinics.tenantId, A.tenantId));
    answers.push(await get(expired.token));
    await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, A.tenantId));

    const bodies = await Promise.all(answers.map((r) => r.clone().text()));
    expect(answers.every((r) => r.status === 404)).toBe(true);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("This link is not valid");
    const headers = answers.map((r) => JSON.stringify(headerMap(r)));
    expect(new Set(headers).size).toBe(1);
  });

  it("is wired at /s/[token], and HEAD is refused", async () => {
    const res = await GET(new Request(url("short")), { params: Promise.resolve({ token: "short" }) });
    expect(res.status).toBe(404);
    const head = HEAD();
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET, POST");
  });

  it("refuses a burst from one address (429), separately from other addresses", async () => {
    const tight = createRateLimiter({ windowMs: 60_000, max: 2 });
    const from = (ip: string) => get("short", { "x-forwarded-for": ip }, { limiter: tight });
    expect((await from("203.0.113.1")).status).toBe(404);
    expect((await from("203.0.113.1")).status).toBe(404);
    expect((await from("203.0.113.1")).status).toBe(429);
    expect((await from("203.0.113.2")).status).toBe(404);
  });
});

describe("POST /s/<token>", () => {
  it("serves the PDF inline with no-store and noindex, and counts one open", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const res = await post(link.token, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="Rx-\d+-v1\.pdf"$/);
    expect(res.headers.get("cache-control")).toBe("no-store, private, max-age=0");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    expect(await opens(link.linkId)).toBe(1);
  });

  it("gives another site's POST the uniform 404 and counts nothing", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    for (const site of ["cross-site", "same-site"]) {
      const res = await post(link.token, { "sec-fetch-site": site });
      expect(res.status).toBe(404);
    }
    expect(await opens(link.linkId)).toBe(0);
  });

  it("answers 503 with Retry-After when the PDF service is down, and burns no open", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    engine.failWith = "pdf_unavailable";
    const res = await post(link.token);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.text()).not.toContain("Route Patient");
    expect(await opens(link.linkId)).toBe(0);
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/share-route.test.ts` — expected: FAIL (modules missing).

(The used-up link is advanced one open at a time because the `share_links_rules` trigger refuses any jump.)

- [ ] **Step 8: Pages, handlers, the route, and the desktop stash**

`src/server/http/share-pages.ts`:

```ts
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { escapeHtml } from "@/lib/rx-render/html";
import { contentDisposition } from "./response";

/** On every share-route response: never cached, never indexed, never leaks the URL as a referrer. */
export const SHARE_COMMON_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const PAGE_HEADERS = {
  ...SHARE_COMMON_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
} as const;

const STYLE =
  "body{font-family:system-ui,sans-serif;margin:0;padding:24px;color:#111;background:#fff}main{max-width:28rem;margin:0 auto}" +
  "h1{font-size:1.25rem}button{font-size:1rem;padding:.75rem 1.25rem;border-radius:.5rem;border:0;background:#111;color:#fff}" +
  ".small{font-size:.875rem;color:#555}";

/* NEEDS NATIVE-SPEAKER REVIEW: the Hindi lines below (human decision, Plan 1D). */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** The single answer for every unusable link (decision 6). It names no clinic, patient or reason. */
export function notFoundPage(): Response {
  return new Response(
    page(
      "Link not valid - ClinicPad",
      '<h1>This link is not valid</h1><p>It may have expired, been used up, or been withdrawn by the clinic. Ask the clinic to send the prescription again.</p><p lang="hi">यह लिंक मान्य नहीं है। क्लिनिक से पर्चा दोबारा भेजने को कहें।</p>',
    ),
    { status: 404, headers: PAGE_HEADERS },
  );
}

export function unavailablePage(): Response {
  return new Response(
    page("Try again later - ClinicPad", "<h1>Please try again in a few minutes</h1><p>The prescription cannot be shown right now.</p>"),
    { status: 503, headers: { ...PAGE_HEADERS, "Retry-After": "30" } },
  );
}

export function tooManyPage(): Response {
  return new Response(page("Too many requests - ClinicPad", "<h1>Too many requests</h1><p>Wait a minute, then try again.</p>"), {
    status: 429,
    headers: { ...PAGE_HEADERS, "Retry-After": "60" },
  });
}

/** GET of a usable link. Link previews and scanners stop here: nothing is counted or rendered. */
export function interstitialPage(link: { expiresAt: Date; remainingOpens: number; timeZone: string }): Response {
  const zone = isValidTimeZone(link.timeZone) ? link.timeZone : DEFAULT_TIME_ZONE;
  const expires = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(link.expiresAt);
  const times = `${link.remainingOpens} more time${link.remainingOpens === 1 ? "" : "s"}`;
  return new Response(
    page(
      "Prescription - ClinicPad",
      `<h1>Your prescription</h1><p>Your clinic has shared a prescription with you.</p><p lang="hi">आपके क्लिनिक ने आपका पर्चा भेजा है।</p>` +
        `<form method="post"><button type="submit">Open prescription (PDF)</button></form>` +
        `<p class="small">This link works until ${escapeHtml(expires)} and can be opened ${escapeHtml(times)}. Anyone who has the link can open it, so do not forward it.</p>`,
    ),
    { status: 200, headers: PAGE_HEADERS },
  );
}

export function pdfResponse(pdf: ArrayBuffer, fileName: string): Response {
  return new Response(pdf, {
    status: 200,
    headers: {
      ...SHARE_COMMON_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition("inline", fileName),
      "Content-Length": String(pdf.byteLength),
    },
  });
}

export function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { ...SHARE_COMMON_HEADERS, Allow: "GET, POST" } });
}
```

`src/server/http/share-route.ts`:

```ts
import type { PdfEngine } from "@/server/pdf/engine";
import type { Limiter } from "@/server/pdf/limiter";
import { openSharedPrescription, resolveShareLink } from "@/server/services/share-links";
import { clientKey, createRateLimiter, type RateLimiter } from "./rate-limit";
import { interstitialPage, notFoundPage, pdfResponse, tooManyPage, unavailablePage } from "./share-pages";

export type ShareRouteDeps = { limiter?: RateLimiter; engine?: PdfEngine; pdfLimiter?: Limiter; now?: () => Date };

/** Per client address, per process: 20 requests a minute to /s/... (production adds an edge limit). */
export const shareRouteLimiter: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

function allowed(request: Request, deps: ShareRouteDeps): boolean {
  return (deps.limiter ?? shareRouteLimiter).hit(clientKey(request));
}

export async function handleShareGet(request: Request, token: string, deps: ShareRouteDeps = {}): Promise<Response> {
  if (!allowed(request, deps)) return tooManyPage();
  try {
    const link = await resolveShareLink(token, deps.now?.() ?? new Date());
    return link.ok ? interstitialPage(link.value) : notFoundPage();
  } catch (error) {
    console.error("share link page failed", error instanceof Error ? error.name : typeof error);
    return unavailablePage();
  }
}

export async function handleSharePost(request: Request, token: string, deps: ShareRouteDeps = {}): Promise<Response> {
  if (!allowed(request, deps)) return tooManyPage();
  // Another site must not spend the patient's opens: it gets the same answer as an unknown link.
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return notFoundPage();
  try {
    const opened = await openSharedPrescription(token, { engine: deps.engine, limiter: deps.pdfLimiter, signal: request.signal, now: deps.now?.() });
    if (opened.ok) return pdfResponse(opened.value.pdf, opened.value.fileName);
    return opened.code === "not_found" ? notFoundPage() : unavailablePage();
  } catch (error) {
    console.error("share link open failed", error instanceof Error ? error.name : typeof error);
    return unavailablePage();
  }
}
```

`src/app/s/[token]/route.ts`:

```ts
import { handleShareGet, handleSharePost } from "@/server/http/share-route";
import { methodNotAllowed } from "@/server/http/share-pages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public by design (no session): /s is outside the middleware matcher. See ADR-0037.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return handleShareGet(request, token);
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return handleSharePost(request, token);
}

export function HEAD(): Response {
  return methodNotAllowed();
}
```

In `scripts/build-desktop.mjs`, add `"src/app/s", // public share links (server only)` to `SERVER_ONLY` after `"src/app/api/clean-data",`.

- [ ] **Step 9: Run, full suite, desktop build, commit**

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/integration/share-route.test.ts tests/integration/share-links.test.ts tests/unit/share-token.test.ts tests/unit/rate-limit.test.ts tests/unit/rx-output-http.test.ts tests/unit/gotenberg.test.ts tests/integration/rx-output-routes.test.ts
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; npm run build:desktop; git status --short
Set-Location E:\projects\clinicpad; git add src/server/sharing/token.ts src/server/sharing/config.ts src/server/db/share-token.ts src/server/services/share-links.ts src/server/services/rx-documents.ts src/server/services/rx-output.ts src/server/services/audit.ts src/server/services/patients.ts src/server/pdf/limiter.ts src/server/pdf/engine.ts src/server/pdf/gotenberg.ts src/server/http/rate-limit.ts src/server/http/share-pages.ts src/server/http/share-route.ts "src/app/s/[token]/route.ts" "src/app/(app)/prescriptions/[id]/pdf/route.ts" scripts/build-desktop.mjs tests/helpers/fake-pdf-engine.ts tests/helpers/share.ts tests/unit/share-token.test.ts tests/unit/rate-limit.test.ts tests/unit/rx-output-http.test.ts tests/unit/gotenberg.test.ts tests/integration/share-links.test.ts tests/integration/share-route.test.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(sharing): hashed expiring share links, public interstitial and PDF route, uniform 404, rate limits, PDF abort" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: share-route 11 (the preview `it.each` counts four), share-links 12; the desktop export succeeds and `git status --short` lists only this task's files (no `.desktop-stash`).

---

## Task 10: Sending — recipients, the `wa.me` link, the email provider, the share log, and the Share panel

**Files:**
- Create: `src/lib/domain/recipient.ts`, `src/server/messaging/whatsapp.ts`, `src/server/messaging/email.ts`, `src/server/services/sharing.ts`, `src/server/actions/sharing.ts`, `src/components/rx/share-panel.tsx`, `src/components/rx/share-links-list.tsx`, `tests/helpers/fake-email.ts`
- Modify: `src/app/(app)/prescriptions/[id]/page.tsx` (the panel), `tests/unit/prescription-page.test.tsx` (mocks and cases)
- Test: `tests/unit/recipient.test.ts`, `tests/unit/wa-link.test.ts`, `tests/unit/email-provider.test.ts`, `tests/integration/sharing.test.ts`, `tests/unit/share-panel.test.tsx`, `tests/e2e/sharing.spec.ts`

**Interfaces:**
- Consumes: Task 9's `createShareLinkIn`, `listShareLinksIn`, `ShareLinkView`, `CreatedLink`, `resolveAppUrl`, `shareUrl`; Task 8's `currentSharingConsentIn`, `ConsentView`, `ConsentCard`, `prescriptionShares`, `shareLinks`; `normalizePhone` (hardened in Task 5); `cleanText`; `escapeHtml`; `primaryClinic`; `DEFAULT_TIME_ZONE`, `isValidTimeZone`; `recordAudit`.
- Produces:
  - `src/lib/domain/recipient.ts`: `type PhoneRecipient = { ok: true; digits: string; masked: string } | { ok: false; message: string }`; `type EmailRecipient = { ok: true; address: string; masked: string } | { ok: false; message: string }`; `RECIPIENT_MESSAGES`; `whatsAppRecipient(raw: string): PhoneRecipient`; `emailRecipient(raw: string): EmailRecipient`; `maskDigits(digits: string): string`.
  - `src/server/messaging/whatsapp.ts`: `type ShareMessageParts = { clinicName: string; rxNo: number; version: number; url: string; expiresOn: string }`; `shareMessageText(parts): string`; `waMeLink(digits: string, text: string): string`.
  - `src/server/messaging/email.ts`: `type EmailMessage = { to; subject; text; html }`; `type EmailFailureCode = "email_unavailable" | "email_rejected" | "email_timeout"`; `type EmailOutcome`; `interface EmailProvider { readonly name: "resend" | "fake"; send(message): Promise<EmailOutcome> }`; `createResendProvider({ apiKey, from, fetch?, timeoutMs? })`; `getEmailProvider(env?): EmailProvider | null`; `shareEmailMessage(parts: ShareMessageParts & { to: string; maxOpens: number }): EmailMessage`.
  - `src/server/services/sharing.ts`: `type WhatsAppShare = { linkId; url; waUrl; expiresAt: Date; recipientMasked }`; `type EmailShare = { linkId; expiresAt: Date; recipientMasked }`; `type SharePanelData = { prescriptionId; patientId; status: "finalized" | "amended"; enabled: boolean; consent: ConsentView | null; links: ShareLinkView[]; emailAvailable: boolean; defaultPhone: string; timeZone: string }`; `shareByWhatsApp(ctx, { prescriptionId, phone: unknown }, deps?: { appUrl?: string | null; now?: Date })`; `shareByEmail(ctx, { prescriptionId, email: unknown }, deps?: { email?: EmailProvider | null; appUrl?: string | null; now?: Date })`; `getSharePanel(ctx, prescriptionId, deps?: { email?: EmailProvider | null })`; `EMAILS_PER_PRESCRIPTION_PER_DAY = 5`.
  - Actions: `type ShareFormState = { error?; field?; waUrl?; url?; sentTo?; expiresAt? }`, `type RevokeFormState = { error? }`; `shareWhatsAppAction(prescriptionId, prev, formData)` (field `phone`); `shareEmailAction(prescriptionId, prev, formData)` (field `email`); `revokeShareLinkAction(prescriptionId, linkId, prev)`.
  - Components: `SharePanel({ data, canCaptureConsent, isOwner })`; `ShareLinksList({ prescriptionId, links, timeZone })`. Labels the e2e relies on: "Share with the patient", "WhatsApp number", "Create WhatsApp message", "Open WhatsApp", "Copy link", "Share link", "Email address", "Send by email", "Links sent", "Withdraw link".
  - `tests/helpers/fake-email.ts`: `createFakeEmailProvider(): FakeEmailProvider` (`sent: EmailMessage[]`, `failWith: EmailFailureCode | null`).

- [ ] **Step 1: Write the failing pure tests**

`tests/unit/recipient.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { emailRecipient, RECIPIENT_MESSAGES, whatsAppRecipient } from "@/lib/domain/recipient";

describe("whatsAppRecipient", () => {
  it.each([
    ["98765 43210", "919876543210"],
    ["098765-43210", "919876543210"],
    ["+91 98765 43210", "919876543210"],
    ["91 98765 43210", "919876543210"],
    ["0091 98765 43210", "919876543210"],
    ["+0091 98765 43210", "919876543210"],
    ["tel:+91-98765-43210", "919876543210"],
    ["\u200E+91 98765 43210", "919876543210"],
    ["\u202A+1 415 555 0100\u202C", "14155550100"],
    ["+1 (415) 555-0100", "14155550100"],
    ["+971 50 123 4567", "971501234567"],
    ["+44 7700 900123", "447700900123"],
    // A Bangalore landline in E.164 form: right digits; WhatsApp will simply not find an account.
    ["080 2345 6789", "918023456789"],
  ])("%j -> wa.me/%s", (raw, digits) => {
    expect(whatsAppRecipient(raw)).toMatchObject({ ok: true, digits });
  });

  it("masks all but the country code and the last four digits", () => {
    expect(whatsAppRecipient("98765 43210")).toEqual({ ok: true, digits: "919876543210", masked: "+91******3210" });
    expect(whatsAppRecipient("+1 415 555 0100")).toMatchObject({ masked: "+14*****0100" });
  });

  it.each([
    ["", RECIPIENT_MESSAGES.phoneEmpty],
    ["   ", RECIPIENT_MESSAGES.phoneEmpty],
    ["98765 abcde", RECIPIENT_MESSAGES.phoneChars],
    ["9.87654E+09", RECIPIENT_MESSAGES.phoneChars],
    ["12", RECIPIENT_MESSAGES.phoneInvalid],
    // Ten digits not starting 6-9: not an Indian mobile (a foreign number typed without +, or a 4-digit STD landline).
    ["4155550100", RECIPIENT_MESSAGES.notMobile],
    ["0141 234 5678", RECIPIENT_MESSAGES.notMobile],
    // Eleven digits with no +: we cannot know the country.
    ["14155550100", RECIPIENT_MESSAGES.needsCountry],
  ])("refuses %j rather than guessing", (raw, message) => {
    expect(whatsAppRecipient(raw)).toEqual({ ok: false, message });
  });
});

describe("emailRecipient", () => {
  it("accepts an address, lower-cases the domain, and masks the local part", () => {
    expect(emailRecipient("  Asha.Rao@Example.COM ")).toEqual({ ok: true, address: "Asha.Rao@example.com", masked: "A***@example.com" });
  });

  it.each([
    ["", RECIPIENT_MESSAGES.emailEmpty],
    ["asha", RECIPIENT_MESSAGES.emailInvalid],
    ["asha@localhost", RECIPIENT_MESSAGES.emailInvalid],
    ["a b@example.com", RECIPIENT_MESSAGES.emailInvalid],
    ["a@example.com\r\nBcc: victim@example.com", RECIPIENT_MESSAGES.emailInvalid],
    ["a@example.com\u0000", RECIPIENT_MESSAGES.emailInvalid],
    ["<a@example.com>", RECIPIENT_MESSAGES.emailInvalid],
    [`${"a".repeat(65)}@example.com`, RECIPIENT_MESSAGES.emailInvalid],
  ])("refuses %j", (raw, message) => {
    expect(emailRecipient(raw)).toEqual({ ok: false, message });
  });
});
```

`tests/unit/wa-link.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shareMessageText, waMeLink } from "@/server/messaging/whatsapp";

const parts = { clinicName: "Asha  Clinic\nPune", rxNo: 12, version: 2, url: "https://app.clinicpad.in/s/AbC_-123", expiresOn: "24 Nov 2026" };

describe("shareMessageText", () => {
  it("names the clinic, the Rx number and the expiry, and carries the link; never the patient or clinical text", () => {
    const text = shareMessageText(parts);
    expect(text).toBe("Asha Clinic Pune: your prescription Rx 12 v2 is ready. Open it here (the link works until 24 Nov 2026): https://app.clinicpad.in/s/AbC_-123");
  });

  it("falls back to a neutral sender and caps a long clinic name", () => {
    expect(shareMessageText({ ...parts, clinicName: "   " })).toMatch(/^Your clinic: /);
    expect(shareMessageText({ ...parts, clinicName: "x".repeat(500) }).indexOf(":")).toBeLessThanOrEqual(80);
  });
});

describe("waMeLink", () => {
  it("is the universal https://wa.me link (works on phones and on desktop), digits only, the text encoded", () => {
    const link = waMeLink("919876543210", shareMessageText(parts));
    expect(link.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(link).not.toContain("whatsapp://");
    expect(decodeURIComponent(new URL(link).searchParams.get("text") ?? "")).toContain(parts.url);
    expect(new URL(link).searchParams.get("text")).toBe(shareMessageText(parts));
    expect(link.length).toBeLessThan(2048);
  });

  it.each(["+919876543210", "91 98765", "1234567", "1".repeat(16), "91987654321a"])("refuses %j as digits", (digits) => {
    expect(() => waMeLink(digits, "x")).toThrow();
  });
});
```

`tests/unit/email-provider.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createResendProvider, getEmailProvider, shareEmailMessage, type EmailMessage } from "@/server/messaging/email";

const MESSAGE: EmailMessage = { to: "asha@example.com", subject: "Your prescription", text: "t", html: "<p>h</p>" };

function recorder(respond: () => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { calls, impl };
}

describe("createResendProvider", () => {
  it("posts one JSON message to Resend with the API key and returns its id", async () => {
    const { calls, impl } = recorder(async () => Response.json({ id: "re_123" }));
    const outcome = await createResendProvider({ apiKey: "test-key", from: "ClinicPad <no-reply@clinicpad.test>", fetch: impl }).send(MESSAGE);
    expect(outcome).toEqual({ ok: true, providerMessageId: "re_123" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ from: "ClinicPad <no-reply@clinicpad.test>", to: ["asha@example.com"], subject: "Your prescription", text: "t", html: "<p>h</p>" });
  });

  it.each([
    [422, "email_rejected"],
    [403, "email_rejected"],
    [429, "email_unavailable"],
    [500, "email_unavailable"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const { impl } = recorder(async () => new Response("{}", { status }));
    expect(await createResendProvider({ apiKey: "k", from: "a@b.test", fetch: impl }).send(MESSAGE)).toEqual({ ok: false, code });
  });

  it("maps a network error and a timeout, and tolerates a body that is not JSON", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const slow: typeof fetch = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    expect(await createResendProvider({ apiKey: "k", from: "a@b.test", fetch: down }).send(MESSAGE)).toEqual({ ok: false, code: "email_unavailable" });
    expect(await createResendProvider({ apiKey: "k", from: "a@b.test", fetch: slow }).send(MESSAGE)).toEqual({ ok: false, code: "email_timeout" });
    const { impl } = recorder(async () => new Response("ok", { status: 200 }));
    expect(await createResendProvider({ apiKey: "k", from: "a@b.test", fetch: impl }).send(MESSAGE)).toEqual({ ok: true, providerMessageId: null });
  });
});

describe("getEmailProvider", () => {
  it.each([
    [{}],
    [{ RESEND_API_KEY: "", EMAIL_FROM: "a@b.test" }],
    [{ RESEND_API_KEY: "k", EMAIL_FROM: "" }],
    [{ RESEND_API_KEY: "k", EMAIL_FROM: "no-at-sign" }],
    [{ RESEND_API_KEY: "k", EMAIL_FROM: "a@b.test\r\nBcc: x@y.test" }],
  ])("is null (email hidden) for %j", (env) => {
    expect(getEmailProvider(env)).toBeNull();
  });

  it("builds the Resend adapter only when both are set, without any network call", () => {
    expect(getEmailProvider({ RESEND_API_KEY: "k", EMAIL_FROM: "ClinicPad <no-reply@clinicpad.test>" })?.name).toBe("resend");
  });
});

describe("shareEmailMessage", () => {
  it("escapes the clinic name in HTML, keeps headers single-line, and carries the link but no patient data", () => {
    const m = shareEmailMessage({ to: "a@b.test", clinicName: 'Asha <b>Clinic</b>\r\nBcc: x', rxNo: 7, version: 1, url: "https://app.test/s/T", expiresOn: "24 Nov 2026", maxOpens: 10 });
    expect(m.subject).toBe("Your prescription from Asha <b>Clinic</b> Bcc: x");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).toContain("Asha &lt;b&gt;Clinic&lt;/b&gt;");
    expect(m.html).toContain('href="https://app.test/s/T"');
    expect(m.text).toContain("https://app.test/s/T");
    expect(m.text).toContain("10 times until 24 Nov 2026");
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/recipient.test.ts tests/unit/wa-link.test.ts tests/unit/email-provider.test.ts` — expected: FAIL (modules missing).

- [ ] **Step 2: Write the recipient, WhatsApp and email modules**

`src/lib/domain/recipient.ts`:

```ts
import { normalizePhone } from "./phone";
import { cleanText } from "./text";

export type PhoneRecipient = { ok: true; digits: string; masked: string } | { ok: false; message: string };
export type EmailRecipient = { ok: true; address: string; masked: string } | { ok: false; message: string };

export const RECIPIENT_MESSAGES = {
  phoneEmpty: "Enter the WhatsApp number.",
  phoneChars: "Use digits only, for example +91 98765 43210.",
  phoneInvalid: "This is not a valid phone number.",
  notMobile: "This is not an Indian mobile number. For another country, start with + and the country code.",
  needsCountry: "Add the country code, for example +44 7700 900123.",
  emailEmpty: "Enter the email address.",
  emailInvalid: "This is not a valid email address.",
} as const;

const refuse = (message: string) => ({ ok: false as const, message });

/** "+91******3210": the first two digits and the last four; the share log never stores more (decision 11). */
export function maskDigits(digits: string): string {
  return `+${digits.slice(0, 2)}${"*".repeat(Math.max(0, digits.length - 6))}${digits.slice(-4)}`;
}

/**
 * The full international number, digits only, that wa.me needs. Indian numbers may be typed nationally (98765
 * 43210, 0 98765 43210, 91 98765 43210) and must be mobiles (6-9); any other country needs + and its code. Anything
 * ambiguous is refused with what to type: a wrong number would send a prescription to a stranger.
 */
export function whatsAppRecipient(raw: string): PhoneRecipient {
  const text = cleanText(raw).replace(/\p{Cf}/gu, "").trim().replace(/^tel:/i, "").trim();
  if (text === "") return refuse(RECIPIENT_MESSAGES.phoneEmpty);
  if (!/^\+?[\d\s().-]+$/.test(text)) return refuse(RECIPIENT_MESSAGES.phoneChars);
  const normalized = normalizePhone(text);
  if (normalized === null) return refuse(RECIPIENT_MESSAGES.phoneInvalid);
  const typedDigits = text.replace(/\D/g, "");
  const international = text.startsWith("+") || typedDigits.startsWith("00");
  const indian = normalized.length === 10 && (!international || /^(?:00)?91/.test(typedDigits));
  let digits: string;
  if (indian) {
    if (!/^[6-9]/.test(normalized)) return refuse(RECIPIENT_MESSAGES.notMobile);
    digits = `91${normalized}`;
  } else if (international) {
    digits = normalized;
  } else {
    return refuse(RECIPIENT_MESSAGES.needsCountry);
  }
  return { ok: true, digits, masked: maskDigits(digits) };
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** A plain address only. Control characters (a CR/LF header injection, a NUL) are refused before any cleaning. */
export function emailRecipient(raw: string): EmailRecipient {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return refuse(RECIPIENT_MESSAGES.emailInvalid);
  const text = cleanText(raw).trim();
  if (text === "") return refuse(RECIPIENT_MESSAGES.emailEmpty);
  if (text.length > 254 || !EMAIL.test(text)) return refuse(RECIPIENT_MESSAGES.emailInvalid);
  const at = text.lastIndexOf("@");
  const local = text.slice(0, at);
  const domain = text.slice(at + 1).toLowerCase();
  return { ok: true, address: `${local}@${domain}`, masked: `${local[0]}***@${domain}` };
}
```

(The control-character regex is written with `\u` escapes in source; do not paste raw characters.)

`src/server/messaging/whatsapp.ts`:

```ts
export type ShareMessageParts = { clinicName: string; rxNo: number; version: number; url: string; expiresOn: string };

const MAX_CLINIC = 80;

/**
 * The WhatsApp text: clinic, Rx number, link, expiry. Never the patient's name or clinical text — WhatsApp shows
 * messages in notifications and people forward them (decision 9).
 */
export function shareMessageText(p: ShareMessageParts): string {
  const clinic = p.clinicName.replace(/\s+/g, " ").trim().slice(0, MAX_CLINIC) || "Your clinic";
  const label = `Rx ${p.rxNo}${p.version > 1 ? ` v${p.version}` : ""}`;
  return `${clinic}: your prescription ${label} is ready. Open it here (the link works until ${p.expiresOn}): ${p.url}`;
}

/**
 * The universal link (not whatsapp://): on a phone it opens the app, on a desktop the WhatsApp Desktop or Web
 * prompt, with the text filled in. The clinic presses send; ClinicPad sends nothing itself.
 */
export function waMeLink(digits: string, text: string): string {
  if (!/^\d{8,15}$/.test(digits)) throw new Error("waMeLink needs 8 to 15 digits");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
```

`src/server/messaging/email.ts`:

```ts
import { escapeHtml } from "@/lib/rx-render/html";
import type { ShareMessageParts } from "./whatsapp";
import { shareMessageText } from "./whatsapp";

export type EmailMessage = { to: string; subject: string; text: string; html: string };
export type EmailFailureCode = "email_unavailable" | "email_rejected" | "email_timeout";
export type EmailOutcome = { ok: true; providerMessageId: string | null } | { ok: false; code: EmailFailureCode };

/** Sends one message. Never throws: every failure is a code. Tests use a fake (tests/helpers/fake-email.ts). */
export interface EmailProvider {
  readonly name: "resend" | "fake";
  send(message: EmailMessage): Promise<EmailOutcome>;
}

const RESEND_URL = "https://api.resend.com/emails";

export function createResendProvider(opts: { apiKey: string; from: string; fetch?: typeof fetch; timeoutMs?: number }): EmailProvider {
  const fetchImpl = opts.fetch ?? fetch;
  return {
    name: "resend",
    async send(message) {
      let response: Response;
      try {
        response = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: opts.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { ok: false, code: timedOut ? "email_timeout" : "email_unavailable" };
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, code: "email_unavailable" };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, code: "email_rejected" };
      }
      try {
        const body = (await response.json()) as { id?: unknown };
        return { ok: true, providerMessageId: typeof body.id === "string" ? body.id.slice(0, 200) : null };
      } catch {
        return { ok: true, providerMessageId: null };
      }
    },
  };
}

/**
 * Email is available only when RESEND_API_KEY and a plausible EMAIL_FROM are both set (decision 10); otherwise null
 * and the Share panel says email is not set up. Building the adapter makes no network call.
 */
export function getEmailProvider(env: { RESEND_API_KEY?: string; EMAIL_FROM?: string } = process.env): EmailProvider | null {
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.EMAIL_FROM ?? "").trim();
  if (apiKey === "" || from === "" || !from.includes("@") || /[\r\n]/.test(from)) return null;
  return createResendProvider({ apiKey, from });
}

const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/** The email body: the same link and expiry as WhatsApp, no attachment, no patient data. */
export function shareEmailMessage(p: ShareMessageParts & { to: string; maxOpens: number }): EmailMessage {
  const clinic = singleLine(p.clinicName).slice(0, 80) || "your clinic";
  const intro = shareMessageText(p);
  const note = `This link opens the prescription as a PDF. It works ${p.maxOpens} times until ${p.expiresOn}. If you were not expecting this email, you can ignore it.`;
  return {
    to: p.to,
    subject: `Your prescription from ${clinic}`,
    text: `${intro}\n\n${note}\n`,
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(p.url)}">Open your prescription</a></p><p>${escapeHtml(note)}</p>`,
  };
}
```

`tests/helpers/fake-email.ts`:

```ts
import type { EmailFailureCode, EmailMessage, EmailProvider } from "@/server/messaging/email";

export type FakeEmailProvider = EmailProvider & { sent: EmailMessage[]; failWith: EmailFailureCode | null };

/** Records what would have been sent; never touches the network. */
export function createFakeEmailProvider(): FakeEmailProvider {
  const provider: FakeEmailProvider = {
    name: "fake",
    sent: [],
    failWith: null,
    async send(message) {
      provider.sent.push(message);
      return provider.failWith ? { ok: false, code: provider.failWith } : { ok: true, providerMessageId: `fake-${provider.sent.length}` };
    },
  };
  return provider;
}
```

Run the three unit files — expected: PASS (recipient 31, wa-link 8, email-provider 13).

- [ ] **Step 3: Write the failing sharing-service test**

`tests/integration/sharing.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, prescriptionShares, shareLinks } from "@/server/db/schema";
import { startPrescription } from "@/server/services/prescriptions";
import { getSharePanel, shareByEmail, shareByWhatsApp } from "@/server/services/sharing";
import { createFakeEmailProvider } from "../helpers/fake-email";
import { shareablePrescription } from "../helpers/share";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const APP = "http://localhost:3000";
const NAME = "Sharing Patient Meena";

beforeAll(async () => {
  A = await createTestTenant("sharing-svc");
  await adminDb.update(clinics).set({ name: "Asha <b>Clinic</b>" }).where(eq(clinics.tenantId, A.tenantId));
});

afterAll(async () => {
  await A.cleanup();
});

const sharesOf = (prescriptionId: string) => adminDb.select().from(prescriptionShares).where(eq(prescriptionShares.prescriptionId, prescriptionId));

describe("shareByWhatsApp", () => {
  it("returns a wa.me link for the patient's number with the share URL, and logs a masked recipient", async () => {
    const s = await shareablePrescription(A, NAME, "098765-43210");
    const result = await shareByWhatsApp(A.as("reception"), { prescriptionId: s.prescriptionId, phone: "098765-43210" }, { appUrl: APP });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.waUrl.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    const text = new URL(result.value.waUrl).searchParams.get("text") ?? "";
    expect(text).toContain(result.value.url);
    expect(result.value.url).toMatch(/^http:\/\/localhost:3000\/s\/[A-Za-z0-9_-]{43}$/);
    expect(text).toContain("Asha <b>Clinic</b>");
    expect(text).not.toContain("Meena");
    expect(result.value.recipientMasked).toBe("+91******3210");

    const [share] = await sharesOf(s.prescriptionId);
    expect(share).toMatchObject({ channel: "whatsapp", recipientMasked: "+91******3210", provider: "wa_link", status: "prepared", shareLinkId: result.value.linkId });
    const stored = JSON.stringify([await sharesOf(s.prescriptionId), await adminDb.select().from(shareLinks).where(eq(shareLinks.id, result.value.linkId))]);
    expect(stored).not.toContain("9876543210");
    const events = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.entityId, s.prescriptionId)));
    const shared = events.find((e) => e.action === "prescription.shared");
    expect(shared?.after).toMatchObject({ linkId: result.value.linkId, channel: "whatsapp", status: "prepared" });
    expect(JSON.stringify(events)).not.toMatch(/9876543210|\/s\/|Meena/);
  });

  it("refuses a bad number, a missing app URL, a draft, and roles without rx.share, creating no link", async () => {
    const s = await shareablePrescription(A, NAME);
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: s.prescriptionId, phone: "4155550100" }, { appUrl: APP })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "phone",
    });
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: s.prescriptionId, phone: "98765 43210" }, { appUrl: null })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    for (const role of ["nurse", "pharmacist", "accountant"]) {
      expect(await shareByWhatsApp(A.as(role), { prescriptionId: s.prescriptionId, phone: "98765 43210" }, { appUrl: APP })).toMatchObject({ ok: false, code: "forbidden" });
    }
    const draft = await startPrescription(A.as("doctor"), { patientId: s.patientId });
    if (!draft.ok) throw new Error(draft.message);
    expect(await shareByWhatsApp(A.as("doctor"), { prescriptionId: draft.value.prescriptionId, phone: "98765 43210" }, { appUrl: APP })).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(await adminDb.select().from(shareLinks).where(eq(shareLinks.prescriptionId, s.prescriptionId))).toHaveLength(0);
  });
});

describe("shareByEmail", () => {
  it("is unavailable when no provider is configured", async () => {
    const s = await shareablePrescription(A, NAME);
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com" }, { email: null, appUrl: APP })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("sends the link through the provider, escapes the clinic name in HTML, and logs the result", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    const result = await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "Meena.R@Example.com" }, { email, appUrl: APP });
    expect(result).toMatchObject({ ok: true, value: { recipientMasked: "M***@example.com" } });
    expect(email.sent).toHaveLength(1);
    const [m] = email.sent;
    expect(m.to).toBe("Meena.R@example.com");
    expect(m.subject).toBe("Your prescription from Asha <b>Clinic</b>");
    expect(m.html).toContain("Asha &lt;b&gt;Clinic&lt;/b&gt;");
    expect(m.text).toMatch(/http:\/\/localhost:3000\/s\/[A-Za-z0-9_-]{43}/);
    expect(`${m.subject} ${m.text} ${m.html}`).not.toContain("Sharing Patient");
    const [share] = await sharesOf(s.prescriptionId);
    expect(share).toMatchObject({ channel: "email", status: "sent", provider: "fake", providerMessageId: "fake-1", recipientMasked: "M***@example.com" });
  });

  it("refuses a header-injection address before anything is created", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    expect(
      await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com\r\nBcc: x@example.com" }, { email, appUrl: APP }),
    ).toMatchObject({ ok: false, code: "invalid", field: "email" });
    expect(email.sent).toHaveLength(0);
  });

  it("withdraws the link and logs the failure when the provider fails", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    email.failWith = "email_rejected";
    const result = await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "a@example.com" }, { email, appUrl: APP });
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    const [share] = await sharesOf(s.prescriptionId);
    expect(share).toMatchObject({ status: "failed", errorCode: "email_rejected" });
    const [link] = await adminDb.select().from(shareLinks).where(eq(shareLinks.id, share.shareLinkId));
    expect(link.revokeReason).toBe("send_failed");
  });

  it("sends at most five emails per prescription a day", async () => {
    const s = await shareablePrescription(A, NAME);
    const email = createFakeEmailProvider();
    for (let i = 0; i < 5; i += 1) {
      expect((await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: `p${i}@example.com` }, { email, appUrl: APP })).ok).toBe(true);
    }
    expect(await shareByEmail(A.as("doctor"), { prescriptionId: s.prescriptionId, email: "p5@example.com" }, { email, appUrl: APP })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(email.sent).toHaveLength(5);
  });
});

describe("getSharePanel", () => {
  it("gives the panel what it shows, only for rx.share roles and signed versions", async () => {
    const s = await shareablePrescription(A, NAME, "98765 43210");
    await shareByWhatsApp(A.as("doctor"), { prescriptionId: s.prescriptionId, phone: "98765 43210" }, { appUrl: APP });
    const panel = await getSharePanel(A.as("reception"), s.prescriptionId, { email: null });
    expect(panel).toMatchObject({
      ok: true,
      value: { status: "finalized", enabled: true, emailAvailable: false, defaultPhone: "98765 43210", timeZone: "Asia/Kolkata", consent: { granted: true } },
    });
    expect(panel.ok && panel.value.links.map((l) => [l.status, l.recipientMasked])).toEqual([["active", "+91******3210"]]);
    expect(await getSharePanel(A.as("pharmacist"), s.prescriptionId)).toMatchObject({ ok: false, code: "forbidden" });
    const draft = await startPrescription(A.as("doctor"), { patientId: s.patientId });
    if (!draft.ok) throw new Error(draft.message);
    expect(await getSharePanel(A.as("doctor"), draft.value.prescriptionId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getSharePanel(A.as("doctor"), s.prescriptionId, { email: createFakeEmailProvider() })).toMatchObject({ ok: true, value: { emailAvailable: true } });
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/sharing.test.ts` — expected: FAIL (module missing).

- [ ] **Step 4: Write the sharing service and actions**

`src/server/services/sharing.ts`:

```ts
import { and, count, eq, gte, isNull } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { emailRecipient, whatsAppRecipient } from "@/lib/domain/recipient";
import { fail, ok, type Result } from "@/lib/result";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { patients, prescriptionShares, prescriptions, shareLinks, visits } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { getEmailProvider, shareEmailMessage, type EmailMessage, type EmailProvider } from "@/server/messaging/email";
import { shareMessageText, waMeLink } from "@/server/messaging/whatsapp";
import { resolveAppUrl, shareUrl } from "@/server/sharing/config";
import { recordAudit } from "./audit";
import { currentSharingConsentIn, type ConsentView } from "./consent";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";
import { createShareLinkIn, listShareLinksIn, SHARE_LIMITS, type CreatedLink, type ShareLinkView } from "./share-links";

export type WhatsAppShare = { linkId: string; url: string; waUrl: string; expiresAt: Date; recipientMasked: string };
export type EmailShare = { linkId: string; expiresAt: Date; recipientMasked: string };
export type SharePanelData = {
  prescriptionId: string;
  patientId: string;
  status: "finalized" | "amended";
  enabled: boolean;
  consent: ConsentView | null;
  links: ShareLinkView[];
  emailAvailable: boolean;
  defaultPhone: string;
  timeZone: string;
};

export const EMAILS_PER_PRESCRIPTION_PER_DAY = 5;
const DAY_MS = 86_400_000;
const FORBIDDEN = "You cannot share prescriptions.";
const NOT_FOUND = "Prescription not found.";
const NO_APP_URL = "Sharing is not set up on this server (NEXT_PUBLIC_APP_URL).";
const NO_EMAIL = "Email sharing is not set up on this server.";
const EMAIL_FAILED = "The email could not be sent, so its link was withdrawn. Try again, or share by WhatsApp.";
const TOO_MANY_EMAILS = "Five emails were already sent for this prescription today. Try again tomorrow, or share by WhatsApp.";

function zoneOf(timezone: string | null | undefined): string {
  return isValidTimeZone(timezone) ? timezone : DEFAULT_TIME_ZONE;
}

function dayText(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone }).format(at);
}

/**
 * Creates a link and a WhatsApp message for the clinic to send from its own WhatsApp (decision 9). The full number
 * is used only to build the wa.me URL that goes back to the browser; the share log keeps the masked form.
 */
export async function shareByWhatsApp(
  ctx: ServiceContext,
  input: { prescriptionId: string; phone: unknown },
  deps: { appUrl?: string | null; now?: Date } = {},
): Promise<Result<WhatsAppShare>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", FORBIDDEN);
  if (!isUuid(input.prescriptionId)) return fail("not_found", NOT_FOUND);
  const recipient = whatsAppRecipient(typeof input.phone === "string" ? input.phone : "");
  if (!recipient.ok) return fail("invalid", recipient.message, "phone");
  const appUrl = deps.appUrl === undefined ? resolveAppUrl(process.env) : deps.appUrl;
  if (!appUrl) return fail("unavailable", NO_APP_URL);
  const now = deps.now ?? new Date();

  return withTenant(ctx.tenantId, async (tx): Promise<Result<WhatsAppShare>> => {
    const link = await createShareLinkIn(tx, ctx, { prescriptionId: input.prescriptionId, channel: "whatsapp" }, now);
    if (!link.ok) return link;
    const clinic = await primaryClinic(tx, ctx.tenantId);
    const [share] = await tx
      .insert(prescriptionShares)
      .values({
        tenantId: ctx.tenantId,
        prescriptionId: link.value.prescriptionId,
        shareLinkId: link.value.linkId,
        channel: "whatsapp",
        recipientMasked: recipient.masked,
        provider: "wa_link",
        status: "prepared",
        actorUserId: ctx.userId,
      })
      .returning({ id: prescriptionShares.id });
    await recordAudit(tx, ctx, {
      action: "prescription.shared",
      entityType: "prescription",
      entityId: link.value.prescriptionId,
      after: { linkId: link.value.linkId, shareId: share.id, channel: "whatsapp", status: "prepared" },
    });
    const url = shareUrl(link.value.token, appUrl);
    const text = shareMessageText({
      clinicName: clinic?.name ?? "",
      rxNo: link.value.rxNo,
      version: link.value.version,
      url,
      expiresOn: dayText(link.value.expiresAt, zoneOf(clinic?.timezone)),
    });
    return ok({ linkId: link.value.linkId, url, waUrl: waMeLink(recipient.digits, text), expiresAt: link.value.expiresAt, recipientMasked: recipient.masked });
  });
}

/**
 * Emails an expiring link (no attachment, decision 10). The link is created first (one transaction), the provider
 * is called outside any transaction, and the outcome is logged in a second one; a failed send withdraws its link.
 */
export async function shareByEmail(
  ctx: ServiceContext,
  input: { prescriptionId: string; email: unknown },
  deps: { email?: EmailProvider | null; appUrl?: string | null; now?: Date } = {},
): Promise<Result<EmailShare>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", FORBIDDEN);
  if (!isUuid(input.prescriptionId)) return fail("not_found", NOT_FOUND);
  const provider = deps.email === undefined ? getEmailProvider() : deps.email;
  if (!provider) return fail("unavailable", NO_EMAIL);
  const recipient = emailRecipient(typeof input.email === "string" ? input.email : "");
  if (!recipient.ok) return fail("invalid", recipient.message, "email");
  const appUrl = deps.appUrl === undefined ? resolveAppUrl(process.env) : deps.appUrl;
  if (!appUrl) return fail("unavailable", NO_APP_URL);
  const now = deps.now ?? new Date();

  const prepared = await withTenant(ctx.tenantId, async (tx): Promise<Result<{ link: CreatedLink; message: EmailMessage }>> => {
    const [{ value: sentToday }] = await tx
      .select({ value: count() })
      .from(prescriptionShares)
      .where(
        and(
          eq(prescriptionShares.tenantId, ctx.tenantId),
          eq(prescriptionShares.prescriptionId, input.prescriptionId),
          eq(prescriptionShares.channel, "email"),
          gte(prescriptionShares.createdAt, new Date(now.getTime() - DAY_MS)),
        ),
      );
    if (sentToday >= EMAILS_PER_PRESCRIPTION_PER_DAY) return fail("unavailable", TOO_MANY_EMAILS);
    const link = await createShareLinkIn(tx, ctx, { prescriptionId: input.prescriptionId, channel: "email" }, now);
    if (!link.ok) return link;
    const clinic = await primaryClinic(tx, ctx.tenantId);
    const message = shareEmailMessage({
      to: recipient.address,
      clinicName: clinic?.name ?? "",
      rxNo: link.value.rxNo,
      version: link.value.version,
      url: shareUrl(link.value.token, appUrl),
      expiresOn: dayText(link.value.expiresAt, zoneOf(clinic?.timezone)),
      maxOpens: SHARE_LIMITS.maxOpens,
    });
    return ok({ link: link.value, message });
  });
  if (!prepared.ok) return prepared;
  const { link, message } = prepared.value;

  // Outside any transaction: a network call must never hold a database transaction open.
  const outcome = await provider.send(message);

  return withTenant(ctx.tenantId, async (tx): Promise<Result<EmailShare>> => {
    const [share] = await tx
      .insert(prescriptionShares)
      .values({
        tenantId: ctx.tenantId,
        prescriptionId: link.prescriptionId,
        shareLinkId: link.linkId,
        channel: "email",
        recipientMasked: recipient.masked,
        provider: provider.name,
        status: outcome.ok ? "sent" : "failed",
        providerMessageId: outcome.ok ? outcome.providerMessageId : null,
        errorCode: outcome.ok ? null : outcome.code,
        actorUserId: ctx.userId,
      })
      .returning({ id: prescriptionShares.id });
    if (!outcome.ok) {
      await tx
        .update(shareLinks)
        .set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: "send_failed" })
        .where(and(eq(shareLinks.tenantId, ctx.tenantId), eq(shareLinks.id, link.linkId), isNull(shareLinks.revokedAt)));
    }
    await recordAudit(tx, ctx, {
      action: "prescription.shared",
      entityType: "prescription",
      entityId: link.prescriptionId,
      after: { linkId: link.linkId, shareId: share.id, channel: "email", status: outcome.ok ? "sent" : "failed" },
    });
    return outcome.ok
      ? ok({ linkId: link.linkId, expiresAt: link.expiresAt, recipientMasked: recipient.masked })
      : fail("unavailable", EMAIL_FAILED);
  });
}

/** Everything the Share panel shows for one signed version (drafts have no panel). */
export async function getSharePanel(
  ctx: ServiceContext,
  prescriptionId: string,
  deps: { email?: EmailProvider | null } = {},
): Promise<Result<SharePanelData>> {
  if (!can(ctx.role, "rx.share")) return fail("forbidden", FORBIDDEN);
  if (!isUuid(prescriptionId)) return fail("not_found", NOT_FOUND);
  const emailAvailable = (deps.email === undefined ? getEmailProvider() : deps.email) !== null;
  return withTenant(ctx.tenantId, async (tx): Promise<Result<SharePanelData>> => {
    const [rx] = await tx
      .select({ id: prescriptions.id, status: prescriptions.status, patientId: visits.patientId })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .where(and(eq(prescriptions.tenantId, ctx.tenantId), eq(prescriptions.id, prescriptionId)))
      .limit(1);
    if (!rx || (rx.status !== "finalized" && rx.status !== "amended")) return fail("not_found", NOT_FOUND);
    const [patient] = await tx.select({ phone: patients.phone }).from(patients).where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, rx.patientId))).limit(1);
    const clinic = await primaryClinic(tx, ctx.tenantId);
    return ok({
      prescriptionId: rx.id,
      patientId: rx.patientId,
      status: rx.status,
      enabled: clinic?.sharingEnabled ?? false,
      consent: await currentSharingConsentIn(tx, ctx.tenantId, rx.patientId),
      links: await listShareLinksIn(tx, ctx.tenantId, rx.id, new Date()),
      emailAvailable,
      defaultPhone: patient?.phone ?? "",
      timeZone: zoneOf(clinic?.timezone),
    });
  });
}
```

`src/server/actions/sharing.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/server/auth/session";
import { revokeShareLink } from "@/server/services/share-links";
import { shareByEmail, shareByWhatsApp } from "@/server/services/sharing";

export type ShareFormState = { error?: string; field?: string; waUrl?: string; url?: string; sentTo?: string; expiresAt?: string };
export type RevokeFormState = { error?: string };

// Plain module constants: a "use server" file may export only async functions and types.
const INTERNAL = "Something went wrong. Please try again.";

function logFailure(name: string, error: unknown): void {
  console.error(`${name} failed`, error instanceof Error ? error.name : typeof error);
}

export async function shareWhatsAppAction(prescriptionId: string, _prev: ShareFormState, formData: FormData): Promise<ShareFormState> {
  const session = await requireSession();
  try {
    const result = await shareByWhatsApp(session, { prescriptionId, phone: formData.get("phone") });
    if (!result.ok) return { error: result.message, field: result.field };
    revalidatePath(`/prescriptions/${prescriptionId}`);
    return { waUrl: result.value.waUrl, url: result.value.url, sentTo: result.value.recipientMasked, expiresAt: result.value.expiresAt.toISOString() };
  } catch (error) {
    logFailure("shareWhatsAppAction", error);
    return { error: INTERNAL };
  }
}

export async function shareEmailAction(prescriptionId: string, _prev: ShareFormState, formData: FormData): Promise<ShareFormState> {
  const session = await requireSession();
  try {
    const result = await shareByEmail(session, { prescriptionId, email: formData.get("email") });
    if (!result.ok) {
      revalidatePath(`/prescriptions/${prescriptionId}`);
      return { error: result.message, field: result.field };
    }
    revalidatePath(`/prescriptions/${prescriptionId}`);
    return { sentTo: result.value.recipientMasked, expiresAt: result.value.expiresAt.toISOString() };
  } catch (error) {
    logFailure("shareEmailAction", error);
    return { error: INTERNAL };
  }
}

export async function revokeShareLinkAction(prescriptionId: string, linkId: string, _prev: RevokeFormState): Promise<RevokeFormState> {
  void _prev;
  const session = await requireSession();
  try {
    const result = await revokeShareLink(session, linkId);
    revalidatePath(`/prescriptions/${prescriptionId}`);
    return result.ok ? {} : { error: result.message };
  } catch (error) {
    logFailure("revokeShareLinkAction", error);
    return { error: INTERNAL };
  }
}
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/integration/sharing.test.ts` — expected: PASS (8).

- [ ] **Step 5: Write the failing panel test**

`tests/unit/share-panel.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { SharePanelData } from "@/server/services/sharing";

const actions = vi.hoisted(() => ({
  shareWhatsAppAction: vi.fn(),
  shareEmailAction: vi.fn(),
  revokeShareLinkAction: vi.fn(),
  recordConsentAction: vi.fn(),
  withdrawConsentAction: vi.fn(),
}));
vi.mock("@/server/actions/sharing", () => ({
  shareWhatsAppAction: actions.shareWhatsAppAction,
  shareEmailAction: actions.shareEmailAction,
  revokeShareLinkAction: actions.revokeShareLinkAction,
}));
vi.mock("@/server/actions/consent", () => ({ recordConsentAction: actions.recordConsentAction, withdrawConsentAction: actions.withdrawConsentAction }));

import { SharePanel } from "@/components/rx/share-panel";

const RX = "00000000-0000-4000-8000-0000000000b1";
const LINK = "00000000-0000-4000-8000-0000000000c1";
const data = (overrides: Partial<SharePanelData> = {}): SharePanelData => ({
  prescriptionId: RX,
  patientId: "00000000-0000-4000-8000-0000000000d1",
  status: "finalized",
  enabled: true,
  consent: { id: "c", granted: true, version: "sharing-v1", method: "verbal", recordedAt: new Date("2026-11-16T05:00:00Z") },
  links: [],
  emailAvailable: false,
  defaultPhone: "98765 43210",
  timeZone: "Asia/Kolkata",
  ...overrides,
});
const WA = "https://wa.me/919876543210?text=Asha%20Clinic";

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe("SharePanel", () => {
  it("tells the owner where to turn sharing on, and everyone else whom to ask", () => {
    const first = render(<SharePanel data={data({ enabled: false })} canCaptureConsent isOwner />);
    expect(screen.getByRole("link", { name: "Turn it on in Settings" })).toHaveAttribute("href", "/settings");
    first.unmount();
    render(<SharePanel data={data({ enabled: false })} canCaptureConsent isOwner={false} />);
    expect(screen.getByText(/Ask the clinic owner to turn it on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create WhatsApp message" })).toBeNull();
  });

  it("asks for consent before offering any way to share", () => {
    render(<SharePanel data={data({ consent: null })} canCaptureConsent isOwner={false} />);
    expect(screen.getByRole("button", { name: "Record consent" })).toBeInTheDocument();
    expect(screen.queryByLabelText("WhatsApp number")).toBeNull();
  });

  it("prepares the message, then opens WhatsApp only from a real link click (no popup-blocked window.open)", async () => {
    actions.shareWhatsAppAction.mockResolvedValue({ waUrl: WA, url: "https://app.test/s/T", sentTo: "+91******3210", expiresAt: "2026-11-24T05:00:00.000Z" });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<SharePanel data={data()} canCaptureConsent isOwner={false} />);
    expect(screen.getByLabelText("WhatsApp number")).toHaveValue("98765 43210");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp message" }));
    });
    const [prescriptionId, , formData] = actions.shareWhatsAppAction.mock.calls[0] as [string, unknown, FormData];
    expect(prescriptionId).toBe(RX);
    expect(formData.get("phone")).toBe("98765 43210");
    const open = await screen.findByRole("link", { name: "Open WhatsApp" });
    expect(open).toHaveAttribute("href", WA);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Message ready for \+91\*\*\*\*\*\*3210/)).toBeInTheDocument();
    expect(screen.getByLabelText("Share link")).toHaveValue("https://app.test/s/T");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("copies the link when the clipboard is available", async () => {
    actions.shareWhatsAppAction.mockResolvedValue({ waUrl: WA, url: "https://app.test/s/T", sentTo: "+91******3210", expiresAt: "2026-11-24T05:00:00.000Z" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SharePanel data={data()} canCaptureConsent isOwner={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp message" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    });
    expect(writeText).toHaveBeenCalledWith("https://app.test/s/T");
    expect(screen.getByRole("button", { name: "Link copied" })).toBeInTheDocument();
  });

  it("shows the error next to the number", async () => {
    actions.shareWhatsAppAction.mockResolvedValue({ error: "Add the country code, for example +44 7700 900123.", field: "phone" });
    render(<SharePanel data={data()} canCaptureConsent isOwner={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp message" }));
    });
    expect(await screen.findByText("Add the country code, for example +44 7700 900123.")).toBeInTheDocument();
    expect(screen.getByLabelText("WhatsApp number")).toHaveAttribute("aria-invalid", "true");
  });

  it("offers email only when it is set up", async () => {
    const first = render(<SharePanel data={data()} canCaptureConsent isOwner={false} />);
    expect(screen.getByText("Email sharing is not set up on this server.")).toBeInTheDocument();
    first.unmount();
    actions.shareEmailAction.mockResolvedValue({ sentTo: "a***@example.com", expiresAt: "2026-11-24T05:00:00.000Z" });
    render(<SharePanel data={data({ emailAvailable: true })} canCaptureConsent isOwner={false} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "asha@example.com" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send by email" }));
    });
    expect(await screen.findByText(/Sent to a\*\*\*@example.com/)).toBeInTheDocument();
  });

  it("does not offer to share a superseded version", () => {
    render(<SharePanel data={data({ status: "amended" })} canCaptureConsent isOwner />);
    expect(screen.getByText(/replaced by a newer one/)).toBeInTheDocument();
    expect(screen.queryByLabelText("WhatsApp number")).toBeNull();
  });

  it("lists links with their state and lets an active one be withdrawn", async () => {
    actions.revokeShareLinkAction.mockResolvedValue({});
    const links = [
      { id: LINK, channel: "whatsapp" as const, recipientMasked: "+91******3210", createdAt: new Date("2026-11-16T05:00:00Z"), expiresAt: new Date("2026-11-23T05:00:00Z"), openCount: 2, maxOpens: 10, status: "active" as const, revokeReason: null },
      { id: "00000000-0000-4000-8000-0000000000c2", channel: "email" as const, recipientMasked: "a***@example.com", createdAt: new Date("2026-11-15T05:00:00Z"), expiresAt: new Date("2026-11-22T05:00:00Z"), openCount: 0, maxOpens: 10, status: "revoked" as const, revokeReason: "consent_withdrawn" },
    ];
    render(<SharePanel data={data({ links })} canCaptureConsent isOwner={false} />);
    const items = within(screen.getByRole("list", { name: "Links sent" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("WhatsApp to +91******3210");
    expect(items[0]).toHaveTextContent("opened 2 of 10");
    expect(items[1]).toHaveTextContent("withdrawn (consent withdrawn)");
    expect(within(items[1]).queryByRole("button", { name: "Withdraw link" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(items[0]).getByRole("button", { name: "Withdraw link" }));
    });
    expect(actions.revokeShareLinkAction.mock.calls[0].slice(0, 2)).toEqual([RX, LINK]);
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/share-panel.test.tsx` — expected: FAIL (module missing).

- [ ] **Step 6: Write the panel and the links list**

`src/components/rx/share-links-list.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { revokeShareLinkAction, type RevokeFormState } from "@/server/actions/sharing";
import type { ShareLinkView } from "@/server/services/share-links";

const CHANNEL: Record<ShareLinkView["channel"], string> = { whatsapp: "WhatsApp", email: "Email" };
const REVOKED: Record<string, string> = {
  user: "withdrawn",
  consent_withdrawn: "withdrawn (consent withdrawn)",
  patient_archived: "withdrawn (patient archived)",
  send_failed: "not sent (the email failed)",
};

function day(at: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(at);
}

function state(link: ShareLinkView, timeZone: string): string {
  if (link.status === "active") return `active until ${day(link.expiresAt, timeZone)}`;
  if (link.status === "expired") return "expired";
  if (link.status === "used_up") return "used up";
  return REVOKED[link.revokeReason ?? "user"] ?? "withdrawn";
}

function WithdrawLink({ prescriptionId, linkId }: { prescriptionId: string; linkId: string }) {
  const [result, action, pending] = useActionState(revokeShareLinkAction.bind(null, prescriptionId, linkId), {} as RevokeFormState);
  return (
    <form action={action} className="inline">
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        Withdraw link
      </Button>
      {result.error ? <span className="text-destructive">{result.error}</span> : null}
    </form>
  );
}

/** Every link of this version: to whom (masked), when, state, opens; active ones can be withdrawn. */
export function ShareLinksList({ prescriptionId, links, timeZone }: { prescriptionId: string; links: ShareLinkView[]; timeZone: string }) {
  if (links.length === 0) return <p className="text-sm text-muted-foreground">No links sent yet.</p>;
  return (
    <div className="space-y-1">
      <h3 id={`links-${prescriptionId}`} className="text-sm font-medium">
        Links sent
      </h3>
      <ul aria-labelledby={`links-${prescriptionId}`} className="divide-y rounded border text-sm">
        {links.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-x-2 p-2">
            <span>
              {CHANNEL[l.channel]} to {l.recipientMasked ?? "an unknown recipient"} · sent {day(l.createdAt, timeZone)} · {state(l, timeZone)} · opened{" "}
              {l.openCount} of {l.maxOpens}
            </span>
            {l.status === "active" ? <WithdrawLink prescriptionId={prescriptionId} linkId={l.id} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`src/components/rx/share-panel.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { shareEmailAction, shareWhatsAppAction, type ShareFormState } from "@/server/actions/sharing";
import type { SharePanelData } from "@/server/services/sharing";
import { ConsentCard } from "@/components/patients/consent-card";
import { ShareLinksList } from "./share-links-list";

type Props = { data: SharePanelData; canCaptureConsent: boolean; isOwner: boolean };

function untilText(iso: string | undefined, timeZone: string): string {
  if (!iso) return "";
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(new Date(iso));
}

function WhatsAppForm({ prescriptionId, defaultPhone, timeZone }: { prescriptionId: string; defaultPhone: string; timeZone: string }) {
  const [state, action, pending] = useActionState(shareWhatsAppAction.bind(null, prescriptionId), {} as ShareFormState);
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const copied = state.url !== undefined && copiedFor === state.url;
  async function copy() {
    if (!state.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopiedFor(state.url);
    } catch {
      setCopiedFor(null); // the read-only field below can still be selected and copied by hand
    }
  }
  return (
    <form action={action} className="space-y-2">
      <Label htmlFor="share-phone">WhatsApp number</Label>
      <Input
        id="share-phone"
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        defaultValue={defaultPhone}
        aria-invalid={state.field === "phone" || undefined}
        aria-describedby="share-phone-hint"
      />
      <p id="share-phone-hint" className="text-xs text-muted-foreground">
        Indian mobile numbers can be typed as 98765 43210. Other countries: start with + and the country code.
      </p>
      <Button type="submit" disabled={pending}>
        Create WhatsApp message
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.waUrl && state.url ? (
        <div role="status" className="space-y-2 rounded-md border bg-muted/40 p-2 text-sm">
          <p>
            Message ready for {state.sentTo}. The link works until {untilText(state.expiresAt, timeZone)}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <a href={state.waUrl} target="_blank" rel="noopener noreferrer">
                Open WhatsApp
              </a>
            </Button>
            <Button type="button" variant="outline" onClick={copy}>
              {copied ? "Link copied" : "Copy link"}
            </Button>
          </div>
          <Input readOnly aria-label="Share link" value={state.url} onFocus={(event) => event.currentTarget.select()} />
          <p className="text-xs text-muted-foreground">WhatsApp opens with the message filled in. Press send there; ClinicPad does not send it for you.</p>
        </div>
      ) : null}
    </form>
  );
}

function EmailForm({ prescriptionId, timeZone }: { prescriptionId: string; timeZone: string }) {
  const [state, action, pending] = useActionState(shareEmailAction.bind(null, prescriptionId), {} as ShareFormState);
  return (
    <form action={action} className="space-y-2">
      <Label htmlFor="share-email">Email address</Label>
      <Input id="share-email" name="email" type="email" autoComplete="off" aria-invalid={state.field === "email" || undefined} />
      <Button type="submit" variant="outline" disabled={pending}>
        Send by email
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.sentTo ? (
        <p role="status" className="text-sm">
          Sent to {state.sentTo}. The link works until {untilText(state.expiresAt, timeZone)}.
        </p>
      ) : null}
    </form>
  );
}

/** Sharing a finalized prescription: the clinic switch, consent first, then WhatsApp or email, then the links sent. */
export function SharePanel({ data, canCaptureConsent, isOwner }: Props) {
  const heading = (
    <h2 id="share-heading" className="text-lg font-medium">
      Share with the patient
    </h2>
  );
  if (data.status === "amended") {
    return (
      <section aria-labelledby="share-heading" className="space-y-3 rounded-lg border p-3">
        {heading}
        <p role="note" className="text-sm">
          This version was replaced by a newer one, so it cannot be shared. Links sent earlier still open, marked SUPERSEDED.
        </p>
        <ShareLinksList prescriptionId={data.prescriptionId} links={data.links} timeZone={data.timeZone} />
      </section>
    );
  }
  if (!data.enabled) {
    return (
      <section aria-labelledby="share-heading" className="space-y-3 rounded-lg border p-3">
        {heading}
        <p role="note" className="text-sm">
          Sharing is turned off for this clinic.{" "}
          {isOwner ? (
            <Link className="underline" href="/settings">
              Turn it on in Settings
            </Link>
          ) : (
            "Ask the clinic owner to turn it on."
          )}
        </p>
      </section>
    );
  }
  const consented = data.consent !== null && data.consent.granted;
  return (
    <section aria-labelledby="share-heading" className="space-y-3 rounded-lg border p-3">
      {heading}
      {consented ? (
        <>
          <WhatsAppForm prescriptionId={data.prescriptionId} defaultPhone={data.defaultPhone} timeZone={data.timeZone} />
          {data.emailAvailable ? (
            <EmailForm prescriptionId={data.prescriptionId} timeZone={data.timeZone} />
          ) : (
            <p className="text-xs text-muted-foreground">Email sharing is not set up on this server.</p>
          )}
        </>
      ) : (
        <ConsentCard patientId={data.patientId} consent={data.consent} canCapture={canCaptureConsent} archived={false} timeZone={data.timeZone} />
      )}
      <ShareLinksList prescriptionId={data.prescriptionId} links={data.links} timeZone={data.timeZone} />
    </section>
  );
}
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/share-panel.test.tsx` — expected: PASS (8).

- [ ] **Step 7: Put the panel on the prescription page**

In `src/app/(app)/prescriptions/[id]/page.tsx`, add the imports `import { getSharePanel } from "@/server/services/sharing";` and `import { SharePanel } from "@/components/rx/share-panel";`, extend the parallel reads:

```tsx
  const [favourites, links, readiness, outputs, printable, share] = await Promise.all([
    settle(canEdit ? listFavourites(session) : null),
    settle(getVersionLinks(session, rx.id)),
    settle(canEdit ? getPadReadiness(session) : null),
    settle(isDraft ? null : listPrescriptionOutputs(session, rx.id)),
    settle(isDraft ? null : loadRxDocument(session, rx.id, { withAssets: false })),
    settle(!isDraft && can(session.role, "rx.share") ? getSharePanel(session, rx.id) : null),
  ]);
```

and render directly after `<RxOutputPanel ... />`:

```tsx
      {share?.ok ? <SharePanel data={share.value} canCaptureConsent={can(session.role, "consent.capture")} isOwner={session.role === "owner"} /> : null}
```

In `tests/unit/prescription-page.test.tsx`: add `getSharePanel: vi.fn(),` to the hoisted `mocks`; add the mocks

```tsx
vi.mock("@/server/services/sharing", () => ({ getSharePanel: mocks.getSharePanel }));
vi.mock("@/components/rx/share-panel", () => ({ SharePanel: () => <div>share panel</div> }));
```

in `beforeEach` add `mocks.getSharePanel.mockResolvedValue({ ok: true, value: {} });`, and append:

```tsx
describe("prescription page share panel", () => {
  it("shows the panel on a finalized version to owners, doctors and reception", async () => {
    for (const role of ["owner", "doctor", "reception"]) {
      mocks.session.role = role;
      mocks.getPrescription.mockResolvedValue(finalizedView("finalized"));
      const view = render(await PrescriptionPage({ params }));
      expect(screen.getByText("share panel")).toBeInTheDocument();
      view.unmount();
    }
  });

  it("never asks for the panel for nurses or pharmacists, or on drafts", async () => {
    for (const role of ["nurse", "pharmacist"]) {
      mocks.session.role = role;
      mocks.getPrescription.mockResolvedValue(finalizedView("finalized"));
      const view = render(await PrescriptionPage({ params }));
      expect(screen.queryByText("share panel")).toBeNull();
      view.unmount();
    }
    mocks.session.role = "doctor";
    mocks.getPrescription.mockResolvedValue(draftView(null));
    render(await PrescriptionPage({ params }));
    expect(screen.queryByText("share panel")).toBeNull();
    expect(mocks.getSharePanel).not.toHaveBeenCalled();
  });

  it("still renders the page when the panel read fails", async () => {
    mocks.getPrescription.mockResolvedValue(finalizedView("finalized"));
    mocks.getSharePanel.mockRejectedValue(new Error("down"));
    render(await PrescriptionPage({ params }));
    expect(screen.queryByText("share panel")).toBeNull();
    expect(screen.getByText("read-only")).toBeInTheDocument();
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/prescription-page.test.tsx` — expected: PASS (the existing 21 plus 3).

- [ ] **Step 8: Write the e2e flow**

`tests/e2e/sharing.spec.ts`:

```ts
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

async function finalizedPrescription(page: Page, name: string, phone: string): Promise<{ rxUrl: string; patientUrl: string }> {
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Phone").fill(phone);
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const patientUrl = page.url();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill("Paracetamol");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible({ timeout: 15_000 });
  return { rxUrl: page.url(), patientUrl };
}

test("share a prescription by WhatsApp after consent; the patient opens it signed out; withdrawing stops it", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const withPdf = await gotenbergUp();
  const clinic = await registerClinic(page, "share");
  clinics.push(clinic);

  // Off by default: the owner turns it on.
  await page.goto("/settings");
  await page.getByRole("checkbox", { name: /Allow sharing prescriptions/ }).check();
  await page.getByRole("button", { name: "Save sharing" }).click();
  await expect(page.getByText("Saved.", { exact: true }).last()).toBeVisible();

  const { rxUrl, patientUrl } = await finalizedPrescription(page, "Meena Share", "98765 43210");
  const share = page.getByRole("region", { name: "Share with the patient" });
  await share.getByLabel("Verbal").check();
  await share.getByLabel("The patient (or their guardian) agreed to this text.").check();
  await share.getByRole("button", { name: "Record consent" }).click();
  await expect(share.getByLabel("WhatsApp number")).toHaveValue("98765 43210");

  await share.getByRole("button", { name: "Create WhatsApp message" }).click();
  const openWhatsApp = share.getByRole("link", { name: "Open WhatsApp" });
  await expect(openWhatsApp).toHaveAttribute("href", /^https:\/\/wa\.me\/919876543210\?text=/);
  await expect(openWhatsApp).toHaveAttribute("target", "_blank");
  const href = (await openWhatsApp.getAttribute("href")) ?? "";
  const text = new URL(href).searchParams.get("text") ?? "";
  expect(text).not.toContain("Meena");
  const shareUrl = /https?:\/\/\S+\/s\/[A-Za-z0-9_-]{43}/.exec(text)?.[0] ?? "";
  expect(shareUrl).not.toBe("");

  // The patient, signed out: an interstitial with no details, then the PDF.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(shareUrl);
  await expect(visitor.getByRole("heading", { name: "Your prescription" })).toBeVisible();
  await expect(visitor.getByText("Meena")).toHaveCount(0);
  const [response] = await Promise.all([
    visitor.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/s/")),
    visitor.getByRole("button", { name: "Open prescription (PDF)" }).click(),
  ]);
  if (withPdf) {
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    await page.goto(rxUrl);
    await expect(page.getByText(/opened 1 of 10/)).toBeVisible();
  } else {
    expect(response.status()).toBe(503);
  }

  // Withdraw the link: the visitor's copy stops at once.
  await page.goto(rxUrl);
  await page.getByRole("button", { name: "Withdraw link" }).click();
  await expect(page.getByText(/withdrawn/)).toBeVisible();
  await visitor.goto(shareUrl);
  await expect(visitor.getByRole("heading", { name: "This link is not valid" })).toBeVisible();
  await visitorContext.close();

  // Withdrawing consent removes the way to share.
  await page.goto(patientUrl);
  await page.getByRole("button", { name: "Withdraw consent" }).click();
  await page.getByRole("button", { name: "Yes, withdraw consent" }).click();
  await expect(page.getByText(/^Withdrawn on/)).toBeVisible();
  await page.goto(rxUrl);
  await expect(page.getByRole("button", { name: "Create WhatsApp message" })).toHaveCount(0);

  // Nurses never see the panel.
  await setRole(clinic.email, "nurse");
  await page.goto(rxUrl);
  await expect(page.getByRole("heading", { name: "Share with the patient" })).toHaveCount(0);
});
```

- [ ] **Step 9: Run, full suite, commit**

```powershell
Set-Location E:\projects\clinicpad; docker compose up -d gotenberg
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/sharing.spec.ts tests/e2e/rx-output.spec.ts
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/domain/recipient.ts src/server/messaging/whatsapp.ts src/server/messaging/email.ts src/server/services/sharing.ts src/server/actions/sharing.ts src/components/rx/share-panel.tsx src/components/rx/share-links-list.tsx "src/app/(app)/prescriptions/[id]/page.tsx" tests/helpers/fake-email.ts tests/unit/recipient.test.ts tests/unit/wa-link.test.ts tests/unit/email-provider.test.ts tests/unit/share-panel.test.tsx tests/unit/prescription-page.test.tsx tests/integration/sharing.test.ts tests/e2e/sharing.spec.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(sharing): WhatsApp wa.me and email sharing behind consent, masked share log, Share panel" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: sharing e2e 1 passed (with Gotenberg up the PDF branch runs; without it the 503 branch), rx-output e2e unchanged; the suite clean.

---

## Task 11: Pilot polish — Hindi option labels in one place, not-found and empty states, keyboard flow, and the TransformStream finding

**Files:**
- Modify: `src/lib/domain/rx-options.ts` (`FOOD_RELATION_LABELS_HI`, `PERIODICITY_LABELS_HI`), `src/lib/rx-render/labels.ts` (import them; delete `HI_FOOD` / `HI_PERIODICITY`), `src/app/(app)/layout.tsx` (skip link, `main` target), `src/app/(app)/dashboard/page.tsx` (safe zone, first-run actions), `src/components/patients/patient-form.tsx` (`autoFocusName`), `src/app/(app)/patients/new/page.tsx`
- Create: `src/app/(app)/not-found.tsx`
- Test: `tests/unit/rx-option-labels.test.ts`, `tests/e2e/keyboard.spec.ts`; `tests/unit/rx-render.test.ts` and the golden files must pass **unchanged**

**Interfaces:**
- Consumes: `FOOD_RELATIONS`, `PERIODICITIES`, `FOOD_RELATION_LABELS`, `PERIODICITY_LABELS` (`src/lib/domain/rx-options.ts`); `translations.hindi` (`src/lib/translations.ts`); `foodText`, `periodicityText` (`src/lib/rx-render/labels.ts`); `isValidTimeZone`, `DEFAULT_TIME_ZONE`; `can`.
- Produces: `FOOD_RELATION_LABELS_HI: Record<FoodRelation, string>`, `PERIODICITY_LABELS_HI: Record<Periodicity, string>`; `PatientForm` prop `autoFocusName?: boolean`; the `(app)` not-found page ("Not found", link "Go to the dashboard"); the skip link "Skip to content" targeting `#main`; dashboard first-run links "Register your first patient" and "Import from CSV"; a recorded finding about the dev-server `TransformStream` error.

- [ ] **Step 1: Write the failing label test**

`tests/unit/rx-option-labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FOOD_RELATION_LABELS_HI, FOOD_RELATIONS, PERIODICITIES, PERIODICITY_LABELS_HI } from "@/lib/domain/rx-options";
import { foodText, periodicityText } from "@/lib/rx-render/labels";

const devanagari = /\p{Script=Devanagari}/u;

describe("Hindi labels for the option codes (one source, NEEDS NATIVE-SPEAKER REVIEW)", () => {
  it.each(FOOD_RELATIONS.map((code) => [code]))("food relation %s has a Devanagari label that the pad prints", (code) => {
    expect(FOOD_RELATION_LABELS_HI[code]).toMatch(devanagari);
    expect(foodText(code, "hi")).toBe(FOOD_RELATION_LABELS_HI[code]);
  });

  it.each(PERIODICITIES.map((code) => [code]))("periodicity %s has a Devanagari label that the pad prints", (code) => {
    expect(PERIODICITY_LABELS_HI[code]).toMatch(devanagari);
    expect(periodicityText(code, "hi")).toBe(PERIODICITY_LABELS_HI[code]);
  });
});
```

Run `Set-Location E:\projects\clinicpad; npx vitest run tests/unit/rx-option-labels.test.ts` — expected: FAIL (`FOOD_RELATION_LABELS_HI` is not exported).

- [ ] **Step 2: Move the Hindi labels next to the codes**

In `src/lib/domain/rx-options.ts`, change the header comment's last sentence to "Hindi labels (for the printed pad today) live here too, keyed by the same codes.", add `import { translations } from "@/lib/translations";` at the top and, after `PERIODICITY_LABELS`, add:

```ts
const hi = translations.hindi;

/*
 * NEEDS NATIVE-SPEAKER REVIEW before wide release (human decision, Plan 1D). Taken from the legacy app's strings
 * (src/lib/translations.ts). The app UI is English; these are printed on Hindi and bilingual pads.
 */
export const FOOD_RELATION_LABELS_HI: Record<FoodRelation, string> = {
  before: hi.before,
  after: hi.after,
  with: hi.with,
  without: hi.without,
  with_tea: hi.with_tea,
  just_for_now: hi.just_for_now,
  according_to_pain: hi.according_to_pain,
};

export const PERIODICITY_LABELS_HI: Record<Periodicity, string> = {
  daily: hi.daily,
  alternate_day: hi.alternate,
  twice_weekly: hi.weeklyTwice,
  weekly: hi.weekly,
  every_5th_day: hi.every_5th_day,
  fortnightly: hi.fortnightly,
  monthly: hi.monthly,
  as_needed: hi.asNeeded,
};
```

(These are exactly the `HI_FOOD` and `HI_PERIODICITY` maps from `labels.ts`, moved.) In `src/lib/rx-render/labels.ts`, delete `HI_FOOD` and `HI_PERIODICITY`, change the first import to `import { FOOD_RELATION_LABELS, FOOD_RELATION_LABELS_HI, PERIODICITY_LABELS, PERIODICITY_LABELS_HI, type FoodRelation, type Periodicity } from "@/lib/domain/rx-options";`, and make `foodText` / `periodicityText` call `coded(code, FOOD_RELATION_LABELS, FOOD_RELATION_LABELS_HI, lang)` and `coded(code, PERIODICITY_LABELS, PERIODICITY_LABELS_HI, lang)`. If `FoodRelation` / `Periodicity` are no longer used in `labels.ts`, drop them from the import (lint reports it).

```powershell
Set-Location E:\projects\clinicpad; npx vitest run tests/unit/rx-option-labels.test.ts tests/unit/rx-render.test.ts tests/unit/rx-labels.test.ts
Set-Location E:\projects\clinicpad; git status --short tests/unit/__golden__
```

Expected: PASS (rx-option-labels 15), the renderer and golden tests unchanged, and **no** golden file modified (printed output is byte-identical; `RENDERER_VERSION` stays `"1"`).

- [ ] **Step 3: Not-found page, skip link, dashboard first run, registration focus**

`src/app/(app)/not-found.tsx`:

```tsx
import Link from "next/link";

/** Shown for notFound() inside the app: unknown, foreign, and forbidden records all look the same. */
export default function AppNotFound() {
  return (
    <div className="max-w-md space-y-3 rounded-lg border p-6">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="text-sm text-muted-foreground">This page or record does not exist, or your role cannot open it.</p>
      <Link className="text-sm underline" href="/dashboard">
        Go to the dashboard
      </Link>
    </div>
  );
}
```

In `src/app/(app)/layout.tsx`, make the first child of the outer `div`:

```tsx
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>
```

and change `<main className="min-w-0 flex-1 p-4 md:p-6">` to `<main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6">`.

In `src/app/(app)/dashboard/page.tsx`: change `const { tenantId } = await requireSession();` to `const session = await requireSession(); const { tenantId } = session;`; add `import Link from "next/link";`, `import { can } from "@/lib/domain/permissions";` and `import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";`; replace `const timezone = data.clinic?.timezone ?? "Asia/Kolkata";` with `const zone = data.clinic?.timezone; const timezone = isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;` (a damaged zone must not crash the dashboard's `Intl.DateTimeFormat`); and replace the last `<section>` with:

```tsx
      <section className="space-y-2 rounded-lg border p-6">
        <h2 className="font-medium">{data.patients === 0 ? "Get started" : "Your clinic is set up"}</h2>
        <p className="text-sm text-muted-foreground">Times are shown in {timezone}.</p>
        {data.patients === 0 ? (
          <div className="flex flex-wrap gap-3 text-sm">
            {can(session.role, "patient.write") ? (
              <Link className="underline" href="/patients/new">
                Register your first patient
              </Link>
            ) : null}
            {can(session.role, "patient.import") ? (
              <Link className="underline" href="/patients/import">
                Import from CSV
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
```


In `src/components/patients/patient-form.tsx`, add `autoFocusName?: boolean` to `Props` (doc: `/** Put the cursor in Name on first render (registration: type the name straight away). */`), destructure it, and add `autoFocus={autoFocusName}` to the Name `Input`. In `src/app/(app)/patients/new/page.tsx`, pass `autoFocusName` to `PatientForm`.

- [ ] **Step 4: Write the keyboard e2e**

`tests/e2e/keyboard.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { cleanupClinic, registerClinic, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

test("a receptionist can register a walk-in with the keyboard alone", async ({ page }) => {
  clinics.push(await registerClinic(page, "keys"));
  await page.goto("/patients/new");
  const started = Date.now();
  await expect(page.getByLabel("Name")).toBeFocused();
  await page.keyboard.type("Keyboard Walkin");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Phone")).toBeFocused();
  await page.keyboard.type("98765 11111");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Keyboard Walkin" })).toBeVisible();
  const seconds = (Date.now() - started) / 1000;
  // Evidence that the flow allows a fast registration; the exit criterion itself is measured with real receptionists.
  console.log(`keyboard-only registration: ${seconds.toFixed(1)} s (automation)`);
  expect(seconds).toBeLessThan(30);
});

test("the skip link moves focus past the navigation", async ({ page }) => {
  clinics.push(await registerClinic(page, "skip"));
  await page.goto("/dashboard");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
});

test("an unknown record shows the in-app not-found page, and a new clinic gets first-run links", async ({ page }) => {
  clinics.push(await registerClinic(page, "nf"));
  await expect(page.getByRole("link", { name: "Register your first patient" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import from CSV" })).toBeVisible();
  await page.goto("/patients/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to the dashboard" })).toBeVisible();
});
```

Run:

```powershell
Set-Location E:\projects\clinicpad; npm run test:e2e -- tests/e2e/keyboard.spec.ts tests/e2e/smoke.spec.ts tests/e2e/patients.spec.ts
```

Expected: keyboard 3 passed (record the printed seconds in your report), smoke and patients unchanged. If a smoke test looked for the old dashboard sentence, update its expected text to "Times are shown in".

- [ ] **Step 5: Investigate the dev-server `TransformStream` error under `next start` (finding, not a fix)**

Plan 1C logged `TypeError: controller[kState].transformAlgorithm is not a function` once in the Next **dev** server during the `pad-settings` role test. Reproduce it against a production build:

```powershell
Set-Location E:\projects\clinicpad; Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
```

If a process listens on 3000, stop only a dev server you started (`Stop-Process -Id <id>`); if it is not yours, report it and stop. Then:

```powershell
Set-Location E:\projects\clinicpad; npm run build:web
Set-Location E:\projects\clinicpad; $env:AUTH_TRUST_HOST = "true"; $env:GOTENBERG_URL = "http://localhost:3001"; $env:NEXT_PUBLIC_APP_URL = "http://localhost:3000"; Start-Process -FilePath "npm.cmd" -ArgumentList "run", "start" -RedirectStandardOutput "$env:TEMP\clinicpad-start.log" -RedirectStandardError "$env:TEMP\clinicpad-start.err.log" -NoNewWindow -PassThru
```

Wait until `http://localhost:3000/api/health` answers (`Invoke-WebRequest http://localhost:3000/api/health -UseBasicParsing`), then run the spec three times against that server (Playwright reuses it outside CI):

```powershell
Set-Location E:\projects\clinicpad; npx playwright test tests/e2e/pad-settings.spec.ts --repeat-each=3
Set-Location E:\projects\clinicpad; Select-String -Path "$env:TEMP\clinicpad-start.log", "$env:TEMP\clinicpad-start.err.log" -Pattern "transformAlgorithm|TypeError" -SimpleMatch:$false
```

Then stop the `next start` process you started (`Stop-Process -Id <id from Start-Process>`), and run the same spec three times against the dev server for comparison (`npx playwright test tests/e2e/pad-settings.spec.ts --repeat-each=3`, Playwright starts `npm run dev`), capturing its output to `$env:TEMP\clinicpad-dev.log` with `*> $env:TEMP\clinicpad-dev.log` and searching it the same way.

Record the outcome in your task report with the counts (production: N runs, M occurrences; dev: N runs, M occurrences) and the first stack frame if one appears. Task 12 writes it into `docs/PROGRESS.md`:
- **Not seen under `next start`, seen in dev:** "dev-only (Next dev server stream handling); no action" — close the follow-up.
- **Seen under `next start`:** keep the follow-up open with the stack's top frame and the request path, and note that the pad-settings tests still pass; do not change code in this plan.
- **Seen in neither:** "not reproduced in 6 runs; left open as unreproduced."

- [ ] **Step 6: Full suite and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }; if ($?) { npm run test }
Set-Location E:\projects\clinicpad; git add src/lib/domain/rx-options.ts src/lib/rx-render/labels.ts "src/app/(app)/not-found.tsx" "src/app/(app)/layout.tsx" "src/app/(app)/dashboard/page.tsx" src/components/patients/patient-form.tsx "src/app/(app)/patients/new/page.tsx" tests/unit/rx-option-labels.test.ts tests/e2e/keyboard.spec.ts
Set-Location E:\projects\clinicpad; git commit -m "feat(app): Hindi option labels in one place, in-app not-found, skip link, first-run dashboard, registration focus" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

(If Step 4 changed `tests/e2e/smoke.spec.ts`, add it to the `git add` line.)

---

## Task 12: Decisions, progress, setup notes, the Phase 1 exit-criteria evidence, and the Gate 1D verification

**Files:**
- Modify: `docs/DECISIONS.md` (ADR-0036 to ADR-0041), `docs/PROGRESS.md`, `docs/SETUP.md`, `AGENTS.md`, `.env.example`

**Interfaces:**
- Consumes: every task above, their commits, and Task 11's TransformStream finding.
- Produces: ADR-0036 to ADR-0041; `docs/PROGRESS.md` §4.11 (Phase 1D checklist, follow-ups, exit-criteria evidence table); resolved markers on the §4.8–§4.10 follow-ups; a passing gate.

- [ ] **Step 1: Run the full gate first (evidence before any box is ticked)**

```powershell
Set-Location E:\projects\clinicpad; docker compose up -d postgres gotenberg
Set-Location E:\projects\clinicpad; npm run db:sweep-test-tenants
Set-Location E:\projects\clinicpad; node scripts/verify-gate-0.mjs
Set-Location E:\projects\clinicpad; npm run test:visual
Set-Location E:\projects\clinicpad; npm run build:desktop; git status --short
Set-Location E:\projects\clinicpad; npx drizzle-kit generate
```

Expected: `Gate 0 verification PASSED` (lint 0 errors, typecheck clean, every unit and integration test, `build:web`, `build:desktop`, every e2e spec); `test:visual` 24 passed with **no** baseline change (printed output is unchanged in Plan 1D); `build:desktop` exits 0 and `git status --short` is empty apart from this task's documentation edits (no `.desktop-stash`, `src/app/s` restored); drizzle-kit answers "No schema changes". Write down the counts: unit + integration files and tests, e2e passed and skipped. From the baseline (1,625 passed + 1 skipped in 71 files) the per-task Expected lines add up to about 350 new unit and integration tests in 27 new test files; e2e grows by 8 tests (patients +1, patient-history 1, patient-import 2, sharing 1, keyboard 3) to 57, reported as 49 passed and 8 skipped (the opt-in screenshot tests). Use the numbers the gate prints, not these estimates. If the gate fails, fix the cause in the task that owns it (a new commit), re-run, and only then continue.

- [ ] **Step 2: Record the decisions**

Append to `docs/DECISIONS.md`, directly before `## 19. Open decisions` (after ADR-0035). Re-check that ADR-0036 is the next free number; if not, renumber these six consecutively and update the references in code comments (`grep -rn "ADR-003[6-9]\|ADR-004[01]" src` lists them; `src/app/s/[token]/route.ts` cites ADR-0037). Write each `Date` as the day you run this step.

```md
## ADR-0036 — Consent before sharing is an append-only log; withdrawal and archive stop every link

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** DPDP-style consent needs purpose, version, timestamp, who captured it, and revocation (PRODUCT_SPEC §6.2, AGENTS.md invariant 5). WhatsApp and email providers are third parties even when the recipient is the patient.

**Decision:** `patient_consents` is an append-only event log (purpose `sharing`, version such as `sharing-v1`, `granted`, method `verbal | written`, `captured_by`, `created_at`); the latest event per patient and purpose is the current state, and withdrawal inserts `granted = false`. The runtime role can only insert and read; admin-level immutability applies (0022). Consent is required before every share. The consent text and its Hindi translation live in `src/lib/domain/consent.ts` under the version key; rewording means a new key. Recording and withdrawing need `consent.capture` (owner, doctor, reception) and lock the patient row `FOR UPDATE`; withdrawal and archiving revoke every open link of the patient in the same transaction (`revoke_reason` `consent_withdrawn` / `patient_archived`). Creating a link locks the patient row `FOR SHARE`, so a link can never survive a concurrent withdrawal. Audit events (`patient.consent_recorded`, `patient.consent_withdrawn`) carry ids, purpose, version, method and counts only.

**Consequences:** Full consent history as evidence; one extra row per change. The English text needs legal review and the Hindi text a native speaker before any clinic turns sharing on (sharing is off per clinic until then, ADR-0038).

**Revisit trigger:** ABDM consent artefacts (Phase 5), marketing consent, or a regulator's required wording.

---

## ADR-0037 — Share links: hashed, short-lived, revocable, count-limited, opened through a two-step public route

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** A patient must open their prescription from a WhatsApp or email message without an account, while link previews, mail scanners, guessing, and a forwarded message must not expose it, and every opening must be audited.

**Decision:** A link is 32 random bytes (base64url, 43 characters); only its SHA-256 is stored (`share_links.token_hash`, unique). It points at one `finalized` prescription of its own tenant (trigger `share_links_target`), lives 7 days, opens at most 10 times, and can be withdrawn; the runtime role may only add one to `open_count` and revoke once (trigger `share_links_rules`), never delete. `/s/<token>` is the only route without a session: GET answers an interstitial page with no patient, clinic or clinical data and a POST button, so previews and scanners never count an open or render anything; POST renders the frozen pad through the existing renderer, limiter and `PdfEngine`, then, in one transaction that re-checks every condition, counts the open, writes a `prescription_outputs` row (kind `shared_pdf`, no actor, `share_link_id`) and audits `prescription.share_opened` (actor null). A malformed, unknown, expired, used-up, withdrawn or switched-off link, and a cross-site POST, all get the identical 404; a failed render answers 503 and burns nothing. Every response is `no-store`, `noindex`, `no-referrer`, `nosniff`; HTML responses carry a `default-src 'none'` CSP. The token lookup runs through `withShareToken` and one RLS policy, `share_link_by_token` (SELECT, `clinicpad_app`, `token_hash = current_setting('app.share_token_hash')`), the single allow-listed exception in `tests/integration/rls-guard.test.ts`; everything after it runs in `withTenant`. A superseded version keeps opening with its SUPERSEDED marker; only the current version can be shared. Limits: 10 active links per prescription, 60 links per user per hour (database counts; two simultaneous shares can overshoot by one), 20 public requests per client address per minute (in memory, per process). The PDF limiter drops a queued render whose request was aborted.

**Consequences:** No PHI in URLs, previews or logs; the patient taps once more. The in-memory limit is per process: production must add an edge rate limit. Opens are counted only for completed renders.

**Revisit trigger:** a stored PDF (Phase 2 storage), the WhatsApp Cloud API sending documents directly, or a patient portal with accounts.

---

## ADR-0038 — Sending: a wa.me link the clinic sends itself, email through a provider, sharing off per clinic

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** ADR-0010 chose the WhatsApp Cloud API behind an abstraction, but it needs Meta business verification, approved templates and credentials that do not exist yet; Phase 1 needs sharing now.

**Decision:** WhatsApp sharing builds `https://wa.me/<international digits>?text=<message>` (`waMeLink`); the message names the clinic, the Rx number, the link and its expiry, never the patient or clinical text. The browser opens it from a real anchor click in a new tab (popup blockers), which works on phones and desktop. Phone input goes through `whatsAppRecipient`: Indian numbers may be typed nationally and must be mobiles (6–9), other countries need `+` and the code, anything ambiguous is refused with what to type. Email sends the same expiring link (no attachment) through `EmailProvider`; `getEmailProvider()` builds the Resend adapter only when `RESEND_API_KEY` and a valid `EMAIL_FROM` exist, otherwise email is hidden. The provider is called outside any database transaction; a failed send withdraws its link (`send_failed`). `prescription_shares` is the append-only share log (channel, masked recipient, provider, status `prepared | sent | failed`, provider id, error code); full numbers and addresses are never stored. At most 5 emails per prescription per 24 hours. `clinics.sharing_enabled` (default false) is the owner's switch; off makes every link of the clinic answer 404 at once. Roles: `rx.share` = owner, doctor, reception. Tests use a fake provider and never touch the network.

**Consequences:** No message leaves ClinicPad's servers for WhatsApp; delivery status is unknown ("prepared"). The Cloud API (or a BSP) can replace the `wa_link` provider behind `shareByWhatsApp` without changing links, consent or the log.

**Revisit trigger:** Meta verification complete (Cloud API), BSP choice (open decision #2), delivery reconciliation (Phase 3).

---

## ADR-0039 — Patient CSV import: stateless dry-run and commit, Excel repairs, explicit duplicate decisions, idempotent rows

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** Clinics arrive with patient lists from Excel and other software (ROADMAP 1.1, PRODUCT_SPEC §6.2). Files come in odd encodings and formats, contain duplicates and family phones, and get uploaded twice.

**Decision:** The browser keeps the file; the server re-parses it for the dry-run and for the commit, which refuses a file whose SHA-256 changed. Caps: 1,000,000 bytes, 5,000 rows, 40 columns, 2,000 characters per mapped cell. UTF-8 (BOM stripped) and UTF-16 with a BOM are read; workbooks, BOM-less UTF-16, binary data and non-UTF-8 text are refused with what to do. The delimiter (`,` `;` tab) comes from the header line; row numbers are spreadsheet rows. Headers map to fields by aliases and the owner can change every choice. Rows pass Excel repairs (day-first dates, Excel serials, `'` and `.0` removed; two-digit years, month/day/year, a bare year and scientific-notation phones refused; a NUL refuses the row; an age column is reported, never turned into a birth date) and then the patient form's own schema and the clinic-day DOB rule. A duplicate (normalized phone matching an active patient or an earlier row) is skipped unless the owner chooses "register as new" or, when exactly one same-name patient matches, "add missing details" (fill-only, never overwrite); an exact repeat inside the file can only be skipped. Each imported patient stores `import_row_key` (SHA-256 of name key, phone, DOB; partial unique index), so a re-run imports nothing twice. The commit runs in one transaction under `pg_advisory_xact_lock` per tenant, allocates patient numbers as one block, and writes `patient_imports` (append-only job row), `patient.created` per patient with the import id, `patient.updated` per fill with field names, and `patient_import.committed`. The problem-row download is built in the browser by `serializeCsv`, which neutralises formula cells. Import is owner-only (`patient.import`). `sample_data/patients_template.csv` documents the shape; the existing `sample_data` catalogue lists stay loaded by `npm run db:seed:catalogue`.

**Consequences:** No PHI staging table; the file travels twice. Dates are always read day-first. Imported rows carry an import id for later clean-up.

**Revisit trigger:** `.xlsx` upload, files above 1 MB (would need a route handler instead of a server action), a full merge tool, or importing prescriptions.

---

## ADR-0040 — Database hardening of Plan 1D

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** ADR-0023 listed gaps (an INSERT of an already-finalized row; the `finalized -> amended` flip without a successor), statuses and clinical values were checked only by Zod, CHECKs lived only in SQL, three foreign-key columns had no index, `tenant_medicines.created_by` had no key, the runtime role could delete counters, and no test covered RLS across the whole schema.

**Decision:** 0017: rows of `prescriptions` and `visits` are born as drafts (BEFORE INSERT, `23000`); the flip to `amended` requires a finalized child of the same tenant; closed status vocabularies; `tenant_counters` DELETE/TRUNCATE revoked. 0018: periodicity, quarter-step dose (0–99) and duration (1–365) CHECKs on items and favourites; indexes on `visits(tenant_id, doctor_id)`, `visits(tenant_id, branch_id)`, `prescriptions(tenant_id, template_version_id)`; `tenant_medicines (tenant_id, created_by) -> memberships (tenant_id, user_id) ON DELETE SET NULL (created_by)`. New CHECKs are added `NOT VALID` and validated in the same migration when every row passes, so a development database with leftovers still migrates (`npm run db:sweep-test-tenants` removes old test tenants: only local databases, only tenants whose members all use `@example.com`, older than an hour, never `demo-clinic`). Every CHECK is also declared in the Drizzle schema, and `tests/integration/schema-checks.test.ts` fails when the two lists differ; policies, grants and triggers stay in SQL, and `tests/integration/rls-guard.test.ts` requires forced RLS and an `app.tenant_id`-scoped policy on every table with a `tenant_id` (one allow-listed exception, ADR-0037). The composite-key guard now also accepts memberships' `(tenant_id, user_id)` key. The demo seed inserts drafts and finalizes them by UPDATE; `createTestTenant` gives its user an owner membership; the e2e `seedPatients` reserves numbers through the counter.

**Consequences:** ADR-0023's "INSERT of an already-finalized row" and "no successor check" limitations are closed. A constraint can remain NOT VALID on a dirty development database until it is swept; new writes are checked either way.

**Revisit trigger:** a managed database that restricts triggers, or partitioning by tenant.

---

## ADR-0041 — Clinic-timezone dates, patient history and archive, and Plan 1D localisation choices

- **Status:** accepted
- **Date:** <the day this step runs, YYYY-MM-DD>

**Context:** DOB validation and on-screen ages used the UTC day, so a baby born today could not be registered between 00:00 and 05:30 IST. The patient page listed prescriptions unfiltered, and archive had no UI or way back. Three localisation items were open: Hindi labels for option codes, "Page x of y" in Hindi, and a temperature unit.

**Decision:** Calendar days are the clinic's (`clinicLocalDate`, `src/lib/domain/clinic-date.ts`): the Zod DOB bound is the latest date on Earth (UTC+14) and the services apply the clinic's day; patient ages on screen and history date filters use the clinic's zone (an unknown zone falls back to Asia/Kolkata, never UTC). `listPatientPrescriptions` filters by clinic-local date range on `coalesce(finalized_at, created_at)`, the visit's doctor, status and diagnosis or complaint text (escaped `ILIKE`), 20 per page with a total order; malformed URL filters are ignored. Rows offer Open, Print, Download PDF and, for the current version, Repeat. Archive (owner, inline confirm) hides a patient from search and new prescriptions, keeps every record, revokes its share links, and is undone from "Show archived" (audit `patient.archived` with `revokedLinks`, `patient.unarchived`). Hindi labels for food relation and periodicity codes have one source (`FOOD_RELATION_LABELS_HI`, `PERIODICITY_LABELS_HI` in `rx-options.ts`); printed output is unchanged. "Page x of y" stays English with Western digits in every label language (the Gotenberg footer cannot rely on the embedded Devanagari font; Western digits are normal on Indian pads). The temperature unit stays °F until Phase 3 nurse vitals: a unit setting changes the frozen snapshot (`v` bump), the autosave payload, the renderer and the golden files.

**Consequences:** Dates agree between the form, the list, the pad and the filters. A native speaker still has to review all Hindi strings (pad labels, option labels, consent text, share pages).

**Revisit trigger:** a clinic outside India, a UI language switch, or Phase 3 vitals.
```

- [ ] **Step 3: Update `docs/PROGRESS.md`**

- Header: **Last updated** today; **Current phase** "Phase 1D — Sharing, consent, CSV import, history, hardening (code complete; automated gate passed locally <date>). Phase 1 is code complete; the exit criteria that need people are open (section 4.11)."; **Overall status** with today's gate.
- Section 1 snapshot: "Tests passing" and "Build status" rows from Step 1's output.
- Section 2: Phase 1 row "🟡 code complete (1A–1D); exit criteria needing design partners open (section 4.11)".
- Add after section 4.10's follow-ups and before `## 5. In progress`:

```md
### 4.11 Phase 1D checklist (sharing, consent, CSV import, history, hardening)

A box is ticked only for evidence seen on <date> at commit `<the last code commit>`: <paste the gate's lint, typecheck, test and e2e summary lines>.

- [ ] Rows born as drafts; superseding needs a finalized successor; status vocabularies; counter DELETE/TRUNCATE revoked; RLS forced and tenant-scoped on every tenant table (`tests/integration/integrity-1d.test.ts`, `rls-guard.test.ts`)
- [ ] Every CHECK declared in the Drizzle schema; periodicity, dose and duration checks; FK-column indexes; `tenant_medicines.created_by` composite key; test-tenant sweep (`schema-checks.test.ts`, `tenant-fk.test.ts`, `tests/unit/sweep-rules.test.ts`, `sweep-test-tenants.test.ts`)
- [ ] DOB and ages on the clinic's calendar; a newborn at 00:30 IST registers (`tests/unit/clinic-date.test.ts`, `tests/integration/patients-dates.test.ts`)
- [ ] Patient history: date, doctor, status and text filters, pages, Open / Print / Download / Repeat; archive and restore (`patient-history.test.ts`, `patient-archive.test.ts`, `tests/unit/prescription-history.test.tsx`, `tests/e2e/patient-history.spec.ts`)
- [ ] CSV import: decoding, delimiters, mapping, Excel repairs, validation report, duplicate decisions, idempotent and concurrent-safe commit, formula-safe problem-row download (`tests/unit/{csv,csv-decode,patient-import-rows}.test.ts`, `patient-import.test.ts`, `tests/unit/import-wizard.test.tsx`, `tests/e2e/patient-import.spec.ts`)
- [ ] Consent log with version and method; withdrawal and archive revoke links; per-clinic sharing switch, off by default (`sharing-schema.test.ts`, `consent.test.ts`, `tests/unit/consent-card.test.tsx`)
- [ ] Share links hashed, 7 days, 10 opens, revocable; public interstitial and PDF; uniform 404; previews never count; rate limits; PDF abort (`tests/unit/{share-token,rate-limit}.test.ts`, `share-links.test.ts`, `share-route.test.ts`, `rx-output-http.test.ts`, `gotenberg.test.ts`)
- [ ] WhatsApp `wa.me` link and email provider behind consent; masked share log; Share panel; nurses and pharmacists cannot share (`tests/unit/{recipient,wa-link,email-provider,share-panel}.test.ts(x)`, `sharing.test.ts`, `prescription-page.test.tsx`, `tests/e2e/sharing.spec.ts`)
- [ ] Hindi option labels in one place (printed output unchanged); in-app not-found; skip link; keyboard-only registration (`tests/unit/rx-option-labels.test.ts`, `tests/e2e/keyboard.spec.ts`)
- [ ] Desktop export unchanged with `src/app/s` stashed (`npm run build:desktop`, clean tree)
- [ ] `node scripts/verify-gate-0.mjs` PASSED with the Phase 1D tests; `npm run test:visual` 24 passed, no baseline changed

**Phase 1 exit criteria: evidence so far**

| Exit criterion (ROADMAP §3) | Automated evidence | What still needs people | Status |
|---|---|---|---|
| A repeat prescription is finalized, printed and shared in under 60 seconds (5 real users) | `prescriptions.spec.ts` (repeat), `rx-output.spec.ts` (print), `sharing.spec.ts` (WhatsApp link), `patient-history.spec.ts` (repeat from the list) | Time it with 5 real users at design-partner clinics | open |
| A new patient is registered in under 30 seconds by a receptionist | `keyboard.spec.ts` (keyboard-only registration; printed <N> s in automation) | Time it with receptionists | open |
| PDF output is visually consistent across Chrome, Safari and the print dialog | `rx-visual.spec.ts` (Chromium and Gotenberg, 24 reviewed screenshots) | Print one pad from Safari | open |
| Finalized prescriptions are immutable; amendments create v2 with a reason and an audit event | `immutability.test.ts`, `immutability-races.test.ts`, `integrity-1d.test.ts`, `prescriptions-lifecycle.test.ts` | — | met (automated) |
| 5 design-partner clinics use it for 10 working days with no data-loss incident | — | The pilot itself (needs staging, see section 5) | open |
| Render failure rate < 1%; p95 finalize < 800 ms online | Local tests only | Staging metrics under real use | open |
| CSV import of the existing `sample_data/*.csv` shape works with a validation report | `patient-import.test.ts`, `import-wizard.test.tsx`, `patient-import.spec.ts` (patients, `sample_data/patients_template.csv`); `catalogue-seed.test.ts` (the catalogue lists) | — | met (automated) |

**Phase 1D known limitations and follow-ups**

- HUMAN DECISION (still open): may an owner without a doctor profile finalize (sections 4.8–4.10)?
- HUMAN DECISION (still open): data minimisation for reception and pharmacists (`rx.read` unchanged; `rx.share` excludes nurses and pharmacists by default).
- HUMAN DECISION: WhatsApp Cloud API vs a BSP (ADR-0010, open decision #2). Not built; `wa.me` manual send only, delivery status unknown ("prepared").
- HUMAN: legal review of the English consent text and native-speaker review of every Hindi string (pad labels, option labels, consent text, share pages) before any clinic turns sharing on; sharing stays off per clinic until then.
- HUMAN/OPS: a Resend account and sender-domain DNS for email sharing; `NEXT_PUBLIC_APP_URL` as an https origin in production; an edge rate limit in front of `/s/`.
- The public-route rate limit and the PDF limiter are per process.
- Two simultaneous shares can overshoot the per-user or per-prescription link limits by one, and two emails the daily email limit (no lock).
- Dates in imports are always read day-first; a US-formatted file with days ≤ 12 is read wrongly unless a later row has a day above 12 in the first place or the owner notices the preview.
- Temperature stays °F (ADR-0041). "Page x of y" stays English (ADR-0041).
- TransformStream dev-server error: <Task 11's finding>.
- Other columns that hold a user id without a key (`patients.created_by`, `clinic_assets.created_by`, `prescription_outputs.actor_user_id`, `audit_events.actor_user_id`, `prescriptions.finalized_by`, the new `*_by` columns) are unchanged; only `tenant_medicines.created_by` was asked for.
```

- In sections 4.8, 4.9 and 4.10, append " — resolved in Plan 1D (`<commit>`)" to each follow-up this plan closed, using the commit of the task that closed it: DOB UTC/IST and the age label (Task 3); `tenant_counters` DELETE, the BEFORE INSERT guard, the finalized-child precondition, the status CHECKs (Task 1); periodicity/dose/duration CHECKs, 0012 CHECKs only in SQL, the three missing indexes, `tenant_medicines.created_by`, the catalogue-wide RLS guard (Tasks 1–2); e2e `seedPatients` and the leaked-tenant sweep (Task 2); patient archive UI and unarchive (Task 4); phone `tel:` / `+0091` (Task 5); Hindi labels for the option codes (Task 11); the PDF limiter abort plumbing (Task 9); "Page x of y" and the temperature unit (decided, ADR-0041); the TransformStream item (Task 11's finding: "resolved" only if it was dev-only).
- Section 5: replace the "**Next:**" line with "**Next:** a design-partner pilot needs staging (Phase 0 carry-overs) and the human decisions listed in section 4.11; then Phase 2 (Template Studio). Phase 2's ADRs start at ADR-0042; its migrations start at 0023."
- Section 11: a session-log entry in the same format as the 2026-11-17 entries (Did / Evidence / Blocked by / Next / Gotchas). Gotchas worth keeping: rows are born as drafts (insert then UPDATE to finalize); a `finalized -> amended` flip needs a finalized child first; every CHECK must also be declared in the Drizzle schema; `as("reception")` returns a new random user per call (capture one context when asserting on it); `/s/` is outside the middleware and must stay session-less; the e2e sharing spec needs Gotenberg up for its PDF branch.

- [ ] **Step 4: Update `docs/SETUP.md`, `.env.example` and `AGENTS.md`**

`docs/SETUP.md`:
- §3.1, the `NEXT_PUBLIC_APP_URL` row: "Canonical URL, used in links and auth callbacks; the base of share links (`/s/<token>`). An https origin with no path in production, or sharing is unavailable."
- §3.3: replace the `RESEND_API_KEY`, `EMAIL_FROM` row with `| \`RESEND_API_KEY\`, \`EMAIL_FROM\` | 1D (optional) | Email sharing of prescription links. Without both, the Share panel hides email; tests never set them |`.
- §5 commands: add `npm run db:sweep-test-tenants            # list leftover test tenants (local databases only); add -- --apply to delete them`.
- §9 troubleshooting: add `| Share panel says "Sharing is turned off for this clinic" | Off by default | The owner turns it on in Settings, Sharing (after reviewing the consent text) |` and `| A shared link says "This link is not valid" | Expired (7 days), used 10 times, withdrawn, consent withdrawn, patient archived, or sharing switched off | Share again from the prescription page |`.

`.env.example`: above `RESEND_API_KEY=`, replace `# Email` with:

```
# Email sharing of prescription links (Plan 1D, optional). Leave empty to hide email in the Share panel.
# EMAIL_FROM must be a sender address on a domain verified with the provider.
```

and above `NEXT_PUBLIC_APP_URL`, add `# Also the base of share links (/s/<token>); an https origin in production.`.

`AGENTS.md`:
- **Last updated** today.
- §2 bullet "No billing, no appointments, no sharing, no offline sync for the web app; ..." becomes "No billing, no appointments, no offline sync for the web app. Sharing exists as consent-gated, expiring links sent through `wa.me` or email (Plan 1D), not through the WhatsApp Cloud API. Built-in pad templates and PDF exist since Plan 1C; Template Studio does not."
- §2 "Repository state": date; "Phase 0 and Phase 1A–1D are code complete"; the gate counts from Step 1; "sections 4.8 to 4.11"; add a sentence: "Phase 1D adds DPDP-style consent (`patient_consents`), hashed expiring share links with a public `/s/<token>` route and a masked share log, WhatsApp `wa.me` and email sharing behind a per-clinic switch, patient CSV import with a validation report and duplicate decisions, patient history filters, archive and restore, clinic-timezone dates, and database hardening (rows born as drafts, CHECKs mirrored in the schema, an RLS guard)."; "What does not exist: Template Studio, the WhatsApp Cloud API and delivery status, offline sync, billing, staging."; "ADR-0019 to ADR-0041".
- §6 Commands: add `npm run db:sweep-test-tenants   # dev only: leftover test tenants (add -- --apply)`.
- §8: "Phase 1 (1A–1D) is code complete. Next: staging and a design-partner pilot (human decisions in docs/PROGRESS.md section 4.11), then Phase 2."
- §10: change the desktop-build bullet's list to "everything under `src/app/(app)`, auth, API, and the public share route `src/app/s`", and add:
  - "**`/s/<token>` is the only route without a session.** It finds the link through `withShareToken` (policy `share_link_by_token`) and does everything else in `withTenant`; never `adminDb`, never patient or clinic details on the interstitial, and every unusable link answers the same 404 (ADR-0037)."
  - "**Lock the patient row before writing that patient's share links**: `FOR SHARE` to create one, `FOR UPDATE` (or the patient `UPDATE`) to withdraw consent or archive (ADR-0036). No sharing path locks a prescription."
  - "**Rows are born as drafts (0017).** Insert visits and prescriptions as drafts and finalize by UPDATE (prescription, then visit); a `finalized -> amended` flip needs a finalized child first. Test fixtures that flip a parent must finalize a version 2 first."
  - "**Every CHECK constraint is declared in the Drizzle schema too** (`tests/integration/schema-checks.test.ts`). A new CHECK on a table with existing rows goes in `NOT VALID` and is validated in the same migration (see 0017/0018); run `npm run db:sweep-test-tenants` on a dirty development database."
  - "**Patient import commits under a per-tenant advisory lock and numbers patients with `allocateNumbers`** (one block); keep both, or a double-click imports twice or burns numbers (ADR-0039)."
  - "**Tests never send email or call providers.** Pass `createFakeEmailProvider()` (`tests/helpers/fake-email.ts`); `getEmailProvider()` is null without `RESEND_API_KEY`."
  - "**`as(role)` in `createTestTenant` returns a fresh random user id for every role except owner and doctor.** Capture one context when a test asserts on the actor."

- [ ] **Step 5: Re-run the quick checks after the edits and commit**

```powershell
Set-Location E:\projects\clinicpad; npm run lint; if ($?) { npm run typecheck }
Set-Location E:\projects\clinicpad; git status --short
Set-Location E:\projects\clinicpad; git add docs/DECISIONS.md docs/PROGRESS.md docs/SETUP.md AGENTS.md .env.example
Set-Location E:\projects\clinicpad; git commit -m "docs: record Phase 1D decisions (ADR-0036..0041), exit-criteria evidence, and progress" -m "Co-Authored-By: Claude <model> <noreply@anthropic.com>"
```

Expected: lint and typecheck clean (documentation only); `git status --short` lists exactly the five files before the commit and nothing after it. Tick a §4.11 box only where Step 1's output (or a later re-run after a fix) shows the evidence.

---

## Self-review

**Spec and roadmap coverage**
- 1.7 Sharing: provider seam with a `wa.me` link (Tasks 9–10, decision 9), email through `EmailProvider` with a fake and a Resend adapter built only from env credentials (Task 10, decision 10), consent with purpose, version, timestamp, captor and revocation before any share (Task 8, decisions 1–3), an append-only share log with masked recipients (Tasks 8, 10, decision 11), hashed, expiring, revocable, count-limited links (Tasks 8–9, decision 4), a public route that serves only the frozen PDF with a uniform 404, `no-store`, `noindex` and no tenant enumeration (Task 9, decisions 5–7), rate limits (Tasks 9–10, decision 12), the Share panel (Task 10), and the Cloud API explicitly out of scope with the seam named (decision 9, ADR-0038).
- 1.1 CSV import: decoding, delimiters, mapping, Excel repairs, caps, formula-safe output (Task 5), dry-run, duplicate and merge decisions, row-level errors, idempotent and concurrent-safe commit, audit, tenant scope (Task 6), the screen and the e2e (Task 7), the sample shape (decision 21).
- 1.8 Patient history: filters, pagination, Open / Print / Download / Repeat; archive and restore with audit and the role matrix (Task 4).
- 1.9 Audit: `prescription.share_link_created`, `prescription.shared`, `prescription.share_opened` (actor null), `prescription.share_revoked`, `patient.consent_recorded`, `patient.consent_withdrawn`, `patient.archived` (with `revokedLinks`), `patient.unarchived`, `patient.created` / `patient.updated` with `importId`, `patient_import.committed`, `clinic.sharing_changed` — ids, codes and counts only, asserted in Tasks 4, 6, 8, 9, 10.
- 1.10 Pilot hardening: every Plan 1D follow-up in the Scope table has a task or a recorded decision (temperature unit and "Page x of y" in ADR-0041; the TransformStream item as Task 11's investigation); empty and error states (Tasks 4, 7, 10, 11); keyboard flow (Task 11).
- Exit criteria: Task 12's evidence table separates what is automated from what needs people (60-second repeat, 30-second registration, Safari, 5 clinics × 10 days, staging metrics).
- Human decisions: listed with their safe defaults (the table before Global Constraints) and carried into PROGRESS §4.11.

**Reconciliation with the code at HEAD `bedd1ff`:** migrations 0017–0022 (0016 is the last); ADRs 0036–0041 (0035 is the last); `enforce_rx_immutability` is reprinted from its 0005 body with one change; the three tests that flip without a successor and the `"void"` test are rewritten in Task 1; the seed's finalized visit inserts are changed in Task 1; the composite-key guard is widened only for `(tenant_id, user_id)` parents in Task 2; `createTestTenant` gains the membership that `tenant_medicines_created_by_fk` needs; `getPatient`, `searchPatients`, `archivePatient` keep their signatures (new options are optional); `renderPrescriptionPdf` keeps its first four parameters; `loadRxDocument` keeps its signature; `LimiterResult` keeps `{ busy: false, value }` so existing `toEqual` assertions hold; the UTC "after today" patient test is rewritten in Task 3 (it would fail every evening otherwise); no new link text contains "patients".

**Placeholder scan:** every code step has complete code and every command its expected output. The conditional instructions are explicit rules, not gaps: re-check ADR numbers (Task 12); reorder a drizzle-kit foreign key that precedes its parent table (Tasks 6, 8); validate a constraint left `NOT VALID` after sweeping (Task 2, with the exact query); add `.gitattributes` only if it normalizes the template CSV (Task 5); replace `requestAnimationFrame` only if jsdom lacks it (Task 7); update a smoke assertion only if one names the old dashboard sentence (Task 11); the TransformStream outcome has three written-out branches (Task 11); gate counts are the ones the gate prints (Task 12).

**Type consistency:** `ColumnMapping`, `ImportField`, `IMPORT_FIELDS`, `IMPORT_FIELD_LABELS`, `PATIENT_TEMPLATE_ROWS`, `checkMapping`, `suggestMapping`, `ageColumns` (Task 5) are what Tasks 6 and 7 import; `IMPORT_LIMITS` lives in `patient-rows.ts` and is imported from there by Tasks 6 and 7. `ImportReport` (with `needsName`, `ageColumns`), `ImportRowReport`, `ImportDecision`, `CommitSummary`, `DryRunState`, `CommitState` (Task 6) are the props and states of Task 7. `ConsentView`, `currentSharingConsentIn`, `revokeActiveLinksForPatient`, `RevokeReason` (Task 8) are used by Tasks 9 and 10; `ConsentCard({ patientId, consent, canCapture, archived, timeZone })` is rendered by the patient page (Task 8) and the Share panel (Task 10). `createShareLinkIn(tx, ctx, { prescriptionId, channel }, now)`, `CreatedLink`, `ShareLinkView`, `ShareChannel`, `SHARE_LIMITS`, `listShareLinksIn` (Task 9) are consumed by `sharing.ts` (Task 10) and `tests/helpers/share.ts`. Share-link columns are `openCount` / `maxOpens` / `lastOpenedAt` everywhere (schema, trigger, services, list, panel text "opened N of M"). `LimiterResult` with `aborted` (Task 9) is handled in `rx-output.ts` and `share-links.ts`. `PdfEngine.render(doc, { signal })` is implemented by Gotenberg and the fake. `SharePanelData` (Task 10) carries `timeZone` for the panel, the links list and the consent card. Labels the e2e specs use match the components: "Show archived", "Archive patient", "Yes, archive patient", "Restore patient", "Import from CSV", "CSV file", "Check file", "Import N patients", "Nothing to import", "Allow sharing prescriptions…", "Save sharing", "Record consent", "WhatsApp number", "Create WhatsApp message", "Open WhatsApp", "Open prescription (PDF)", "This link is not valid", "Withdraw link", "Withdraw consent", "Yes, withdraw consent", "Skip to content", "Not found", "Register your first patient".

**Review Focus coverage:** (1) phone formats — `phone.test.ts` (Task 5), `patient-import-rows.test.ts` phone cells (Task 5), `recipient.test.ts` 22 phone cases (Task 10); (2) desktop links, previews and scanners — `wa-link.test.ts` (universal link), `share-panel.test.tsx` (anchor, no `window.open`), `share-route.test.ts` (four preview agents, cross-site POST), `sharing.spec.ts`; (3) link lifecycle — `share-links.test.ts` and `share-route.test.ts` (uniform 404 across seven states, engine failure burns nothing, superseded opens marked), `consent.test.ts` (withdrawal revokes); (4) Excel CSVs — `csv.test.ts`, `csv-decode.test.ts`, `patient-import-rows.test.ts`, `patient-import.test.ts` file checks, `import-wizard.test.tsx` problem-row download, `patient-import.spec.ts`; (5) duplicates — `patient-import.test.ts` (family phone, in-file repeat, re-run, concurrent commits, a duplicate appearing after the check, fill-only). Clinic timezones are pinned in `clinic-date.test.ts`, `patients-dates.test.ts` and `patient-history.test.ts`.
