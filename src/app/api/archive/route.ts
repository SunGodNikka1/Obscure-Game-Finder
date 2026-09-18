import { desc, eq } from "drizzle-orm";
import { db, isDatabaseConfigured } from "@/db";
import { archivedGames, scanSessions } from "@/db/schema";
import type { DiscoveredGame } from "@/lib/discovery/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ARCHIVED_GAMES = 500;

/** GET /api/archive -> most recent saved scans */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionParam = url.searchParams.get("session");

  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Archive storage is not configured on this host" }, { status: 503 });
  }

  try {
    if (sessionParam) {
      const sessionId = Number(sessionParam);
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        return Response.json({ error: "invalid session id" }, { status: 400 });
      }
      const rows = await db
        .select({ payload: archivedGames.payload })
        .from(archivedGames)
        .where(eq(archivedGames.sessionId, sessionId))
        .limit(MAX_ARCHIVED_GAMES);
      return Response.json({ games: rows.map((row) => row.payload) });
    }

    const sessions = await db
      .select()
      .from(scanSessions)
      .orderBy(desc(scanSessions.createdAt))
      .limit(15);
    return Response.json({ sessions });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") console.error("[archive:get]", error);
    return Response.json({ error: "Archive storage unavailable" }, { status: 503 });
  }
}

/** POST /api/archive -> persist the current result set */
export async function POST(request: Request): Promise<Response> {
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Archive storage is not configured on this host" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body ?? {}) as {
    username?: unknown;
    robloxUserId?: unknown;
    depth?: unknown;
    httpRequests?: unknown;
    games?: unknown;
  };
  const username = typeof raw.username === "string" && raw.username.trim() ? raw.username.trim().slice(0, 64) : "session";
  const games = Array.isArray(raw.games) ? (raw.games as DiscoveredGame[]).slice(0, MAX_ARCHIVED_GAMES) : [];
  if (games.length === 0) {
    return Response.json({ error: "Nothing to archive" }, { status: 400 });
  }

  try {
    const [session] = await db
      .insert(scanSessions)
      .values({
        username,
        robloxUserId: typeof raw.robloxUserId === "number" ? raw.robloxUserId : null,
        depth: typeof raw.depth === "number" ? Math.max(0, Math.min(5, Math.floor(raw.depth))) : 0,
        gameCount: games.length,
        httpRequests: typeof raw.httpRequests === "number" ? Math.max(0, Math.floor(raw.httpRequests)) : 0,
      })
      .returning();

    await db.insert(archivedGames).values(
      games.map((game) => ({
        sessionId: session.id,
        universeId: game.universeId,
        name: game.name.slice(0, 250),
        payload: game,
      })),
    );

    return Response.json({ ok: true, sessionId: session.id, saved: games.length });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") console.error("[archive:post]", error);
    return Response.json({ error: "Archive storage unavailable" }, { status: 503 });
  }
}
