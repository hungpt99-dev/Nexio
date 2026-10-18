import type { Settings } from '../../shared/types';
import type { SearchOptions, SearchResult, WebAvailability, WebErrorCode } from './types';
import { MAX_FETCHES_PER_RUN, MAX_SEARCHES_PER_RUN, WebError } from './types';
import { consented, invalidateBackend, resolveWebBackend, type BackendKey, type ResolvedBackend } from './resolve-backend';
import { getCachedSearch, searchKey, setCachedSearch } from './cache';
import { scanSecretsText } from '../../shared/attachments';

export const WEB_MAX_RESULTS = 5;

export interface SearchDeps {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/** Last backend health, for the Settings status line (in-memory only). */
let lastHealth: { backend: string; ok: boolean; at: number; detail: string } | null = null;
export function getWebHealth(): typeof lastHealth {
  return lastHealth;
}
function noteHealth(backend: string, ok: boolean, detail: string): void {
  lastHealth = { backend, ok, at: Date.now(), detail };
}

/** Structured availability, computed each run (no secrets logged). */
export function getWebAvailability(s: Settings, provider: string, model: string, apiKey: string): WebAvailability {
  if (s.webAllow === false) return { state: 'unavailable', reason: 'disabled' };
  const backend = resolveWebBackend({ provider, model, apiKey, baseUrl: s.baseUrl, fetchFn: undefined });
  if (!consented(s, backend.key)) return { state: 'needs_consent', backend: backend.key, name: backend.name };
  return { state: 'available', backend: backend.key, name: backend.name };
}

export function describeWebState(s: Settings, provider: string, model: string, apiKey: string): string {
  const a = getWebAvailability(s, provider, model, apiKey);
  if (a.state === 'available') return 'available';
  if (a.state === 'needs_consent') return 'needs_consent';
  return 'unavailable:disabled';
}

/** Per-run caps. Counts live on the run, never global. */
export interface WebRunBudget {
  searches: number;
  fetches: number;
}
export function checkSearchBudget(b: WebRunBudget): void {
  if (b.searches >= MAX_SEARCHES_PER_RUN) throw new WebError('PROVIDER_ERROR', `search cap reached (${MAX_SEARCHES_PER_RUN} per run)`);
}
export function checkFetchBudget(b: WebRunBudget): void {
  if (b.fetches >= MAX_FETCHES_PER_RUN) throw new WebError('PROVIDER_ERROR', `fetch cap reached (${MAX_FETCHES_PER_RUN} per run)`);
}

export function looksLikeSecrets(query: string): boolean {
  return scanSecretsText(query);
}

/** Reformulate once for NO_RESULTS: split glued words like "scion anthropic git". */
export function reformulateQuery(q: string): string | null {
  const t = q.trim();
  if (!t) return null;
  const spaced = t.replace(/([a-z])([A-Z])/g, '$1 $2');
  const parts = spaced.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    const lower = t.toLowerCase();
    const known = ['anthropic', 'github', 'scion', 'duckduckgo', 'gemini'];
    for (const k of known) {
      const i = lower.indexOf(k);
      if (i > 0) return `${t.slice(0, i).trim()} ${t.slice(i).trim()}`;
      if (i === 0 && lower.length > k.length) return `${t.slice(0, k.length).trim()} ${t.slice(k.length).trim()}`;
    }
    return null;
  }
  const variants = [`${parts.join(' ')} git`, parts.join(' OR ')];
  const cand = variants.find((v) => v.toLowerCase() !== t.toLowerCase());
  return cand || null;
}

export interface RunSearchOpts extends SearchOptions {
  /** Explicit user action (Test button, /search, inline confirm): skip ask-before. */
  skipAskBefore?: boolean;
}

function errorCode(e: unknown): WebErrorCode | 'OTHER' {
  return e instanceof WebError ? e.code : 'OTHER';
}

