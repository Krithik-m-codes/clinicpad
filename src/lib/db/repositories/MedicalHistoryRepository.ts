"use client";

import { dbManager, STORES, MedicalHistory } from "../dbManager";

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class MedicalHistoryRepository {
  private async getStore(mode: IDBTransactionMode = "readonly") {
    const db = await dbManager.ensureDB();
    const transaction = db.transaction([STORES.MEDICAL_HISTORY], mode);
    return transaction.objectStore(STORES.MEDICAL_HISTORY);
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
          const history = cursor.value as MedicalHistory;
          if (history.name.toUpperCase().trim() === normalizedName) {
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
        console.error(
          "Error checking medical history existence:",
          request.error
        );
        reject(request.error);
      };
    });
  }

  async create(
    data: Omit<MedicalHistory, "id" | "timestamp">
  ): Promise<number> {
    const normalizedName = (data.name || "").toUpperCase().trim();

    // Check for duplicates
    const exists = await this.existsByName(normalizedName);
    if (exists) {
      throw new Error(
        `Medical history with name "${normalizedName}" already exists`
      );
    }

    const store = await this.getStore("readwrite");

    const history: Omit<MedicalHistory, "id"> = {
      name: normalizedName,
      timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
      const request = store.add(history);

      request.onsuccess = () => {
        const id = request.result as number;
        console.log("Medical history saved successfully:", id);
        resolve(id);
      };

      request.onerror = () => {
        console.error("Failed to save medical history:", request.error);
        reject(request.error);
      };
    });
  }

  async bulkCreate(
    histories: Omit<MedicalHistory, "id" | "timestamp">[],
    chunkSize: number = 200
  ): Promise<{ inserted: number; skipped: number; duplicates: string[] }> {
    console.log(
      `Starting bulk create for ${histories.length} medical histories`
    );

    // First, load all existing names into a Set for efficient duplicate checking
    const store = await this.getStore();
    const existingNames = new Set<string>();

    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const history = cursor.value as MedicalHistory;
          existingNames.add(history.name.toUpperCase().trim());
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => {
        console.error(
          "Error loading existing medical histories:",
          request.error
        );
        reject(request.error);
      };
    });

    let inserted = 0;
    let skipped = 0;
    const duplicates: string[] = [];

    for (let i = 0; i < histories.length; i += chunkSize) {
      const chunk = histories.slice(i, i + chunkSize);
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

          const history: Omit<MedicalHistory, "id"> = {
            name: normalizedName,
            timestamp: new Date().toISOString(),
          };

          const request = writeStore.add(history);

          request.onsuccess = () => {
            inserted++;
            existingNames.add(normalizedName); // Track for this batch
            completed++;
            if (completed === total) {
              resolve();
            }
          };

          request.onerror = () => {
            console.error(
              "Failed to save medical history in bulk:",
              request.error
            );
            skipped++;
            completed++;
            if (completed === total) {
              resolve();
            }
          };
        });
      });

      console.log(
        `Processed ${Math.min(i + chunkSize, histories.length)} / ${
          histories.length
        } medical histories`
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
  ): Promise<PaginatedResponse<MedicalHistory>> {
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
        console.error("Failed to get medical histories:", request.error);
        reject(request.error);
      };
    });
  }

  async getById(id: number): Promise<MedicalHistory | null> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        console.error("Failed to get medical history:", request.error);
        reject(request.error);
      };
    });
  }

  async update(id: number, updates: Partial<MedicalHistory>): Promise<boolean> {
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
        };

        const putRequest = store.put(updatedData);

        putRequest.onsuccess = () => {
          console.log("Medical history updated successfully:", id);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error("Failed to update medical history:", putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error(
          "Failed to get medical history for update:",
          getRequest.error
        );
        reject(getRequest.error);
      };
    });
  }

  async delete(id: number): Promise<boolean> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.delete(id);

      request.onsuccess = () => {
        console.log("Medical history deleted successfully:", id);
        resolve(true);
      };

      request.onerror = () => {
        console.error("Failed to delete medical history:", request.error);
        reject(request.error);
      };
    });
  }

  async search(
    query: string,
    page: number = 1,
    limit: number = 100
  ): Promise<PaginatedResponse<MedicalHistory>> {
    if (!query || query.trim() === "") {
      return this.getAll(page, limit);
    }

    const allData = await this.getAll(1, 999999);
    const searchQuery = query.toLowerCase().trim();
    const searchWords = searchQuery.split(/\s+/);

    const filteredData = allData.data.filter((history) => {
      const searchableText = history.name.toLowerCase();
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
        console.error("Failed to count medical histories:", request.error);
        reject(request.error);
      };
    });
  }

  async clear(): Promise<void> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => {
        console.log("All medical histories cleared");
        resolve();
      };

      request.onerror = () => {
        console.error("Failed to clear medical histories:", request.error);
        reject(request.error);
      };
    });
  }
}

export const medicalHistoryRepository = new MedicalHistoryRepository();
