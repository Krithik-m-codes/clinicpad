# ClinicPad — Product Specification

**Version:** 0.1 (working draft)
**Date:** 2026-11-06
**Status:** for review
**Owner:** founder / product

---

## 1. Vision

> Every doctor already has a prescription pad. ClinicPad makes it smart, then runs the clinic around it.

ClinicPad is a prescription-first clinic operating system for small and mid-sized outpatient practices. It preserves the doctor's own letterhead and workflow, works when the internet doesn't, and gives the clinic owner the business visibility that paper and generic EMRs cannot.

**10-year ambition:** become the default operating system for independent outpatient clinics in emerging markets — starting in India, expanding to the Gulf, Southeast Asia, Africa, and Latin America — with a white-label distribution layer that lets local partners sell it as their own.

---

## 2. Positioning

| Alternative | What it is | Why doctors stay | ClinicPad's answer |
|---|---|---|---|
| Paper pad | The default | Zero learning curve, own letterhead, always works | Same pad, digitised; offline; faster repeat prescriptions |
| Generic EMR (HealthPlix, Eka, Practo Ray) | Clinical note-taking + records | Habit, ABDM, brand | Bring your own pad; owner-grade ops; no forced layout |
| Cheap clinic suites (MedPrax, Medplix, MyClinicDesk) | Appointments + billing + Rx | Price | Better template fidelity, offline desktop, document tools, white-label |
| International PMSs (Cliniko, SimplePractice, DrChrono) | Full practice management | Compliance, breadth | 10–30× cheaper local pricing; WhatsApp-native; India compliance |

**One-line positioning:** *"The clinic app that uses your own prescription pad — and works when the internet doesn't."*

**Category:** prescription-first clinic OS / practice management.
**Wedge:** Template Studio (BYOP).
**Moat over time:** offline sync + template library + reseller network + longitudinal patient data.

---

## 3. Target users

### 3.1 Primary ICP — solo & small clinics in Tier 2/3 India

- 1–5 doctors, 1–3 locations.
- 20–150 patients/day.
- Currently uses paper pads, a register, WhatsApp, and maybe Excel.
- Has a receptionist or family member at the front desk.
- Price-sensitive: ₹500–₹2,000/month is acceptable if it saves time and looks professional.
- Internet is unreliable; power cuts happen; desktop/laptop is common; Android phone is universal.
- Speaks English + at least one Indian language.

**Specialties to start:** general medicine, paediatrics, dermatology, orthopaedics, ENT, gynaecology, dental, physiotherapy, homeopathy/Ayurveda.

### 3.2 Secondary ICP — polyclinics and small chains

- 5–20 doctors, 2–10 branches.
- Needs multi-doctor scheduling, role-based access, consolidated reporting, doctor-wise revenue, and branding consistency.
- Will pay ₹5,000–₹15,000/month if it reduces leakage and gives owner visibility.

### 3.3 Tertiary ICP — international solo/allied practices

- Gulf, Southeast Asia, UK, US.
- Wants an affordable, clean practice-management tool with local compliance.
- Enter after India product-market fit; requires HIPAA/GDPR work and local payment rails.

### 3.4 Buyer vs user

- **User:** doctor (wants speed, own pad, patient history).
- **Buyer:** clinic owner (wants revenue visibility, control, fewer errors).
- **Influencer:** receptionist (wants a queue that works), accountant (wants GST reports), local IT vendor (wants recurring revenue).

Design for the doctor's speed; sell to the owner's control.

---

## 4. Jobs to be done

| # | Job | Success looks like |
|---|---|---|
| 1 | Write a prescription while the patient is in the chair | < 60 seconds for a repeat patient; < 2 minutes for a new patient |
| 2 | Keep my letterhead and brand | Printed PDF is indistinguishable from the current pad |
| 3 | Find a patient's history instantly | Search by name/phone; full timeline in < 2 seconds |
| 4 | Share the prescription | WhatsApp PDF delivered before the patient leaves |
| 5 | Know today's collections | One dashboard; no end-of-day register math |
| 6 | Manage the queue | Token/walk-in status visible to reception and doctor |
| 7 | Reduce no-shows | Automated WhatsApp reminders |
| 8 | Stay compliant | ABHA linking, GST invoices, consent, audit trail |
| 9 | Keep working when the internet is down | Read/write locally; sync later; no data loss |
| 10 | Look professional | Branded prescriptions, invoices, and messages |

---

## 5. Product principles

