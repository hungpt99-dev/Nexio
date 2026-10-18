/** Decision Engine composition + turn-path facade (application).
 *
 * Builds the registry from validated Settings (all engines OFF until the user
 * configures one). Inputs are the user's own typed text plus minimal context
 * (mode + in-scope tool names/descriptions) — never file contents, web
 * pages, MCP output, attachment text or model output.
 */
import type { DecisionContext, DecisionResult } from './types';
import { DEFAULT_THRESHOLDS, classifyIntentPoint, contextRoutePoint, dispatchCommandPoint, routeModePoint, type PointThresholds } from './points';
import { SystemOneEngine } from './engines';
import { createRegistry, decide } from './registry';
import { shortlistTools, type RetrievalDoc } from './retrieval';

export interface DecisionEndpointConfig {
  id: string;
  kind: 'typesafe-jev' | 'laya' | 'compatible';
  baseUrl: string;
  model: string;
  /** Secret id in the OS secret store (cloud). Empty for loopback servers. */
  secretId?: string;
  timeoutMs: number;
  thresholds: PointThresholds;
  enabled: boolean;
  /** Loopback-only enforcement for local profiles. */
  localOnly: boolean;
}

export interface DecisionSettings {
  order: string[];
  endpoints: DecisionEndpointConfig[];
  toolScope: string[];
  rules: import('./rules').DecisionRule[];
  debugText?: boolean;
}

export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  order: [],
  endpoints: [],
  toolScope: [],
  rules: [],
};

function endpointEngine(
  ep: DecisionEndpointConfig,
  apiKey: string | null,
): SystemOneEngine | null {
  if (!ep.enabled || !ep.baseUrl || !ep.model) return null;
  return new SystemOneEngine(ep.id, {
    baseUrl: ep.baseUrl,
    model: ep.model,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: ep.timeoutMs || 8000,
    thresholds: ep.thresholds || DEFAULT_THRESHOLDS,
  }, { localOnly: ep.localOnly });
}

/** Registry from settings: configured order, enabled endpoints only. */
export function registryFromSettings(
  s: DecisionSettings,
  getKey: (secretId: string) => string | null,
): ReturnType<typeof createRegistry> {
  const byId = new Map((s.endpoints || []).map((e) => [e.id, e]));
  const engines = [];
  for (const id of s.order || []) {
    const ep = byId.get(id);
    if (!ep) continue;
    const engine = endpointEngine(ep, ep.secretId ? getKey(ep.secretId) : null);
    if (engine) engines.push(engine);
  }
  return createRegistry(engines);
}

/** Offline when no engine is configured — callers use the normal chat turn. */
export function decisionsEnabled(s: DecisionSettings | undefined): boolean {
  return !!s && (s.order || []).length > 0 && (s.endpoints || []).some((e) => e.enabled);
}

export interface TurnScope {
  mode: 'ask' | 'do';
  tools: RetrievalDoc[];
  locale?: string;
}

function ctxFor(text: string, scope: TurnScope): DecisionContext {
  return {
    text: text.slice(0, 2000),
    mode: scope.mode,
    tools: scope.tools.map((t) => ({ name: t.name, description: t.description })),
    locale: scope.locale,
  };
}

/** route_mode: Ask vs Do. Fallthrough = existing clarify path. */
export async function decideRouteMode(
  registry: ReturnType<typeof createRegistry>,
  text: string,
  scope: TurnScope,
  signal?: AbortSignal,
): Promise<DecisionResult> {
  return decide(registry, routeModePoint(), ctxFor(text, scope), signal);
}

/** dispatch_command within a BM25 shortlist (narrows, never enables). */
export async function decideDispatch(
  registry: ReturnType<typeof createRegistry>,
  text: string,
  scope: TurnScope,
  signal?: AbortSignal,
): Promise<{ result: DecisionResult; shortlist: string[] }> {
  const short = shortlistTools(text, scope.tools, 12);
  const names = (short.length ? short : scope.tools).map((t) => t.name);
  const result = await decide(registry, dispatchCommandPoint(names), ctxFor(text, scope), signal);
  return { result, shortlist: names };
}

/** classify_intent for memory (remember/forget/workflow/chat). */
export async function decideMemoryIntent(
  registry: ReturnType<typeof createRegistry>,
  text: string,
  scope: TurnScope,
  signal?: AbortSignal,
): Promise<DecisionResult> {
  return decide(registry, classifyIntentPoint(), ctxFor(text, scope), signal);
}

/** context_route: which on-screen context the request needs. */
export async function decideContextRoute(
  registry: ReturnType<typeof createRegistry>,
  text: string,
  scope: TurnScope,
  signal?: AbortSignal,
): Promise<DecisionResult> {
  return decide(registry, contextRoutePoint(), ctxFor(text, scope), signal);
}