/** One fallthrough per query, only to a consented backend. Never silent. */
export async function runSearch(
  s: Settings,
  deps: SearchDeps,
  query: string,
  opts: RunSearchOpts,
  budget?: WebRunBudget,
  logQuery?: (q: string) => void,
): Promise<{ results: SearchResult[]; backend: string; backendKey: BackendKey; ms: number; cached: boolean; reformulated?: string }> {
  if (s.webAllow === false) throw new WebError('DISABLED', 'web search is off. Turn it on in Settings > Web search', { action: 'open-settings' });
  if (looksLikeSecrets(query)) throw new WebError('PROVIDER_ERROR', 'query looks like it contains secrets; refusing to send');
  if (budget) checkSearchBudget(budget);
  // Attempts count even on cache hits (bounds runaway loops, not just provider calls).
  if (budget) budget.searches++;
  const count = Math.min(Math.max(opts.count || WEB_MAX_RESULTS, 1), 20);
  const baseInput = { provider: deps.provider, model: deps.model, apiKey: deps.apiKey, baseUrl: deps.baseUrl, fetchFn: opts.fetchFn || deps.fetchFn };
  let backend: ResolvedBackend = resolveWebBackend(baseInput);
  const needConsent = (b: ResolvedBackend): void => {
    if (!consented(s, b.key)) {
      throw new WebError('CONSENT_REQUIRED', `web search via ${b.name} needs your go-ahead`, { action: 'open-settings', backend: b.key, privacyUrl: b.privacyUrl });
    }
  };
  needConsent(backend);
  if (s.webAskBefore === true && !opts.skipAskBefore) {
    throw new WebError('NEEDS_CONFIRM', `search the web via ${backend.name} for "${query.trim().slice(0, 120)}"?`, { action: null, backend: backend.key });
  }
  const key = searchKey(backend.key, query, count);
  const hit = getCachedSearch<{ results: SearchResult[] }>(key);
  const t0 = Date.now();
  if (hit) {
    noteHealth(backend.name, true, 'cached');
    return { results: hit.results, backend: backend.name, backendKey: backend.key, ms: Date.now() - t0, cached: true };
  }
  const searchOpts: SearchOptions = {
    count,
    signal: opts.signal,
    fetchFn: opts.fetchFn || deps.fetchFn,
    ...(opts.recency ? { recency: opts.recency } : {}),
  };
  const attempt = async (b: ResolvedBackend, q: string): Promise<SearchResult[]> => {
    const results = await b.search(q, searchOpts);
    setCachedSearch(searchKey(b.key, q, count), { results });
    if (s.webSaveQueries === true && logQuery) logQuery(q);
    noteHealth(b.name, true, `${results.length} result(s)`);
    return results;
  };
  try {
    const results = await attempt(backend, query);
    return { results, backend: backend.name, backendKey: backend.key, ms: Date.now() - t0, cached: false };
  } catch (e) {
    if (e instanceof WebError && e.code === 'NO_RESULTS') {
      const retry = reformulateQuery(query);
      if (retry && retry.toLowerCase() !== query.toLowerCase()) {
        try {
          const results = await attempt(backend, retry);
          return { results, backend: backend.name, backendKey: backend.key, ms: Date.now() - t0, cached: false, reformulated: retry };
        } catch (e2) {
          throw e2;
        }
      }
    }
    // Single fallthrough per query, only to a consented backend.
    const transient = e instanceof WebError && (e.code === 'RATE_LIMITED' || e.code === 'TIMEOUT' || e.code === 'NETWORK');
    const hard = e instanceof WebError && (e.code === 'PROVIDER_ERROR' || e.code === 'UNSUPPORTED_TYPE');
    if ((transient || hard) && backend.key !== 'hosted:duckduckgo') {
      invalidateBackend(baseInput, !transient);
      const next = resolveWebBackend(baseInput);
      if (next.key !== backend.key) {
        try {
          needConsent(next);
        } catch (consentErr) {
          throw consentErr;
        }
        const results = await attempt(next, query);
        return { results, backend: next.name, backendKey: next.key, ms: Date.now() - t0, cached: false, reformulated: undefined };
      }
      invalidateBackend(baseInput);
    }
    if (e instanceof WebError) {
      if (e.code !== 'NO_RESULTS') noteHealth(backend.name, false, errorCode(e));
      throw e;
    }
    noteHealth(backend.name, false, 'NETWORK');
    throw new WebError('NETWORK', `search failed: ${(e as Error).message}`, { action: 'retry' });
  }
}

export async function testWebConfig(
  s: Settings,
  deps: SearchDeps,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string; backend?: string; ms?: number; count?: number }> {
  const t0 = Date.now();
  try {
    // The Test button is an explicit user action: consent + ask-before are bypassed.
    const backend = resolveWebBackend({ ...deps, fetchFn });
    const r = await runSearch({ ...s, webAskBefore: false, webConsent: { ...s.webConsent, [backend.key]: true } }, deps, 'Nexio connectivity test', { count: 1, fetchFn, skipAskBefore: true }, undefined, undefined);
    const ms = Date.now() - t0;
    return { ok: true, message: `Works via ${r.backend}: ${r.results.length} result(s) in ${ms} ms`, backend: r.backend, ms, count: r.results.length };
  } catch (e) {
    if (e instanceof WebError) return { ok: false, message: `${e.code}: ${e.message.replace(/^.*?: /, '')}`, backend: undefined };
    return { ok: false, message: `NETWORK: ${(e as Error).message}` };
  }
}
