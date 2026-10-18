/** Decision engine implementations (infrastructure).
 *
 * All engines OFF until the user configures one in Settings. No engine logs
 * keys or text (see audit.ts). Fail-closed: anything unexpected -> fallthrough.
 */
import type { DecisionContext, DecisionEngine, DecisionPoint, DecisionResult } from './types';
import { sanitizeConfidence } from './types';
import { NONE_OPTION, toVerdict } from './points';
import { systemOneDecide, type SystemOneProfile } from './systemone';

function fallthrough(engineId: string, model: string, latencyMs: number): DecisionResult {
  return { verdict: 'fallthrough', probabilities: {}, confidence: 0, engineId, model, latencyMs };
}

/** The main engine: System One API (Jev cloud / Laya local / compatible). */
export class SystemOneEngine implements DecisionEngine {
  readonly capabilities = new Set(['route', 'dispatch', 'classify', 'context'] as const);
  private available = true;

  constructor(
    readonly id: string,
    private readonly profile: SystemOneProfile,
    private readonly opts: { fetchFn?: typeof fetch; localOnly?: boolean } = {},
  ) {}

  isAvailable(): boolean {
    return this.available;
  }

  /** Transport flips unavailable after a failure; Settings re-enables. */
  markDown(): void {
    this.available = false;
  }

  async decide(point: DecisionPoint, ctx: DecisionContext, signal?: AbortSignal): Promise<DecisionResult> {
    const t0 = Date.now();
    if (signal?.aborted) return fallthrough(this.id, this.profile.model, 0);
    try {
      const r = await systemOneDecide(this.profile, point, ctx, this.opts);
      if (r.verdict === 'fallthrough' && r.confidence === 0) this.markDown();
      return { ...r, engineId: this.id };
    } catch {
      this.markDown();
      return fallthrough(this.id, this.profile.model, Date.now() - t0);
    }
  }
}

/** Provider-native constrained decoding (OFF by default).
 *
 * Uses the provider's NATIVE schema-constrained output / tool calling with an
 * enum of only in-scope choices. No text-JSON parsing, no regex extraction.
 * Unavailable when the provider lacks constrained output — the caller checks
 * `isAvailable()` and falls through. The `complete` fn is injected so this
 * module never touches provider SDKs directly.
 */
export class StructuredModelEngine implements DecisionEngine {
  readonly capabilities = new Set(['route', 'dispatch', 'classify', 'context'] as const);

  constructor(
    readonly id: string,
    private readonly complete: ((prompt: { choices: string[]; text: string }, signal?: AbortSignal) => Promise<{ choice: string; confidence: number }>) | null,
  ) {}

  isAvailable(): boolean {
    return this.complete !== null;
  }

  async decide(point: DecisionPoint, ctx: DecisionContext, signal?: AbortSignal): Promise<DecisionResult> {
    const t0 = Date.now();
    const fail = fallthrough(this.id, 'structured', Date.now() - t0);
    if (!this.complete || signal?.aborted) return fail;
    const primary = point.questions[0];
    if (primary.type !== 'choice') return fail;
    const choices = Object.keys(primary.options);
    try {
      // why: the enum travels AS the schema, so the model cannot return an
      // out-of-scope value — no parsing layer exists to be fooled.
      const { choice, confidence } = await this.complete({ choices, text: ctx.text }, signal);
      if (!choices.includes(choice)) return { ...fail, latencyMs: Date.now() - t0 };
      const conf = sanitizeConfidence(confidence);
      const probs: Record<string, number> = {};
      for (const c of choices) probs[c] = c === choice ? conf : (1 - conf) / Math.max(1, choices.length - 1);
      const { verdict, choice: win } = toVerdict(point.id, choice, conf, { act: 0.85, confirm: 0.55 });
      void NONE_OPTION;
      return { verdict, choice: win, probabilities: probs, confidence: conf, engineId: this.id, model: 'structured', latencyMs: Date.now() - t0 };
    } catch {
      return { ...fail, latencyMs: Date.now() - t0 };
    }
  }
}

/** Adapter slot for on-device classifiers (e.g. Needle 3 by Cactus Compute,
 * Apache-2.0 — verified https://huggingface.co/Cactus-Compute/needle3).
 * Interface + mock only in this run: the real adapter arrives with a Needle
 * runtime binding and ships separately from model weights. */
export interface OnDeviceClassifier {
  /** Pick one of `choices` for `text`, or null to abstain. */
  classify(text: string, choices: string[], signal?: AbortSignal): Promise<{ choice: string; confidence: number } | null>;
}

export class OnDeviceEngine implements DecisionEngine {
  readonly capabilities = new Set(['route', 'dispatch', 'classify'] as const);

  constructor(readonly id: string, private readonly backend: OnDeviceClassifier | null) {}

  isAvailable(): boolean {
    return this.backend !== null;
  }

  async decide(point: DecisionPoint, ctx: DecisionContext, signal?: AbortSignal): Promise<DecisionResult> {
    const t0 = Date.now();
    const fail = fallthrough(this.id, 'on-device', 0);
    if (!this.backend || signal?.aborted) return fail;
    const primary = point.questions[0];
    if (primary.type !== 'choice') return { ...fail, latencyMs: Date.now() - t0 };
    const choices = Object.keys(primary.options);
    try {
      // why: null = the classifier abstains (mirrors Needle's empty-list
      // contract) — abstention always falls through, never guesses.
      const r = await this.backend.classify(ctx.text, choices, signal);
      if (!r || !choices.includes(r.choice)) return { ...fail, latencyMs: Date.now() - t0 };
      const conf = sanitizeConfidence(r.confidence);
      const probs: Record<string, number> = {};
      for (const c of choices) probs[c] = c === r.choice ? conf : (1 - conf) / Math.max(1, choices.length - 1);
      const { verdict, choice } = toVerdict(point.id, r.choice, conf, { act: 0.85, confirm: 0.55 });
      return { verdict, choice, probabilities: probs, confidence: conf, engineId: this.id, model: 'on-device', latencyMs: Date.now() - t0 };
    } catch {
      return { ...fail, latencyMs: Date.now() - t0 };
    }
  }
}

/** Deterministic mock for tests and the Settings test box. */
export class MockEngine implements DecisionEngine {
  readonly capabilities: ReadonlySet<'route' | 'dispatch' | 'classify' | 'context'>;

  constructor(
    readonly id = 'mock',
    private readonly answer: { choice: string; confidence: number } | null = null,
    caps: Array<'route' | 'dispatch' | 'classify' | 'context'> = ['route', 'dispatch', 'classify', 'context'],
  ) {
    this.capabilities = new Set(caps);
  }

  isAvailable(): boolean {
    return true;
  }

  async decide(point: DecisionPoint, _ctx: DecisionContext, signal?: AbortSignal): Promise<DecisionResult> {
    const t0 = Date.now();
    if (signal?.aborted || !this.answer) {
      return fallthrough(this.id, 'mock', Date.now() - t0);
    }
    const primary = point.questions[0];
    const choices = primary.type === 'choice' ? Object.keys(primary.options) : [];
    if (!choices.includes(this.answer.choice)) return fallthrough(this.id, 'mock', Date.now() - t0);
    const conf = sanitizeConfidence(this.answer.confidence);
    const probs: Record<string, number> = {};
    for (const c of choices) probs[c] = c === this.answer.choice ? conf : 0;
    const { verdict, choice } = toVerdict(point.id, this.answer.choice, conf, { act: 0.85, confirm: 0.55 });
    return { verdict, choice, probabilities: probs, confidence: conf, engineId: this.id, model: 'mock', latencyMs: Date.now() - t0 };
  }
}
