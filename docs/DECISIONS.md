# ClinicPad — Architecture Decision Records

**Last updated:** 2026-11-19
**Format:** lightweight ADR (context → decision → consequences → revisit trigger)
**Rule:** if a decision is hard to reverse or affects tenant safety, patient data, or money, it goes here before implementation.

Status values: `proposed` · `accepted` · `superseded` · `rejected`

---

## ADR-0001 — Product name: ClinicPad

- **Status:** accepted (working name)
- **Date:** 2026-11-06

**Context:** We need a name that works for a prescription-first clinic OS in India and abroad, is easy to say on a WhatsApp call, and does not box us into "prescription software" forever.

**Decision:** Use **ClinicPad** as the working product name, with "Your pad. Digitised." as the tagline.

**Consequences:** Short, memorable, and ties directly to the BYOP wedge. "Pad" is understood in India and internationally. Must run a trademark and domain check before spending on branding.

**Revisit trigger:** trademark conflict, domain unavailable at reasonable cost, or a name test that shows confusion with existing clinic products.

---

## ADR-0002 — Market sequencing: India first, international after Phase 5

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** International practice management is a different product: HIPAA/GDPR, local payments, local tax, different clinical workflows, higher support expectations. Spreading thin early would slow the wedge.

**Decision:** Build and sell in India through Phase 4. Add international data region, Stripe, localization, and compliance in Phase 5.

**Consequences:** Faster learning and lower compliance cost early. Leaves international inbound on the table for 6–9 months. Architecture must keep tenant region as a first-class field from day one so the later split is not a rewrite.

**Revisit trigger:** significant inbound from a single international market, or India growth stalls below Gate B.

---

## ADR-0003 — Application stack: Next.js App Router + TypeScript + Tailwind + shadcn/ui

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** The prototype already uses this stack. The team knows it. It supports server rendering, server actions, API routes, and a static export for Tauri.

**Decision:** Keep Next.js 15 (App Router), React 19, TypeScript (strict), Tailwind v4, and the existing shadcn/ui primitives. Do not introduce a second UI kit.

**Consequences:** Reuse of existing components and skills. Static export must be split from the web build (ADR-0012). Server components require disciplined boundary design.

**Revisit trigger:** Tauri/static build becomes unmaintainable, or performance targets cannot be met.

---

## ADR-0004 — Multi-tenancy: shared Postgres with row-level security

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** Clinic data is sensitive. We need isolation without operating one database per clinic.

**Decision:** Single Postgres database, `tenant_id` on every business table, RLS enforced at the database. The app uses a tenant-scoped client; tenant identity comes from the authenticated session, never from request input.

**Consequences:** Strong isolation with manageable operations. Every query and migration must respect RLS. Cross-tenant admin tasks require a separate, audited role. Tests must prove isolation, not assume it.

**Revisit trigger:** a tenant requires dedicated infrastructure (enterprise/chain), or RLS performance degrades at scale.

---

## ADR-0005 — Database hosting: Supabase Mumbai for the MVP

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** We need managed Postgres, storage, auth options, and India residency without hiring an SRE.

**Decision:** Use Supabase in `ap-south-1` (Mumbai) for MVP Postgres, storage, and possibly auth. Keep a self-host path via Docker for clinics that require it later.

**Consequences:** Fast start and India residency. Vendor coupling in auth/storage; keep DB access through Drizzle and storage behind an interface. Pricing must be monitored as document storage grows.

**Revisit trigger:** Supabase pricing exceeds self-host cost, residency requirements expand, or auth limitations block required flows.

---

## ADR-0006 — ORM: Drizzle

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** We need typed SQL, migrations, and RLS-friendly queries. Prisma's engine and migration model add weight; raw SQL loses type safety.

**Decision:** Use Drizzle ORM with `drizzle-kit` for migrations.

**Consequences:** SQL-like control and good TypeScript inference. Smaller ecosystem than Prisma; some patterns must be written manually. RLS policies live in SQL migrations, not in the ORM schema.

**Revisit trigger:** Drizzle blocks a critical feature (e.g. complex migrations, views) or team velocity drops.

---

## ADR-0007 — Document pipeline: Gotenberg + LibreOffice + pdf2docx + OCR

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** The wedge requires high-fidelity DOCX→PDF, PDF→DOCX, and OCR for scanned pads.

**Decision:**
- DOCX/HTML → PDF: **Gotenberg** (LibreOffice for DOCX, Chromium for HTML).
- DOCX templating: **docxtemplater**.
- PDF → DOCX: **pdf2docx** for text PDFs.
- Scanned PDFs: **OCRmyPDF + Tesseract** (English + Hindi + regional packs), then pdf2docx.
- Merge/split/compress: Gotenberg / qpdf / pdfcpu.

**Consequences:** Good fidelity without building a renderer. Conversion must run in a sandbox with no network, file-size/time limits, virus scanning, and pinned LibreOffice/font versions. Fidelity is not perfect; overlay mode is the fallback.

**Revisit trigger:** fidelity complaints exceed 5% of templates, or a commercial engine (e.g. Aspose) becomes cheaper than support cost.

---

## ADR-0008 — Authentication: Auth.js v5 with credentials, phone OTP in Phase 1

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** Indian clinics expect phone OTP; international users expect email/Google. We need MFA for owners, server-enforced sessions, and a provider that works with our own Postgres without coupling RLS to a vendor's JWT.

**Options considered:**
1. Supabase Auth — fastest, phone OTP support, RLS integration, but vendor coupling and India SMS costs.
2. Auth.js (NextAuth) + custom SMS — flexible, portable, more code.
3. Clerk — excellent DX, higher cost at scale, data residency questions.
4. WorkOS — enterprise SSO later, overkill now.

**Decision:** Use **Auth.js v5** with a Credentials provider (email + password, bcrypt) and JWT sessions. Store our own `users` table. Session tokens carry `userId`, `tenantId`, and `role`; the server re-validates membership on sensitive mutations. Phone OTP and Google are added in Phase 1 through additional providers; MFA for owners follows the same session model.

**Why not Supabase Auth:** our RLS design uses `app.tenant_id` set by the server, not `auth.uid()`. Auth.js keeps auth portable across Supabase, self-hosted Postgres, and desktop.

**Consequences:** We own password hashing, rate limiting, reset flows, and session revocation. Those are well-understood but must be tested. Phone OTP is not available on day one; email/password is the Phase 0 path.

**Revisit trigger:** OTP deliverability becomes a conversion blocker, or enterprise SSO requirements exceed Auth.js capabilities.

---

## ADR-0009 — Payments: Razorpay (India) + Stripe (international)

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** Indian clinics pay via UPI/cards/netbanking and need GST invoices. International customers expect cards and local tax handling.

**Decision:** Razorpay subscriptions for India; Stripe for international from Phase 5. All payment state is reconciled by webhook into our own `subscriptions`/`invoices` tables; never trust the client.

**Consequences:** Two integrations, but correct rails. Webhook idempotency and dunning are mandatory. GST invoicing is our responsibility, not the gateway's.

**Revisit trigger:** Razorpay subscription limitations, or a partner requires marketplace payouts.

---

## ADR-0010 — WhatsApp: Cloud API behind a provider abstraction

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** WhatsApp is the distribution channel for prescriptions and reminders in India. Direct Meta integration is cheapest at scale but has onboarding friction. BSPs speed onboarding but add markup and lock-in.

**Decision:** Define `MessagingProvider` with `sendTemplate`, `sendDocument`, `status`, and `optOut`. Implement Meta Cloud API first; allow a BSP adapter if onboarding blocks early customers.

**Consequences:** No per-message markup to customers. Template approval and business verification take time; start early. Delivery status and opt-out must be stored.

**Revisit trigger:** Meta policy changes, BSP economics improve, or deliverability issues appear.

---

## ADR-0011 — Free tier: capped at 100 prescriptions/month

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** A free tier drives adoption in a trust-poor market, but unlimited free usage destroys the business and support capacity.

**Decision:** Free plan: 1 doctor, 1 branch, 100 Rx/month, 1 built-in template, footer branding, 5 document conversions, 30-day audit. No own-pad printing; show a locked preview instead.

**Consequences:** Doctors can form a habit without paying. The cap is high enough for a light practice and low enough to trigger upgrade. Support must handle "why can't I print my pad" gracefully.

**Revisit trigger:** free-to-paid conversion < 3% after 200 free clinics, or support cost per free clinic exceeds ₹50/month.

---

## ADR-0012 — Build targets: split web (server) and desktop (static)

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** `next.config.ts` currently forces `output: "export"` and ignores build errors. Auth callbacks and API routes cannot work in static export.

**Decision:** Two explicit build modes:
- **Web:** normal Next.js server build, strict TS/ESLint, deployed to Vercel/Fly.
- **Desktop:** static export consumed by Tauri, built via a separate config/flag.

Shared code must not assume `window` or Node-only APIs without a boundary.

**Consequences:** Both targets stay viable. CI must build both (or desktop nightly) to catch drift. Some Next.js features are unavailable in desktop mode; the offline layer abstracts them.

**Revisit trigger:** desktop is dropped, or a single build can serve both without compromise.

---

## ADR-0013 — Offline strategy: local-first outbox, server as source of truth

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** Tier 2/3 clinics lose internet and power. Losing a prescription is unacceptable.

**Decision:** Writes go to a durable local store (IndexedDB on web, SQLite on desktop) and an outbox before the UI confirms success. Sync uses idempotency keys and cursor-based deltas. Conflict policy: clinical records are append-only/versioned; demographic edits use last-writer-wins with a visible conflict; money uses server reconciliation.

**Consequences:** Complex sync code and testing. Every mutation needs an idempotency key and a stable client ID. Offline scope is limited to patients, prescriptions, and payments at first.

**Revisit trigger:** sync bugs cause data loss, or a simpler managed sync (e.g. ElectricSQL) matures.

---

## ADR-0014 — Template syntax: docxtemplater-compatible placeholders

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** Doctors' Word files need a simple, documented way to bind data without learning a templating language.

**Decision:** Use `{{field}}` syntax with dot paths, `{{#loop}}...{{/loop}}`, and `{{#if}}...{{/if}}`, compatible with docxtemplater. Unknown fields block publishing. Missing optional values render blank.

**Consequences:** Doctors can edit templates in Word. We must validate and version templates. HTML templates use the same field names for consistency.

**Revisit trigger:** docs templating needs exceed docxtemplater (e.g. complex conditionals), or a WYSIWYG editor replaces Word uploads.

---

## ADR-0015 — Money, time, and identifiers

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** Clinics operate across time zones and currencies; floating-point money causes reconciliation bugs.

**Decision:**
- Money stored as integer **paise/cents** plus ISO currency code.
- Timestamps stored as UTC ISO strings; rendered in clinic timezone (`Asia/Kolkata` default).
- New IDs are **UUIDv7**; human-facing numbers (Rx, invoice) are per-tenant sequences.
- Dates that are clinically meaningful (DOB, follow-up) are stored as dates, not timestamps.

**Consequences:** Conversion helpers at boundaries. Sequence generation must be transactional to avoid gaps/duplicates.

**Revisit trigger:** multi-currency invoices per tenant, or offline sequence conflicts.

---

## ADR-0016 — Data residency and retention

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** DPDP (India) and GDPR (EU) require lawful processing, purpose limitation, and deletion. Medical records also have retention obligations.

