import type { SearchOptions, SearchProvider, SearchResult } from '../types';
import { WebError } from '../types';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

function mapResults(json: unknown): SearchResult[] {
  const j = json as { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string; profile?: { name?: string } }> } };
  const list = j?.web?.results || [];
  return list.map((r) => {
    let source = '';
    try { source = new URL(r.url || '').hostname; } catch { source = r.profile?.name || ''; }
    return {
      title: String(r.title || r.url || 'Untitled'),
      url: String(r.url || ''),
      snippet: String(r.description || ''),
      source,
      ...(r.age ? { date: String(r.age) } : {}),
    };
  }).filter((r) => r.url);
}

export function braveProvider(apiKey: string, fetchFn: typeof fetch = fetch): SearchProvider {
  return {
    id: 'brave',
    label: 'Brave Search',
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const q = query.trim();
      if (!q) throw new WebError('PROVIDER_ERROR', 'empty query');
      const count = Math.min(Math.max(opts.count || 5, 1), 20);
      const params = new URLSearchParams({ q, count: String(count) });
      if (opts.country) params.set('country', opts.country);
      if (opts.language) params.set('search_lang', opts.language);
      if (opts.recency === 'day') params.set('freshness', 'pd');
      else if (opts.recency === 'week') params.set('freshness', 'pw');
      else if (opts.recency === 'month') params.set('freshness', 'pm');
      else if (opts.recency === 'year') params.set('freshness', 'py');
      let res: Response;
      try {
        res = await fetchFn(`${ENDPOINT}?${params.toString()}`, {
          headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
          signal: opts.signal,
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw new WebError('TIMEOUT', 'search timed out');
        throw new WebError('NETWORK', `search request failed: ${(e as Error).message}`);
      }
      if (res.status === 401 || res.status === 403) throw new WebError('PROVIDER_ERROR', `search rejected (http ${res.status}): check your Brave API key`, { status: res.status });
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
export const BRAVE_ENDPOINT = ENDPOINT;
