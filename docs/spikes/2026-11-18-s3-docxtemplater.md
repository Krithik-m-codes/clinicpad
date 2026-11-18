# S3 finding: docxtemplater core readiness for Plan 2B

Date: 2026-11-18. Plan 2A Task 5. Throwaway code: `spikes/s3-docxtemplater/` (git-ignored; nothing added to the project's `package.json` or lockfile). Synthetic DOCX files built by the probe; no real pads were tested (none supplied). Decision: input for 2B planning; gates nothing in 2A.

## Verdict: GO (core docxtemplater only, with five rules for 2B)

The free core renders split-run tags, a repeating medicines row, optional sections and Devanagari. LibreOffice (Gotenberg) repeats the `w:tblHeader` row on every page. Errors on malformed templates are structured and cheap. The two things the plan hoped for that do not work as written are `{{#if x}}...{{/if}}` (needs a rule below) and image tags (done with plain ZIP edits instead of the paid module).

## Packages (read from `npm view` and the installed `package.json`; installed with `--save-exact`)

| Package | Version | `license` field | Integrity |
|---|---|---|---|
| docxtemplater | 3.71.1 (npm `latest`) | `MIT` | `sha512-lXX1FNYwwe/md6WYmNE/1MRjbGN3h0SFdVxKQ3fiIRFvKp0TqgJinylu144iWwPJeALa36jmgGKxk54bGx7bSA==` |
| pizzip | 3.3.0 | `(MIT OR GPL-3.0)` | `sha512-seR2ALUYS4Z0GCs0sVwXWImhBsoCImXpHr+ExNfIZ9G0czvHqpUxlJgwHCl1BBHFyU3nUFmZJPFEEWbpY8cKRg==` |
| pdf-lib | 1.17.1 | `MIT` | `sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==` |
| pdfjs-dist (probe only) | 5.7.284 | `Apache-2.0` | see the S2 finding |

First paragraph of each LICENSE file, verbatim (no conclusion about legal compliance: that is the human's Q7):

- docxtemplater `LICENSE.md`: "docxtemplater is dual licensed. You may use it under the MIT license *or* the GPLv3 license."
- pizzip `LICENSE.markdown`: "PizZip is dual licensed. You may use it under the MIT license _or_ the GPLv3 license."
- pdf-lib `LICENSE.md`: "MIT License" followed by "Copyright (c) 2019 Andrew Dillon".

Only the core package is used. No paid module (image, HTML, slides, table, etc.) is installed or needed.

## Environment

Gotenberg `gotenberg/gotenberg:8.11.0` (already local, the version compose pins; LibreOffice routes on, Chromium routes disabled), started as a private container `clinicpad-office-spike` on 127.0.0.1:3003 with `--memory 2g`, removed afterwards. Other containers were not touched. Node 22.19.0. Fonts in the image include Noto Sans/Serif Devanagari and Sarai.

## Results

### Tags split across runs: works
`Name: {{pat` + `ient.na` (bold) + `me}}` renders as `Name: Asha Rao`. The lexer rejoins tags across runs, so Word's habit of splitting text is not a problem.

### Conditionals and loops

| Case | Result |
|---|---|
| `{{#patient.allergies}}...{{/patient.allergies}}` | Shown for a non-empty string, hidden for `""` and for a missing key. |
| `{{^patient.allergies}}...{{/patient.allergies}}` (inverted) | Works ("No known allergies"). |
| `{{#if patient.allergies}}...{{/if}}` | **Fails at compile time** (`closing_tag_does_not_match_opening_tag`: tag "if patient.allergies" is closed by "if"). The lexer pairs the raw tag text before the parser runs, so a custom `parser` that strips `if ` cannot fix it (also fails with the default parser). |
| `{{#if patient.allergies}}...{{/}}` | Works (empty closing tag closes the innermost section). |
| `{{#if patient.allergies}}...{{/if patient.allergies}}` | Works when the parser strips the `if ` prefix (closing text must equal the opening text). |
| Expressions (`{{#if n > 1}}`, `{{#n == 2}}`) | No expression language in core: the tag is looked up as a literal name, found nothing and silently renders nothing. A typo or unsupported syntax hides content without an error. |
| Nested section and loop (`{{#a}}{{#b}}[{{x}}]{{/b}}{{/a}}`) | Works. |
| Prototype access (`{{constructor}}`, `{{__proto__}}`, `{{patient.constructor}}`) | Rendered empty with the strict own-property parser and also with the default parser. The probe parser walks the scope stack with `Object.hasOwn`. |
| Special XML characters in data | Escaped (`<w:p>&evil</w:p>` becomes text). A NUL (and other XML-illegal chars) in data raises `invalid_xml_characters` instead of producing a corrupt file. |

### Medicines table: row loop with a repeated header

Template: header row with `<w:trPr><w:tblHeader/>`, one body row (min height 1500 twips) holding `{{#medicines}}{{name}}` in the first cell and `{{duration}}{{/medicines}}` in the last. With `paragraphLoop: true` the whole row repeats.

- 3 medicines: 4 rows (1 header and 3 data rows); header row count stays 1 in the XML.
- 0 medicines: the data row disappears; the header stays (1 row).
- LibreOffice via Gotenberg: 12 rows gives 2 pages (9 + 3 rows), 30 rows gives 4 pages (9, 9, 9, 3); `MEDHEAD` appears on every page in both cases. The `tblHeader` repeat works.
- A loop opened and closed in different table rows or outside the table (open in a paragraph before the table, close missing) is an `unclosed_loop` error, not silent output.

### Image swap without the paid module
- **Swapping the media bytes works.** Keep a placeholder `word/media/logo.png` in the template with an inline drawing, render, then `doc.getZip().file("word/media/logo.png", newBytes)` before generating. LibreOffice drew the replacement (120x60) and not the placeholder (40x40). The extent in the drawing stays that of the template, so 2B should keep the aspect ratio by resizing the replacement to the placeholder's pixel box or by writing `a:ext`.
- **Conditional logo works** by wrapping the paragraph that holds the drawing in a section (`{{#hasLogo}}`...`{{/hasLogo}}`): 1 image in the PDF with the logo, 0 without.
- **Raw XML tag `{{@logoXml}}` works only with a full paragraph value.** A tag alone in a paragraph replaces the whole `w:p`, so the value must be `<w:p><w:r><w:drawing>...</w:drawing></w:r></w:p>` (a bare `w:r` or drawing produced invalid XML and no image). The relationship id and the media file must already exist in the package; 2B needs a small helper to add `word/_rels/document.xml.rels` entries and `[Content_Types].xml` defaults. Raw XML is a hostile-input surface: only ever pass XML built by our code.

### Devanagari
Hindi in data (`आशा राव`, `पेनिसिलिन से एलर्जी`, `पैरासिटामोल ५००`) lands in the DOCX and the PDF text layer contains Devanagari. LibreOffice embedded `NotoSansDevanagari-Regular` (plus Carlito for Latin). Extracted text shows shaping artefacts (glyph ids without ToUnicode), so text extraction is not a reliable check of correct conjuncts: **human visual check of a Hindi PDF is PENDING.** For a template that names a font the server image lacks (for example Kruti Dev or a Mangal-only pad) LibreOffice substitutes silently; 2B should warn about unavailable fonts at upload.

### Error behaviour on malformed templates
All compile-time, thrown from `new Docxtemplater(zip)` as `TemplateError` with `message: "Multi error"` and `properties.errors[]` (each with `properties.id`, `explanation`, `xtag`, `offset`, `file`). Around 1.5 ms. Two simultaneous problems come back as two entries.

| Template problem | `id` |
|---|---|
| `{{#medicines}}` never closed | `unclosed_loop` |
| `{{/medicines}}` never opened | `unopened_loop` |
| `{{#a}}...{{/b}}` | `closing_tag_does_not_match_opening_tag` |
| `{{patient.name` | `unclosed_tag` |
| `patient.name}}` | `unopened_tag` |
| `{{}}` | none: renders as empty text silently |
| Not a ZIP | plain `Error` ("Can't find end of central directory") |
| ZIP without a recognisable document part | `InternalError` `filetype_not_identified` |
| NUL or XML-illegal char in data | `invalid_xml_characters` (at render) |
| `{{#medicines}}` with data `"notalist"` | no error: renders once as a truthy section |

The library also logs thrown errors with `console.error`; production code should catch and map `properties.errors` into our own publish-time issue list and not rely on the message text. Unknown keys render empty through `nullGetter` (the probe returned `""`); a stricter `nullGetter` that records the missing tag would let publish-time validation refuse templates with unknown tags.

ZIP size: PizZip and docxtemplater impose no inflate limit. The 200 MB inflate probe was rejected before inflating only because it lacked package parts, so it is **not conclusive**; 2B must read `uncompressedSize` of each ZIP entry (and the entry count) before constructing `Docxtemplater`.

### Determinism and PDF stamping
- Two renders of the same template and data are byte-identical when `generate({ date: new Date(0) })` is used (1,387 bytes in the probe).
- `pdf-lib` `embedPdf` plus `drawPage` stamped a "DRAFT" page onto every page of the 4-page LibreOffice PDF; the stamp text and the table header both remain on all pages (output 12.6 KB).

### Performance (single process, warm, Node 22)

| Operation | Time |
|---|---|
| Compile (`new Docxtemplater`) of the small pad | about 1 to 2 ms |
| Render + ZIP generate, 5 medicines | about 3.3 ms |
| Render + ZIP generate, 30 medicines | about 3.9 to 5.3 ms |
| Render + ZIP generate, 500 medicines | about 26 to 35 ms |
| RSS growth over about 220 renders | about 38 MB (no GC pressure forced; not a leak test) |
| DOCX to PDF in Gotenberg (30 medicines, 4 pages) | about 165 to 565 ms (first call slower) |

Real pads with images, headers and long styles will be heavier; the figures show the library is not the bottleneck, LibreOffice is.

## Rules for the 2B plan
1. The sanitizer/validator must reject or normalise `{{#if x}}...{{/if}}`. Recommended grammar: `{{#x}}...{{/x}}` and `{{^x}}...{{/x}}` (name repeated on close). `{{#if x}}...{{/}}` works but is not recommended (an author cannot see which section an empty close ends). Pick one spelling and document it in the Studio help.
2. Use a strict own-property parser and a recording `nullGetter` so unknown tags fail at publish, not silently at print. There are no comparisons: any "if more than one medicine" logic must be precomputed into booleans in the render data.
3. Images via media-byte swap (and a paragraph-level `@` raw tag when a position must move); never the paid module. Resize to the placeholder box.
4. Pre-validate the uploaded ZIP (entry count, per-entry and total uncompressed size, no macros, no external relationships) before docxtemplater touches it.
5. Output DOCX must use fixed ZIP dates for reproducibility; stamp or compose with pdf-lib after conversion.

## Pending and out of scope
- Real pads (none supplied), Word's own table-header behaviour, header/footer parts and text boxes (tags inside text boxes and headers were not probed).
- Human visual check of Devanagari conjuncts in the PDF; fonts missing from the Gotenberg image.
- Legal review of the dual MIT/GPL licences (Q7).
- Probe-only note: `npm audit` on the spike folder flags `pdfjs-dist` 5.7.284 (GHSA-hq66-cqwq-w95j, high: arbitrary JavaScript execution upon opening a malicious PDF; affected `>=5.6.83 <6.2.108`). S2's ratified version is 5.7.284, so Task 16 (and the controller) should review it. The probe set `isEvalSupported:false` and parsed only PDFs we made.