**Decision:** India tenant data stays in `ap-south-1`. Add a `region` field to tenants from day one. Retention defaults: clinical records 7 years (or local statutory minimum), audit 7 years, documents per tenant policy, marketing consent revocable. Deletion is soft-delete + scheduled hard-delete with legal-hold override.

**Consequences:** Region-aware routing and storage buckets. Deletion jobs must be tested. Do not claim compliance certifications before they are held.

**Revisit trigger:** new market entry, or a regulator clarifies retention periods.

---

## ADR-0017 — AI guardrails: documentation assist only

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** AI can save documentation time but creates clinical and regulatory risk.

**Decision:** AI may transcribe, structure, summarize, OCR, and suggest template mappings. It may **not** diagnose, prescribe, or recommend treatment. Every AI output is labelled "draft", requires clinician review, and is logged. Drug interaction checks use a licensed dataset, not generative output.

**Consequences:** Slower AI feature development; stronger trust. Prompt and model versions must be recorded for audit.

**Revisit trigger:** regulation explicitly permits clinical decision support with certified models.

---

## ADR-0018 — No generic EMR drift

- **Status:** accepted
- **Date:** 2026-11-06

**Context:** Clinic software tends to expand into everything and lose its wedge.

**Decision:** Every roadmap item must strengthen at least one of: BYOP fidelity, offline reliability, WhatsApp distribution, owner visibility, or reseller leverage. Features that only match competitors go to the bottom of the list.

**Consequences:** We will say no to many requests. Sales must be trained to explain the focus. Revisit only after Gate C.

**Revisit trigger:** churn interviews show a missing table-stakes feature is the reason for leaving.

---

## ADR-0019 — Auth lookups use the admin connection; middleware uses an edge-safe config

- **Status:** accepted
- **Date:** 2026-11-12

**Context:** `users` is revoked from the RLS-bound app role and a membership lookup happens before any tenant is known, so login cannot use `db`. Next.js middleware runs on the edge runtime, which cannot load `postgres` or `bcryptjs`.

**Decision:** `src/server/auth/credentials.ts` performs login and membership lookups through `adminDb`. `src/auth.config.ts` is edge-safe (no DB, no bcrypt) and is the only config middleware imports; `src/auth.ts` adds the credentials provider and DB-backed callbacks. The JWT callback re-reads the active membership on every token use, so role changes and deactivation apply immediately. Middleware only checks that a session exists; role checks happen in server components via `requireSession()`.

**Consequences:** One extra indexed query per authenticated request. Role enforcement must never rely on middleware or on hiding navigation.

**Revisit trigger:** request latency from the membership lookup, or a move to Supabase Auth.

---

## ADR-0020 — Legacy prescription generator isolated in a `(legacy)` route group

- **Status:** accepted (interim, until Phase 1)
- **Date:** 2026-11-12

**Context:** The legacy single-doctor app wrapped every route in `PrescriptionProvider` and its own header, and owned `/`.

**Decision:** Legacy routes live under `src/app/(legacy)/` with their own layout. URLs `/preview`, `/manage`, `/patient-infos` are unchanged; the prescription form moved from `/` to `/prescribe`. `/` redirects to `/dashboard`. The root layout is minimal.

**Consequences:** Legacy data is IndexedDB demo data only and is not tenant-aware. Remove the group when Phase 1 replaces it.

---

## ADR-0021 — Desktop build exports the legacy shell only (interim)

- **Status:** accepted (interim, until Phase 4)
- **Date:** 2026-11-12

**Context:** `output: "export"` cannot include auth, server components behind login, Postgres-backed API routes, or middleware.

**Decision:** `npm run build:desktop` runs `scripts/build-desktop.mjs`, which moves server-only routes to `.desktop-stash/`, swaps in a client redirect to `/prescribe`, runs the static export, and always restores the originals (also after an interrupted run). The Tauri desktop app is therefore the offline legacy generator until Phase 4 delivers local SQLite + sync.

**Consequences:** The list of server-only paths in the script must be updated when new server routes are added to the web app. The Tauri installer has not been smoke-tested since the split.

---

## ADR-0022 — Rx numbers are assigned at finalization, per tenant

- **Status:** accepted
- **Date:** 2026-11-16

**Context:** Prescription numbers are part of a medico-legal sequence. A number handed out to a draft that is later abandoned leaves a hole that has to be explained to an auditor.

**Decision:** First-version drafts have no number (`rx_no` is null); an amendment draft carries its parent's number from the moment it is created. `finalizePrescription` allocates the next per-tenant number inside the finalize transaction, after every check has passed, through `allocateNumber` (`src/server/services/numbering.ts`): an insert-or-increment upsert on the `tenant_counters` row `(tenant_id, 'rx')`, which takes a row lock so concurrent finalizes queue and receive distinct, consecutive numbers. An amendment keeps its parent's `rx_no` and increases `version`; only a prescription with no parent allocates a number. A finalize that fails, conflicts or rolls back burns no number (tested in `tests/integration/prescriptions-lifecycle.test.ts` and `tests/integration/numbering-audit.test.ts`). Patient numbers use the same counter table under the name `patient`.

**Consequences:** The sequence has no gaps from abandoned drafts, double-clicks or failed finalizes. Finalize serializes per tenant on the counter row, which is acceptable at clinic scale. Amendments of a prescription without a number are refused with `conflict` rather than allocating a second number.

**Revisit trigger:** offline finalize (Phase 4) needs number blocks or a different reservation scheme.

---

## ADR-0023 — Immutability is enforced by Postgres triggers

- **Status:** accepted
- **Date:** 2026-11-16

**Context:** Invariant 3 says a signed prescription is never overwritten. Application code can have bugs, and the admin connection bypasses RLS, so the rule has to live where every writer passes through it.

**Decision:** `BEFORE` triggers on `prescriptions`, `prescription_items` and `visits` (migrations 0004, 0005, 0006 and 0008; final rules below) reject changes with SQLSTATE `23000`, also for the admin connection.

- A `finalized` or `amended` prescription cannot be updated or deleted. The only allowed change is the `finalized -> amended` status flip, and nothing else (apart from `updated_at`) may change in that statement.
- Items of a non-draft prescription cannot be inserted, updated, deleted or moved; an update checks both the old and the new parent. Item triggers fail closed on a missing or foreign-tenant parent (`23503`).
- A finalized visit cannot be updated or deleted. A draft visit whose prescription is no longer a draft accepts only the plain `draft -> finalized` flip (`status`, `finalized_at`, `updated_at` change; no other column).
- A non-draft row may be deleted only when its tenant row no longer exists (`tenant_is_erased`, `SECURITY DEFINER`, `search_path` pinned, `row_security = off`, fails closed). Tenant offboarding therefore works, and no other foreign-key cascade can erase a signed record. `clinicpad_app` has no `DELETE` on `tenants`.
- Item and visit triggers read the parent prescription `FOR SHARE`, so a finalize that has not committed yet cannot be raced (`tests/integration/immutability-races.test.ts`).

**Locking rule for every writer:** lock the prescription row `FOR UPDATE` before touching its items or its visit. The services do this (`saveDraft`, `finalizePrescription`, `amendPrescription`). Another order may make PostgreSQL abort one side with `40P01` (deadlock); that is a failed request, not corruption.

**Second lock order (found in the whole-branch review):** there are two orders, not one. `amendPrescription` locks the parent (the finalized source) `FOR UPDATE`. Finalizing an amendment (`finalizePrescription`) locks the child (the amendment draft) first and then updates the parent (the `finalized -> amended` flip), so it locks child then parent. The two cannot deadlock only because amend's open-amendment check returns `conflict` before it writes anything: while an amendment draft exists, amend takes the parent lock, sees the open child and leaves without taking a child lock. **Any rewrite of `amendPrescription` must keep that order: check for an open amendment first, write afterwards.**

**Plan 1B additions to the lock notes:** `discardDraft` (ADR-0031) locks only the draft row `FOR UPDATE` and never the parent, so a discard and a finalize of the same draft serialize on that row (whichever commits second sees the other's result: `immutable` or `not_found`, and no Rx number is burned). `amendPrescription` reads the open child with a plain select, which is safe against a pending discard: it either sees the open child and returns early, or finds the slot free after the discard commits. `repeatPrescription` reads its source `FOR SHARE` (it conflicts with amend's `FOR UPDATE`) and never locks a child.

**Documented limitations (not enforced by these triggers):**
- `TRUNCATE`, `ALTER TABLE ... DISABLE TRIGGER` and `session_replication_role = replica` by a superuser or table owner.
- An `INSERT` of an already-finalized row.
- The `finalized -> amended` flip does not check that a finalized successor exists.
- An uncommitted non-draft prescription is invisible to the visit guard.
- Production must keep the `EXECUTE` grant on `tenant_is_erased` aligned with the role that performs offboarding (migration owner versus admin role split).

**Consequences:** Medico-legal integrity does not depend on application correctness. Services translate `23000` into an `immutable` result. Tests in `tests/integration/immutability.test.ts` and `tests/integration/immutability-races.test.ts` run against the real database.

**Revisit trigger:** a managed-database restriction on triggers, or a legal requirement for cryptographic sealing (hash chain or signature) on top.

---

## ADR-0024 — Amendments copy the visit

- **Status:** accepted
- **Date:** 2026-11-16

**Context:** A signed prescription must stay exactly as issued, yet doctors need to correct it.

**Decision:** `amendPrescription` creates a new draft visit and a new draft prescription: `parent_prescription_id` points at the source, `version = source.version + 1`, `rx_no` is copied, `amendment_reason` is required (5 to 500 characters), and the items are copied with fresh ids. The originals never change until the new version is finalized, when the parent flips to `amended`. Only a `finalized` source can be amended (a draft is edited directly; an `amended` one is refused with `conflict`). There is at most one open amendment per prescription, enforced by the service and by the partial unique index `prescriptions_one_open_amendment` (migration 0003). The audit event `prescription.amendment_drafted` carries `reasonLength` and `parentPrescriptionId`, never the reason text; finalizing the amendment writes `prescription.amended`.

**Consequences:** Full version history with no in-place edits. The amendment is a second visit row for the same encounter and keeps the original `doctorId` (see Phase 1A follow-ups in `docs/PROGRESS.md`).

**Revisit trigger:** reporting needs one visit per encounter, or the amending doctor must differ from the original author.

---

## ADR-0025 — Same-tenant references are enforced by the database

- **Status:** accepted
- **Date:** 2026-11-16

**Context:** RLS checks only a row's own `tenant_id`, and foreign-key checks run without RLS. A single-column foreign key could therefore point at another tenant's row.

