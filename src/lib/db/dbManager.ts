"use client";

// Database configuration
const DB_NAME = "MedicalDB";
const DB_VERSION = 3;

// Store names
export const STORES = {
  PATIENT_INFO: "patientInfoTemplates",
  MEDICINES: "medicines",
  COMPLAINTS: "complaints",
  DIAGNOSIS: "diagnosis",
  MEDICAL_HISTORY: "medicalHistory",
  TESTS: "tests",
  DRUG_HISTORY: "drugHistory",
} as const;

// Interface for PatientInfoTemplate (renamed from PrescriptionTemplate)
export interface PatientInfoTemplate {
  id: string;
  patientName: string;
  title: string;
  age: string;
  gender: string;
  weight: string;
  phone: string;
  medicalHistory: string;
  drugHistory?: string; // Will be populated as comma-separated string from drugHistory array
  patientComplaints: string;
  diagnosis: string;
  bloodPressure: string;
  pulse: number;
  temperature: number;
  spo2: number;
  medicines: Array<{
    name: string;
    salt?: string;
    dosage: string;
    frequency: string;
    duration: string;
    durationMonths?: number;
    durationType: string;
    timing: string;
    foodTiming: string;
    sos?: boolean;
    remark: string;
  }>;
  tests: Array<{
    name: string;
    remark: string;
  }>;
  remarks: string;
  nextReview: string;
  timestamp: string;
  templateName?: string;
}

// Medicine interface
export interface Medicine {
  id?: number;
  name: string;
  salt: string;
  brand?: string;
  timestamp?: string;
}

// Complaint interface
export interface Complaint {
  id?: number;
  name: string;
  timestamp?: string;
}

// Diagnosis interface
export interface Diagnosis {
  id?: number;
  name: string;
  icdCode?: string;
  timestamp?: string;
}

// Medical History interface
export interface MedicalHistory {
  id?: number;
  name: string;
  timestamp?: string;
}

// Test interface
export interface Test {
  id?: number;
  name: string;
  category?: string;
  timestamp?: string;
}

class DBManager {
  private db: IDBDatabase | null = null;
  private isTauri: boolean;

  constructor() {
    this.isTauri = typeof window !== "undefined" && "__TAURI__" in window;
  }

  async initDB(): Promise<IDBDatabase> {
    if (typeof window === "undefined") {
      throw new Error("IndexedDB is not available in server environment");
    }

    if (this.db) {
      return this.db;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error("Failed to open IndexedDB:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log(
          `IndexedDB initialized - ${
            this.isTauri ? "Tauri" : "Web"
          } environment`
        );
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        console.log(
          `Upgrading database from version ${oldVersion} to ${DB_VERSION}`
        );

        // Create or migrate patientInfoTemplates store
        if (!db.objectStoreNames.contains(STORES.PATIENT_INFO)) {
          const patientStore = db.createObjectStore(STORES.PATIENT_INFO, {
            keyPath: "id",
          });
          patientStore.createIndex("patientName", "patientName", {
            unique: false,
          });
          patientStore.createIndex("timestamp", "timestamp", { unique: false });
          patientStore.createIndex("templateName", "templateName", {
            unique: false,
          });
        } else if (oldVersion < 2) {
          // Handle migration from prescriptionTemplates to patientInfoTemplates
          const transaction = (event.target as IDBOpenDBRequest).transaction;
          if (
            transaction &&
            db.objectStoreNames.contains("prescriptionTemplates")
          ) {
            // Migration will be handled separately
            console.log(
              "Old prescriptionTemplates store exists, will migrate data"
            );
          }
        }

        // Create medicines store
        if (!db.objectStoreNames.contains(STORES.MEDICINES)) {
          const medicineStore = db.createObjectStore(STORES.MEDICINES, {
            keyPath: "id",
            autoIncrement: true,
          });
          medicineStore.createIndex("name", "name", { unique: false });
          medicineStore.createIndex("salt", "salt", { unique: false });
          medicineStore.createIndex("brand", "brand", { unique: false });
          medicineStore.createIndex("timestamp", "timestamp", {
            unique: false,
          });
        }

        // Create complaints store
        if (!db.objectStoreNames.contains(STORES.COMPLAINTS)) {
          const complaintStore = db.createObjectStore(STORES.COMPLAINTS, {
            keyPath: "id",
            autoIncrement: true,
          });
          complaintStore.createIndex("name", "name", { unique: false });
          complaintStore.createIndex("timestamp", "timestamp", {
            unique: false,
          });
        }

        // Create diagnosis store
        if (!db.objectStoreNames.contains(STORES.DIAGNOSIS)) {
          const diagnosisStore = db.createObjectStore(STORES.DIAGNOSIS, {
            keyPath: "id",
            autoIncrement: true,
          });
          diagnosisStore.createIndex("name", "name", { unique: false });
          diagnosisStore.createIndex("icdCode", "icdCode", { unique: false });
          diagnosisStore.createIndex("timestamp", "timestamp", {
            unique: false,
          });
        }

        // Create medical history store
        if (!db.objectStoreNames.contains(STORES.MEDICAL_HISTORY)) {
          const historyStore = db.createObjectStore(STORES.MEDICAL_HISTORY, {
            keyPath: "id",
            autoIncrement: true,
          });
          historyStore.createIndex("name", "name", { unique: false });
          historyStore.createIndex("timestamp", "timestamp", { unique: false });
        }

        // Create tests store
        if (!db.objectStoreNames.contains(STORES.TESTS)) {
          const testsStore = db.createObjectStore(STORES.TESTS, {
            keyPath: "id",
            autoIncrement: true,
          });
          testsStore.createIndex("name", "name", { unique: false });
          testsStore.createIndex("category", "category", { unique: false });
          testsStore.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
    });
  }

  async ensureDB(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.initDB();
    }
    if (!this.db) {
      throw new Error("Failed to initialize IndexedDB");
    }
    return this.db;
  }

  async migrateOldData(): Promise<void> {
    try {
      const db = await this.ensureDB();

      // Check if old store exists
      if (!db.objectStoreNames.contains("prescriptionTemplates")) {
        console.log("No old data to migrate");
        return;
      }

      const transaction = db.transaction(
        ["prescriptionTemplates", STORES.PATIENT_INFO],
        "readwrite"
      );
      const oldStore = transaction.objectStore("prescriptionTemplates");
      const newStore = transaction.objectStore(STORES.PATIENT_INFO);

      const allOldData = await new Promise<PatientInfoTemplate[]>(
        (resolve, reject) => {
          const request = oldStore.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }
      );

      console.log(`Migrating ${allOldData.length} records from old store`);

      // Copy all data to new store
      for (const record of allOldData) {
        await new Promise<void>((resolve, reject) => {
          const request = newStore.add(record);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }

      console.log("Migration completed successfully");
    } catch (error) {
      console.error("Migration failed:", error);
      // Don't throw - migration is optional
    }
  }

  getDB(): IDBDatabase | null {
    return this.db;
  }
}

// Export singleton instance
export const dbManager = new DBManager();