1. **The pad is sacred.** Never force a layout. The doctor's design wins; the software adapts.
2. **Speed beats completeness.** The consultation screen must be usable with one hand and a keyboard.
3. **Offline is a feature, not an edge case.** Every write is durable locally before it is confirmed.
4. **Show the money.** Owners buy visibility. Every clinical action should roll up into a business metric.
5. **Earn trust with restraint.** No dark patterns, no message markup, no data lock-in, no AI diagnosis.
6. **One record, many surfaces.** Patient, visit, prescription, invoice, and message all hang off the same record.
7. **Localize deeply, not superficially.** Hindi + 6–10 Indian languages, Indian date/number/currency formats, Indian drug names.
8. **Ship the wedge first.** Template Studio is the demo. Everything else supports it.

---

## 6. Feature specification

Priorities: **P0 = sellable MVP**, **P1 = clinic OS**, **P2 = expansion/moat**.

### 6.1 Identity, tenancy, and onboarding (P0)

- Sign up with email or phone OTP; verify.
- Create clinic: name, type, address, timezone, currency, logo, letterhead, prescription footer.
- Add doctor profile: name, qualifications, registration number, specialties, languages, signature image, stamp, consultation fee.
- Invite staff by phone/email; roles: Owner, Doctor, Reception, Nurse, Pharmacist, Accountant.
- Multi-doctor and multi-branch from day one in the data model; UI can start simple.
- MFA for owners; session management; device list.
- Onboarding wizard: Clinic → Doctor → Pad (template) → First patient → First prescription.
- Subscription gate with 14-day trial; graceful read-only mode on expiry (never delete data).

**Acceptance:** a new doctor can sign up, create a clinic, upload a pad, and print a test prescription in under 10 minutes without support.

### 6.2 Patients (P0)

- Quick-add: name, phone, age or DOB, gender, address, ABHA (optional), tags, allergies, chronic conditions, notes.
- Search by name, phone, patient ID, ABHA; fuzzy matching; recent patients.
- Duplicate detection on phone + name; merge tool with audit trail.
- Patient timeline: visits, prescriptions, documents, invoices, payments, messages, consent.
- Import from CSV/Excel using the existing `sample_data/*.csv` shape; column mapping; validation report.
- Export a patient's full record (PDF + JSON) for portability.
- Consent capture with purpose, version, timestamp, and revocation.

**Acceptance:** reception can register a walk-in in under 30 seconds and find them by phone.

### 6.3 Prescription / visit (P0)

A visit is the unit of care. It contains:

- **Context:** patient, doctor, branch, date/time, visit type (new/follow-up/tele), chief complaint.
- **Vitals:** BP, pulse, temperature, SpO₂, weight, height, BMI, respiratory rate, blood sugar (extensible).
- **Clinical:** complaints (multi-select + free text), diagnosis (multi-select + ICD-10 search), medical history, drug history, allergies.
- **Medicines:** brand/generic, strength, form, route, dose, timing (morning/afternoon/evening/night), food relation, duration, SOS, periodicity, remarks, start date.
- **Investigations:** tests with instructions; lab order later.
- **Advice:** free text + reusable advice templates.
- **Follow-up:** date, reason.
- **Attachments:** lab reports, previous prescriptions, images.
- **Signature/stamp:** doctor profile or per-visit override.
- **Metadata:** Rx number (per clinic, sequential), version, status (draft/final/amended), printed/shared timestamps.

Capabilities:
- Save draft automatically; finalize explicitly.
- Clone previous prescription; "repeat last visit"; favourites/bundles ("cold kit", "diabetes follow-up").
- Multi-prescription history per patient; filter by date/doctor/diagnosis.
- Amend a finalized prescription by creating a new version with a reason; never overwrite.
- Print, save PDF, share WhatsApp/email, copy link.
- A4 and A5; multi-page with repeated header/footer; page numbering.
- QR code linking to a secure, expiring patient view (later).
- Works offline (Phase 4).

**Acceptance:** a repeat prescription can be finalized, printed, and WhatsApp-shared in under 60 seconds.

### 6.4 Template Studio — the wedge (P0/P1)

See §7 for the deep dive. Summary:

- Built-in gallery of responsive HTML templates by specialty.
- Upload `.docx` and map placeholders visually.
- Upload `.pdf`: convert to DOCX, or use as an overlay background for scanned pads.
- Detect placeholders, validate, preview with sample data, publish a version.
- Version history, rollback, and per-doctor/per-branch assignment.
- Asset library: logo, signature, stamp, watermark, letterhead.
- Page rules: size, margins, header/footer repetition, signature block, overflow behavior.
- "5-minute setup" wizard.