**Decision:** Relations between tenant-owned tables use composite keys `(tenant_id, x_id) -> parent(tenant_id, id)`. The parent gets `UNIQUE (tenant_id, id)`. Constraint names are explicit and under 63 characters. Migration 0007 converted `prescription_items -> prescriptions`, `prescriptions -> visits`, `prescriptions.parent_prescription_id` and `visits -> patients`; migration 0009 (`drizzle/0009_tenant_composite_fks_phase0.sql`) converted the last three Phase 0 relations: `branches -> clinics` (`branches_clinic_fk`, cascade), `doctors.primary_branch_id -> branches` (`doctors_primary_branch_fk`) and `template_versions -> templates` (`template_versions_template_fk`, cascade), adding `UNIQUE (tenant_id, id)` on `clinics`, `branches` and `templates`. Nullable parents use the `ON DELETE SET NULL (column)` form (Postgres 15+), so the tenant column is not nulled: `doctors_primary_branch_fk` is `ON DELETE SET NULL ("primary_branch_id")`, hand-written because drizzle-kit emits a plain `SET NULL` that would try to null `tenant_id` and fail the branch delete. A guard test in `tests/integration/tenant-fk.test.ts` fails if a single-column key into a tenant-owned table appears; its allowlist is now empty and must stay empty. Three columns referenced tenant-owned rows with no foreign key at all (`visits.doctor_id`, `visits.branch_id`, `prescriptions.template_version_id`, from `drizzle/0001_plain_chamber.sql`); the guard test inspects declared keys only, so it could not see them. **Update (Plan 1B, migration `drizzle/0010_clinical_references.sql`):** `doctors` now has `UNIQUE (tenant_id, id)` and `UNIQUE (tenant_id, user_id)`, `template_versions` has `UNIQUE (tenant_id, id)`, and the three columns are composite keys: `visits_doctor_fk`, `visits_branch_fk`, `prescriptions_template_version_fk`, each `ON DELETE SET NULL (column)`, hand-written. Deleting a doctor, branch, or template version that a finalized record references is refused by the immutability triggers (deactivate instead); tenant offboarding still works (`tests/integration/clinical-references.test.ts`). **Pattern for every new tenant-owned table:** unique `(tenant_id, id)` on the parent, foreign key on `(tenant_id, x_id)` in the child. Services still resolve every input id through `withTenant` first.

**Consequences:** Composite keys cover every declared relation between tenant-owned tables, and the guard test pins that, so none of those can reference another tenant's row even through the admin connection. Since migration 0010 the three columns listed above are covered too. Migrations need the unique constraint created before the foreign key that references it (drizzle-kit emits them in the wrong order and needs a hand edit).

**Revisit trigger:** partitioning by tenant, which would change how keys are declared.

---

## ADR-0026 — Phase 1A role matrix and repeat rule

- **Status:** accepted
- **Date:** 2026-11-16

**Decision:** `src/lib/domain/permissions.ts` is the single matrix; every service calls `can(role, action)` before touching data, and unknown roles or actions are denied (`tests/unit/permissions.test.ts`).

| Action | owner | doctor | reception | nurse | pharmacist | accountant |
|---|---|---|---|---|---|---|
| `patient.read` | yes | yes | yes | yes | no | no |
| `patient.write` | yes | yes | yes | no | no | no |
| `patient.archive` | yes | no | no | no | no | no |
| `rx.read` | yes | yes | yes | yes | yes | no |
| `rx.draft`, `rx.finalize`, `rx.amend` | yes | yes | no | no | no | no |

The nurse reads but does not write patients (design spec section 4). The accountant reads neither patients nor prescriptions. Only the owner archives patients.

`repeatPrescription` copies a `finalized` source into a new draft. It refuses a draft source and a superseded (`amended`) source with `conflict`: a superseded version holds exactly the content an amendment corrected, so copying it forward would be a patient-safety hazard. Audit payloads carry ids, counts and field names only, never free text.

**Revisit trigger:** a clinic role model that needs per-clinic custom roles, or nurse charting in Phase 3.

---

## ADR-0027 — Visit clinical content lives in columns on `visits`

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** The clinical form adds complaints, medical and drug history, examination notes, vitals, ordered investigations, and a follow-up reason. `DATA_MODEL.md` sketches separate `vitals` and `investigations` tables. Everything that belongs to a finalized prescription must be immutable (ADR-0023) and copied by amend (ADR-0024).

**Decision:** Store them on `visits`: `text[]` for phrase lists (`complaints`, `medical_history`, `drug_history`), `text` for `examination_notes` and `follow_up_reason`, and typed `jsonb` for `vitals` (one object per visit, temperature in °F, BMI computed not stored) and `investigations` (array of `{ name, instructions }`). Prescription items gain a generic name, four dose slots (`numeric(5,2)`, quarter steps), periodicity, SOS, and duration value + unit, with `duration_days` kept as derived total days. `prescriptions.draft_revision` carries the autosave revision (ADR-0029). Plan 1A rows are read as durations in days; no data backfill (migration 0011). Blank phrase entries are dropped; a NUL in any text is refused (`invalid`); other stray control characters and invisible or bidi characters (including U+200E, U+200F, U+061C, U+2061-2064, U+180E and the Unicode tag block) are removed by `cleanInput` / `cleanText` for draft text, the amendment reason and the patient text fields (name, phone, address, notes, allergies); catalogue search terms and keys are cleaned by `cleanText` directly (`src/server/validation/text.ts`, `src/lib/domain/text.ts`).

**Consequences:** The existing visit and item immutability triggers, including the 0008 guard on a draft visit whose prescription is already finalized, cover the new columns with no new trigger (`tests/integration/clinical-schema.test.ts`). Amend copies every visit and item column through `omit()`, so later columns are copied too; repeat copies the prescribing content only. A future child table with clinical content (vitals history, lab orders) needs its own ADR-0023-style trigger.

**Revisit trigger:** vitals trend charts, lab orders with result status, or ICD-coded diagnosis analytics.

---

## ADR-0028 — Medicine catalogue: global reference tables plus clinic tables

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** Doctors need fast medicine and clinical-term suggestions from day one, plus their own medicines and favourite dosing. A single table with a nullable `tenant_id` would need a special RLS policy on a tenant table.

**Decision:** `global_medicines` and `global_clinical_terms` have no `tenant_id`, are loaded from `sample_data/*.csv` by `npm run db:seed:catalogue` on the admin connection (idempotent), and are SELECT-only for `clinicpad_app` (INSERT/UPDATE/DELETE/TRUNCATE revoked; RLS forced with a select policy that applies to every role; the migration role additionally has a `global_owner_write` policy; migration 0012). Clinic additions go to `tenant_medicines`; default lines go to `medicine_favourites`, which belong to a doctor profile through the composite key `(tenant_id, doctor_id) -> doctors(tenant_id, id)` (`medicine_favourites_doctor_fk`, `ON DELETE CASCADE`), one per medicine per doctor, upserted, at most 200. Both tenant tables carry the standard forced `tenant_isolation` policy. Search is a GET route handler (`/api/catalogue/search`) with escaped LIKE wildcards; no trigram index yet.

**Consequences:** Every tenant table keeps the standard isolation policy and the tenant-FK guard stays empty. No request path can modify the shared catalogue. A prescriber without a doctor profile has no favourites. The seed data is reference text, not a licensed drug database; it carries no clinical decision support, it has spelling errors and duplicate names with differing generic names, and it needs a clinical review before any pilot (`docs/PROGRESS.md`, section 4.9 follow-ups).

**Revisit trigger:** a licensed drug database (Phase 6), a tenant above ~20k catalogue rows, or demand for clinic-learned complaint and diagnosis lists.

---

## ADR-0029 — Draft autosave with optimistic revisions

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** Drafts must save automatically without losing or reordering edits when saves overlap, the network drops, or the same draft is open twice. The offline outbox is Phase 4.

**Decision:** Every save sends the full draft snapshot and the `draft_revision` it was based on (`baseRevision`, required and validated at the action boundary: a missing or malformed revision is refused before any service call). The server locks the prescription row, rejects a stale revision with `conflict` and the current revision, and otherwise writes and increments the revision. The client (`src/lib/rx/autosave.ts`) keeps exactly one save in flight, debounces 800 ms (at most 5 s during continuous typing), gives each save a 30 s timeout (a timeout is an ambiguous, retryable failure), retries network and server failures with backoff from 1 s doubling to 30 s while showing "not saved", and stops on a conflict until the user reloads the latest version or explicitly keeps their own; a conflict never overwrites without that choice. Teardown is `dispose()` (keep-safe: a final best-effort save) versus `discard()` (drops pending edits, used when the user reloads the latest). Finalize goes through the same queue with `expectedRevision`, so content the doctor never saw is never finalized; the client gives finalize a 45 s timeout and re-reads state after an unknown outcome (the answer may have been lost after the commit). The editor is disabled until it has hydrated, locked while finalizing and after success, and warns before unload while anything is unsaved. Editor server actions never redirect. Autosaves are not audited; `prescription.finalized` and `prescription.amended` add a clinical summary (counts and field names only) to Plan 1A's payload.

**Consequences:** No interleaved or reordered writes; two windows get a visible conflict instead of a merge. The Phase 4 outbox can reuse the revision contract as its idempotency and conflict check. Known limits are listed in `docs/PROGRESS.md` (section 4.9): Next serialises server actions, so a hung finalize delays a resumed autosave, and one invalid field blocks the whole snapshot. Leaving the page: `dispose()` cannot save when the engine is halted (conflict, locked, invalid), held or failing, and Next soft navigation never fires `beforeunload`, so while edits are at risk (`wouldLoseEditsOnLeave()`) a capture-phase guard on same-origin link clicks, `popstate` and forms marked `data-leave-guard` (the sign-out form) asks for confirmation. It prompts when something is unsaved AND the engine is halted (conflict, locked, invalid), held, paused by a finalize, retrying or in doubt after an ambiguous failure, or a save is in flight (it may hang, and `dispose()` would only queue another behind it). It does not prompt for an edit that is only waiting in the 800 ms debounce, which `dispose()` sends at once, nor after a successful finalize or discard. Cancelling Back restores the URL and the router history state sampled while the page was current. A finalize whose outcome is unknown re-reads the page only when online with nothing unsaved (a failed RSC refresh becomes a full browser reload), and a finalize conflict halts the engine in the conflict state.

**Revisit trigger:** Phase 4 sync design, or users regularly editing one draft from two devices.

---

## ADR-0030 — Who may edit clinical content and use the catalogue

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** The platform spec gives nurses vitals entry, but a nurse writing into a doctor's open draft would race the doctor's autosave. ADR-0026 holds the Plan 1A matrix.

**Decision:** Every clinical field, vitals included, is edited only by roles with `rx.draft` (owner, doctor); finalizing needs `rx.finalize`. Two actions join the matrix in `src/lib/domain/permissions.ts`: `catalogue.read` (owner, doctor, nurse, pharmacist) for medicine and term search, and `catalogue.write` (owner, doctor) for adding clinic medicines. Reception and accountants have neither. Nurse vitals capture moves to the Phase 3 queue flow as its own action and service.

**Consequences:** One writer per draft. Clinics that want nurses to record vitals wait for Phase 3. Roles with `rx.read` (reception, nurse, pharmacist) now also read history, examination notes, and vitals of a prescription; whether reception and pharmacists should see them is a data-minimisation decision to make before a pilot (`docs/PROGRESS.md`).

**Revisit trigger:** design-partner feedback that nurse vitals entry is needed before Phase 3.

---

## ADR-0031 — Discarding drafts and withdrawing amendments

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** Abandoned drafts stayed on the patient's list forever, and an open amendment could be neither finished nor abandoned, which blocked every further correction (one open amendment per prescription, ADR-0024). Repeat copied a prescription even while its correction was in progress.

**Decision:** `discardDraft` (owner, doctor) deletes a draft prescription with its items and its draft visit, after locking the draft row `FOR UPDATE`: a first-version draft, or an open amendment, which frees its parent's slot without touching the parent. A finalized or amended version is never deleted (`immutable`; the triggers refuse it anyway), and a corrupt state the triggers refuse (a draft prescription on a non-draft visit) returns `immutable` with "This prescription cannot be discarded.". The event `prescription.draft_discarded` records ids and counts only. `repeatPrescription` refuses a source with an open amendment draft (`conflict`) and reads the source `FOR SHARE`. The page offers "Discard draft" / "Withdraw amendment" to roles with `rx.draft` behind an inline confirm step (focus on "Keep it", warning announced politely); after a failed discard the form refreshes the page, and a `not_found` reads "This draft was changed or discarded elsewhere."

