/** ONE System One HTTP adapter (infrastructure).
 *
 * Speaks POST {baseUrl}/v1/systemone with {state, questions} and reads typed
 * answers. Verified against https://pydantic.dev/docs/ai/models/system-one/ :
 * decision models answer typed questions (pick-one / yes-no / rubric) with
 * probabilities and confidence — no text generation, nothing to parse.
 * Endpoint profiles (Jev cloud, Laya local, any compatible incl. Ollama) are
 * configuration, not code forks. No vendor SDK: Nexio has zero runtime deps.
 */
import type { DecisionContext, DecisionPoint, DecisionResult } from './types';
import { isRecord, sanitizeConfidence } from './types';
import { NONE_OPTION, toVerdict, type PointThresholds } from './points';

export interface SystemOneProfile {
  /** API root, e.g. https://api.typesafe.ai or http://127.0.0.1:8000.
   * The client appends /v1/systemone. Local profiles must be loopback. */
  baseUrl: string;
  model: string;
  /** Cloud (Jev) keys live in the OS secret store; local servers use a random token. */
  apiKey?: string;
  timeoutMs: number;
  thresholds: PointThresholds;
}

type WireQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string }
  | { type: 'score'; instructions: string; criteria: string[] };

interface WireAnswer {
  type: string;
  choice?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
  noul?: unknown;
}

function toWire(point: DecisionPoint): Record<string, WireQuestion> {
  const out: Record<string, WireQuestion> = {};
  for (const q of point.questions) {
    if (q.type === 'choice') {
      const criteria: Record<string, string | null> = {};
      for (const [opt, meaning] of Object.entries(q.options)) criteria[opt] = meaning || null;
      out[q.id] = { type: 'choice', instructions: q.instructions, criteria };
    } else if (q.type === 'boolean') {
      out[q.id] = { type: 'noul', instructions: q.instructions };
    } else {
      out[q.id] = { type: 'score', instructions: q.instructions, criteria: [...q.levels] };
    }
  }
  return out;
}

/** Loopback-only guard for local profiles (fail-closed). */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1');
  } catch {
    return false;
  }
}

function probRecord(v: unknown): Record<string, number> {
  if (!isRecord(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v)) {
    const n = typeof p === 'number' ? p : Number.NaN;
    if (Number.isFinite(n)) out[k] = Math.min(1, Math.max(0, n));
  }
  return out;
}

/** Secondary question answers (choice string | boolean | score number). */
function collectDetails(
  point: DecisionPoint,
  answers: Record<string, unknown>,
): Record<string, string | boolean | number> {
  const details: Record<string, string | boolean | number> = {};
  for (const q of point.questions.slice(1)) {
    const raw = answers[q.id];
    if (!isRecord(raw)) continue;
    if (q.type === 'choice' && raw.type === 'choice' && typeof raw.choice === 'string') {
      if (raw.choice in q.options && raw.choice !== NONE_OPTION) details[q.id] = raw.choice;
    } else if (q.type === 'boolean' && raw.type === 'noul' && typeof raw.noul === 'number') {
      details[q.id] = raw.noul >= 0.5;
    }
  }
  return details;
}

export async function systemOneDecide(
  profile: SystemOneProfile,
  point: DecisionPoint,
  ctx: DecisionContext,
  opts: { fetchFn?: typeof fetch; localOnly?: boolean } = {},
): Promise<DecisionResult> {
  const t0 = Date.now();
  const fail = (latencyMs: number): DecisionResult => ({
    verdict: 'fallthrough',
    probabilities: {},
    confidence: 0,
    engineId: 'systemone',
    model: profile.model,
    latencyMs,
  });
  // why: a local profile pointing at the network is a misconfiguration that
  // would leak typed user text — refuse before any byte leaves.
  if (opts.localOnly && !isLoopbackUrl(profile.baseUrl)) return fail(Date.now() - t0);
  let base: URL;
  try {
    base = new URL(profile.baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return fail(Date.now() - t0);
  } catch {
    return fail(Date.now() - t0);
  }
  const url = new URL('v1/systemone', base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(profile.timeoutMs, point.timeoutMs));
  try {
    const fetchFn = opts.fetchFn || fetch;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: profile.model, state: ctx.text, questions: toWire(point) }),
      signal: controller.signal,
    });
    if (!res.ok) return fail(Date.now() - t0);
    const body = await res.json() as unknown;
    if (!isRecord(body) || !isRecord(body.answers)) return fail(Date.now() - t0);
    const answers = body.answers as Record<string, unknown>;
    const primary = point.questions[0];
    const raw = answers[primary.id] as WireAnswer | undefined;
    if (!isRecord(raw) || typeof raw.type !== 'string') return fail(Date.now() - t0);
    const details = collectDetails(point, answers);
    const withDetails = <T extends object>(r: T): T & { details: Record<string, string | boolean | number> } =>
      ({ ...r, details });
    if (primary.type === 'choice' && raw.type === 'choice' && typeof raw.choice === 'string') {
      // why: unknown choices (model drift/version skew) never arm anything.
      if (!(raw.choice in (primary.options as Record<string, string>))) return fail(Date.now() - t0);
      const probs = probRecord(raw.probabilities);
      const conf = sanitizeConfidence(raw.confidence);
      const { verdict, choice } = toVerdict(point.id, raw.choice, conf, profile.thresholds);
      return withDetails({ verdict, choice, probabilities: probs, confidence: conf, engineId: 'systemone', model: profile.model, latencyMs: Date.now() - t0 });
    }
    if (primary.type === 'boolean' && raw.type === 'noul' && typeof raw.noul === 'number') {
      const p = Math.min(1, Math.max(0, raw.noul));
      const conf = Math.max(p, 1 - p);
      const yes = p >= profile.thresholds.act;
      return withDetails({
        verdict: yes ? 'act' : 'fallthrough',
        probabilities: { yes: p, no: 1 - p },
        confidence: conf,
        engineId: 'systemone',
        model: profile.model,
        latencyMs: Date.now() - t0,
      });
    }
    return fail(Date.now() - t0);
  } catch {
    return fail(Date.now() - t0);
  } finally {
    clearTimeout(timer);
  }
}

/** Connection test for Settings: answers a trivial choice, executes nothing. */
export async function systemOneTest(
  profile: SystemOneProfile,
  opts: { fetchFn?: typeof fetch; localOnly?: boolean } = {},
): Promise<{ ok: boolean; latencyMs: number; model?: string; error?: string }> {
  const t0 = Date.now();
  const r = await systemOneDecide(profile, {
    id: 'connection_test',
    timeoutMs: 8000,
    questions: [{
      type: 'choice',
      id: 'q',
      instructions: 'Connection test: which is this?',
      options: { test: 'a connection test', [NONE_OPTION]: 'none of these' },
    }],
  }, { text: 'connection test', mode: 'ask', tools: [] }, opts);
  const ms = Date.now() - t0;
  if (r.verdict === 'fallthrough' && r.confidence === 0) return { ok: false, latencyMs: ms, error: 'endpoint unreachable or schema violation' };
  return { ok: true, latencyMs: ms, model: profile.model };
}
