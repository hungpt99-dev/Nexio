import type { SearchOptions, SearchProvider, SearchResult } from './types';
import { WebError } from './types';

// Keyless hosted fallback: DuckDuckGo HTML endpoint. No key, no account.
// Verified live 2026-10-18: GET https://html.duckduckgo.com/html/?q=...
// returns result blocks with a.result__a (href //duckduckgo.com/l/?uddg=<url>&...)
// and a.result__snippet. Unofficial HTML surface: rate-limited aggressively,
// markup may change — every anomaly maps to a typed error, never silent.
const ENDPOINT = 'https://html.duckduckgo.com/html/';
export const DUCK_PRIVACY_URL = 'https://duckduckgo.com/privacy';

function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/gi, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&b;/g, '');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function realUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return ''; }
  }
  if (/^https?:\/\//i.test(href)) return href;
  return '';
}

/** Parse result blocks out of DDG html. Exported for tests. */
export function parseDuckResults(html: string, count: number): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snips: string[] = [];
  const sre = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = sre.exec(html)) && snips.length < 50) snips.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(html)) && out.length < count) {
    const url = realUrl(decodeEntities(m[1]));
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const title = stripTags(m[2]) || url;
    let source = '';
    try { source = new URL(url).hostname; } catch { /* keep empty */ }
    out.push({ title, url, snippet: snips[i] || '', source });
    i++;
  }
  return out;
}

export function duckduckgoProvider(fetchFn: typeof fetch = fetch): SearchProvider {
  return {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const q = query.trim();
      if (!q) throw new WebError('PROVIDER_ERROR', 'empty query');
      const count = Math.min(Math.max(opts.count || 5, 1), 20);
      const params = new URLSearchParams({ q });
      let res: Response;
      try {
        res = await fetchFn(`${ENDPOINT}?${params.toString()}`, {
          headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; Nexio/1.0)' },
          signal: opts.signal,
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw new WebError('TIMEOUT', 'search timed out');
        throw new WebError('NETWORK', `search request failed: ${(e as Error).message}`);
      }
      if (res.status === 429) throw new WebError('RATE_LIMITED', 'search rate limited (http 429): try again shortly', { status: 429, action: 'retry' });
      if (res.status === 202 || res.status === 403) throw new WebError('RATE_LIMITED', 'search throttled by the hosted provider: try again shortly', { status: res.status, action: 'retry' });
      if (!res.ok) throw new WebError('PROVIDER_ERROR', `search failed (http ${res.status})`, { status: res.status });
      const html = await res.text().catch(() => '');
      if (/anomaly-modal|challenge-form/i.test(html)) throw new WebError('RATE_LIMITED', 'search throttled by the hosted provider: try again shortly', { action: 'retry' });
      const out = parseDuckResults(html, count);
      if (!out.length) throw new WebError('NO_RESULTS', 'no results found');
      return out;
    },
  };
}
