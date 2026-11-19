# ClinicPad — Roadmap

**Version:** 0.1
**Date:** 2026-11-06
**Status:** active
**Owner:** founder / product
**Companion docs:** `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `GTM_PRICING.md`, `PROGRESS.md`, `DECISIONS.md`

---

## 1. How to read this roadmap

This is a **sequence of sellable states**, not a feature backlog. Each phase ends with a gate: a demonstrable product, a measurable outcome, and an explicit go/no-go decision. If a gate fails, we fix the phase instead of starting the next one.

**Assumptions**

- Team: 1 full-time founder-engineer plus part-time design/support. With 2 full-time engineers, compress durations by ~35%. With 3+, split workstreams but keep the gate order.
- Working weeks, no heroics. Estimates include a 20% buffer.
- India-first. International work is deliberately deferred to Phase 5.
- Dates below are targets for a start on **2026-11-09**. Re-baseline at each gate.

**Phase status legend:** `not started` · `in progress` · `blocked` · `done`

| Phase | Outcome | Duration | Target window | Status |
|---|---|---|---|---|
| 0 | Foundation: strict build, auth, tenancy, app shell | 3 weeks | 2026-11-09 → 2026-11-27 | not started |
| 1 | Prescription MVP on built-in templates | 4 weeks | 2026-11-30 → 2026-12-25 | not started |
| 2 | Template Studio + document tools (the wedge) | 4 weeks | 2026-12-28 → 2027-01-22 | not started |
| 3 | Clinic operations: queue, billing, WhatsApp, analytics | 6 weeks | 2027-01-25 → 2027-03-05 | not started |
| 4 | Offline-first web + desktop app | 6 weeks | 2027-03-08 → 2027-04-16 | not started |
| 5 | Compliance, international, reseller growth | 8 weeks | 2027-04-19 → 2027-06-11 | not started |
| 6 | AI assist, marketplace, ecosystem | ongoing | 2027-06 onward | not started |

**Revenue gates (cumulative, India + international MRR)**

| Gate | When | Target | What it proves |
|---|---|---|---|
| A | End of Phase 2 | 10 paying clinics, ₹5k MRR | The BYOP wedge converts |
| B | End of Phase 3 | 50 paying clinics, ₹40k MRR | Full clinic ops retains |
| C | End of Phase 4 | 150 paying clinics, ₹1.5L MRR | Offline/desktop unlocks Tier 2/3 |
| D | End of Phase 5 | 400 paying clinics + 20 international, ₹5L MRR | Repeatable across segments/geos |
| E | Phase 6 | 1,000 paying clinics, ₹15L MRR | Category position / reseller leverage |

> These are planning targets, not promises. Pricing assumptions live in `GTM_PRICING.md`; validate with real invoices before using them in fundraising.

---

## 2. Phase 0 — Foundation

**Goal:** turn the copied prototype into a strict, multi-tenant, deployable skeleton. No clinical features are added in this phase except what is needed to prove the spine works.

**Why first:** the current app is a static export with no auth, no server database, and `ignoreBuildErrors: true`. Building features on that foundation compounds rework and creates patient-data risk.

### Workstreams

| # | Workstream | Deliverable | Est. |
|---|---|---|---|
| 0.1 | Repo hygiene | Remove `test.txt`, rebrand package/metadata, add `.env.example`, git init, CI | 1 day |
| 0.2 | Build split | Web build (server) vs desktop build (static/Tauri); `output: export` only for desktop; strict TS/ESLint | 2 days |
| 0.3 | Tooling | Vitest, Playwright, `typecheck`/`test`/`test:e2e` scripts, pre-commit hooks | 2 days |
| 0.4 | Database | Postgres (Docker locally, Supabase Mumbai for staging), Drizzle schema for core tables, migrations | 3 days |
| 0.5 | Tenancy + RLS | `tenant_id` on all business tables, RLS policies, tenant-scoped DB client, RLS tests | 3 days |
| 0.6 | Auth | Email/password + phone OTP (provider decision in ADR), sessions, MFA for owners | 3 days |
| 0.7 | Onboarding | Clinic creation, doctor profile, branch, invite staff, 5-step wizard | 4 days |
| 0.8 | App shell | Role-aware navigation, empty states, toasts, error boundaries, loading states | 3 days |
| 0.9 | Seed + demo | Seed a demo clinic with 3 doctors, 50 patients, 20 prescriptions | 1 day |
| 0.10 | Ops | Structured logs, error tracking, health check, backup/restore drill (staging) | 2 days |

### Exit criteria (all must pass)

- [ ] `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` pass with zero errors. `ignoreBuildErrors` is gone.
- [ ] Web app deploys to staging; desktop build still produces a working Tauri binary.
- [ ] A new user can sign up, create a clinic, add a doctor profile, and see the app shell in under 5 minutes.
- [ ] Tenant A cannot read or write Tenant B's rows — proven by an automated RLS test, not by inspection.
- [ ] All clinical/business tables have `tenant_id`; the tenant-scoped repository is the only DB access path.
- [ ] Audit log table exists and records at least one event per mutation type that exists today.
- [ ] Staging backup restores successfully into a fresh database.
- [ ] CI runs lint, typecheck, unit tests, and a Playwright smoke test on every PR.

### Explicit non-goals

- Template Studio, document conversion, billing, appointments, WhatsApp, offline sync.
- Importing real patient data.
- Marketing site beyond a placeholder.

**Gate 0 decision:** proceed to Phase 1 only when the checklist is green. If auth or RLS is unstable, stop and fix it — everything downstream depends on it.

---

## 3. Phase 1 — Prescription MVP

**Goal:** a doctor can register a patient, write a prescription on a **built-in** ClinicPad template, finalize it, print it, and share a PDF. This is the first end-to-end clinical loop.

**Sellable state:** "ClinicPad Lite" — usable by a design-partner clinic, not yet the BYOP wedge.

### Workstreams

| # | Workstream | Deliverable | Est. |
|---|---|---|---|
| 1.1 | Patients | CRUD, search (name/phone/ID), duplicate detection, timeline shell, CSV import with mapping | 5 days |
| 1.2 | Visit + prescription | Draft autosave, finalize, versioning, Rx numbering per clinic, clone/repeat | 6 days |
| 1.3 | Clinical form | Migrate `MedicalForm` to server-backed data; medicines, vitals, diagnosis, tests, advice, follow-up | 5 days |
| 1.4 | Medicines | Searchable catalogue, favourites, dose/timing presets, free-text fallback | 3 days |
| 1.5 | Template renderer | Extract hard-coded preview into a data-driven HTML template; 3 built-in templates (General, Paediatric, Derma) | 4 days |
| 1.6 | PDF + print | Server-side PDF via Gotenberg; A4/A5; print CSS; download and print dialog | 3 days |
| 1.7 | Sharing | WhatsApp share link + email PDF (manual recipient in this phase); delivery log stub | 3 days |
| 1.8 | Patient history | List of prescriptions per patient, filters, open/print/copy | 2 days |
| 1.9 | Audit | Append-only events for create/finalize/print/share/amend | 2 days |
| 1.10 | Pilot hardening | Error states, empty states, keyboard flow, Hindi/English strings | 3 days |

### Exit criteria

- [ ] A repeat patient prescription is finalized, printed, and shared in under 60 seconds (measured with 5 real users).
- [ ] A new patient can be registered in under 30 seconds by a receptionist.
- [ ] PDF output is visually consistent across Chrome, Safari, and the print dialog.
- [x] Finalized prescriptions are immutable; amendments create v2 with a reason and an audit event. (Automated evidence only; see docs/PROGRESS.md 4.11.)
- [ ] 5 design-partner clinics use it for at least 10 working days with no data-loss incident.
- [ ] Prescription render failure rate < 1%; p95 finalize < 800 ms online.
- [x] CSV import of the existing `sample_data/*.csv` shape works with a validation report. (Automated evidence; patients template and catalogue lists.)

**Status 2026-11-18:** code for every workstream 1.1 to 1.10 is complete and the automated gate passed. The five boxes left open need people or staging: the 60-second repeat and 30-second registration timings, the Safari print check (and Android Chrome / WhatsApp in-app browser check of shared links), the 5-clinic 10-day pilot, and render-failure and p95 metrics. The evidence table is in docs/PROGRESS.md section 4.11.

### Explicit non-goals

- DOCX upload, PDF↔Word conversion, overlay templates (Phase 2).
- Appointments, billing, analytics dashboards (Phase 3).
- Offline writes (Phase 4).
- ABDM (Phase 5).

**Gate 1 decision:** do design partners ask to use their own pad? If yes, Phase 2 is confirmed as the priority. If they only care about billing, revisit the wedge before building Template Studio.

---

## 4. Phase 2 — Template Studio + document tools (the wedge)

**Goal:** a doctor uploads their existing Word or PDF pad and gets an identical-looking prescription with real data in under 10 minutes. This is the demo that sells the product.

**Sellable state:** "ClinicPad — Bring Your Own Pad" at ₹499–₹599/month. This is the first paid launch.

**Status (2026-11-19):** 2A (overlay pads: photo, scan, image or PDF pad, field boxes and a flow region, versions, preview, publish, assign, frozen prints, ClamAV scanning, sandboxed PDF reading) is DONE IN CODE; its automated gate result and the pending human checks are in `docs/PROGRESS.md` section 4.12. 2B (DOCX templates, docxtemplater, DOCX to PDF, PDF to DOCX) and 2C (designer invites, patient documents, remaining gallery) are NOT STARTED. 2B starts only after pilot evidence that doctors bring Word pads, Gate 1, and staging with the conversion container egress-blocked.

### Workstreams

| # | Workstream | Deliverable | Est. |
|---|---|---|---|
| 2.1 | Upload pipeline | Signed uploads, type/size validation, ClamAV scan, macro stripping, retention | 4 days |
| 2.2 | DOCX parser | Detect placeholders, sections, tables, images; produce a template model | 4 days |
| 2.3 | Mapping UI | Two-column field mapper, auto-suggest, insert-field, validation errors | 6 days |
| 2.4 | Rendering | docxtemplater loops/conditionals/images; Gotenberg DOCX→PDF; font bundling | 5 days |
| 2.5 | Preview + publish | Sample/blank/real-patient preview, version history, rollback, assignment | 4 days |
| 2.6 | Built-in gallery | 8–10 specialty HTML templates, responsive print CSS, visual regression tests | 4 days |
| 2.7 | PDF→DOCX | `pdf2docx` for text PDFs; OCRmyPDF + Tesseract for scans; job queue + progress | 5 days |
| 2.8 | Overlay mode | Background PDF/image, drag field boxes, font controls, overflow handling | 5 days |
| 2.9 | Document tools | Merge, split, rotate, compress, watermark, page numbers; patient document store | 4 days |
| 2.10 | Concierge setup | Internal admin tool to digitise a pad for a customer; SLA + checklist | 2 days |

### Exit criteria

- [ ] Upload a 1-page DOCX pad with a medicines table; render 3 and 12 medicines correctly, including overflow to page 2 with repeated header.
- [ ] Upload a scanned PDF pad; create an overlay; print with real data.
- [ ] Hindi patient name renders correctly with bundled fonts; missing signature does not break layout.
- [ ] Page numbering is correct across 3 pages; A4 and A5 both pass.
- [ ] Visual diff against the source DOCX is within the agreed tolerance on the golden-template suite.
- [ ] 10 clinics complete setup; median time-to-first-real-prescription < 10 minutes self-serve.
- [ ] PDF→DOCX and DOCX→PDF jobs succeed > 97%; failures produce actionable errors and retries.
- [ ] No template or asset is readable across tenants (automated test).

### Explicit non-goals

- Public template marketplace (Phase 6).
- Arbitrary Photoshop/Figma import.
- Editing DOCX in-browser like Word.

**Gate A:** 10 paying clinics and ₹5k MRR within 30 days of launch. If conversion is below 5%, interview non-converters before Phase 3.

---

## 5. Phase 3 — Clinic operations

**Goal:** the clinic can run a full OPD day inside ClinicPad. The owner gets visibility. This is where the product becomes hard to remove.

### Workstreams

| # | Workstream | Deliverable | Est. |
|---|---|---|---|
| 3.1 | Appointments | Calendar, slots, walk-ins, recurring, statuses, doctor/branch filters | 6 days |
| 3.2 | Queue | Token numbers, reception view, "in consult"/"done", optional TV display | 3 days |
| 3.3 | Billing | Service catalogue, invoices, discounts, GST (CGST/SGST/IGST), round-off | 7 days |
| 3.4 | Payments | Cash/UPI/card recording, part payments, refunds, outstanding, receipts | 5 days |
| 3.5 | Online payments | Razorpay integration (UPI/cards), webhook reconciliation | 4 days |
| 3.6 | WhatsApp automation | Template messages for Rx ready, reminders, confirmations, invoices; opt-out; retries | 6 days |
| 3.7 | Dashboard | Today, 7/30/90-day trends, doctor/branch splits, top diagnoses/medicines, collections | 6 days |
| 3.8 | Staff + roles | Owner/Doctor/Reception/Nurse/Accountant permissions enforced server-side | 3 days |
| 3.9 | Day-end | Cash reconciliation, closing report, CSV/PDF export | 3 days |
| 3.10 | Retention loops | Recall lists, no-show tracking, follow-up reminders | 3 days |

### Exit criteria

- [ ] A pilot clinic runs 5 consecutive OPD days with no paper register.
- [ ] Owner can answer "how is my clinic doing this month?" in under 60 seconds.
- [ ] Today's collections reconcile to the rupee at day-end for 5 days.
- [ ] WhatsApp delivery success > 95% (excluding invalid numbers); every message has a status.
- [ ] Role tests prove Reception cannot view another doctor's financials or amend a prescription.
- [ ] GST invoice output reviewed by a CA for format and rounding.
- [ ] No-show rate and recall conversion are measurable per clinic.

**Gate B:** 50 paying clinics and ₹40k MRR; 90-day logo retention > 85% for the Phase 2 cohort.

---

## 6. Phase 4 — Offline-first web + desktop

**Goal:** the product keeps working through internet and power cuts, and ships as a Windows desktop app for clinics that want a local install.

### Workstreams

| # | Workstream | Deliverable | Est. |
|---|---|---|---|
| 4.1 | Local store | IndexedDB (web) / SQLite (desktop) schema mirroring the server model | 5 days |
| 4.2 | Outbox | Durable write queue, idempotency keys, retry with backoff, conflict policy | 6 days |
| 4.3 | Sync engine | Pull/push, cursor-based deltas, tombstones, per-entity merge rules | 8 days |
| 4.4 | Offline UX | Sync status, pending badges, conflict resolution UI, "last synced" | 4 days |
| 4.5 | Desktop shell | Tauri v2 packaging, SQLite, auto-update, code signing, installer | 6 days |
| 4.6 | Printing | Native print path, printer selection, A4/A5 presets, no `innerHTML` hacks | 3 days |
| 4.7 | Resilience | 24-hour offline drill, crash recovery, migration tests | 3 days |
| 4.8 | Support tooling | Diagnostic bundle, remote log pull (consented), version skew handling | 2 days |

### Exit criteria

- [ ] 24-hour offline drill: create patients, prescriptions, and payments offline; reconnect; zero data loss, zero duplicates.
- [ ] Two devices editing the same patient converge deterministically; conflicts are surfaced, never silently overwritten.
- [ ] Desktop installer works on a clean Windows 10/11 machine; auto-update succeeds from v1 to v2.
- [ ] Offline finalize p95 < 150 ms local; sync resumes automatically after reconnect.
- [ ] Power-loss test (kill process mid-write) does not corrupt the local database.
- [ ] Support can diagnose a sync failure from a redacted diagnostic bundle.

**Gate C:** 150 paying clinics and ₹1.5L MRR; desktop cohort retention > 90%.

---

## 7. Phase 5 — Compliance, international, reseller growth

**Goal:** sell credibly to larger clinics in India and to the first international customers, and turn partners into a distribution channel.

### Workstreams

| # | Workstream | Deliverable | Est. |
|---|---|---|---|
| 5.1 | DPDP hardening | Consent records, purpose limitation, breach playbook, DPA, retention jobs, deletion proofs | 5 days |
| 5.2 | ABDM | Sandbox integration, ABHA linking, consent artefacts, FHIR R4 mapping, certification path | 12 days |
| 5.3 | Security | External pen test, threat model review, dependency scanning, incident runbook | 5 days |
| 5.4 | International region | EU/US data region, region-aware routing, sub-processor list, SCCs/DPAs | 8 days |
| 5.5 | Localization | Currency, tax labels, date/number formats, RTL-ready layout, 3 launch languages | 5 days |
| 5.6 | Stripe | International subscriptions, tax handling, dunning, invoices | 4 days |
| 5.7 | White-label | Custom domain, logo/colors, reseller admin, sub-tenant billing, revenue share | 8 days |
| 5.8 | Partner program | Reseller kit, margins, certification, co-branded onboarding | 3 days |
| 5.9 | Reliability | SLOs, status page, on-call, quarterly restore drill, DR region | 4 days |

### Exit criteria

- [ ] DPDP consent and deletion flows verified by an external reviewer.
- [ ] ABDM sandbox flows work end-to-end; certification submitted (do not claim compliance before approval).
- [ ] Pen test: no critical/high findings open; mediums have owners and dates.
- [ ] First 20 international customers paying in USD/GBP/AED with local invoices.
- [ ] First 3 resellers live with at least 5 sub-tenants each.
- [ ] 99.9% monthly uptime for two consecutive months; restore drill passes.
- [ ] Data residency proven: India data never leaves the India region; international data never enters it.

**Gate D:** 400 paying clinics + 20 international; ₹5L MRR; CAC payback < 6 months.

---

## 8. Phase 6 — AI assist, marketplace, ecosystem

**Goal:** expand the moat without violating the "no AI diagnosis" rule.

**Candidates (prioritize by pull, not novelty):**

- Ambient scribe: consented recording → transcript → structured draft note/prescription, always clinician-reviewed.
- Handwritten prescription OCR → editable draft.
- Smart placeholder mapping and template repair suggestions.
- Template marketplace with moderation and revenue share.
- Public API, webhooks, and an integration directory (labs, pharmacies, calendars).
- Clinical decision support with a **licensed** drug database (interactions, allergies, dosing) — not generative guesses.
- Voice commands in Hindi/English/Hinglish.
- Multi-clinic chain analytics and benchmarking (opt-in, anonymized).

**Guardrails:** every AI output is labelled a draft, requires clinician sign-off, is logged, and is never presented as diagnosis or treatment advice. See `AGENTS.md` invariant 6.

**Gate E:** 1,000 paying clinics, ₹15L MRR, net revenue retention > 110%.

---

## 9. Cross-cutting workstreams (run continuously)

| Area | Ongoing commitment |
|---|---|
| Security | Dependency updates, secret scanning, quarterly access review, annual pen test |
| Privacy | Consent copy review, retention jobs, sub-processor register, DSAR workflow |
| Quality | Golden-template visual tests, RLS tests, sync tests, restore drills |
| Support | In-app help, WhatsApp support, knowledge base, onboarding checklist |
| Docs | Update `PROGRESS.md` at every milestone; ADRs for every irreversible choice |
| Analytics | Product events from day one (activation, prescription volume, share rate, churn) |
| Billing hygiene | Failed-payment dunning, GST invoices, refund policy, revenue reconciliation |

---

## 10. What we deliberately will not build before Gate C

- Hospital IPD/OT/ICU, insurance/TPA claims, payroll.
- A patient-facing marketplace or doctor discovery.
- Custom enterprise deployments, on-prem installs, or bespoke integrations.
- Native iOS/Android apps (PWA + desktop cover the beachhead).
- AI diagnosis, autonomous prescribing, or unlicensed clinical recommendations.
- Hardware (kiosks, TV displays, printers) — integrate only.

---

## 11. Risk-adjusted schedule notes

| Risk | Effect on plan | Mitigation |
|---|---|---|
| Auth/RLS rework | +2 weeks in Phase 0 | Build RLS tests first; do not skip tenant-scoped client |
| DOCX fidelity worse than expected | +2–3 weeks in Phase 2 | Overlay fallback; concierge setup; golden-template suite early |
| WhatsApp onboarding delays | +1–2 weeks in Phase 3 | Start Meta business verification in Phase 1; BSP fallback |
| Offline sync complexity | +3 weeks in Phase 4 | Restrict offline scope to patients/Rx/payments; conflict UI |
| ABDM certification | +1–3 months in Phase 5 | Start sandbox in Phase 3; never gate revenue on ABDM |
| Solo-founder bandwidth | Slips every phase | Hire contract help for design/QA; cut P2 features, not gates |

**Rule:** when behind, cut scope inside a phase, never skip a gate.

---

## 12. Phase exit review template

Copy this into `PROGRESS.md` at each gate:

```md
### Gate <N> review — <date>
- Demo: <link/recording>
- Metrics: <activation, usage, revenue, retention>
- Exit checklist: <x/y passed; list exceptions>
- Customer evidence: <interviews, quotes, tickets>
- Decision: proceed / fix / pivot
- Scope changes for next phase:
- Owners and dates:
```
