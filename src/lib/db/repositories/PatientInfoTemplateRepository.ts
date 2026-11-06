"use client";

import { dbManager, STORES, PatientInfoTemplate } from "../dbManager";

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class PatientInfoTemplateRepository {
  private async getStore(mode: IDBTransactionMode = "readonly") {
    const db = await dbManager.ensureDB();
    const transaction = db.transaction([STORES.PATIENT_INFO], mode);
    return transaction.objectStore(STORES.PATIENT_INFO);
  }

  async create(
    data: Omit<PatientInfoTemplate, "id" | "timestamp">
  ): Promise<PatientInfoTemplate> {
    const store = await this.getStore("readwrite");

    const template: PatientInfoTemplate = {
      ...data,
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
      const request = store.add(template);

      request.onsuccess = () => {
        console.log("Patient info saved successfully:", template.id);
        resolve(template);
      };

      request.onerror = () => {
        console.error("Failed to save patient info:", request.error);
        reject(request.error);
      };
    });
  }

  async getAll(
    page: number = 1,
    limit: number = 100
  ): Promise<PaginatedResponse<PatientInfoTemplate>> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.getAll();

      request.onsuccess = () => {
        const allData = request.result || [];
        // Sort by timestamp descending (newest first)
        allData.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        const total = allData.length;
        const totalPages = Math.ceil(total / limit);
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const data = allData.slice(startIndex, endIndex);

        resolve({
          data,
          total,
          page,
          limit,
          totalPages,
        });
      };

      request.onerror = () => {
        console.error("Failed to get patient info:", request.error);
        reject(request.error);
      };
    });
  }

  async getById(id: string): Promise<PatientInfoTemplate | null> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        console.error("Failed to get patient info:", request.error);
        reject(request.error);
      };
    });
  }

  async update(
    id: string,
    updates: Partial<PatientInfoTemplate>
  ): Promise<boolean> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const existingData = getRequest.result;
        if (!existingData) {
          resolve(false);
          return;
        }

        const updatedData = { ...existingData, ...updates };
        const putRequest = store.put(updatedData);

        putRequest.onsuccess = () => {
          console.log("Patient info updated successfully:", id);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error("Failed to update patient info:", putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error(
          "Failed to get patient info for update:",
          getRequest.error
        );
        reject(getRequest.error);
      };
    });
  }

  async delete(id: string): Promise<boolean> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.delete(id);

      request.onsuccess = () => {
        console.log("Patient info deleted successfully:", id);
        resolve(true);
      };

      request.onerror = () => {
        console.error("Failed to delete patient info:", request.error);
        reject(request.error);
      };
    });
  }

  async search(
    query: string,
    page: number = 1,
    limit: number = 100
  ): Promise<PaginatedResponse<PatientInfoTemplate>> {
    const allData = await this.getAll(1, 999999); // Get all for searching
    const lowerQuery = query.toLowerCase();

    const filteredData = allData.data.filter(
      (template) =>
        template.patientName.toLowerCase().includes(lowerQuery) ||
        template.diagnosis.toLowerCase().includes(lowerQuery) ||
        template.templateName?.toLowerCase().includes(lowerQuery) ||
        template.medicalHistory.toLowerCase().includes(lowerQuery)
    );

    const total = filteredData.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const data = filteredData.slice(startIndex, endIndex);

    return {
      data,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async getStats() {
    const allData = await this.getAll(1, 999999);
    const templates = allData.data;
    const now = new Date();
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    return {
      total: templates.length,
      thisWeek: templates.filter(
        (template) => new Date(template.timestamp) >= lastWeek
      ).length,
      lastUpdated: templates.length > 0 ? templates[0].timestamp : null,
    };
  }

  async count(): Promise<number> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.count();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        console.error("Failed to count records:", request.error);
        reject(request.error);
      };
    });
  }

  async cleanupOld(daysToKeep: number = 15): Promise<number> {
    const store = await this.getStore("readwrite");
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    return new Promise((resolve, reject) => {
      const index = store.index("timestamp");
      const range = IDBKeyRange.upperBound(cutoffDate.toISOString());
      const request = index.openCursor(range);

      let deletedCount = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          deletedCount++;
          cursor.continue();
        } else {
          console.log(
            `Cleaned up ${deletedCount} old records (older than ${daysToKeep} days)`
          );
          resolve(deletedCount);
        }
      };

      request.onerror = () => {
        console.error("Failed to cleanup old records:", request.error);
        reject(request.error);
      };
    });
  }
}

export const patientInfoRepository = new PatientInfoTemplateRepository();
