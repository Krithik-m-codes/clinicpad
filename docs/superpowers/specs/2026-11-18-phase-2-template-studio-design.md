# Phase 2 — Template Studio and document tools ("bring your own pad"): design specification

**Date:** 2026-11-18
**Status:** draft for human review. APPROVED by the human on 2026-11-18 ("Sure": recommendations incl. strict defaults for Q6 and Q10 accepted). Not committed (written on branch `phase-1-prescription-mvp` at HEAD `32ff673`; no source code was changed).
**Design gate:** architectural path (new subsystem). The designer could not ask questions, so every decision below carries options, a recommendation and a confidence level, and section 18 lists the questions only a human can answer. Approval of this spec permits `writing-plans` for sub-plan 2A only; 2B and 2C each need their own plan (and 2B a go decision, section 4.4).
**Numbering:** Phase 2 ADRs start at ADR-0043 and migrations at 0024 (`docs/PROGRESS.md` section 5).
**Read with:** `AGENTS.md` (invariants 3.1–3.10, section 10), `docs/ROADMAP.md` section 4, `docs/PRODUCT_SPEC.md` sections 6.4, 7, 8, `docs/ARCHITECTURE.md` section 6, `docs/DATA_MODEL.md` section 3.5, `docs/DECISIONS.md` ADR-0007, 0011, 0014, 0032–0035, 0037, 0042.

---

## 1. Understanding (what was asked, what is assumed)

**Intended outcome (from ROADMAP §4 and PRODUCT_SPEC §6.4):** a doctor uploads the pad they already use and, in under 10 minutes and without help, prints a prescription with real data that looks like their own pad. This is the first paid launch ("Bring Your Own Pad", ₹499–₹599/month) and Gate A (10 paying clinics, ₹5k MRR).

**Success criteria (ROADMAP §4 exit list, unchanged):** 1-page DOCX pad with a medicines table renders 3 and 12 medicines with overflow and a repeated header; a scanned PDF pad becomes an overlay and prints with real data; Hindi names render with bundled fonts and a missing signature does not break layout; page numbers correct across 3 pages, A4 and A5; visual diff within an agreed tolerance on a golden suite; 10 clinics complete setup with median self-serve time to first real prescription under 10 minutes; conversion jobs succeed > 97% with actionable errors; no template or asset readable across tenants (automated).

**Constraints that bind this design:** invariants 1 (tenant isolation, RLS), 2 (audit), 3 (never overwrite a signed prescription), 4 (India data in India, which includes the document engine, because it renders prescription content), 7 (no secrets), 8 (uploads are hostile), 9 (offline must not lose data; relevant to Phase 4 printing), 10 (no compliance claims). Plus the repo's own rules: snapshot printing (ADR-0032), self-contained documents (ADR-0034), immutable assets (ADR-0035), composite same-tenant keys (ADR-0025), every CHECK declared in Drizzle, files under ~250 lines.

**What the request said vs what this spec assumes:**

| Said (by the brief or the docs) | Assumed here (correct me) |
|---|---|
| Suggested cut: 2A = DOCX pipeline first | Challenged: overlay first (section 4) |
| Upload Word or PDF pad | Many target doctors have no Word file: they have a printed pad, a phone photo, or a PDF from a local printer. GTM's concierge path collects pads "on WhatsApp" (`docs/GTM_PRICING.md` line 210), which are mostly photos and PDFs. Unverified; the pilot should count it (Q2) |
| Gate 1 asks whether partners want their own pad | The pilot has not run; Phase 2 starts only partially before it (section 16) |
| Solo founder, 4-week Phase 2 | The ROADMAP §4 workstreams add up to 43 working days, about 9 weeks for one engineer; the 4-week figure needs re-baselining (Q19) |
| India first, A4/A5 | Letter size deferred; Devanagari is the only Indic script tested in Phase 2 |

---

## 2. Repo facts Phase 2 builds on

| Fact | Where | Consequence for Phase 2 |
|---|---|---|
| `TemplateRef` is `{ kind: "builtin"; key }`; comment reserves `docx` and `overlay` kinds | `src/lib/rx-render/types.ts` lines 13–18 | The seam exists; `renderPrescription` has an exhaustive switch with no default (`render.ts` lines 47–53), so a new kind fails to compile until drawn |
| `RenderedDocument` is `{ format: "html"; html; footerHtml; paper; title }`; comment reserves `format: "docx"` | `types.ts` line 95 | The engine must dispatch on `format` |
| Snapshot v1 freezes patient, clinic, doctor, layout; `layout.template` is a literal `builtin` | `src/lib/rx-render/snapshot.ts` | Custom templates need snapshot v2 (bump `v`, keep the v1 parser) |
| Presentation is NOT frozen; `RENDERER_VERSION = "1"` is logged per output | `render.ts` line 32, ADR-0032 | For custom templates the template file IS customer data and must be frozen by id + hash |
| `prescriptions.template_version_id` exists, composite FK `prescriptions_template_version_fk` `ON DELETE SET NULL (template_version_id)`, never written today | `src/server/db/schema/clinical.ts` lines 148, 183–187; migration 0010 | Write it at finalize. A referenced version cannot be deleted (the SET NULL is an UPDATE the immutability trigger refuses, ADR-0025) |
| Amend copies `templateVersionId`, repeat resets it | `src/server/services/rx-mapping.ts` lines 108, 128 | Finalize will overwrite it from the resolved template; change the amend rule to `reset` for clarity |
| `templates` (`name`, `kind` default `html`, `status` default `draft`) and `template_versions` (`version`, `file_key`, `mapping`, `published_at`) are bare Phase 0 tables with `UNIQUE (tenant_id, id)` | `clinical.ts` lines 240–284 | Extend them; no rows exist outside tests (verify in Task 1) |
| `clinics.rx_template / rx_paper_size / rx_labels` choose the built-in pad (CHECK-constrained) | `src/server/db/schema/tenancy.ts` lines 111–131 | Built-ins stay as they are; custom templates get their own assignment columns |
| `clinic_assets`: PNG/JPEG `bytea`, ≤ 512 KB, 16–2000 px, deduped by SHA-256, insert/read only, caps 20/50, no malware scan | `tenancy.ts` lines 60–89, `src/server/services/assets.ts`, ADR-0035 | Pad backgrounds do not fit these limits; they need their own table and limits |
| `checkSelfContained()` is deny-by-default (allowed tags, no CSS comments, `url()` only for embedded PNG/JPEG/WOFF2, 4 MB cap) | `src/lib/rx-render/self-contained.ts` | The overlay renderer can stay inside this checker unchanged |
| The existing draft/superseded `.watermark` is `position:fixed` | `src/lib/rx-render/styles.ts` line 34 | Chromium already repeats fixed elements per printed page in this pipeline (confirm for browsers in spike S1) |
| PDF engine: injectable `PdfEngine`, never throws, 4 MB HTML cap, 15 MB / 20-page PDF caps, 20 s render timeout; per-process limiter 2 running / 5 queued | `src/server/pdf/engine.ts`, `limiter.ts` | Add an office engine beside it with its own limiter and limits |
| Gotenberg 8.11.0 pinned by digest, Chromium hardened, `--libreoffice-disable-routes`, `--pdfengines-disable-routes`, `cap_drop: ALL`, 1 GB | `docker-compose.yml`, `.github/workflows/ci.yml` | LibreOffice is new attack surface; run it in a separate container. Gotenberg 8.32.0 added LibreOffice outbound URL allow/deny-list flags, so 8.11 is too old for the office container |
| Browser print uses a hidden iframe with the HTML and works when Gotenberg is down | ADR-0034 | True for HTML kinds only. A DOCX pad can only print from a PDF |
| Server actions have a 1 MB body limit; CSV import caps at ~900 KB for that reason | ADR-0039 | Template uploads must use a route handler with a streamed byte cap |
| Middleware matcher: `/dashboard`, `/patients`, `/prescriptions`, `/settings` | `src/middleware.ts` line 7 | Add `/templates/:path*` |
| Desktop build stashes `src/app/(app)` and listed server routes | `scripts/build-desktop.mjs` lines 17–24, AGENTS §10 | Put Template Studio pages and route handlers under `src/app/(app)/templates/` so they are stashed automatically |
| Role matrix is a single table | `src/lib/domain/permissions.ts` | New `template.*` actions go there |
| `users.is_platform_admin` column exists, with no cross-tenant path built | `tenancy.ts` line 171 | Not used for concierge (section 10.4) |
| `render.ts` is 446 lines | `src/lib/rx-render/render.ts` | Split it before adding overlay code (targeted improvement, AGENTS §5) |

---

## 3. Decision summary

