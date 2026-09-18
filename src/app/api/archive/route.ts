import { asc, count, desc, eq, inArray } from "drizzle-orm";
import { db, isDatabaseConfigured } from "@/db";
import { archivedGames, scanSessions } from "@/db/schema";
import type { DiscoveredGame } from "@/lib/discovery/types";
import { enforceRateLimit, type EnvLike } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ARCHIVED_GAMES = 500;

/**
 * Hard ceiling on stored sessions so anonymous writes can never grow the
 * database without bound. When reached, the OLDEST sessions are pruned
 * (archived_games cascades) -- consistent with the UI, which only ever lists
 * the 15 most recent sessions. Override with ARCHIVE_MAX_SESSIONS; 0 disables.
 */
const DEFAULT_ARCHIVE_MAX_SESSIONS = 200;

function archiveMaxSessions(env: EnvLike = process.env): number {
  const raw = env.ARCHIVE_MAX_SESSIONS;
  if (raw === undefined || raw === "") return DEFAULT_ARCHIVE_MAX_SESSIONS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_ARCHIVE_MAX_SESSIONS;
}

/** Deletes the oldest sessions so that at most `max - 1` remain (room for one insert). */
async function pruneOldestSessions(max: number): Promise<number> {
  if (max <= 0) return 0;
  const [{ total }] = await db.select({ total: count() }).from(scanSessions);
  const excess = Number(total) - (max - 1);
  if (excess <= 0) return 0;
  const oldest = await db
    .select({ id: scanSessions.id })
    .from(scanSessions)
    .orderBy(asc(scanSessions.createdAt), asc(scanSessions.id))
    .limit(excess);
  if (oldest.length === 0) return 0;
  await db.delete(scanSessions).where(
    inArray(
      scanSessions.id,
      oldest.map((row) => row.id),
    ),
  );
  return oldest.length;
}

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

  // Optional, env-gated abuse protection for public deployments (see lib/rateLimit.ts).
  // Archive writes get the tightest quota because each one persists up to 500 rows.
  const limited = await enforceRateLimit(request, "archive");
  if (limited) return limited;

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
    const pruned = await pruneOldestSessions(archiveMaxSessions());
    if (pruned > 0 && process.env.NODE_ENV !== "production") {
      console.info(`[archive:post] pruned ${pruned} oldest session(s) to stay within ARCHIVE_MAX_SESSIONS`);
    }

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
