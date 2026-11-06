import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({
      status: "ok",
      service: "clinicpad",
      time: new Date().toISOString(),
    });
  } catch {
    return Response.json({ status: "error", service: "clinicpad" }, { status: 503 });
  }
}
