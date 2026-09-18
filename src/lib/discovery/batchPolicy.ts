import { CONTINUOUS_CONFIG } from "./config";

/**
 * CONTINUOUS BATCH OUTCOME POLICY
 *
 * Extracted as a pure function so the retry/pause decision -- the most
 * safety-critical branch in the continuous crawler -- is unit-testable and
 * cannot silently regress.
 *
 * The central rule: a batch is successful ONLY when a checkpoint was received
 * AND that checkpoint reports `ok === true`. The server emits a checkpoint even
 * when a batch fails (so partial progress is never thrown away), so treating
 * "a checkpoint exists" as success would let failures masquerade as progress
 * and would never trigger the retry/pause path.
 */
export type BatchOutcome = "success" | "retry" | "pause";

export interface BatchOutcomeInput {
  /** Did the stream deliver a checkpoint at all? */
  sawCheckpoint: boolean;
  /** The checkpoint's own `ok` flag (false when absent). */
  checkpointOk: boolean;
  /**
   * Consecutive failures INCLUDING this batch if it failed.
   * Reset to 0 by the caller only on a genuine success.
   */
  consecutiveFailures: number;
  maxAttempts?: number;
}

export function evaluateBatchOutcome(input: BatchOutcomeInput): BatchOutcome {
  const maxAttempts = input.maxAttempts ?? CONTINUOUS_CONFIG.MAX_BATCH_ATTEMPTS;
  const succeeded = input.sawCheckpoint && input.checkpointOk === true;
  if (succeeded) return "success";
  return input.consecutiveFailures >= maxAttempts ? "pause" : "retry";
}

/** Exponential backoff, clamped to the configured ceiling. */
export function retryDelayMs(
  attempt: number,
  base: number = CONTINUOUS_CONFIG.RETRY_BASE_DELAY_MS,
  max: number = CONTINUOUS_CONFIG.RETRY_MAX_DELAY_MS,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(base * 2 ** (safeAttempt - 1), max);
}
