import { z } from "zod";
import { isCalendarDate, isValidTimeZone } from "./format";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES } from "./types";

/**
 * Snapshot limits must be >= every write-side limit (patient, clinic and doctor validation), so
 * anything that can be saved can also be frozen and printed. They are deliberately looser than the
 * write side (names 200, lines 200, free text 5,000, bounded lists); tests/unit/rx-labels.test.ts
 * pins this against the write-side numbers. Raise a snapshot limit before raising a write-side one.
 */
const name = z.string().max(200);
const line = z.string().max(200);
const freeText = z.string().max(5000);
const assetId = z.uuid().nullable();

/** Shape of prescriptions.render_snapshot, version 1. Bump `v` and keep a parser per version if it changes. */
export const renderSnapshotSchema = z.object({
  v: z.literal(1),
  takenAt: z.iso.datetime({ offset: true }),
  patient: z.object({
    name,
    patientNo: z.number().int().nullable(),
    gender: z.string().max(32).nullable(),
    dob: z.string().refine(isCalendarDate, "dob must be YYYY-MM-DD").nullable(),
    ageLabel: z.string().max(32),
    allergies: z.array(line).max(50),
  }),
  clinic: z.object({
    name,
    addressLines: z.array(line).max(10),
    phone: line.nullable(),
    email: z.string().max(254).nullable(),
    footerLines: z.array(freeText).max(10),
    logoAssetId: assetId,
    timezone: z.string().refine(isValidTimeZone, "timezone must be an IANA zone"),
  }),
  doctor: z.object({
    name,
    qualifications: line.nullable(),
    designation: line.nullable(),
    registrationNo: z.string().max(80).nullable(),
    registrationCouncil: line.nullable(),
    signatureAssetId: assetId,
  }),
  layout: z.object({
    template: z.object({ kind: z.literal("builtin"), key: z.enum(BUILTIN_TEMPLATES) }),
    paperSize: z.enum(PAPER_SIZES),
    labels: z.enum(LABEL_LANGUAGES),
  }),
});

export type RenderSnapshot = z.infer<typeof renderSnapshotSchema>;

/** The stored jsonb is data, not trusted code: parse it, and treat anything unexpected as damaged. Never throws. */
export function parseRenderSnapshot(value: unknown): RenderSnapshot | null {
  const parsed = renderSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
