"use client";

import { dbManager, STORES, Test } from "../dbManager";

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class TestsRepository {
  private static instance: TestsRepository;

  // private constructor() {}

  public static getInstance(): TestsRepository {
    if (!TestsRepository.instance) {
      TestsRepository.instance = new TestsRepository();
    }
    return TestsRepository.instance;
  }

  private async getStore(mode: IDBTransactionMode = "readonly") {
    const db = await dbManager.ensureDB();
    const transaction = db.transaction([STORES.TESTS], mode);
    return transaction.objectStore(STORES.TESTS);
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
          const test = cursor.value as Test;
          if (test.name.toUpperCase().trim() === normalizedName) {
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
        console.error("Error checking test existence:", request.error);
        reject(request.error);
      };
    });
  }

  async create(data: Omit<Test, "id" | "timestamp">): Promise<number> {
    const normalizedName = (data.name || "").toUpperCase().trim();

    // Check for duplicates
    const exists = await this.existsByName(normalizedName);
    if (exists) {
      throw new Error(`Test with name "${normalizedName}" already exists`);
    }

    const store = await this.getStore("readwrite");

    const test: Omit<Test, "id"> = {
      name: normalizedName,
      category: data.category?.toUpperCase().trim() || "",
      timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
      const request = store.add(test);

      request.onsuccess = () => {
        const id = request.result as number;
        console.log("Test saved successfully:", id);
        resolve(id);
      };

      request.onerror = () => {
        console.error("Failed to save test:", request.error);
        reject(request.error);
      };
    });
  }

  async bulkCreate(
    tests: Omit<Test, "id" | "timestamp">[],
    chunkSize: number = 200
  ): Promise<{ inserted: number; skipped: number; duplicates: string[] }> {
    console.log(`Starting bulk create for ${tests.length} tests`);

    // First, load all existing names into a Set for efficient duplicate checking
    const store = await this.getStore();
    const existingNames = new Set<string>();

    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const test = cursor.value as Test;
          existingNames.add(test.name.toUpperCase().trim());
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => {
        console.error("Error loading existing tests:", request.error);
        reject(request.error);
      };
    });

    let inserted = 0;
    let skipped = 0;
    const duplicates: string[] = [];

    for (let i = 0; i < tests.length; i += chunkSize) {
      const chunk = tests.slice(i, i + chunkSize);
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

          const test: Omit<Test, "id"> = {
            name: normalizedName,
            category: data.category?.toUpperCase().trim() || "",
            timestamp: new Date().toISOString(),
          };

          const request = writeStore.add(test);

          request.onsuccess = () => {
            inserted++;
            existingNames.add(normalizedName); // Track for this batch
            completed++;
            if (completed === total) {
              resolve();
            }
          };

          request.onerror = () => {
            console.error("Failed to save test in bulk:", request.error);
            skipped++;
            completed++;
            if (completed === total) {
              resolve();
            }
          };
        });
      });

      console.log(
        `Processed ${Math.min(i + chunkSize, tests.length)} / ${
          tests.length
        } tests`
      );
    }

    console.log(
      `Bulk create completed: ${inserted} inserted, ${skipped} skipped`
    );
    return { inserted, skipped, duplicates };
  }

  async bulkCreateTransaction(
    tests: Omit<Test, "id" | "timestamp">[]
  ): Promise<void> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const transaction = store.transaction;
      let hasError = false;

      transaction.oncomplete = () => {
        if (!hasError) {
          console.log(`Bulk created ${tests.length} tests successfully`);
          resolve();
        }
      };

      transaction.onerror = () => {
        console.error("Transaction failed:", transaction.error);
        reject(transaction.error);
      };

      tests.forEach((testData) => {
        const test: Omit<Test, "id"> = {
          name: (testData.name || "").toUpperCase().trim(),
          category: testData.category?.toUpperCase().trim() || "",
          timestamp: new Date().toISOString(),
        };

        const request = store.add(test);

        request.onsuccess = () => {
          // Test added successfully
        };

        request.onerror = () => {
          hasError = true;
          console.error("Failed to add test:", testData.name, request.error);
          reject(request.error);
        };
      });
    });
  }

  async getAll(
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResponse<Test>> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const countRequest = store.count();

      countRequest.onsuccess = () => {
        const total = countRequest.result;
        const totalPages = Math.ceil(total / limit);
        const offset = (page - 1) * limit;

        const data: Test[] = [];
        let current = 0;

        if (total === 0) {
          resolve({
            data: [],
            total: 0,
            page,
            limit,
            totalPages: 0,
          });
          return;
        }

        const request = store.openCursor();

        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result;

          if (cursor) {
            if (current >= offset && data.length < limit) {
              data.push({ id: cursor.key as number, ...cursor.value });
            }

            current++;

            if (data.length < limit && current < total) {
              cursor.continue();
            } else {
              resolve({
                data,
                total,
                page,
                limit,
                totalPages,
              });
            }
          } else {
            resolve({
              data,
              total,
              page,
              limit,
              totalPages,
            });
          }
        };

        request.onerror = () => {
          console.error("Failed to get tests:", request.error);
          reject(request.error);
        };
      };

      countRequest.onerror = () => {
        console.error("Failed to count tests:", countRequest.error);
        reject(countRequest.error);
      };
    });
  }

  async searchByName(
    query: string,
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedResponse<Test>> {
    // <-- FIX 1: Return PaginatedResponse
    const store = await this.getStore();
    const upperQuery = query.toUpperCase().trim();

    return new Promise((resolve, reject) => {
      const allMatches: Test[] = []; // <-- Store all matches here first
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;

        if (cursor) {
          const test: Test = { id: cursor.key as number, ...cursor.value };

          if (
            test.name.includes(upperQuery) ||
            test.category?.includes(upperQuery)
          ) {
            allMatches.push(test); // Add every match
          }

          cursor.continue();
        } else {
          // <-- FIX 2: All cursors finished, now do pagination
          const total = allMatches.length;
          const totalPages = Math.ceil(total / limit);
          const offset = (page - 1) * limit; // Slice the results to get only the data for the current page

          const paginatedData = allMatches.slice(offset, offset + limit);

          resolve({
            data: paginatedData,
            total,
            page,
            limit,
            totalPages,
          });
        }
      };

      request.onerror = () => {
        console.error("Failed to search tests:", request.error);
        reject(request.error);
      };
    });
  }
  async getById(id: number): Promise<Test | null> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.get(id);

      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? { id, ...result } : null);
      };

      request.onerror = () => {
        console.error("Failed to get test by ID:", request.error);
        reject(request.error);
      };
    });
  }

  async update(id: number, data: Partial<Omit<Test, "id">>): Promise<boolean> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const existingTest = getRequest.result;

        if (!existingTest) {
          reject(new Error(`Test with ID ${id} not found`));
          return;
        }

        const updatedTest = {
          ...existingTest,
          ...data,
          name: data.name ? data.name.toUpperCase().trim() : existingTest.name,
          category:
            data.category !== undefined
              ? data.category.toUpperCase().trim()
              : existingTest.category,
          timestamp: new Date().toISOString(),
        };

        const putRequest = store.put(updatedTest, id);

        putRequest.onsuccess = () => {
          console.log("Test updated successfully:", id);
          resolve(true);
        };

        putRequest.onerror = () => {
          console.error("Failed to update test:", putRequest.error);
          reject(putRequest.error);
        };
      };

      getRequest.onerror = () => {
        console.error("Failed to get test for update:", getRequest.error);
        reject(getRequest.error);
      };
    });
  }

  async delete(id: number): Promise<boolean> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.delete(id);

      request.onsuccess = () => {
        console.log("Test deleted successfully:", id);
        resolve(true);
      };

      request.onerror = () => {
        console.error("Failed to delete test:", request.error);
        reject(request.error);
      };
    });
  }

  async count(): Promise<number> {
    const store = await this.getStore();

    return new Promise((resolve, reject) => {
      const request = store.count();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        console.error("Failed to count tests:", request.error);
        reject(request.error);
      };
    });
  }

  async clear(): Promise<void> {
    const store = await this.getStore("readwrite");

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onsuccess = () => {
        console.log("All tests cleared successfully");
        resolve();
      };

      request.onerror = () => {
        console.error("Failed to clear tests:", request.error);
        reject(request.error);
      };
    });
  }

  // /lib/db/TestsRepository.ts

  // ...

  // REPLACE the old 'exists' function with this:
  async exists(name: string): Promise<boolean> {
    // This just calls the efficient private function you already built
    return this.existsByName(name);
  }
}

export const testsRepository = new TestsRepository();
