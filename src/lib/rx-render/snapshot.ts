import { z } from "zod";
import { isCalendarDate, isValidTimeZone } from "./format";
import { LABEL_LANGUAGES, PAD_TEMPLATES, PAPER_SIZES, type PadLayout } from "./types";

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

const parts = {
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
};

const builtinRef = z.object({ kind: z.literal("builtin"), key: z.enum(PAD_TEMPLATES) });
/** A custom pad, frozen by version id AND content hash (Plan 2A, ADR-0045): reprints verify both. */
const overlayRef = z.object({ kind: z.literal("overlay"), templateVersionId: z.uuid(), contentSha256: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * Version 1 (Plan 1C): built-in pads. Built-in pads keep writing exactly this shape (Plan 2A override 4), so
 * everything finalized so far, and everything finalized on a built-in pad later, reads the same way.
 */
export const renderSnapshotV1Schema = z.object({
  v: z.literal(1),
  ...parts,
  layout: z.object({ template: builtinRef, paperSize: z.enum(PAPER_SIZES), labels: z.enum(LABEL_LANGUAGES) }),
});

/** Version 2 (Plan 2A): written only when the signer's pad is a custom overlay version (id and content hash frozen). */
export const renderSnapshotV2Schema = z.object({
  v: z.literal(2),
  ...parts,
  layout: z.object({ template: overlayRef, paperSize: z.enum(PAPER_SIZES), labels: z.enum(LABEL_LANGUAGES) }),
});

/** Shape of prescriptions.render_snapshot. Bump `v` and keep a parser per version if it changes. */
export const renderSnapshotSchema = z.discriminatedUnion("v", [renderSnapshotV1Schema, renderSnapshotV2Schema]);

export type RenderSnapshot = z.infer<typeof renderSnapshotSchema>;

/** The stored jsonb is data, not trusted code: parse it, and treat anything unexpected as damaged. Never throws. */
export function parseRenderSnapshot(value: unknown): RenderSnapshot | null {
  const parsed = renderSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type SnapshotParts = Omit<z.infer<typeof renderSnapshotV1Schema>, "v" | "layout">;

/**
 * Pairs a layout with the snapshot version that records it: built-in pads are version 1 (the shape every older record
 * has), a custom overlay pad is version 2 (Plan 2A override 4).
 */
export function snapshotWithLayout(parts: SnapshotParts, layout: PadLayout): RenderSnapshot {
  const { template, paperSize, labels } = layout;
  return template.kind === "overlay"
    ? { v: 2, ...parts, layout: { template, paperSize, labels } }
    : { v: 1, ...parts, layout: { template, paperSize, labels } };
}
