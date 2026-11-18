# ClinicPad — Setup Guide

**Last updated:** 2026-11-12
**Applies to:** Windows 10/11 (PowerShell), macOS, Linux
**Goal:** a new developer can clone, install, run, and verify ClinicPad in under 30 minutes.

---

## 1. Prerequisites

| Tool | Version | Why | Check |
|---|---|---|---|
| Node.js | 22 LTS or newer | Next.js 15 / React 19 | `node -v` |
| npm | 11+ | Package manager | `npm -v` |
| Git | 2.40+ | Version control | `git --version` |
| Docker Desktop | current | Postgres, Gotenberg, ClamAV | `docker --version` |
| Rust + Cargo | stable | Tauri desktop only | `rustc --version` |
| PowerShell | 7+ (Windows) | Setup scripts | `$PSVersionTable.PSVersion` |

Optional: `pnpm` is **not** used — stay on npm to match `package-lock.json`. VS Code with ESLint, Tailwind CSS IntelliSense, and rust-analyzer is recommended.

> **Windows note:** enable long paths if `tauri build` fails with path-length errors:
> `git config --system core.longpaths true` (admin PowerShell), then reboot.

---

## 2. Clone and install

```powershell
cd E:\projects
git clone <repo-url> clinicpad
cd clinicpad
npm install
```

For the existing local copy (no remote yet):

```powershell
cd E:\projects\clinicpad
npm install
```

Expected: install completes without `ERESOLVE`. If peer-dependency conflicts appear, do **not** use `--force`; fix the version instead.

---

## 3. Environment variables

Copy the template and fill in local values:

```powershell
Copy-Item .env.example .env.local
```

`.env.local` is git-ignored. Never commit real secrets.

### 3.1 Variables that exist today

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | yes | Canonical URL, used in links and auth callbacks; the base of share links (`/s/<token>`). An https origin with no path in production, or sharing is unavailable |
| `NODE_ENV` | auto | `development` / `production` |

### 3.2 Variables added in Phase 0

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Pooled Postgres connection (Supabase port 6543) |
| `DIRECT_URL` | yes | Direct connection for migrations (port 5432) |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL (if Supabase Auth) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Public anon key (RLS-protected) |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | Admin tasks; never expose to the client |
| `AUTH_SECRET` | yes | Session signing (32+ random bytes) |
| `ENCRYPTION_KEY` | yes | Field-level encryption for sensitive data |
| `GOTENBERG_URL` | for PDFs and shared PDFs; mandatory in production | PDF service (Gotenberg); defaults to `http://localhost:3001` outside production, and the app reports the PDF service as down in production when it is unset or not an http(s) URL |

Generate secrets:

```powershell
# 32-byte base64 secret
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

### 3.2b Variables added in Plan 1D (sharing)

| Variable | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY`, `EMAIL_FROM` | optional | Email sharing of prescription links. Without both, the Share panel hides email; tests never set them. `EMAIL_FROM` must be on a domain verified with Resend. Turn click and open tracking OFF for that domain in the Resend dashboard (a tracking redirect would pass the share token to the provider) |
| `SHARE_CLIENT_IP_HEADER` | production, non-Vercel hosts | Name of the header your proxy sets with the real client address (and strips from client requests). The public share route rate-limits on it and never reads `X-Forwarded-For`; production logs a warning once when no such header arrives, and then all callers share one bucket |

Production notes for sharing: use an https `NEXT_PUBLIC_APP_URL` (otherwise "Sharing is not set up on this server"); `GOTENBERG_URL` is required (shared PDFs render on the server); the share-route rate limits are per process, so add an edge rate limit in front of `/s/`; the share token is in the URL path, so web server, proxy, CDN and analytics logs must not retain full `/s/*` URLs; install with lifecycle scripts enabled (`postinstall` applies `scripts/patch-react-ping.mjs`, ADR-0042). A local `next start` also needs `AUTH_TRUST_HOST=true`.

### 3.3 Variables added in later phases

