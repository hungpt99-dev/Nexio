// Model-native grounding request shape (google_search tool, generateContent
// REST). Verified 2026-10-18: https://ai.google.dev/gemini-api/docs/grounding
export function webSearchEndpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

export function webSearchBody(query: string): Record<string, unknown> {
  return {
    contents: [{ parts: [{ text: `Search the web for: ${query}` }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 1024, temperature: 0 },
  };
}
