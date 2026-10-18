import type { DatabaseSync } from 'node:sqlite';
import type { Settings } from '../../shared/types';
import type { SearchOptions, SearchResult, WebAvailability, WebProviderId } from './types';
import { MAX_FETCHES_PER_RUN, MAX_SEARCHES_PER_RUN, WebError } from './types';
import { createSearchProvider, isWebProviderId } from './providers/index';
import { getCachedFetch, getCachedSearch, searchKey, setCachedFetch, setCachedSearch } from './cache';
import { readSecret } from '../secrets/index';
import { scanSecretsText } from '../../shared/attachments';

export const WEB_SECRET_PREFIX = 'web:';
export function webSecretId(provider: string): string {
  return `${WEB_SECRET_PREFIX}${provider}`;
}

export interface WebConfig {
  provider: WebProviderId;
  credential: string;
  maxResults: number;
  allowAsk: boolean;
  region?: string;
  language?: string;
  saveQueries: boolean;
  allowlist: string[];
}

export function getWebConfig(s: Settings, db?: DatabaseSync): { config: WebConfig; keyState: 'ok' | 'missing' | 'unreadable' } {
  const provider = (s.webProvider || 'off') as WebProviderId;
  const maxResults = Math.min(Math.max(s.webMaxResults || 5, 1), 20);
  const allowAsk = s.webAllowAsk !== false;
  const cfg: WebConfig = {
    provider,
    credential: '',
    maxResults,
    allowAsk,
    region: s.webRegion || undefined,
    language: s.webLanguage || undefined,
    saveQueries: s.webSaveQueries === true,
    allowlist: s.webAllowlist || [],
  };
  if (provider === 'off') return { config: cfg, keyState: 'missing' };
  if (provider === 'searxng') {
    const url = (s.webUrl || '').trim();
    if (!url) return { config: cfg, keyState: 'missing' };
    cfg.credential = url;
    return { config: cfg, keyState: 'ok' };
  }
  if (db) {
    const r = readSecret(db, webSecretId(provider));
    if (!r.ok) return { config: cfg, keyState: r.reason === 'missing' ? 'missing' : 'unreadable' };
    cfg.credential = r.value;
    if (!cfg.credential) return { config: cfg, keyState: 'missing' };
    return { config: cfg, keyState: 'ok' };
  }
  const envKey = process.env.NEXIO_SEARCH_KEY || '';
  if (!envKey && provider === 'brave') return { config: cfg, keyState: 'missing' };
  cfg.credential = provider === 'brave' ? envKey : (s.webUrl || '').trim();
  if (!cfg.credential) return { config: cfg, keyState: 'missing' };
  return { config: cfg, keyState: 'ok' };
}

export function getAvailability(s: Settings, mode: 'ask' | 'do', db?: DatabaseSync): WebAvailability {
  const provider = (s.webProvider || 'off') as WebProviderId;
  if (!provider || provider === 'off') return { state: 'not_configured' };
  if (!isWebProviderId(provider)) return { state: 'not_configured' };
  if (mode === 'ask') {
    const { config, keyState } = getWebConfig(s, db);
    if (keyState === 'missing') return { state: 'not_configured' };
    if (keyState === 'unreadable') return { state: 'error', code: 'KEY_UNREADABLE' };
    if (!config.allowAsk) return { state: 'disabled_in_mode' };
    return { state: 'available', provider };
  }
  const { keyState } = getWebConfig(s, db);
  if (keyState === 'missing') return { state: 'not_configured' };
  if (keyState === 'unreadable') return { state: 'error', code: 'KEY_UNREADABLE' };
  return { state: 'available', provider };
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
    const known = ['anthropic', 'github', 'scion', 'searxng', 'brave'];
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

export async function runSearch(
  s: Settings,
  db: DatabaseSync | undefined,
  query: string,
  opts: SearchOptions,
  budget?: WebRunBudget,
  logQuery?: (q: string) => void,
): Promise<{ results: SearchResult[]; provider: string; ms: number; cached: boolean; reformulated?: string }> {
  const { config, keyState } = getWebConfig(s, db);
  if (config.provider === 'off') throw new WebError('NOT_CONFIGURED', 'web search is off. Set it up in Settings > Web search', { action: 'open-settings' });
  if (keyState === 'unreadable') throw new WebError('KEY_UNREADABLE', 'saved search key cannot be read. Re-enter it in Settings > Web search', { action: 'open-settings' });
  if (keyState === 'missing') throw new WebError('NOT_CONFIGURED', 'web search is off. Set it up in Settings > Web search', { action: 'open-settings' });
  if (!isWebProviderId(config.provider)) throw new WebError('NOT_CONFIGURED', 'web search is off. Set it up in Settings > Web search', { action: 'open-settings' });
  if (looksLikeSecrets(query)) throw new WebError('PROVIDER_ERROR', 'query looks like it contains secrets; refusing to send');
  if (budget) checkSearchBudget(budget);
  const count = Math.min(Math.max(opts.count || config.maxResults || 5, 1), 20);
  const provider = createSearchProvider(config.provider, config.credential, opts.fetchFn);
  const key = searchKey(config.provider, query, count);
  const hit = getCachedSearch<{ results: SearchResult[] }>(key);
  const t0 = Date.now();
  if (hit) return { results: hit.results, provider: config.provider, ms: Date.now() - t0, cached: true };
  const searchOpts: SearchOptions = {
    allowlist: config.allowlist,
    count,
    signal: opts.signal,
    fetchFn: opts.fetchFn,
    ...(opts.recency ? { recency: opts.recency } : {}),
    ...(config.region || opts.country ? { country: opts.country || config.region } : {}),
    ...(config.language || opts.language ? { language: opts.language || config.language } : {}),
  };
  try {
    const results = await provider.search(query, searchOpts);
    if (budget) budget.searches++;
    setCachedSearch(key, { results });
    if (config.saveQueries && logQuery) logQuery(query);
    return { results, provider: config.provider, ms: Date.now() - t0, cached: false };
  } catch (e) {
    if (e instanceof WebError && e.code === 'NO_RESULTS') {
      const retry = reformulateQuery(query);
      if (retry && retry.toLowerCase() !== query.toLowerCase()) {
        const results = await provider.search(retry, searchOpts);
        if (budget) budget.searches++;
        setCachedSearch(searchKey(config.provider, retry, count), { results });
        return { results, provider: config.provider, ms: Date.now() - t0, cached: false, reformulated: retry };
      }
    }
    throw e;
  }
}

export async function testWebConfig(
  s: Settings,
  db: DatabaseSync | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string; ms?: number; count?: number }> {
  const t0 = Date.now();
  try {
    const r = await runSearch(s, db, 'Nexio connectivity test', { count: 1, fetchFn }, undefined, undefined);
    const ms = Date.now() - t0;
    return { ok: true, message: `Works: ${r.results.length} result(s) in ${ms} ms`, ms, count: r.results.length };
  } catch (e) {
    if (e instanceof WebError) return { ok: false, message: `${e.code}: ${e.message.replace(/^.*?: /, '')}` };
    return { ok: false, message: `NETWORK: ${(e as Error).message}` };
  }
}

export function describeWebState(s: Settings, mode: 'ask' | 'do', db?: DatabaseSync): string {
  const a = getAvailability(s, mode, db);
  if (a.state === 'available') return 'available';
  if (a.state === 'not_configured') return 'not_configured';
  if (a.state === 'disabled_in_mode') return 'disabled_in_mode';
  return `error:${a.code}`;
}
