# ClinicPad — Architecture Decision Records

**Last updated:** 2026-11-16
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

**Decision:** Drafts have no number (`rx_no` is null). `finalizePrescription` allocates the next per-tenant number inside the finalize transaction, after every check has passed, through `allocateNumber` (`src/server/services/numbering.ts`): an insert-or-increment upsert on the `tenant_counters` row `(tenant_id, 'rx')`, which takes a row lock so concurrent finalizes queue and receive distinct, consecutive numbers. An amendment keeps its parent's `rx_no` and increases `version`; only a prescription with no parent allocates a number. A finalize that fails, conflicts or rolls back burns no number (tested in `tests/integration/prescriptions-lifecycle.test.ts` and `tests/integration/numbering-audit.test.ts`). Patient numbers use the same counter table under the name `patient`.

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

**Decision:** Relations between tenant-owned tables use composite keys `(tenant_id, x_id) -> parent(tenant_id, id)`. The parent gets `UNIQUE (tenant_id, id)`. Constraint names are explicit and under 63 characters. Migration 0007 converted `prescription_items -> prescriptions`, `prescriptions -> visits`, `prescriptions.parent_prescription_id` and `visits -> patients`; migration 0009 covers the remaining Phase 0 relations (written by a parallel task; confirm against `drizzle/` at final verification). Nullable parents use the `ON DELETE SET NULL (column)` form so the tenant column is not nulled. A guard test in `tests/integration/tenant-fk.test.ts` fails if a single-column key into a tenant-owned table appears. **Pattern for every new tenant-owned table:** unique `(tenant_id, id)` on the parent, foreign key on `(tenant_id, x_id)` in the child. Services still resolve every input id through `withTenant` first.

**Consequences:** Cross-tenant references are impossible even through the admin connection. Migrations need the unique constraint created before the foreign key that references it (drizzle-kit emits them in the wrong order and needs a hand edit).

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