**Acceptance:** a doctor uploads their existing Word pad and prints an identical-looking prescription with real patient data in under 10 minutes.

### 6.5 Document tools (P1)

- PDF → Word and Word → PDF.
- Merge, split, rotate, compress, watermark, page numbers.
- OCR scanned documents (English + Hindi + major Indian scripts).
- E-signature (draw/upload) and signature placement.
- Clinic-branded templates for medical leave, fitness, referral, consent, receipts.
- Batch convert and store in the patient's documents.
- Virus scan + retention policy.

**Acceptance:** a clinic can convert a lab PDF to Word to edit it, or turn a scanned old pad into an editable template, without leaving the app.

### 6.6 Appointments and queue (P1)

- Day/week calendar per doctor and branch.
- Slots, walk-ins, overbooking rules, recurring appointments.
- Statuses: booked → arrived → in consult → done / no-show / cancelled.
- Token numbers and a queue view (reception + optional TV display).
- Public booking page (P1) and WhatsApp booking (P2).
- Reminders (WhatsApp/SMS) with confirmation and rescheduling.
- No-show tracking and recall lists.

**Acceptance:** the front desk can run a full OPD day without a paper register.

### 6.7 Billing and payments (P1)

- Service catalog: consultation, procedure, package, lab test, misc.
- Invoice with line items, discounts, taxes (CGST/SGST/IGST), HSN/SAC, round-off.
- Payment modes: cash, UPI, card, bank transfer, online (Razorpay/Stripe).
- Part payments, advances, refunds, outstanding balances.
- Receipts: print, PDF, WhatsApp.
- Day-end closing, cash reconciliation, doctor share/commission (P2).
- Expense tracking (P2).
- GST reports and export (P1).
- Financial audit trail.

**Acceptance:** the owner can see today's collections and outstanding dues without touching a spreadsheet.

### 6.8 Communications (P1)

- WhatsApp Cloud API behind a provider abstraction.
- Templates: prescription ready, appointment reminder, confirmation, invoice, follow-up, recall, birthday/health camp (marketing with opt-in).
- SMS fallback when WhatsApp fails.
- Email for documents and invoices.
- Delivery logs, retries, opt-out management.
- No per-message markup; pass-through Meta pricing with transparent credits.
- In-app notification center.

**Acceptance:** a prescription PDF reaches the patient's WhatsApp within 30 seconds of finalization, with a delivery status.

### 6.9 Dashboard and analytics (P1)

- Today: patients seen, appointments, revenue collected, pending payments, queue length.
- Trends: 7/30/90 days; new vs returning patients; doctor-wise and branch-wise.
- Clinical: top diagnoses, top medicines, follow-up adherence.
- Operational: no-show rate, average consult time, peak hours.
- Financial: collections, outstanding, discounts, refunds, GST summary.
- Export CSV/PDF; scheduled email digest (P2).

**Acceptance:** an owner can answer "how is my clinic doing this month?" in under 60 seconds.

### 6.10 Admin and trust (P0/P1)

- Clinic branding, letterhead, footer, prescription numbering.
- Users, roles, permissions, invites, deactivation.
- Audit log (who viewed/changed/printed/shared what).
- Backup and restore; data export (full clinic + per patient).
- Data deletion with legal-retention handling.
- Integrations: ABDM, labs, pharmacy, Google Calendar, webhooks, API keys.
- Subscription and invoices.
- Status page and incident communication.

### 6.11 ABDM / ABHA (P1)

- HFR registration guidance; HPR for doctors.
- ABHA creation/verification/linking at registration.
- Consent-based record sharing (HIP/HIU) via ABDM sandbox → certification.
- FHIR R4 mapping for prescriptions, diagnostic reports, discharge summaries.
- Consent audit trail.
- Do not claim "ABDM compliant" until certified.

### 6.12 AI assist (P2)

- Ambient scribe: record consultation → transcript → structured note + draft prescription.
- Handwritten prescription OCR → editable draft.
- Smart template mapping suggestions.
- Drug interaction and allergy checks (licensed dataset; not AI-invented).
- Voice commands in Hindi/English/Hinglish.
- Guardrails: clinician review required; no autonomous diagnosis; clear "AI draft" labeling.

### 6.13 Multi-branch and white-label (P2)

