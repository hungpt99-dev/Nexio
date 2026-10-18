import type { AppInfo } from './types';
import { spawn } from 'node:child_process';

/** Fallback open when Electron shell is unavailable (dev/tests): cmd/open. */
export function openFallback(target: string, key: 'win32' | 'darwin'): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = key === 'win32' ? 'cmd' : 'open';
    const args = key === 'win32' ? ['/c', 'start', '""', target] : [target];
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.unref();
  });
}

/** Split an accelerator on '+' and map known modifier tokens. */
export function keyTokensFor(accel: string, map: Record<string, string>): string[] {
  return accel
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const hit = Object.entries(map).find(([k]) => k.toLowerCase() === p.toLowerCase());
      return hit ? hit[1] : p;
    });
}

/** Join tokens: concatenated glyphs on mac, '+' on Windows. */
export function keyLabelFor(accel: string, map: Record<string, string>, sep: string): string {
  return keyTokensFor(accel, map).join(sep);
}

/** Parse tasklist CSV / ps comm output into a deduped, capped app-name list. */
export function parseAppList(raw: string): AppInfo[] {
  const names = [...new Set(
    raw.split('\n').map((l) => l.trim().replace(/^"|"$/g, '').split(',')[0].trim()).filter(Boolean),
  )].slice(0, 300);
  return names.map((name) => ({ name }));
}

/** Parse `KEY=VALUE` lines (handles quotes like a login shell would print them). */
export function parseLoginEnv(text: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.slice(1, -1);
      }
    }
    out[m[1]] = v;
  }
  return out;
}

/** Run a helper process, parse stdout as JSON. Timeout + abort kill it. Never throws secrets. */
export function collectJson(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
  opts?: { windowsHide?: boolean },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { timeout: timeoutMs, windowsHide: opts?.windowsHide !== false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const done = (e: Error | null) => {
      if (signal.aborted) return reject(new Error('Aborted'));
      if (e) return reject(new Error(`helper failed: ${String(err || e.message || e).slice(0, 200)}`));
      try {
        resolve(JSON.parse(String(out || 'null')));
      } catch {
        reject(new Error(`helper returned non-JSON: ${String(out).slice(0, 200)}`));
      }
    };
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); if (out.length > 2_000_000) { try { child.kill(); } catch { /* noop */ } } });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8').slice(0, 500); });
    child.on('error', (e) => done(e));
    child.on('close', (code) => {
      if (code !== 0 && !out.trim()) return done(new Error(`exit ${code}`));
      done(null);
    });
    signal.addEventListener('abort', () => { try { child.kill(); } catch { /* noop */ } }, { once: true });
  });
}
