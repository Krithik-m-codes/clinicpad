import { z } from "zod";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES } from "./types";

/** Shape of prescriptions.render_snapshot, version 1. Bump `v` and keep a parser per version if it changes. */
export const renderSnapshotSchema = z.object({
  v: z.literal(1),
  takenAt: z.string(),
  patient: z.object({
    name: z.string(),
    patientNo: z.number().int().nullable(),
    gender: z.string().nullable(),
    dob: z.string().nullable(),
    ageLabel: z.string(),
    allergies: z.array(z.string()),
  }),
  clinic: z.object({
    name: z.string(),
    addressLines: z.array(z.string()),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    footerLines: z.array(z.string()),
    logoAssetId: z.string().nullable(),
    timezone: z.string(),
  }),
  doctor: z.object({
    name: z.string(),
    qualifications: z.string().nullable(),
    designation: z.string().nullable(),
    registrationNo: z.string().nullable(),
    registrationCouncil: z.string().nullable(),
    signatureAssetId: z.string().nullable(),
  }),
  layout: z.object({
    template: z.object({ kind: z.literal("builtin"), key: z.enum(BUILTIN_TEMPLATES) }),
    paperSize: z.enum(PAPER_SIZES),
    labels: z.enum(LABEL_LANGUAGES),
  }),
});

export type RenderSnapshot = z.infer<typeof renderSnapshotSchema>;

/** The stored jsonb is data, not trusted code: parse it, and treat anything unexpected as damaged. */
export function parseRenderSnapshot(value: unknown): RenderSnapshot | null {
  const parsed = renderSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
