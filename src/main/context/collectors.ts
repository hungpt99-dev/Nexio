import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Settings } from '../../shared/types';
import type { ActiveWindow, ClipboardData, ContextFileRef, ContextSnapshot, FolderData, PageData, SelectionData } from './types';
import { capText, FILES_CAP, PAGE_TEXT_CAP, SELECTION_CAP, CLIPBOARD_PREVIEW_CAP } from './store';
import { isDenyListed } from './deny';
import { scanSecretsText, looksLikeCredentialsFile } from '../../shared/attachments';
import { stripTrackingParams } from '../web/ssrf';
import { defaultAllowedRoots, isInsideRoots, normalizeAndResolve } from '../agent/permissions';
import { platform } from '../platform/index';
import { macClipboardConcealed } from '../platform/context-darwin';
import { winClipboardConcealed } from '../platform/context-win32';

export interface CollectorCtx {
  settings: Settings;
  db?: DatabaseSync;
  cwd: string;
  homeDir: string;
  signal: AbortSignal;
}

function sourcesOn(s: Settings): Record<string, boolean> {
  const c = s.contextSources || {};
  return {
    selection: c.selection !== false,
    files: c.files !== false,
    folder: c.folder !== false,
    clipboard: c.clipboard !== false,
    page: c.page !== false,
  };
}

function withBudget<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function budgeted<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<T> {
  const c = new AbortController();
  const onAbort = (): void => c.abort();
  parent.addEventListener('abort', onAbort, { once: true });
  try {
    return await withBudget(fn(c.signal), ms, parent);
  } finally {
    parent.removeEventListener('abort', onAbort);
  }
}

export function denyListed(win: ActiveWindow | null, s: Settings): boolean {
  if (!win) return false;
  return isDenyListed({ id: win.id, name: win.name, windowTitle: win.windowTitle }, s.contextDenyList || []);
}

function statish(p: string): { size?: number; mtime?: number } {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return {};
  }
}

export function toFileRef(rawPath: string, isDir: boolean, saveNames: boolean, roots: string[], homeDir: string): ContextFileRef | null {
  let abs: string;
  try {
    abs = normalizeAndResolve(rawPath, homeDir);
  } catch {
    return null;
  }
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch { /* dangling: keep abs */ }
  const displayName = path.basename(real) || real;
  const st = statish(real);
  const outsideRoots = !isInsideRoots(real, roots);
  void saveNames;
  return {
    id: `${real}`,
    displayName: displayName.normalize('NFC'),
    absolutePath: real,
    kind: isDir ? 'folder' : 'file',
    ...(st.size !== undefined ? { size: st.size } : {}),
    ...(st.mtime !== undefined ? { mtime: st.mtime } : {}),
    ...(outsideRoots ? { outsideRoots: true } : {}),
  };
}

export async function collectSelection(snap: ContextSnapshot, win: ActiveWindow | null, ctx: CollectorCtx): Promise<void> {
  const on = sourcesOn(ctx.settings);
  if (!on.selection) { snap.states.selection = 'skipped:disabled'; return; }
  if (!win || denyListed(win, ctx.settings)) { snap.states.selection = win ? 'denied' : 'skipped:unavailable'; return; }
  try {
    const r = await budgeted((sig) => platform().readSelection(win, sig), 400, ctx.signal);
    if (!r.ok) {
      snap.states.selection = r.skip === 'empty' ? 'skipped:empty' : `unavailable:${r.skip}`;
      return;
    }
    const cap = capText(r.text, SELECTION_CAP);
    const data: SelectionData = { kind: 'text', text: cap.text, truncated: cap.truncated, length: [...r.text.normalize('NFC')].length };
    snap.selection = data;
    snap.sources.push('selection');
    snap.states.selection = 'available';
    if (scanSecretsText(data.text)) {
      snap.secretFlags = { ...snap.secretFlags, selection: true };
    }
  } catch {
    snap.states.selection = 'unavailable:timeout';
  }
}

