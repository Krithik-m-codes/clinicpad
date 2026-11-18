import { getPdfEngine } from "@/server/pdf";

const TTL_MS = 3000;
let cached: { up: boolean; at: number } | null = null;

/** Up or down, remembered for a few seconds so a probe loop cannot hammer the PDF service. */
export async function pdfServiceUp(): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.at >= 0 && now - cached.at < TTL_MS) return cached.up;
  let up = false;
  try {
    up = (await getPdfEngine().health()).up;
  } catch {
    up = false;
  }
  cached = { up, at: now };
  return up;
}

export function resetPdfHealthCache(): void {
  cached = null;
}
