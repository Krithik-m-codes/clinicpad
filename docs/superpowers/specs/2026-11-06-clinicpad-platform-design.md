# ClinicPad Platform — Design Specification

**Date:** 2026-11-06
**Status:** draft for review
**Owner:** founder / product
**Implementation plan:** `docs/superpowers/plans/2026-11-06-phase-0-foundation.md`
**Related:** `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/ROADMAP.md`

---

## 1. Context

The repository started as a single-doctor prescription prototype: Next.js static export, client-only React state, IndexedDB persistence, one hard-coded A4 layout, and a Tauri shell. It has no authentication, no tenant boundary, no server database, and no safe path for patient data.

ClinicPad turns that prototype into a sellable, multi-tenant clinic operating system. The commercial wedge is **Bring Your Own Pad (BYOP)**: a doctor uploads their existing Word or PDF prescription pad, and ClinicPad renders it with live patient data in under ten minutes. Everything else — patients, appointments, billing, WhatsApp, analytics, offline — supports that wedge and the owner who pays for it.

This spec defines the platform design that the phase plans implement. It is intentionally narrower than the product spec: it covers the substrate (tenancy, auth, data, documents, sync, money) and leaves feature detail to `PRODUCT_SPEC.md`.

---

## 2. Goals

1. **Tenant-safe by construction.** No query can cross a clinic boundary without an explicit, audited admin path.
2. **Prescription fidelity.** A doctor's uploaded pad renders identically (within an agreed tolerance) with real data, including multi-page overflow.
3. **Offline durability.** A confirmed write survives a browser refresh, process crash, or power loss, and syncs without duplication.
4. **Owner visibility.** Every clinical action rolls up into collections, retention, and operational metrics.
5. **Sellable in India first.** INR pricing, GST invoices, UPI/Razorpay, WhatsApp sharing, DPDP-aware consent, Mumbai data residency.
6. **Portable.** A clinic can export its full record and leave; no data lock-in.

## 3. Non-goals (this platform spec)

- Hospital IPD/OT/ICU, insurance/TPA claims, payroll.
- AI diagnosis or autonomous prescribing.
- Native mobile apps (PWA + desktop cover the beachhead).
- A patient marketplace or doctor discovery.
- Custom enterprise deployments before Gate C.
- Claims of HIPAA/GDPR/ABDM compliance before certification.

---

## 4. Users and roles

| Role | Primary jobs | Default permissions |
|---|---|---|
| Owner | See money, manage staff, configure clinic | Everything in tenant, billing, audit, exports |
| Doctor | Write prescriptions, review history | Patients, visits, prescriptions, own schedule |
| Reception | Register patients, queue, collect payment | Patients, appointments, invoices; no clinical amend |
| Nurse | Vitals, queue status | Vitals, patient read, queue update |
| Accountant | Reconcile, GST, reports | Invoices, payments, reports; no clinical notes |
| Pharmacist (later) | Dispense against Rx | Prescription read, dispense log |
| Platform admin | Support, compliance | Cross-tenant, audited, break-glass only |

Permissions are enforced **server-side** on every mutation. UI hiding is convenience, not security.

---

## 5. System architecture

```
Web (Next.js server build) ──┐
Desktop (Tauri + SQLite) ────┼──> Server actions / route handlers ──> Postgres (RLS)
PWA (IndexedDB) ─────────────┘            │
                                          ├─ Object storage (templates, PDFs)
                                          ├─ Job queue (conversions, messages)
                                          ├─ Doc engine (Gotenberg/LibreOffice, pdf2docx, OCR)
                                          ├─ WhatsApp Cloud API
                                          ├─ Razorpay / Stripe
                                          └─ Email (Resend)
```

**Stack:** Next.js 15 App Router, React 19, TypeScript strict, Tailwind v4, shadcn/ui, Drizzle ORM, Postgres 16, Supabase Mumbai (MVP), Gotenberg + LibreOffice, docxtemplater, pdf2docx, OCRmyPDF/Tesseract, Tauri v2 + SQLite, Razorpay + Stripe, Meta WhatsApp Cloud API behind an adapter.

**Build targets:** web (server) and desktop (static export for Tauri) are separate builds. Shared code must not depend on `window` or Node-only APIs without an explicit boundary. See ADR-0012.

---

## 6. Tenancy and authorization

### 6.1 Model

