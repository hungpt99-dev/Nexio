import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  globalShortcut: { register: vi.fn(() => false), unregister: vi.fn(), unregisterAll: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

import { ipcMain } from 'electron';
import { IpcChannels } from '../../src/shared/ipc-channels';
import { openTestDb } from '../../src/main/db/db';
import { __resetIpcRegistryForTests, registerIpc } from '../../src/main/ipc';

const handle = vi.mocked(ipcMain.handle);
type Listener = (...args: unknown[]) => unknown;
function listenerFor(channel: string): Listener {
  const call = handle.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no handler for ${channel}`);
  return call[1] as Listener;
}

let prevDataDir: string | undefined;
beforeAll(() => {
  prevDataDir = process.env.NEXIO_DATA_DIR;
  process.env.NEXIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexio-sched-'));
  (globalThis as unknown as { __nexioDb: unknown }).__nexioDb = openTestDb();
  __resetIpcRegistryForTests();
  handle.mockClear();
  registerIpc();
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env.NEXIO_DATA_DIR;
  else process.env.NEXIO_DATA_DIR = prevDataDir;
});

function schedules(a: unknown) {
  return listenerFor(IpcChannels.schedules)({}, a) as Promise<Record<string, unknown>>;
}

describe('schedules channel (real DB, real validation)', () => {
  it('creates, lists, gets, pauses, resumes, deletes', async () => {
    const created = await schedules({
      action: 'create', name: 'Brief', prompt: 'summarize inbox', scope: 'ask',
      spec: { kind: 'daily', hh: 9, mm: 0 }, tz: 'UTC', missPolicy: 'skip',
    }) as { id: string; human: string; nextRunAt: number };
    expect(created.id).toMatch(/^job-/);
    expect(created.human).toContain('daily');
    expect(created.nextRunAt).toBeGreaterThan(Date.now());
    const list = await schedules({ action: 'list' }) as Array<{ id: string }>;
    expect(list.map((j) => j.id)).toContain(created.id);
    const one = await schedules({ action: 'get', id: created.id }) as { name: string };
    expect(one.name).toBe('Brief');
    await schedules({ action: 'update', id: created.id, enabled: false });
    const paused = await schedules({ action: 'get', id: created.id }) as { enabled: boolean; nextRunAt: null };
    expect(paused.enabled).toBe(false);
    expect(await schedules({ action: 'remove', id: created.id })).toBe(true);
    const after = await schedules({ action: 'list' }) as Array<unknown>;
    expect(after.map((j) => (j as { id: string }).id)).not.toContain(created.id);
  });
  it('rejects bad input with plain errors', async () => {
    // why: typedHandle returns error envelopes (the preload rethrows them).
    expect(await schedules({ action: 'create', name: '', prompt: 'x', spec: { kind: 'daily', hh: 9, mm: 0 } }))
      .toMatchObject({ ok: false, message: expect.stringContaining('name must be') });
    expect(await schedules({ action: 'create', name: 'n', prompt: 'x', spec: { kind: 'daily', hh: 99, mm: 0 } }))
      .toMatchObject({ ok: false, message: expect.stringContaining('invalid schedule') });
    expect(await schedules({ action: 'create', name: 'n', prompt: 'x', spec: { kind: 'daily', hh: 9, mm: 0 }, tz: 'Mars/X' }))
      .toMatchObject({ ok: false, message: expect.stringContaining('unknown timezone') });
    expect(await schedules({ action: 'get', id: 'job-nope' }))
      .toMatchObject({ ok: false, message: expect.stringContaining('Unknown job') });
  });
  it('runNow without a running scheduler fails honestly', async () => {
    const created = await schedules({
      action: 'create', name: 'Once', prompt: 'hi', spec: { kind: 'interval', everyMs: 3_600_000 },
    }) as { id: string };
    expect(await schedules({ action: 'runNow', id: created.id }))
      .toMatchObject({ ok: false, message: expect.stringContaining('not running') });
    await schedules({ action: 'remove', id: created.id });
  });
});