- Branch switcher; consolidated dashboards; shared patient record with branch-level access.
- Branch-specific branding, staff, pricing, and templates.
- Reseller mode: custom domain, logo, colors, pricing, and support contact.
- Reseller dashboard: sub-tenants, usage, revenue share.
- API and webhooks for partners.

---

## 7. Template Studio — deep dive

### 7.1 Why it matters

The prescription is the most emotionally and professionally visible artifact a doctor produces. It carries their name, qualifications, registration number, clinic address, timings, and often family/legacy branding. Forcing a new layout is the #1 reason doctors abandon software.

Template Studio turns that objection into the acquisition hook.

### 7.2 Inputs

1. **Built-in templates** — responsive HTML/CSS, specialty packs, print-perfect.
2. **DOCX** — the doctor's existing Word file. Best case: they have placeholders or we add them.
3. **PDF** — convert to DOCX first; if scanned, OCR; if the layout is too complex, use overlay mode.
4. **Image/scan** — overlay mode only, with mapped field boxes.

### 7.3 Placeholder language

Use a simple, documented syntax compatible with docxtemplater:

```
{{clinic.name}}
{{clinic.address}}
{{clinic.phone}}
{{doctor.name}}
{{doctor.qualifications}}
{{doctor.reg_no}}
{{doctor.signature}}
{{patient.name}}
{{patient.age}}
{{patient.gender}}
{{patient.phone}}
{{visit.date}}
{{visit.rx_no}}
{{vitals.bp}}
{{vitals.pulse}}
{{diagnosis}}
{{complaints}}
{{advice}}
{{follow_up.date}}
{{qr}}

{{#medicines}}
{{name}} | {{dose}} | {{timing}} | {{duration}} | {{remarks}}
{{/medicines}}

{{#tests}}
{{name}} — {{instructions}}
{{/tests}}
```

Rules:
- Unknown placeholders block publishing with a clear error.
- Missing optional values render as blank, not "undefined".
- Medicine/test loops render as table rows.
- Conditional blocks: `{{#if patient.allergies}}...{{/if}}`.
- Images: signature/stamp/logo as inline images or floating assets.
- Page breaks: `{{pagebreak}}` and automatic loop overflow.

### 7.4 Mapping UI

1. Upload file.
2. Parse and list detected placeholders.
3. Show a two-column map: **template field ↔ ClinicPad data field**.
4. Auto-map by name similarity; let the user override.
5. Provide "Insert field" for files without placeholders (cursor-based insertion for DOCX).
6. Preview with three datasets: sample, blank, and a real patient (permission-gated).
7. Validate: missing required fields, broken loops, font substitutions, page overflow, image resolution.
8. Publish as version 1; assign to doctor/branch/specialty.
9. Roll back or duplicate.

### 7.5 Rendering pipeline

```
Template (DOCX/HTML)
   → render with data (docxtemplater / React HTML)
   → DOCX or HTML
   → Gotenberg (LibreOffice / Chromium)
   → PDF
   → store + preview + share
```

- Fonts: bundle Noto Sans, Noto Serif, and Devanagari/Indic fonts. Warn on missing fonts.
- Margins/page size: enforce A4/A5; allow Letter for international.
- Header/footer repetition on every page.
- Signature block anchored to the bottom of the last page.
- Overflow: push medicines to a continuation page with a repeated header and "Page X of Y".
- Watermark and QR are optional layers, not baked into the template.
- Deterministic output: pin LibreOffice and font versions; visual regression tests.

### 7.6 Overlay mode (scanned pads)

For PDFs that cannot be faithfully converted:
- Use the original page as a background image.
- Let the user draw boxes for each field.
- Render text at the box coordinates with configurable font/size/color.
- Handle multi-page overflow by repeating the background or using a blank continuation page.
- Good enough for legacy pads; recommend DOCX for best quality.

### 7.7 Template governance

- Draft → Published → Archived.
- Version history with diff and rollback.
- Per-clinic ownership; no cross-tenant leakage.
- Marketplace (P2): doctors publish templates, revenue share, moderation.
- Compliance: registration number and doctor name are required fields on every prescription template.

### 7.8 Acceptance tests

- Upload a 1-page DOCX pad with a medicines table; render 3 medicines and 12 medicines (overflow) correctly.
- Upload a scanned PDF pad; create an overlay; print with real data.
- Missing signature does not break the layout.
- Hindi patient name renders correctly with the bundled font.
- Page numbering is correct across 3 pages.
- Visual diff against the source is within an agreed tolerance for DOCX templates.

