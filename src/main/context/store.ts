import crypto from 'node:crypto';
import type { ContextSnapshot, ContextSourceName } from './types';

export const SNAPSHOT_TTL_MS = 60_000;
export const SELECTION_CAP = 20_000;
export const FILES_CAP = 200;
export const CLIPBOARD_PREVIEW_CAP = 200;
export const PAGE_TEXT_CAP = 20_000;

let seq = 0;
let current: ContextSnapshot | null = null;
let expiryTimer: unknown = null;
/** Per-file exclusions for the live snapshot (preview checkboxes). */
let excludedFiles = new Set<string>();

function clearTimer(): void {
  if (expiryTimer) {
    try { clearTimeout(expiryTimer as ReturnType<typeof setTimeout>); } catch { /* noop */ }
    expiryTimer = null;
  }
}

function emptyStates(): Record<ContextSourceName, string> {
  return { selection: 'skipped:disabled', files: 'skipped:disabled', folder: 'skipped:disabled', clipboard: 'skipped:disabled', page: 'skipped:disabled', screenshot: 'skipped:no_screen_context' };
}

/** Begin a capture: snapshot exists in memory only, expires after 60 s. */
export function beginSnapshot(app: { name: string; windowTitle: string; isBrowser: boolean }, external: import('./types').ActiveWindow | null): ContextSnapshot {
  clear();
  excludedFiles = new Set();
  const now = Date.now();
  seq += 1;
  current = {
    id: `ctx-${now}-${seq}`,
    capturedAt: now,
    expiresAt: now + SNAPSHOT_TTL_MS,
    app, external,
    sources: [],
    states: emptyStates(),
    attached: new Set(),
  };
  try {
    const t = setTimeout(() => { current = null; expiryTimer = null; }, SNAPSHOT_TTL_MS + 1000);
    (t as { unref?: () => void }).unref?.();
    expiryTimer = t;
  } catch { /* timer best-effort */ }
  return current;
}

export function getSnapshot(id?: string): ContextSnapshot | null {
  if (!current) return null;
  if (Date.now() > current.expiresAt) { current = null; return null; }
  if (id && current.id !== id) return null;
  return current;
}

/** Delete on hide, Incognito exit and app quit. Never persisted. */
export function clear(): void {
  clearTimer();
  current = null;
  excludedFiles = new Set();
}
export function setFileExcluded(id: string, excluded: boolean): void {
  if (excluded) excludedFiles.add(id);
  else excludedFiles.delete(id);
}
export function isFileExcluded(id: string): boolean {
  return excludedFiles.has(id);
}

/** Truncate without splitting grapheme clusters; NFC for any script. */
export function capText(text: string, cap: number): { text: string; truncated: boolean } {
  const norm = String(text || '').normalize('NFC');
  if ([...norm].length <= cap) return { text: norm, truncated: false };
  return { text: [...norm].slice(0, cap).join(''), truncated: true };
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** Test seam: reset module state. */
export function __resetContextStoreForTests(): void {
  clear();
  seq = 0;
}
