import { dryRunPatientImport, type ImportReport } from "@/server/services/patient-import";
import type { ServiceContext } from "@/server/services/context";

/** What the wizard sends back to commit: everything the dry-run returned, plus the owner's duplicate choices. */
export function commitInput(report: ImportReport, decisions: Record<string, string> = {}) {
  const fingerprints: Record<string, string> = {};
  for (const r of report.rows) if (r.status === "duplicate") fingerprints[String(r.row)] = r.fingerprint;
  return { mapping: report.mapping, decisions, expectedSha256: report.fileSha256, checkToken: report.checkToken, fingerprints };
}

export async function dryRunOk(ctx: ServiceContext, bytes: Uint8Array, mapping?: unknown): Promise<ImportReport> {
  const result = await dryRunPatientImport(ctx, { bytes }, mapping);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
