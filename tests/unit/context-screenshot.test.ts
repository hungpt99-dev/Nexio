import { describe, it, expect } from 'vitest';
import {
  captureScreenshot, storeShot, clearShot, stagedShot, screenshotStaged, isDenyListedApp,
  type CapturerDeps, type SourceThumb,
} from '../../src/main/context/screenshot';
import { probeScreenCapture, probeSpeaksPlainly } from '../../src/main/capabilities/registry';
import { beginSnapshot, __resetContextStoreForTests } from '../../src/main/context/store';

function thumb(id: string, name: string, displayId = '1'): SourceThumb {
  const png = Buffer.alloc(2048, 7);
  return { id, name, displayId, toPNG: () => png, width: 1920, height: 1080 };
}

function deps(over: Partial<CapturerDeps> = {}): CapturerDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sources: async () => [thumb('window:1', 'Acme — Report.docx', '1'), thumb('screen:1', 'Display 1', '1')],
    cursorDisplayId: () => '1',
    primaryDisplayId: () => '1',
    hidePopup: () => { calls.push('hide'); },
    showPopup: () => { calls.push('show'); },
    sleep: async () => {},
    screenPermission: () => 'granted',
    ...over,
  };
}

const WIN = { pid: 1, id: 'com.acme.writer', name: 'Acme', windowTitle: 'Report.docx', isBrowser: false };

describe('screenshot capture (real logic, injected capturer seam)', () => {
  it('captures the recorded window; popup hides then restores', async () => {
    const d = deps();
    const r = await captureScreenshot('window', WIN, [], d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.shot.png.length).toBeGreaterThan(1024);
      expect(r.shot.source).toContain('Report');
    }
    expect(d.calls).toEqual(['hide', 'show']);
  });
  it('captures the display under the cursor in screen mode', async () => {
    const r = await captureScreenshot('screen', WIN, [], deps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shot.source).toBe('Display 1');
  });
  it('deny-listed apps are never captured (no hide, no pixels)', async () => {
    const d = deps();
    const r = await captureScreenshot('window', WIN, ['acme'], d);
    expect(r).toMatchObject({ ok: false, skip: 'denied' });
    expect(d.calls).toEqual([]);
  });
  it('missing Screen Recording permission refuses before listing sources', async () => {
    let listed = false;
    const d = deps({
      screenPermission: () => 'denied',
      sources: async () => { listed = true; return []; },
    });
    const r = await captureScreenshot('window', WIN, [], d);
    expect(r).toMatchObject({ ok: false, skip: 'no_permission' });
    expect(listed).toBe(false);
  });
  it('unknown window refuses instead of capturing a neighbour', async () => {
    const r = await captureScreenshot('window', { ...WIN, name: 'Ghost', windowTitle: 'nope' }, [], deps());
    expect(r).toMatchObject({ ok: false, skip: 'empty' });
  });
  it('empty pixels refuse', async () => {
    const d = deps({ sources: async () => [{ ...thumb('screen:1', 'Display 1'), toPNG: () => Buffer.alloc(10) }] });
    const r = await captureScreenshot('screen', WIN, [], d);
    expect(r).toMatchObject({ ok: false, skip: 'empty' });
  });
});

describe('screenshot snapshot lifecycle (bytes in memory only)', () => {
  it('store -> available+attached; detach clears pixels; staged only when attached', () => {
    __resetContextStoreForTests();
    const snap = beginSnapshot({ name: 'Acme', windowTitle: 'R', isBrowser: false }, WIN);
    const meta = storeShot(snap, { png: Buffer.alloc(3000, 9), width: 100, height: 100, source: 'Display 1' });
    expect(snap.states.screenshot).toBe('available');
    expect(snap.attached.has('screenshot')).toBe(true);
    expect(meta.sha).toHaveLength(16);
    const st = stagedShot(snap);
    expect(st?.dataBase64.length).toBeGreaterThan(100);
    // detach clears pixels: nothing left to send or log
    clearShot(snap);
    expect(snap.screenshot).toBeUndefined();
    expect(stagedShot(snap)).toBeNull();
    expect(snap.states.screenshot).toBe('skipped:empty');
  });
  it('deny-list matching is substring over id/name/title', () => {
    expect(isDenyListedApp(WIN, ['1password'], 'Display 1')).toBe(false);
    expect(isDenyListedApp({ ...WIN, name: '1Password' }, ['1password'], 'Display 1')).toBe(true);
    expect(isDenyListedApp(WIN, ['report'], 'Display 1')).toBe(true);
  });
});

describe('screenshot probe speaks plainly and fails closed', () => {
  it('outside Electron: unavailable with human text, no codes', () => {
    const r = probeScreenCapture();
    expect(r.available).toBe(false);
    expect(probeSpeaksPlainly(r)).toBe(true);
    expect(r.action.length).toBeGreaterThan(0);
  });
  it('send path stages the live attached shot, nothing when detached', () => {
    __resetContextStoreForTests();
    expect(screenshotStaged()).toEqual([]);
    const snap = beginSnapshot({ name: 'Acme', windowTitle: 'R', isBrowser: false }, WIN);
    storeShot(snap, { png: Buffer.alloc(3000, 9), width: 100, height: 100, source: 'Display 1' });
    const staged = screenshotStaged();
    expect(staged).toHaveLength(1);
    expect(staged[0].mime).toBe('image/png');
    expect(staged[0].name).toContain('screenshot-');
    clearShot(snap);
    expect(screenshotStaged()).toEqual([]);
  });
});
