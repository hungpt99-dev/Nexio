import type { SearchOptions, SearchProvider, SearchResult } from './types';
import { WebError } from './types';
import { capabilitiesFor as anthropicCaps } from '../ai/providers/anthropic/capabilities';
import { capabilitiesFor as geminiCaps } from '../ai/providers/gemini/capabilities';
import { webSearchBody as anthropicBody, webSearchEndpoint as anthropicEndpoint, webSearchHeaders as anthropicHeaders } from '../ai/providers/anthropic/websearch';
import { webSearchBody as geminiBody, webSearchEndpoint as geminiEndpoint } from '../ai/providers/gemini/websearch';

export const ANTHROPIC_PRIVACY_URL = 'https://www.anthropic.com/privacy';
export const GOOGLE_PRIVACY_URL = 'https://policies.google.com/privacy';

/** Model-native search support per provider+model. Safe default: false. */
export function supportsNativeSearch(provider: string, model: string): boolean {
  if (provider === 'anthropic') return anthropicCaps(model).supportsNativeSearch === true;
  if (provider === 'gemini') return geminiCaps(model).supportsNativeSearch === true;
  // OpenAI: native web_search lives in the Responses API only
  // (https://platform.openai.com/docs/guides/tools-web-search, verified
  // 2026-10-18); Chat Completions offers only the specialized
  // gpt-5-search-api path, which Nexio does not use. Compatible servers:
  // no standard native search. Both stay false.
  return false;
}

function errorMessage(e: unknown): string {
  if (e instanceof WebError) throw e;
  return (e as Error).message || 'unknown error';
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<{ status: number; json: unknown; text: string }> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new WebError('TIMEOUT', 'search timed out');
    throw new WebError('NETWORK', `search request failed: ${(e as Error).message}`);
  }
  const text = await res.text().catch(() => '');
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
  return { status: res.status, json, text };
}

interface AnthropicResultBlock { type?: string; url?: string; title?: string; page_age?: string; content?: unknown; tool_use_id?: string; error_code?: string }
interface AnthropicCitation { type?: string; url?: string; title?: string; cited_text?: string }

function snippetFor(citations: AnthropicCitation[], url: string): string {
  const hit = citations.find((c) => c.url === url && c.cited_text);
  return hit?.cited_text ? String(hit.cited_text).slice(0, 400) : '';
}

/** Anthropic Messages API server-side web_search (web_search_20250305,
 * allowed_callers direct). Verified 2026-10-18:
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool */
export function anthropicNativeProvider(apiKey: string, model: string, baseUrl?: string, fetchFn: typeof fetch = fetch): SearchProvider {
  return {
    id: 'native-anthropic',
    label: 'Anthropic web search',
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const q = query.trim();
      if (!q) throw new WebError('PROVIDER_ERROR', 'empty query');
      const base = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
      let r: { status: number; json: unknown; text: string };
      try {
        r = await postJson(anthropicEndpoint(base), anthropicHeaders(apiKey), anthropicBody(model, q), opts.signal, fetchFn);
      } catch (e) {
        throw new WebError('PROVIDER_ERROR', errorMessage(e));
      }
      if (r.status === 401 || r.status === 403) throw new WebError('PROVIDER_ERROR', `native search rejected (http ${r.status}): check the provider key`, { status: r.status });
      if (r.status === 429) throw new WebError('RATE_LIMITED', 'native search rate limited (http 429): try again shortly', { status: 429, action: 'retry' });
      if (r.status === 400 && /web search is not enabled/i.test(r.text)) {
        throw new WebError('PROVIDER_ERROR', 'native search is disabled for this organization (Anthropic Console)', { status: 400 });
      }
      if (r.status < 200 || r.status >= 300) throw new WebError('PROVIDER_ERROR', `native search failed (http ${r.status})`, { status: r.status });
      const content = (r.json as { content?: Array<{ type?: string; tool_use_id?: string; content?: AnthropicResultBlock | AnthropicResultBlock[]; citations?: AnthropicCitation[] }> } | undefined)?.content || [];
      const results: AnthropicResultBlock[] = [];
      const citations: AnthropicCitation[] = [];
      for (const b of content) {
        if (b.type === 'web_search_tool_result') {
          const items = Array.isArray(b.content) ? b.content : b.content ? [b.content] : [];
          for (const item of items) {
            if (item?.type === 'web_search_tool_result_error') {
              const code = String(item.error_code || '');
              if (code === 'too_many_requests') throw new WebError('RATE_LIMITED', 'native search rate limited: try again shortly', { action: 'retry' });
              throw new WebError('PROVIDER_ERROR', `native search error: ${code || 'unknown'}`);
            }
            if (item?.type === 'web_search_result' && item.url) results.push(item);
          }
        }
        if (Array.isArray(b.citations)) citations.push(...b.citations);
      }
      if (!results.length) throw new WebError('NO_RESULTS', 'no results found');
      const count = Math.min(Math.max(opts.count || 5, 1), 20);
      return results.slice(0, count).map((x) => {
        const url = String(x.url || '');
        let source = '';
        try { source = new URL(url).hostname; } catch { /* keep empty */ }
        return {
          title: String(x.title || url || 'Untitled'),
          url,
          snippet: snippetFor(citations, url),
          source,
          ...(x.page_age ? { date: String(x.page_age) } : {}),
        };
      });
    },
  };
}

