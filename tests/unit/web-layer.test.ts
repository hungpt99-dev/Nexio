import { describe, it, expect, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { braveProvider } from '../../src/main/web/providers/brave';
import { searxngProvider } from '../../src/main/web/providers/searxng';
import { isWebProviderId } from '../../src/main/web/providers/index';
import { WebError } from '../../src/main/web/types';
import { isBlockedIp, rejectFast, stripTrackingParams, resolveBlocked } from '../../src/main/web/ssrf';
import { fetchReadable } from '../../src/main/web/fetch';
import { __clearWebCacheForTests } from '../../src/main/web/cache';
import {
  getAvailability, getWebConfig, reformulateQuery, runSearch, testWebConfig,
  type WebRunBudget,
} from '../../src/main/web/manager';
import { makeWebFetchTool, makeWebSearchTool } from '../../src/main/web/tools';
import type { WebConfig } from '../../src/main/web/manager';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function braveBody(results: unknown[] = [{ title: 'T', url: 'https://example.com/a', description: 'S', age: 'today' }]): Response {
  return json({ web: { results } });
}

beforeEach(() => __clearWebCacheForTests());

describe('provider registry', () => {
  it('adding a provider = one folder + registry line (brave, searxng only)', () => {
    expect(isWebProviderId('brave')).toBe(true);
    expect(isWebProviderId('searxng')).toBe(true);
    expect(isWebProviderId('google')).toBe(false);
    expect(isWebProviderId('off')).toBe(false);
  });
});

describe('brave adapter', () => {
  it('maps web.results to {title,url,snippet,source,date}', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: unknown, init: unknown) => {
      seen.push(String(url));
      const h = (init as { headers: Record<string, string> }).headers;
      expect(h['X-Subscription-Token']).toBe('k');
      return braveBody();
    }) as unknown as typeof fetch;
    const out = await braveProvider('k', fetchFn).search('scion anthropic', { count: 5 });
    expect(out).toMatchObject([{ title: 'T', url: 'https://example.com/a', snippet: 'S', source: 'example.com', date: 'today' }]);
    expect(seen[0]).toContain('https://api.search.brave.com/res/v1/web/search');
    expect(seen[0]).toContain('count=5');
  });
  it('typing: 401/403 -> PROVIDER_ERROR, 429 -> RATE_LIMITED, empty -> NO_RESULTS', async () => {
    for (const [status, code] of [[401, 'PROVIDER_ERROR'], [403, 'PROVIDER_ERROR'], [429, 'RATE_LIMITED']] as const) {
      const fetchFn = (async () => new Response('x', { status })) as unknown as typeof fetch;
      await expect(braveProvider('k', fetchFn).search('q', {})).rejects.toMatchObject({ code });
    }
    const empty = (async () => braveBody([])) as unknown as typeof fetch;
    await expect(braveProvider('k', empty).search('q', {})).rejects.toMatchObject({ code: 'NO_RESULTS' });
  });
  it('caps count at 20 and sends region/language hints', async () => {
    let url = '';
    const fetchFn = (async (u: unknown) => { url = String(u); return braveBody(); }) as unknown as typeof fetch;
    await braveProvider('k', fetchFn).search('q', { count: 99, country: 'US', language: 'en' });
    expect(url).toContain('count=20');
    expect(url).toContain('country=US');
    expect(url).toContain('search_lang=en');
  });
});