export async function collectFiles(snap: ContextSnapshot, ctx: CollectorCtx): Promise<void> {
  const on = sourcesOn(ctx.settings);
  if (!on.files && !on.folder) { snap.states.files = 'skipped:disabled'; snap.states.folder = 'skipped:disabled'; return; }
  try {
    const r = await budgeted((sig) => platform().readSelectedFiles(sig), 800, ctx.signal);
    if (!r.ok) {
      const st = r.skip === 'empty' ? 'skipped:empty' : `unavailable:${r.skip}`;
      if (on.files) snap.states.files = st;
      if (on.folder) snap.states.folder = st;
      return;
    }
    const roots = ctx.settings.agentAllowedRoots?.length ? ctx.settings.agentAllowedRoots : defaultAllowedRoots(ctx.homeDir, ctx.cwd);
    if (on.files) {
      const refs: ContextFileRef[] = [];
      for (const f of r.files.slice(0, FILES_CAP)) {
        const ref = toFileRef(f.path, f.isDir, ctx.settings.contextSaveFileNames === true, roots, ctx.homeDir);
        if (ref) {
          if (f.size !== undefined && ref.size === undefined) ref.size = f.size;
          refs.push(ref);
          if (looksLikeCredentialsFile(ref.displayName)) {
            snap.secretFlags = { ...snap.secretFlags, files: true };
          }
        }
      }
      if (refs.length) {
        snap.files = refs;
        snap.filesTotal = r.total;
        snap.sources.push('files');
        snap.states.files = 'available';
      } else {
        snap.states.files = 'skipped:empty';
      }
    }
    if (on.folder && r.folder) {
      const ref = toFileRef(r.folder, true, ctx.settings.contextSaveFileNames === true, roots, ctx.homeDir);
      if (ref) {
        const folder: FolderData = { absolutePath: ref.absolutePath, displayName: ref.displayName };
        snap.folder = folder;
        if (!snap.sources.includes('folder')) snap.sources.push('folder');
        snap.states.folder = 'available';
      } else if (on.folder && snap.states.folder.startsWith('skipped')) {
        snap.states.folder = 'skipped:empty';
      }
    } else if (on.folder) {
      snap.states.folder = 'skipped:empty';
    }
  } catch {
    if (on.files) snap.states.files = 'unavailable:timeout';
    if (on.folder) snap.states.folder = 'unavailable:timeout';
  }
}

interface ElectronClipboard {
  availableFormats(): string[];
  readText(): string;
  readHTML(): string;
  readImage(): { isEmpty(): boolean; toPNG(): Buffer };
  readBuffer(format: string): Buffer;
}

function electronClipboard(): ElectronClipboard | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clipboard } = require('electron') as typeof import('electron');
    return clipboard as unknown as ElectronClipboard;
  } catch {
    return null;
  }
}

