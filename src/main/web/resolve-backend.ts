import type { SearchOptions, SearchProvider, SearchResult } from './types';
import { createNativeProvider, ANTHROPIC_PRIVACY_URL, GOOGLE_PRIVACY_URL } from './native';
import { duckduckgoProvider, DUCK_PRIVACY_URL } from './duckduckgo';
import type { Settings } from '../../shared/types';

export type BackendKey = 'native:anthropic' | 'native:gemini' | 'hosted:duckduckgo';

export interface ResolvedBackend {
  key: BackendKey;
  /** Human name shown in the step row + consent notice. */
  name: string;
  privacyUrl: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}

export interface ResolveInput {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

const sessionCache = new Map<string, ResolvedBackend>();
const pinnedHosted = new Set<string>();

function cacheKey(input: ResolveInput): string {
  return `${input.provider}\n${input.model}`;
}

function hostedBackend(fetchFn?: typeof fetch): ResolvedBackend {
  const inner: SearchProvider = duckduckgoProvider(fetchFn);
  return {
    key: 'hosted:duckduckgo',
    name: 'DuckDuckGo',
    privacyUrl: DUCK_PRIVACY_URL,
    search: (q, o) => inner.search(q, o),
  };
}

function nativeBackend(input: ResolveInput): ResolvedBackend | null {
  const inner = createNativeProvider(input.provider, input.apiKey, input.model, input.baseUrl, input.fetchFn);
  if (!inner) return null;
  const isAnthropic = input.provider === 'anthropic';
  return {
    key: isAnthropic ? 'native:anthropic' : 'native:gemini',
    name: inner.label,
    privacyUrl: isAnthropic ? ANTHROPIC_PRIVACY_URL : GOOGLE_PRIVACY_URL,
    search: (q, o) => inner.search(q, o),
  };
}

/**
 * Single resolver: model-native first, keyless hosted second, unavailable
 * never (hosted needs no config). Result cached per provider+model for the
 * session; hard native failures pin the session to hosted.
 */
export function resolveWebBackend(input: ResolveInput): ResolvedBackend {
  const k = cacheKey(input);
  const hit = sessionCache.get(k);
  if (hit) return hit;
  let out: ResolvedBackend;
  if (!pinnedHosted.has(k)) {
    const native = nativeBackend(input);
    if (native) {
      sessionCache.set(k, native);
      return native;
    }
  }
  out = hostedBackend(input.fetchFn);
  sessionCache.set(k, out);
  return out;
}

/** Drop the cached resolution so the next query re-evaluates. */
export function invalidateBackend(input: ResolveInput, pinHosted = false): void {
  const k = cacheKey(input);
  sessionCache.delete(k);
  if (pinHosted) pinnedHosted.add(k);
}

export function consented(s: Settings, key: BackendKey): boolean {
  return s.webConsent?.[key] === true;
}

/** Test seam. */
export function __clearBackendCacheForTests(): void {
  sessionCache.clear();
  pinnedHosted.clear();
}
