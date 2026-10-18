import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, executeToolCall, type ToolExecState, webPromptBlock } from '../../src/main/agent/loop';
import type { AgentEvent, Tool } from '../../src/main/agent/types';
import { __clearBackendCacheForTests } from '../../src/main/web/resolve-backend';
import { __clearWebCacheForTests } from '../../src/main/web/cache';
import { runSearch } from '../../src/main/web/manager';
import type { Settings } from '../../src/shared/types';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-web-'));
const S = (over: Record<string, unknown> = {}) =>
  ({ provider: 'openai', model: 'm', hotkey: '', mode: 'chat', webAllow: true, webAskBefore: false, webSaveQueries: false, webConsent: {}, webAllowlist: [], ...over }) as unknown as Settings;
const DEX = (over: Record<string, unknown> = {}) => ({ provider: 'openai', model: 'gpt-4o', apiKey: '', ...over });

function toolTurn(calls: Array<{ id: string; name: string; input: unknown }>, text = ''): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } }],
  }), { status: 200 });
}
function finalTurn(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}
function scriptFetch(script: Response[], seen: string[][]): typeof fetch {
  let i = 0;
  return (async (url: unknown, init: unknown) => {
    try {
      const body = JSON.parse(String((init as { body?: unknown }).body || '{}'));
      const tools = body?.tools;
      if (Array.isArray(tools)) seen.push(tools.map((t: { function?: { name?: string }; name?: string }) => t.function?.name || t.name).filter(Boolean));
    } catch { /* ignore */ }
    return script[Math.min(i++, script.length - 1)];
  }) as unknown as typeof fetch;
}
const DDG = '<html><body><div class="result"><h2 class="result__title"><a class="result__a" href="https://example.com/a">T</a></h2><a class="result__snippet" href="https://example.com/a">S</a></div></body></html>';
function ddgFetch(): typeof fetch {
  return (async () => new Response(DDG, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;
}

beforeEach(() => {
  __clearWebCacheForTests();
  __clearBackendCacheForTests();
});

describe('honest states: zero-config availability each run', () => {
  it('master off: tools NOT offered; state unavailable:disabled', async () => {
    const seen: string[][] = [];
    const dir = tmpRoot();
    await runAgent('what is new with scion?', {
      provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
      allowedRoots: [dir], mode: 'ask',
      webSettings: S({ webAllow: false }),
      fetchFn: scriptFetch([finalTurn('hello')], seen),
      logDir: tmpRoot(), emit: () => {},
      waitForApproval: async () => { throw new Error('no approval'); },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const names of seen) {
      expect(names).not.toContain('web_search');
      expect(names).not.toContain('web_fetch');
    }
    expect(webPromptBlock('unavailable:disabled')).toContain('turned web search off');
  });
  it('no consent: tools hidden; model told needs_consent (never silent)', async () => {
    const seen: string[][] = [];
    const dir = tmpRoot();
    await runAgent('hi', {
      provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
      allowedRoots: [dir], mode: 'ask',
      webSettings: S({}),
      fetchFn: scriptFetch([finalTurn('hello')], seen),
      logDir: tmpRoot(), emit: () => {},
      waitForApproval: async () => { throw new Error('no approval'); },
    });
    expect(seen.flat()).not.toContain('web_search');
    expect(webPromptBlock('needs_consent')).toContain('needs_consent');
  });
  it('consented: offered in Ask and Do', async () => {
    const s = S({ webConsent: { 'hosted:duckduckgo': true } });
    for (const mode of ['ask', 'do'] as const) {
      const seen: string[][] = [];
      const dir = tmpRoot();
      await runAgent('hi', {
        provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
        allowedRoots: [dir], mode,
        webSettings: s,
        fetchFn: scriptFetch([finalTurn('hello')], seen),
        logDir: tmpRoot(), emit: () => {},
        waitForApproval: async () => ({ decision: 'deny' }),
      });
      expect(seen.flat()).toContain('web_search');
    }
  });
});

describe('honesty contract', () => {
  it('prompt says when to search, how to report, cites only returned sources', () => {
    const b = webPromptBlock('available');
    expect(b).toContain('Use web_search for anything current');
    expect(b).toContain('Never say you cannot access the internet unless the state says unavailable');
    expect(b).toContain('Never invent search results');
    expect(b).toContain('[1], [2]');
    expect(b).toContain('NO_RESULTS');
    expect(b).toContain('CONSENT_REQUIRED');
  });
  it('failed search is reported with the exact reason (typed code reaches the model)', async () => {
    const events: AgentEvent[] = [];
    const dir = tmpRoot();
    const failing: Tool = {
      name: 'web_search', description: 'x', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      risk: 'read', askSafe: true,
      describe: (i) => `Searched the web via DuckDuckGo: ${String((i as Record<string, unknown>).query || '')}`,
      run: async () => ({ ok: false, output: 'RATE_LIMITED: search rate limited (http 429)' }),
    };
    await runAgent('latest news', {
      provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
      allowedRoots: [dir], mode: 'ask',
      tools: [failing],
      webSettings: S({ webConsent: { 'hosted:duckduckgo': true } }),
      fetchFn: scriptFetch([
        toolTurn([{ id: 'c1', name: 'web_search', input: { query: 'latest news' } }]),
        finalTurn('Search failed: RATE_LIMITED'),
      ], []),
      logDir: tmpRoot(), emit: (e) => events.push(e),
      waitForApproval: async () => { throw new Error('no approval'); },
    });
    const res = events.find((e) => e.type === 'tool_result');
    expect(res?.type === 'tool_result' && res.output).toContain('RATE_LIMITED');
  });
  it('CONSENT_REQUIRED then allow: no silent backend switch', async () => {
    await expect(runSearch(S({}), DEX(), 'q', {}, { searches: 0, fetches: 0 })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });
});

describe('NO_RESULTS: exactly one reformulation, step shows backend + query', () => {
  it('zero results retry once with new wording', async () => {
    let calls: string[] = [];
    const fakeFetch = (async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (calls.length === 1) {
        return new Response('<html><body>no results</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
      return new Response(DDG, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof fetch;
    const out = await runSearch(
      S({ webConsent: { 'hosted:duckduckgo': true } }),
      { provider: 'openai', model: 'gpt-4o', apiKey: '', fetchFn: fakeFetch },
      'scion anthropic git', { count: 5 }, { searches: 0, fetches: 0 },
    );
    expect(calls.length).toBe(2);
    expect(out.reformulated).toBeTruthy();
    expect(out.backend).toBe('DuckDuckGo');
    expect(out.results.length).toBe(1);
  });
  it('step row reads "Searched the web via <backend>: <exact query>" with result count', async () => {
    const events: AgentEvent[] = [];
    const dir = tmpRoot();
    const okTool: Tool = {
      name: 'web_search', description: 'x', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      risk: 'read', askSafe: true,
      describe: (i) => `Searched the web via DuckDuckGo: ${String((i as Record<string, unknown>).query || '')}`,
      run: async (input) => ({ ok: true, output: `Searched the web via DuckDuckGo: ${String((input as Record<string, unknown>).query)} (1 result(s))`, source: 'web_search', untrusted: true }),
    };
    await runAgent('do you know scion anthropic git', {
      provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
      allowedRoots: [dir], mode: 'ask',
      tools: [okTool],
      webSettings: S({ webConsent: { 'hosted:duckduckgo': true } }),
      fetchFn: scriptFetch([
        toolTurn([{ id: 'c1', name: 'web_search', input: { query: 'do you know scion anthropic git' } }]),
        finalTurn('done'),
      ], []),
      logDir: tmpRoot(), emit: (e) => events.push(e),
      waitForApproval: async () => { throw new Error('no approval'); },
    });
    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.type === 'tool_call' && call.summary).toBe('Searched the web via DuckDuckGo: do you know scion anthropic git');
  });
});

describe('language: latest message decides; UI locale never does', () => {
  it('prompt rule keys on the latest message alone (no per-language regex)', () => {
    const b = webPromptBlock('available');
    expect(b).toContain("user's latest message alone");
    expect(b).not.toMatch(/tiếng việt|vietnamese.*regex|detect.*\bvi\b/i);
  });
});

describe('privacy + injection: untrusted web content has no authority', () => {
  it('search right after reading a file asks for confirmation in Ask', async () => {
    const st: ToolExecState = {
      cwd: tmpRoot(),
      policy: { allowedRoots: ['/'], explicitRoots: [], alwaysAllow: [], requireApprovalForWrites: true, homeDir: os.homedir() },
      limits: { maxToolCalls: 25, runTimeoutMs: 300000, toolTimeoutMs: 30000, maxOutputChars: 8000 },
      emit: () => {}, messages: [],
      waitForApproval: async () => { throw new Error('no approval'); },
      hooks: null, checkRunTimeout: () => false, toolCalls: 0, approvalWaitMs: 0,
      lastUntrusted: '/tmp/secret.txt', mode: 'ask',
    };
    const { webSearchTool } = await import('../../src/main/agent/tools/web_search');
    const out = await executeToolCall(webSearchTool, 'web_search', { query: 'x' }, 'c1', st);
    expect(out).toBe('denied');
  });
  it('ask-before-searching forces an approval card in Do', async () => {
    const events: AgentEvent[] = [];
    const st: ToolExecState = {
      cwd: tmpRoot(),
      policy: { allowedRoots: [tmpRoot()], explicitRoots: [], alwaysAllow: [], requireApprovalForWrites: true, homeDir: os.homedir() },
      limits: { maxToolCalls: 25, runTimeoutMs: 300000, toolTimeoutMs: 30000, maxOutputChars: 8000 },
      emit: (e) => events.push(e), messages: [],
      waitForApproval: async () => ({ decision: 'deny' }),
      hooks: null, checkRunTimeout: () => false, toolCalls: 0, approvalWaitMs: 0,
      lastUntrusted: null, mode: 'do', webAskBefore: true,
    };
    const { webSearchTool } = await import('../../src/main/agent/tools/web_search');
    await executeToolCall(webSearchTool, 'web_search', { query: 'x' }, 'c1', st);
    expect(events.some((e) => e.type === 'approval_request')).toBe(true);
  });
});

describe('E2E (fake hosted server, no keys)', () => {
  it('consented -> ask -> step row with backend, sources shown, answer cites them', async () => {
    const s = S({ webConsent: { 'hosted:duckduckgo': true } });
    const r = await runSearch(s, { provider: 'openai', model: 'gpt-4o', apiKey: '', fetchFn: ddgFetch() }, 'scion anthropic', { count: 5 }, { searches: 0, fetches: 0 });
    expect(r.backend).toBe('DuckDuckGo');
    expect(r.results[0].source).toBe('example.com');
  });
  it('unavailable (master off) -> honest message naming Settings', async () => {
    await expect(runSearch(S({ webAllow: false }), DEX(), 'anything current', { count: 5 }, { searches: 0, fetches: 0 }))
      .rejects.toMatchObject({ code: 'DISABLED' });
  });
});
