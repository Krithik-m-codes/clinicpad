"""Test helper (tests/integration/overlay-spacer-pdf.test.ts): per page, the y range (mm from the page top) of the
word "Medicine" (the medicine table heading and the medicine names), the page height and the page count of a PDF.
Needs PyMuPDF (pip install pymupdf); prints JSON on stdout."""
import json
import sys

import fitz

MM = 25.4 / 72
pages = []
with fitz.open(sys.argv[1]) as doc:
    for index, page in enumerate(doc):
        rows = [w for w in page.get_text("words") if w[4] == "Medicine"]
        pages.append(
            {
                "page": index + 1,
                "heightMm": round(page.rect.height * MM, 2),
                "firstMm": round(min(w[1] for w in rows) * MM, 2) if rows else None,
                "lastBottomMm": round(max(w[3] for w in rows) * MM, 2) if rows else None,
            }
        )
print(json.dumps(pages))
