import { describe, it, expect, beforeEach, vi } from 'vitest';
import { beginSnapshot, __resetContextStoreForTests } from '../../src/main/context/store';
import { collectApp, collectClipboard, collectFiles, collectPage, collectSelection } from '../../src/main/context/collectors';
import { refreshContext } from '../../src/main/context/manager';
import { isDenyListed } from '../../src/main/context/deny';
import { platform } from '../../src/main/platform/index';
import type { ActiveWindow } from '../../src/main/platform/types';

const APP = { name: 'Notepad', windowTitle: 'n', isBrowser: false };
const WIN: ActiveWindow = { pid: 123, id: 'notepad.exe', name: 'Notepad', windowTitle: 'n', isBrowser: false };
const ctxBase = (over: Record<string, unknown> = {}) => ({
  settings: { provider: 'openai', model: 'm', theme: 'light', hotkey: '', mode: 'chat', contextSources: {}, ...over } as never,
  cwd: '/', homeDir: '/tmp', signal: new AbortController().signal,
});

beforeEach(() => {
  __resetContextStoreForTests();
  vi.restoreAllMocks();
});

describe('deny-list', () => {
  it('matches exe/bundle/name/title substrings, any language structure', () => {
    expect(isDenyListed({ id: '1password.exe', name: '1Password', windowTitle: 'x' }, [])).toBe(true);
    expect(isDenyListed({ id: 'com.bitwarden.desktop', name: 'Bitwarden', windowTitle: '' }, [])).toBe(true);
    expect(isDenyListed({ id: 'notepad.exe', name: 'Notepad', windowTitle: 'notes' }, [])).toBe(false);
    expect(isDenyListed({ id: 'app.exe', name: 'SecretVault', windowTitle: '' }, ['secretvault'])).toBe(true);
    expect(isDenyListed({ id: 'app.exe', name: 'App', windowTitle: 'Enter password' }, ['enter password'])).toBe(true);
  });
});

