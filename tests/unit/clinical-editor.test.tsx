import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  autosave: vi.fn(),
  finalize: vi.fn(),
  removeFavourite: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/server/actions/drafts", () => ({
  autosaveDraftAction: mocks.autosave,
  finalizeDraftAction: mocks.finalize,
}));
vi.mock("@/server/actions/catalogue", () => ({
  saveFavouriteAction: vi.fn(),
  removeFavouriteAction: mocks.removeFavourite,
  addClinicMedicineAction: vi.fn(),
}));

import { ClinicalEditor } from "@/components/rx/clinical-editor";
import { FINALIZE_TIMEOUT_MS } from "@/components/rx/use-autosave";
import type { FavouriteView } from "@/server/services/catalogue";
import type { ClinicalVisitView } from "@/server/services/rx-mapping";

const visit: ClinicalVisitView = {
  id: "v1",
  visitType: "new",
  chiefComplaint: null,
  complaints: [],
  diagnosis: [],
  medicalHistory: [],
  drugHistory: [],
  examinationNotes: null,
  vitals: {},
  investigations: [],
  advice: null,
  followUpDate: null,
  followUpReason: null,
};

const SAVED = { ok: true, revision: 1, savedAt: "2026-11-17T04:30:00.000Z" } as const;
const CONFLICT = { ok: false, code: "conflict", message: "This draft was changed in another window or device.", currentRevision: 5 } as const;

function renderEditor(favourites: FavouriteView[] = []) {
  return render(
    <ClinicalEditor
      prescriptionId="rx-1"
      visit={visit}
      items={[]}
      revision={0}
      favourites={favourites}
      canAddToClinic
      canFinalize
    />,
  );
}

const advice = () => screen.getByLabelText("Advice") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(advice(), { target: { value: text } });
const clickFinalize = () => fireEvent.click(screen.getByRole("button", { name: /^finalize/i }));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const lastAutosavePayload = () => mocks.autosave.mock.calls.at(-1)?.[1] as { advice: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ medicines: [], terms: [] }) })));
  mocks.autosave.mockResolvedValue(SAVED);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.autosave.mockReset();
  mocks.finalize.mockReset();
  mocks.removeFavourite.mockReset();
});

describe("ClinicalEditor finalize", () => {
  it("after an internal failure with no revision, refreshes, resumes autosave, and loses no edit", async () => {
    mocks.finalize.mockResolvedValue({ ok: false, code: "internal", message: "Something went wrong." });
    const view = renderEditor();
    type("first");
    clickFinalize();
    await advance(0);

    expect(mocks.refresh).toHaveBeenCalled();
    expect(screen.getByText(/could not confirm that the prescription was finalized/i)).toBeInTheDocument();

    // The hold was released: a later edit is scheduled and saved.
    type("second");
    await advance(1000);
    expect(lastAutosavePayload().advice).toBe("second");

    // An edit made just before leaving the page is saved on unmount.
    type("third");
    view.unmount();
    await advance(0);
    expect(lastAutosavePayload().advice).toBe("third");
  });

  it("locks the editor while finalizing and after success", async () => {
    const pending = deferred<unknown>();
    mocks.finalize.mockReturnValue(pending.promise);
    renderEditor();
    expect(advice()).toBeEnabled();
    clickFinalize();
    await advance(0);
    expect(advice()).toBeDisabled();
    expect(screen.getByRole("button", { name: /finalizing/i })).toBeDisabled();

    pending.resolve({ ok: true, rxNo: 1 });
    await advance(0);
    expect(mocks.refresh).toHaveBeenCalled();
    expect(advice()).toBeDisabled();
  });

  it("treats a stuck finalize like an internal failure", async () => {
    mocks.finalize.mockReturnValue(new Promise(() => undefined));
    renderEditor();
    type("kept");
    clickFinalize();
    await advance(FINALIZE_TIMEOUT_MS - 1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(advice()).toBeDisabled();
    await advance(1);
    expect(screen.getByText(/could not confirm that the prescription was finalized/i)).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalled();
    expect(advice()).toBeEnabled();
    expect(screen.queryByText(/nothing was finalized/i)).not.toBeInTheDocument();
  });

  it("does not claim nothing was finalized when the answer was lost", async () => {
    mocks.finalize.mockRejectedValue(new Error("network"));
    renderEditor();
    clickFinalize();
    await advance(0);
    expect(screen.getByText(/could not confirm that the prescription was finalized/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing was finalized/i)).not.toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalled();
    expect(advice()).toBeEnabled();
  });

  it("explains when finalize did not run because saving stopped, with the engine's reason", async () => {
    const inFlight = deferred<unknown>();
    mocks.autosave.mockReturnValue(inFlight.promise);
    renderEditor();
    type("edit");
    await advance(1000); // autosave is now in flight
    clickFinalize();
    await advance(0);
    inFlight.resolve(CONFLICT);
    await advance(0);

    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(screen.getByText(/finalize did not run: saving stopped/i)).toBeInTheDocument();
    expect(screen.getByText(/see the save status above/i)).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("refreshes after an already-finalized failure so the finalized view appears", async () => {
    mocks.finalize.mockResolvedValue({ ok: false, code: "immutable", message: "This prescription is finalized." });
    renderEditor();
    clickFinalize();
    await advance(0);
    expect(screen.getByText("This prescription is finalized.")).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("clears the finalize message when the doctor edits", async () => {
    mocks.finalize.mockResolvedValue({ ok: false, code: "invalid", message: "Add at least one medicine before finalizing.", revision: 1, savedAt: SAVED.savedAt });
    renderEditor();
    clickFinalize();
    await advance(0);
    expect(screen.getByText(/at least one medicine/i)).toBeInTheDocument();
    type("more");
    await advance(0);
    expect(screen.queryByText(/at least one medicine/i)).not.toBeInTheDocument();
  });
});

describe("ClinicalEditor conflicts", () => {
  it("'Keep my version' saves the local copy on top of the newer revision, and Finalize waits meanwhile", async () => {
    mocks.autosave.mockResolvedValueOnce(CONFLICT).mockResolvedValue({ ok: true, revision: 6, savedAt: SAVED.savedAt });
    renderEditor();
    type("mine");
    await advance(1000);
    expect(screen.getByText(/your version has not been saved/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^finalize$/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /keep my version/i }));
    await advance(0);
    expect(mocks.autosave).toHaveBeenCalledTimes(2);
    expect(mocks.autosave.mock.calls[1][2]).toBe(5);
    expect(lastAutosavePayload().advice).toBe("mine");
    expect(screen.getByRole("button", { name: /^finalize$/i })).toBeEnabled();
  });
});

describe("favourites", () => {
  const favourite = { id: "f1", drugName: "DOLO 650MG" } as unknown as FavouriteView;

  it("ignores a second remove while the first is pending, and reports a failure", async () => {
    const pending = deferred<unknown>();
    mocks.removeFavourite.mockReturnValue(pending.promise);
    renderEditor([favourite]);
    const remove = screen.getByRole("button", { name: "Remove favourite DOLO 650MG" });
    fireEvent.click(remove);
    fireEvent.click(remove);
    await advance(0);
    expect(mocks.removeFavourite).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: false, code: "internal", message: "x" });
    await advance(0);
    expect(screen.getByText(/could not remove the favourite/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove favourite DOLO 650MG" })).toBeInTheDocument();
  });
});
