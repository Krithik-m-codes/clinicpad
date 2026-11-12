import { PrescriptionProvider } from "@/contexts/PrescriptionContext";
import Header from "@/components/layout/Header";

/**
 * Legacy single-doctor prescription generator (IndexedDB, demo data only).
 * Kept reachable until Phase 1 replaces it; isolated here so the legacy provider and
 * header do not leak into the authenticated app shell.
 */
export default function LegacyLayout({ children }: { children: React.ReactNode }) {
  return (
    <PrescriptionProvider>
      <Header />
      <main className="pt-10 md:pt-14 lg:pt-18 bg-[var(--secondary-color)] ">{children}</main>
    </PrescriptionProvider>
  );
}
