// 5-minute cache for identical search queries / fetch URLs only.
// NEVER applies to conversation turns — keyed strictly by provider+query or URL.
const TTL_MS = 5 * 60 * 1000;
interface Entry<T> { value: T; expires: number; }
const searchCache = new Map<string, Entry<unknown>>();
const fetchCache = new Map<string, Entry<unknown>>();

export function searchKey(provider: string, query: string, count: number): string {
  return `${provider}\n${query.trim().toLowerCase()}\n${count}`;
}
export function getCachedSearch<T>(key: string): T | undefined {
  const e = searchCache.get(key);
  if (!e || e.expires < Date.now()) { searchCache.delete(key); return undefined; }
  return e.value as T;
}
export function setCachedSearch(key: string, value: unknown): void {
  if (searchCache.size > 200) searchCache.clear();
  searchCache.set(key, { value, expires: Date.now() + TTL_MS });
}
export function getCachedFetch<T>(url: string): T | undefined {
  const e = fetchCache.get(url.toLowerCase());
  if (!e || e.expires < Date.now()) { fetchCache.delete(url.toLowerCase()); return undefined; }
  return e.value as T;
}
export function setCachedFetch(url: string, value: unknown): void {
  if (fetchCache.size > 200) fetchCache.clear();
  fetchCache.set(url.toLowerCase(), { value, expires: Date.now() + TTL_MS });
}
export function __clearWebCacheForTests(): void {
  searchCache.clear();
  fetchCache.clear();
}
