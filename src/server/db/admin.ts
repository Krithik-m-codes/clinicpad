import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("ADMIN_DATABASE_URL, DIRECT_URL, or DATABASE_URL is required");
}

const adminClient = postgres(connectionString, { max: 3, prepare: false });

export const adminDb = drizzle(adminClient, { schema });
