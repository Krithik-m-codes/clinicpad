"use client";

import { dbManager, STORES, Complaint } from "../dbManager";

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class ComplaintsRepository {
  private async getStore(mode: IDBTransactionMode = "readonly") {
    const db = await dbManager.ensureDB();
    const transaction = db.transaction([STORES.COMPLAINTS], mode);
    return transaction.objectStore(STORES.COMPLAINTS);
  }

  private async existsByName(name: string): Promise<boolean> {
    const store = await this.getStore("readonly");
    const normalizedName = name.toUpperCase().trim();

    return new Promise((resolve, reject) => {
      const request = store.openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const complaint = cursor.value as Complaint;
          if (complaint.name === normalizedName) {
            resolve(true);
            return;
          }
          cursor.continue();
        } else {
          resolve(false);
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async create(data: Omit<Complaint, "id" | "timestamp">): Promise<number> {
    const normalizedName = (data.name || "").toUpperCase().trim();

    // Check for duplicate
    const exists = await this.existsByName(normalizedName);
    if (exists) {
      throw new Error(`Complaint with name "${normalizedName}" already exists`);
    }

    const store = await this.getStore("readwrite");

    const complaint: Omit<Complaint, "id"> = {
      name: normalizedName,
      timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
      const request = store.add(complaint);

      request.onsuccess = () => {
        const id = request.result as number;
        console.log("Complaint saved successfully:", id);
        resolve(id);
      };

      request.onerror = () => {
        console.error("Failed to save complaint:", request.error);
        reject(request.error);
      };
    });
  }

  async bulkCreate(
    complaints: Omit<Complaint, "id" | "timestamp">[],
    chunkSize: number = 200
  ): Promise<{ inserted: number; skipped: number; duplicates: string[] }> {
    console.log(`Starting bulk create for ${complaints.length} complaints`);

    let totalInserted = 0;
    let totalSkipped = 0;
    const duplicateNames: string[] = [];

    // Get all existing names
    const existingNames = new Set<string>();
    const readStore = await this.getStore("readonly");
    await new Promise<void>((resolve, reject) => {
      const request = readStore.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const complaint = cursor.value as Complaint;
          existingNames.add(complaint.name);
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });

    for (let i = 0; i < complaints.length; i += chunkSize) {
      const chunk = complaints.slice(i, i + chunkSize);
      const store = await this.getStore("readwrite");

      await new Promise<void>((resolve) => {
        let completed = 0;
        const total = chunk.length;

        chunk.forEach((data) => {
          const normalizedName = (data.name || "").toUpperCase().trim();

          // Skip if duplicate
          if (existingNames.has(normalizedName)) {
            totalSkipped++;
            duplicateNames.push(normalizedName);
            completed++;
            if (completed === total) {
              resolve();
            }
            return;
          }

          const complaint: Omit<Complaint, "id"> = {
            name: normalizedName,
            timestamp: new Date().toISOString(),
          };

          const request = store.add(complaint);

          request.onsuccess = () => {
            totalInserted++;
            existingNames.add(normalizedName);
            completed++;
            if (completed === total) {
              resolve();
            }
          };

          request.onerror = () => {
            console.error("Failed to save complaint in bulk:", request.error);
            totalSkipped++;
            completed++;
            if (completed === total) {
              resolve();
            }
          };
        });
      });

      console.log(
        `Processed ${Math.min(i + chunkSize, complaints.length)} / ${
          complaints.length
        } complaints`
      );
    }

    console.log(
      `Bulk create completed: ${totalInserted} inserted, ${totalSkipped} skipped`
    );
    return {
      inserted: totalInserted,
      skipped: totalSkipped,
      duplicates: duplicateNames,
    };
  }

  async getAll(
    page: number = 1,
    limit: number = 100
  ): Promise<PaginatedResponse<Complaint>> {
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
        console.error("Failed to get complaints:", request.error);
        reject(request.error);
      };
    });
  }

  async getById(id: number): Promise<Complaint | null> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        console.error("Failed to get complaint:", request.error);
        reject(request.error);
      };
    });
  }

  async update(id: number, updates: Partial<Complaint>): Promise<boolean> {
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
          console.log("Complaint updated successfully:", id);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error("Failed to update complaint:", putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error("Failed to get complaint for update:", getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  async delete(id: number): Promise<boolean> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.delete(id);

      request.onsuccess = () => {
        console.log("Complaint deleted successfully:", id);
        resolve(true);
      };

      request.onerror = () => {
        console.error("Failed to delete complaint:", request.error);
        reject(request.error);
      };
    });
  }

  async search(
    query: string,
    page: number = 1,
    limit: number = 100
  ): Promise<PaginatedResponse<Complaint>> {
    if (!query || query.trim() === "") {
      return this.getAll(page, limit);
    }

    const allData = await this.getAll(1, 999999);
    const searchQuery = query.toLowerCase().trim();
    const searchWords = searchQuery.split(/\s+/);

    const filteredData = allData.data.filter((complaint) => {
      const searchableText = complaint.name.toLowerCase();
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
        console.error("Failed to count complaints:", request.error);
        reject(request.error);
      };
    });
  }

  async clear(): Promise<void> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => {
        console.log("All complaints cleared");
        resolve();
      };

      request.onerror = () => {
        console.error("Failed to clear complaints:", request.error);
        reject(request.error);
      };
    });
  }
}

export const complaintsRepository = new ComplaintsRepository();
