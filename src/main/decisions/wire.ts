/** Turn-path wiring for the Decision Engine (application).
 *
 * Single place that builds a registry from Settings and maps engine results
 * onto the typed shapes the turn path consumes. Inputs are the user's own
 * typed text only. Every mapping fails closed to null (offline behavior).
 * Audit rows carry hashes and metadata only — never text, never keys.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Settings } from '../../shared/types';
import { getSecret } from '../store/secrets';
import { decisionKeyService } from '../store/secrets';
import { ALL_TOOLS } from '../agent/tools/registry';
import { registryFromSettings, decisionsEnabled, decideRouteMode, decideMemoryIntent, decideContextRoute, decideDispatch, type DecisionSettings } from './index';
import { recordDecisionResult, decisionChip } from './audit';
import type { MemoryDecision } from '../memory/classify';

function settingsOf(s: Settings): DecisionSettings {
  const d = s.decisions;
  if (!d || typeof d !== 'object') return { order: [], endpoints: [], toolScope: [], rules: [] };
  return {
    order: Array.isArray(d.order) ? d.order.filter((x): x is string => typeof x === 'string') : [],
    endpoints: Array.isArray(d.endpoints) ? d.endpoints : [],
    toolScope: Array.isArray(d.toolScope) ? d.toolScope.filter((x): x is string => typeof x === 'string') : [],
    rules: [],
  };
}

function scopeFor(s: Settings, mode: 'ask' | 'do') {
  const scoped = (s.decisions?.toolScope || []).filter((n) => typeof n === 'string' && n);
  const tools = ALL_TOOLS
    .filter((t) => (scoped.length ? scoped.includes(t.name) : true))
    .map((t) => ({ name: t.name, description: t.description, argNames: [] as string[] }));
  return { mode, tools, locale: s.locale };
}

/** Registry from settings: configured order, enabled endpoints only.
 * Null when decisions are disabled — the turn uses its offline path. */
export function registryFor(db: DatabaseSync, s: Settings) {
  const cfg = settingsOf(s);
  if (!decisionsEnabled(cfg)) return null;
  return registryFromSettings(cfg, (secretId) => getSecret(db, decisionKeyService(secretId)) || null);
}

function audit(db: DatabaseSync | undefined, point: string, text: string, r: { engineId: string; model: string; probabilities: unknown; verdict: string; choice?: string; confidence: number; latencyMs: number }): void {
  if (!db) return;
  try {
    recordDecisionResult(db, {
      point,
      inputText: text,
      result: {
        verdict: r.verdict as 'act' | 'confirm' | 'fallthrough',
        choice: r.choice,
        probabilities: (r.probabilities || {}) as Record<string, number>,
        confidence: r.confidence,
        engineId: r.engineId,
        model: r.model,
        latencyMs: r.latencyMs,
      },
    });
  } catch { /* audit never breaks runs */ }
}

/** route_mode -> 'act' | 'answer' | null (clarify/none/fallthrough -> null). */
export function routeDecideFor(db: DatabaseSync, s: Settings, mode: 'ask' | 'do', signal?: AbortSignal) {
  const reg = registryFor(db, s);
  if (!reg) return null;
  const scope = scopeFor(s, mode);
  return async (text: string): Promise<'act' | 'answer' | null> => {
    const r = await decideRouteMode(reg, text, scope, signal);
    audit(db, 'route_mode', text, r);
    if (r.verdict === 'fallthrough') return null;
    if (r.choice === 'do') return r.verdict === 'act' ? 'act' : null;
    if (r.choice === 'answer') return r.verdict === 'act' ? 'answer' : null;
    return null;
  };
}

/** classify_intent -> typed memory decision or null. */
export function memoryDecideFor(db: DatabaseSync, s: Settings, mode: 'ask' | 'do', signal?: AbortSignal) {
  const reg = registryFor(db, s);
  if (!reg) return null;
  const scope = scopeFor(s, mode);
  return async (text: string, context: string[]): Promise<MemoryDecision | null> => {
    void context;
    const r = await decideMemoryIntent(reg, text, scope, signal);
    audit(db, 'classify_intent', text, r);
    if (r.verdict === 'fallthrough' || !r.choice) return null;
    if (r.choice === 'remember' || r.choice === 'forget') {
      const kindRaw = r.details?.['kind'];
      const kind = kindRaw === 'preference' || kindRaw === 'fact' || kindRaw === 'folder_rule' || kindRaw === 'procedure'
        ? kindRaw
        : 'fact';
      return {
        intent: r.choice,
        text,
        kind,
        language: guessLanguage(text),
        pin: r.details?.['identity'] === true,
      };
    }
    return { intent: 'none', text: '', kind: 'fact', language: guessLanguage(text) };
  };
}

/** Script-based language guess (BCP-47 or 'und'). Deterministic, never a model call. */
export function guessLanguage(text: string): string {
  const t = text.normalize('NFC');
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(t)) return 'ja';
  if (/[\uac00-\ud7af]/.test(t)) return 'ko';
  if (/[\u0600-\u06ff]/.test(t)) return 'ar';
  if (/[\u0400-\u04ff]/.test(t)) return 'ru';
  if (/[\u0900-\u097f]/.test(t)) return 'hi';
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(t)) return 'vi';
  if (/[a-z]/i.test(t)) return 'en';
  return 'und';
}

export interface ContextDecision {
  needsContext: string[];
  deictic: boolean;
  ambiguity?: string[];
}

/** context_route -> sources + deictic flag or null. */
export function contextDecideFor(db: DatabaseSync, s: Settings, mode: 'ask' | 'do', signal?: AbortSignal) {
  const reg = registryFor(db, s);
  if (!reg) return null;
  const scope = scopeFor(s, mode);
  return async (text: string): Promise<ContextDecision | null> => {
    const r = await decideContextRoute(reg, text, scope, signal);
    audit(db, 'context_route', text, r);
    if (r.verdict === 'fallthrough' || !r.choice) return null;
    const src = r.choice;
    const valid = ['selection', 'files', 'folder', 'clipboard', 'page'];
    if (!valid.includes(src)) return null;
    return { needsContext: [src], deictic: r.details?.['deictic'] === true };
  };
}

/** Settings test box: type text -> see the decision. NOTHING executes.
 * Returns route + dispatch verdicts with a UI chip (names/numbers only). */
export async function testDecision(db: DatabaseSync, s: Settings, text: string, signal?: AbortSignal) {
  const reg = registryFor(db, s);
  if (!reg) return { configured: false as const };
  const scope = scopeFor(s, 'do');
  const clean = String(text || '').slice(0, 500);
  const route = await decideRouteMode(reg, clean, scope, signal);
  const dispatch = await decideDispatch(reg, clean, scope, signal);
  audit(db, 'route_mode', clean, route);
  return {
    configured: true as const,
    route: { verdict: route.verdict, choice: route.choice, confidence: route.confidence, latencyMs: route.latencyMs },
    dispatch: {
      verdict: dispatch.result.verdict,
      choice: dispatch.result.choice,
      confidence: dispatch.result.confidence,
      latencyMs: dispatch.result.latencyMs,
      shortlist: dispatch.shortlist,
    },
    chip: decisionChip(route),
  };
}
