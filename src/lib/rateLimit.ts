import { sql } from "drizzle-orm";
import { db, isDatabaseConfigured } from "@/db";

/**
 * SERVER-SIDE ABUSE PROTECTION (env-gated, disabled by default)
 *
 * IMPORTANT SECURITY NOTE
 * -----------------------
 * The crawler request budget carried in the Continuous ∞ payload
 * (`budgetState`) is **UX and politeness state, not security**. It is supplied
 * by the client, so any caller can simply omit it and receive a fresh bucket.
 * It exists to make the UI counters truthful and to keep the crawler polite --
 * it must never be mistaken for enforcement.
 *
 * Real protection for a public deployment therefore needs an external,
 * server-authoritative layer keyed by IP (or session/API key). This module
 * provides exactly that with a fixed-window counter in Postgres, which works
 * on serverless/multi-instance hosting because the state lives in the database
 * rather than in process memory.
 *
 * ENABLING
 *   RATE_LIMIT_ENABLED=1                 # turn the limiter on
 *   RATE_LIMIT_WINDOW_SECONDS=60         # optional (default 60)
 *   RATE_LIMIT_MAX_REQUESTS=30           # optional (default 30) per route per window
 *
 * Requires the `rate_limit_hits` table (see `src/db/schema.ts`,
 * created with `npx drizzle-kit push`).
 *
 * Left DISABLED for Arena/local testing, where no shared persistent store is
 * guaranteed and the preview is single-tenant. If you deploy this publicly,
 * turn it on, or place the app behind your host's own rate limiter
 * (Vercel Firewall, Cloudflare, an API gateway, etc.).
 */

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MAX_REQUESTS = 30;

export function isRateLimitEnabled(): boolean {
  return process.env.RATE_LIMIT_ENABLED === "1" && isDatabaseConfigured();
}

function readIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Best-effort client identity. Behind a proxy the left-most `x-forwarded-for`
 * entry is the closest thing to a real client IP we can see.
 */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return (
    request.headers.get("x-real-ip")?.slice(0, 64) ??
    request.headers.get("cf-connecting-ip")?.slice(0, 64) ??
    "unknown"
  );
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

/**
 * Fixed-window counter. One UPSERT per call; the window is derived from the
 * clock so no cleanup job is required for correctness (old rows are simply
 * never read again and can be pruned lazily).
 */
export async function checkRateLimit(request: Request, route: string): Promise<RateLimitVerdict> {
  const windowSeconds = readIntEnv("RATE_LIMIT_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS);
  const maxRequests = readIntEnv("RATE_LIMIT_MAX_REQUESTS", DEFAULT_MAX_REQUESTS);
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const identity = `${clientKey(request)}:${route}`;

  try {
    const result = await db.execute<{ hits: number }>(sql`
      insert into rate_limit_hits (identity, window_start, hits)
      values (${identity}, ${new Date(windowStart)}, 1)
      on conflict (identity, window_start)
      do update set hits = rate_limit_hits.hits + 1
      returning hits
    `);

    const rows = (result as unknown as { rows?: Array<{ hits: number }> }).rows ?? [];
    const hits = Number(rows[0]?.hits ?? 1);
    const resetSeconds = Math.max(1, Math.ceil((windowStart + windowSeconds * 1000 - now) / 1000));

    return {
      allowed: hits <= maxRequests,
      remaining: Math.max(0, maxRequests - hits),
      resetSeconds,
    };
  } catch (error) {
    // Fail OPEN: a limiter outage must not take the application down.
    if (process.env.NODE_ENV !== "production") console.error("[rateLimit]", error);
    return { allowed: true, remaining: maxRequests, resetSeconds: windowSeconds };
  }
}

/**
 * Convenience guard for route handlers.
 * Returns a 429 `Response` when the caller is over quota, otherwise `null`.
 */
export async function enforceRateLimit(request: Request, route: string): Promise<Response | null> {
  if (!isRateLimitEnabled()) return null;
  const verdict = await checkRateLimit(request, route);
  if (verdict.allowed) return null;
  return Response.json(
    { error: "Rate limit exceeded. Please slow down." },
    {
      status: 429,
      headers: {
        "retry-after": String(verdict.resetSeconds),
        "x-ratelimit-remaining": "0",
      },
    },
  );
}