```
tenants (clinic group)
  └── clinics (brand/legal entity)
        └── branches (location)
              ├── memberships (user ↔ tenant, role)
              ├── doctors
              ├── patients
              ├── appointments
              ├── visits → prescriptions → prescription_items
              ├── invoices → payments
              ├── templates → template_versions
              └── audit_events
```

Every business table carries `tenant_id NOT NULL`. Branch-scoped tables also carry `branch_id`. `tenant_id` is never accepted from the client; it is derived from the authenticated session and set on the transaction.

### 6.2 RLS

- RLS enabled on all tenant tables.
- Policy pattern: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.
- The app sets `app.tenant_id` inside a transaction via a tenant-scoped repository; no raw pool access from feature code.
- Admin/support access uses a separate role with `BYPASSRLS`, requires a reason, and writes an audit event.
- An automated test creates two tenants and asserts that every CRUD path is isolated.

### 6.3 Auth

Email/password + phone OTP for India, Google for international later. Owner MFA. Sessions are server-validated; the client never asserts identity. Provider choice is ADR-0008 (pending: Supabase Auth leaning).

---

## 7. Core domain model

Key entities and invariants:

| Entity | Key fields | Invariant |
|---|---|---|
| `tenants` | id, name, region, plan, trial_ends_at | Region immutable after first patient |
| `clinics` | tenant_id, name, address, timezone, currency, logo | Timezone/currency required |
| `branches` | clinic_id, name, address, timings | At least one per clinic |
| `memberships` | tenant_id, user_id, role, status | Unique (tenant, user) |
| `doctors` | tenant_id, user_id, reg_no, qualifications, signature | Reg. no. required to publish a template |
| `patients` | tenant_id, name, phone, dob/age, gender, abha | Phone or guardian phone required |
| `visits` | tenant_id, patient_id, doctor_id, branch_id, status | Finalized visits immutable |
| `prescriptions` | visit_id, rx_no, version, status, template_version_id | (tenant, rx_no, version) unique |
| `prescription_items` | prescription_id, drug, dose, timing, duration | Order preserved |
| `templates` | tenant_id, kind, status | Published version required to print |
| `template_versions` | template_id, version, file_key, mapping | Immutable once published |
| `invoices` | tenant_id, number, totals, tax | Totals computed server-side |
| `payments` | invoice_id, mode, amount, reference | Sum ≤ invoice total unless credit note |
| `audit_events` | tenant_id, actor, action, entity, before/after | Append-only |

Full DDL and indexes: `docs/DATA_MODEL.md`.

**Money:** integer paise + ISO currency. **Time:** UTC ISO strings, rendered in clinic timezone. **IDs:** UUIDv7; human numbers are per-tenant transactional sequences.

---

## 8. Template and document engine

### 8.1 Inputs

1. Built-in HTML/CSS templates (specialty packs).
2. Doctor's `.docx` with `{{placeholders}}`.
3. PDF → DOCX (text) or OCR → DOCX (scan).
4. Image/PDF overlay mode for pads that cannot be faithfully converted.

### 8.2 Placeholder contract

`{{clinic.name}}`, `{{doctor.reg_no}}`, `{{patient.name}}`, `{{visit.rx_no}}`, `{{#medicines}}...{{/medicines}}`, `{{#if patient.allergies}}...{{/if}}`, `{{pagebreak}}`. Unknown placeholders block publish. Missing optional values render blank, never `undefined`.

### 8.3 Pipeline

```
upload → validate (type/size/macro) → virus scan → store (private)
      → parse/map → render (docxtemplater/HTML) → PDF (Gotenberg)
      → store → preview/share/print
```

Operational rules: 25 MB max, reject `.docm`, no network in the conversion sandbox, async jobs with retries, deterministic LibreOffice/font versions, visual regression tests.

### 8.4 Fidelity acceptance

- 3 and 12 medicine rows render correctly, with overflow to a repeated-header continuation page.
- Hindi names render with bundled fonts.
- A4 and A5 pass; page numbering is correct across 3 pages.
- Visual diff against the source DOCX is within the agreed tolerance.
- Missing signature/stamp does not break layout.

---

## 9. Offline and sync

- Local store: IndexedDB (web/PWA), SQLite (desktop).
- Every mutation writes to a durable local outbox **before** the UI confirms.
- Each mutation carries a client-generated UUIDv7 and idempotency key; the server deduplicates.
- Sync pulls cursor-based deltas and pushes the outbox with exponential backoff.
- Conflict policy: clinical records are append-only/versioned; demographic edits are last-writer-wins with a visible conflict; money is server-reconciled and never silently merged.
- Offline scope for v1: patients, visits/prescriptions, payments. Templates and analytics require connectivity.
- A 24-hour offline drill is a release gate.

