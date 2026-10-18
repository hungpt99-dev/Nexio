/** Decision audit (infrastructure).
 *
 * Every decision is audited: point, engine, model name/version, input HASH,
 * per-option probabilities, verdict, outcome, latency. No raw text unless the
 * user enables an explicit debug option. Keys are never logged.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DecisionResult } from './types';

export function hashInput(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export interface DecisionAuditRow {
  id: string;
  ts: number;
  point: string;
  engine: string;
  model: string;
  modelVersion: string;
  inputHash: string;
  probabilities: string;
  verdict: string;
  choice?: string;
  confidence: number;
  latencyMs: number;
  outcome?: string;
}

export function ensureDecisionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, point TEXT NOT NULL,
      engine TEXT NOT NULL, model TEXT NOT NULL, modelVersion TEXT NOT NULL DEFAULT '',
      inputHash TEXT NOT NULL, probabilities TEXT NOT NULL, verdict TEXT NOT NULL,
      choice TEXT, confidence REAL NOT NULL, latencyMs INTEGER NOT NULL, outcome TEXT
    );
    CREATE TABLE IF NOT EXISTS decision_calibrations (
      key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, model TEXT NOT NULL, version TEXT NOT NULL,
      pointId TEXT NOT NULL, act REAL NOT NULL, confirm REAL NOT NULL,
      falseActRate REAL NOT NULL, ece REAL NOT NULL, n INTEGER NOT NULL, fittedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_calls (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, inputHash TEXT NOT NULL,
      latencyMs INTEGER NOT NULL, ok INTEGER NOT NULL, errorCode TEXT
    );
  `);
}

export function recordDecision(db: DatabaseSync, row: DecisionAuditRow): void {
  db.prepare(
    'INSERT OR REPLACE INTO decisions (id, ts, point, engine, model, modelVersion, inputHash, probabilities, verdict, choice, confidence, latencyMs, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id, row.ts, row.point, row.engine, row.model, row.modelVersion, row.inputHash,
    row.probabilities, row.verdict, row.choice || null, row.confidence, row.latencyMs, row.outcome || null,
  );
}

export function recordDecisionResult(
  db: DatabaseSync,
  o: { point: string; inputText: string; result: DecisionResult; modelVersion?: string; outcome?: string },
): string {
  const id = `dec-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  recordDecision(db, {
    id,
    ts: Date.now(),
    point: o.point,
    engine: o.result.engineId,
    model: o.result.model,
    modelVersion: o.modelVersion || '',
    inputHash: hashInput(o.inputText),
    probabilities: JSON.stringify(o.result.probabilities),
    verdict: o.result.verdict,
    choice: o.result.choice,
    confidence: o.result.confidence,
    latencyMs: o.result.latencyMs,
    outcome: o.outcome,
  });
  return id;
}

/** UI chip: "Fast path · Laya · 0.97 · 33ms" (names + numbers, never text). */
export function decisionChip(result: DecisionResult): string {
  return `Fast path · ${result.engineId} · ${result.confidence.toFixed(2)} · ${result.latencyMs}ms`;
}