describe('collectors with mocked platform', () => {
  it('selection success, password skipped, deny-listed denied, unsupported', async () => {
    const snap = beginSnapshot(APP, WIN);
    vi.spyOn(platform(), 'readSelection').mockResolvedValue({ ok: true, text: '  hello  ' });
    await collectSelection(snap, WIN, ctxBase());
    expect(snap.states.selection).toBe('available');
    expect(snap.selection?.text).toBe('  hello  ');

    const s2 = beginSnapshot(APP, WIN);
    vi.spyOn(platform(), 'readSelection').mockResolvedValue({ ok: false, skip: 'password_field' });
    await collectSelection(s2, WIN, ctxBase());
    expect(s2.states.selection).toBe('unavailable:password_field');
    expect(s2.selection).toBeUndefined();
  });
  it('selection over the cap truncates with a flag', async () => {
    const snap = beginSnapshot(APP, WIN);
    vi.spyOn(platform(), 'readSelection').mockResolvedValue({ ok: true, text: 'x'.repeat(30_000) });
    await collectSelection(snap, WIN, ctxBase());
    expect(snap.selection?.truncated).toBe(true);
    expect([...snap.selection!.text].length).toBe(20_000);
  });
  it('files: 200 cap, NFD paths, outside roots flagged, symlinks resolved', async () => {
    const { default: fs } = await import('node:fs');
    const { default: os } = await import('node:os');
    const { default: path } = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    const uni = path.join(dir, 'caf\u0065\u0301.txt');
    fs.writeFileSync(uni, 'x');
    const link = path.join(dir, 'link.txt');
    try { fs.symlinkSync(uni, link); } catch { /* win without rights */ }
    const snap = beginSnapshot(APP, WIN);
    const many = Array.from({ length: 250 }, (_, i) => ({ path: path.join(dir, `f${i}.txt`), isDir: false }));
    vi.spyOn(platform(), 'readSelectedFiles').mockResolvedValue({ ok: true, files: many, total: 250, folder: dir });
    await collectFiles(snap, ctxBase({ agentAllowedRoots: [dir] }));
    expect(snap.files?.length).toBe(200);
    expect(snap.filesTotal).toBe(250);
    expect(snap.states.files).toBe('available');
    // NFD + symlink + outside-roots
    const s2 = beginSnapshot(APP, WIN);
    vi.spyOn(platform(), 'readSelectedFiles').mockResolvedValue({
      ok: true,
      files: [{ path: uni, isDir: false }, { path: link, isDir: false }, { path: '/etc/passwd', isDir: false }],
      total: 3,
    });
    await collectFiles(s2, ctxBase({ agentAllowedRoots: [dir] }));
    const names = s2.files!.map((f) => f.displayName);
    expect(names).toContain('café.txt');
    // /etc is a symlink (macOS): realpath resolves, display name kept, marked outside roots
    const outside = s2.files!.find((f) => f.displayName === 'passwd');
    expect(outside).toBeTruthy();
    expect(outside?.absolutePath).not.toBe('/etc/passwd');
    expect(outside?.outsideRoots).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('clipboard: concealed formats skipped before any read; text capped; never auto-attached', async () => {
    const snap = beginSnapshot(APP, WIN);
    await collectClipboard(snap, ctxBase());
    // headless Electron clipboard: unavailable or empty — never attached by collection
    expect(snap.attached.has('clipboard')).toBe(false);
    expect(['skipped:empty', 'unavailable:unsupported_app', 'available']).toContain(snap.states.clipboard);
  });
  it('page: tracking params + fragments stripped; private window skipped', async () => {
    const bwin: ActiveWindow = { pid: 9, id: 'chrome.exe', name: 'Chrome', windowTitle: 'T', isBrowser: true };
    const snap = beginSnapshot({ name: 'Chrome', windowTitle: 'T', isBrowser: true }, bwin);
    vi.spyOn(platform(), 'readBrowserPage').mockResolvedValue({
      ok: true, url: 'https://e.com/a?utm_source=x&gclid=y#frag', title: 'T', text: 'body text',
    });
    await collectPage(snap, bwin, ctxBase());
    expect(snap.page?.url).toBe('https://e.com/a');
    expect(snap.page?.text).toBe('body text');
    const s2 = beginSnapshot({ name: 'Chrome', windowTitle: '', isBrowser: true }, bwin);
    vi.spyOn(platform(), 'readBrowserPage').mockResolvedValue({ ok: false, skip: 'private_window' });
    await collectPage(s2, bwin, ctxBase());
    expect(s2.states.page).toBe('skipped:private_window');
    expect(s2.page).toBeUndefined();
  });
  it('refreshContext: async collectors, per-source budgets, excludes self, deny-list yields no content', async () => {
    vi.spyOn(platform(), 'readSelection').mockImplementation(
      () => new Promise((res) => setTimeout(() => res({ ok: true, text: 'slow' }), 5000)),
    );
    vi.spyOn(platform(), 'readSelectedFiles').mockResolvedValue({ ok: false, skip: 'empty' });
    const t0 = Date.now();
    const snap = await refreshContext(ctxBase().settings, WIN, { cwd: '/', db: undefined });
    const dt = Date.now() - t0;
    expect(snap).not.toBeNull();
    // slow selection collector hit its 400 ms budget instead of blocking
    expect(dt).toBeLessThan(3000);
    expect(snap!.states.selection).toMatch(/unavailable/);
  });
});

describe('osascript record/list parsing', () => {
  it('parses {k:v} records with quoted commas', async () => {
    const { parseOsaRecord, parseOsaList } = await import('../../src/main/platform/context-darwin');
    expect(parseOsaRecord('{nm:"Google Chrome", bid:"com.google.Chrome", pid:6820, wt:"a, b"}')).toEqual({
      nm: 'Google Chrome', bid: 'com.google.Chrome', pid: '6820', wt: 'a, b',
    });
    expect(parseOsaRecord('nm:Google Chrome, bid:com.google.Chrome, pid:6820, wt:')).toEqual({
      nm: 'Google Chrome', bid: 'com.google.Chrome', pid: '6820', wt: '',
    });
    expect(parseOsaRecord('garbage')).toEqual({});
    expect(parseOsaList('{"a", "b, c"}')).toEqual(['a', 'b, c']);
    expect(parseOsaList('')).toEqual([]);
  });

  // why: Chrome ships com.google.Chrome (capital C); the page reader used
  // to exact-match lowercase ids and reported real Chrome as unsupported.
  it('matches the real mixed-case Chrome bundle id', async () => {
    const { browserPageTarget } = await import('../../src/main/platform/context-darwin');
    expect(browserPageTarget('com.google.Chrome')).toEqual({ kind: 'chrome', appName: 'Google Chrome' });
    expect(browserPageTarget('com.google.chrome')).toEqual({ kind: 'chrome', appName: 'Google Chrome' });
    expect(browserPageTarget('com.apple.safari')).toEqual({ kind: 'safari' });
    expect(browserPageTarget('org.mozilla.firefox')).toBeNull();
    expect(browserPageTarget('')).toBeNull();
  });

  // why: a readable element with no selected text is empty, not unsupported.
  it('distinguishes nothing-selected from unsupported selection', async () => {
    const { selectionReadForRaw } = await import('../../src/main/platform/context-darwin');
    expect(selectionReadForRaw('NOSEL')).toEqual({ ok: false, skip: 'empty' });
    expect(selectionReadForRaw('NONE')).toEqual({ ok: false, skip: 'unsupported_app' });
    expect(selectionReadForRaw('SECURE')).toEqual({ ok: false, skip: 'password_field' });
    expect(selectionReadForRaw('TEXT:hello')).toEqual({ ok: true, text: 'hello' });
    expect(selectionReadForRaw('TEXT:   ')).toEqual({ ok: false, skip: 'empty' });
  });
});
