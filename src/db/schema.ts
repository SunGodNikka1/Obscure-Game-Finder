import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { DiscoveredGame } from "@/lib/discovery/types";

/**
 * Persistence is OPTIONAL for the finder: a scan lives in browser session state.
 * These tables back the "Archive" feature (save a finished scan, reload it
 * later) and are the extension point for a fuller persistence layer.
 */
export const scanSessions = pgTable("scan_sessions", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  robloxUserId: bigint("roblox_user_id", { mode: "number" }),
  depth: integer("depth").notNull().default(0),
  gameCount: integer("game_count").notNull().default(0),
  httpRequests: integer("http_requests").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const archivedGames = pgTable(
  "archived_games",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => scanSessions.id, { onDelete: "cascade" }),
    universeId: bigint("universe_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    payload: jsonb("payload").$type<DiscoveredGame>().notNull(),
  },
  (table) => [index("archived_games_session_idx").on(table.sessionId)],
);

/**
 * Fixed-window rate-limit counters for public deployments.
 * See `src/lib/rateLimit.ts`. Only used when RATE_LIMIT_ENABLED=1.
 */
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    identity: text("identity").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    hits: integer("hits").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.identity, table.windowStart] })],
);

export type ScanSessionRow = typeof scanSessions.$inferSelect;
export type ArchivedGameRow = typeof archivedGames.$inferSelect;