**Consequences:** Drafts are not records (ADR-0029), so a discarded draft is gone; only its audit event remains. Doctors can always get out of an unwanted correction. Lock interplay with finalize, amend and repeat is described in ADR-0023; `tests/integration/prescriptions-discard.test.ts` holds the row lock to prove the order deterministically.

**Revisit trigger:** a clinic asking to restore a discarded draft (switch to a `discarded` status).

---

## ADR-0032 — Printed prescriptions come from a snapshot frozen at finalize, signed by the finalizer

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** A reprint read the patient's name and age, the clinic header, and the doctor's details live, so a later edit (a renamed patient, a moved clinic, a corrected registration number) would change a medico-legal record. The immutability triggers (ADR-0023) forbid writing to a prescription after finalize. An amendment copies the original visit, including its `doctor_id` (ADR-0024), and an owner without a doctor profile can finalize.

**Decision:** `finalizePrescription` builds and Zod-parses `prescriptions.render_snapshot` (patient name, number, gender, date of birth, age, allergies; clinic name, address lines, phone, email, footer lines, logo asset id, timezone; prescribing doctor's name, qualifications, designation, registration number and council, signature asset id; template, paper size, label language) under the prescription row lock and BEFORE the Rx number is allocated, then writes it in the same UPDATE that sets `status = 'finalized'` (the trigger allows it while the row is a draft and freezes it afterwards). The column is always overwritten in that UPDATE, so a stale value stored on a draft cannot survive. Lock order, revision check, numbering rule, and audit payload are unchanged.

- The prescriber is the finalizing user: their own doctor profile, or no doctor block at all; never the visit's doctor.
- A draft is never signed. Its preview (`loadRxDocument`) names as would-be signer only the VIEWER's own doctor profile (name and registration number) and only when the viewer can finalize (`rx.finalize`); anyone else sees "Not signed — draft". A draft never loads or embeds a signature image (the loader nulls the asset id and the renderer ignores any image it is given), and never shows the visit's doctor, whose identity an amendment inherits.
- What is frozen is the DATA (patient, clinic, doctor, layout choices, clinical content). The PRESENTATION (template drawing, labels, CSS, fonts) is not: a later release can print the same snapshot differently. Every output row therefore records `renderer_version` (`RENDERER_VERSION` in `src/lib/rx-render/render.ts`, migration 0016; null for rows logged before it); bump the constant whenever printed output changes.
- The age is computed for the calendar day in the clinic's timezone (an unknown zone falls back to `Asia/Kolkata`, never UTC).
- It fails closed: an unparseable snapshot or a tenant with no clinic row refuses to finalize (an invalid-input result) and burns no number. `createTestTenant` inserts a clinic for that reason.
- The snapshot is versioned (`v: 1`); its field limits are never lower than the write-side limits (`PAD_LIMITS`), pinned by a guard test.
- Drafts and prescriptions finalized before this ADR print from live data (`loadRxDocument` ignores a draft's stored snapshot; an old finalized row uses its finalizer's current profile) and the pad says so. An amendment gets its own snapshot at its own finalize. The prescription page shows the patient name from the snapshot for finalized versions (with the current name when it changed); the allergy banner stays live as a safety prompt. The draft page warns a prescriber whose profile lacks a name or registration number, or who has no doctor profile; finalize does not block on it.

**Consequences:** Reprints are stable and need no extra trigger. New printed fields must be added to the snapshot schema (bump `v`). Clinic and profile edits apply only to prescriptions finalized afterwards, which the settings pages say. `buildRenderSnapshot` relies on RLS, so it must run inside `withTenant` and never on the admin connection (the demo seed's prescriptions print from live data).

**Revisit trigger:** a regulator requires reprints to show current demographics, a clinic must never print without a registration number (add a finalize precondition), or Template Studio needs fields the snapshot lacks.

---

## ADR-0033 — Print and PDF outputs are logged and audited, not cached

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** The data model sketched `printed_at`, `shared_at`, and `rendered_pdf_url` on `prescriptions`, but finalized rows cannot be updated and there is no object storage yet.

**Decision:** Every browser print and PDF download appends a `prescription_outputs` row (tenant, prescription, actor, kind, template, paper size, page count, PDF size, SHA-256 of the exact HTML) and an audit event with ids and counts only (`prescription.printed`, `prescription.pdf_downloaded`). The runtime role can insert and read the table, never update or delete it; migration 0015 also installs immutability triggers on the admin connection (unless the tenant is being erased), a SHA-256 shape check and a template-key check. A trigger accepts outputs only for `finalized` and `amended` prescriptions (an exact allow-list, `23000` otherwise) and refuses a prescription not visible in the row's tenant (`23503`); the key to `prescriptions` is the composite `(tenant_id, prescription_id)`.

- Viewing a non-draft document without printing (`purpose=preview`) writes no output row but IS audited as `prescription.previewed` (ids only); the print counter on the page counts only print and PDF outputs. A draft preview writes neither an output row nor an audit event (a draft is a working copy, not a record). Each output row records the `renderer_version` that drew it (ADR-0032).
- `HEAD` is refused with 405. The document route (preview AND print) and the PDF route serve a request whose `Sec-Fetch-Site` header is absent, `same-origin`, or `none` (an address-bar or bookmark navigation) and answer 403 to `cross-site` and `same-site`, so another site cannot trigger an audited view or a logged print. The header is advisory (a non-browser client can omit or forge it); the session cookie and role check remain the real access control.
- A failed log write answers 500 and serves nothing; a document that fails `checkSelfContained()` answers 500. PDF file names drop lone surrogates and bidi/format characters, `pdfFileName` requires the status (a draft never carries an Rx number), and PDF responses carry `nosniff` and no-store headers.
- PDFs are regenerated on demand from the frozen inputs; the HTML of every reprint is byte-identical (same hash), PDF bytes differ only in Chromium metadata. A print is logged when its HTML is served to the print frame, whether or not the dialog is confirmed.
- The PDF concurrency limiter is per process (Retry-After on 503 busy); the print frame is removed on `afterprint`, after 60 s, on a new print, or on unmount.

**Consequences:** No stored PHI-bearing files and no retention job; one Gotenberg call per download. Plan 1D's sharing log extends the same table.

**Revisit trigger:** Gotenberg load or latency, WhatsApp/email sharing that needs a stored file, a multi-instance deployment (shared limiter), or Phase 2 storage (cache keyed by `html_sha256`).

---

## ADR-0034 — One self-contained HTML renderer for print and PDF, and a hardened PDF engine

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** ADR-0007 chose Gotenberg's Chromium route for HTML to PDF. The same pad must also print from the browser, render Devanagari identically everywhere, and never let user text or Gotenberg reach the network.

**Decision:** `src/lib/rx-render/` is a pure TypeScript renderer that builds HTML only through the `html` tagged template (auto-escaping; it throws when a value lands in an unsafe position such as a tag or attribute name, an unquoted attribute, or inside a quoted attribute as raw markup). Built-in templates (General, Paediatric, Derma) are data drawn by one renderer; `TemplateRef.kind` is the seam for Phase 2. Documents embed Noto Sans Devanagari (`@fontsource/noto-sans-devanagari`, pinned) and images as `data:` URIs, carry a `default-src 'none'` CSP, and must pass `checkSelfContained()` before they are served or sent. That checker is a deny-by-default parser: every `<` must start a well-formed tag, CSS comments (`/*`) are refused, `url()` accepts only base64 PNG/JPEG images and WOFF2 fonts, `image-set`, `src()`, `@import` and similar are refused in style blocks and attributes, and the document is capped at 4 MB (linear-time scanners). A repeating outer table header (patient strip) and footer give a header on every page without JavaScript; the signature stays with the last section (`.closing`); "Page X of Y" comes from Gotenberg's footer template (sized to the full page width so the Rx number and page number sit at opposite edges).

The engine (`src/server/pdf/`) sits behind an injectable `PdfEngine` that never throws: a 4 MB HTML cap (character and UTF-8 byte length), a streaming PDF byte cap, a page cap, a content-type and `%PDF-` check, render and health timeouts, and a typed failure with a safe message. Gotenberg runs from a digest-pinned image bound to `127.0.0.1:3001` with JavaScript disabled, a Chromium deny-list (only the staged `file:///tmp/`, `data:`, `about:`, `blob:`), `--webhook-disable`, `--api-disable-download-from`, LibreOffice and PDF-engine routes disabled, `cap_drop: ALL`, `no-new-privileges`, and memory and process limits (`docker-compose.yml`; the CI workflow runs the same flags). `tests/integration/gotenberg-smoke.test.ts` proves with a beacon that a page without the CSP cannot reach the network, has a positive-control container without the deny-list, and a config-drift test comparing the running container with the flags; in CI or with `GOTENBERG_REQUIRED=1` a missing Gotenberg or docker fails instead of skipping. `GOTENBERG_URL` is mandatory in production (`resolveGotenbergUrl`), and production must also block the container's network egress. Print uses a hidden iframe and works when Gotenberg is down. Viewing, previewing, printing, and downloading use `rx.read`; `/prescriptions/:path*` is in the middleware matcher.

**Consequences:** Identical output in Gotenberg and browsers apart from page numbers; about 185 KB of font CSS per document; unit tests run without Gotenberg. Pad labels are English, Hindi, or bilingual (`labels.ts`; a native speaker must review the Hindi). The checker's round-2 version was never run against live-browser exploit payloads in the build session (a safety check stopped that review); defense in depth (CSP, JavaScript off, deny-list, the HTML re-checked at serve time) is the mitigation. The legacy `/preview` page remains only for the desktop shell.

**Revisit trigger:** Phase 2 Template Studio, a second script family (Gujarati, Tamil, ...), or a Gotenberg major upgrade (re-run `npm run test:visual` and review the PDFs).

---

## ADR-0035 — Clinic images live in Postgres as immutable assets

- **Status:** accepted
- **Date:** 2026-11-17

**Context:** The pad needs a clinic logo and a doctor signature. There is no object storage yet, uploads are hostile (AGENTS.md invariant 8), and a reprint must keep the signature it was finalized with.

**Decision:** `clinic_assets` stores PNG or JPEG bytes (`bytea`, at most 512 KB, 16 to 2000 px per side, type detected from the bytes, nothing after the true end marker; a JPEG is walked segment by segment), de-duplicated by SHA-256 per tenant and kind (computed server-side). Each clinic is capped at 20 logos and 50 signatures (checked in the upload transaction without a lock, so two simultaneous uploads can overshoot by one). The runtime role can insert and read but never update or delete; admin-level immutability triggers apply unless the tenant is erased. `clinics.logo_asset_id` and `doctors.signature_asset_id` point at the current asset through composite same-tenant keys (`NO ACTION`), and snapshots record the asset ids. `loadImageAssets` returns a map keyed by kind and id, so an id of one kind cannot be passed off as the other, and writes check tenant and kind. A custom Drizzle `bytea` type converts to and from `Buffer` (without it real PNGs failed with `22021`). Two actions join the role matrix: `settings.clinic` (owner) for the clinic pad and logo, `settings.profile` (owner, doctor) for one's own profile and signature. Settings text is validated with the shared cleaning helpers (a NUL is refused) and the clinic name is required.

**Metadata:** `stripImageMetadata` (`src/lib/domain/image.ts`, pure) runs at upload before anything is stored or hashed: a JPEG loses APP1 to APP15 (EXIF/GPS, XMP, ICC), COM, and JFXX thumbnails, keeping a plain JFIF APP0 and the Adobe APP14 colour transform; a PNG keeps only IHDR, PLTE, tRNS, IDAT, IEND and the colour or density chunks (gAMA, cHRM, sRGB, iCCP, sBIT, pHYs), dropping text, EXIF and time chunks. Pixel data is copied as is (no re-encoding). The result is inspected again, the stored bytes and the SHA-256 are those of the stripped image, and de-duplication uses the stripped hash. Assets stored before this change (dev data only; no clinic used the app) may still carry metadata. There is still no malware scan.

**Consequences:** Data stays in the India-region database; old prescriptions keep their images; the table grows by a few hundred KB per change.

**Revisit trigger:** Phase 2 storage and upload pipeline (ClamAV, re-encoding), or asset volume above a few GB.

---

## ADR-0036 — Consent before sharing is an append-only log; withdrawal and archive stop every link

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** DPDP-style consent needs purpose, version, timestamp, who captured it, and revocation (PRODUCT_SPEC §6.2, AGENTS.md invariant 5). WhatsApp and email providers are third parties even when the recipient is the patient.

**Decision:** `patient_consents` is an append-only event log (purpose `sharing`, version such as `sharing-v1`, `granted`, method `verbal | written`, `captured_by` not null, `created_at` set by `clock_timestamp()` in a trigger); the latest event per patient and purpose is the current state, and withdrawal inserts `granted = false`. The runtime role can only insert and read; admin-level immutability applies (0022). Consent is required before every share. The consent text and its Hindi translation live in `src/lib/domain/consent.ts` under the version key (`CONSENT_VERSIONS`, typed `CONSENT_TEXT`); rewording means a new key. The card posts the version it shows and the service records it only if it is a known version. Recording and withdrawing need `consent.capture` (owner, doctor, reception) and lock the patient row `FOR UPDATE`; withdrawal and archiving revoke every open link of the patient in the same transaction (`revoke_reason` `consent_withdrawn` / `patient_archived`). A link row must cite the patient's current granted consent: trigger `share_links_target` (0023) requires the prescription finalized, a consent of the same tenant, purpose `sharing`, `granted`, belonging to the prescription's patient, with no later consent event for that patient.

**Locking note (0023, ADR-0037):** creating a link takes a `KEY SHARE` lock on the cited consent row, the prescription and the patient through the composite foreign keys, and `createShareLinkIn` locks the patient row `FOR SHARE`. Consent writers lock the patient row `FOR UPDATE`, so a link insert waits for an in-flight record/withdraw/archive and a link can never survive a concurrent withdrawal. The target trigger reads consent without locking; that is safe because consent rows are append-only and the patient row lock serialises the writers. No sharing path locks a prescription row. Audit events (`patient.consent_recorded`, `patient.consent_withdrawn`) carry ids, purpose, version, method and counts only.

**Consequences:** Full consent history as evidence; one extra row per change. The English text needs legal review and the Hindi text a native speaker before any clinic turns sharing on (sharing is off per clinic until then, ADR-0038).

**Revisit trigger:** ABDM consent artefacts (Phase 5), marketing consent, or a regulator's required wording.

---

## ADR-0037 — Share links: hashed, short-lived, revocable, count-limited, opened through a two-step public route

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** A patient must open their prescription from a WhatsApp or email message without an account, while link previews, mail scanners, guessing, and a forwarded message must not expose it, and every opening must be audited.

**Decision:** A link is 32 random bytes (base64url, 43 characters); only its SHA-256 is stored (`share_links.token_hash`, unique). It points at one `finalized` prescription of its own tenant (trigger `share_links_target`), lives 7 days, opens at most 10 times, and can be withdrawn; the runtime role may only add one to `open_count` and revoke once (trigger `share_links_rules`), never delete; an insert trigger pins `open_count = 0`, no revocation fields and `created_at = now()`. `/s/<token>` is the only route without a session: GET answers an interstitial page with no patient, clinic or clinical data and a POST button, so previews and scanners never count an open or render anything; POST renders the frozen pad through the existing renderer, a separate public limiter (concurrency 1, small queue, one in-flight render per link) and `PdfEngine`, then, in one transaction that re-checks every condition (link state, sharing switch, patient not archived, current granted consent, abort signal), counts the open, writes a `prescription_outputs` row (kind `shared_pdf`, no actor, `share_link_id`) and audits `prescription.share_opened` (actor null). A malformed, unknown, expired, used-up, withdrawn or switched-off link, and a cross-site POST, all get the identical 404; a failed render answers 503 and burns nothing; a double tap answers its own 503 ("already opening", `Retry-After`). Every response is `no-store`, `noindex`, `no-referrer`, `nosniff`; HTML responses carry a `default-src 'none'` CSP and the PDF carries `frame-ancestors 'none'` plus `X-Frame-Options: DENY`. A link is refused at creation unless the prescription's `renderSnapshot` was frozen at finalize (`snapshotSource = "finalize"`); the open-time check stays as a backstop.

**Token policy (override 8):** the token lookup runs through `withShareToken`, which sets `app.share_token_hash` with a transaction-local `set_config`, and one RLS policy, `share_link_by_token` (SELECT, `clinicpad_app`), written exactly as in migration 0022:

```sql
create policy share_link_by_token on share_links for select to clinicpad_app
  using (token_hash = nullif(current_setting('app.share_token_hash', true), ''));
```

It is the single allow-listed exception in `tests/integration/rls-guard.test.ts` (the guard compares the full expression). Everything after the lookup runs in `withTenant`; never `adminDb`.

**POST origin rule:** when `Sec-Fetch-Site` is present it alone decides (`same-origin` and `none` pass). Only when it is absent: `Origin: null` or no Origin passes, and a named Origin must equal the host of `NEXT_PUBLIC_APP_URL` (else the `Host` header). Refusals are logged without the token.

**Superseded versions:** a link to a version that was later amended keeps opening for its 7 days and shows the SUPERSEDED marker; only the current version can be shared. This is a human decision (below).

**Rate limits:** 10 active links per prescription and 60 links per user per hour (database counts; two simultaneous shares can overshoot by one); on the public route 20 requests per client address per minute and 30 per minute per token hash, both in memory and **per process**. The client address comes only from the header named by `SHARE_CLIENT_IP_HEADER`, or on Vercel (`VERCEL` set) from `X-Vercel-Forwarded-For`; `X-Real-IP` is read only when `SHARE_CLIENT_IP_HEADER` names it, and a client-supplied `X-Forwarded-For` is never read. IPv6 addresses are grouped by /64. With no trusted header all callers share one bucket ("unknown") per process, and production logs once. The in-flight guard per link is also per process. The PDF limiter drops a queued render whose request was aborted (a client abort is logged as `aborted`).

**Caller contract:** `createShareLinkIn` re-checks archived patient, sharing switch, current granted consent, finalized status and snapshot, and checks the clinic switch and the current consent itself; it relies on its caller only for the **role permission** (`rx.share`). The sharing service (`src/server/services/sharing.ts`) checks it, and nothing else may call `createShareLinkIn`. The public resolve and open functions take only the token and are public by design.

**Known behaviours and human checks:**
- Link scanners and previewers that follow the form with a POST (not only GET) spend an open. GET never counts. The cap of 10 is the limit on that damage.
- Older Android WebView downloaders (WhatsApp's in-app browser) may save the interstitial instead of the PDF, and some send neither `Origin` nor `Sec-Fetch-Site` (accepted). Check Android Chrome and the WhatsApp in-app browser by hand before ticking the sharing exit criteria.
- Email click and open tracking is a Resend domain setting and must be off (ADR-0038); a tracking redirect would hand the token to the provider.
- The token is in the URL **path**, so request logs (host, proxy, CDN, analytics) must not retain full URLs of `/s/*`; configure them before any pilot.

**Consequences:** No PHI in URLs, previews or logs; the patient taps once more. The in-memory limits are per process: production must add an edge rate limit. Opens are counted only for completed renders.

**Revisit trigger:** a stored PDF (Phase 2 storage), the WhatsApp Cloud API sending documents directly, or a patient portal with accounts.

---

## ADR-0038 — Sending: a wa.me link the clinic sends itself, email through a provider, sharing off per clinic

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** ADR-0010 chose the WhatsApp Cloud API behind an abstraction, but it needs Meta business verification, approved templates and credentials that do not exist yet; Phase 1 needs sharing now.

**Decision:** WhatsApp sharing builds `https://wa.me/<international digits>?text=<message>` (`waMeLink`); the message names the clinic, the Rx number, the link and its expiry, never the patient or clinical text. The browser opens it from a real anchor click in a new tab (popup blockers), which works on phones and desktop. Phone input goes through `whatsAppRecipient`: Indian numbers may be typed nationally and must be mobiles (6–9), other countries need `+` and the code, and anything ambiguous is refused with what to type (it never suggests digits: a `+` followed by ten digits starting 6–9 with no country code set apart asks for the full number with its country code, `+65 8123 4567` is accepted, and an 11-digit number with a leading 0 and a landline area-code shape, `080 2345 6789`, `0755 123 4567`, is refused instead of being turned into a +91 mobile). The Share panel shows the full number and the patient's name before "Open WhatsApp"; the log keeps only the masked form. Email sends the same expiring link (no attachment) through `EmailProvider`; `getEmailProvider()` builds the Resend adapter only when `RESEND_API_KEY` and a valid `EMAIL_FROM` exist, otherwise email is hidden. The request body carries no tracking fields; **click and open tracking are a Resend domain setting and must stay off** (tracking would rewrite the link and leak the token to the provider's redirect). An email is logged before it is sent: the first transaction creates the link and inserts a `prepared` row with the masked recipient, the provider is then called outside any database transaction, and a second transaction inserts the outcome (`sent` or `failed`; the log is insert-only, so there are two rows per attempt) and a failed send withdraws its link (`send_failed`). If that second transaction fails after a real send the email is still reported as sent and the `prepared` row stays. `prescription_shares` is the append-only share log (channel, masked recipient, provider, status `prepared | sent | failed`, provider id, error code); the mask always has a `*` and no run of five digits (`maskEmail` replaces digits and cuts to 64 characters, and the mask is checked before anything is sent), and full numbers and addresses are never stored. At most 5 emails per prescription per 24 hours, counted as distinct links in the log (prepared rows count, so a failed or unlogged send cannot be retried without limit; no lock, so two simultaneous sends can overshoot by one). `clinics.sharing_enabled` (default false) is the owner's switch, enforced in the service; off makes every link of the clinic answer 404 at once. Roles: `rx.share` = owner, doctor, reception. Tests use a fake provider and never touch the network.

**Human decisions attached (not made):** the email provider's data residency and legal basis for cross-border processing (Resend is not in India; the email carries the clinic name, Rx number and link, no clinical text); the Resend account and sender-domain DNS.

**Consequences:** No message leaves ClinicPad's servers for WhatsApp; delivery status is unknown ("prepared"). The Cloud API (or a BSP) can replace the `wa_link` provider behind `shareByWhatsApp` without changing links, consent or the log.

**Revisit trigger:** Meta verification complete (Cloud API), BSP choice (open decision #2), delivery reconciliation (Phase 3).

---

## ADR-0039 — Patient CSV import: stateless dry-run and commit, Excel repairs, explicit duplicate decisions, idempotent rows

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** Clinics arrive with patient lists from Excel and other software (ROADMAP 1.1, PRODUCT_SPEC §6.2). Files come in odd encodings and formats, contain duplicates and family phones, and get uploaded twice.

**Decision:** The browser keeps the file; the server re-parses it for the dry-run and for the commit, which refuses a file whose SHA-256 changed and a mapping that differs from the dry-run's (the token binds both). Caps: about 900 KB per file (Next's 1 MB server-action body limit), 5,000 rows, 40 columns, 2,000 characters per mapped cell (echoed cells are cut shorter in the report). UTF-8 (BOM stripped) and UTF-16 with a BOM are read; workbooks, BOM-less UTF-16, binary data and non-UTF-8 text are refused with what to do. The delimiter (`,` `;` tab) comes from the header line; row numbers are spreadsheet rows. Headers map to fields by aliases and the owner can change every choice. Rows pass Excel repairs (day-first dates, Excel serials, `'` and `.0` removed; two-digit years, month/day/year, a bare year and scientific-notation phones refused; a NUL refuses the row; an age column is reported, never turned into a birth date) and then the patient form's own schema and the clinic-day DOB rule.

A duplicate is a normalized phone matching an active patient or an earlier row, **or** a normalized name equal to an existing patient's name with equal-or-empty DOB (so a re-import with a corrected mapping cannot duplicate, also for rows without a phone). A duplicate is skipped unless the owner chooses "register as new" or "add missing details" (fill-only, never overwrite). Each match records its basis: the phone matches (with the same name or a different one), or the name only. "Add missing details" is offered for exactly one match whose DOB and gender agree or one side is empty **and** whose phone matches too, or whose patient has no phone while both birth dates are recorded and equal. "Register as new" is not offered for an exact repeat inside the file or for any row with a match by name only. **Rows that match only by name are therefore skip-only, and the report shows the basis of each match; that is a human decision to revisit** (two patients with the same name and different phones, twins and namesakes are skipped until the owner registers them by hand from the patient form). The dry-run returns a per-row match fingerprint (sorted matched ids and the row it duplicates). The commit request carries only the rows the owner moved off the default (skip), each as `c<row>.<8 hex of the fingerprint>` or `f<row>...` (at most 15 characters per row, under 80 KB for 5,000 rows), plus a bitmap of the rows that were duplicates at check time; a row without a choice is skipped whatever it matches now (so a file of 5,000 duplicates commits), and a choice is honoured only if its fingerprint is unchanged, otherwise the row is skipped with a stale-row reason. Each imported patient stores `import_row_key` (SHA-256 of name key, phone, DOB; partial unique index), so a re-run imports nothing twice. The commit runs in one transaction under `pg_advisory_xact_lock` per tenant, allocates patient numbers as one block (`allocateNumbers`), and writes `patient_imports` (append-only job row, security in 0020), `patient.created` per patient with the import id, `patient.updated` per fill with field names, and `patient_import.committed`. The problem-row download is built in the browser by `serializeCsv`, which neutralises formula cells. Import is owner-only (`patient.import`), reached from a button on `/patients`. `sample_data/patients_template.csv` documents the shape (`.gitattributes` marks it `-text`); the existing `sample_data` catalogue lists stay loaded by `npm run db:seed:catalogue`.

**Consequences:** No PHI staging table; the file travels twice. Dates are always read day-first. Imported rows carry an import id for later clean-up.

**Revisit trigger:** `.xlsx` upload, files above 1 MB (would need a route handler instead of a server action), a full merge tool, or importing prescriptions.

---

## ADR-0040 — Database hardening of Plan 1D

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** ADR-0023 listed gaps (an INSERT of an already-finalized row; the `finalized -> amended` flip without a successor), statuses and clinical values were checked only by Zod, CHECKs lived only in SQL, three foreign-key columns had no index, `tenant_medicines.created_by` had no key, the runtime role could delete counters, and no test covered RLS across the whole schema.

**Decision:** 0017: rows of `prescriptions` and `visits` are born as drafts (BEFORE INSERT, `23000`); the flip to `amended` requires a finalized child of the same tenant that is not the row itself, and `draft -> amended` is refused (also through `INSERT ... ON CONFLICT DO UPDATE`); `parent_prescription_id` may not equal `id`; closed status vocabularies; `tenant_counters` DELETE/TRUNCATE revoked. 0018: periodicity, quarter-step dose (0–99) and duration (1–365) CHECKs on items and favourites; indexes on `visits(tenant_id, doctor_id)`, `visits(tenant_id, branch_id)`, `prescriptions(tenant_id, template_version_id)`, `prescriptions(tenant_id, parent_prescription_id)`; `tenant_medicines (tenant_id, created_by) -> memberships (tenant_id, user_id) ON DELETE SET NULL (created_by)`. 0019 to 0023 add the import and sharing tables with their security, triggers and indexes on every new composite key (`patients(tenant_id, import_id)`, `prescription_outputs(tenant_id, share_link_id)`). New CHECKs are added `NOT VALID` and validated in the same migration when every row passes, so a development database with leftovers still migrates (`npm run db:sweep-test-tenants` removes old test tenants: only local databases, only tenants whose members all use `@example.com`, older than an hour, never `demo-clinic`). Every CHECK is also declared in the Drizzle schema, and `tests/integration/schema-checks.test.ts` fails when the two lists differ; policies, grants and triggers stay in SQL, and `tests/integration/rls-guard.test.ts` requires forced RLS and an `app.tenant_id`-scoped policy (every non-null `qual` and `with_check`) on every table with a `tenant_id`, with one allow-listed exception (ADR-0037). The composite-key guard accepts parents `(tenant_id, id)` and `(tenant_id, user_id)` only. The demo seed inserts drafts and finalizes them by UPDATE; `createTestTenant` gives its user an owner membership; the e2e `seedPatients` reserves numbers through the counter.

**Consequences:** ADR-0023's "INSERT of an already-finalized row" and "no successor check" limitations are closed. A constraint can remain NOT VALID on a dirty development database until it is swept; new writes are checked either way.

**Revisit trigger:** a managed database that restricts triggers, or partitioning by tenant.

---

## ADR-0041 — Clinic-timezone dates, patient history and archive, and Plan 1D localisation choices

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** DOB validation and on-screen ages used the UTC day, so a baby born today could not be registered between 00:00 and 05:30 IST. The patient page listed prescriptions unfiltered, and archive had no UI or way back. Three localisation items were open: Hindi labels for option codes, "Page x of y" in Hindi, and a temperature unit.

**Decision:** Calendar days are the clinic's (`clinicLocalDate`, `src/lib/domain/clinic-date.ts`): the Zod DOB bound is the latest date on Earth (UTC+14) and the services apply the clinic's day (the DOB input has no `max`); patient ages on screen and history date filters use the clinic's zone (an unknown zone falls back to Asia/Kolkata, never UTC). `listPatientPrescriptions` filters by clinic-local date range on `coalesce(finalized_at, created_at)`, the visit's doctor, status and diagnosis or complaint text (escaped `ILIKE`), 20 per page with a total order; malformed URL filters are ignored. Rows are labelled `Rx #N vV` and offer Open, Print, Download PDF and, for the current version, Repeat. Archive (owner, inline confirm) hides a patient from search and new prescriptions, keeps every record, revokes its share links, and is undone from "Show archived" (audit `patient.archived` with `revokedLinks`, `patient.unarchived`). Hindi labels for food relation and periodicity codes have one source (`FOOD_RELATION_LABELS_HI`, `PERIODICITY_LABELS_HI` in `rx-options.ts`, reusing the legacy strings); printed output is unchanged. "Page x of y" stays English with Western digits in every label language (the Gotenberg footer cannot rely on the embedded Devanagari font; Western digits are normal on Indian pads). The temperature unit stays °F until Phase 3 nurse vitals: a unit setting changes the frozen snapshot (`v` bump), the autosave payload, the renderer and the golden files.

**Consequences:** Dates agree between the form, the list, the pad and the filters. A native speaker still has to review all Hindi strings (pad labels, option labels, consent text, share pages).

**Revisit trigger:** a clinic outside India, a UI language switch, or Phase 3 vitals.

---

## ADR-0042 — Next.js 15.5.29 and a vendored React patch (facebook/react#36134), applied on postinstall

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** Under `next start`, saving the pad or uploading a logo sometimes stayed on "Saving…" / "Uploading…" until a reload (5 of 12 runs of `pad-settings.spec.ts`). The server action had completed. Cause: the React build that Next 15.5.x bundles (`next/dist/compiled/react-dom`) drops a ping that arrives synchronously during the render while the exit status is "suspended with delay", so the transition lane is marked suspended and never retried. A `revalidatePath` action response that streams in over several packets triggers it (any same-page RSC refresh can: import, sharing, consent, `router.refresh()`). The upstream fix is facebook/react#36134 (merged 2026-03-24); no Next 15.x release contains it. Detail: `.superpowers/sdd/2026-11-17-phase-1d-sharing-import-hardening/debug-pad-settings-report.md`.

**Decision:** Upgrade `next` and `eslint-config-next` from 15.5.2 to 15.5.29 (exact pins; the latest 15.5.x; 15.5.2 also predated the December 2025 RSC security fixes). The bundled React in 15.5.29 still has the bug, so `scripts/patch-react-ping.mjs` runs on `postinstall` and applies the upstream change to the vendored `react-dom` and `react-dom-experimental` client, profiling and testing builds (10 files): in the render-phase branch it records `workInProgressRootPingedLanes |= pingedLanes`. It is idempotent (marker comment) and warns on code it does not recognise. `tests/unit/vendored-react-ping.test.ts` runs the real scheduler against the vendored React and fails when the bug is present, which is what a Next upgrade or a missing patch would cause.

**Risk:** an install with `--ignore-scripts` (`npm ci --ignore-scripts`, a host that disables lifecycle scripts, some Docker builds) ships the bug again, silently for users; the unit test catches it in CI only if CI installs with scripts. `npm install next@...` does not re-patch until `postinstall` runs (run `node scripts/patch-react-ping.mjs` by hand). Deployment must install with scripts enabled, or run the script before `next build`. We patch third-party vendored code, which needs the owner's sign-off.

**Build guard:** `prebuild`, `prebuild:web` and `prebuild:desktop` run `node scripts/patch-react-ping.mjs --check`, which patches if needed and exits non-zero when a bundled file is neither patched nor recognised (or no React DOM bundle is found), so `next build` fails loudly after an install with `--ignore-scripts` or a Next upgrade that changed the code. `postinstall` still never fails the install.

**Removal condition:** a Next release that contains react#36134 (the fix is in React 19.2+ builds after 2026-03-24; Next 16.3 canaries carry it). Then delete the script, the `postinstall` entry and the test, and drop the AGENTS.md note.

**Consequences:** `pad-settings` 24 of 24 under `next start` (12 of 12 on 15.5.29). `npm audit` still reports 25 vulnerabilities in other packages (follow-up, not addressed here).

**Revisit trigger:** any Next upgrade (the script warns on unknown code), or React's release of the fix in a stable Next.

## ADR-0043 — Phase 2 order: overlay pads first (Template Studio), DOCX after pilot evidence; the template model

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** Phase 2 must let a doctor print on their own pad within ten minutes. Many target doctors have a printed pad, a photo or a printer's PDF rather than a Word file, and DOCX brings the largest new attack surface (zip, XML, LibreOffice) and cannot print in the browser or offline. A custom pad is clinic data that a signed prescription depends on, and a letterhead can carry one doctor's name and registration number.

**Decision:** Sub-plan 2A ships overlay pads (a background image plus field boxes and one flow region) on the existing self-contained HTML pipeline. DOCX (2B) starts only after pilot evidence on the formats doctors bring and Gate 1; docxtemplater core (MIT) only, never paid modules. Spikes S1, S2, S4 and S5 gated 2A; S3 is input for 2B (use `{{#x}}..{{/x}}` loops, pre-check the zip).

Template model (migrations 0024 to 0028): `templates` (kind `overlay`; status `active | archived`; `current_version_id`) and `template_versions` (born as drafts by trigger; a draft is a working copy under `draft_revision`; a published version is frozen on every connection; rollback publishes a copy as the next number). **Binding is per VERSION, not per template** (migration 0025): `identity` (`dynamic | bound`), `bound_doctor_id` and `bound_confirmed` live on the version, are set at publish and are frozen with it; `resolveTemplateIn` reads them from the current version. Rollback copies the source version's binding and runs the same conflict checks as publish (a bound pad that is the clinic default is refused; one assigned to another doctor is refused). Assignment columns `clinics.custom_template_id` and `doctors.template_id` (composite keys, NO ACTION). At finalize the signer's own pad wins, then the clinic default, then the built-in pad; a bound pad is used only for its doctor. Publishing asks the letterhead question with no preselected answer and checks the spec's preconditions. A pad may omit clinical sections but never silently: publish computes the omitted sections (`src/lib/rx-render/omitted.ts`), the owner must acknowledge exactly that list (`acknowledgedOmitted`, enforced on the server, names recorded in the audit event), and a prescription whose record has content in a section its pinned pad does not print shows a warning on the prescription page and the print panel. Roles: `template.read` and `template.write` (owner, doctor for pads bound to them, designer), `template.publish` (owner), `template.assign` (owner; a doctor for their own profile). Lock order: the template-quota advisory lock, then the template row, then clinic or doctor rows; finalize takes no template lock.

**Consequences:** Word users print through "Save as PDF" in Word. The exit criterion "DOCX pad with overflow and a repeated header" waits for 2B. Binding is strict by default while human decision Q6 is open; turning it off means publishing every pad as dynamic. The letterhead question (strict default; an explicit server-side confirmation for `dynamic`, where the publisher answers "this letterhead shows no doctor") is recorded as pending human sign-off. `templates.kind` is not frozen once a version is published (forward note for 2B).

**Revisit trigger:** pilot evidence that most partners bring editable Word pads, branch-level pads, a designer invite flow (2C), or a decision against binding.

---

## ADR-0044 — Snapshot v2 and the frozen v1 overlay definition: reprint what was signed

- **Status:** accepted (extends ADR-0032)
- **Date:** 2026-11-18

**Context:** ADR-0032 froze print data but left presentation free. A custom pad is the clinic's own artifact, so a reprint must use exactly the pad that was signed.

**Decision:** `render_snapshot` stays `v: 1` for built-in pads (identical shape, no migration of old rows) and is `v: 2` only for overlay pads: `layout.template` is `{ kind: "overlay", templateVersionId, contentSha256 }` (built-ins are `{ kind: "builtin", key }`), with paper and labels from the version. **The v1 overlay definition schema and its geometry rules are frozen**: reprint parses a stored definition with the frozen v1 parser and does NOT re-run the publish-time geometry rules (a later rule change must never make a signed pad unprintable). `contentSha256` is the SHA-256 of the canonical JSON of the definition AS STORED (services store the parser's output: lengths rounded to 0.1 mm, unknown keys dropped), plus paper, labels and the stored file's hash; the hash of the minimal definition is pinned as a literal in a unit test, so any parser change that alters a stored definition fails a test. Finalize writes `prescriptions.template_version_id` in the same UPDATE (CHECKs tie a set column to the snapshot; a trigger refuses an unpublished version) and fails closed, without using an Rx number, when the pad is damaged or fails the geometry check. Every print, download, share open and preview reloads the version and file inside `withTenant`, re-hashes bytes and definition, and refuses to print on any mismatch (`TEMPLATE_DAMAGED_MESSAGE`). Amendments resolve their own pad (the amend column rule is `reset`). Output rows record `template_version_id`, `engine` and the renderer version per kind (`1`, `overlay-1`).

**The renderer itself is NOT frozen**: `overlay-1` shares section, medicine, style, mark and label code with the built-in renderer, so a change there changes old reprints. What is frozen is the data (snapshot, definition, image bytes), not Chromium, fonts or CSS. Only the renderer version string is recorded per output.

**Consequences:** A stored as-issued PDF (open decision Q16) would be the stronger proof and needs object storage. Tracked, not done: a database check that the snapshot's hash, paper and labels equal the version's (needs a migration), and an engine version column on output rows.

**Revisit trigger:** DOCX pads (2B adds the `docx` reference), as-issued PDF storage, or a renderer change that must be pinned per version.

---

## ADR-0045 — Hostile-upload pipeline: bytes decide, scan before store, quotas, files in Postgres behind a storage seam

- **Status:** accepted (supersedes the "no malware scan" note of ADR-0035)
- **Date:** 2026-11-18

**Context:** Uploads are hostile (invariant 8). Server actions are capped at 1 MB; LibreOffice and server-side PDF parsing are not needed for overlays. There is no object storage.

**Decision:** `POST /templates/uploads` (a route handler excluded from the middleware matcher, which would buffer bodies up to 10 MB; it checks its own session, `template.write`, `Sec-Fetch-Site`, 30 uploads per user per hour, and a streamed 2 MB cap). The bytes decide the type (PNG or JPEG only, nothing after the end marker, upright, at most 64 JPEG scans, long side 1,100 to 3,600 px, A-series proportions within the tolerance in `BACKGROUND_LIMITS`). The **background cap is 1 MB** (lowered from 2 MB after S1: a 2 MB background plus logo and signature would not fit the 4 MiB self-contained document limit; the migration CHECK mirrors it; the client recompresses). Logo and signature keep their 512 KB caps, and a pad may use one box for each. ClamAV `clamd` scans over INSTREAM before any transaction (one shared 15 s deadline for VERSION and INSTREAM; down, slow or confused means refused, fail closed; infected is audited with the signature name). Both the original bytes and the metadata-stripped bytes are scanned; the stripped bytes are what is hashed and stored; the original bytes and the file name are never stored or logged. Logo and signature uploads are scanned the same way, and non-image refusals are audited (`upload.rejected`). `CLAMAV_HOST`/`CLAMAV_PORT` are mandatory in production; the development bypass needs `NODE_ENV=development`, `CLAMAV_DISABLED_FOR_DEVELOPMENT=1` AND `CLAMAV_DISABLED_ACK=unscanned-uploads-on-this-machine`, otherwise the flag makes every upload fail.

Scanner container (S4, `docs/spikes/2026-11-18-s4-clamav.md`): `clamav/clamav:1.4.6@sha256:4cc4350d3fded380caf1799e76c0d1c93f3fa40af99c0cb2862ec0c9b117718a`, memory limit 2500 MB (a signature reload peaks at 1.99 to 2.17 GB), all capabilities dropped except CHOWN, SETUID, SETGID, DAC_OVERRIDE and FOWNER, `no-new-privileges`, read-only root, tmpfs `/tmp`, `/run`, `/var/log/clamav`, `CLAMAV_NO_FRESHCLAMD=true` (it never calls out; signatures are baked into the image). Signatures are refreshed by a separate `clamav-update` container (compose profile `update`), the only one that needs egress. StreamMaxLength is 100 MB. A drift check in `clamav-smoke.test.ts` pins the options.

`template_files` (bytea, forced RLS, composite keys, CHECKs mirroring the upload limits and the hash, immutable by trigger; `storage = 'pg'` is the seam and `loadTemplateFileIn()` the only reader). Per tenant, under one advisory lock: 20 active pads, 100 versions (every rollback adds one; published versions can never be deleted), 50 MB of files. Files no version uses are deleted at the next upload once they are 30 days old; the database refuses deleting a file in use (foreign key) or younger than a day (trigger). A 23503 on `template_versions_file_fk` after a file was deduped away is reported as "upload the image again". The EICAR test string is never committed (decoded from base64 in `tests/helpers/eicar.ts`).

**Scope by decision:** uploads of logos, signatures and pad backgrounds are scanned (original and stripped bytes); CSV patient import is NOT scanned (text parsed and validated, never stored as a file).

**Consequences:** About 2.5 GB of memory for clamd. Open ops items: hosting on AWS ap-south-1 in a private subnet with no egress, with `clamav-update` as the only egress (a developer machine cannot block egress because Docker does not publish ports of internal networks); schedule `clamav-update` a few times a day and alarm on signature age; run the container once on a Linux host. Licences: ClamAV is GPL-2.0 and is used over a socket as a separate service (fine for SaaS); it needs legal review before it is bundled into the desktop installer. Template bytes add a few MB per clinic to the database and backups. Tracked, not done: a race between garbage collection and a dedupe reuse of a file, and `lockTemplate` loading every version.

**Revisit trigger:** DOCX intake (2B), patient documents (2C), template bytes above 5 GB, or a ClamAV advisory.

---

## ADR-0046 — PDF intake runs only in a sandboxed browser frame

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** Doctors bring PDFs (a printer's artwork, a scan, Word's "Save as PDF"). Parsing PDFs on the server is a large attack surface; the browser already ships a PDF engine.

**Decision:** A PDF never reaches the server. pdf.js (`pdfjs-dist@6.5.438`, exact pin, Apache-2.0; integrity in `docs/spikes/2026-11-18-s2-pdfjs-frame.md`; 6.2.108 is an equal fallback) runs inside `<iframe sandbox="allow-scripts">` (no `allow-same-origin`, so an opaque origin) served by `/pdf-frame/*`. The frame is a public, cookieless route with an allow-list of files (the wasm, standard-font and ICC files are served from `/pdf-frame/`; `useWasm:false` was rejected because JBIG2 and JPEG 2000 scans then render blank), a CSP that allows scripts only from that path plus `wasm-unsafe-eval`, `connect-src` limited to `/pdf-frame/`, `worker-src 'none'` (a fake in-frame worker works in Chromium, Firefox and WebKit), no eval (`isEvalSupported:false`), `enableScripting:false` and a bare `getDocument`. The parent accepts only well-formed messages from that frame's window with origin `"null"`, accepts `ready` once, posts a transferred COPY of the bytes, fails fast if `ready` does not arrive in about 5 s, and times out. The frame replies with a JPEG page (not PNG) sized to fit the 1 MB background cap; the server then scans and strips it like any image upload (ADR-0045). Size, page count and DPI limits live in `PDF_INTAKE_LIMITS` (a test ties the frame constants to the image limits). The frame's CSP and origin checks are built from `NEXT_PUBLIC_APP_URL`; the route answers 503 in production without it. **Single-origin limitation:** a clinic that reaches the app on both `www.` and the apex domain sees the frame blocked on the other host; serve one canonical origin and redirect. `PDF_INTAKE=off|0|false` is the kill switch (the route answers 404, the wizard hides PDF); photo and image upload stay available.

Advisory GHSA-hq66-cqwq-w95j (CVE-2026-16633, high; XSS through `enableScripting` in the hosting origin, pdfjs-dist 5.6.83 up to but not including 6.2.108) is not exploitable here (scripting off, eval off, strict CSP, opaque origin), but `npm audit` would flag 5.x forever, hence 6.5.438. In 6.x `PDFDocumentProxy` has no `destroy()`; the loading task is destroyed instead. `pdfjs-dist` needs Node 22.13 or newer and lists `@napi-rs/canvas` as an optional dependency ClinicPad does not use. App code never imports `pdfjs-dist` (tests may, in Node). `src/app/pdf-frame` is in the desktop build's `SERVER_ONLY` stash list. The WebKit cookie observation in S2 was judged WebKit not enforcing SameSite (a control run without the sandbox is identical), not a sandbox leak.

**Consequences:** Intake needs a browser with canvas; photos are downscaled to 3,600 px before drawing (older iOS has a canvas size limit). Encrypted PDFs, real scanner JBIG2 (arithmetic and symbol modes) and real Word output are human-pending.

**Revisit trigger:** a pdf.js advisory (run `npm run test:pdf-frame` after any upgrade), DOCX intake (2B), or server-side conversion.

---

## ADR-0047 — Overlay pads in the self-contained HTML pipeline; Gotenberg 8.40.0; print mechanics (S1); print modes and the printer offset

- **Status:** accepted (extends ADR-0034); the printer-offset question is an OPEN HUMAN DECISION
- **Date:** 2026-11-18

**Context:** Overlay pads should keep every Plan 1C guarantee: self-contained documents, browser print without Gotenberg where the browser can do it, the same text as built-in pads.

**Decision:** `renderOverlay` (pure) draws the background and every-page boxes `position:fixed` and first-page boxes absolute, and runs the body inside a table whose `thead` and `tfoot` spacers repeat on every page, using the built-in section and medicine renderers; CSS lengths come only from numbers of a parsed definition. Three targets: `screen`, `print` (printer offset; no background on pre-printed stationery) and `pdf` (background always, no offset).

S1 mechanics (`docs/spikes/2026-11-18-s1-overlay-print.md`): (a) Chromium repeats a table header only while it is under about a quarter of the page it has, so each spacer is at most 24 % of the EFFECTIVE page (paper minus the page-number band minus the worst-case printer offset); publish refuses larger gaps and the renderer clamps (it never throws for a stored version); (b) page numbers are off by default; a 5 to 12 mm blank band puts "Page x of y" and the Rx number in a footer strip that Gotenberg's footer fills (`@page` margin boxes do not render in Gotenberg); (c) Chromium browsers print overlay pads from HTML; Firefox and Safari print the Gotenberg PDF made for paper until a human confirms them (`OVERLAY_BROWSER_PRINT = { chromium: true, firefox: false, webkit: false, other: false }`, a visible and tested default), so **"Print still works without Gotenberg" is false for overlay pads on Firefox and Safari**; (d) with Gotenberg 8.40.0 the background image is written about once per PDF (8.11 wrote it per page), so the size guard estimates background plus logo plus signature plus a small allowance and refuses a download above the 15 MiB cap with a friendly "use Print" message (the advice differs for someone already printing through the PDF: tracked minor); (e) tell people to print PDFs at 100 % ("Actual size"); the overlay screenshot tolerance is `maxDiffPixelRatio` 0.001, provisional until human decision Q9.

Gotenberg is pinned to `gotenberg/gotenberg:8.40.0@sha256:53073e798c8ef39ea2187e44cb67bab77894ea2509100b94c4fe3b461f7b2996` (Chromium 156), one pin across `docker-compose.yml`, `ci.yml` and the smoke test (`engine-pins.test.ts`), with the visual suite and the real PDFs re-reviewed. For 2B only: `--libreoffice-allow-list`, `--libreoffice-deny-list`, `--libreoffice-deny-private-ips` and `--libreoffice-deny-public-ips`.

**Printer offset (OPEN HUMAN DECISION; decide before the first real clinic publishes a non-zero offset).** The offset (a shift in mm for pre-printed stationery) sits in the definition, so it is part of the frozen content hash. Costs: recalibrating needs an owner publish and uses version quota; there is one offset per version, not per printer; an old prescription reprinted after a printer change still uses the old offset. The better long-term model is a per-clinic (or per-printer) print-time adjustment recorded on each output row, outside the hash. Acceptable for the pilot ONLY while offsets stay zero. Related: the alignment test page prints from HTML while Firefox and Safari print from the PDF, so calibration differs by browser (human check).

**Consequences:** Body tables use ClinicPad's styling, not the doctor's own table design; phone photos print as photographed. Open design observations for a human decision: the follow-up and signature block can spill alone onto a last page; on A5 the bilingual age and gender text can wrap in a narrow box (an A5 bilingual split default is recommended); consider printing the Rx number and "Page x of y" whenever the output spans pages; the screen preview shows the footer band mid-page once content passes page 1 (print and PDF are correct).

**Revisit trigger:** the S1 human check on Firefox, Safari and iOS, Chromium `@page` margin boxes for browser page numbers, the offset decision, or DOCX (2B).

---

## ADR-0048 — The designer role, its provisioning, and test-only tooling licences

- **Status:** accepted
- **Date:** 2026-11-18

**Context:** An outside designer may build a clinic's pad but must never read patients or prescriptions. A designer account that never expires is a standing risk.

**Decision:** Role `designer` (migration 0028) holds only `template.read` and `template.write`: no patient, prescription, billing or sharing permission, and sample previews show a placeholder doctor ("Dr. Sample Doctor / SAMPLE-0000") and no Rx number, never a real person. Its membership MUST expire: `memberships.expires_at`, a CHECK that a designer has one (compared as `role::text`, because a new enum value cannot be used in the migration that adds it), a CHECK that expiry follows creation, and `getActiveMembership` and the sign-in callback refuse an expired membership on every request. The e2e helper sets seven days. **(Superseded by ADR-0052 for provisioning: the owner invite flow exists since Plan 2C slice 1.) Originally: there is no designer invite UI until 2C and no code creates designer memberships: today an operator provisions them by raw SQL. That is not acceptable beyond the pilot; an audited provisioning script with a mandatory expiry (and an audit event) is required before any clinic hires a designer.** The cross-tenant sweep (56 tests plus a completeness guard) found no leak.

Tooling licences: pdf.js (Apache-2.0) and docxtemplater core (MIT, 2B) are fine. PyMuPDF (AGPL-3.0) is a TEST-ONLY dependency (`overlay-spacer-pdf.test.ts` reads real Gotenberg PDFs; `pymupdf==1.28.0` pinned in CI; never installed on a server or bundled; the test FAILS when it is required but missing). ClamAV is GPL-2.0 over a socket (ADR-0045).

**Consequences:** A designer cannot see a real patient preview (that needs `rx.read` and is audited as `template.previewed_with_patient`).

**Revisit trigger:** the designer invite flow (2C), or any need for a designer to see clinical data.

---

## ADR-0052 — Owner-invited designer accounts (concierge tooling)

- **Status:** accepted
- **Date:** 2026-11-23

**Context:** ADR-0048 required an audited, expiring way to give a setup person access instead of raw SQL. Sign-in resolves the OLDEST active membership of a user, so an existing account that belongs to another clinic can never reach a second one, and replacing such an account's password would be an account takeover. A set-password email flow needs a public token route, a token table and a mail path (larger, and not needed for a concierge pilot).

**Decision:** The clinic owner (`designer.manage`, owner only) creates a dedicated designer account at `/settings/designers` (`src/server/auth/designers.ts`, admin connection with every query scoped by the session tenant and `role = 'designer'`).
- A new email gets a user with a random one-time password (20 characters from a CSPRNG, bcrypt hash stored, plaintext shown ONCE in a hand-over note, never audited, logged or stored). Nothing is emailed.
- An email that already has an account is refused, except a former designer whose only memberships are designer memberships of THIS clinic (re-invite: new password, reactivated, `created_at` restarted). Platform admins and accounts with no or other memberships are refused. The refusal message says only that the email cannot be used.
- Expiry is mandatory: whole days 1 to 30, default 7. Extend sets expiry to now + days (only later); revoke sets the membership `disabled` and takes effect on the next request. At most 5 unexpired designers per clinic (also when extending an expired one) and 10 invites or re-invites per clinic per 24 hours.
- Audit events `designer.invited`, `designer.extended`, `designer.revoked` in the same transaction (ids, dates, `reinvited`, `passwordRotated`; never an email, password or hash). One advisory lock per clinic serialises designer operations.
- Sessions: Auth.js renews `iat`, so the token carries its own `signedInAt`. `getActiveMembership` ignores an expiring membership whose `created_at` is later than the session start (plus 2 s), so a re-invite cuts off every earlier session; a token without the claim fails closed for designers. Permanent members are unaffected.
- A designer stays templates-only (role matrix unchanged: `template.read`, `template.write`).

**Consequences:** No forced password change exists, so the owner must pass the note over a private channel; the membership expiry bounds the exposure. Because accounts are per clinic, concierge staff need a distinct email per clinic. User rows of revoked or expired designers are kept (audit references) and block that email from sign-up; a cleanup job is not built. An owner learns whether an email is registered (sign-up already reveals this). Replaces the raw-SQL provisioning in ADR-0048. The checklist and SLA timestamps of spec section 10.4 are NOT built.

**Revisit trigger:** a set-password link flow, MFA, designers who serve several clinics (needs a clinic switcher), or abuse of the invite form (per-IP limits).

---

## ADR-0053 — Specialty gallery of built-in pads

- **Status:** accepted
- **Date:** 2026-11-23

**Context:** Spec 15.3 task 1: five to seven more built-in specialty pads. The clinical form is fixed, so a pad can differ only by emphasis.

**Decision:** Six pads, code only: `ortho`, `ent`, `gynae`, `dental`, `physio`, `ayush` (Ayurveda and homeopathy), defined in `src/lib/rx-render/templates.ts` and drawn by the existing renderer. Each differs by section order, vital order and compactness, medicine layout (slots, pattern or topical) and accent colour, and prints EVERY section and every vital (no silent omission; a completeness test runs for all pads). `PAD_TEMPLATES` (nine keys) is what clinics may choose and snapshots may record; `BUILTIN_TEMPLATES` (the original three) is unchanged because the frozen overlay v1 schema uses it for `flow.bodyStyle` (ADR-0044), so an overlay pad cannot use a gallery body style. Snapshot stays `v: 1` (the key enum widens additively: old snapshots parse as before). Migration 0029 widens `clinics_rx_template_check` and `rx_outputs_template_key_check` (NOT VALID, then VALIDATE).

**Consequences:** The definitions are layout opinions that no clinician has reviewed: they need a design-partner look per specialty before they are marketed as specialty pads. Older app versions cannot read a snapshot that names a gallery key (rollback after a clinic picked one needs the key list kept).

**Revisit trigger:** specialty-specific clinical fields (they need Plan 1B form work first), or user-defined gallery packs.

---

---

## 19. Open decisions

| # | Question | Options | Owner | Needed by |
|---|---|---|---|---|
| 1 | ~~Auth provider~~ | Decided: Auth.js v5 credentials (ADR-0008, ADR-0019) | founder | done |
| 2 | WhatsApp: direct vs BSP | Meta Cloud API / BSP | founder | Phase 1 |
| 3 | First two specialty template packs | General + Paeds / Derma / Ortho | product | Phase 1 |
| 4 | Desktop packaging | Tauri v2 / Electron | founder | Phase 4 |
| 5 | Billing build vs partner | Build / partner with billing tool | founder | Phase 3 |
| 6 | International region | EU (Frankfurt) / US (Virginia) first | founder | Phase 5 |
| 7 | Free tier DOCX | Locked preview / watermarked print | product | Gate A |
| 8 | Reseller margin | 20% / 35% | founder | Phase 5 |
