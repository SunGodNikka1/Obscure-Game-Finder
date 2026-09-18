import type { DiscoveredGame } from "@/lib/discovery/types";
import { gameUrl } from "@/lib/filters";

/**
 * EXPORT / IMPORT FORMATS
 *
 * The original OGF exported a plain list of game links which could be pasted
 * straight back in ("keep the exported format"), and warned it could only
 * request 200 games at a time because of a Roblox string limit.
 *
 * This website has no such limit, so the default export is complete. The
 * 200-entry chunking is offered as an explicit OGF-compatibility option rather
 * than being forced on everyone.
 *
 * Both formats are accepted by the importer:
 *   - links only      -> https://www.roblox.com/games/1818/Crossroads
 *   - enriched record -> https://www.roblox.com/games/1818/Crossroads | Crossroads | universe:13058
 * The enriched form is still line-based and link-first, so pasting it back into
 * our importer (or the original's) works unchanged.
 */

export type ExportFormat = "links" | "enriched";

export const OGF_CHUNK_SIZE = 200;

function enrichedLine(game: DiscoveredGame): string {
  const parts = [gameUrl(game), game.name.replace(/\s*\|\s*/g, " / ")];
  if (game.universeKnown) parts.push(`universe:${game.universeId}`);
  if (game.rootPlaceId) parts.push(`place:${game.rootPlaceId}`);
  return parts.join(" | ");
}

export function buildExport(games: DiscoveredGame[], format: ExportFormat): string {
  if (games.length === 0) return "";
  return games.map((game) => (format === "links" ? gameUrl(game) : enrichedLine(game))).join("\n");
}

/** Splits an export into OGF-compatible chunks of 200 entries. */
export function buildChunkedExport(
  games: DiscoveredGame[],
  format: ExportFormat,
  chunkSize = OGF_CHUNK_SIZE,
): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < games.length; i += chunkSize) {
    chunks.push(buildExport(games.slice(i, i + chunkSize), format));
  }
  return chunks;
}

export function describeExport(games: DiscoveredGame[], chunked: boolean): string {
  if (!chunked) return `${games.length} entries`;
  const chunkCount = Math.max(1, Math.ceil(games.length / OGF_CHUNK_SIZE));
  return `${games.length} entries in ${chunkCount} chunk${chunkCount === 1 ? "" : "s"} of ${OGF_CHUNK_SIZE}`;
}
