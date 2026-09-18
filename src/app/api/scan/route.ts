import { runDiscovery } from "@/lib/discovery/engine";
import { clampDepth } from "@/lib/discovery/config";
import type { ScanEvent } from "@/lib/discovery/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/scan
 * Streams NDJSON `ScanEvent` objects while the crawler works, so the UI can
 * append results progressively instead of waiting for a single fat payload.
 * Aborting the client fetch aborts the server-side crawl via `request.signal`.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const username = typeof raw.username === "string" ? raw.username.slice(0, 64) : "";
  if (!username.trim()) {
    return Response.json({ error: "username is required" }, { status: 400 });
  }

  const payload = {
    username,
    depth: clampDepth(raw.depth),
    includeCreated: raw.includeCreated !== false,
    includeFavorites: raw.includeFavorites !== false,
    includeInventory: raw.includeInventory !== false,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: ScanEvent) => write(`${JSON.stringify(event)}\n`);

      // Flush a blank line immediately so intermediary proxies commit the
      // response headers instead of buffering the whole stream. Blank lines are
      // ignored by the NDJSON reader on the client.
      write("\n");
      // Heartbeat keeps long crawls alive through idle-timeout proxies.
      const heartbeat = setInterval(() => write("\n"), 10_000);

      try {
        for await (const event of runDiscovery(payload, request.signal)) {
          if (request.signal.aborted) break;
          send(event);
        }
      } catch (error) {
        // Never leak stack traces to the client.
        if (!request.signal.aborted) {
          send({
            type: "log",
            ts: Date.now(),
            level: "error",
            message: "Scan failed unexpectedly on the server.",
          });
          send({
            type: "done",
            ts: Date.now(),
            ok: false,
            message: "Scan failed.",
            stats: {
              http: 0,
              friends: 0,
              refreshSeconds: 0,
              requestsMade: 0,
              friendsFound: 0,
              usersScanned: 0,
              usersQueued: 0,
              games: 0,
              playable: 0,
              closed: 0,
              failures: 1,
              rateLimited: 0,
              waitingSeconds: 0,
            },
          });
        }
        if (process.env.NODE_ENV !== "production") console.error("[scan]", error);
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  // NOTE: no `connection` / `keep-alive` / `transfer-encoding` headers here.
  // Those are hop-by-hop headers, are forbidden over HTTP/2, and make edge
  // proxies reject the response (Chrome reports ERR_INVALID_RESPONSE).
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
