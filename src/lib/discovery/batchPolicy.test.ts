import { describe, expect, it } from "vitest";
import { evaluateBatchOutcome, retryDelayMs } from "./batchPolicy";
import { CONTINUOUS_CONFIG } from "./config";

/**
 * The retry/pause decision is the most safety-critical branch in the
 * continuous crawler. These tests pin its contract:
 *   - success requires a checkpoint AND checkpoint.ok === true
 *   - anything else is a failure that retries until MAX_BATCH_ATTEMPTS, then pauses
 *   - backoff is exponential from RETRY_BASE_DELAY_MS, capped at RETRY_MAX_DELAY_MS
 */
describe("evaluateBatchOutcome", () => {
  it("returns success for a checkpoint that reports ok=true", () => {
    expect(evaluateBatchOutcome({ sawCheckpoint: true, checkpointOk: true, consecutiveFailures: 0 })).toBe("success");
  });

  it("treats success as independent of any earlier failure count", () => {
    // The caller resets the counter on success; the policy itself must not care.
    expect(evaluateBatchOutcome({ sawCheckpoint: true, checkpointOk: true, consecutiveFailures: 2 })).toBe("success");
  });

  it("retries a checkpoint that reports ok=false (a checkpoint existing is not success)", () => {
    expect(evaluateBatchOutcome({ sawCheckpoint: true, checkpointOk: false, consecutiveFailures: 1 })).toBe("retry");
  });

  it("retries a transport failure (no checkpoint delivered at all)", () => {
    expect(evaluateBatchOutcome({ sawCheckpoint: false, checkpointOk: false, consecutiveFailures: 1 })).toBe("retry");
  });

  it("never reports success when no checkpoint was seen, even if checkpointOk is set", () => {
    expect(evaluateBatchOutcome({ sawCheckpoint: false, checkpointOk: true, consecutiveFailures: 1 })).toBe("retry");
  });

  it("retries on every attempt below MAX_BATCH_ATTEMPTS and pauses once it is reached", () => {
    const max = CONTINUOUS_CONFIG.MAX_BATCH_ATTEMPTS;
    const outcomes: string[] = [];
    for (let failures = 1; failures <= max; failures += 1) {
      outcomes.push(evaluateBatchOutcome({ sawCheckpoint: true, checkpointOk: false, consecutiveFailures: failures }));
    }
    // e.g. with MAX_BATCH_ATTEMPTS = 3: retry, retry, pause
    expect(outcomes).toEqual([...Array(max - 1).fill("retry"), "pause"]);
  });

  it("pauses after the maximum number of consecutive failures", () => {
    const max = CONTINUOUS_CONFIG.MAX_BATCH_ATTEMPTS;
    expect(evaluateBatchOutcome({ sawCheckpoint: true, checkpointOk: false, consecutiveFailures: max })).toBe("pause");
    expect(evaluateBatchOutcome({ sawCheckpoint: false, checkpointOk: false, consecutiveFailures: max })).toBe("pause");
    expect(evaluateBatchOutcome({ sawCheckpoint: false, checkpointOk: false, consecutiveFailures: max + 5 })).toBe("pause");
  });

  it("honours an explicit maxAttempts override", () => {
    expect(evaluateBatchOutcome({ sawCheckpoint: false, checkpointOk: false, consecutiveFailures: 1, maxAttempts: 1 })).toBe("pause");
    expect(evaluateBatchOutcome({ sawCheckpoint: false, checkpointOk: false, consecutiveFailures: 4, maxAttempts: 5 })).toBe("retry");
  });
});

describe("retryDelayMs", () => {
  const base = CONTINUOUS_CONFIG.RETRY_BASE_DELAY_MS;
  const max = CONTINUOUS_CONFIG.RETRY_MAX_DELAY_MS;

  it("doubles from the base delay on each attempt", () => {
    expect(retryDelayMs(1)).toBe(base);
    expect(retryDelayMs(2)).toBe(base * 2);
    expect(retryDelayMs(3)).toBe(base * 4);
  });

  it("is clamped at the configured ceiling", () => {
    expect(retryDelayMs(4)).toBe(Math.min(base * 8, max));
    expect(retryDelayMs(10)).toBe(max);
    expect(retryDelayMs(50)).toBe(max);
  });

  it("matches the documented 2s / 4s / 8s / 15s schedule with the shipped config", () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt))).toEqual([2_000, 4_000, 8_000, 15_000]);
  });

  it("treats non-positive or fractional attempts as the first attempt", () => {
    expect(retryDelayMs(0)).toBe(base);
    expect(retryDelayMs(-3)).toBe(base);
    expect(retryDelayMs(1.9)).toBe(base);
  });

  it("accepts custom base and ceiling", () => {
    expect(retryDelayMs(1, 100, 1_000)).toBe(100);
    expect(retryDelayMs(3, 100, 1_000)).toBe(400);
    expect(retryDelayMs(6, 100, 1_000)).toBe(1_000);
  });
});
