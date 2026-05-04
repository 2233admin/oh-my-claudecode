/**
 * OMC HUD - Context ETA
 *
 * Predicts time-to-context-full based on rolling percent samples.
 *
 * Algorithm:
 *   1. Clamp + round input percent into [0, 100].
 *   2. Cold start: store one sample, return null ETA.
 *   3. Reject pathological gaps (clock skew/suspend/zero), /compact resets,
 *      and huge paste outliers — drop history, store fresh single sample.
 *   4. Append sample, cap rolling window at 36.
 *   5. Slope:
 *        - n < 6: two-point first→last slope
 *        - n >= 6: least-squares linear regression over the window
 *   6. Suppress when slope < 0.25 %/min (idle), ETA <= 0, ETA > 240, or
 *      non-finite.
 *   7. ETA = ceil((100 - percent) / slope) minutes.
 *
 * Inspired by codachi (https://github.com/vincent-k2026/codachi, MIT,
 * vincent-k2026); algorithm independently derived per codex consult.
 */

export type ContextEtaSample = {
  timestampMs: number;
  percent: number; // 0-100
};

export type ContextEtaResult = {
  etaMinutes: number | null; // null = don't display
  samples: ContextEtaSample[]; // updated rolling window, max 36
};

const MAX_SAMPLES = 36;
const MIN_GAP_SEC = 0; // strictly > 0 required
// Suspend / clock-skew baseline threshold. With only one prior sample (no
// cadence signal yet), gaps above this trigger a fresh start because we can't
// distinguish "user idle for 95s" from "machine suspended for 95s". With
// multiple prior samples we extend tolerance based on the established cadence
// (see effectiveMaxGapSec below).
const MAX_GAP_SEC_BASE = 90;
// Multiplier applied to the typical historical inter-sample gap when
// computing the effective max-gap. 2.5x balances "let normal idle polling
// through" vs "still catch suspend events that exceed normal cadence".
const HISTORICAL_GAP_MULTIPLIER = 2.5;
const COMPACT_DELTA_THRESHOLD = -10; // deltaPct <= -10 → /compact
const COMPACT_RATIO_THRESHOLD = 0.5; // current < last * 0.5 → /compact
const PASTE_DELTA_THRESHOLD = 15; // deltaPct >= 15 within ...
const PASTE_GAP_SEC_THRESHOLD = 30; // ... 30s gap → paste outlier
const REGRESSION_MIN_SAMPLES = 6; // < 6 uses two-point slope
const IDLE_SLOPE_MIN = 0.25; // %/min below this → suppress
const ETA_CAP_MINUTES = 240; // > 240 minutes → suppress

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function freshStart(percent: number, nowMs: number): ContextEtaResult {
  return {
    etaMinutes: null,
    samples: [{ timestampMs: nowMs, percent }],
  };
}

/**
 * Compute the suspend-vs-idle threshold for the next-sample gap.
 *
 * With only one prior sample we have no cadence information, so we must use
 * the conservative MAX_GAP_SEC_BASE (anything beyond that is more likely
 * "machine suspended" than "user paused for 90s"). With multiple prior
 * samples we use the average historical inter-sample gap × multiplier so
 * naturally slow polling (e.g. 5-min intervals on an idle session) stays
 * within bounds.
 */
function effectiveMaxGap(previousSamples: ContextEtaSample[]): number {
  if (previousSamples.length < 2) return MAX_GAP_SEC_BASE;
  const first = previousSamples[0];
  const last = previousSamples[previousSamples.length - 1];
  const totalSec = (last.timestampMs - first.timestampMs) / 1000;
  if (totalSec <= 0) return MAX_GAP_SEC_BASE;
  const avgGapSec = totalSec / (previousSamples.length - 1);
  return Math.max(MAX_GAP_SEC_BASE, avgGapSec * HISTORICAL_GAP_MULTIPLIER);
}

/**
 * Two-point slope from first to last sample, in %/min.
 * Returns null when the timespan is non-positive.
 */
function twoPointSlope(samples: ContextEtaSample[]): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const minutes = (last.timestampMs - first.timestampMs) / 60_000;
  if (minutes <= 0) return null;
  return (last.percent - first.percent) / minutes;
}

/**
 * Least-squares linear regression slope over samples, in %/min.
 * x = timestampMs (converted to minutes from first sample), y = percent.
 * Returns null when degenerate (zero variance in x).
 */
function regressionSlope(samples: ContextEtaSample[]): number | null {
  const n = samples.length;
  const t0 = samples[0].timestampMs;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const s of samples) {
    const x = (s.timestampMs - t0) / 60_000; // minutes from first sample
    const y = s.percent;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom <= 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

export function updateContextEta(
  currentPercent: number,
  previousSamples: ContextEtaSample[],
  nowMs: number,
): ContextEtaResult {
  const percent = clampPercent(currentPercent);

  // Rule 1: cold start
  if (previousSamples.length === 0) {
    return freshStart(percent, nowMs);
  }

  const last = previousSamples[previousSamples.length - 1];
  const gapSec = (nowMs - last.timestampMs) / 1000;
  const deltaPct = percent - last.percent;

  // Rule 2: clock skew, suspend, zero/negative gap.
  // Effective max-gap widens when we already have an established sampling
  // cadence: low-activity sessions polling every several minutes shouldn't
  // be treated as a suspend just because a single inter-sample gap exceeds
  // the cold-start 90s threshold.
  const effectiveMaxGapSec = effectiveMaxGap(previousSamples);
  if (gapSec <= MIN_GAP_SEC || gapSec > effectiveMaxGapSec) {
    return freshStart(percent, nowMs);
  }

  // Rule 3: /compact reset (large drop or sudden halving)
  if (
    deltaPct <= COMPACT_DELTA_THRESHOLD ||
    percent < last.percent * COMPACT_RATIO_THRESHOLD
  ) {
    return freshStart(percent, nowMs);
  }

  // Rule 4: huge paste outlier (large jump within short window)
  if (deltaPct >= PASTE_DELTA_THRESHOLD && gapSec <= PASTE_GAP_SEC_THRESHOLD) {
    return freshStart(percent, nowMs);
  }

  // Append new sample, cap window
  const appended = [...previousSamples, { timestampMs: nowMs, percent }];
  const samples =
    appended.length > MAX_SAMPLES
      ? appended.slice(appended.length - MAX_SAMPLES)
      : appended;

  // Need >= 2 samples to compute slope
  if (samples.length < 2) {
    return { etaMinutes: null, samples };
  }

  const slope =
    samples.length < REGRESSION_MIN_SAMPLES
      ? twoPointSlope(samples)
      : regressionSlope(samples);

  if (slope === null || !isFinite(slope) || slope < IDLE_SLOPE_MIN) {
    return { etaMinutes: null, samples };
  }

  const etaMinutes = Math.ceil((100 - percent) / slope);

  if (!isFinite(etaMinutes) || etaMinutes <= 0 || etaMinutes > ETA_CAP_MINUTES) {
    return { etaMinutes: null, samples };
  }

  return { etaMinutes, samples };
}
