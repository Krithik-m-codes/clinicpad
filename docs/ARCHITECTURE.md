# ClinicPad — Architecture

**Status:** proposed target architecture
**Date:** 2026-11-06
**Constraint:** the current repo is a static-exported Next.js + Tauri app. We migrate incrementally; do not big-bang rewrite.

---

## 1. Design goals

| Goal | Implication |
|---|---|
| Multi-tenant SaaS | Tenant isolation in the database, not just the app layer |
| Works offline | Local durable store + outbox + sync protocol |
| Prescription fidelity | Server-side rendering with pinned fonts and conversion engines |
| India-first compliance | Mumbai data residency, DPDP controls, ABDM path, GST |
| Sell to clinics, not enterprises | Self-serve onboarding, low ops overhead, predictable costs |
| White-label ready | Branding and domain per tenant/reseller |
| Clinical safety | Immutable versions, audit trail, no data loss |

---

## 2. Stack

### Chosen

| Layer | Choice | Why |
|---|---|---|
| Web framework | Next.js 15 (App Router), React 19, TypeScript | Already in repo; SSR + server actions; Vercel `bom1` for India |
| UI | Tailwind CSS v4 + shadcn/ui + Radix | Already in repo; fast, accessible |
| Database | PostgreSQL 16+ | Relational clinical data, strong constraints, RLS |
| DB hosting (MVP) | Supabase (Mumbai / `ap-south-1`) | Postgres + Auth + Storage + RLS in one; self-host path |
| ORM | Drizzle | Typed SQL, migrations, good RLS support; avoid Prisma's engine overhead |
| Auth | Supabase Auth (MVP) | Email/password, OTP, Google; RLS integration; MFA |
| Storage | Supabase Storage / S3-compatible (R2 or MinIO) | Signed URLs; India region for PHI |
| Queue | pg-boss (Postgres) or BullMQ + Redis | Async PDFs, WhatsApp, reminders, imports |
| Cache | Redis (Upstash) | Sessions, rate limits, hot data |
| Document engine | Gotenberg (Chromium + LibreOffice) + `pdf2docx` + OCRmyPDF/Tesseract | Battle-tested conversions; self-hostable |
| DOCX templating | docxtemplater | Loops, conditionals, images; mature |
| Desktop | Tauri v2 + SQLite | Small binaries, native printing, offline |
| Web offline | IndexedDB (Dexie) + service worker | PWA fallback |
| Payments (India) | Razorpay | UPI, cards, net banking, subscriptions |
| Payments (intl) | Stripe | Cards, subscriptions, tax |
| WhatsApp | Meta Cloud API behind an adapter | Cheapest; provider abstraction for BSPs |
| Email | Resend or Postmark | Transactional |
| Observability | Sentry + Axiom/Better Stack + PostHog | Errors, logs, product analytics |
| CI/CD | GitHub Actions → Vercel + Fly.io/Railway + Supabase migrations | Simple, low ops |
| Monorepo | Turborepo (Phase 0) | Shared UI/types; separate web/desktop/doc-engine |
| Testing | Vitest + Testing Library + Playwright | Unit, component, E2E |
| Lint/format | ESLint + Prettier | Consistency |

### Rejected / deferred

- **MongoDB:** clinical data is relational; reporting needs SQL.
- **Firebase:** weak relational queries and RLS; vendor lock-in; India residency concerns.
- **Electron:** heavier than Tauri; Tauri already in repo.
- **Kubernetes:** premature; Fly.io/Railway + Vercel is enough until 1,000+ clinics.
- **Microservices:** start modular monolith; extract only the doc engine and queue workers.
- **GraphQL:** REST/server actions are simpler for this team size.

---

## 3. Repository target structure

```
clinicpad/
├─ apps/
│  ├─ web/                 # Next.js web + PWA
│  └─ desktop/             # Tauri wrapper (reuses web build)
├─ packages/
│  ├─ ui/                  # shadcn components
│  ├─ core/                # domain types, schemas, business rules
│  ├─ db/                  # Drizzle schema, migrations, RLS policies
│  ├─ templates/           # built-in HTML templates + renderer
│  └─ config/              # eslint, tsconfig, tailwind presets
├─ services/
│  ├─ doc-engine/          # Gotenberg + pdf2docx + OCR (Node or Python)
│  └─ worker/              # queues: PDFs, WhatsApp, reminders, imports
├─ infra/
│  ├─ docker-compose.dev.yml
│  ├─ supabase/            # migrations, seed, RLS tests
│  └─ terraform/           # optional later
├─ docs/
└─ scripts/
```

