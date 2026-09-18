import { sql } from "drizzle-orm";
import { db, isDatabaseConfigured } from "@/db";

export const dynamic = "force-dynamic";

/**
 * The finder works without Postgres (storage only backs the optional Archive),
 * so the healthcheck stays green when the database is absent and simply
 * reports its state instead.
 */
export async function GET() {
  if (!isDatabaseConfigured()) {
    return Response.json({ ok: true, db: "not-configured" });
  }
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, db: "ok" });
  } catch {
    return Response.json({ ok: true, db: "unavailable" });
  }
}
