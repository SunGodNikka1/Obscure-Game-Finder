import { RobloxClient, describeError } from "@/lib/roblox/client";
import { resolvePlaceToUniverse } from "@/lib/roblox/games";
import { hydrateUniverses } from "@/lib/discovery/normalize";
import { MAX_IMPORT_TOKENS, parseImportInput } from "@/lib/discovery/importParse";
import type { DiscoveredGame, LogLevel } from "@/lib/discovery/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ImportLog {
  level: LogLevel;
  message: string;
}

/**
 * POST /api/import  { input: string }
 * Resolves pasted experience URLs / place ids / universe ids into real
 * DiscoveredGame records. Nothing is faked: an entry only appears in the result
 * set when Roblox actually returns metadata for it.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = typeof (body as { input?: unknown })?.input === "string" ? (body as { input: string }).input : "";
  if (!input.trim()) {
    return Response.json({ games: [], logs: [{ level: "warn", message: "Import cancelled: nothing pasted." }], http: 0 });
  }

  const tokens = parseImportInput(input.slice(0, 8000));
  const logs: ImportLog[] = [
    { level: "system", message: `Import: parsing ${tokens.length} reference${tokens.length === 1 ? "" : "s"}…` },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const client = new RobloxClient({ signal: controller.signal });

  const universeIds: number[] = [];
  const sourceOf = new Map<number, string>();
  /** Known place ids per universe, so partial records keep their identity. */
  const fallback = new Map<number, { rootPlaceId?: number | null }>();

  try {
    for (const token of tokens.slice(0, MAX_IMPORT_TOKENS)) {
      if (token.kind === "invalid" || token.id === null) {
        logs.push({ level: "error", message: `Invalid entry "${token.raw}" — ${token.reason ?? "unparseable"}.` });
        continue;
      }
      if (token.kind === "universe") {
        universeIds.push(token.id);
        sourceOf.set(token.id, token.raw);
        continue;
      }
      try {
        const universeId = await resolvePlaceToUniverse(client, token.id);
        if (universeId) {
          universeIds.push(universeId);
          sourceOf.set(universeId, token.raw);
          fallback.set(universeId, { rootPlaceId: token.id });
          logs.push({ level: "info", message: `Place ${token.id} → universe ${universeId}.` });
        } else if (token.kind === "ambiguous") {
          universeIds.push(token.id);
          sourceOf.set(token.id, token.raw);
          logs.push({ level: "info", message: `${token.id} is not a place id — trying it as a universe id.` });
        } else {
          logs.push({ level: "error", message: `Place ${token.id} could not be resolved to a universe.` });
        }
      } catch (error) {
        if (token.kind === "ambiguous") {
          universeIds.push(token.id);
          sourceOf.set(token.id, token.raw);
          logs.push({ level: "warn", message: `Place lookup failed for ${token.id}; retrying as universe id.` });
        } else {
          logs.push({ level: "error", message: `Place ${token.id} failed — ${describeError(error)}` });
        }
      }
    }

    let games: DiscoveredGame[] = [];
    if (universeIds.length > 0) {
      const hydrated = await hydrateUniverses(
        client,
        universeIds,
        () => ({
          discoveredByUserId: null,
          discoveredByUserName: "manual import",
          discoveryDepth: 0,
          discoveryPath: ["Imported"],
          discoveryReason: "import" as const,
        }),
        { maxDepth: 2, fallback },
      );
      // Keep anything with a real Roblox identity (a resolved place id counts,
      // even when metadata is unavailable -- broken/ancient places are valuable).
      // Only ids Roblox knows nothing about at all are rejected.
      games = hydrated.filter((game) => {
        const known = game.name !== `Universe ${game.universeId}` || game.rootPlaceId !== null;
        if (!known) {
          logs.push({
            level: "error",
            message: `No public experience found for "${sourceOf.get(game.universeId) ?? game.universeId}".`,
          });
        }
        return known;
      });
      logs.push({
        level: games.length > 0 ? "ok" : "warn",
        message: `Import complete. ${games.length} experience${games.length === 1 ? "" : "s"} added.`,
      });
    } else {
      logs.push({ level: "warn", message: "Import complete. Nothing resolvable found." });
    }

    return Response.json({ games, logs, http: client.requestCount });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") console.error("[import]", error);
    logs.push({ level: "error", message: "Import failed while contacting Roblox." });
    return Response.json({ games: [], logs, http: client.requestCount }, { status: 200 });
  } finally {
    clearTimeout(timeout);
  }
}