**Migration approach:** Phase 0 moves the existing Next.js code into `apps/web` and the Tauri shell into `apps/desktop`, keeping behaviour identical. Do not mix the restructure with feature work.

---

## 4. Multi-tenancy

### 4.1 Model

- `tenants` = clinics (a clinic can have branches).
- `branches` belong to a tenant.
- `users` are global identities.
- `memberships` connect user ↔ tenant ↔ branch with a role.
- Every clinical/business table has `tenant_id` (required) and optionally `branch_id`.
- `tenant_id` is never accepted from the client; it is resolved from the authenticated membership and injected server-side.

### 4.2 Postgres RLS

```sql
alter table patients enable row level security;

create policy patients_tenant_isolation on patients
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  with check (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);
```

- Use a `security definer` function to resolve the active tenant and role.
- Branch-level policies layer on top for staff restricted to one branch.
- Run RLS tests in CI: every table must reject cross-tenant reads/writes.
- Service-role keys are server-only and never shipped to the client.

### 4.3 Roles

| Role | Scope | Capabilities |
|---|---|---|
| Owner | Tenant | Everything, billing, users, exports |
| Doctor | Branch(es) | Patients, visits, Rx, own analytics |
| Reception | Branch | Registration, appointments, queue, billing |
| Nurse | Branch | Vitals, queue, documents |
| Pharmacist | Branch | Dispensing (P2), inventory (P2) |
| Accountant | Tenant | Billing, reports, exports (no clinical notes) |

Permissions are checked in the API **and** enforced by RLS where possible.

---

## 5. Offline-first and sync

### 5.1 Why

Tier 2/3 clinics lose internet daily. A cloud-only app fails at the worst moment. Offline is also a desktop selling point.

### 5.2 Model

- **Local store:** SQLite (Tauri) / IndexedDB (web).
- **Source of truth for the session:** local store. UI reads locally, writes locally.
- **Outbox:** every mutation appends an operation with an idempotency key.
- **Sync engine:** push outbox → server; pull changes since a cursor.
- **Server sequence:** `server_seq` monotonically increasing per tenant; clients store the last seen cursor.
- **IDs:** UUIDv7 generated on the client (time-ordered, collision-resistant).
- **Clock:** server timestamps win for ordering; client timestamps kept for display only.

### 5.3 Conflict policy

| Data | Policy |
|---|---|
| Demographics, contact, preferences | Last-write-wins per field; show a conflict prompt for simultaneous edits |
| Appointments | Last-write-wins with a conflict banner; never silently double-book |
| Vitals, visit notes | Append-only versions; amendments create a new version |
| Finalized prescriptions | **Immutable.** Amendments create a new version with a reason and audit entry |
| Invoices/payments | Append-only ledger entries; corrections are reversing entries |
| Files | Content-addressed; deduplicate; never overwrite a finalized document |

### 5.4 Sync UX

- Status indicator: "All changes saved", "3 changes waiting", "Offline".
- Background sync every 30 seconds and on reconnect.
- Manual "Sync now" and a conflict center.
- Hard rule: the UI must not show "Saved" until the local write is durable.

### 5.5 What works offline

- Patient lookup and creation.
- Prescription drafting/finalizing and printing (local PDF via desktop print).
- Appointments and queue.
- Billing drafts and cash receipts.
- Viewing previously synced documents.

Not offline in v1: WhatsApp sending, online payments, ABDM operations, template uploads (queue them).

---

## 6. Document and template engine

### 6.1 Rendering pipeline

```
Data (visit + clinic + doctor)
  → Renderer
      ├─ HTML template (React/Handlebars) → HTML
      └─ DOCX template (docxtemplater)   → DOCX
  → Gotenberg
      ├─ /forms/chromium/convert/html
      └─ /forms/libreoffice/convert
  → PDF (A4/A5/Letter)
  → store (signed URL) + thumbnail
  → print / WhatsApp / email
```

