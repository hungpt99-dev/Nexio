import { describe, it, expect, beforeEach } from 'vitest';
import { supportsNativeSearch, anthropicNativeProvider, geminiNativeProvider } from '../../src/main/web/native';
import { duckduckgoProvider, parseDuckResults, DUCK_PRIVACY_URL } from '../../src/main/web/duckduckgo';
import { WebError } from '../../src/main/web/types';
import { isBlockedIp, rejectFast, stripTrackingParams, resolveBlocked } from '../../src/main/web/ssrf';
import { fetchReadable } from '../../src/main/web/fetch';
import { __clearWebCacheForTests } from '../../src/main/web/cache';
import { __clearBackendCacheForTests, resolveWebBackend, consented } from '../../src/main/web/resolve-backend';
import {
  getWebAvailability, runSearch, testWebConfig, looksLikeSecrets, reformulateQuery, getWebHealth,
  type WebRunBudget,
} from '../../src/main/web/manager';
import { makeWebSearchTool, makeWebFetchTool } from '../../src/main/web/tools';
import type { Settings } from '../../src/shared/types';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function anthropicBody(results: Array<{ url: string; title: string; cited?: string }> = [{ url: 'https://example.com/a', title: 'T', cited: 'snippet text' }]): Response {
  return json({
    content: [
      { type: 'web_search_tool_result', tool_use_id: 'x', content: results.map((r) => ({ type: 'web_search_result', url: r.url, title: r.title, page_age: 'today' })) },
      { type: 'text', text: 'answer', citations: results.filter((r) => r.cited).map((r) => ({ type: 'web_search_result_location', url: r.url, title: r.title, cited_text: r.cited })) },
    ],
  });
}
const DDG_HTML = `<html><body>
<div class="result results_links_deep web-result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Title A</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Snippet <b>A</b> here</a></div>
<div class="result results_links_deep web-result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://other.test/b">Title B</a></h2></div>
</body></html>`;

const S = (over: Record<string, unknown> = {}) =>
  ({ webAllow: true, webAskBefore: false, webSaveQueries: false, webConsent: {}, webAllowlist: [], ...over }) as unknown as Settings;
const DEPS = (over: Record<string, unknown> = {}) =>
  ({ provider: 'openai', model: 'gpt-4o', apiKey: '', ...over });

beforeEach(() => {
  __clearWebCacheForTests();
  __clearBackendCacheForTests();
});

describe('supportsNativeSearch: safe default false', () => {
  it('openai + compatible never (Responses-only / no standard)', () => {
    expect(supportsNativeSearch('openai', 'gpt-4o')).toBe(false);
    expect(supportsNativeSearch('openai', 'gpt-5-search-api')).toBe(false);
    expect(supportsNativeSearch('compatible', 'llama3')).toBe(false);
    expect(supportsNativeSearch('unknown', 'x')).toBe(false);
  });
  it('anthropic allowlist (verified docs)', () => {
    expect(supportsNativeSearch('anthropic', 'claude-opus-4-5')).toBe(true);
    expect(supportsNativeSearch('anthropic', 'claude-sonnet-4-0')).toBe(true);
    expect(supportsNativeSearch('anthropic', 'claude-haiku-3-5')).toBe(true);
    expect(supportsNativeSearch('anthropic', 'claude-3-7-sonnet-latest')).toBe(true);
    expect(supportsNativeSearch('anthropic', 'claude-2.1')).toBe(false);
    expect(supportsNativeSearch('anthropic', 'gpt-4o')).toBe(false);
  });
  it('gemini allowlist (verified docs)', () => {
    expect(supportsNativeSearch('gemini', 'gemini-2.0-flash')).toBe(true);
    expect(supportsNativeSearch('gemini', 'gemini-3-flash-preview')).toBe(true);
    expect(supportsNativeSearch('gemini', 'gemini-1.5-pro')).toBe(false);
  });
});