export async function collectClipboard(snap: ContextSnapshot, ctx: CollectorCtx): Promise<void> {
  const on = sourcesOn(ctx.settings);
  if (!on.clipboard) { snap.states.clipboard = 'skipped:disabled'; return; }
  const cb = electronClipboard();
  if (!cb) { snap.states.clipboard = 'unavailable:unsupported_app'; return; }
  let formats: string[] = [];
  try {
    formats = cb.availableFormats() || [];
  } catch {
    snap.states.clipboard = 'unavailable:timeout';
    return;
  }
  const key = platform().key;
  const concealed = key === 'darwin' ? macClipboardConcealed(formats) : winClipboardConcealed(formats);
  if (concealed) {
    // Password-manager content: never read beyond the format check.
    snap.states.clipboard = 'skipped:concealed';
    return;
  }
  const lower = formats.map((f) => f.toLowerCase());
  try {
    if (lower.some((f) => f.includes('text/uri-list'))) {
      let uris: string[] = [];
      try {
        const buf = cb.readBuffer('text/uri-list');
        uris = buf.toString('utf8').split(/\r?\n/).map((u) => u.trim()).filter((u) => u.startsWith('file://'));
      } catch { /* fall through to text */ }
      if (uris.length) {
        const roots = ctx.settings.agentAllowedRoots?.length ? ctx.settings.agentAllowedRoots : defaultAllowedRoots(ctx.homeDir, ctx.cwd);
        const refs: ContextFileRef[] = [];
        for (const u of uris.slice(0, FILES_CAP)) {
          try {
            const p = decodeURI(new URL(u).pathname);
            const winPath = key === 'win32' && /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
            const ref = toFileRef(winPath, false, ctx.settings.contextSaveFileNames === true, roots, ctx.homeDir);
            if (ref) refs.push(ref);
          } catch { /* skip bad uri */ }
        }
        if (refs.length) {
          const data: ClipboardData = { kind: 'files', preview: refs.map((r) => r.displayName).slice(0, 3).join(', '), length: refs.length, concealed: false, files: refs };
          snap.clipboard = data;
          snap.sources.push('clipboard');
          snap.states.clipboard = 'available';
          return;
        }
      }
    }
    const img = cb.readImage();
    if (img && !img.isEmpty()) {
      const png = img.toPNG();
      if (png.length > 5 * 1024 * 1024) { snap.states.clipboard = 'skipped:too_large'; return; }
      const data: ClipboardData = { kind: 'image', preview: `Image, ${(png.length / 1024).toFixed(0)} KB`, length: png.length, concealed: false, imageBytes: png, imageMime: 'image/png' };
      snap.clipboard = data;
      snap.sources.push('clipboard');
      snap.states.clipboard = 'available';
      return;
    }
    const text = cb.readText() || '';
    if (!text) {
      const html = cb.readHTML() || '';
      if (!html) { snap.states.clipboard = 'skipped:empty'; return; }
    }
    if (!text.trim()) { snap.states.clipboard = 'skipped:empty'; return; }
    const full = text.length > 500_000 ? text.slice(0, 500_000) : text;
    const cap = capText(full.slice(0, 4000), CLIPBOARD_PREVIEW_CAP);
    const data: ClipboardData = { kind: 'text', preview: cap.text, length: [...full.normalize('NFC')].length, concealed: false, fullText: full };
    snap.clipboard = data;
    snap.sources.push('clipboard');
    snap.states.clipboard = 'available';
    if (scanSecretsText(full.slice(0, 65536))) {
      snap.secretFlags = { ...snap.secretFlags, clipboard: true };
    }
  } catch {
    snap.states.clipboard = 'unavailable:timeout';
  }
}

export async function collectPage(snap: ContextSnapshot, win: ActiveWindow | null, ctx: CollectorCtx): Promise<void> {
  const on = sourcesOn(ctx.settings);
  if (!on.page) { snap.states.page = 'skipped:disabled'; return; }
  if (!win || !win.isBrowser) { snap.states.page = 'skipped:empty'; return; }
  if (denyListed(win, ctx.settings)) { snap.states.page = 'denied'; return; }
  try {
    const r = await budgeted((sig) => platform().readBrowserPage(win, sig), 400, ctx.signal);
    if (!r.ok) {
      snap.states.page = r.skip === 'empty' ? 'skipped:empty' : r.skip === 'private_window' ? 'skipped:private_window' : `unavailable:${r.skip}`;
      return;
    }
    const clean = stripTrackingParams(r.url).split('#')[0];
    const cap = r.text ? capText(r.text, PAGE_TEXT_CAP) : null;
    const page: PageData = {
      url: clean,
      title: r.title.slice(0, 300),
      ...(cap ? { text: cap.text, truncated: cap.truncated } : {}),
      ...(r.isPrivate ? { isPrivate: true } : {}),
    };
    snap.page = page;
    snap.sources.push('page');
    snap.states.page = 'available';
    if ((r.text && scanSecretsText(r.text.slice(0, 65536))) || scanSecretsText(`${r.title} ${clean}`.slice(0, 2000))) {
      snap.secretFlags = { ...snap.secretFlags, page: true };
    }
  } catch {
    snap.states.page = 'unavailable:timeout';
  }
}

export function collectApp(snap: ContextSnapshot, win: ActiveWindow | null, denyExtra: string[]): void {
  if (!win) {
    snap.states.selection = snap.states.selection === 'skipped:disabled' ? 'skipped:disabled' : 'skipped:unavailable';
    return;
  }
  if (isDenyListed({ id: win.id, name: win.name, windowTitle: win.windowTitle }, denyExtra)) {
    snap.app = { name: 'a protected app', windowTitle: '', isBrowser: false };
    return;
  }
  snap.app = { name: win.name, windowTitle: win.windowTitle.slice(0, 300), isBrowser: win.isBrowser };
}
