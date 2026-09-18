import { describe, expect, it } from "vitest";
import { ROUTE_QUOTAS, resolveRouteQuota } from "./rateLimit";

describe("resolveRouteQuota", () => {
  it("uses the built-in per-route quota when no env is set", () => {
    for (const route of Object.keys(ROUTE_QUOTAS)) {
      expect(resolveRouteQuota(route, {})).toEqual(ROUTE_QUOTAS[route]);
    }
  });

  it("gives archive writes the tightest quota", () => {
    const archive = resolveRouteQuota("archive", {});
    const batch = resolveRouteQuota("scan-batch", {});
    expect(archive.maxRequests / archive.windowSeconds).toBeLessThan(batch.maxRequests / batch.windowSeconds);
  });

  it("falls back to module defaults for an unknown route", () => {
    expect(resolveRouteQuota("something-else", {})).toEqual({ maxRequests: 30, windowSeconds: 60 });
  });

  it("applies the global env override to every route", () => {
    const env = { RATE_LIMIT_MAX_REQUESTS: "7", RATE_LIMIT_WINDOW_SECONDS: "120" };
    expect(resolveRouteQuota("scan", env)).toEqual({ maxRequests: 7, windowSeconds: 120 });
    expect(resolveRouteQuota("archive", env)).toEqual({ maxRequests: 7, windowSeconds: 120 });
  });

  it("lets a route-suffixed env variable win over the global one", () => {
    const env = {
      RATE_LIMIT_MAX_REQUESTS: "7",
      RATE_LIMIT_MAX_REQUESTS_ARCHIVE: "2",
      RATE_LIMIT_WINDOW_SECONDS_SCAN_BATCH: "30",
    };
    expect(resolveRouteQuota("archive", env)).toEqual({ maxRequests: 2, windowSeconds: ROUTE_QUOTAS.archive.windowSeconds });
    expect(resolveRouteQuota("scan-batch", env)).toEqual({ maxRequests: 7, windowSeconds: 30 });
    expect(resolveRouteQuota("import", env).maxRequests).toBe(7);
  });

  it("ignores invalid or non-positive values", () => {
    const env = { RATE_LIMIT_MAX_REQUESTS: "abc", RATE_LIMIT_WINDOW_SECONDS_SCAN: "0" };
    expect(resolveRouteQuota("scan", env)).toEqual(ROUTE_QUOTAS.scan);
  });
});
