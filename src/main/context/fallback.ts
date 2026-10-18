import type { ActiveWindow } from './types';
import { platform } from '../platform/index';

// Optional copy fallback (Settings > Context, default OFF): save the full
// clipboard (all formats), send Ctrl/Cmd+C to the previously active window,
// read, then RESTORE the clipboard exactly. Aborts (and restores nothing,
// having sent nothing) if the clipboard changed mid-operation. Never runs
// without the setting or for deny-listed apps. Only the run is logged.

interface SavedClip {
  text: string;
  html: string;
  rtf: string;
  imageBytes: Buffer | null;
  buffers: Array<{ format: string; data: Buffer }>;
}

function cb(): {
  availableFormats(): string[];
  readText(): string;
  writeText(t: string): void;
  readHTML(): string;
  writeHTML(h: string): void;
  readRTF(): string;
  writeRTF(r: string): void;
  readImage(): { isEmpty(): boolean; toPNG(): Buffer };
  writeImage(img: { toPNG(): Buffer }): void;
  readBuffer(f: string): Buffer;
  writeBuffer(f: string, b: Buffer): void;
  clear(): void;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clipboard, nativeImage } = require('electron') as typeof import('electron');
    void nativeImage;
    return clipboard;
  } catch {
    return null;
  }
}

function fingerprint(c: {
  readText(): string; readHTML(): string; readRTF(): string;
  readImage(): { isEmpty(): boolean; toPNG(): Buffer }; availableFormats(): string[];
}): string {
  try {
    const t = c.readText() || '';
    const h = c.readHTML() || '';
    const img = c.readImage();
    return `${(c.availableFormats() || []).join(',')}|${t.length}:${t.slice(0, 64)}|${h.length}|${img && !img.isEmpty() ? img.toPNG().length : 0}`;
  } catch {
    return 'unreadable';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function copyFallback(win: ActiveWindow, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; skip: 'aborted' | 'failed' }> {
  const c = cb();
  if (!c) return { ok: false, skip: 'failed' };
  const key = platform().key;
  let saved: SavedClip;
  try {
    const formats = c.availableFormats() || [];
    const buffers: SavedClip['buffers'] = [];
    for (const f of formats.slice(0, 20)) {
      if (!f.includes('/')) continue;
      try {
        buffers.push({ format: f, data: Buffer.from(c.readBuffer(f)) });
      } catch { /* format not buffer-readable */ }
    }
    let imageBytes: Buffer | null = null;
    try {
      const img = c.readImage();
      if (img && !img.isEmpty()) imageBytes = img.toPNG();
    } catch { /* no image */ }
    saved = { text: c.readText() || '', html: c.readHTML() || '', rtf: c.readRTF() || '', imageBytes, buffers };
  } catch {
    return { ok: false, skip: 'failed' };
  }
  try {
    // Clear first so anything read afterwards is the fresh copy (or
    // nothing). The saved clipboard is restored in `finally` either way.
    try { c.clear(); } catch { /* best-effort */ }
    // Focus the previous app, send copy, read back.
    if (key === 'win32') {
      await platform().runShell(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")`,
        { cwd: process.cwd(), signal, timeoutMs: 3000 },
      );
    } else {
      await new Promise<void>((resolve, reject) => {
        const { execFile } = require('node:child_process') as typeof import('node:child_process');
        const child = execFile('osascript', ['-e', `tell application "System Events" to tell (first process whose unix id is ${Math.floor(win.pid)}) to keystroke "c" using command down`], { timeout: 3000 }, (err) => (err ? reject(err) : resolve()));
        signal.addEventListener('abort', () => { try { child.kill(); } catch { /* noop */ } }, { once: true });
      });
    }
    await sleep(250);
    if (signal.aborted) return { ok: false, skip: 'aborted' };
    const text = c.readText() || '';
    if (!text.trim()) return { ok: false, skip: 'failed' };
    return { ok: true, text };
  } catch {
    return { ok: false, skip: 'failed' };
  } finally {
    // Restore exactly what was there.
    try {
      c.clear();
      if (saved.text) c.writeText(saved.text);
      if (saved.html) c.writeHTML(saved.html);
      if (saved.rtf) c.writeRTF(saved.rtf);
      for (const b of saved.buffers) {
        try { c.writeBuffer(b.format, b.data); } catch { /* best-effort */ }
      }
      if (saved.imageBytes) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { nativeImage } = require('electron') as typeof import('electron');
          c.writeImage(nativeImage.createFromBuffer(saved.imageBytes));
        } catch { /* best-effort */ }
      }
      if (!saved.text && !saved.html && !saved.rtf && !saved.buffers.length && !saved.imageBytes) c.clear();
    } catch { /* restore best-effort */ }
  }
}