interface GeminiChunk { web?: { uri?: string; title?: string } }
interface GeminiSupport { segment?: { text?: string }; groundingChunkIndices?: number[] }

/** Gemini generateContent REST with the google_search tool. Verified
 * 2026-10-18: https://ai.google.dev/gemini-api/docs/grounding
 * (classic generateContent shape; UNVERIFIED beyond this adapter's tests —
 * any shape drift falls through to hosted search honestly). */
export function geminiNativeProvider(apiKey: string, model: string, baseUrl?: string, fetchFn: typeof fetch = fetch): SearchProvider {
  return {
    id: 'native-gemini',
    label: 'Google Search grounding',
    async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
      const q = query.trim();
      if (!q) throw new WebError('PROVIDER_ERROR', 'empty query');
      // Only the official endpoint carries the grounding tool; custom bases fall through.
      if (baseUrl && !/generativelanguage\.googleapis\.com/i.test(baseUrl)) {
        throw new WebError('PROVIDER_ERROR', 'native search needs the official Gemini endpoint');
      }
      let r: { status: number; json: unknown; text: string };
      try {
        r = await postJson(geminiEndpoint(model), {
          'x-goog-api-key': apiKey,
        }, geminiBody(q), opts.signal, fetchFn);
      } catch (e) {
        throw new WebError('PROVIDER_ERROR', errorMessage(e));
      }
      if (r.status === 400 && /API key|API_KEY_INVALID/i.test(r.text)) throw new WebError('PROVIDER_ERROR', 'native search rejected (http 400): check the provider key', { status: 400 });
      if (r.status === 429) throw new WebError('RATE_LIMITED', 'native search rate limited (http 429): try again shortly', { status: 429, action: 'retry' });
      if (r.status < 200 || r.status >= 300) throw new WebError('PROVIDER_ERROR', `native search failed (http ${r.status})`, { status: r.status });
      const cand = (r.json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; groundingMetadata?: { groundingChunks?: GeminiChunk[]; groundingSupports?: GeminiSupport[] } }> } | undefined)?.candidates?.[0];
      const chunks = cand?.groundingMetadata?.groundingChunks || [];
      const supports = cand?.groundingMetadata?.groundingSupports || [];
      const results: SearchResult[] = [];
      chunks.forEach((c, i) => {
        const url = c.web?.uri || '';
        if (!/^https?:\/\//i.test(url)) return;
        let source = '';
        try { source = new URL(url).hostname; } catch { /* keep empty */ }
        const seg = supports.find((gs) => (gs.groundingChunkIndices || []).includes(i))?.segment?.text || '';
        results.push({ title: String(c.web?.title || url), url, snippet: seg.slice(0, 400), source });
      });
      if (!results.length) throw new WebError('NO_RESULTS', 'no results found');
      const count = Math.min(Math.max(opts.count || 5, 1), 20);
      return results.slice(0, count);
    },
  };
}

/** Build the native provider for a model, or null when unsupported. */
export function createNativeProvider(provider: string, apiKey: string, model: string, baseUrl?: string, fetchFn: typeof fetch = fetch): SearchProvider | null {
  if (!apiKey || !supportsNativeSearch(provider, model)) return null;
  if (provider === 'anthropic') return anthropicNativeProvider(apiKey, model, baseUrl, fetchFn);
  if (provider === 'gemini') return geminiNativeProvider(apiKey, model, baseUrl, fetchFn);
  return null;
}