### 6.2 Service design

- `services/doc-engine` exposes:
  - `POST /render` — template ID + data + options → PDF
  - `POST /convert` — file + target format (pdf/docx)
  - `POST /ocr` — scanned PDF → searchable PDF/DOCX
  - `POST /transform` — merge/split/compress/watermark
  - `GET /health`
- Stateless; jobs are queued and retried.
- Isolated containers: no network, CPU/memory/time limits, read-only filesystem, non-root user.
- Pin LibreOffice, Chromium, and font versions. Visual regression tests on every upgrade.
- Bundle: Noto Sans, Noto Serif, Noto Sans Devanagari, Noto Sans Gujarati/Tamil/Telugu/Bengali/Kannada/Malayalam, plus a Latin serif/sans pair.
- Store rendered PDFs in object storage with a content hash; cache by `(template_version, data_hash)`.

### 6.3 DOCX templating

- docxtemplater with `paragraphLoop` and `linebreaks`.
- Custom filters for Indian date formats, currency, and dosage formatting.
- Loop blocks for medicines/tests; conditional blocks for allergies/remarks.
- Table row repetition must be tested at 1, 5, 12, and 30 rows.
- Images: signature/stamp/logo inserted as data URIs or template assets.
- Validation rejects unknown placeholders before publishing.

### 6.4 Overlay mode

- For scanned pads: store page images + a JSON of field boxes (x/y/w/h, font, size, align).
- Render text over the image at print DPI; repeat the background for overflow pages.
- Good for legacy pads; DOCX is the recommended path.

### 6.5 PDF generation guarantees

- Deterministic page count for the same input/version.
- Header/footer repeated on every page.
- Signature block on the last page.
- No clipped text; overflow moves to a continuation page.
- QR code optional; watermark optional.
- PDF/A option for archival.

---

## 7. Authentication and security

### 7.1 Auth

- Email/password + phone OTP (India) + Google.
- MFA (TOTP) for Owner and Doctor roles; enforceable per tenant.
- Session rotation, device list, revoke sessions.
- Invite links expire; role is assigned server-side.
- Rate limiting on login, OTP, and password reset.

### 7.2 Data protection

- TLS 1.3 everywhere; HSTS.
- Encryption at rest (provider-managed; field-level for ABHA/phone if needed).
- Signed, short-lived URLs for documents (≤ 5 minutes).
- Upload validation: MIME sniffing, extension allowlist, size limit, ClamAV scan, macro stripping.
- No PHI in logs, error messages, analytics, or URLs.
- Sentry scrubbing and a deny-list for patient fields.
- Backups: PITR + daily encrypted snapshots; 30-day retention; quarterly restore drills.
- Data residency: India tenants in `ap-south-1`. International tenants in their region later.

### 7.3 Audit

Append-only `audit_events`:

```
id, tenant_id, actor_id, action, entity_type, entity_id,
before_hash, after_hash, ip, user_agent, created_at, metadata
```

Actions include `patient.view`, `patient.export`, `prescription.finalize`, `prescription.print`, `prescription.share`, `template.publish`, `user.role_change`, `billing.refund`, `data.export`, `data.delete`.

### 7.4 Compliance posture

- **India:** DPDP Act 2023 (notice, consent, purpose limitation, data principal rights, breach notification), Clinical Establishments Act record retention, GST, Telemedicine Practice Guidelines 2020, ABDM when integrated.
- **International:** HIPAA (BAA, risk analysis, access controls, audit, backups), GDPR/UK GDPR (DPA, SCCs, data residency, DSARs).
- Publish a subprocessor list, security page, and DPA.
- Annual penetration test before enterprise sales.

---

## 8. API design

- Next.js route handlers + server actions for the app.
- Public REST API (P2) with API keys, scopes, rate limits, and OpenAPI docs.
- Webhooks with HMAC signatures and retries.
- Idempotency keys on payments, messages, and sync operations.
- Consistent error envelope: `{ code, message, details, requestId }`.
- Pagination: cursor-based.
- Versioning: `/api/v1/...`.

