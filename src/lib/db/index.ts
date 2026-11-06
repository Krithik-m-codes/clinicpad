"use client";

// Export dbManager and types
export * from "./dbManager";

// Export all repositories (explicitly to avoid ambiguity)
export {
  PatientInfoTemplateRepository,
  type PaginatedResponse,
} from "./repositories/PatientInfoTemplateRepository";
export { MedicinesRepository } from "./repositories/MedicinesRepository";
export { ComplaintsRepository } from "./repositories/ComplaintsRepository";
export { DiagnosisRepository } from "./repositories/DiagnosisRepository";
export { MedicalHistoryRepository } from "./repositories/MedicalHistoryRepository";
export { TestsRepository } from "./repositories/TestsRepository";

// Initialize and export repositories
import { patientInfoRepository } from "./repositories/PatientInfoTemplateRepository";
import { medicinesRepository } from "./repositories/MedicinesRepository";
import { complaintsRepository } from "./repositories/ComplaintsRepository";
import { diagnosisRepository } from "./repositories/DiagnosisRepository";
import { medicalHistoryRepository } from "./repositories/MedicalHistoryRepository";
import { testsRepository } from "./repositories/TestsRepository";

export {
  patientInfoRepository,
  medicinesRepository,
  complaintsRepository,
  diagnosisRepository,
  medicalHistoryRepository,
  testsRepository,
};

// Initialize DB on module load
import { dbManager } from "./dbManager";

if (typeof window !== "undefined") {
  dbManager
    .initDB()
    .then(() => {
      console.log("Medical DB initialized successfully");
      // Optionally migrate old data
      dbManager.migrateOldData();
    })
    .catch((error) => {
      console.error("Failed to initialize Medical DB:", error);
    });
}
