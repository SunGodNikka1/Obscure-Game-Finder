/**
 * Parses pasted Roblox references into place / universe ids.
 * Accepts:
 *   https://www.roblox.com/games/1818/Classic-Crossroads
 *   roblox.com/games/start?placeId=1818
 *   https://www.roblox.com/games/1818
 *   universe:13058 | universeId=13058 | u13058
 *   1818            (bare id -> tried as a place, then as a universe)
 */
export type ImportTokenKind = "place" | "universe" | "ambiguous" | "invalid";

export interface ParsedImportToken {
  raw: string;
  kind: ImportTokenKind;
  id: number | null;
  reason?: string;
}

export const MAX_IMPORT_TOKENS = 50;

const isSaneId = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value < 1e15;

/**
 * Splits pasted input into candidate references.
 *
 * Parsing is LINE-ORIENTED so that our own enriched export round-trips:
 *
 *   https://www.roblox.com/games/1818/Crossroads | Crossroads | universe:13058
 *
 * Only the first resolvable reference on a line is used, so the trailing
 * name/universe/place annotations never produce duplicates or bogus "invalid
 * entry" noise. Lines with no reference at all are still reported as invalid.
 * Whitespace-separated lists (the original OGF format) still work because a
 * line containing several bare links is split on whitespace as a fallback.
 */
function splitCandidates(input: string): string[] {
  const out: string[] = [];
  for (const line of input.split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.includes("|")) {
      // Enriched export line: keep only the leading link/id segment.
      out.push(trimmed.split("|")[0].trim());
      continue;
    }
    const pieces = trimmed.split(/[\s,;]+/).filter(Boolean);
    // A single line holding several references (original OGF style export).
    if (pieces.length > 1) out.push(...pieces);
    else if (pieces.length === 1) out.push(pieces[0]);
  }
  return out;
}

export function parseImportInput(input: string): ParsedImportToken[] {
  const pieces = splitCandidates(input).slice(0, MAX_IMPORT_TOKENS);

  return pieces.map<ParsedImportToken>((raw) => {
    const lower = raw.toLowerCase();

    const universeMatch = lower.match(/(?:universe(?:id)?[=:/]|^u)(\d{2,15})/);
    if (universeMatch) {
      const id = Number(universeMatch[1]);
      return isSaneId(id)
        ? { raw, kind: "universe", id }
        : { raw, kind: "invalid", id: null, reason: "universe id out of range" };
    }

    const placeQuery = lower.match(/placeid[=:](\d{2,15})/);
    if (placeQuery) {
      const id = Number(placeQuery[1]);
      return isSaneId(id)
        ? { raw, kind: "place", id }
        : { raw, kind: "invalid", id: null, reason: "place id out of range" };
    }

    const gameUrl = lower.match(/roblox\.com\/(?:[a-z-]{2,7}\/)?games\/(\d{2,15})/);
    if (gameUrl) {
      const id = Number(gameUrl[1]);
      return isSaneId(id)
        ? { raw, kind: "place", id }
        : { raw, kind: "invalid", id: null, reason: "place id out of range" };
    }

    if (/^\d{2,15}$/.test(lower)) {
      const id = Number(lower);
      return isSaneId(id)
        ? { raw, kind: "ambiguous", id }
        : { raw, kind: "invalid", id: null, reason: "id out of range" };
    }

    if (lower.includes("roblox.com")) {
      return { raw, kind: "invalid", id: null, reason: "Roblox URL contains no experience id" };
    }
    return { raw, kind: "invalid", id: null, reason: "unrecognised reference" };
  });
}
