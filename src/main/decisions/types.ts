/** Decision Engine domain types (pure, no I/O).
 *
 * A decision is a PROPOSAL: it never bypasses tool validation, path
 * confinement, risk policy or approval cards. Engines may only make Nexio
 * MORE cautious, never less.
 */

/** Typed question kinds a System One model answers natively. */
export type QuestionKind = 'choice' | 'boolean' | 'score';

export interface ChoiceQuestion {
  type: 'choice';
  id: string;
  instructions: string;
  /** option -> one-line meaning. MUST include a none/abstain option. */
  options: Record<string, string>;
}

export interface BooleanQuestion {
  type: 'boolean';
  id: string;
  instructions: string;
}

export interface ScoreQuestion {
  type: 'score';
  id: string;
  instructions: string;
  /** Ordered levels, e.g. ['not urgent', 'soon', 'blocking']. */
  levels: string[];
}

export type DecisionQuestion = ChoiceQuestion | BooleanQuestion | ScoreQuestion;

/** A typed question set the engine answers about the user's own text. */
export interface DecisionPoint {
  id: string;
  questions: DecisionQuestion[];
  /** Budget for the whole point (all questions answered in one round trip). */
  timeoutMs: number;
}

export type DecisionVerdict = 'act' | 'confirm' | 'fallthrough';

export interface DecisionResult {
  verdict: DecisionVerdict;
  /** Winning choice for single-choice points (undefined when fallthrough). */
  choice?: string;
  /** Per-option probabilities for the primary choice question. */
  probabilities: Record<string, number>;
  /** Calibrated confidence of the verdict (0..1). */
  confidence: number;
  engineId: string;
  model: string;
  latencyMs: number;
  /** Secondary question answers (choice string | boolean | score number). */
  details?: Record<string, string | boolean | number>;
}

/** What the engine needs: typed user text + minimal in-scope context. */
export interface DecisionContext {
  /** The user's own typed text (or exact slash args). Never file contents,
   * web pages, MCP output, attachment text or model output. */
  text: string;
  mode: 'ask' | 'do';
  /** Names + descriptions of in-scope tools only (disabled tools hidden). */
  tools: Array<{ name: string; description: string }>;
  locale?: string;
}

/** Capabilities an engine declares; the router only sends supported points. */
export type DecisionCapability = 'route' | 'dispatch' | 'classify' | 'context';

export interface DecisionEngine {
  readonly id: string;
  readonly capabilities: ReadonlySet<DecisionCapability>;
  isAvailable(): boolean;
  decide(point: DecisionPoint, ctx: DecisionContext, signal?: AbortSignal): Promise<DecisionResult>;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Clamp to [0,1]; non-finite becomes 0 (fail-closed on confidence). */
export function sanitizeConfidence(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
