/** Engine registry + router (application).
 *
 * Engines run in the user's configured order, only among those declaring the
 * capability. Deterministic fallback chain, fail-closed: error, timeout,
 * endpoint down, schema violation, unknown choice -> fallthrough. No
 * per-engine branching in the turn path — callers use `decide()` only.
 */
import type { DecisionCapability, DecisionContext, DecisionEngine, DecisionPoint, DecisionResult } from './types';

export interface Registry {
  engines: DecisionEngine[];
}

export function createRegistry(engines: DecisionEngine[] = []): Registry {
  return { engines: [...engines] };
}

function fallthrough(point: DecisionPoint): DecisionResult {
  return { verdict: 'fallthrough', probabilities: {}, confidence: 0, engineId: 'none', model: '', latencyMs: 0 };
}

function capabilityFor(point: DecisionPoint): DecisionCapability {
  if (point.id === 'route_mode') return 'route';
  if (point.id === 'dispatch_command') return 'dispatch';
  if (point.id === 'classify_intent') return 'classify';
  return 'context';
}

/** Route a point through configured engines in order; first non-fallthrough wins. */
export async function decide(
  registry: Registry,
  point: DecisionPoint,
  ctx: DecisionContext,
  signal?: AbortSignal,
): Promise<DecisionResult> {
  const cap = capabilityFor(point);
  const t0 = Date.now();
  for (const engine of registry.engines) {
    if (signal?.aborted) break;
    if (!engine.capabilities.has(cap) || !engine.isAvailable()) continue;
    try {
      const r = await engine.decide(point, ctx, signal);
      if (r.verdict !== 'fallthrough') return r;
    } catch {
      continue;
    }
  }
  return { ...fallthrough(point), latencyMs: Date.now() - t0 };
}
