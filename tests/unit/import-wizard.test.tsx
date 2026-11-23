import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ImportReport } from "@/server/services/patient-import";
import { serializeCsv } from "@/lib/csv";
import { PATIENT_TEMPLATE_ROWS } from "@/lib/import/patient-columns";
import { IMPORT_LIMITS, IMPORT_MESSAGES } from "@/lib/import/patient-rows";

const actions = vi.hoisted(() => ({ dryRunImportAction: vi.fn(), commitImportAction: vi.fn() }));
vi.mock("@/server/actions/patient-import", () => actions);

import { encodeRowSet } from "@/lib/import/commit-choices";
import { ImportWizard } from "@/components/patients/import-wizard";

const FP3 = "b".repeat(64);
const FP4 = "c".repeat(64);
const REPORT: ImportReport = {
  fileSha256: "a".repeat(64),
  checkToken: "d".repeat(64),
  headers: ["Patient Name", "Mobile", "DOB", "Age"],
  mapping: { name: 0, phone: 1, dob: 2, gender: null, address: null, allergies: null, notes: null },
  ageColumns: ["Age"],
  needsName: false,
  totals: { rows: 4, new: 1, duplicate: 2, alreadyImported: 0, invalid: 1 },
  rows: [
    { row: 2, status: "new", name: "Asha Rao", dob: "1990-08-15" },
    {
      row: 3,
      status: "duplicate",
      name: "Meera Shah",
      rowDob: null,
      rowGender: "female",
      matches: [{ patientNo: 7, name: "Meera Shah", sameName: true, basis: "phone", dob: "1985-01-02", gender: "female" }],
      duplicateOfRow: null,
      canFill: true,
      canCreate: true,
      fingerprint: FP3,
    },
    { row: 4, status: "duplicate", name: "Meera Shah", rowDob: null, rowGender: "unknown", matches: [], duplicateOfRow: 3, canFill: false, canCreate: false, fingerprint: FP4 },
    { row: 5, status: "invalid", field: "name", message: "Enter the patient's name", cells: ['=HYPERLINK("http://evil")', "+91 1", "", ""] },
  ],
};

const blobs: Blob[] = [];
function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

beforeEach(() => {
  actions.dryRunImportAction.mockReset();
  actions.commitImportAction.mockReset();
  blobs.length = 0;
  Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => (blobs.push(b), "blob:test")), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

function chooseFile(size = 100) {
  const file = new File(["x".repeat(size)], "patients.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
  return file;
}

async function check() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check file" }));
  });
}

