import type { ActiveWindow, BrowserPageRead, SelectedFilesRead, SelectionRead } from './types';

const BROWSER_IDS = ['com.google.chrome', 'com.microsoft.edgemac', 'org.mozilla.firefox', 'com.brave.browser', 'com.operasoftware.opera', 'company.thebrowser.arc', 'org.chromium.chromium', 'com.apple.safaritechnology-preview'];
const SAFARI_IDS = ['com.apple.safari', 'com.apple.safaritechnology-preview'];

function runOsaText(signal: AbortSignal, script: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    const child = execFile('osascript', ['-s', 's', '-e', script], { timeout: timeoutMs }, (err, stdout) => {
      if (signal.aborted) return reject(new Error('Aborted'));
      if (err && !String(stdout || '').trim()) return reject(err);
      resolve(String(stdout || ''));
    });
    signal.addEventListener('abort', () => { try { child.kill(); } catch { /* noop */ } }, { once: true });
  });
}

/** Parse `{a:1, b:"x, y"}` AppleScript record output (quoted strings hold commas). */
export function parseOsaRecord(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const t = String(raw || '').trim();
  // why: `-s s` prints {k:"v"} records; without it AppleScript prints bare k:v pairs.
  const body = t.startsWith('{') && t.endsWith('}') ? t.slice(1, -1) : t;
  let i = 0;
  const n = body.length;
  const skip = (): void => { while (i < n && /[\s,]/.test(body[i])) i++; };
  while (i < n) {
    skip();
    if (i >= n) break;
    let key = '';
    while (i < n && body[i] !== ':') { key += body[i]; i++; }
    key = key.trim();
    if (i >= n || !key) break; // no colon: not a record
    i++; // :
    skip();
    let val = '';
    if (body[i] === '"') {
      i++;
      while (i < n) {
        if (body[i] === '\\' && i + 1 < n) { val += body[i + 1]; i += 2; continue; }
        if (body[i] === '"') { i++; break; }
        val += body[i]; i++;
      }
    } else {
      while (i < n && body[i] !== ',') { val += body[i]; i++; }
      val = val.trim();
    }
    if (key) out[key] = val;
  }
  return out;
}

export async function macActiveWindow(signal: AbortSignal, selfPid: number): Promise<ActiveWindow | null> {
  const script = [
    'tell application "System Events"',
    'set p to first process whose frontmost is true',
    'set nm to name of p',
    'try',
    'set bid to bundle identifier of p',
    'on error',
    'set bid to ""',
    'end try',
    'try',
    'set pid to unix id of p',
    'on error',
    'set pid to 0',
    'end try',
    'try',
    'set wt to name of first window of p',
    'on error',
    'set wt to ""',
    'end try',
    'return {nm:nm, bid:bid, pid:pid, wt:wt}',
    'end tell',
  ].join('\n');
  let j: { nm?: string; bid?: string; pid?: number; wt?: string };
  try {
    const raw = await runOsaText(signal, script, 3000);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as typeof j;
      j = parsed && typeof parsed === 'object' ? parsed : { nm: '', bid: '', pid: 0, wt: '' };
    } catch {
      const m = parseOsaRecord(raw);
      j = { nm: m.nm, bid: m.bid, pid: Number(m.pid) || 0, wt: m.wt };
    }
  } catch {
    return null;
  }
  const pid = Number(j?.pid) || 0;
  if (!pid || pid === selfPid) return null;
  const bid = String(j?.bid || '');
  const name = String(j?.nm || bid);
  if (!name || /nexio/i.test(`${bid} ${name}`)) return null;
  const isBrowser = BROWSER_IDS.includes(bid) || SAFARI_IDS.includes(bid) || /chrome|firefox|safari|edge|brave|opera|arc/i.test(`${bid} ${name}`);
  return { pid, id: bid || name, name, windowTitle: String(j?.wt || ''), isBrowser };
}

export async function macReadSelection(pid: number, signal: AbortSignal): Promise<SelectionRead> {
  // Scoped to the recorded pid: no focus needed. Needs Accessibility
  // permission; denial surfaces as no_permission (never prompts here).
  const script = [
    `tell application "System Events" to tell (first process whose unix id is ${Math.floor(pid)})`,
    'try',
    'set fe to value of attribute "AXFocusedUIElement"',
    'on error',
    'return "NONE"',
    'end try',
    'try',
    'if role of fe is "AXSecureTextField" then return "SECURE"',
    'on error',
    'end try',
    'try',
    'set t to value of attribute "AXSelectedText" of fe',
    'if t is missing value then return "NONE"',
    'return "TEXT:" & t',
    'on error',
    'return "NONE"',
    'end try',
    'end tell',
  ].join('\n');
  let raw: string;
  try {
    raw = (await runOsaText(signal, script, 4000)).trim();
  } catch {
    return { ok: false, skip: 'unsupported_app' };
  }
  const s = String(raw ?? '');
  if (s === 'SECURE') return { ok: false, skip: 'password_field' };
  if (s.startsWith('TEXT:')) {
    const t = s.slice(5);
    if (!t.trim()) return { ok: false, skip: 'empty' };
    return { ok: true, text: t };
  }
  return { ok: false, skip: 'unsupported_app' };
}

