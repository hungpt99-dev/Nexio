import type { SearchOptions, SearchProvider, SearchResult } from '../types';
import { WebError } from '../types';
import { rejectFast, resolveBlocked } from '../ssrf';

function mapResults(json: unknown): SearchResult[] {
  const j = json as { results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string; engine?: string }> };
  const list = j?.results || [];
  return list.map((r) => {
    let source = '';
    try { source = new URL(r.url || '').hostname; } catch { source = String(r.engine || ''); }
    return {
      title: String(r.title || r.url || 'Untitled'),
      url: String(r.url || ''),
      snippet: String(r.content || ''),
      source,
      ...(r.publishedDate ? { date: String(r.publishedDate) } : {}),
    };
  }).filter((r) => r.url);
}

export function searxngProvider(baseUrl: string, fetchFn: typeof fetch = fetch): SearchProvider {
  return {
    id: 'searxng',
    label: 'SearXNG',
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const q = query.trim();
      if (!q) throw new WebError('PROVIDER_ERROR', 'empty query');
      const base = baseUrl.replace(/\/+$/, '');
      const fast = rejectFast(base, opts.allowlist);
      if (fast) throw new WebError('BLOCKED_URL', fast.replace(/^BLOCKED_URL: /, ''), { action: null });
      try {
        const host = new URL(base).hostname;
        const blocked = await resolveBlocked(host, undefined as never);
        const allowed = (opts.allowlist || []).some((a) => host.toLowerCase() === a.toLowerCase());
        if (blocked && !allowed) throw new WebError('BLOCKED_URL', blocked.replace(/^BLOCKED_URL: /, ''), { action: null });
      } catch (e) {
        if (e instanceof WebError) throw e;
      }
      const params = new URLSearchParams({ q, format: 'json' });
      if (opts.language) params.set('language', opts.language);
      if (opts.recency === 'day') params.set('time_range', 'day');
      else if (opts.recency === 'week' || opts.recency === 'month') params.set('time_range', 'month');
      else if (opts.recency === 'year') params.set('time_range', 'year');
      let res: Response;
      try {
        res = await fetchFn(`${base}/search?${params.toString()}`, {
          headers: { Accept: 'application/json' },
          signal: opts.signal,
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw new WebError('TIMEOUT', 'search timed out');
        throw new WebError('NETWORK', `search request failed: ${(e as Error).message}`);
      }
      if (res.status === 403) throw new WebError('PROVIDER_ERROR', 'search rejected (http 403): enable format=json on your SearXNG instance', { status: 403 });
      if (res.status === 429) throw new WebError('RATE_LIMITED', 'search rate limited (http 429): try again shortly', { status: 429, action: 'retry' });
      if (!res.ok) throw new WebError('PROVIDER_ERROR', `search failed (http ${res.status})`, { status: res.status });
      let json: unknown;
      try { json = await res.json(); } catch { throw new WebError('PROVIDER_ERROR', 'search returned invalid JSON'); }
      const out = mapResults(json);
      if (!out.length) throw new WebError('NO_RESULTS', 'no results found');
      return out;
    },
  };
}
