export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  date?: string;
}

export interface SearchOptions {
  count?: number;
  recency?: 'day' | 'week' | 'month' | 'year';
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** Extra hosts allowed to bypass SSRF protection. */
  allowlist?: string[];
}

export interface SearchProvider {
  id: string;
  label: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}

export type WebErrorCode =
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PROVIDER_ERROR'
  | 'NO_RESULTS'
  | 'BLOCKED_URL'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'DISABLED'
  | 'CONSENT_REQUIRED'
  | 'NEEDS_CONFIRM'
  | 'UNAVAILABLE';

export class WebError extends Error {
  code: WebErrorCode;
  status?: number;
  action?: 'open-settings' | 'retry' | null;
  /** Backend key for consent routing (CONSENT_REQUIRED). */
  backend?: string;
  privacyUrl?: string;
  constructor(code: WebErrorCode, message: string, opts?: { status?: number; action?: 'open-settings' | 'retry' | null; backend?: string; privacyUrl?: string }) {
    super(`${code}: ${message}`);
    this.name = 'WebError';
    this.code = code;
    this.status = opts?.status;
    this.action = opts?.action ?? null;
    this.backend = opts?.backend;
    this.privacyUrl = opts?.privacyUrl;
  }
}

/** Structured availability, computed each run. No keys, no setup. */
export type WebAvailability =
  | { state: 'available'; backend: string; name: string }
  | { state: 'needs_consent'; backend: string; name: string }
  | { state: 'unavailable'; reason: 'disabled' };

export function availabilityState(a: WebAvailability): string {
  if (a.state === 'available') return 'available';
  if (a.state === 'needs_consent') return 'needs_consent';
  return 'unavailable:disabled';
}

export const MAX_SEARCHES_PER_RUN = 8;
export const MAX_FETCHES_PER_RUN = 6;
export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_TEXT = 100 * 1024;
export const FETCH_REDIRECT_LIMIT = 5;
export const WEB_USER_AGENT = 'Nexio/1.0 (+https://nexio.local; desktop-app)';
