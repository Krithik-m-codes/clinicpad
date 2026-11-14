# ClinicPad

**Your prescription pad, digitised — for the whole clinic.**

ClinicPad is a clinic operating system that starts with the one thing every doctor already owns: their prescription pad. Upload your existing Word/PDF letterhead, map it once, and every prescription prints exactly the way your patients expect. Then run the rest of the clinic around it — patients, appointments, billing, WhatsApp sharing, analytics, and compliance.

> **Status:** pre-alpha. The repository currently contains the original single-doctor prescription generator (Next.js + Tauri + IndexedDB). The product spec, architecture, roadmap, and execution plan are in [`docs/`](docs/). Phase 0 has not started.

---

## Why this exists

Most clinic software forces a doctor onto a generic prescription layout. Doctors refuse to switch because their letterhead is part of their identity, and because re-learning a workflow costs them patients-per-hour. ClinicPad inverts that:

1. **Bring your own pad (BYOP).** Upload a `.docx` or `.pdf`; we detect placeholders, map them, and publish a smart template in minutes. Scanned pads can be OCR'd or used as an overlay.
2. **Offline-first.** The desktop app keeps working when the internet doesn't. Sync when it's back.
3. **WhatsApp-native.** Send the prescription PDF from the clinic's own WhatsApp number.
4. **Owner-grade visibility.** Collections, doctor-wise revenue, outstanding balances, and leakage — not just clinical notes.
5. **India-ready, globally priced.** ABDM/ABHA, GST invoicing, DPDP controls, Indian languages — with a path to HIPAA/GDPR.

---

## Product bets

| Bet | Why it wins |
|---|---|
| Template fidelity is the wedge | No major Indian competitor markets "upload your Word pad". It is the fastest demo-to-value moment in the category. |
| Offline + desktop is a moat in Tier 2/3 | Internet outages are normal. Cloud-only competitors lose the consultation. |
| Prescription → clinic OS land-and-expand | Start at ₹499/month for a solo doctor; grow into appointments, billing, and multi-branch. |
| White-label for resellers | Local IT vendors and medical reps already sell to clinics. Give them a product to own. |
| Transparent pricing, no message markup | Builds trust in a market trained to expect hidden costs. |

---

## Target customer

- **Beachhead:** solo and small-practice doctors (1–5 doctors) in Tier 2/3 India — general medicine, paediatrics, dermatology, orthopaedics, ENT, gynaecology, dental, physiotherapy, homeopathy/Ayurveda.
- **Expansion:** polyclinics, 2–10 branch chains, teleconsult-only practices, medical camps.
- **International (later):** solo/allied-health practices in the Gulf, Southeast Asia, UK, and US.

---

## Repository map

```
clinicpad/
├─ src/                      # Next.js 15 app (App Router) — existing prescription UI
│  ├─ app/                   # routes: /, /preview, /patient-infos, /manage
│  ├─ components/            # shadcn/ui + prescription components
│  ├─ contexts/              # PrescriptionContext (to be replaced by server-backed store)
│  └─ lib/                   # IndexedDB layer, utils, translations
├─ src-tauri/                # Tauri v2 desktop wrapper
├─ public/                   # logos, watermarks, sample assets
├─ sample_data/              # CSV import templates
├─ docs/                     # product, market, architecture, roadmap, progress
│  └─ superpowers/           # specs + implementation plans
├─ scripts/                  # developer scripts (environment checks)
├─ .opencode/                # project-level agent configuration
├─ AGENTS.md                 # agent operating manual + project memory
└─ CLAUDE.md                 # Claude Code entry point (imports AGENTS.md)
```

---

## Documentation

| Document | What it answers |
|---|---|
| [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) | Who it is for, jobs-to-be-done, full feature specification, non-goals, success metrics |
| [`docs/MARKET_RESEARCH.md`](docs/MARKET_RESEARCH.md) | How Practo Ray, HealthPlix, Eka, MedPrax, Cliniko, SimplePractice and others operate and what they charge |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Stack, multi-tenancy, offline sync, document engine, security, deployment |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Core entities and multi-tenant schema |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased plan with exit criteria and revenue gates |
| [`docs/GTM_PRICING.md`](docs/GTM_PRICING.md) | Pricing, packaging, channels, onboarding, unit economics |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | Live status tracker — update this as work lands |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Architecture decision records (ADRs) |
| [`docs/SETUP.md`](docs/SETUP.md) | Local development, tooling, and Superpowers verification |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | Formal design spec |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | Implementation plans |

---

## Quick start (current legacy app)

Prerequisites: Node.js 22+, npm 11+, Git. Rust + Tauri prerequisites only for the desktop build.

```bash
npm install
npm run dev          # http://localhost:3000
npm run build:web    # server build
npm run build:desktop # static export for the Tauri shell (legacy offline app)
npm run tauri:dev    # desktop development
npm run tauri:build  # desktop installer
```

The current app stores everything in IndexedDB and hard-codes one doctor's identity in the preview page. Do not treat it as production data handling. The migration plan is in [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Working with AI agents

This repo is set up for agent-assisted development using the **Superpowers** skill pack (brainstorming → writing plans → executing plans → TDD → verification).

- Read [`AGENTS.md`](AGENTS.md) first. It is the project memory and operating manual.
- Skills are installed globally at `~/.agents/skills` (OpenCode) and `~/.claude/skills` (Claude Code).
- Verify the install: `powershell -ExecutionPolicy Bypass -File scripts/check-superpowers.ps1`
- Project-level config: [`.opencode/opencode.jsonc`](.opencode/opencode.jsonc)

---

## License / confidentiality

Proprietary. Not open source. Do not distribute without permission.