---

## 10. Money, messaging, and compliance

**Billing:** Razorpay subscriptions (India), Stripe (international later). Webhooks are idempotent and reconcile into local `subscriptions`/`invoices`. GST invoice fields: GSTIN, HSN/SAC, place of supply, CGST/SGST/IGST, round-off. Never trust client-computed totals.

**WhatsApp:** `MessagingProvider` interface (`sendTemplate`, `sendDocument`, `status`, `optOut`). Meta Cloud API first; BSP adapter allowed. Pass-through pricing, zero markup, delivery logs, opt-out enforcement.

**Privacy:** India data in `ap-south-1`; `region` on tenant from day one. Consent captured with purpose, version, timestamp, revocation. Retention: clinical 7 years (or statutory minimum), audit 7 years, documents per policy. Deletion is scheduled with legal-hold override. Export: full clinic + per-patient PDF/JSON.

**Security:** TLS everywhere, encryption at rest, field-level encryption for secrets/ABHA where required, least-privilege roles, audit log, rate limits, upload scanning, dependency scanning, annual pen test before international launch. No compliance claims before certification.

---

## 11. Non-functional requirements

| Area | Target |
|---|---|
| Prescription finalize (online) | p95 < 800 ms |
| Prescription finalize (local/offline) | p95 < 150 ms |
| PDF generation | p95 < 5 s |
| Patient search | p95 < 300 ms for 100k patients/tenant |
| App shell load (4G) | LCP < 2.5 s |
| Availability | 99.9% monthly after Phase 5 |
| Render failure rate | < 0.5% |
| Cross-tenant incidents | zero |
| Restore drill | quarterly, RPO ≤ 15 min, RTO ≤ 4 h |
| Accessibility | WCAG 2.1 AA for core flows |

---

## 12. Rollout

| Phase | Deliverable | Gate |
|---|---|---|
| 0 | Strict build, auth, tenancy, app shell, seed | Gate 0 checklist |
| 1 | Patients + prescriptions on built-in templates | 5 design partners, 10 days |
| 2 | Template Studio + document tools | Gate A: 10 paying, ₹5k MRR |
| 3 | Queue, billing, WhatsApp, analytics | Gate B: 50 paying, ₹40k MRR |
| 4 | Offline + desktop | Gate C: 150 paying, ₹1.5L MRR |
| 5 | DPDP/ABDM, international, white-label | Gate D: 400 + 20 intl, ₹5L MRR |
| 6 | AI assist, marketplace, API | Gate E: 1,000 paying, ₹15L MRR |

Detailed tasks, estimates, and exit criteria: `docs/ROADMAP.md`.

---

## 13. Acceptance (platform level)

- [ ] Two tenants cannot see each other's data through any app path (automated).
- [ ] A new clinic can onboard, upload a pad, and print a prescription in < 10 minutes.
- [ ] A finalized prescription is immutable; amendments are versioned and audited.
- [ ] A 24-hour offline drill loses no data and creates no duplicates.
- [ ] A PDF is delivered to WhatsApp with a delivery status.
- [ ] The owner can see today's collections and 30-day trends in < 60 seconds.
- [ ] A full clinic export and a per-patient export both succeed.
- [ ] No critical/high security findings at the Phase 5 pen test.
- [ ] All money is integer minor units; all totals reconcile at day-end.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| DOCX fidelity varies by file | Overlay fallback, concierge setup, golden-template suite |
| Offline sync corruption | Outbox + idempotency + drills + conflict UI |
| RLS misconfiguration | RLS tests in CI, tenant-scoped client only, admin path audited |
| WhatsApp onboarding delay | Start verification early, BSP fallback, SMS/email fallback |
| Support-heavy SMB market | Self-serve onboarding, partner tier, in-app help |
| ABDM certification slips | Start sandbox early, never gate revenue on it |
| Solo-founder bandwidth | Cut scope inside phases, never skip gates |

---

## 15. Open questions

1. Auth provider (ADR-0008).
2. WhatsApp direct vs BSP for first 100 clinics.
3. Desktop packaging: Tauri vs Electron.
4. Billing build vs partner.
5. First international region.
6. Free-tier DOCX behaviour.
7. Reseller margin and support ownership.

Track resolutions in `docs/DECISIONS.md`.