---

## 8. Document tools — technical notes

| Conversion | Engine | Notes |
|---|---|---|
| DOCX → PDF | Gotenberg + LibreOffice | Best fidelity; pin versions; embed fonts; strip macros |
| HTML → PDF | Gotenberg + Chromium | Print CSS; wait for fonts/images |
| PDF → DOCX | `pdf2docx` (MIT) | Good for text PDFs; no OCR; layout can drift |
| Scanned PDF → DOCX | OCRmyPDF + Tesseract | English + Hindi + regional packs; then pdf2docx |
| PDF merge/split/compress | Gotenberg / qpdf / pdfcpu | Sandboxed; size/time limits |
| DOCX templating | docxtemplater | Loops, conditionals, images |
| E-sign | Signature pad + PDF stamp | Audit trail with IP/timestamp |

Operational rules:
- Max file size 25 MB (configurable).
- Reject `.docm` and macro-enabled formats.
- Virus scan every upload (ClamAV).
- Conversion jobs are async with progress and retries.
- No outbound network from the conversion sandbox.
- Files deleted after the retention window or on tenant request.

---

## 9. Non-goals (v1)

- Full hospital IPD/OT/ICU management.
- Insurance/TPA claim processing.
- Payroll/HR suite.
- Owning a pharmacy or e-pharmacy.
- Medical diagnosis or autonomous treatment recommendations.
- Hardware (printers, kiosks, TV displays) — integrate, don't manufacture.
- Building a patient marketplace to acquire patients.
- Custom enterprise implementations before 100 paying clinics.

---

## 10. Success metrics

### Activation
- Sign-up → first printed/shared prescription in < 10 minutes (target 70% of sign-ups).
- Template setup completed in < 10 minutes (target 60% without support).
- First patient added in < 2 minutes.

### Engagement
- Weekly active doctors / monthly active doctors > 50%.
- Prescriptions per active doctor per week > 40.
- WhatsApp share rate > 40% of prescriptions.
- Daily dashboard views by owners > 3/week.

### Retention and revenue
- 90-day logo retention > 85% for paying clinics.
- Net revenue retention > 105%.
- Free → paid conversion > 8%.
- CAC payback < 6 months.
- Support tickets per clinic per month < 1.5.

### Quality
- Prescription render failure rate < 0.5%.
- p95 prescription save < 800 ms (online), < 150 ms (local).
- p95 PDF generation < 5 seconds.
- Zero cross-tenant data incidents.
- Restore drill passes quarterly.

### Clinical/business impact (for case studies)
- Minutes saved per consultation.
- Reduction in no-shows.
- Increase in repeat visits.
- Reduction in revenue leakage.

---

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| ABDM certification is slow/complex | Blocks enterprise/ABDM claims | Start sandbox early; don't gate MVP on it; be honest in marketing |
| Data breach | Existential | Security-first architecture, pen test, least privilege, encryption, audits, insurance |
| Doctor switching cost | Low activation | Concierge onboarding, pad digitisation, import, WhatsApp support |
| Free competitors compress pricing | Margin pressure | Differentiate on templates/offline/owner tools; bundle services |
| WhatsApp policy/pricing changes | Messaging cost/availability | Provider abstraction; SMS/email fallback; transparent pass-through |
| Support-heavy SMB market | Poor unit economics | Self-serve onboarding, partner/reseller network, in-app help, community |
| AI regulation | Feature restrictions | Position as documentation assistant; clinician review; no diagnosis |
| Template fidelity complaints | Churn | Visual regression tests; overlay fallback; human setup service |
| Regional language quality | Adoption barrier | Native-speaker review; bundled fonts; community testing |

---

## 12. Open questions

1. Final name and domain (ClinicPad is a working name; check trademark).
2. Should the first release be web-only or ship the desktop app simultaneously?
3. Free tier: yes/no, and what cap?
4. WhatsApp: direct Meta Cloud API vs BSP for the first 100 clinics?
5. Do we offer a done-for-you template setup as a paid service from day one?
6. Which two specialties do we build deep template packs for first?
7. India-only data residency from day one, or a separate international region later?
8. Which pricing anchor: ₹499 (volume) or ₹799 (premium)?
9. Do we build billing in Phase 3 or partner with an existing billing tool?
10. What is the first reseller channel: medical reps, local IT vendors, or accountant networks?
