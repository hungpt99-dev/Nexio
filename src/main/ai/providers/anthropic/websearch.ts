// Model-native web search request shape (server tool). Verified 2026-10-18:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
export const WEB_SEARCH_TOOL = 'web_search_20250305';
export const ANTHROPIC_VERSION = '2023-06-01';

export function webSearchEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
}

export function webSearchHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
}

export function webSearchBody(model: string, query: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: `Search the web for: ${query}` }],
    tools: [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 5, allowed_callers: ['direct'] }],
  };
}
