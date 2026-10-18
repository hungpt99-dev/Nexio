import { describe, it, expect } from 'vitest';
import { parseSpec, parseCron, nextRunMs, validTimeZone, wallTime } from '../../src/main/scheduler/spec';

const SUN = Date.UTC(2026, 9, 18, 12, 0, 0); // Sunday 12:00Z

describe('job spec validation', () => {
  it('accepts the four kinds, rejects garbage', () => {
    expect(parseSpec({ kind: 'interval', everyMs: 3_600_000 }).ok).toBe(true);
    expect(parseSpec({ kind: 'interval', everyMs: 1000 }).ok).toBe(false);
    expect(parseSpec({ kind: 'daily', hh: 9, mm: 30 }).ok).toBe(true);
    expect(parseSpec({ kind: 'daily', hh: 25, mm: 0 }).ok).toBe(false);
    expect(parseSpec({ kind: 'weekdays', days: [1, 3], hh: 9, mm: 0 }).ok).toBe(true);
    expect(parseSpec({ kind: 'weekdays', days: [], hh: 9, mm: 0 }).ok).toBe(false);
    expect(parseSpec({ kind: 'cron', expr: '0 9 * * 1-5' }).ok).toBe(true);
    expect(parseSpec({ kind: 'cron', expr: 'every day' }).ok).toBe(false);
    expect(parseSpec({ kind: 'cron', expr: '* * * *' }).ok).toBe(false);
    expect(parseSpec(null).ok).toBe(false);
  });
  it('cron names, ranges and steps parse', () => {
    expect(parseCron('0 9 * * mon-fri')).not.toBeNull();
    expect(parseCron('*/15 8-18 * * *')).not.toBeNull();
    expect(parseCron('0 0 29 2 *')).not.toBeNull();
    expect(parseCron('61 * * * *')).toBeNull();
  });
  it('timezone ids validate', () => {
    expect(validTimeZone('UTC')).toBe(true);
    expect(validTimeZone('Asia/Ho_Chi_Minh')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('next run (fixed clock, UTC)', () => {
  it('interval adds arithmetically', () => {
    const p = parseSpec({ kind: 'interval', everyMs: 3_600_000 });
    expect(p.ok && nextRunMs(p.spec, 'UTC', SUN)).toBe(SUN + 3_600_000);
  });
  it('daily 09:00 from Sun 12:00Z fires Monday 09:00Z', () => {
    const p = parseSpec({ kind: 'daily', hh: 9, mm: 0 });
    expect(p.ok && nextRunMs(p.spec, 'UTC', SUN)).toBe(Date.UTC(2026, 9, 19, 9, 0, 0));
  });
  it('weekdays [Mon] 09:00 from Sun 12:00Z fires Monday 09:00Z', () => {
    const p = parseSpec({ kind: 'weekdays', days: [1], hh: 9, mm: 0 });
    expect(p.ok && nextRunMs(p.spec, 'UTC', SUN)).toBe(Date.UTC(2026, 9, 19, 9, 0, 0));
  });
  it('weekdays [Sun] 09:00 from Sun 12:00Z fires next Sunday', () => {
    const p = parseSpec({ kind: 'weekdays', days: [0], hh: 9, mm: 0 });
    expect(p.ok && nextRunMs(p.spec, 'UTC', SUN)).toBe(Date.UTC(2026, 9, 25, 9, 0, 0));
  });
  it('cron 0 9 * * * matches the next 09:00', () => {
    const p = parseSpec({ kind: 'cron', expr: '0 9 * * *' });
    expect(p.ok && nextRunMs(p.spec, 'UTC', SUN)).toBe(Date.UTC(2026, 9, 19, 9, 0, 0));
  });
  it('cron every 15 minutes lands on the quarter hour', () => {
    const p = parseSpec({ kind: 'cron', expr: '*/15 * * * *' });
    const got = p.ok && nextRunMs(p.spec, 'UTC', SUN);
    expect(got).toBe(Date.UTC(2026, 9, 18, 12, 15, 0));
  });
  it('daily in Ho Chi Minh time resolves wall time', () => {
    const p = parseSpec({ kind: 'daily', hh: 9, mm: 0 });
    const got = p.ok && nextRunMs(p.spec, 'Asia/Ho_Chi_Minh', SUN);
    // 09:00+07:00 Monday = 02:00Z Monday
    expect(got).toBe(Date.UTC(2026, 9, 19, 2, 0, 0));
  });
  it('spring-forward gap falls to the next day (America/New_York)', () => {
    // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00->03:00).
    const before = Date.UTC(2026, 2, 7, 12, 0, 0);
    const p = parseSpec({ kind: 'daily', hh: 2, mm: 30 });
    const got = p.ok && nextRunMs(p.spec, 'America/New_York', before);
    expect(got).not.toBeNull();
    if (got) {
      const w = wallTime('America/New_York', got);
      // the gap day contributes no 02:30, so the run lands on March 9 02:30 EDT (= 06:30Z).
      expect([w.mo, w.d, w.h, w.mi].join('-')).toBe('3-9-2-30');
      expect(new Date(got).toISOString()).toBe('2026-03-09T06:30:00.000Z');
    }
  });
});
