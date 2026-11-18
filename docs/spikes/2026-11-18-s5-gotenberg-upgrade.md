# Spike S5: Gotenberg 8.11.0 to 8.40.0

Date: 2026-11-18. Plan 2A Task 4. Verdict: **GO**.

## Decision

```
GOTENBERG_IMAGE=gotenberg/gotenberg:8.40.0@sha256:53073e798c8ef39ea2187e44cb67bab77894ea2509100b94c4fe3b461f7b2996
FLAGS=gotenberg --api-timeout=30s --api-disable-download-from --webhook-disable --libreoffice-disable-routes --pdfengines-disable-routes --chromium-disable-javascript=true "--chromium-deny-list=^(?!file:///tmp/|data:|about:|blob:).*" --log-level=warn
CHROMIUM=156.0.8078.79 (Debian 13 trixie; 8.11.0 shipped Chrome 129)
LIBREOFFICE_URL_FLAGS=--libreoffice-deny-list, --libreoffice-allow-list, --libreoffice-deny-private-ips, --libreoffice-deny-public-ips
```

The flag list is unchanged from `docker-compose.yml`. Task 6 changes only the image reference.

## Method

- `docker pull gotenberg/gotenberg:8` resolved to label `org.opencontainers.image.version=8.40.0` (digest `sha256:53073e79...`). `docker pull gotenberg/gotenberg:8.40.0` returned the same digest, and `RepoDigests` agrees. Nothing was typed from memory.
- The candidate ran as a scratch container `clinicpad-s5-gotenberg` on 127.0.0.1:3011 with the project flags plus `--cap-drop ALL`, `no-new-privileges`, `--memory 1g` and `--pids-limit 512`. The project containers `clinicpad-gotenberg` (8.11.0) and `clinicpad-postgres` were not touched. The scratch container has been removed.
- `gotenberg --help` of the image was saved to `spikes/s5-gotenberg/help.txt` (ignored).

## Flags

All eight flags exist in the 8.40.0 help under the same names: `--api-timeout`, `--api-disable-download-from`, `--webhook-disable`, `--libreoffice-disable-routes`, `--pdfengines-disable-routes`, `--chromium-disable-javascript`, `--chromium-deny-list`, `--log-level`. None was renamed or removed.

Behaviour on the running scratch container: `/health` reports chromium and libreoffice up; `POST /forms/libreoffice/convert` and `POST /forms/pdfengines/merge` answer 404 (routes disabled).

New in 8.x (not needed for 2A): `--chromium-allow-list`, `--chromium-deny-private-ips`, `--chromium-deny-public-ips`, and the LibreOffice flags above. For 2B (DOCX conversion) use `--libreoffice-deny-private-ips` plus a deny-list, in addition to running the conversion container with no outbound network.

## Smoke test

`tests/integration/gotenberg-smoke.test.ts` was run against the candidate (`GOTENBERG_REQUIRED=1`, `GOTENBERG_URL=http://localhost:3011`). The file hard-codes the container names and the image used by the positive control, so a temporary copy with the scratch container name and the new image was used and deleted afterwards (the committed file is unchanged; Task 6 updates its `IMAGE` constant). Result: 10 passed, 1 skipped (the skipped item is the "Gotenberg is required" guard, which only runs when the engine is down). Covered: all template and paper renders, the deny-list probe with zero beacon hits with and without the document CSP, config drift (all seven flags and the 127.0.0.1 binding), and the positive control (a Gotenberg without the deny-list does see the beacon, so the zero-hit assertions are meaningful on the new image).

## Visual suite old vs new

`RX_VISUAL=1` `tests/e2e/rx-visual.spec.ts` (24 tests) passed against both versions (run with a temporary Playwright config without the dev server, because port 3000 was held by an unrelated process). Eight real PDFs were compared with pdf.js 5.7.284:

| PDF | pages old / new | extracted text |
|---|---|---|
| general-a4-en, general-a4-30-medicines, general-a4-draft-watermark, general-a5-long-hostile | equal | identical |
| derma-a4-hindi, general-a5-draft-watermark, paediatric-a5-bilingual, paediatric-a5-bilingual-30-medicines | equal | differs, see below |

All eight have the same page count. The four text differences are Devanagari conjuncts only: 8.11.0 extracted `उम्र`, `क्रमांक`, `रूप` and `मान्य` with NUL characters in place of the conjunct glyphs, and 8.40.0 extracts the real characters. That is a text-mapping improvement in the newer Chromium, not a layout change. The PDFs are larger on 8.40.0 (about 1.5x to 5x, for example 26 KB to 67 KB for `general-a4-en`), probably from font embedding differences; all stay small.

**Human check PENDING:** a person must open each old/new pair (`spikes/s5-gotenberg/old` and `new`, ignored) and confirm fonts, spacing, page breaks and footers. Nothing measured shows a regression, but no one has looked yet.

## Background image is now written once (override 16(c))

`probe-jpeg.mjs` (S1) was re-run against 8.40.0 (`spikes/s5-gotenberg/probe-new.txt`). Image objects in the Gotenberg PDF, A4, noisy JPEG background:

| Background | pages | 8.11.0 images / size | 8.40.0 images / size |
|---|---|---|---|
| 590 KB | 3 | 3 / 1.9 MB | 2 / 1.2 MB |
| 590 KB | 10 | 10 / 6.4 MB | 1 / 0.63 MB |
| 1.99 MB | 3 | 3 / 6.1 MB | 1 / 2.0 MB |
| 1.99 MB | 10 | 10 / 20.4 MB | 1 / 2.0 MB |
| worst case (2 MB bg + 512 KB logo + 512 KB signature, 9 pages) | | 18 images / 23.5 MB | 2 images / 2.6 MB |

The per-page duplication is gone: the image is stored once (one case shows 2 copies over 3 pages, a sporadic duplicate that Playwright's own Chromium also produces). The 10-page 2 MB case drops from 20.4 MB (over the 15 MiB cap) to 2.0 MB, and the worst case is far under the cap. Every page still paints the image. HTML lengths are unchanged from S1 (2 MB + 512 KB + 512 KB is 4,131,354 characters, 62,950 under `MAX_DOCUMENT_CHARS`), so the HTML-cap constraints of override 3 are unaffected.

Consequence for the plan, once Task 6 lands: the PDF size estimate can become `bg + logo + signature` plus a small allowance (conservatively one extra image copy per two pages) instead of `pages x (bg + logo + sig)`. Keep the friendly "too large for download, use Print" refusal as a safety net, based on the actual output size. The background cap (16(b)) is also driven by the HTML cap, so it stays as decided.

## Notes

- This applies only after Task 6 pins the new image; until then the running 8.11.0 container still duplicates the image per page.
- Task 6 must update `docker-compose.yml`, `.github/workflows/ci.yml` and the `IMAGE` constant in the smoke test to the same tag and digest, then re-run the smoke test and the visual suite on the real compose container.
- Firefox and Safari print checks from S1 remain PENDING and are independent of this upgrade.