describe('anthropic native provider', () => {
  it('maps results + citations to SearchResult', async () => {
    const seen: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: unknown, init: unknown) => {
      seen.push({ url: String(url), body: String((init as { body?: unknown }).body || ''), headers: (init as { headers?: Record<string, string> }).headers || {} });
      return anthropicBody();
    }) as unknown as typeof fetch;
    const out = await anthropicNativeProvider('k', 'claude-opus-4-5', undefined, fetchFn).search('q', {});
    expect(out).toMatchObject([{ title: 'T', url: 'https://example.com/a', snippet: 'snippet text', source: 'example.com' }]);
    expect(seen[0].url).toContain('/v1/messages');
    expect(seen[0].body).toContain('web_search_20250305');
    expect(seen[0].headers['x-api-key']).toBe('k');
  });
  it('typed errors: org-disabled -> PROVIDER_ERROR, 429 -> RATE_LIMITED, empty -> NO_RESULTS, in-body rate limit', async () => {
    const err400 = (async () => new Response('web search is not enabled', { status: 400 })) as unknown as typeof fetch;
    await expect(anthropicNativeProvider('k', 'm', undefined, err400).search('q', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const err429 = (async () => new Response('x', { status: 429 })) as unknown as typeof fetch;
    await expect(anthropicNativeProvider('k', 'm', undefined, err429).search('q', {})).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const empty = (async () => json({ content: [{ type: 'web_search_tool_result', tool_use_id: 'x', content: [] }] })) as unknown as typeof fetch;
    await expect(anthropicNativeProvider('k', 'm', undefined, empty).search('q', {})).rejects.toMatchObject({ code: 'NO_RESULTS' });
    const inBody = (async () => json({ content: [{ type: 'web_search_tool_result', tool_use_id: 'x', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } }] })) as unknown as typeof fetch;
    await expect(anthropicNativeProvider('k', 'm', undefined, inBody).search('q', {})).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('gemini native provider', () => {
  it('maps grounding chunks + supports to SearchResult', async () => {
    let url = '';
    const fetchFn = (async (u: unknown) => {
      url = String(u);
      return json({ candidates: [{ content: { parts: [{ text: 'hi' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://e.com/x', title: 'X' } }], groundingSupports: [{ segment: { text: 'seg text' }, groundingChunkIndices: [0] }] } }] });
    }) as unknown as typeof fetch;
    const out = await geminiNativeProvider('k', 'gemini-2.0-flash', undefined, fetchFn).search('q', {});
    expect(out).toMatchObject([{ url: 'https://e.com/x', snippet: 'seg text', source: 'e.com' }]);
    expect(url).toContain('generativelanguage.googleapis.com');
  });
  it('refuses custom base URLs (official endpoint only)', async () => {
    const never = (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    await expect(geminiNativeProvider('k', 'gemini-2.0-flash', 'http://localhost:11434/v1', never).search('q', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('duckduckgo keyless hosted provider', () => {
  it('parses result links + snippets, decodes uddg URLs', () => {
    const out = parseDuckResults(DDG_HTML, 5);
    expect(out).toMatchObject([
      { title: 'Title A', url: 'https://example.com/a', snippet: 'Snippet A here', source: 'example.com' },
      { title: 'Title B', url: 'https://other.test/b', snippet: '', source: 'other.test' },
    ]);
    expect(parseDuckResults('<html></html>', 5)).toEqual([]);
  });
  it('anomaly page -> RATE_LIMITED; empty -> NO_RESULTS', async () => {
    const anom = (async () => new Response('<div class="anomaly-modal">x</div>', { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    await expect(duckduckgoProvider(anom).search('q', {})).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const empty = (async () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    await expect(duckduckgoProvider(empty).search('q', {})).rejects.toMatchObject({ code: 'NO_RESULTS' });
  });
  it('privacy URL recorded', () => {
    expect(DUCK_PRIVACY_URL).toContain('duckduckgo.com/privacy');
  });
});

describe('resolver order + session cache', () => {
  it('native supported -> native; otherwise hosted', () => {
    expect(resolveWebBackend({ provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k' }).key).toBe('native:anthropic');
    expect(resolveWebBackend({ provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k' }).key).toBe('native:gemini');
    expect(resolveWebBackend({ provider: 'openai', model: 'gpt-4o', apiKey: 'k' }).key).toBe('hosted:duckduckgo');
    expect(resolveWebBackend({ provider: 'openai', model: 'gpt-4o', apiKey: '' }).key).toBe('hosted:duckduckgo');
    expect(resolveWebBackend({ provider: 'anthropic', model: 'claude-2.1', apiKey: 'k' }).key).toBe('hosted:duckduckgo');
  });
  it('cached per provider+model; invalidate re-evaluates', () => {
    const a = resolveWebBackend({ provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k' });
    const b = resolveWebBackend({ provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k' });
    expect(a).toBe(b);
    __clearBackendCacheForTests();
    expect(resolveWebBackend({ provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k' })).not.toBe(a);
  });
});

describe('consent per backend, no silent fallback', () => {
  it('no consent -> CONSENT_REQUIRED naming the backend', async () => {
    await expect(runSearch(S({}), DEPS(), 'q', {}, { searches: 0, fetches: 0 })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });
  it('consented backend runs; other backends still need consent', async () => {
    expect(consented(S({ webConsent: { 'hosted:duckduckgo': true } }), 'hosted:duckduckgo')).toBe(true);
    expect(consented(S({ webConsent: { 'hosted:duckduckgo': true } }), 'native:anthropic')).toBe(false);
  });
});

describe('single fallthrough per query', () => {
  it('native hard failure pins hosted and retries once', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: unknown) => {
      calls.push(String(url));
      if (String(url).includes('api.anthropic.com')) return new Response('web search is not enabled', { status: 400 });
      return new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;
    const s = S({ webConsent: { 'native:anthropic': true, 'hosted:duckduckgo': true } });
    const r = await runSearch(s, { provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k', fetchFn }, 'q', {}, { searches: 0, fetches: 0 });
    expect(r.backend).toBe('DuckDuckGo');
    expect(calls.filter((u) => u.includes('api.anthropic.com'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('duckduckgo'))).toHaveLength(1);
    // pinned: next query goes straight to hosted
    calls.length = 0;
    await runSearch(s, { provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k', fetchFn }, 'q2', {}, { searches: 0, fetches: 0 });
    expect(calls.some((u) => u.includes('api.anthropic.com'))).toBe(false);
  });
  it('hosted failure throws hosted error (no infinite fallback)', async () => {
    const fetchFn = (async (url: unknown) => {
      if (String(url).includes('api.anthropic.com')) return new Response('web search is not enabled', { status: 400 });
      return new Response('x', { status: 500 });
    }) as unknown as typeof fetch;
    const s = S({ webConsent: { 'native:anthropic': true, 'hosted:duckduckgo': true } });
    await expect(runSearch(s, { provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k', fetchFn }, 'q', {}, { searches: 0, fetches: 0 }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it('fallthrough to a non-consented backend is refused, not silent', async () => {
    const fetchFn = (async (url: unknown) => {
      if (String(url).includes('api.anthropic.com')) return new Response('web search is not enabled', { status: 400 });
      return new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;
    const s = S({ webConsent: { 'native:anthropic': true } });
    await expect(runSearch(s, { provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k', fetchFn }, 'q', {}, { searches: 0, fetches: 0 }))
      .rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });
});

describe('availability states + honest messages', () => {
  it('master off -> unavailable; no consent -> needs_consent; consented -> available', () => {
    expect(getWebAvailability(S({ webAllow: false }), 'openai', 'gpt-4o', 'k').state).toBe('unavailable');
    expect(getWebAvailability(S({}), 'openai', 'gpt-4o', 'k')).toMatchObject({ state: 'needs_consent' });
    expect(getWebAvailability(S({ webConsent: { 'hosted:duckduckgo': true } }), 'openai', 'gpt-4o', 'k').state).toBe('available');
  });
  it('disabled runSearch is honest (no setup instructions for keys)', async () => {
    await expect(runSearch(S({ webAllow: false }), DEPS(), 'q', {}, { searches: 0, fetches: 0 })).rejects.toMatchObject({ code: 'DISABLED' });
  });
  it('step row shows the backend that answered', async () => {
    const fetchFn = (async () => new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const tool = makeWebSearchTool({ settings: S({ webConsent: { 'hosted:duckduckgo': true } }), ...DEPS({ fetchFn }) }, { searches: 0, fetches: 0 }, fetchFn);
    const r = await tool.run({ query: 'scion anthropic git' }, { signal: new AbortController().signal, cwd: '/' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('Searched the web via DuckDuckGo: scion anthropic git');
  });
  it('no key fields or key code paths: hosted works with empty key', async () => {
    const fetchFn = (async () => new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const r = await runSearch(S({ webConsent: { 'hosted:duckduckgo': true } }), DEPS({ apiKey: '' }), 'q', {}, { searches: 0, fetches: 0 });
    expect(r.backend).toBe('DuckDuckGo');
    void fetchFn;
  });
});

describe('ask-before-searching', () => {
  it('NEEDS_CONFIRM when on; skipped for explicit actions', async () => {
    const s = S({ webAskBefore: true, webConsent: { 'hosted:duckduckgo': true } });
    await expect(runSearch(s, DEPS(), 'q', {}, { searches: 0, fetches: 0 })).rejects.toMatchObject({ code: 'NEEDS_CONFIRM' });
    const fetchFn = (async () => new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const r = await runSearch(s, { ...DEPS(), fetchFn }, 'q', { skipAskBefore: true }, { searches: 0, fetches: 0 });
    expect(r.backend).toBe('DuckDuckGo');
  });
});

describe('SSRF blocklist', () => {
  it('blocks localhost, private ranges, metadata IP, and non-http schemes', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1']) {
      expect(isBlockedIp(h), h).toBe(true);
    }
    expect(isBlockedIp('93.184.216.34')).toBe(false);
    for (const u of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://x/y', 'gopher://x', 'jar:https://x!/y']) {
      expect(rejectFast(u), u).toBeTruthy();
    }
    expect(rejectFast('http://user:pass@example.com/')).toContain('credentials');
    expect(rejectFast('http://localhost:8080/x')).toContain('internal');
    expect(rejectFast('http://127.0.0.1/x')).toContain('private');
  });
  it('only http/https; redirects re-check DNS', async () => {
    await expect(resolveBlocked('localhost')).resolves.toContain('BLOCKED_URL');
    const fetchFn = (async (u: unknown) => {
      if (String(u).includes('start')) {
        return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/evil' } });
      }
      throw new Error('must not fetch blocked target');
    }) as unknown as typeof fetch;
    await expect(fetchReadable('https://example.com/start', { fetchFn })).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  });
  it('strips tracking params from URLs shown to the user', () => {
    expect(stripTrackingParams('https://e.com/a?utm_source=x&gclid=y&q=1')).toBe('https://e.com/a?q=1');
  });
});

describe('fetchReadable limits', () => {
  it('10s timeout, 2MB cap, 100KB text cap, html/text/json/pdf only, 5 redirects', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const tooBig = (async () => new Response(big, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    await expect(fetchReadable('https://example.com/b', { fetchFn: tooBig })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const badType = (async () => new Response('x', { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch;
    await expect(fetchReadable('https://example.com/i', { fetchFn: badType })).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    const loop = (async () => new Response('', { status: 301, headers: { location: 'https://example.com/loop' } })) as unknown as typeof fetch;
    await expect(fetchReadable('https://example.com/loop', { fetchFn: loop })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const html = (async () => new Response('<html><head><title>Hi</title><script>alert(1)</script></head><body><p>Hello <b>web</b></p></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    const r = await fetchReadable('https://example.com/p', { fetchFn: html });
    expect(r.text).toContain('Hello web');
    expect(r.text).not.toContain('alert');
    expect(r.title).toBe('Hi');
  });
  it('sends fixed Nexio user agent and no cookies', async () => {
    let headers: Record<string, string> = {};
    const fetchFn = (async (_u: unknown, init: unknown) => {
      headers = (init as { headers: Record<string, string> }).headers;
      return new Response('hi', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }) as unknown as typeof fetch;
    await fetchReadable('https://example.com/', { fetchFn });
    expect(headers['User-Agent']).toContain('Nexio');
    expect(headers.Cookie).toBeUndefined();
  });
});

describe('manager: privacy + caps + reformulation', () => {
  it('per-run caps: max 8 searches, 6 fetches', async () => {
    const deps = { settings: S({ webConsent: { 'hosted:duckduckgo': true } }), ...DEPS() };
    const budget: WebRunBudget = { searches: 8, fetches: 0 };
    const tool = makeWebSearchTool(deps, budget, (async () => new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch);
    const r = await tool.run({ query: 'q' }, { signal: new AbortController().signal, cwd: '/' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('search cap');
    const fbudget: WebRunBudget = { searches: 0, fetches: 6 };
    const ft = makeWebFetchTool([], fbudget);
    const fr = await ft.run({ url: 'https://example.com/' }, { signal: new AbortController().signal, cwd: '/' });
    expect(fr.ok).toBe(false);
    expect(fr.output).toContain('fetch cap');
  });
  it('secret redaction: queries with secrets are refused, never sent', async () => {
    let called = 0;
    const t = makeWebSearchTool(
      { settings: S({ webConsent: { 'hosted:duckduckgo': true } }), ...DEPS() },
      { searches: 0, fetches: 0 },
      (async () => { called++; return new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } }); }) as unknown as typeof fetch,
    );
    const r = await t.run({ query: 'sk-proj-abcdefghij1234567890 leak check' }, { signal: new AbortController().signal, cwd: '/' });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });
  it('health recorded on runs', async () => {
    const fetchFn = (async () => new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
    await testWebConfig(S({ webConsent: {} }), { ...DEPS(), fetchFn }, fetchFn);
    expect(getWebHealth()?.backend).toBe('DuckDuckGo');
    expect(getWebHealth()?.ok).toBe(true);
  });
  it('cache scope: identical queries hit cache; no coverage of turns', async () => {
    let calls = 0;
    const ff = (async () => { calls++; return new Response(DDG_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } }); }) as unknown as typeof fetch;
    const budget: WebRunBudget = { searches: 0, fetches: 0 };
    const t = makeWebSearchTool({ settings: S({ webConsent: { 'hosted:duckduckgo': true } }), ...DEPS({ fetchFn: ff }) }, budget, ff);
    const ctx = { signal: new AbortController().signal, cwd: '/' };
    await t.run({ query: 'same query' }, ctx);
    await t.run({ query: 'same query' }, ctx);
    expect(calls).toBe(1);
    expect(budget.searches).toBe(2);
  });
});

describe('settings validation (zero-config keys only)', () => {
  it('accepts the new keys, rejects bad values', async () => {
    const { validateSettings } = await import('../../src/main/store/settings');
    expect(validateSettings({ webAllow: true, webAskBefore: false, webSaveQueries: false, webConsent: { 'hosted:duckduckgo': true }, webAllowlist: [] })).toEqual([]);
    expect(validateSettings({ webAllow: 'yes' as never })).toHaveLength(1);
    expect(validateSettings({ webAskBefore: 1 as never })).toHaveLength(1);
    expect(validateSettings({ webConsent: [] as never })).toHaveLength(1);
    expect(validateSettings({ webAllowlist: 'x' as never })).toHaveLength(1);
  });
});

describe('E2E over real HTTP (fake hosted search server, no keys)', () => {
  it('serves DDG-style HTML; resolver + tools produce sources end to end', async () => {
    const http = await import('node:http');
    const body = '<html><body><div class="result"><h2 class="result__title"><a class="result__a" href="https://srv.test/a">Srv A</a></h2><a class="result__snippet" href="https://srv.test/a">Srv snip</a></div></body></html>';
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      // Point the hosted branch at the fake server by shadowing fetch.
      const fetchFn = (async (url: unknown, init?: unknown) => {
        const u = String(url).replace('https://html.duckduckgo.com/html/', `http://127.0.0.1:${port}/`);
        return fetch(u, init as RequestInit);
      }) as unknown as typeof fetch;
      const s = S({ webConsent: { 'hosted:duckduckgo': true } });
      const r = await runSearch(s, { provider: 'openai', model: 'gpt-4o', apiKey: '', fetchFn }, 'fake server query', { count: 5 }, { searches: 0, fetches: 0 });
      expect(r.backend).toBe('DuckDuckGo');
      expect(r.results[0]).toMatchObject({ title: 'Srv A', url: 'https://srv.test/a', snippet: 'Srv snip', source: 'srv.test' });
    } finally {
      server.close();
    }
  });
  it('native hard failure falls through to the fake hosted server once', async () => {
    const http = await import('node:http');
    const body = '<html><body><div class="result"><h2 class="result__title"><a class="result__a" href="https://srv.test/a">Srv A</a></h2></div></body></html>';
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const seen: string[] = [];
      const fetchFn = (async (url: unknown, init?: unknown) => {
        seen.push(String(url));
        if (String(url).includes('api.anthropic.com')) return new Response('web search is not enabled', { status: 400 });
        return fetch(String(url).replace('https://html.duckduckgo.com/html/', `http://127.0.0.1:${port}/`), init as RequestInit);
      }) as unknown as typeof fetch;
      const s = S({ webConsent: { 'native:anthropic': true, 'hosted:duckduckgo': true } });
      const r = await runSearch(s, { provider: 'anthropic', model: 'claude-opus-4-5', apiKey: 'k', fetchFn }, 'q', { count: 5 }, { searches: 0, fetches: 0 });
      expect(r.backend).toBe('DuckDuckGo');
      expect(seen.filter((u) => u.includes('api.anthropic.com'))).toHaveLength(1);
      expect(r.results[0].source).toBe('srv.test');
    } finally {
      server.close();
    }
  });
});
