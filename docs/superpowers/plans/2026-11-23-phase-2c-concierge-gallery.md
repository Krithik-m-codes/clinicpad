# Phase 2C slice 1: concierge designer invite and built-in specialty gallery

Spec: `docs/superpowers/specs/2026-11-18-phase-2-template-studio-design.md` sections 10.4 and 15.3 (tasks 1 and 2 only).
Branch: `phase-2c-concierge-gallery`. ADRs from 0052 (0049 is reserved for 2B). Migrations from 0029.
Out of scope: object storage, pg-boss, document tools, PDF to DOCX (tasks 3 to 6 need legal and hosting decisions).

## Task A: owner-only "invite designer" (security-sensitive, Opus review)

Design (ADR-0052, the smaller safe option): the owner creates a dedicated designer account. No email is sent and no
public set-password route is added.

- New action `designer.manage` (owner only) in the role matrix.
- Service `src/server/services/designers.ts`: `inviteDesigner`, `extendDesigner`, `revokeDesigner`, `listDesigners`.
  The role is hard-coded `designer`; the tenant comes from the session context only.
- Invite: email, name, days (integer 1 to 30, default 7). New email: create a user with a random one-time password
  (bcrypt hash stored, plaintext shown once in the hand-over note, never audited or logged). Existing email: refused,
  unless the user's only memberships are a designer membership of this same clinic (re-invite: new password, new expiry,
  reactivated). Reason: sign-in picks the oldest active membership, so an existing account with another clinic could
  never reach this one, and resetting its password would be an account takeover.
- At most 5 unexpired active designers per clinic.
- Extend: new expiry = now + days (1 to 30), must be later than the current expiry; refused for revoked memberships.
- Revoke: status `disabled`; the next request refuses the session.
- Audit (same transaction): `designer.invited`, `designer.extended`, `designer.revoked` (ids and dates only).
- UI: `/settings/designers` (owner only): invite form, hand-over note with copy, table of designers with status and
  expiry, extend and revoke. Link from settings.
- Tests: unit (matrix, hand-over note, password generator), integration (service behaviour, audit, expiry, role matrix
  for all roles, cross-tenant, designer stays templates-only), e2e (invite, sign in as designer, templates only, extend,
  revoke, sign-in refused).

## Task B: built-in specialty gallery

Six new built-in pads, code only: `ortho`, `ent`, `gynae`, `dental`, `physio`, `ayush` (Ayurveda and homeopathy).
- `PAD_TEMPLATES` = the three originals plus the six. `BUILTIN_TEMPLATES` stays the original three because the frozen
  overlay v1 schema uses it for `flow.bodyStyle` (ADR-0044); the overlay schema is untouched.
- Definitions in `templates.ts` (section order, vitals, medicine layout, accent). The clinical form is fixed, so a pad
  differs by emphasis, not by new fields.
- Snapshot stays `v: 1` (additive key). Migration 0029 widens `clinics_rx_template_check` and
  `rx_outputs_template_key_check` (and the Drizzle schema).
- Tests: unit invariants for every pad, goldens for each new pad, Gotenberg smoke over all pads, visual spec cases
  (human look at the PNGs and PDFs).

## Finish
lint, typecheck, full vitest with CLAMAV_REQUIRED=1 CI=true GOTENBERG_REQUIRED=1, designer and pad e2e on a free port,
`drizzle-kit generate` shows no drift, `build:web`, `build:desktop`, docs (PROGRESS 4.13, AGENTS.md, DECISIONS 0052+).