describe("ImportWizard", () => {
  it("refuses a file over the server-action cap in the browser, before anything is sent", () => {
    render(<ImportWizard />);
    chooseFile(IMPORT_LIMITS.maxBytes + 1);
    expect(screen.getByText(IMPORT_MESSAGES.tooLarge)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check file" }));
    expect(actions.dryRunImportAction).not.toHaveBeenCalled();
  });

  it("checks the file, shows the report, and imports with the owner's choices, token and fingerprints", async () => {
    actions.dryRunImportAction.mockResolvedValue({ report: REPORT });
    actions.commitImportAction.mockResolvedValue({
      summary: { importId: "i", created: 2, filled: 0, skipped: 1, alreadyImported: 0, invalid: 1, staleRows: [], staleCount: 0, firstPatientNo: 8, lastPatientNo: 9 },
    });
    render(<ImportWizard />);
    const file = chooseFile();
    await check();
    const sent = actions.dryRunImportAction.mock.calls[0][0] as FormData;
    expect(sent.get("file")).toBe(file);
    expect(sent.get("mapping")).toBeNull();

    expect(await screen.findByText("1 ready to import")).toBeInTheDocument();
    expect(screen.getByText("2 possible duplicates")).toBeInTheDocument();
    expect(screen.getByText("1 with problems")).toBeInTheDocument();
    expect(screen.getByText(/Not imported: Age/)).toBeInTheDocument();
    expect(screen.getByText("Enter the patient's name")).toBeInTheDocument();
    expect(screen.getByLabelText("Name (required)")).toHaveValue("0");
    // Both sides' details are shown so the owner can judge.
    expect(screen.getByText(/Patient #7 Meera Shah \(born 1985-01-02, female; same name and phone\)/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Row 4.*Register as a new patient/ })).toBeDisabled();
    expect(screen.queryByRole("radio", { name: /Row 4.*Add the missing details/ })).toBeNull();

    expect(screen.getByRole("button", { name: "Import 1 patient" })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: /Row 3.*Register as a new patient/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import 2 patients" }));
    });
    const committed = actions.commitImportAction.mock.calls[0][0] as FormData;
    expect(committed.get("choices")).toBe(`c3.${FP3.slice(0, 8)}`);
    expect(committed.get("dups")).toBe(encodeRowSet([3, 4]));
    expect(JSON.parse(String(committed.get("mapping")))).toEqual(REPORT.mapping);
    expect(committed.get("sha")).toBe(REPORT.fileSha256);
    expect(committed.get("token")).toBe(REPORT.checkToken);
    expect(await screen.findByText(/Imported 2 patients \(#8 to #9\)/)).toBeInTheDocument();
  });

  it("lists rows skipped as stale and tells the owner to review again", async () => {
    actions.dryRunImportAction.mockResolvedValue({ report: REPORT });
    actions.commitImportAction.mockResolvedValue({
      summary: { importId: "i", created: 1, filled: 0, skipped: 1, alreadyImported: 0, invalid: 1, staleRows: [3], staleCount: 1, firstPatientNo: 8, lastPatientNo: 8 },
    });
    render(<ImportWizard />);
    chooseFile();
    await check();
    await screen.findByText("1 ready to import");
    fireEvent.click(screen.getByRole("radio", { name: /Row 3.*Register as a new patient/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import 2 patients" }));
    });
    expect(await screen.findByText(/1 row was skipped because the matching patients changed.*rows 3.*Review them again/)).toBeInTheDocument();
  });

  it("marks the report stale when the mapping changes, and checks again with the new mapping", async () => {
    actions.dryRunImportAction.mockResolvedValue({ report: REPORT });
    render(<ImportWizard />);
    chooseFile();
    await check();
    await screen.findByText("1 ready to import");
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "" } });
    expect(screen.queryByRole("button", { name: /^Import \d/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    });
    const sent = actions.dryRunImportAction.mock.calls[1][0] as FormData;
    expect(JSON.parse(String(sent.get("mapping")))).toMatchObject({ name: 0, phone: null });
  });

  it("downloads the problem rows as a formula-safe CSV with a BOM", async () => {
    actions.dryRunImportAction.mockResolvedValue({ report: REPORT });
    render(<ImportWizard />);
    chooseFile();
    await check();
    fireEvent.click(await screen.findByRole("button", { name: "Download problem rows" }));
    const bytes = await readBytes(blobs[0]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text.split("\r\n")[0]).toBe("Patient Name,Mobile,DOB,Age,Row,Problem");
    expect(text).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(text).toContain("'+91 1");
    expect(text).toContain("Name: Enter the patient's name");
  });

  it("renders hostile cell text as text, never as markup", async () => {
    const hostile: ImportReport = {
      ...REPORT,
      headers: ["<img src=x onerror=alert(1)>", "Mobile", "DOB", "Age"],
      rows: [{ row: 2, status: "new", name: "<b>Bold</b>", dob: null }],
      totals: { rows: 1, new: 1, duplicate: 0, alreadyImported: 0, invalid: 0 },
    };
    actions.dryRunImportAction.mockResolvedValue({ report: hostile });
    const { container } = render(<ImportWizard />);
    chooseFile();
    await check();
    expect(await screen.findByText("<b>Bold</b>")).toBeInTheDocument();
    expect(container.querySelector("b, img")).toBeNull();
  });

  it("offers the template as a download", async () => {
    render(<ImportWizard />);
    fireEvent.click(screen.getByRole("button", { name: "Download the template" }));
    const bytes = await readBytes(blobs[0]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(serializeCsv(PATIENT_TEMPLATE_ROWS));
  });

  it("shows a server error and keeps the chosen file", async () => {
    actions.dryRunImportAction.mockResolvedValue({ error: "This file is not saved as UTF-8.", field: "file" });
    render(<ImportWizard />);
    chooseFile();
    await check();
    await waitFor(() => expect(screen.getByText("This file is not saved as UTF-8.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Check file" })).toBeEnabled();
  });

  it("turns a thrown action into a message instead of crashing", async () => {
    actions.dryRunImportAction.mockRejectedValue(new Error("network"));
    render(<ImportWizard />);
    chooseFile();
    await check();
    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Check file" })).toBeEnabled();
  });

  it("turns a thrown import into a message and keeps the report", async () => {
    actions.dryRunImportAction.mockResolvedValue({ report: REPORT });
    actions.commitImportAction.mockRejectedValue(new Error("boom"));
    render(<ImportWizard />);
    chooseFile();
    await check();
    await screen.findByText("1 ready to import");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import 1 patient" }));
    });
    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(screen.getByText("1 ready to import")).toBeInTheDocument();
  });
});