| # | Decision | Recommendation | Main alternative | Confidence |
|---|---|---|---|---|
| D1 | First vertical slice | **Overlay mode (image/PDF background + field boxes + flow region) on the existing HTML/Chromium pipeline** | DOCX first (the brief's suggestion) | medium-high |
| D2 | PDF intake in 2A | **Rasterize page 1 in the browser with pdf.js inside an opaque-origin sandboxed iframe; the server only ever receives an image** | Server-side rasterizer container | medium |
| D3 | Template file storage | **Postgres `bytea` in a new `template_files` table behind a `BlobStore` seam (2A/2B); object storage only when patient documents arrive (2C)** | Object storage now | medium-high |
| D4 | Malware scanning | **ClamAV (clamd) in its own container, synchronous scan, fail closed; retrofit logo/signature uploads** | Skip ClamAV for images in 2A | medium |
| D5 | DOCX images | **Replace pictures by alt text (`doctor.signature`, `clinic.logo`) ourselves; no paid docxtemplater module** | Paid image module (about €500 per module per year) | medium |
| D6 | Placeholder grammar | **Mustache sections (`{{#x}}…{{/x}}`, `{{^x}}`), dotted allow-listed paths, no expressions; `{{#if x}}` accepted only as sugar normalised to `{{#x}}` (verify in spike S3)** | docxtemplater angular-expressions parser | medium |
| D7 | LibreOffice isolation | **Second Gotenberg container (`gotenberg-office`), latest pinned 8.x with LibreOffice URL deny-list, no egress, custom fonts image** | Enable LibreOffice in the existing Chromium container | high |
| D8 | DOCX print path | **Print the office-made PDF (hidden iframe on Chromium browsers, new tab elsewhere); explicit "print on the standard pad" fallback when the office engine is down** | LibreOffice DOCX to HTML | medium |
| D9 | Draft/superseded marks on DOCX output | **Composite a Chromium-made stamp page onto the office PDF with pdf-lib (Chromium shapes Devanagari)** | Inject a watermark shape into the DOCX header | low-medium (spike) |
| D10 | Snapshot | **v2: `layout.template` becomes a union with `templateVersionId` + `contentSha256`; finalize resolves the template and writes `template_version_id`** | Live lookup of the current template at print | high |
| D11 | Doctor identity on letterheads | **A template either prints the doctor from data ("dynamic") or is bound to one doctor whose identity is printed in the letterhead ("bound"); a bound template is never used for another finalizer** | Ignore (risk: Dr B's Rx on Dr A's letterhead) | high |
| D12 | Job queue | **None in 2A/2B (synchronous, limiter-bounded); pg-boss + a worker in 2C for PDF→DOCX/OCR** | pg-boss from 2A | medium-high |
| D13 | Concierge access | **Time-limited membership with a new `designer` role (templates only, no patient or prescription access)** | Platform-admin break-glass across tenants | medium-high |
| D14 | Gotenberg version | **Upgrade the Chromium container to the latest pinned 8.x in 2A (Chromium ≥ 131 adds `@page` margin boxes), re-baseline visuals** | Stay on 8.11 until 2B | medium |

---

## 4. Sequencing

### 4.1 Three ways to cut Phase 2

**Option A — DOCX first (the brief's suggestion).** 2A = hardened upload, DOCX model, placeholders, docxtemplater (loops, overflow, repeated header), Gotenberg DOCX→PDF, publish/version/assign, preview. 2B = mapping UI, insert-field, overlay, PDF→DOCX. 2C = document tools, gallery, concierge.
- For: tackles the hardest fidelity risk first (ROADMAP §11: "DOCX fidelity worse than expected, +2–3 weeks"); matches the positioning line "upload your Word pad".
- Against: the slice cannot be demonstrated self-serve. Without insert-field (2B), a doctor whose Word file has no `{{placeholders}}` must edit it in Word, which few doctors will do in 10 minutes. It opens the largest new attack surface (zip, XML, LibreOffice) before anything ships. DOCX pads cannot print from the browser (section 9) and cannot print offline in Phase 4 without LibreOffice on the client. Doctors without a Word file (printed pad, photo, printer's PDF) get nothing.

**Option B — overlay first (recommended).** 2A = template model, snapshot v2, upload pipeline for images, pdf.js page rasterization, overlay editor (field boxes + one flow region that reuses the built-in body), overlay renderer on the existing HTML pipeline, publish/version/assign, print (including pre-printed stationery), PDF, share. 2B = DOCX (sanitizer, office engine, fonts, placeholders, docxtemplater, mapping UI, insert-field, golden DOCX suite). 2C = gallery, concierge tooling, document tools, object storage, job queue, PDF→DOCX/OCR.
- For: reuses most of Plan 1C (renderer, `checkSelfContained`, embedded Devanagari font, browser print, Gotenberg Chromium, share route, output log, visual tests), so it ships fastest. It covers every source format on day one: photo or scan, the printer's PDF, and Word (the doctor clicks "Save as PDF" in Word; the letterhead then keeps Word's exact rendering, which LibreOffice cannot promise when it substitutes Mangal or Calibri). It also covers clinics that keep printing on their pre-printed paper (print the data only). New attack surface is small: images only, which already have a byte-level validator (`src/lib/domain/image.ts`). It stays printable offline in Phase 4 because it is HTML.
- Against: dynamic content uses ClinicPad's table styling inside the region, not the doctor's own Word table; a phone photo makes a poor background unless it is flat and evenly lit; page numbers and a full-bleed background conflict (section 6.4); Safari print behaviour of repeated fixed elements is unverified (spike S1). It does not satisfy the DOCX exit criterion, so 2B is still needed for the gate.

**Option C — compile everything to overlay.** At publish time, LibreOffice renders the DOCX once with marker values; we read the marker positions from the PDF and generate an overlay definition, so every print runs through the HTML pipeline.
- For: one runtime pipeline; LibreOffice runs once per template version, not per prescription; offline print in Phase 4.
- Against: novel and fragile (marker extraction, loops, tables); the doctor's table styling is lost anyway; raster letterhead. Keep it in mind as the Phase 4 offline fallback for DOCX pads (deferred, section 14).

### 4.2 Recommendation

Option B. It reaches a sellable, demonstrable "your pad in 10 minutes" fastest with the least new risk, and it is the fallback the roadmap already names for DOCX fidelity problems. DOCX stays in Phase 2 as 2B because the exit criteria and the paid hook ("DOCX upload is the paid hook", `docs/GTM_PRICING.md` line 69) depend on it, but its priority and depth should be set by pilot evidence on which formats doctors actually bring (Q2).

### 4.3 Sub-plans

| Sub-plan | Scope | Exit evidence (subset of ROADMAP §4) | Rough size |
|---|---|---|---|
| **2A — Overlay slice** | Spikes S1, S2, S5; schema and guarantees for templates; upload pipeline (route handler, caps, ClamAV, quotas); field catalogue; snapshot v2 and resolution at finalize; overlay renderer; Template Studio wizard (upload, crop, boxes, preview, publish, assign); print modes incl. pre-printed stationery; visual tests; cross-tenant tests | Scanned/photo/PDF pad becomes an overlay and prints with real data; Hindi name; missing signature; A4 and A5; 12 medicines overflow with repeated header and repeated patient boxes; no cross-tenant read; median setup time measured on design partners | 25–38 working days |
| **2B — DOCX** | Spikes S3, S4; DOCX sanitizer; office engine container with fonts; placeholder grammar and validator; docxtemplater renderer; DOCX output path (PDF print, stamps, fallback); mapping UI, insert-field, table-to-loop; golden DOCX suite with tolerance | DOCX pad 3/12 medicines with overflow and repeated header; page numbers across 3 pages; visual diff within tolerance; DOCX→PDF success > 97% | 21–30 working days |
| **2C — Gallery, concierge, document tools** | 8–10 built-in specialty pads; concierge designer role and checklist; object storage + patient document store; pg-boss job queue and worker; merge/split/rotate/compress/watermark/page numbers; PDF→DOCX and OCR (licence-gated) | Gallery visual tests; PDF→DOCX success > 97% (if kept, Q8); 10 clinics complete setup | 17–24 working days |

Sizes are the sum of the task sizes in section 15 (S ≤ 1 day, M 1–2, L 3–4): 63–92 working days for one engineer working by hand, against the roadmap's 4 weeks. Phase 1 plans ran far faster in calendar time with agent-driven execution (Plans 1C and 1D each landed within about a day, `docs/PROGRESS.md` section 11), so calendar time may be much shorter; review, human checks and pilot feedback are the real pacing items. Cut 2C first when behind (ROADMAP §11: cut scope inside a phase, never skip a gate).

### 4.4 Gates between sub-plans

- **Before 2A planning is final:** spikes S1 (overlay print mechanics), S2 (pdf.js in a sandboxed iframe), S5 (Gotenberg upgrade) answered; human answers Q1, Q3, Q6, Q10.
- **Before 2B starts:** pilot evidence on source formats and Gate 1 ("do partners ask for their own pad?"); spikes S3 (docxtemplater + LibreOffice on 3–5 real pads) and S4 (ClamAV footprint); staging exists with the office container egress-blocked (Q4).
- **Before 2C starts:** storage decision for patient documents (Q5), licensing review for PDF→DOCX/OCR (Q7), decision whether PDF→DOCX stays in Phase 2 (Q8).

---

## 5. Template model

### 5.1 Kinds and how they relate to built-ins

| Kind | Source | Drawn by | Output formats | Prints without Gotenberg | Offline in Phase 4 |
|---|---|---|---|---|---|
| `builtin` (exists) | `TEMPLATE_DEFINITIONS` in code | `renderBuiltin` (HTML) | html → Chromium PDF | yes | yes |
| `overlay` (2A) | background image + boxes + flow region (jsonb definition) | new `renderOverlay` (HTML), reusing the built-in section renderers | html → Chromium PDF | yes | yes |
| `docx` (2B) | sanitized DOCX bytes + validated tag list | new `renderDocx` (docxtemplater) | docx → LibreOffice PDF | **no** | **no** (section 14) |

Built-ins stay code, not rows: they have no versions to freeze (presentation of built-ins is versioned by `RENDERER_VERSION`, ADR-0032). The gallery in 2C adds more built-in definitions the same way. `templates` rows are tenant-owned custom templates only (`kind in ('overlay','docx')`); the Phase 0 default `kind = 'html'` is replaced by a CHECK (added `NOT VALID` then validated, AGENTS §10).

### 5.2 Tables (sketch for Task 1; final DDL in the plan)

All tables: `tenant_id NOT NULL`, forced RLS with the standard `tenant_isolation` policy, `UNIQUE (tenant_id, id)` on parents, composite FKs with explicit names under 63 characters, CHECKs declared in Drizzle too. The existing guards (`tests/integration/rls-guard.test.ts`, `tenant-fk.test.ts`, `schema-checks.test.ts`) fail automatically if a new table forgets one of these.

- **`template_files`** (new): `id`, `tenant_id`, `kind` (`background_image` | `docx`), `mime`, `byte_size`, `sha256` (of stored bytes, checked by `sha256 = encode(sha256(bytes),'hex')` like `clinic_assets_hash_matches_check`), `bytes bytea`, `width`/`height` (images), `scan_engine` (ClamAV version + signature date), `storage` (`pg` only for now; the seam for object storage), `created_by`, `created_at`. `UNIQUE (tenant_id, kind, sha256)` for de-duplication. Runtime role: INSERT and SELECT only; immutability triggers on the admin connection unless the tenant is erased (ADR-0035 pattern). Only clean, validated, sanitized bytes are ever stored; the original upload is never persisted.
- **`templates`** (extend): `name`, `kind`, `status` (`active` | `archived`), `identity` (`dynamic` | `bound`), `bound_doctor_id` (composite FK to `doctors`, required iff `bound`), `current_version_id` (composite FK to `template_versions`, nullable until first publish), `created_by`, `updated_at`. Templates are never deleted once any version was published (archive instead); an unpublished template may be deleted with its draft versions.
- **`template_versions`** (extend): `version`, `state` (`draft` | `published`), `file_id` (composite FK to `template_files`, NO ACTION), `content_sha256` (hash of the canonical JSON of definition + file sha: the value the snapshot freezes), `definition jsonb` (overlay: `overlayDefinitionSchema` v1; docx: detected tag list, paper, font report), `paper_size` (`A4` | `A5`), `labels` (`en` | `hi` | `bilingual`), `published_at`, `published_by`. A draft version is edited in place (it is not a record, like a draft prescription, ADR-0029); a published version is frozen by trigger: no UPDATE of any column, no DELETE unless the tenant is erased. Rollback publishes a copy of an older version as a new version number; history is linear and never rewritten. Replace `mapping`/`file_key` (unused) in the same migration after checking they hold no rows.
- **Assignment** (columns, mirroring `clinics.logo_asset_id`): `clinics.custom_template_id` and `doctors.template_id`, both composite FKs to `templates`, NO ACTION. When `clinics.custom_template_id` is null the built-in in `clinics.rx_template` applies, exactly as today. Branch-level assignment is deferred (no branch UI yet).
- **`prescription_outputs`** (alter): extend `rx_outputs_template_key_check` to include `overlay` and `docx`; add nullable `template_version_id` (composite FK + index); add `input_sha256` (SHA-256 of the exact HTML or DOCX bytes sent to the engine) and `engine` (`chromium` | `libreoffice` | `browser`); keep `html_sha256` for HTML kinds and relax it to "exactly one of `html_sha256`/`input_sha256` per format" with a CHECK. The table stays append-only; changing a CHECK touches no rows.

### 5.3 Lifecycle and resolution at finalize

```
upload (validated, scanned, sanitized) -> template_files row
        -> template + draft version (edit boxes / mapping, preview)
        -> validate -> publish (state=published, frozen; templates.current_version_id = it)
        -> assign (clinic default / a doctor)
        -> finalize resolves -> snapshot v2 freezes { kind, templateVersionId, contentSha256 }
        -> print / PDF / share read the frozen version, forever
```

**Resolution (inside `finalizePrescription`, under the prescription row lock, after the revision check and before the Rx number is allocated, exactly where `buildFinalSnapshot` runs today):**

1. Finalizer's doctor profile has `template_id`, that template is `active`, has a published current version, and is `dynamic` or bound to this doctor → use it.
2. Else `clinics.custom_template_id` under the same conditions → use it.
3. Else the built-in `clinics.rx_template` (today's behaviour).

A template bound to another doctor is skipped, never used. The resolved version id is written to `prescriptions.template_version_id` in the same UPDATE that sets `status = 'finalized'` (the trigger allows column changes while the row is a draft). Plain reads are enough: published versions never change, and a concurrent publish or archive only decides which immutable version is current at read time. The FK takes a KEY SHARE lock on the version row; no new lock order is introduced (ADR-0023 orders unchanged). Finalize fails closed (`invalid`, no number burned) if the chosen version's file is missing or its hash does not match.

**Drafts** preview with the would-be resolution for the viewer (the viewer's own doctor assignment if they can finalize, else the clinic default), mirroring the ADR-0032 rule for the would-be signer. Draft previews are not logged (ADR-0033).

**Amendments** resolve again at their own finalize (an amendment is a new record; ADR-0032 says clinic and profile edits apply to prescriptions finalized afterwards). Change `AMEND_PRESCRIPTION_COLUMNS.templateVersionId` from `copy` to `reset` so the code says what happens. Alternative (Q15): an amendment keeps its parent's template version.

### 5.4 The frozen-snapshot invariant for custom templates

ADR-0032 froze data and deliberately left presentation free. For custom templates the presentation is the clinic's own artifact, so it is frozen too:

- Snapshot v2: `layout.template` becomes `{ kind: "builtin", key } | { kind: "overlay", templateVersionId, contentSha256 } | { kind: "docx", templateVersionId, contentSha256 }`; `layout.paperSize` and `layout.labels` come from the version for custom kinds. `parseRenderSnapshot` keeps a v1 parser and normalises v1 to the v2 shape in memory (no backfill: migrations cannot update finalized rows, AGENTS §10).
- Reprint loads the version by id inside `withTenant`, re-hashes definition + file, and refuses to print on a mismatch (fails closed with a support message), so a tampered row cannot change a signed pad silently.
- Template edits create new versions; archiving a template hides it from assignment only. Nothing that a finalized prescription references can be deleted (FKs + triggers), so a reprint in five years uses the same bytes.
- What is still NOT frozen, honestly stated: the renderer code (`RENDERER_VERSION` per kind: `1`, `overlay-1`, `docx-1`), the Chromium and LibreOffice builds, and the fonts. Each output row records `renderer_version` and `engine`, and for LibreOffice the image digest. Pixel-identical reprints across an engine upgrade are not guaranteed; the golden suite (section 12) is the control. A stored "as issued" PDF would be the strongest medico-legal answer but needs object storage and a retention policy (Q16; deferred).

### 5.5 Data binding: one allow-listed field catalogue

Templates never see database rows. A pure function `toTemplateData(doc: RxDocument, labels)` (new, `src/lib/rx-render/fields.ts`) produces a plain object of pre-formatted strings, booleans and lists from the snapshot, the visit and the items, reusing `format.ts` and `labels.ts` so built-in and custom pads print identical text. `TEMPLATE_FIELDS` declares every key with its type, sample values (English, Hindi, long), a description in English and Hindi, and whether publishing requires it. Names follow PRODUCT_SPEC §7.3 and ADR-0014 (`doctor.reg_no`, `visit.rx_no`, `follow_up.date`).

| Group | Fields (v1) | Source |
|---|---|---|
| clinic | `name`, `address` (lines joined with line breaks), `phone`, `email`, `footer`, `logo` (image) | snapshot.clinic |
| doctor | `name`, `qualifications`, `designation`, `reg_no`, `council`, `signature` (image; never on drafts) | snapshot.doctor (the finalizer, ADR-0032) |
| patient | `name`, `age`, `gender`, `age_gender`, `no`, `allergies`, `weight` | snapshot.patient, visit vitals |
| visit | `date` (clinic timezone), `rx_no` (blank for drafts; `12 (v2)` for versions > 1), `type` | prescription row + snapshot |
| vitals | `bp`, `pulse`, `temperature`, `spo2`, `rr`, `weight`, `height`, `bmi`, `sugar`, `line` (one compact line) | visit.vitals |
| clinical | `chief_complaint`, `complaints`, `diagnosis`, `history.medical`, `history.drug`, `examination`, `advice`, `follow_up.date`, `follow_up.reason`, `follow_up.line` | visit |
| loop `medicines` | `n`, `name`, `generic`, `strength`, `form`, `route`, `dose`, `schedule` (`1-0-1`), `morning`, `afternoon`, `evening`, `night`, `timing`, `food`, `frequency`, `duration`, `remarks`, `sos` | items |
| loop `tests` | `n`, `name`, `instructions` | visit.investigations |
| flags | `has.allergies`, `has.vitals`, `has.medicines`, `has.tests`, `has.follow_up`, `has.signature` | derived |
| layout (docx only) | `page_x_of_y`, `pagebreak` | expanded by our code into Word fields / breaks |
| reserved | `qr` | refused in v1 with "coming later" (needs a share link at print time; deferred) |

Rules: unknown fields block publish with a "did you mean" suggestion; missing optional values render blank, never `undefined` (`nullGetter`); loops only over list fields, sections only over list or flag fields; values are text, never markup (docxtemplater escapes XML; raw-XML tags `{{@…}}` are refused in user templates; overlay values go through `userText()`). `patient.phone` is deliberately absent (not in the snapshot; printing it is a data-minimisation decision, Q14).

**Publish preconditions** (PRODUCT_SPEC §7.7): `patient.name`, `visit.date` and a medicines region (overlay flow region or docx `medicines` loop) are present; a `dynamic` template contains `doctor.name` and `doctor.reg_no`; a `bound` template names its doctor and the publisher confirms the letterhead shows that doctor's name and registration number (recorded in the audit event).

### 5.6 Fonts and Hindi

- **Overlay and built-in:** unchanged: the document embeds Noto Sans Devanagari 400/700 as WOFF2 data URIs (`src/server/rx-render/fonts.ts`); the background carries the clinic's own letterhead pixels, so the letterhead's fonts do not matter.
- **DOCX (2B):** a custom image `FROM` the pinned Gotenberg digest copies pinned font files (SHA-256 listed in the repo): Noto Sans/Serif, Noto Sans/Serif Devanagari, the ARCHITECTURE §6.2 Indic set (installed, only Devanagari tested in Phase 2), and the metric-compatible Carlito, Caladea and Liberation families (check which the base image already has with `fc-list`). Fontconfig aliases map common Windows Hindi fonts (Mangal, Nirmala UI, Kokila, Aparajita, Utsaah) to Noto Devanagari. Upload validation reads `word/fontTable.xml` and run properties, compares with the image's font list (generated at image build), and reports substitutions before publish. Microsoft fonts are not redistributable, so a pad set in Mangal or Calibri will reflow slightly; the preview shows it and the overlay route (Save as PDF in Word) is offered as the exact alternative.
- **Legacy non-Unicode Hindi fonts (Kruti Dev, Chanakya, DevLys):** text is stored as Latin bytes and prints as gibberish without the font. Detect by font name and refuse with an explanation and the concierge offer; converting such text to Unicode is deferred (Q13).
- Page labels: "Page x of y" stays English with Western digits (ADR-0041) for every kind.

### 5.7 Paper

A4 and A5 portrait only. Overlay: the editor proposes A4 or A5 from the image aspect ratio (A-series ratio 1.414, tolerance about 3%) and the user confirms; anything else is refused with "crop to the pad edges". DOCX: read `w:pgSz` of every section; all sections must be the same A4 or A5 (±2 mm), otherwise refuse with what to change in Word. Letter is deferred (international, Phase 5).

---

## 6. Overlay kind (2A)

### 6.1 Definition (`overlayDefinitionSchema` v1, Zod, stored in `template_versions.definition`)

- `paper`: `A4` | `A5`; `background`: `{ fileId, printMode: "always" | "pdf_only" }` (`pdf_only` = pre-printed stationery: browser print omits the background, the PDF for sharing keeps it).
- `boxes[]` (at most 30): `{ id, field, xMm, yMm, wMm, hMm, fontPt (6–24), align, bold, repeat: "every_page" | "first_page" }`. Numbers are finite, in range, rounded to 0.1 mm; `field` must be a catalogue key of type text or image.
- `flow`: `{ topMm, bottomMm, leftMm, rightMm, bodyStyle: "general" | "paediatric" | "derma", sections: SectionKey[], showRxMark }`: the region where the clinical body flows across pages, drawn by the built-in section and medicine-table renderers.
- `signature`: `{ mode: "end_of_content" | "box" }` (default `end_of_content`: signature and registration line follow the last section inside the flow region, as `.closing` does today; `box` = a fixed box that repeats on every page, Q11).
- `pageNumbers`: `{ bandMm: 0 | 5–12 }` (section 6.4); `printOffsetMm`: `{ x, y }` (−10…10, printer calibration for pre-printed paper).

### 6.2 Rendering (HTML, inside the existing guarantees)

`renderOverlay(doc, assets, definition)` builds one document that passes `checkSelfContained()` unchanged:

- `@page { size: A4|A5 portrait; margin: 0 }` (or a bottom band, section 6.4).
- Background: `<img>` data URI with `position:fixed` full page (`.bg`), omitted from print media when `printMode = pdf_only`.
- Boxes: `every_page` boxes are `position:fixed` (Chromium repeats fixed elements on every printed page; the existing watermark already relies on this); `first_page` boxes are `position:absolute` (page 1 only). Each value is one `userText()` span; overflow is visible, never clipped (ARCHITECTURE §6.5).
- Flow region: the Plan 1C `table.sheet` pattern, with a `thead` spacer of height `topMm` and a `tfoot` spacer of height `paperHeight − bottomMm` that repeat on every page, and horizontal padding for `leftMm/rightMm`. The medicines table's own `thead` repeats inside it (seen working in the 1C visual review). No JavaScript, no measurement.
- Positions come from validated numbers formatted by the renderer (never user strings), so the "no user data in CSS" rule in `render.ts` is kept in spirit; the rule is amended to "numbers from validated definitions only".
- Draft/superseded watermark and banners reuse the existing elements; drafts never embed the signature (ADR-0032).
- Before adding this, split `render.ts` (446 lines) into `builtin.ts`, `sections.ts`, `medicines.ts`, `marks.ts` with the golden files unchanged (a pure refactor commit, goldens prove it).

### 6.3 Background intake

- Accepted: JPEG or PNG image, or a PDF that the browser rasterizes. The server never receives a PDF in 2A.
- **pdf.js in a sandboxed iframe:** pinned `pdfjs-dist` at a release after the CVE-2024-4367 fix (4.2.67+), `isEvalSupported: false`, loaded only on the Template Studio upload step, running in an `<iframe sandbox="allow-scripts">` without `allow-same-origin` (opaque origin, so a hostile PDF that escaped pdf.js still cannot ride the session) that returns a canvas-encoded JPEG/PNG by `postMessage`. Page choice: page 1 by default, any page selectable.
- Client-side processing (convenience, not trust): crop to the pad edges, rotate 90° steps, downsample to about 200 dpi (A4 1654×2339, A5 1165×1654), JPEG quality about 0.8; target size ≤ 600 KB (the background is embedded in every printed HTML and PDF).
- Server limits (trust): PNG/JPEG detected from bytes by `inspectImage`, metadata stripped by `stripImageMetadata` (`src/lib/domain/image.ts`), new limits for this kind: ≤ 2 MB, long side 1100–3600 px, aspect ratio within A4/A5 tolerance, ClamAV clean. These are separate constants from `IMAGE_LIMITS` (512 KB, 2000 px), which stay for logos and signatures.
- Phone photos: crop and rotate only in 2A; perspective correction and paper whitening are deferred (2B optional) and covered by concierge meanwhile (Q20).

### 6.4 Known overlay limits (honest)

- **Page numbers vs full-bleed background.** `counter(page)` only exists in page margin boxes (Chromium ≥ 131 `@page` margin boxes) or in Gotenberg's footer template, and both live in the page margin, where a fixed background cannot reach. Recommendation: page numbers off by default (most pads are one page); when on, the user marks a blank bottom band (5–12 mm) and the background is drawn above it. Spike S1 tests an alternative: put the background's bottom strip inside Gotenberg's footer template.
- **Safari and Firefox print** of repeated fixed elements and `thead` spacers are unverified. If a browser fails, that browser prints the Gotenberg PDF instead (same path as DOCX, section 9).
- **Dynamic table style** comes from the chosen body style, not from the doctor's pad.
- **Long values in boxes** can overflow the box. The editor measures overflow live in the browser (same embedded font) with the long sample data and warns; at print time text overflows visibly rather than being cut.
- **PDF size:** whether Chromium writes the repeated background once or per page is unverified (spike S1); WhatsApp-friendly size matters.

---

## 7. DOCX kind (2B)

### 7.1 Intake: sanitize by rebuilding, never by patching

`sanitizeDocx(bytes)` (pure TypeScript, no LibreOffice, `src/lib/docx/sanitize.ts`) returns a rebuilt package or a typed refusal with a user message:

1. **Container:** ZIP magic; parsed with a streaming unzipper that counts real inflated bytes (never trusts headers): ≤ 4 MB upload, ≤ 1,000 entries, ≤ 40 MB total inflated, ≤ 10 MB per part, inflation ratio ≤ 200:1 per entry; refuse encrypted entries, duplicate names, names with `..`, a leading `/` or `\`, drive letters, NUL or control characters, non-normalised Unicode; refuse overlapping local headers (the overlapping-file zip bomb) and local/central header disagreement; ignore nothing silently.
2. **Type:** `[Content_Types].xml` must declare the main part as `…wordprocessingml.document.main+xml` (or `template.main+xml` for `.dotx`, normalised); `macroEnabled` main parts (`.docm`, `.dotm`) and any `vbaProject.bin`, `vbaData.xml`, `activeX/`, `embeddings/` part are refused with "save as a plain Word document".
3. **XML:** every XML part is UTF-8 (or UTF-16 with BOM) and must contain no `<!DOCTYPE` or `<!ENTITY` (Word never writes one), which removes XXE and entity expansion before any parser runs; parse with a non-validating parser with entity expansion off as a second layer.
4. **Allow-listed parts only** are copied into a new package: document, styles, stylesWithEffects, numbering, fontTable, settings (scrubbed), theme, headers, footers, footnotes, endnotes, media images (PNG and JPEG only; GIF, TIFF, SVG and other types refused; EMF/WMF refused by default, Q22), and minimal docProps with author/company/title blanked. Dropped with a line in the report: comments, people, customXml, glossary, webSettings, thumbnails, printer settings, `altChunk` parts and elements.
5. **Relationships:** every `.rels` is rewritten; any `TargetMode="External"` relationship is removed (remote images, `attachedTemplate` template injection, external hyperlinks, frames, subDocuments); `w:hyperlink` keeps its text and loses the link; `settings.xml` loses `w:attachedTemplate`, `w:mailMerge`, `w:docVars`, `w:updateFields`.
6. **Fields:** complex and simple fields are allow-listed by instruction: `PAGE`, `NUMPAGES`, `SECTIONPAGES` stay; everything else (`INCLUDEPICTURE`, `INCLUDETEXT`, `LINK`, `DDE`, `DDEAUTO`, `IMPORT`, `DATE`, `HYPERLINK`, `MACROBUTTON`, …) is replaced by its cached result text.
7. **Content:** tracked changes (`w:ins`, `w:del`, `w:moveFrom/To`) are refused with "accept or reject all changes in Word" (v1; auto-accept deferred); embedded OLE objects (`w:object`) refused.
8. **Output:** a deterministic ZIP (fixed timestamps and order), hashed; the report lists every removal. ClamAV scans the ORIGINAL bytes before step 1 and the rebuilt bytes after step 8.

The rebuilt package is the only DOCX that is stored, rendered, or sent to LibreOffice. The renderer's output is re-checked with steps 3–6 (cheap) before conversion, so user text can never smuggle a field or relationship in.

### 7.2 Placeholders and rendering

- docxtemplater core (MIT/GPLv3 dual per its FAQ; confirm before adding, Q7) with `{{ }}` delimiters, `paragraphLoop: true`, `linebreaks: true`, `nullGetter` returning `""`, error logging off, and a **custom parser** that resolves only catalogue paths through own-property lookups (no prototype access, no expressions). PizZip is used only on the sanitized package.
- Detection: docxtemplater's lexer reports tags even when Word split them across runs; the validator lists detected tags, unknown tags (blocking), loops over non-lists, unbalanced sections, raw-XML tags, and missing required fields.
- `{{#if x}}…{{/if}}` (ADR-0014, PRODUCT_SPEC §7.3) is not native to docxtemplater core; spike S3 checks whether the custom parser can map it; if not, the sanitizer normalises it to `{{#x}}…{{/x}}` before storing. ADR-0014 gets an amendment either way.
- **Medicines overflow with repeated header:** the loop sits in a table row; the header row gets `w:tblHeader` ("repeat as header row"; the validator offers to set it); LibreOffice flows rows to the next page and repeats the header row; the Word page header part repeats the letterhead. A letterhead placed in the body instead of the page header does not repeat: the validator warns and the preview with 12 medicines shows it.
- **Images:** the template contains a picture whose alt text (`wp:docPr descr`) is `clinic.logo` or `doctor.signature`; the renderer replaces the media bytes and fits the image inside the frame's extent (contain); a missing image becomes a 1×1 transparent PNG so the layout does not move. No paid image module.
- **Page numbers:** existing `PAGE`/`NUMPAGES` fields are kept; `{{page_x_of_y}}` expands to "Page {PAGE} of {NUMPAGES}" fields; the validator warns when a multi-page-capable template has none.
- **Insert-field and table-to-loop (mapping UI):** the editor shows a simplified paragraph and table view built by our parser; the user selects text (for example the underscores after "Name:") and picks a field, or marks a table as the medicines table and maps columns; the server rewrites runs (copying run properties) and produces a new draft file version. Auto-suggest maps common printed labels (Name/नाम, Age/आयु, Date/दिनांक, Rx) to fields.

### 7.3 Output and print

`renderDocx` returns `{ format: "docx", bytes, paper, title }`. The office engine converts it to PDF; the same caps as `PdfEngine` apply (PDF bytes, pages, `%PDF-` magic), a render timeout of 25 s under Gotenberg's `--api-timeout=30s`, and its own per-process limiter (1 running, 4 queued). Gotenberg's LibreOffice queue limit answers 429 when full; that maps to the existing "busy" result.

- **Draft and superseded marks** (mandatory, ADR-0032/0037): a stamp page (DRAFT or SUPERSEDED, English plus Hindi, transparent background) is rendered once per paper size and language by Chromium, which shapes Devanagari correctly, and composited onto every page of the office PDF with pdf-lib `embedPage`. pdf-lib only reads our own LibreOffice output here. Spike S3 confirms; the alternative is a watermark shape injected into the DOCX headers.
- **Print:** the print route serves the PDF; on Chromium-based browsers a hidden iframe prints it; elsewhere it opens in a new tab with "press Print". Logged when served, as today (ADR-0033).
- **Fallback:** when the office engine is down or busy, the page offers "Print on the standard ClinicPad pad instead": the same frozen snapshot on the clinic's built-in layout, an explicit choice, logged with `template_key` builtin. Presentation may change (ADR-0032 allows it); the data cannot.

---

## 8. Security of hostile uploads (invariant 8)

### 8.1 Threat model

| Threat | Where it can land | Controls |
|---|---|---|
| Macro or exploit document | LibreOffice, staff browsers | refuse `docm`/`dotm`/VBA/ActiveX/OLE; rebuild from allow-list; ClamAV before and after; LibreOffice in its own container, no egress, latest pinned 8.x |
| Remote resource or template injection (`attachedTemplate`, `INCLUDEPICTURE`, external rels, DDE) | LibreOffice fetching, data exfiltration | strip all external relationships and non-allow-listed fields (7.1 steps 5–6); Gotenberg ≥ 8.32 LibreOffice URL deny-list (deny all); network egress blocked at the host; beacon test (12.4) |
| XXE / entity expansion | our XML parser, LibreOffice | refuse `DOCTYPE`/`ENTITY`; parser with entities off |
| Zip bomb, overlapping entries, path traversal, huge entry count | app memory/CPU, LibreOffice | streaming unzip with real-byte counts and caps; refuse traversal names; rebuild |
| Image decoder exploits / polyglots | Chromium (Gotenberg, staff browsers) | byte-level PNG/JPEG walk (file must end at IEND/EOI), metadata strip, pixel caps, ClamAV; server-side re-encode deferred (needs a decoder in a sandbox) |
| Hostile PDF | pdf.js | browser-only, pinned, eval off, opaque-origin sandboxed iframe; server never parses a PDF in 2A |
| Injection through patient text into the rendered DOCX | LibreOffice | docxtemplater escapes values; raw-XML tags refused; output re-checked; XML-invalid characters stripped (control characters are already refused or removed on input, ADR-0027) |
| Cross-tenant read of templates/files | data leak | forced RLS, composite FKs, `withTenant` everywhere, cross-tenant test over every service and route (12.3) |
| Upload abuse (storage, CPU) | DB size, engine | per-user rate limit, per-tenant quotas under an advisory lock, size caps, limiters |
| Upload route CSRF | audited writes | session + role, `Sec-Fetch-Site` same-origin/none only (ADR-0033 rule), POST only |

### 8.2 Upload pipeline (2A, reused by 2B)

1. `POST /templates/uploads` route handler under `src/app/(app)/templates/` (auto-stashed for desktop; middleware matcher gains `/templates/:path*`), session + `template.write`, `Sec-Fetch-Site` check, per-user limit (30/hour), body read with a byte counter that stops at the cap (like `readCapped` in `src/server/pdf/gotenberg.ts`). Caps: images 2 MB, DOCX 4 MB (stays under Vercel's 4.5 MB request body limit if the web app runs there; signed direct-to-storage uploads wait for object storage).
2. Type from bytes, never from name or declared type; the file name is reduced to a cleaned display label (≤ 120 characters) and never logged.
3. ClamAV scan of the original bytes (clamd `INSTREAM`, 15 s timeout). Infected: refused, audited with the signature name; scanner down or timeout: refused with "try again in a minute" (fail closed; nothing stored, no quarantine table needed).
4. Kind-specific validation and sanitizing (6.3 or 7.1); metadata strip for images; second scan for rebuilt DOCX.
5. Under `pg_advisory_xact_lock` per tenant (the ADR-0039 pattern, so quotas are exact): quota check, de-duplicated insert into `template_files`, audit.

The same scanner is retrofitted onto logo and signature uploads (`storeImageAsset`, `src/server/services/assets.ts`), closing the "no malware scan" note in ADR-0035.

### 8.3 ClamAV deployment

`MalwareScanner` interface (`scan(bytes, signal) → clean | infected(signature) | unavailable`), a fake for tests, and a clamd adapter. `CLAMAV_URL` is mandatory in production, like `GOTENBERG_URL` (`resolveGotenbergUrl` pattern). Container pinned by digest, `cap_drop: ALL`, `no-new-privileges`, about 1.5–2 GB memory (measure in S4). Signature updates need egress to the ClamAV mirror: run `freshclam` as a separate sidecar that writes to a shared volume, so the `clamd` container that reads hostile files has no egress. In 2A (templates only, no patient data) a single container with freshclam is acceptable for local and staging; the split is required before 2C stores patient documents.

### 8.4 LibreOffice sandbox (2B)

Separate service `gotenberg-office`: custom fonts image built `FROM` the latest Gotenberg 8.x digest (8.32.0 or later, for the LibreOffice URL filter flags), Chromium routes disabled, LibreOffice URL deny-list = everything, `--libreoffice-restart-after` (default 10) kept to bound leaks, `--libreoffice-max-queue-size` small, `--api-timeout=30s`, `--webhook-disable`, `--api-disable-download-from`, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem with a tmpfs `/tmp` (verify Gotenberg runs that way), `mem_limit` about 2 GB, `pids_limit`, bound to 127.0.0.1 locally and a private network without NAT in production. The config-drift test pattern from `tests/integration/gotenberg-smoke.test.ts` is copied for this container.

### 8.5 Storage, quotas, retention, encryption

| Option | For | Against |
|---|---|---|
| **A. Postgres `bytea` (`template_files`)** (recommended for 2A/2B) | Same guarantees as `clinic_assets`: RLS, composite FKs, immutability triggers, tenant erasure, one transaction with the version row, India region, no new sub-processor, no orphans | Database and backup growth; Supabase disk costs more per GB than object storage; unsuitable for patient documents at scale |
| B. Object storage (Supabase Storage Mumbai or S3 `ap-south-1`) | Cheap, scales, signed direct uploads avoid the 4.5 MB body limit | Isolation is enforced only in our code (our RLS uses `app.tenant_id`, not Supabase auth), DB/object consistency and orphan cleanup, a new sub-processor/DPA for S3, retention jobs, signed-URL leakage. R2 is ruled out for PHI (no India jurisdiction) |

Sizing for A: a background is about 0.3–1 MB, a DOCX 0.1–2 MB; versions that change only boxes or mapping reuse the same file row (dedupe by hash). Expect 1–5 MB per clinic, 1–5 GB at 1,000 clinics. Revisit trigger: template bytes above 5 GB, or patient documents (2C). Quotas per tenant (plan-configurable constants): 20 active templates, 100 versions, 50 MB of template files. Unreferenced draft files older than 30 days are removed lazily at the next upload by a `SECURITY DEFINER` function (no scheduler needed); published or referenced files are kept for the tenant's lifetime. Encryption: provider-managed at rest (Supabase disk encryption) and TLS in transit; no application-level encryption for templates (business data, not PHI). Patient documents in 2C need their own decision (Q5).

### 8.6 Audit events (ids, hashes, counts, codes only; never file names or text)

`template.created`, `template_file.uploaded` (fileId, kind, byteSize, sha256, scanEngine), `template_file.rejected` (reasonCode, scan signature if infected), `template.published` (templateId, versionId, version, contentSha256, kind, fieldCount, identity, boundConfirmation), `template.assigned` (scope, doctorId, templateId, previousTemplateId), `template.archived` / `template.unarchived`, `template.previewed_with_patient` (templateVersionId, prescriptionId: a view of patient data). Output events keep their names and add `templateVersionId` and `engine`. Draft edits are not audited (drafts are working copies, ADR-0029).

### 8.7 Roles

| Action | owner | doctor | designer (new) | others |
|---|---|---|---|---|
| `template.read` | yes | yes | yes | no |
| `template.write` (upload, edit drafts) | yes | own bound templates (Q10) | yes | no |
| `template.publish` | yes | no (Q10) | no (Q10) | no |
| `template.assign` (clinic default, any doctor) | yes | own profile only | no | no |
| preview with a real patient | needs `rx.read` too | yes | **no** (no `rx.read`, no `patient.read`) | per `rx.read` |

`designer` has no patient, prescription, catalogue or settings actions; its membership carries an expiry (new `memberships.expires_at`, enforced by the JWT callback that already re-reads membership on every request, ADR-0019).

---

## 9. Rendering pipeline and output equivalence

| Kind | In-app preview | Browser print | PDF download | Share open `/s/<token>` | Works with Gotenberg down |
|---|---|---|---|---|---|
| builtin | HTML | HTML iframe | Chromium | Chromium | print yes, PDF no |
| overlay | HTML | HTML iframe (background per `printMode`) | Chromium (background always) | Chromium | print yes, PDF no |
| docx | PDF (office) | PDF iframe / new tab | LibreOffice | LibreOffice | neither; built-in fallback offered |

- **Dispatch:** `TemplateRef` gains the two kinds; `renderPrescription` stays the single entry (exhaustive switch); `RenderedDocument` gains `format: "docx"`; a `DocumentEngine` facade routes `html` to the Chromium engine and `docx` to the office engine; both keep the "never throws, typed failure, safe message" contract (`src/server/pdf/engine.ts`). The loader (`loadRxDocumentIn`) loads the version and its file inside the same `withTenant` transaction and verifies the hash.
- **Self-contained guarantee (ADR-0034):** unchanged for HTML kinds (overlay passes the same checker, served and sent only after `checkSelfContained`). For DOCX the equivalent is "sanitized package in, re-checked rendered package out, engine without network". The public share route keeps its own limiter; DOCX shares are slower, so expect more 503 "try again" answers at peak.
- **Equivalence between engines:** not claimed. Built-in and overlay output is the same HTML in browsers and Gotenberg apart from page numbers (as today). DOCX output exists only as LibreOffice PDF; fidelity is measured against a Word-exported reference (12.5). Output rows record `engine` and `renderer_version` so differences can be traced.
- **Failure modes:** office timeout (25 s) → `pdf_timeout`; LibreOffice crash or 5xx → `pdf_unavailable`; queue full / 429 / limiter full → busy with `Retry-After`; output over caps → `pdf_too_large`; refused package → `pdf_refused`; hash mismatch at reprint → `invalid` with a support message. None writes an output row (ADR-0033).
- **Gotenberg upgrade (D14):** move the Chromium container from 8.11.0 to the latest pinned 8.x in 2A before recording overlay goldens; re-run `npm run test:visual`, the smoke and drift tests, and read the PDFs (AGENTS §10). Chromium ≥ 131 `@page` margin boxes would also give built-in pads page numbers in Chrome/Edge browser print (a Phase 1C limitation), as an optional follow-up.

---

## 10. UX: the 10-minute path

### 10.1 Overlay wizard (2A), with a time budget

| Step | What the doctor does | Budget |
|---|---|---|
| 1. Choose source | "Photo or scan", "PDF", "Word file" (2A: "open it in Word, Save as PDF, upload the PDF"; 2B: direct), "Use a ClinicPad design", "Send it to us" (concierge) | 15 s |
| 2. Upload and fit | crop to the pad edges, rotate; paper proposed (A4/A5) and confirmed | 1–2 min |
| 3. Auto-layout | proposed boxes: patient strip under the letterhead (name, age/sex, date, Rx no.), body region in the largest blank area (found by a row-luminance scan in the browser), signature at the end; Hindi and English sample data shown | 30 s |
| 4. Adjust | drag/resize boxes, pick fields, font size, body style (General / Paediatric / Derma), "prints on pre-printed paper" toggle; overflow warnings from live measurement | 3–4 min |
| 5. Preview | sample (3 medicines), long sample (12 medicines → page 2), blank; real patient for owner/doctor (audited) | 1 min |
| 6. Publish and use | "Use for: me / whole clinic", confirm identity rule; "Write a test prescription" | 30 s |
| 7. First prescription | existing Phase 1 flow | 2 min |

About 8–10 minutes. Measure, do not assume: compute the funnel from audit timestamps (sign-up → `template_file.uploaded` → `template.published` → first `prescription.finalized` with a custom `template_version_id`), so no third-party analytics are needed for the exit criterion. Optional: a one-page alignment check for pre-printed paper ("print this on your pad and hold it to the light") with `printOffsetMm`.

### 10.2 DOCX flow (2B)

Upload → sanitize report in plain words ("We removed: macros, 2 links to the internet, comments") → detected fields (unknown ones explained) → if none: insert-field mode and "this table is the medicines table" → font report → preview (sample / long / blank) through the office engine → publish and assign.

### 10.3 Errors and empty states

Every refusal names the fix ("Save as a normal Word document (.docx), not .docm"; "This pad uses Kruti Dev, an old Hindi font we cannot print; send it to us and we will set it up"). The list shows each template's state (draft, published vN, assigned to whom, archived).

### 10.4 Concierge (2A process, 2C tooling)

The owner invites "ClinicPad setup" as a `designer` member that expires in 7 days (Q10). The designer prepares the template with sample data only; the owner previews with a real patient and publishes. No cross-tenant access path is built. 2C adds an internal checklist and SLA tracking.

---

## 11. Infrastructure, operations, cost

### 11.1 Services

| Service | When | Memory (estimate, measure) | Network |
|---|---|---|---|
| `gotenberg` (Chromium, exists) | now | 1 GB (current `mem_limit`) | none needed; egress blocked in production (still open from 1C) |
| `clamav` (clamd + freshclam) | 2A | 1.5–2 GB | freshclam needs the ClamAV mirror; clamd none (split before 2C) |
| `gotenberg-office` (LibreOffice + fonts) | 2B | 2 GB | none |
| worker (pg-boss) + `pdf-tools` (pdf2docx, OCRmyPDF, Tesseract eng+hin) | 2C | 2–4 GB | none |

LibreOffice converts one document at a time per container (about 1–3 s for a pad, slower after a restart). Rough peak at 100 clinics × 50 prescriptions/day with 30% DOCX pads and 1.5 outputs each: about 0.3 conversions per second at the busiest hour, within one container's capacity. Scale by adding containers; a PDF cache keyed by (template content hash, snapshot hash, renderer version) waits for object storage (ADR-0033 revisit trigger).

### 11.2 Queue

2A and 2B need no queue: uploads and sanitizing are under a second, scans a few seconds, previews 1–5 s, all bounded by limiters and timeouts and returned synchronously. 2C's PDF→DOCX and OCR take 10 s to minutes: use **pg-boss** (Postgres-backed, transactional enqueue, retries, no Redis) with a long-running worker outside the web host (serverless functions cannot run it). Tenant-visible status lives in a `document_jobs` table (forced RLS; `queued | running | succeeded | failed | cancelled`, attempts, error code, progress, input/output file ids); pg-boss's own tables carry no `tenant_id`, are granted only to the worker role, and are written on the admin connection; domain writes stay in `withTenant`. Retries: 3 with backoff for engine-unavailable, none for refused input.

### 11.3 Deployment needs that do not exist yet

1. **Staging** (Phase 0 carry-over): needed before any real pad is uploaded and for the 10-clinic exit criterion. 2A development can proceed locally.
2. **Document engines in Mumbai:** the engines see prescription content, so invariant 4 puts them in India (`docs/ARCHITECTURE.md` §9 lists "Singapore or Mumbai"; Singapore is not acceptable for PHI). Options: Fly.io `bom` or AWS `ap-south-1` (ECS/Fargate in a private subnet without NAT gives real egress blocking, which Fly.io does not obviously provide; Q4).
3. Image registry (for example GHCR) for the custom office image, pinned by digest in compose, CI and production.
4. CI jobs: ClamAV EICAR test, office smoke/drift/fonts/beacon tests, golden DOCX suite. The CI workflow has never run on GitHub (PROGRESS §5), so this is also the first real run.
5. Log hygiene for upload routes (no file names) and the existing `/s/*` rule; host body-size limits; an edge rate limit for uploads.
6. `npm audit` (25 open findings, PROGRESS 4.11) reviewed before new parsing dependencies (pdfjs-dist, docxtemplater, pizzip, an unzipper, pdf-lib) land.

### 11.4 Cost (order of magnitude, first 100 clinics)

Doc stack grows from about 1 GB to about 5 GB of container memory by 2B (Chromium 1, ClamAV 2, office 2): roughly $25–60/month more on small VMs, consistent with ARCHITECTURE §11's doc-engine line ($20–60). Postgres growth from templates: a few GB at most. 2C's OCR worker adds about $15–40/month.

---

## 12. Testing strategy

### 12.1 Pure unit tests (TDD, Vitest)

Field catalogue and `toTemplateData` (every field, en/hi/bilingual, drafts carry no Rx number or signature); overlay definition schema (ranges, unknown fields, box limits); overlay renderer golden HTML files (A4/A5, 0/3/12/30 medicines, Hindi name, no signature, draft, superseded, `pdf_only`), hostile text printed literally, every output passes `checkSelfContained`; the `render.ts` split proven by unchanged goldens; snapshot v1→v2 parsing; resolution rules (bound vs dynamic, archived, no published version); DOCX sanitizer fixture corpus (renamed `.docm`, `vbaProject.bin`, ActiveX, OLE object, external image, `attachedTemplate`, `altChunk`, DDE and `INCLUDETEXT` fields, `DOCTYPE`/XXE, billion laughs, high-ratio entry, overlapping entries, `../` and absolute names, duplicate names, encrypted entry, 10,000 entries, NUL in a name, data after the end); placeholder validator (split runs, unknown tags, unbalanced sections, raw-XML tags, `#if` normalisation); DOCX renderer (loops at 0/1/3/12/30, blanks, alt-text image swap, missing image, deterministic bytes). Property-based tests (add `fast-check`) for the unzip limits and the tag parser.

### 12.2 Integration (Postgres)

New tables under the existing RLS, composite-key and CHECK guards; published-version and file immutability triggers (including the admin connection and tenant erasure); publish, rollback, archive, assign; finalize writes `template_version_id` and snapshot v2 inside the existing lock order; reprint after the template is edited, archived, or reassigned is byte-identical (same `input_sha256`); hash mismatch fails closed; quotas exact under concurrent uploads (advisory lock); audit payloads contain no names or text.

### 12.3 Cross-tenant test (exit criterion)

For every template service and route (list, read, file bytes, preview, publish, assign, upload, background served inside a document), tenant B's ids answer `not_found`/404 and tenant B's files never appear in tenant A's rendered output. One table-driven test, so a new route without a case fails review.

### 12.4 Container tests (skip locally unless `*_REQUIRED=1`; required in CI)

ClamAV: EICAR as a plain file, inside a DOCX, inside a PNG trailer → refused. Office: DOCX→PDF smoke; config drift (flags); `fc-list` contains the bundled families; **beacon probe**: a DOCX with an external image and an `INCLUDEPICTURE` field pointing at a host listener, sent (a) through the sanitizer (beacon never hit) and (b) raw to the container with the deny-list (never hit), plus a positive control container without the deny-list (hit), mirroring the Chromium probe in `gotenberg-smoke.test.ts`.

### 12.5 Visual regression

- **Overlay:** extend `tests/e2e/rx-visual.spec.ts` (Chromium screenshots and real Gotenberg PDFs) with overlay cases; human review of the PDFs after any template, CSS, font or engine change (AGENTS §10).
- **DOCX golden suite:** 10–15 pads (synthetic ones we build in Word, LibreOffice-made ones, and, with consent and with no patient data, a few design-partner pads stored outside the repo if the owner prefers, Q9), each rendered with blank, 3, 12 and 30 medicines on A4 and A5. Two comparisons: (1) **fidelity**: LibreOffice output of the sample render against a Word-exported reference PDF of the same sample, made once by a human; (2) **regression**: against our own previous output. Rasterize at 150 dpi (pdfjs-dist with a canvas in tests, or a test container), compare with pixelmatch. Proposed tolerances (human decision, Q9): fidelity ≤ 2% differing pixels in static regions and page count equal; regression ≤ 0.1%. Plus semantic assertions from PDF text extraction: patient name, all 12 medicine names, "Page 2 of 3", nothing clipped (text inside the page box), page count.

### 12.6 End-to-end (Playwright)

Overlay flow: upload PNG and PDF → crop → boxes → preview → publish → assign → finalize → print → PDF → share link opens. Roles: reception cannot open Template Studio; designer cannot open patients or preview with a real patient. A scripted run of the wizard records the automation baseline for the 10-minute flow. DOCX flow in 2B.

### 12.7 Reviews

Opus (or human security) review on: schema and triggers, upload route and pipeline, sanitizer, renderer and checker changes, snapshot v2 and finalize changes, engine containers and flags, role changes. Consider an external review of the upload pipeline before the paid launch.

---

## 13. Risk register

| # | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Fixed-element repetition or `thead` spacers fail in Safari/Firefox print | M | M | Spike S1; per-browser fallback to the PDF print path | 2A |
| R2 | Pilot shows doctors do not want their own pad, or bring formats we did not plan for | M | H | Count formats in the pilot; 2B gated on it; GTM kill criteria (`GTM_PRICING.md` line 312) | founder |
| R3 | LibreOffice fidelity vs Word (font substitution, reflow) | H | M | Fonts image and aliases, font report, preview before publish, golden suite, overlay route via Save as PDF, concierge | 2B |
| R4 | Hostile DOCX reaches a LibreOffice bug | M | H | Rebuild from allow-list, ClamAV, isolated container without egress, digest pins, upgrade cadence, fuzz tests, reviews | 2B |
| R5 | Production host cannot block egress from engine containers | M | H | Choose host for it (Q4); beacon test on staging | ops |
| R6 | Legacy Hindi fonts (Kruti Dev) | M | M | Detect and refuse with concierge; conversion deferred | 2B |
| R7 | Phone photos make poor backgrounds | H | M | Scan/PDF guidance, crop, concierge; perspective correction later | 2A/2B |
| R8 | Setup takes more than 10 minutes | M | H | Auto-layout, defaults, live overflow warnings, measured funnel, concierge | 2A |
| R9 | LibreOffice throughput/memory at peak | L | M | Limiter, queue limit (429), restart-after, horizontal scaling, cache later | 2B |
| R10 | Licences: docxtemplater paid modules, AGPL in pdf2docx/PyMuPDF and Ghostscript (OCRmyPDF) | M | H | Core only, own image swap; legal review before 2C; pdfium-based alternatives | founder |
| R11 | Reprint differs after an engine/font upgrade | M | M | Engine and renderer version per output, golden suite on every upgrade, optional stored as-issued PDFs (Q16) | 2B |
| R12 | Prescription printed on another doctor's letterhead | M | H | Identity binding (D11), resolution skips bound templates of other doctors | 2A |
| R13 | Template bytes grow the database | L | M | Dedupe, quotas, lazy GC, monitor; object storage trigger | 2A |
| R14 | pdf.js vulnerability (CVE-2024-4367 class) | L | H | Pinned patched version, eval off, opaque-origin sandbox | 2A |
| R15 | ClamAV parser CVEs; clamd with egress | L | M | Split freshclam before 2C, pinned digest, resource limits | ops |
| R16 | Vercel 4.5 MB body limit / function duration for uploads and office previews | M | M | 4 MB DOCX cap, route handler; office calls ≤ 25 s; worker host if needed | 2B |
| R17 | Desktop export breaks with new server routes | L | M | Routes under `src/app/(app)/templates/`; `npm run build:desktop` in each gate | all |
| R18 | Phase 4: DOCX pads cannot print offline | H | M | Record as a Phase 4 constraint; overlay/built-in print offline; Option C as fallback | Phase 4 |
| R19 | Schedule: 63–92 engineer-days by task sizes vs a 4-week plan | H | M | Re-baseline (Q19); cut 2C first | founder |

---

## 14. Deferred and non-goals

Non-goals kept from ROADMAP §4: public template marketplace, Photoshop/Figma import, editing DOCX in the browser like Word.

Deferred by this design (each with its trigger): `.doc`, `.odt`, `.rtf`, `.cdr` intake (ask for `.docx` or a PDF); Kruti Dev to Unicode conversion; `{{qr}}`; phone-photo perspective correction and whitening; vector PDF backgrounds composited with pdf-lib (raster in 2A); stored "as issued" PDFs and a PDF cache (object storage); offline printing of DOCX pads and Option C compilation (Phase 4); Letter size and non-Devanagari script testing (Phase 5); branch-level assignment; template diff view (history shows versions and lets the owner republish one); EMF/WMF images in DOCX (refused); auto-accepting tracked changes; server-side image re-encoding; per-printer calibration profiles beyond one offset; designer self-publish; ClamAV split for 2A.

---

## 15. Task lists (granularity of Plan 1C/1D; sizes S ≤ 1 day, M 1–2 days, L 3–4 days)

### 15.1 Sub-plan 2A — overlay slice

| # | Task | Size | Opus review |
|---|---|---|---|
| 0 | Spikes S1 (overlay print mechanics in Gotenberg Chromium and Chrome/Edge/Safari/Firefox, PDF size, footer-strip idea), S2 (pdf.js in an opaque-origin sandboxed iframe, quality and size at 150/200/300 dpi), S5 (Gotenberg 8.11 → latest 8.x visual diff); throwaway code, findings into the plan | M | no |
| 1 | Gotenberg upgrade for the Chromium container (digest, flags, CI, smoke/drift tests, visual re-baseline with human PDF review) | M | yes |
| 2 | Schema and database guarantees for templates: `template_files`, extended `templates`/`template_versions`, assignment columns, `prescription_outputs` changes, immutability triggers, RLS, composite keys, CHECKs in Drizzle (migrations 0024+) | L | yes |
| 3 | Upload pipeline: route handler with byte cap and `Sec-Fetch-Site`, background image limits, `MalwareScanner` with ClamAV adapter, fake and compose service, EICAR tests, quotas under advisory lock, lazy GC, audit; retrofit logo/signature uploads | L | yes |
| 4 | Field catalogue and template data (pure, TDD): `TEMPLATE_FIELDS`, `toTemplateData`, sample datasets (English, Hindi, long, blank) | M | no |
| 5 | Snapshot v2 and resolution at finalize: union schema with v1 parser, identity rule, `template_version_id` written at finalize, hash check at reprint, amend rule `reset`, draft would-be resolution | L | yes |
| 6 | Split `render.ts` (pure refactor, goldens unchanged), then overlay definition schema and `renderOverlay` (pure, TDD, goldens, `checkSelfContained`) | L | yes |
| 7 | Render dispatch and output plumbing: `TemplateRef`/`RenderedDocument` unions, loader loads version + background inside `withTenant`, output log with `template_version_id`/`engine`/`input_sha256`, share route, renderer versions | M | yes |
| 8 | Role matrix (`template.*`, `designer` role, `memberships.expires_at`) and template services: create, draft edit, validate, publish, rollback, archive, assign, audit | M | yes |
| 9 | Template Studio UI 1: list, source choice, upload (image, PDF via sandboxed pdf.js), crop/rotate, paper confirmation | L | no |
| 10 | Template Studio UI 2: box editor (drag, resize, field picker, fonts, body style), auto-layout, live overflow warnings, previews (sample/long/blank/real patient with audit), publish and assign | L | no |
| 11 | Print modes: `pdf_only` background, alignment check page and print offset; per-browser print fallback from S1 | M | no |
| 12 | Cross-tenant test sweep, overlay visual tests (Chromium + Gotenberg, human PDF review), e2e overlay flow and roles, `build:desktop`, middleware matcher, ADRs 0043–0048, PROGRESS, setup notes, Gate 2A verification | M | final whole-branch review |

### 15.2 Sub-plan 2B — DOCX

| # | Task | Size | Opus review |
|---|---|---|---|
| 0 | Spikes S3 (docxtemplater core licence, split runs, `#if`, `tblHeader` overflow, alt-text image swap, deterministic output, stamp compositing, on 3–5 real pads with Mangal/Calibri/Kruti Dev) and S4 (ClamAV footprint, EICAR in DOCX, freshclam split) | M | no |
| 1 | DOCX sanitizer (pure, TDD, fixture corpus, property tests): safe unzip, type check, XML refusals, part allow-list rebuild, relationships, fields, tracked changes, deterministic package, report | L | yes |
| 2 | Office engine: custom fonts image, `gotenberg-office` service, flags, CI job, drift/fonts/beacon tests, `OfficeEngine` adapter with limiter and typed failures | L | yes |
| 3 | Placeholder grammar and validator: custom parser over the catalogue, detection, blocking errors, `#if` normalisation, publish preconditions, font and paper report, layout warnings | M | yes |
| 4 | DOCX renderer: docxtemplater configuration, loops, sections, alt-text images, `page_x_of_y`, `tblHeader` option, output re-check | L | yes |
| 5 | DOCX output path: `format: "docx"`, PDF print (iframe / new tab), stamp compositing for draft and superseded, built-in fallback, output log, share route | L | yes |
| 6 | Mapping UI: detected fields, two-column map with auto-suggest, insert-field on the paragraph view, table-to-loop, new draft file versions | L | no |
| 7 | Golden DOCX suite and tolerance harness (rasterize, pixelmatch, text assertions, Word-exported references) | L | no |
| 8 | Docs, ADRs 0049–0051, PROGRESS, Gate 2B verification with human PDF review | M | final review |

### 15.3 Sub-plan 2C — gallery, concierge, document tools

| # | Task | Size | Opus review |
|---|---|---|---|
| 1 | Built-in gallery: 5–7 more specialty definitions (ortho, ENT, gynae, dental, physio, homeopathy/Ayurveda) with goldens and visual tests | L | no |
| 2 | Concierge tooling: invite-designer flow, checklist, SLA timestamps, owner hand-over | M | yes (roles) |
| 3 | Object storage behind `BlobStore`, patient `documents` store, retention, ClamAV freshclam split | L | yes |
| 4 | pg-boss worker and `document_jobs` status model, retries, progress, deployment | L | yes |
| 5 | Document tools: merge, split, rotate, compress, watermark, page numbers (Gotenberg PDF engines or pdf-lib) in the sandbox | L | yes |
| 6 | PDF→DOCX and OCR worker container (licence-gated, Q7/Q8) | L | yes |
| 7 | Docs, ADRs 0052–0053, PROGRESS, Gate 2C and Phase 2 exit evidence | M | final review |

---

## 16. Dependencies on unresolved Phase 1 human decisions

| Open item (PROGRESS 4.10/4.11) | Blocks the pilot | Affects Phase 2 design | Needed by |
|---|---|---|---|
| Gate 1: do partners want their own pad (ROADMAP §3) | it is the pilot's question | decides 2B's priority and depth | before 2B |
| Staging (Phase 0 carry-over) | yes | real uploads, engines in Mumbai, 10-clinic criterion | before 2A exit |
| May an owner without a doctor profile finalize | yes | dynamic templates then print an empty doctor block; bound templates never apply | before 2A Task 5 |
| Data minimisation for reception and pharmacist | yes | who previews templates with real patients; whether `patient.phone` is ever a field | before 2A Task 8 |
| Superseded links stay valid 7 days with a marker | no | DOCX outputs must carry the stamp (planned) | 2B |
| Native Hindi review of all strings | yes | add Template Studio strings and field descriptions to the review | before 2A exit |
| Safari print check | yes | same check covers overlay print (S1) | 2A |
| WhatsApp Cloud API vs BSP, email residency, Resend account | yes | none (sharing path unchanged; PDF size matters if documents are sent directly later) | — |
| `npm audit` findings | no | review before new parsing dependencies | 2A Task 3 |

**Can Phase 2 start before them?** Partly. The roadmap rule is "never skip a gate", and Gate 1 is not passed. Recommendation: run the 2A spikes and 2A itself in parallel with standing up staging and recruiting the pilot, because (a) concierge onboarding of design partners collects their pads anyway, and a pilot on their own overlay pads is the best possible test of the Gate 1 question; (b) 2A reuses Phase 1 machinery and adds little that would be wasted if the answer is "billing first"; (c) none of the open decisions changes 2A's architecture, only two rules (doctor profile, real-patient preview). 2B, the expensive part, waits for pilot evidence. If the founder prefers the strict reading of the gate, the alternative is to spend the time on staging and the pilot and start 2A after Gate 1 (Q1).

---

## 17. Proposed ADRs

ADR-0043 Phase 2 sequencing (overlay first, DOCX gated on pilot evidence); ADR-0044 template model (kinds, immutable published versions, assignment columns, identity binding, resolution at finalize); ADR-0045 snapshot v2 and frozen template versions (extends ADR-0032); ADR-0046 upload pipeline and malware scanning (supersedes the "no malware scan" note in ADR-0035); ADR-0047 template files in Postgres behind a `BlobStore` seam; ADR-0048 overlay renderer inside the self-contained HTML pipeline (extends ADR-0034) and the Gotenberg upgrade; ADR-0049 DOCX sanitizer and placeholder grammar (amends ADR-0014); ADR-0050 office engine container, fonts and egress; ADR-0051 DOCX print path, stamps and built-in fallback; ADR-0052 job queue (2C); ADR-0053 object storage for patient documents (2C).

---

## 18. Open questions for the human

1. **Start before Gate 1?** Run 2A (overlay) in parallel with staging and the pilot, and gate 2B on pilot evidence, or wait for Gate 1 entirely? (Recommended: start 2A now.)
2. **Overlay first?** Approve Option B (overlay slice first) over the DOCX-first cut, and ask design partners which pad format they actually have (photo, printer's PDF, Word file, printed only)?
3. **Template storage:** accept Postgres `bytea` (`template_files`) with quotas for 2A/2B, moving to object storage only for patient documents in 2C?
4. **Engine hosting:** which Mumbai host for the document engines (Fly.io `bom` vs AWS `ap-south-1` private subnet) given that egress must be blocked, and when does staging exist?
5. **Patient documents (2C):** Supabase Storage Mumbai or S3 `ap-south-1`, with which retention period and which legal basis?
6. **Letterhead identity:** approve the rule that a template whose letterhead prints a doctor's name is bound to that doctor and never used for another finalizer; and decide whether an owner without a doctor profile may finalize (open since 1C).
7. **Licences:** confirm docxtemplater core (MIT/GPLv3) without paid modules; get a legal view on AGPL components (pdf2docx and PyMuPDF; Ghostscript under OCRmyPDF) before 2C, or choose alternatives.
8. **PDF→DOCX in Phase 2:** keep it (exit criterion "PDF→DOCX jobs succeed > 97%"), or replace it with overlay for PDFs and move PDF→DOCX to document tools later (amend the exit criterion)?
9. **Visual tolerance:** accept ≤ 2% differing pixels (static regions, 150 dpi) against a Word-exported reference and ≤ 0.1% against our previous output; and may anonymised design-partner pads be kept as goldens (in or outside the repo)?
10. **Concierge and roles:** a `designer` membership that expires after 7 days and cannot see patients; may designers or doctors publish, or only owners?
11. **Signature on overlay pads:** at the end of the content on the last page (default) or in a fixed box on every page?
12. **Pre-printed stationery printing** (data only, background in the PDF) in 2A: yes?
13. **Old formats and fonts:** refuse `.doc` and Kruti Dev pads with a concierge offer in Phase 2, or invest in conversion?
14. **Data minimisation:** is `patient.phone` ever printable, and which roles may preview a template with a real patient?
15. **Amendments:** print on the template current at the amendment's finalize (recommended) or on the parent's template version?
16. **As-issued PDFs:** should finalized prescriptions on custom templates store the issued PDF (medico-legal proof, needs object storage and retention), or keep regenerating on demand (ADR-0033)?
17. **Upload caps:** 2 MB per background image and 4 MB per DOCX (under Vercel's 4.5 MB body limit) acceptable for launch?
18. **Overlay page numbers:** off by default with an optional blank bottom band, acceptable against the "page numbering across 3 pages" criterion (DOCX and built-ins meet it fully)?
19. **Schedule:** re-baseline Phase 2 from 4 weeks (by task sizes: 2A 25–38, 2B 21–30, 2C 17–24 engineer-days; calendar time shorter with agent-driven execution), or cut 2C?
20. **Phone photos:** self-serve with crop only in 2A, or concierge-only until perspective correction exists?
21. **Free tier** (open decision #7, ADR-0011): locked preview or watermarked print for own-pad templates; this changes whether print or only preview is gated by plan in 2A.
22. **EMF/WMF logos in Word files:** refuse (ask for PNG) or accept into the sandboxed LibreOffice?

---

## 19. Spec self-review (done inline)

- Placeholders: none left; every "verify" is attached to a named spike (S1–S5) or an open question.
- Consistency: overlay is HTML everywhere (sections 5.1, 6, 9); DOCX never prints from the browser HTML path (7.3, 9); storage is Postgres in 2A/2B everywhere (3, 8.5, 11); resolution happens at finalize under the existing lock order (5.3, 15.1 Task 5).
- Scope: too large for one plan by design; split into 2A/2B/2C with gates (4.4). Only 2A goes to `writing-plans` after approval.
- Ambiguity resolved explicitly: amendments re-resolve the template (Q15 offers the alternative); drafts preview with the viewer's would-be template; bound templates are skipped, never used, for other finalizers; overlay page numbers are off by default.
- Uncertain facts, stated as such: Safari/Firefox print of fixed elements, Chromium PDF image de-duplication, docxtemplater `#if` handling and licence wording, ClamAV memory, Gotenberg read-only filesystem support, Fly.io egress controls, the share of doctors with Word files.
