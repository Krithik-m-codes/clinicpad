import { pathToFileURL } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import {
  auditEvents,
  branches,
  clinics,
  doctors,
  memberships,
  patients,
  prescriptionItems,
  prescriptions,
  tenants,
  users,
  visits,
} from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";
import { newId } from "@/lib/domain/ids";

const DEMO_SLUG = "demo-clinic";
const DEMO_PASSWORD = "ClinicPad!2026";
const PATIENT_COUNT = 50;
const PRESCRIPTION_COUNT = 20;

const firstNames = ["Asha", "Ravi", "Meera", "Arjun", "Kavya", "Vikram", "Priya", "Rahul", "Sneha", "Imran"];
const lastNames = ["Rao", "Sharma", "Iyer", "Patel", "Nair", "Singh", "Das", "Khan", "Joshi", "Reddy"];

const STAFF = [
  { email: "owner@demo.clinicpad.app", name: "Dr. Meera Shah", role: "owner" as const, clinician: true },
  { email: "doctor@demo.clinicpad.app", name: "Dr. Arjun Rao", role: "doctor" as const, clinician: true },
  { email: "reception@demo.clinicpad.app", name: "Kavya Nair", role: "reception" as const, clinician: false },
];

/**
 * Replaces the demo clinic with fresh demo data. Idempotent: running it again deletes
 * the previous demo tenant (cascade) and recreates it, so counts never grow.
 * Demo data only; refuses to run in production.
 */
export async function seedDemo(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed a production database");
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await adminDb.transaction(async (tx) => {
    await tx.delete(tenants).where(eq(tenants.slug, DEMO_SLUG));
    await tx.delete(users).where(
      inArray(
        users.email,
        STAFF.map((s) => s.email),
      ),
    );

    const tenantId = newId();
    await tx.insert(tenants).values({ id: tenantId, name: "Demo Clinic", slug: DEMO_SLUG, plan: "clinic" });

    const [clinic] = await tx
      .insert(clinics)
      .values({
        tenantId,
        name: "Sunrise Family Clinic",
        addressLine1: "12 MG Road",
        city: "Pune",
        state: "Maharashtra",
        pincode: "411001",
        country: "IN",
        timezone: "Asia/Kolkata",
        currency: "INR",
      })
      .returning();

    const [mainBranch] = await tx
      .insert(branches)
      .values({ tenantId, clinicId: clinic.id, name: "Main Branch", isPrimary: true })
      .returning();

    let ownerId = "";
    let primaryDoctorId = "";
    for (const person of STAFF) {
      const userId = newId();
      if (person.role === "owner") ownerId = userId;
      await tx.insert(users).values({ id: userId, email: person.email, name: person.name, passwordHash });
      await tx.insert(memberships).values({ tenantId, userId, role: person.role, status: "active" });
      if (person.clinician) {
        const [doctor] = await tx
          .insert(doctors)
          .values({
            tenantId,
            userId,
            primaryBranchId: mainBranch.id,
            qualifications: "MBBS, MD",
            specialties: ["General Medicine"],
            consultationFeePaise: 50_000,
          })
          .returning();
        if (!primaryDoctorId) primaryDoctorId = doctor.id;
      }
    }

    const patientRows = await tx
      .insert(patients)
      .values(
        Array.from({ length: PATIENT_COUNT }, (_, i) => {
          const phone = `90000000${String(i).padStart(2, "0")}`;
          return {
            tenantId,
            name: `${firstNames[i % firstNames.length]} ${lastNames[Math.floor(i / 5) % lastNames.length]}`,
            phone,
            phoneNormalized: phone,
            gender: i % 2 === 0 ? "female" : "male",
            allergies: i % 7 === 0 ? ["Penicillin"] : [],
            createdBy: ownerId,
          };
        }),
      )
      .returning();

    const now = new Date();
    const visitRows = await tx
      .insert(visits)
      .values(
        Array.from({ length: PRESCRIPTION_COUNT }, (_, i) => ({
          tenantId,
          patientId: patientRows[i].id,
          doctorId: primaryDoctorId,
          branchId: mainBranch.id,
          status: "finalized",
          visitType: i % 3 === 0 ? "follow-up" : "new",
          chiefComplaint: "Fever and body ache",
          diagnosis: ["Viral fever"],
          advice: "Rest, fluids, review if fever persists beyond 3 days.",
          finalizedAt: now,
        })),
      )
      .returning();

    const rxRows = await tx
      .insert(prescriptions)
      .values(
        visitRows.map((visit, i) => ({
          tenantId,
          visitId: visit.id,
          rxNo: i + 1,
          version: 1,
          status: "finalized",
          finalizedAt: now,
        })),
      )
      .returning();

    await tx.insert(prescriptionItems).values(
      rxRows.flatMap((rx) => [
        {
          tenantId,
          prescriptionId: rx.id,
          sortOrder: 0,
          drugName: "Paracetamol",
          strength: "500 mg",
          form: "tablet",
          dose: "1 tablet",
          timing: "TDS",
          durationDays: 3,
        },
        {
          tenantId,
          prescriptionId: rx.id,
          sortOrder: 1,
          drugName: "Cetirizine",
          strength: "10 mg",
          form: "tablet",
          dose: "1 tablet",
          timing: "HS",
          durationDays: 5,
        },
      ]),
    );

    // Invariant 2: clinical records carry audit events, demo data included.
    await tx.insert(auditEvents).values([
      {
        tenantId,
        actorUserId: ownerId,
        action: "tenant.created",
        entityType: "tenant",
        entityId: tenantId,
        after: { name: "Demo Clinic", plan: "clinic" },
      },
      ...rxRows.map((rx) => ({
        tenantId,
        actorUserId: ownerId,
        action: "prescription.finalized",
        entityType: "prescription",
        entityId: rx.id,
        after: { rxNo: rx.rxNo, version: rx.version },
      })),
    ]);
  });

  console.log(`Seed complete: ${DEMO_SLUG} with ${PATIENT_COUNT} patients and ${PRESCRIPTION_COUNT} prescriptions`);
  console.log(`Login: owner@demo.clinicpad.app / ${DEMO_PASSWORD}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  seedDemo()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