---

## 9. Deployment

### MVP

| Component | Host |
|---|---|
| Web | Vercel (Mumbai `bom1`) |
| DB/Auth/Storage | Supabase (Mumbai) |
| Doc engine | Fly.io / Railway (Singapore or Mumbai) |
| Worker | Fly.io / Railway |
| Redis | Upstash (Mumbai) |
| WhatsApp | Meta Cloud API |
| Email | Resend |
| Monitoring | Sentry + Axiom + PostHog |

### Scale path

- Move doc engine to AWS `ap-south-1` ECS/Fargate when volume justifies.
- Add read replicas for analytics.
- Partition large tables by tenant/time if needed.
- Consider self-hosted Supabase or RDS for enterprise/white-label.
- Add a CDN for static assets and template previews.

### Environments

- `local` — Docker Compose (Postgres, Gotenberg, MinIO, Redis).
- `preview` — per-PR Vercel preview + shared staging DB (anonymised).
- `staging` — production-like, synthetic data.
- `production` — India region.

### CI/CD

- PR: lint → typecheck → unit tests → build → Playwright smoke.
- Main: migrations (expand/contract) → deploy web → deploy doc engine → smoke.
- Migrations are backward-compatible for one release; never drop a column in the same deploy that stops using it.
- Feature flags for risky changes.

---

## 10. Observability

- **Errors:** Sentry with release tags and PHI scrubbing.
- **Logs:** structured JSON; request ID; no PHI.
- **Metrics:** p50/p95 latency for save, render, share; queue depth; failure rates; per-tenant usage.
- **Product analytics:** PostHog events (`clinic_created`, `template_published`, `rx_finalized`, `rx_shared`, `payment_collected`).
- **Alerts:** render failure > 1%, queue backlog > 5 min, DB connections > 80%, payment webhook failures.
- **Status page:** external, with incident history.

---

## 11. Cost model (order of magnitude, first 100 clinics)

| Item | Monthly estimate (USD) |
|---|---|
| Vercel Pro | 20–100 |
| Supabase Pro (Mumbai) | 25–100 |
| Doc engine (1 small VM/container) | 20–60 |
| Redis | 10–30 |
| Storage + bandwidth | 10–50 |
| WhatsApp (pass-through) | variable; ~₹0.115/utility message |
| Email | 10–20 |
| Sentry/PostHog/Axiom | 0–100 |
| **Total infra** | **~$100–$450/month** |

At 100 clinics × ₹799/month (~$950/month), infra is ~10–45% of revenue before support. Keep the doc engine efficient and cache renders.

---

## 12. Testing strategy

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest | Dosage formatting, date/currency, template mapping, permissions |
| Integration | Vitest + Postgres | RLS isolation, repositories, migrations |
| Component | Testing Library | Forms, pickers, template mapper |
| E2E | Playwright | Signup → template → patient → Rx → PDF → share |
| Visual | Playwright screenshots | Template rendering across 1/5/12/30 medicine rows |
| Security | RLS test suite + ZAP/pen test | Cross-tenant access, upload abuse |
| Load | k6 | 50 concurrent clinics, PDF queue |

**Definition of done for a feature:** tests pass, RLS covered, audit event emitted where relevant, docs updated, `docs/PROGRESS.md` updated.

---

## 13. Migration plan from the current app

1. **Freeze behaviour** — tag the current repo state.
2. **Restructure** — move `src/` to `apps/web/src`, `src-tauri/` to `apps/desktop/src-tauri`; keep builds green.
3. **Split configs** — web uses server output; desktop uses static export. Two Next configs or an env switch.
4. **Introduce the domain layer** — move types and pure logic into `packages/core`.
5. **Add the server** — Postgres, Drizzle, auth, RLS; keep IndexedDB as a local cache initially.
6. **Port one vertical slice** — patient + prescription save/read from Postgres.
7. **Port the template renderer** — replace the hard-coded preview with a template.
8. **Add sync** — outbox + pull; desktop uses SQLite.
9. **Remove legacy paths** — delete hard-coded doctor data, old print hacks, unused code.

Do not attempt steps 5–8 in one branch.
