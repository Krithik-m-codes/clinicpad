import { z } from "zod";
import { LABEL_LANGUAGES, PAPER_SIZES } from "@/lib/rx-render/types";
import { cleanRequiredText } from "./text";

export const templateNameSchema = cleanRequiredText(120, "Give the pad a name.");

const fileIdSchema = z.uuid({ message: "Upload the pad image again." });

export const createTemplateSchema = z.object({
  name: templateNameSchema,
  fileId: fileIdSchema,
  paperSize: z.enum(PAPER_SIZES),
  labels: z.enum(LABEL_LANGUAGES),
  definition: z.unknown(),
});

export const saveDraftSchema = z.object({
  definition: z.unknown(),
  labels: z.enum(LABEL_LANGUAGES),
  fileId: fileIdSchema.optional(),
  name: templateNameSchema.optional(),
  baseRevision: z.number().int().min(0),
});

export const publishSchema = z.object({
  identity: z.enum(["dynamic", "bound"]),
  boundDoctorId: z.uuid().nullable(),
  confirmLetterhead: z.boolean(),
  baseRevision: z.number().int().min(0),
});

export const assignSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("clinic"), templateId: z.uuid().nullable() }),
  z.object({ scope: z.literal("doctor"), doctorId: z.uuid(), templateId: z.uuid().nullable() }),
]);
