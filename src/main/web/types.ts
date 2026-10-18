export type WebProviderId = 'off' | 'brave' | 'searxng';

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
  country?: string;
  language?: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /** Extra hosts allowed to bypass SSRF protection. */
  allowlist?: string[];
}

export interface SearchProvider {
  id: Exclude<WebProviderId, 'off'>;
  label: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}

export type WebErrorCode =
  | 'NOT_CONFIGURED'
  | 'KEY_UNREADABLE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PROVIDER_ERROR'
  | 'NO_RESULTS'
  | 'BLOCKED_URL'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'DISABLED';

export class WebError extends Error {
  code: WebErrorCode;
  status?: number;
  action?: 'open-settings' | 'retry' | null;
  constructor(code: WebErrorCode, message: string, opts?: { status?: number; action?: 'open-settings' | 'retry' | null }) {
    super(`${code}: ${message}`);
    this.name = 'WebError';
    this.code = code;
    this.status = opts?.status;
    this.action = opts?.action ?? null;
  }
}

export type WebAvailability =
  | { state: 'available'; provider: string }
  | { state: 'not_configured' }
  | { state: 'disabled_in_mode' }
  | { state: 'error'; code: WebErrorCode };

export function availabilityState(a: WebAvailability): string {
  if (a.state === 'available') return 'available';
  if (a.state === 'not_configured') return 'not_configured';
  if (a.state === 'disabled_in_mode') return 'disabled_in_mode';
  return `error:${a.code}`;
}

export const MAX_SEARCHES_PER_RUN = 8;
export const MAX_FETCHES_PER_RUN = 6;
export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_MAX_TEXT = 100 * 1024;
export const FETCH_REDIRECT_LIMIT = 5;
export const WEB_USER_AGENT = 'Nexio/1.0 (+https://nexio.local; desktop-app)';