| Variable | Phase | Purpose |
|---|---|---|
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | 2 | Template and PDF storage |
| `CLAMAV_HOST`, `CLAMAV_PORT` | 2A | Upload scanning (clamd). Default `127.0.0.1:3310` outside production; both mandatory in production. Uploads are refused while the scanner is unreachable |
| `CLAMAV_DISABLED_FOR_DEVELOPMENT`, `CLAMAV_DISABLED_ACK` | dev only | Skip scanning: works only with `NODE_ENV=development`, the flag `1`, AND `CLAMAV_DISABLED_ACK=unscanned-uploads-on-this-machine`; in any other case the flag makes every upload fail. Do not use it for e2e or demos |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | 3 | India payments |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | 5 | International payments |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN` | 3 | Meta Cloud API |
| `SMS_PROVIDER_KEY` | 0/3 | OTP fallback |
| `SENTRY_DSN` | 0 | Error tracking |
| `CRON_SECRET` | 3 | Protect scheduled jobs |

---

## 4. Local services

`docker-compose.yml` runs `postgres` (5432), `gotenberg` (127.0.0.1:3001, prescription PDFs) and `clamav` (127.0.0.1:3310, upload scanning). Start them with `docker compose up -d`; without Gotenberg the app still works, Print still works, and Download PDF shows an error. On this project's Windows machine Docker Desktop lives under `%LOCALAPPDATA%\Programs\DockerDesktop`.

Target compose stack:

```yaml
services:
  postgres:   # port 5432, db clinicpad, user clinicpad
  gotenberg:  # port 3001, document conversion
  clamav:     # port 3310, upload scanning (uploads are refused while it is down)
  redis:      # port 6379, queues (Phase 3+)
```

Start:

```powershell
docker compose up -d
docker compose ps
```

Stop:

```powershell
docker compose down
```

Reset local data (destructive):

```powershell
docker compose down -v
```

### 4.1 Database

First-time local setup (needs `.env.local`, see section 3):

```powershell
docker compose up -d postgres
npm run db:migrate    # apply migrations (creates the clinicpad_app role and RLS)
npm run db:seed       # demo clinic: 3 staff, 50 patients, 20 prescriptions
npm run db:seed:catalogue   # global medicine and clinical-term lists (idempotent; db:seed also runs it; safe in production)
npm run db:sweep-test-tenants            # list leftover test tenants (local databases only); add -- --apply to delete them
```

Demo login after seeding: `owner@demo.clinicpad.app` / `ClinicPad!2026` (also `doctor@...` and `reception@...`). The seed is idempotent and refuses to run when `NODE_ENV=production`.

Other commands:

```powershell
npm run db:generate   # generate a migration from schema changes
npm run db:studio     # inspect data
```

Three connection strings are used on purpose: `DATABASE_URL` (RLS-bound `clinicpad_app` role, used by feature code via `withTenant()`), `DIRECT_URL` (migrations), and `ADMIN_DATABASE_URL` (sign-up, seed, and auth lookups only).

Connection string for local Postgres:

```
postgresql://clinicpad:clinicpad@localhost:5432/clinicpad
```

For Supabase staging, use the pooled URL in `DATABASE_URL` and the direct URL in `DIRECT_URL`. Migrations always use `DIRECT_URL`.

---

### 4.2 Document engine (Gotenberg)

`docker compose up -d gotenberg` starts the digest-pinned Gotenberg image with JavaScript disabled, a Chromium deny-list, no webhooks or download-from, and the API bound to loopback only (it has no authentication). Check it with `curl http://localhost:3001/health` or the app's `GET /api/health/pdf`. Prescription documents embed their fonts and images, carry a `default-src 'none'` CSP, and are checked before they are sent, so Gotenberg never needs network access: in staging and production run it with no egress (no outbound network from its container) and copy the flag set from `docker-compose.yml`. Set `GOTENBERG_URL` explicitly in production. After upgrading the image, run `npm run test:visual` (it also writes the real PDFs to `test-results/rx-visual-pdf/`) and review the screenshots and PDF pages. Set `GOTENBERG_REQUIRED=1` to make `npm run test` fail instead of skipping when Gotenberg or docker is missing (CI does this).

### 4.3 Malware scanner (ClamAV)

