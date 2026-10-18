import { describe, it, expect, beforeEach, vi } from 'vitest';
import { beginSnapshot, getSnapshot, clear, capText, sha256, __resetContextStoreForTests, setFileExcluded, isFileExcluded } from '../../src/main/context/store';
import { applyAutoAttach, attachSource, detachSource } from '../../src/main/context/manager';
import { buildSnapshotView, describeContextState } from '../../src/main/context/prompt';

const APP = { name: 'Notepad', windowTitle: 'notes.txt', isBrowser: false };

beforeEach(() => __resetContextStoreForTests());

describe('snapshot lifecycle', () => {
  it('expires after 60 s and is deleted on hide', () => {
    vi.useFakeTimers();
    try {
      const s = beginSnapshot(APP, null);
      expect(getSnapshot(s.id)).not.toBeNull();
      expect(s.expiresAt - s.capturedAt).toBe(60_000);
      vi.advanceTimersByTime(60_001);
      expect(getSnapshot(s.id)).toBeNull();
      // wrong id never matches
      const s2 = beginSnapshot(APP, null);
      expect(getSnapshot('nope')).toBeNull();
      clear();
      expect(getSnapshot(s2.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('never captures Nexio itself: null external window yields no content', () => {
    const s = beginSnapshot(APP, null);
    expect(s.sources).toEqual([]);
    expect(s.attached.size).toBe(0);
  });
  it('capText truncates without splitting graphemes and NFC-normalizes', () => {
    const fam = '👨‍👩‍👧‍👦'.normalize('NFD');
    const cap = capText(fam + 'x'.repeat(10), 2);
    expect(cap.truncated).toBe(true);
    expect([...cap.text].length).toBe(2);
    expect(cap.text.normalize('NFC')).toBe(cap.text);
  });
  it('sha256 helper is stable', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
  });
  it('file exclusions are per-snapshot', () => {
    beginSnapshot(APP, null);
    setFileExcluded('/a/b.txt', true);
    expect(isFileExcluded('/a/b.txt')).toBe(true);
    setFileExcluded('/a/b.txt', false);
    expect(isFileExcluded('/a/b.txt')).toBe(false);
    setFileExcluded('/a/b.txt', true);
    clear();
    expect(isFileExcluded('/a/b.txt')).toBe(false);
  });
});

describe('auto-attach + attach/detach', () => {
  const settings = (over: Record<string, unknown> = {}) => ({
    provider: 'openai', model: 'm', hotkey: '', mode: 'chat', ...over,
  }) as never;
  it('default attaches selection + files only', () => {
    const s = beginSnapshot(APP, null);
    s.states.selection = 'available';
    s.selection = { kind: 'text', text: 'hi', truncated: false, length: 2 };
    s.sources.push('selection');
    s.states.files = 'available';
    s.states.clipboard = 'available';
    s.states.page = 'available';
    applyAutoAttach(settings({}), s);
    expect([...s.attached]).toEqual(['selection', 'files']);
  });
  it('ask/off modes attach nothing', () => {
    for (const m of ['ask', 'off']) {
      const s = beginSnapshot(APP, null);
      s.states.selection = 'available';
      s.sources.push('selection');
      applyAutoAttach(settings({ contextAutoAttach: m }), s);
      expect([...s.attached]).toEqual([]);
    }
  });
  it('attach refuses unavailable sources', () => {
    const s = beginSnapshot(APP, null);
    s.states.selection = 'skipped:empty';
    expect(attachSource(s, 'selection')).toBe(false);
    s.states.selection = 'available';
    expect(attachSource(s, 'selection')).toBe(true);
    detachSource(s, 'selection');
    expect([...s.attached]).toEqual([]);
  });
});

describe('snapshot view: labels only, states, no content leaks', () => {
  it('labels carry counts/domains; preview capped', () => {
    const s = beginSnapshot({ name: 'Chrome', windowTitle: 'T', isBrowser: true }, null);
    s.states.selection = 'available';
    s.selection = { kind: 'text', text: 'hello world', truncated: false, length: 11 };
    s.sources.push('selection');
    s.attached.add('selection');
    s.states.files = 'skipped:empty';
    const v = buildSnapshotView(s);
    const sel = v.views.find((x) => x.source === 'selection');
    expect(sel?.label).toContain('11');
    expect(sel?.attached).toBe(true);
    expect(v.views.find((x) => x.source === 'screenshot')).toBeUndefined();
  });
  it('describeContextState explains every state', () => {
    expect(describeContextState('available')).toBe('available');
    expect(describeContextState('denied')).toContain('protected app');
    expect(describeContextState('unavailable:no_permission')).toContain('Settings');
    expect(describeContextState('unavailable:elevated_window')).toContain('elevated');
    expect(describeContextState('skipped:concealed')).toContain('password manager');
    expect(describeContextState('skipped:private_window')).toContain('private');
  });
});
