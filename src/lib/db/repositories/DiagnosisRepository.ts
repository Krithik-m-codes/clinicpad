"use client";

import { dbManager, STORES, Diagnosis } from "../dbManager";

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class DiagnosisRepository {
  private async getStore(mode: IDBTransactionMode = "readonly") {
    const db = await dbManager.ensureDB();
    const transaction = db.transaction([STORES.DIAGNOSIS], mode);
    return transaction.objectStore(STORES.DIAGNOSIS);
  }

  private async existsByName(name: string): Promise<boolean> {
    const store = await this.getStore();
    const normalizedName = name.toUpperCase().trim();

    return new Promise((resolve, reject) => {
      const request = store.openCursor();
      let found = false;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && !found) {
          const diagnosis = cursor.value as Diagnosis;
          if (diagnosis.name.toUpperCase().trim() === normalizedName) {
            found = true;
            resolve(true);
            return;
          }
          cursor.continue();
        } else if (!found) {
          resolve(false);
        }
      };

      request.onerror = () => {
        console.error("Error checking diagnosis existence:", request.error);
        reject(request.error);
      };
    });
  }

  async create(data: Omit<Diagnosis, "id" | "timestamp">): Promise<number> {
    const normalizedName = (data.name || "").toUpperCase().trim();

    // Check for duplicates
    const exists = await this.existsByName(normalizedName);
    if (exists) {
      throw new Error(`Diagnosis with name "${normalizedName}" already exists`);
    }

    const store = await this.getStore("readwrite");

    const diagnosis: Omit<Diagnosis, "id"> = {
      name: normalizedName,
      icdCode: data.icdCode?.toUpperCase().trim() || "",
      timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
      const request = store.add(diagnosis);

      request.onsuccess = () => {
        const id = request.result as number;
        console.log("Diagnosis saved successfully:", id);
        resolve(id);
      };

      request.onerror = () => {
        console.error("Failed to save diagnosis:", request.error);
        reject(request.error);
      };
    });
  }

  async bulkCreate(
    diagnoses: Omit<Diagnosis, "id" | "timestamp">[],
    chunkSize: number = 200
  ): Promise<{ inserted: number; skipped: number; duplicates: string[] }> {
    console.log(`Starting bulk create for ${diagnoses.length} diagnoses`);

    // First, load all existing names into a Set for efficient duplicate checking
    const store = await this.getStore();
    const existingNames = new Set<string>();

    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const diagnosis = cursor.value as Diagnosis;
          existingNames.add(diagnosis.name.toUpperCase().trim());
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => {
        console.error("Error loading existing diagnoses:", request.error);
        reject(request.error);
      };
    });

    let inserted = 0;
    let skipped = 0;
    const duplicates: string[] = [];

    for (let i = 0; i < diagnoses.length; i += chunkSize) {
      const chunk = diagnoses.slice(i, i + chunkSize);
      const writeStore = await this.getStore("readwrite");

      await new Promise<void>((resolve) => {
        let completed = 0;
        const total = chunk.length;

        chunk.forEach((data) => {
          const normalizedName = (data.name || "").toUpperCase().trim();

          // Skip duplicates
          if (existingNames.has(normalizedName)) {
            skipped++;
            duplicates.push(normalizedName);
            completed++;
            if (completed === total) {
              resolve();
            }
            return;
          }

          const diagnosis: Omit<Diagnosis, "id"> = {
            name: normalizedName,
            icdCode: data.icdCode?.toUpperCase().trim() || "",
            timestamp: new Date().toISOString(),
          };

          const request = writeStore.add(diagnosis);

          request.onsuccess = () => {
            inserted++;
            existingNames.add(normalizedName); // Track for this batch
            completed++;
            if (completed === total) {
              resolve();
            }
          };

          request.onerror = () => {
            console.error("Failed to save diagnosis in bulk:", request.error);
            skipped++;
            completed++;
            if (completed === total) {
              resolve();
            }
          };
        });
      });

      console.log(
        `Processed ${Math.min(i + chunkSize, diagnoses.length)} / ${
          diagnoses.length
        } diagnoses`
      );
    }

    console.log(
      `Bulk create completed: ${inserted} inserted, ${skipped} skipped`
    );
    return { inserted, skipped, duplicates };
  }

  async getAll(
    page: number = 1,
    limit: number = 100
  ): Promise<PaginatedResponse<Diagnosis>> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.getAll();

      request.onsuccess = () => {
        const allData = request.result || [];

        allData.sort((a, b) => a.name.localeCompare(b.name));

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
        console.error("Failed to get diagnoses:", request.error);
        reject(request.error);
      };
    });
  }

  async getById(id: number): Promise<Diagnosis | null> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        console.error("Failed to get diagnosis:", request.error);
        reject(request.error);
      };
    });
  }

  async update(id: number, updates: Partial<Diagnosis>): Promise<boolean> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const existingData = getRequest.result;
        if (!existingData) {
          resolve(false);
          return;
        }

        const updatedData = {
          ...existingData,
          ...updates,
          name: updates.name
            ? updates.name.toUpperCase().trim()
            : existingData.name,
          icdCode: updates.icdCode
            ? updates.icdCode.toUpperCase().trim()
            : existingData.icdCode,
        };

        const putRequest = store.put(updatedData);

        putRequest.onsuccess = () => {
          console.log("Diagnosis updated successfully:", id);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error("Failed to update diagnosis:", putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error("Failed to get diagnosis for update:", getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  async delete(id: number): Promise<boolean> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.delete(id);

      request.onsuccess = () => {
        console.log("Diagnosis deleted successfully:", id);
        resolve(true);
      };

      request.onerror = () => {
        console.error("Failed to delete diagnosis:", request.error);
        reject(request.error);
      };
    });
  }

  async search(
    query: string,
    page: number = 1,
    limit: number = 100
  ): Promise<PaginatedResponse<Diagnosis>> {
    if (!query || query.trim() === "") {
      return this.getAll(page, limit);
    }

    const allData = await this.getAll(1, 999999);
    const searchQuery = query.toLowerCase().trim();
    const searchWords = searchQuery.split(/\s+/);

    const filteredData = allData.data.filter((diagnosis) => {
      const searchableText = [diagnosis.name, diagnosis.icdCode]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchWords.every((word) => searchableText.includes(word));
    });

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

  async count(): Promise<number> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.count();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        console.error("Failed to count diagnoses:", request.error);
        reject(request.error);
      };
    });
  }

  async clear(): Promise<void> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => {
        console.log("All diagnoses cleared");
        resolve();
      };

      request.onerror = () => {
        console.error("Failed to clear diagnoses:", request.error);
        reject(request.error);
      };
    });
  }
}

export const diagnosisRepository = new DiagnosisRepository();