`docker compose up -d clamav` starts the digest-pinned ClamAV image (clamd on 127.0.0.1:3310, no authentication) with the hardening of `docs/spikes/2026-11-18-s4-clamav.md`: all capabilities dropped except CHOWN, SETUID, SETGID, DAC_OVERRIDE and FOWNER, `no-new-privileges`, read-only root, tmpfs `/tmp`, `/run` and `/var/log/clamav`, and a 2500 MB memory limit (a signature reload doubles clamd memory for about 15 s). It runs with `CLAMAV_NO_FRESHCLAMD=true`: it never calls out, and the signatures baked into the image load in about 20 s (no multi-minute first download; the empty named volume is filled from the image on first start). The container is healthy when `docker compose ps clamav` says so. Uploads of logos, signatures and pad background images are scanned before anything is stored; if the scanner is down they are refused with a message to try again, never accepted unscanned.

Updating signatures is a separate job with egress: `docker compose --profile update run --rm clamav-update`, then `docker compose restart clamav` (about 16 s; or send clamd `zRELOAD`, scans keep working). Schedule it a few times a day in staging and production. Docker does not publish ports of containers on an internal network, so on a developer machine the scanner sits on the default bridge; true egress blocking (production) needs the app in a container on the same internal network or a host firewall (open hosting question).

Uploads are scanned twice, the original and the metadata-stripped bytes that are stored, so the stored bytes are always bytes the scanner saw. CSV imports are not scanned by decision (text parsed and validated, never stored as a file). Tests never need clamd: they use `tests/helpers/fake-scanner.ts`. `tests/integration/clamav-smoke.test.ts` runs against the real container when it is up (EICAR detection, `VERSION` format, and a drift check of the container options) and skips otherwise; `CLAMAV_REQUIRED=1` or `CI=true` turns the skip into a failure. CI starts the same image and options with `CLAMAV_NO_FRESHCLAMD=true`. `tests/e2e/pad-settings.spec.ts` uploads a real logo and signature, so run it with the scanner up (`docker compose up -d postgres gotenberg clamav`).

## 5. Run the app

```powershell
npm run dev
```

Open http://localhost:3000.

Other commands:

```powershell
npm run build:web      # server build (this is what staging/production run)
npm run build:desktop  # static export for Tauri (legacy offline shell only, ADR-0021)
npm run start          # run the production web build (locally needs AUTH_TRUST_HOST=true, an https NEXT_PUBLIC_APP_URL for sharing, and GOTENBERG_URL)
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm run test           # Vitest (unit + integration; integration needs Postgres running)
npm run test:e2e       # Playwright (starts the dev server; needs Postgres, Gotenberg for the PDF checks, and one-time `npx playwright install chromium`)
npm run test:visual    # print-layout screenshots (opt-in, per-platform baselines)
node scripts/verify-gate-0.mjs   # everything above, in order
```

> **Windows gotcha:** run the tests from a path with an uppercase drive letter (`E:\projects\clinicpad`). If your terminal opens in `e:\...`, vitest loads two module instances and every test fails with `Cannot read properties of undefined (reading 'config')`.

Desktop:

```powershell
npm run tauri:dev      # dev with hot reload
npm run tauri:build    # installer in src-tauri/target/release/bundle
```

Desktop builds use the static export path (ADR-0012). Do not run `tauri:build` against a server-mode build.

---

## 6. Superpowers verification

ClinicPad uses the Superpowers skills for design, planning, TDD, debugging, and verification. They are installed globally; the repo only verifies them.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check-superpowers.ps1
```

Expected output: each required skill found under at least one of:

- `C:\Users\<you>\.agents\skills` (OpenCode)
- `C:\Users\<you>\.claude\skills` (Claude Code)

Required skills: `brainstorming`, `writing-plans`, `executing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `using-git-worktrees`, `finishing-a-development-branch`.

If a skill is missing, install Superpowers per its upstream instructions, then re-run the script. Do not copy skills into this repo.

---

## 7. Project structure (target)

