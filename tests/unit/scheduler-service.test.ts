import { describe, it, expect } from 'vitest';
import { JobScheduler, type SchedulerDeps } from '../../src/main/scheduler/service';
import type { Job } from '../../src/main/scheduler/store';

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j1', name: 'Morning brief', prompt: 'summarize inbox', scope: 'ask',
    spec: JSON.stringify({ kind: 'interval', everyMs: 3_600_000 }), tz: 'UTC',
    enabled: true, conversationId: null, missPolicy: 'skip',
    lastRunAt: null, lastStatus: null, lastSummary: null,
    createdAt: T0, updatedAt: T0, ...over,
  };
}

function harness(jobs: Job[], now = T0) {
  let t = now;
  const timers: Array<{ at: number; cb: () => void; cancelled: boolean }> = [];
  const fired: string[] = [];
  const notices: string[] = [];
  const deps: SchedulerDeps = {
    now: () => t,
    setTimer: (ms, cb) => {
      const rec = { at: t + ms, cb, cancelled: false };
      timers.push(rec);
      return { cancel: () => { rec.cancelled = true; } };
    },
    jobs: () => jobs,
    fire: async (j) => { fired.push(j.id); return `ok ${j.id}`; },
    notify: (title) => { notices.push(title); },
    onError: () => {},
  };
  const sch = new JobScheduler(deps);
  return {
    sch, fired, notices, timers,
    advance(ms: number) {
      t += ms;
      for (const rec of [...timers]) {
        if (!rec.cancelled && rec.at <= t) {
          rec.cancelled = true;
          rec.cb();
        }
      }
    },
  };
}

describe('job scheduler (injected clock, real service)', () => {
  it('arms the nearest job and fires it on time', async () => {
    const h = harness([job({ id: 'a', spec: JSON.stringify({ kind: 'interval', everyMs: 7_200_000 }) }), job({ id: 'b', spec: JSON.stringify({ kind: 'interval', everyMs: 3_600_000 }) })]);
    h.sch.start();
    expect(h.timers.length).toBe(1);
    expect(h.timers[0].at).toBe(T0 + 3_600_000);
    h.advance(3_600_000);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.fired).toEqual(['b']);
    expect(h.notices).toEqual(['Scheduled job started: Morning brief']);
    h.sch.stop();
  });
  it('disabled jobs never arm', () => {
    const h = harness([job({ enabled: false })]);
    h.sch.start();
    expect(h.timers.length).toBe(0);
    h.sch.stop();
  });
  it('missed run-once fires on start; skip does not', async () => {
    const daily = JSON.stringify({ kind: 'daily', hh: 9, mm: 0 });
    const once = harness([job({ id: 'm', spec: daily, missPolicy: 'run-once', lastRunAt: T0 - 3 * 86_400_000 })]);
    once.sch.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(once.fired).toEqual(['m']);
    once.sch.stop();
    const skip = harness([job({ id: 's', spec: daily, missPolicy: 'skip', lastRunAt: T0 - 3 * 86_400_000 })]);
    skip.sch.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(skip.fired).toEqual([]);
    skip.sch.stop();
  });
  it('runNow fires without disturbing the schedule', async () => {
    const h = harness([job()]);
    h.sch.start();
    const summary = await h.sch.runNow('j1');
    expect(summary).toBe('ok j1');
    expect(h.fired).toEqual(['j1']);
    await expect(h.sch.runNow('nope')).rejects.toThrow('Unknown job');
    h.sch.stop();
  });
  it('invalid specs never arm (fail-closed, no crash)', () => {
    const h = harness([job({ spec: '{"kind":"cron","expr":"nonsense"}' })]);
    h.sch.start();
    expect(h.timers.length).toBe(0);
    h.sch.stop();
  });
});
