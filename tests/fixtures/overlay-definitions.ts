/** A valid overlay definition for A4 (Task 11's schema accepts it; tests/unit/overlay-definition.test.ts pins that). */
export const MINIMAL_OVERLAY_DEFINITION = {
  v: 1,
  background: { printMode: "always" },
  boxes: [
    { id: "b1", field: "patient.name", xMm: 20, yMm: 52, wMm: 90, hMm: 7, fontPt: 11, align: "left", bold: true, repeat: "every_page" },
    { id: "b2", field: "visit.date", xMm: 150, yMm: 52, wMm: 40, hMm: 7, fontPt: 10, align: "right", bold: false, repeat: "every_page" },
  ],
  flow: {
    topMm: 64,
    bottomMm: 27,
    leftMm: 15,
    rightMm: 15,
    bodyStyle: "general",
    sections: ["vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp"],
    showRxMark: true,
  },
  signature: { mode: "end_of_content" },
  pageNumbers: { bandMm: 0 },
  printOffsetMm: { x: 0, y: 0 },
} as const;