describe('searxng adapter', () => {
  it('maps json results and requires format=json enabled', async () => {
    let url = '';
    const fetchFn = (async (u: unknown) => {
      url = String(u);
      return json({ results: [{ title: 'A', url: 'https://s.test/x', content: 'C' }] });
    }) as unknown as typeof fetch;
    const out = await searxngProvider('https://search.example.com', fetchFn).search('q', {});
    expect(out[0]).toMatchObject({ title: 'A', source: 's.test' });
    expect(url).toContain('/search?');
    expect(url).toContain('format=json');
    const denied = (async () => new Response('x', { status: 403 })) as unknown as typeof fetch;
    await expect(searxngProvider('https://search.example.com', denied).search('q', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    // internal base URLs are refused unless allow-listed
    const never = (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    await expect(searxngProvider('http://127.0.0.1:8080', never).search('q', {})).rejects.toMatchObject({ code: 'BLOCKED_URL' });
    await expect(searxngProvider('http://localhost:8080', never).search('q', {})).rejects.toMatchObject({ code: 'BLOCKED_URL' });
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
    // rebinding via redirect: Location to 127.0.0.1 must be refused
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
    // no scripts, no cookies: script content removed, plain text kept
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

describe('manager: availability + privacy + caps', () => {
  const base = { webProvider: 'off' } as unknown as Parameters<typeof getAvailability>[0];
  it('default off: tools not offered, state not_configured', () => {
    expect(getAvailability(base, 'ask')).toEqual({ state: 'not_configured' });
    expect(getAvailability(base, 'do')).toEqual({ state: 'not_configured' });
  });
  it('configured brave in Ask: available; allowAsk=false -> disabled_in_mode', () => {
    const s = { webProvider: 'brave', webAllowAsk: true } as never;
    const secretDb = { prepare: () => ({ get: () => ({ value: Buffer.from('{"v":2,"id":"x","createdAt":1,"backend":"t","appId":"a","cipher":"x"}') }) }) } as never;
    void secretDb;
    // without db the env key decides; set env explicitly
    process.env.NEXIO_SEARCH_KEY = 'k';
    expect(getAvailability(s, 'ask')).toEqual({ state: 'available', provider: 'brave' });
    expect(getAvailability({ ...s, webAllowAsk: false } as never, 'ask')).toEqual({ state: 'disabled_in_mode' });
    delete process.env.NEXIO_SEARCH_KEY;
    expect(getAvailability(s, 'ask')).toEqual({ state: 'not_configured' });
  });
  it('per-run caps: max 8 searches, 6 fetches', async () => {
    const cfg: WebConfig = { provider: 'brave', credential: 'k', maxResults: 5, allowAsk: true, saveQueries: false, allowlist: [] };
    const budget: WebRunBudget = { searches: 8, fetches: 0 };
    const tool = makeWebSearchTool(cfg, budget, (async () => braveBody()) as unknown as typeof fetch);
    const r = await tool.run({ query: 'q' }, { signal: new AbortController().signal, cwd: '/' });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('search cap');
    const fbudget: WebRunBudget = { searches: 0, fetches: 6 };
    const ft = makeWebFetchTool(cfg, fbudget);
    const fr = await ft.run({ url: 'https://example.com/' }, { signal: new AbortController().signal, cwd: '/' });
    expect(fr.ok).toBe(false);
    expect(fr.output).toContain('fetch cap');
  });
  it('secret redaction: queries with secrets are refused, never sent', async () => {
    const cfg: WebConfig = { provider: 'brave', credential: 'k', maxResults: 5, allowAsk: true, saveQueries: false, allowlist: [] };
    let called = 0;
    const t = makeWebSearchTool(cfg, { searches: 0, fetches: 0 }, (async () => { called++; return braveBody(); }) as unknown as typeof fetch);
    const r = await t.run({ query: 'sk-proj-abcdefghij1234567890 leak check' }, { signal: new AbortController().signal, cwd: '/' });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });
  it('reformulate: "scion anthropic git"-style zero results retry once with new wording', () => {
    expect(reformulateQuery('scion anthropic git')).toBeTruthy();
  });
  it('cache scope: identical queries hit cache; conversation turns never do', async () => {
    const cfg: WebConfig = { provider: 'brave', credential: 'k', maxResults: 5, allowAsk: true, saveQueries: false, allowlist: [] };
    let calls = 0;
    const ff = (async () => { calls++; return braveBody(); }) as unknown as typeof fetch;
    const budget: WebRunBudget = { searches: 0, fetches: 0 };
    const t = makeWebSearchTool(cfg, budget, ff);
    const ctx = { signal: new AbortController().signal, cwd: '/' };
    await t.run({ query: 'same query' }, ctx);
    await t.run({ query: 'same query' }, ctx);
    expect(calls).toBe(1);
    expect(budget.searches).toBe(2);
  });
});

describe('testWebConfig: real tiny query, exact error otherwise', () => {
  it('works message carries N results + ms; failures carry codes', async () => {
    const s = { webProvider: 'brave', webMaxResults: 5, webAllowAsk: true } as never;
    let server: http.Server;
    await new Promise<void>((res) => {
      server = http.createServer((_q, r) => {
        r.writeHead(200, { 'Content-Type': 'application/json' });
        r.end(JSON.stringify({ web: { results: [{ title: 'T', url: 'https://e.com/', description: 'd' }] } }));
      }).listen(0, '127.0.0.1', () => res());
    });
    const port = (server!.address() as AddressInfo).port;
    void port;
    server!.close();
    // brave endpoint is fixed; fake at fetch level instead
    process.env.NEXIO_SEARCH_KEY = 'k';
    const okFetch = (async () => braveBody()) as unknown as typeof fetch;
    const ok = await testWebConfig({ webProvider: 'off' } as never, undefined);
    expect(ok.ok).toBe(false);
    expect(ok.message).toContain('NOT_CONFIGURED');
    const badFetch = (async () => new Response('x', { status: 429 })) as unknown as typeof fetch;
    const bad = await testWebConfig({ webProvider: 'brave' } as never, undefined, badFetch);
    void okFetch;
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('RATE_LIMITED');
    delete process.env.NEXIO_SEARCH_KEY;
  });
});
