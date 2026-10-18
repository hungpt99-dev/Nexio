import type { SearchProvider } from '../types';
import { braveProvider } from './brave';
import { searxngProvider } from './searxng';

export const WEB_PROVIDER_IDS = ['brave', 'searxng'] as const;
export type HostedWebProviderId = (typeof WEB_PROVIDER_IDS)[number];

export function isWebProviderId(v: unknown): v is HostedWebProviderId {
  return v === 'brave' || v === 'searxng';
}

/** Adding a provider = one folder + registry line. */
export function createSearchProvider(
  id: HostedWebProviderId,
  credential: string,
  fetchFn: typeof fetch = fetch,
): SearchProvider {
  if (id === 'brave') return braveProvider(credential, fetchFn);
  return searxngProvider(credential, fetchFn);
}