```
clinicpad/
├── AGENTS.md                  # agent memory (read first)
├── CLAUDE.md                  # Claude entry point
├── docs/
│   ├── PRODUCT_SPEC.md
│   ├── MARKET_RESEARCH.md
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── ROADMAP.md
│   ├── GTM_PRICING.md
│   ├── PROGRESS.md
│   ├── DECISIONS.md
│   ├── SETUP.md
│   └── superpowers/
│       ├── specs/
│       └── plans/
├── scripts/
│   └── check-superpowers.ps1
├── src/
│   ├── app/                   # routes
│   ├── components/            # UI + domain components
│   ├── contexts/              # client state (legacy, shrinking)
│   ├── lib/
│   │   ├── db/                # IndexedDB (legacy) + Drizzle
│   │   ├── domain/            # pure domain logic
│   │   └── ...
│   ├── server/                # server-only: auth, actions, services
│   └── types/
├── src-tauri/                 # desktop shell
├── drizzle/                   # SQL migrations (Phase 0)
├── public/
└── sample_data/
```

Rules:

- `src/server/**` is server-only. Never import it from a client component.
- Domain logic goes in `src/lib/domain/**` and is unit-tested.
- Route files stay thin: parse input, authorize, call a service, render.

---

## 8. Clean-clone verification

Run this before declaring setup "done" or merging a setup change:

```powershell
git clone <repo-url> clinicpad-verify
cd clinicpad-verify
Copy-Item .env.example .env.local   # fill values
npm ci
npm run lint
npm run typecheck
npm run test
npm run build
```

All commands must exit `0`. Then start the app and check:

- [ ] Sign-up page loads
- [ ] A clinic can be created
- [ ] Demo seed data appears
- [ ] `GET /api/health` returns `{ "status": "ok" }`

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `next: command not found` | Dependencies not installed | `npm install` |
| Port 3000 in use | Another dev server | `npm run dev -- -p 3001` |
| `output: export` error mentioning dynamic routes | Server feature used in desktop build | Use web build, or move the route behind a client boundary |
| Type errors suddenly visible | `ignoreBuildErrors` removed in Phase 0 | Fix them; do not re-enable the flag |
| Tauri build fails: `cargo not found` | Rust not installed | Install via rustup, restart terminal |
| Tauri build fails: path too long (Windows) | Long-path limit | Enable `core.longpaths`, reboot |
| Postgres auth error | Wrong URL / pooler vs direct | Check `DATABASE_URL` vs `DIRECT_URL` |
| RLS returns zero rows | Session tenant not set | Verify `app.tenant_id` is set in the transaction |
| Migration hangs | Locked table / wrong DB | Check `pg_stat_activity`; use direct connection |
| Uploading a logo or signature says the virus scanner is not available | ClamAV not running or still loading signatures | `docker compose up -d clamav`; wait for `healthy` (about 20 s) |
| Download PDF says the PDF service is not reachable | Gotenberg not running | `docker compose up -d gotenberg`; then `curl http://localhost:3001/health` |
| Share panel says "Sharing is turned off for this clinic" | Off by default | The owner turns it on in Settings, Sharing (after reviewing the consent text) |
| A shared link says "This link is not valid" | Expired (7 days), used 10 times, withdrawn, consent withdrawn, patient archived, or sharing switched off | Share again from the prescription page |
| WhatsApp template rejected | Missing approval / wrong category | Check Meta Business Manager; use an approved template |
| `npm ci` fails after lockfile change | Lockfile out of sync | Run `npm install`, commit `package-lock.json` |

### Logs

```powershell
docker compose logs -f postgres
docker compose logs -f gotenberg
```

Application errors: browser console + server terminal + Sentry (once configured).

---

## 10. Security hygiene for developers

- Use a password manager; never paste secrets into chat or tickets.
- `.env*` is git-ignored — verify with `git status` before committing.
- Use demo data only. Never copy a real patient's records into a dev database.
- Run `npm audit` before releases; do not ignore high/critical findings.
- Do not disable RLS "temporarily". If a query needs cross-tenant access, write an audited admin path.
- Do not commit generated PDFs or uploaded templates containing patient data.

---

## 11. Definition of a working environment

- [ ] `npm run dev` serves the app
- [ ] `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` all pass
- [ ] Local Postgres is up and migrations applied
- [ ] Seed data loads
- [ ] Superpowers check passes
- [ ] You can sign in, create a clinic, and see the dashboard
- [ ] No secrets in `git status`