export async function macReadSelectedFiles(signal: AbortSignal): Promise<SelectedFilesRead> {
  // Needs Automation permission for Finder: ask only from the first-use flow.
  const script = [
    'try',
    'tell application "Finder"',
    'set sel to selection as alias list',
    'set outs to {}',
    'repeat with a in sel',
    'set end of outs to POSIX path of a',
    'end repeat',
    'try',
    'set f to POSIX path of (target of front window as alias)',
    'on error',
    'set f to ""',
    'end try',
    'return {files:outs, folder:f}',
    'end tell',
    'on error errMsg number errNum',
    'if errNum is equal to -1743 then return "NOAUTH"',
    'return "NONE"',
    'end try',
  ].join('\n');
  let raw: string;
  try {
    raw = (await runOsaText(signal, script, 8000)).trim();
  } catch {
    return { ok: false, skip: 'timeout' };
  }
  if (raw === 'NOAUTH') return { ok: false, skip: 'no_permission' };
  if (!raw || raw === 'NONE') return { ok: false, skip: 'empty' };
  const rec = parseOsaRecord(raw);
  const files = parseOsaList(rec.files || '').map((fp) => ({ path: fp, isDir: false }));
  if (!files.length) return { ok: false, skip: 'empty' };
  const out: SelectedFilesRead = { ok: true, files, total: files.length };
  if (rec.folder) out.folder = rec.folder;
  return out;
}

const CHROME_LIKE: Record<string, string> = {
  'com.google.chrome': 'Google Chrome',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'com.brave.browser': 'Brave Browser',
  'com.operasoftware.opera': 'Opera',
  'company.thebrowser.arc': 'Arc',
  'org.chromium.chromium': 'Chromium',
};

export async function macReadBrowserPage(win: ActiveWindow, signal: AbortSignal): Promise<BrowserPageRead> {
  // Per-browser AppleScript (needs Automation for that browser). Firefox
  // exposes no scriptable URL — unsupported_app.
  const appName = CHROME_LIKE[win.id];
  let script: string;
  if (appName) {
    script = [
      `tell application "${appName}"`,
      'try',
      'set u to URL of active tab of front window',
      'set t to title of active tab of front window',
      'return {u:u, t:t}',
      'on error',
      'return "NONE"',
      'end try',
      'end tell',
    ].join('\n');
  } else if (SAFARI_IDS.includes(win.id)) {
    script = [
      'tell application "Safari"',
      'try',
      'set u to URL of front document',
      'set t to name of front document',
      'return {u:u, t:t}',
      'on error',
      'return "NONE"',
      'end try',
      'end tell',
    ].join('\n');
  } else {
    return { ok: false, skip: 'unsupported_app' };
  }
  let raw: string;
  try {
    raw = (await runOsaText(signal, script, 4000)).trim();
  } catch {
    return { ok: false, skip: 'timeout' };
  }
  if (!raw || raw === 'NONE' || raw === 'NOAUTH') return { ok: false, skip: raw === 'NOAUTH' ? 'no_permission' : 'empty' };
  const j = parseOsaRecord(raw);
  if (!j.u) return { ok: false, skip: 'empty' };
  const url = String(j.u);
  const title = String(j.t || '');
  if (/^https?:\/\/(.*\.)?(chrome|edge|firefox|brave|opera):.*newtab|about:(blank|newtab|privatebrowsing)/i.test(url)) {
    return { ok: false, skip: 'empty' };
  }
  return { ok: true, url, title };
}

/** macOS concealed/transient pasteboard types (1Password, Bitwarden, …). */
export function macClipboardConcealed(formats: string[]): boolean {
  const lower = formats.map((f) => f.toLowerCase());
  return lower.some((f) => f.includes('concealed') || f.includes('transient') || f.includes('autogenerated'));
}

/** Parse AppleScript `{"a", "b"}` list output into strings. */
export function parseOsaList(raw: string): string[] {
  const out: string[] = [];
  const t = String(raw || '').trim();
  const body = t.startsWith('{') && t.endsWith('}') ? t.slice(1, -1) : t;
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(body[i])) i++;
    if (i >= n) break;
    if (body[i] === '"') {
      i++;
      let v = '';
      while (i < n) {
        if (body[i] === '\\' && i + 1 < n) { v += body[i + 1]; i += 2; continue; }
        if (body[i] === '"') { i++; break; }
        v += body[i]; i++;
      }
      out.push(v);
    } else {
      let v = '';
      while (i < n && body[i] !== ',') { v += body[i]; i++; }
      if (v.trim()) out.push(v.trim());
    }
  }
  return out;
}
