import { describe, expect, it } from "vitest";
import {
  applyHit,
  applySchedulePreset,
  editorStateFromView,
  emptyMedicine,
  isBlankMedicine,
  medicineFrom,
  numberOrRaw,
  scheduleLabel,
  toDraftPayload,
} from "@/lib/rx/editor-state";
import type { ClinicalVisitView, ItemView } from "@/server/services/rx-mapping";
import type { FavouriteView, MedicineHit } from "@/server/services/catalogue";

const visit: ClinicalVisitView = {
  id: "visit-1",
  visitType: "follow-up",
  chiefComplaint: "Fever",
  complaints: ["Fever"],
  diagnosis: ["Viral fever"],
  medicalHistory: ["DM"],
  drugHistory: [],
  examinationNotes: null,
  vitals: { pulse: 92, bpSystolic: 130, bpDiastolic: 85, notes: "sitting" },
  investigations: [{ name: "CBC" }],
  advice: null,
  followUpDate: "2026-12-01",
  followUpReason: null,
};

const item: ItemView = {
  drugName: "DOLO 650MG",
  genericName: "Paracetamol 650Mg",
  strength: null,
  form: "tablet",
  route: null,
  dose: "1 tab",
  doseMorning: 1,
  doseAfternoon: 0,
  doseEvening: null,
  doseNight: 1,
  timing: null,
  foodRelation: "after",
  periodicity: null,
  isSos: false,
  durationValue: 5,
  durationUnit: "days",
  durationDays: 5,
  remarks: null,
};

const favourite: FavouriteView = {
  id: "fav-1",
  drugName: "AZI OD 500 TAB",
  genericName: "Azithromycin 500Mg",
  strength: null,
  form: null,
  route: null,
  dose: "1 tab",
  doseMorning: 1,
  doseAfternoon: 0,
  doseEvening: null,
  doseNight: 0,
  timing: null,
  foodRelation: "before",
  periodicity: "daily",
  isSos: false,
  durationValue: 3,
  durationUnit: "days",
  remarks: null,
};

describe("editorStateFromView / toDraftPayload", () => {
  it("turns a saved view into form strings and back into the same payload", () => {
    const state = editorStateFromView({ visit, items: [item] });
    expect(state.visitType).toBe("follow-up");
    expect(state.vitals.pulse).toBe("92");
    expect(state.vitals.spo2).toBe("");
    expect(state.vitalsNotes).toBe("sitting");
    expect(state.medicines[0]).toMatchObject({ doseMorning: "1", doseEvening: "", durationValue: "5", form: "tablet" });

    const payload = toDraftPayload(state);
    expect(payload.vitals).toEqual({ bpSystolic: 130, bpDiastolic: 85, pulse: 92, notes: "sitting" });
    expect(payload.items).toEqual([
      expect.objectContaining({
        drugName: "DOLO 650MG",
        genericName: "Paracetamol 650Mg",
        form: "tablet",
        doseMorning: 1,
        doseAfternoon: 0,
        doseEvening: null,
        doseNight: 1,
        durationValue: 5,
        durationUnit: "days",
        foodRelation: "after",
      }),
    ]);
    expect(payload.investigations).toEqual([{ name: "CBC", instructions: "" }]);
    expect(payload.followUpDate).toBe("2026-12-01");
  });

  it("starts an empty prescription with one blank medicine row and sends no items", () => {
    const state = editorStateFromView({ visit: { ...visit, investigations: [] }, items: [] });
    expect(state.medicines).toHaveLength(1);
    expect(isBlankMedicine(state.medicines[0])).toBe(true);
    expect(toDraftPayload(state).items).toEqual([]);
  });

  it("drops blank rows but keeps half-filled ones so the server can flag them", () => {
    const state = editorStateFromView({ visit, items: [] });
    state.medicines = [emptyMedicine(), { ...emptyMedicine(), dose: "1 tab" }, { ...emptyMedicine(), isSos: true }];
    state.investigations = [
      { key: "a", name: "", instructions: "" },
      { key: "b", name: "", instructions: "fasting" },
    ];
    const payload = toDraftPayload(state);
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({ drugName: "", dose: "1 tab" });
    expect(payload.investigations).toEqual([{ name: "", instructions: "fasting" }]);
  });

  it("never silently drops what was typed into a number field", () => {
    expect(numberOrRaw("")).toBeNull();
    expect(numberOrRaw("   ")).toBeNull();
    expect(numberOrRaw("98.6")).toBe(98.6);
    expect(numberOrRaw(" 7 ")).toBe(7);
    expect(numberOrRaw("abc")).toBe("abc");
    const state = editorStateFromView({ visit, items: [] });
    state.vitals.pulse = "9O";
    expect(toDraftPayload(state).vitals.pulse).toBe("9O");
  });
});

describe("medicine row helpers", () => {
  it("applies schedule presets and labels the schedule", () => {
    const m = applySchedulePreset(emptyMedicine(), "½-0-½");
    expect(m).toMatchObject({ doseMorning: "0.5", doseAfternoon: "0", doseEvening: "", doseNight: "0.5" });
    expect(scheduleLabel(m)).toBe("½-0-½");
    expect(applySchedulePreset(m, "TDS")).toBe(m);
    expect(scheduleLabel(emptyMedicine())).toBe("");
  });

  it("fills only the name from a catalogue hit, and the whole line from a favourite", () => {
    const row = { ...emptyMedicine(), dose: "2 tab" };
    const hit: MedicineHit = { source: "global", id: "g1", name: "DOLO 650MG", genericName: "Paracetamol 650Mg", favourite: null };
    expect(applyHit(row, hit)).toMatchObject({ key: row.key, drugName: "DOLO 650MG", genericName: "Paracetamol 650Mg", dose: "2 tab" });

    const fromFavourite = applyHit(row, { ...hit, source: "favourite", name: favourite.drugName, favourite });
    expect(fromFavourite).toMatchObject({
      key: row.key,
      drugName: "AZI OD 500 TAB",
      dose: "1 tab",
      doseNight: "0",
      foodRelation: "before",
      periodicity: "daily",
      durationValue: "3",
    });
  });

  it("keeps a typed generic name when the hit has none", () => {
    const row = { ...emptyMedicine(), genericName: "Paracetamol" };
    const hit: MedicineHit = { source: "global", id: "g2", name: "CROCIN", genericName: null, favourite: null };
    expect(applyHit(row, hit)).toMatchObject({ drugName: "CROCIN", genericName: "Paracetamol" });
  });

  it("copies every field of an item or favourite into a row", () => {
    expect(medicineFrom(favourite, "k-fixed")).toEqual({
      key: "k-fixed",
      drugName: "AZI OD 500 TAB",
      genericName: "Azithromycin 500Mg",
      strength: "",
      form: "",
      route: "",
      dose: "1 tab",
      doseMorning: "1",
      doseAfternoon: "0",
      doseEvening: "",
      doseNight: "0",
      timing: "",
      foodRelation: "before",
      periodicity: "daily",
      isSos: false,
      durationValue: "3",
      durationUnit: "days",
      remarks: "",
    });
  });

  it("gives every new row a key that never collides with rows loaded from the server", () => {
    const loaded = editorStateFromView({ visit, items: [item, item] }).medicines.map((m) => m.key);
    const fresh = Array.from({ length: 50 }, () => emptyMedicine().key);
    expect(new Set([...loaded, ...fresh]).size).toBe(52);
  });

  it("treats an SOS tick alone as content", () => {
    expect(isBlankMedicine({ ...emptyMedicine(), isSos: true })).toBe(false);
  });
});
