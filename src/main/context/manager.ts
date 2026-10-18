import type { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import type { Settings } from '../../shared/types';
import type { ActiveWindow, ContextSnapshot, ContextSourceName } from './types';
import { beginSnapshot, capText, getSnapshot, SELECTION_CAP } from './store';
import { collectApp, collectClipboard, collectFiles, collectPage, collectSelection, denyListed, type CollectorCtx } from './collectors';
import { copyFallback } from './fallback';

export interface ContextEmit {
  onSource(source: ContextSourceName, state: string): void;
}

function ctxOf(s: Settings, cwd: string, signal: AbortSignal, db?: DatabaseSync): CollectorCtx {
  return { settings: s, db, cwd, homeDir: os.homedir(), signal };
}

/**
 * Refresh the snapshot against the recorded external window. Collectors run
 * asynchronously with per-source budgets; a slow collector never blocks
 * typing. Resolves with the snapshot (partial results included).
 */
export async function refreshContext(
  s: Settings,
  external: ActiveWindow | null,
  opts: { cwd?: string; db?: DatabaseSync; signal?: AbortSignal; emit?: ContextEmit; copyFallbackFn?: typeof copyFallback } = {},
): Promise<ContextSnapshot | null> {
  if (s.contextEnabled === false) return null;
  const signal = opts.signal || new AbortController().signal;
  const denied = external ? denyListed(external, s) : false;
  const snap = beginSnapshot(
    { name: external ? external.name : 'no app', windowTitle: '', isBrowser: external ? external.isBrowser : false },
    external,
  );
  const ctx = ctxOf(s, opts.cwd || os.homedir(), signal, opts.db);
  collectApp(snap, denied ? null : external, s.contextDenyList || []);
  if (denied) {
    // A deny-listed app yields NO content: every content source is denied.
    for (const src of ['selection', 'files', 'folder', 'clipboard', 'page'] as ContextSourceName[]) {
      snap.states[src] = 'denied';
    }
    opts.emit?.onSource('selection', 'denied');
    return snap;
  }
  const jobs: Array<Promise<void>> = [
    (async () => {
      await collectSelection(snap, external, ctx);
      // Copy fallback: only with the setting, never for deny-listed apps
      // (already returned above), empty selection only.
      if (snap.states.selection === 'skipped:empty' && s.contextCopyFallback === true && external) {
        try {
          const fb = await (opts.copyFallbackFn || copyFallback)(external, signal);
          if (fb.ok && fb.text.trim()) {
            const cap = capText(fb.text, SELECTION_CAP);
            snap.selection = { kind: 'text', text: cap.text, truncated: cap.truncated, length: [...fb.text.normalize('NFC')].length };
            if (!snap.sources.includes('selection')) snap.sources.push('selection');
            snap.states.selection = 'available';
          }
        } catch { /* fallback best-effort; empty state stands */ }
      }
      opts.emit?.onSource('selection', snap.states.selection);
    })(),
    (async () => {
      await collectFiles(snap, ctx);
      opts.emit?.onSource('files', snap.states.files);
      opts.emit?.onSource('folder', snap.states.folder);
    })(),
    (async () => {
      await collectClipboard(snap, ctx);
      opts.emit?.onSource('clipboard', snap.states.clipboard);
    })(),
    (async () => {
      await collectPage(snap, external, ctx);
      opts.emit?.onSource('page', snap.states.page);
    })(),
  ];
  await Promise.allSettled(jobs);
  applyAutoAttach(s, snap);
  return getSnapshot(snap.id);
}

/** Default auto-attach: selection + files; clipboard/page/folder stay available. */
export function applyAutoAttach(s: Settings, snap: ContextSnapshot): void {
  if (s.contextAutoAttach === 'off' || s.contextAutoAttach === 'ask') return;
  if (snap.states.selection === 'available') snap.attached.add('selection');
  if (snap.states.files === 'available') snap.attached.add('files');
}

export function attachSource(snap: ContextSnapshot, source: ContextSourceName): boolean {
  if (snap.states[source] !== 'available') return false;
  snap.attached.add(source);
  return true;
}

export function detachSource(snap: ContextSnapshot, source: ContextSourceName): void {
  snap.attached.delete(source);
}
