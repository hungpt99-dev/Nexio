/** Per-endpoint calibration (application).
 *
 * Probabilities are not trustworthy by default. Thresholds are fit PER
 * (endpoint, model, version) on the golden set and stored with the model
 * name + version; changing either requires re-calibration. Reports a
 * reliability table and expected calibration error (ECE).
 */
import type { PointThresholds } from './points';

export interface CalibrationCase {
  confidence: number;
  correct: boolean;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  accuracy: number;
  meanConfidence: number;
}

/** 10-bin reliability table over labeled cases. */
export function reliabilityTable(cases: CalibrationCase[]): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < 10; i += 1) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const inBin = cases.filter((c) => c.confidence >= lo && (i === 9 ? c.confidence <= hi : c.confidence < hi));
    const n = inBin.length;
    bins.push({
      lo,
      hi,
      n,
      accuracy: n ? inBin.filter((c) => c.correct).length / n : 0,
      meanConfidence: n ? inBin.reduce((a, c) => a + c.confidence, 0) / n : (lo + hi) / 2,
    });
  }
  return bins;
}

/** Expected calibration error: sum |accuracy - confidence| weighted by bin mass. */
export function expectedCalibrationError(cases: CalibrationCase[]): number {
  if (!cases.length) return 1;
  const bins = reliabilityTable(cases);
  return bins.reduce((a, b) => a + (b.n / cases.length) * Math.abs(b.accuracy - b.meanConfidence), 0);
}

export interface FitThresholds {
  thresholds: PointThresholds;
  /** Fraction of would-act cases that were wrong (must be 0 on adversarial). */
  falseActRate: number;
  abstainRate: number;
  ece: number;
  n: number;
}

/** Fit act/confirm thresholds: highest act with zero false-acts, then the
 * confirm level that keeps the abstain rate under 40%. No zero-false-act
 * level exists -> act at the strictest candidate (abstain almost everything).
 * Deterministic. */
export function fitThresholds(
  cases: CalibrationCase[],
  candidates: number[] = [0.99, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5],
): FitThresholds {
  const ece = expectedCalibrationError(cases);
  let act = candidates[0] ?? 0.99;
  for (const c of candidates) {
    const acted = cases.filter((x) => x.confidence >= c);
    const wrong = acted.filter((x) => !x.correct);
    if (acted.length > 0 && wrong.length === 0) {
      act = c;
      break;
    }
  }
  let confirm = 0.5;
  for (const c of [0.7, 0.6, 0.55, 0.5, 0.4]) {
    const abstained = cases.filter((x) => x.confidence < c).length / Math.max(1, cases.length);
    if (abstained <= 0.4) {
      confirm = c;
      break;
    }
  }
  if (confirm >= act) confirm = Math.max(0.1, act - 0.2);
  const acted = cases.filter((x) => x.confidence >= act);
  return {
    thresholds: { act, confirm },
    falseActRate: acted.length ? acted.filter((x) => !x.correct).length / acted.length : 0,
    abstainRate: cases.length ? cases.filter((x) => x.confidence < confirm).length / cases.length : 1,
    ece,
    n: cases.length,
  };
}

export interface StoredCalibration {
  endpoint: string;
  model: string;
  version: string;
  pointId: string;
  thresholds: PointThresholds;
  falseActRate: number;
  ece: number;
  n: number;
  fittedAt: number;
}

/** Key identity: model name OR version change invalidates stored thresholds. */
export function calibrationKey(endpoint: string, model: string, version: string, pointId: string): string {
  return [endpoint, model, version, pointId].join('|');
}

/** True when the stored calibration still matches this endpoint/model/version. */
export function calibrationFresh(stored: StoredCalibration, endpoint: string, model: string, version: string): boolean {
  return stored.endpoint === endpoint && stored.model === model && stored.version === version;
}
