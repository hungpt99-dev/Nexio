/** Job schedule specs (pure, no I/O, injectable clock via `fromMs`).
 *
 * Kinds: interval | daily | weekdays | cron (5-field subset). No cron
 * dependency: the 5-field subset (lists, ranges, steps, names) is ~60 lines
 * and avoids a dependency with Windows/macOS quirks. Timezone/DST-safe by
 * matching wall-clock fields resolved with Intl in the job's timezone:
 * spring-forward gaps simply don't match (run falls to the next day),
 * fall-back ambiguities fire on the first occurrence.
 */

export type JobSpec =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; hh: number; mm: number }
  | { kind: 'weekdays'; days: number[]; hh: number; mm: number }
  | { kind: 'cron'; expr: string };

export function parseSpec(raw: unknown): { ok: true; spec: JobSpec } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'schedule must be an object' };
  const o = raw as Record<string, unknown>;
  if (o.kind === 'interval') {
    const ms = typeof o.everyMs === 'number' ? o.everyMs : Number.NaN;
    if (!Number.isFinite(ms) || ms < 60_000 || ms > 365 * 86_400_000) {
      return { ok: false, error: 'interval.everyMs must be 60000..31536000000' };
    }
    return { ok: true, spec: { kind: 'interval', everyMs: Math.floor(ms) } };
  }
  if (o.kind === 'daily' || o.kind === 'weekdays') {
    const hh = o.hh as number;
    const mm = o.mm as number;
    if (!Number.isInteger(hh) || hh < 0 || hh > 23) return { ok: false, error: 'hh must be 0..23' };
    if (!Number.isInteger(mm) || mm < 0 || mm > 59) return { ok: false, error: 'mm must be 0..59' };
    if (o.kind === 'daily') return { ok: true, spec: { kind: 'daily', hh, mm } };
    const days = o.days;
    if (!Array.isArray(days) || !days.length || !days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
      return { ok: false, error: 'weekdays.days must be non-empty [0..6] (0=Sunday)' };
    }
    return { ok: true, spec: { kind: 'weekdays', days: [...new Set(days as number[])], hh, mm } };
  }
  if (o.kind === 'cron') {
    if (typeof o.expr !== 'string' || !parseCron(o.expr)) return { ok: false, error: 'cron.expr must be a valid 5-field expression' };
    return { ok: true, spec: { kind: 'cron', expr: (o.expr as string).trim().replace(/\s+/g, ' ') } };
  }
  return { ok: false, error: 'schedule.kind must be interval, daily, weekdays or cron' };
}

const NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseField(raw: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|[a-z0-9]+)(?:-([a-z0-9]+))?(?:\/(\d+))?$/i.exec(part.trim());
    if (!m) return null;
    const num = (v: string): number | null => {
      if (/^\d+$/.test(v)) return Number(v);
      const n = NAMES[v.toLowerCase()];
      return n === undefined ? null : n;
    };
    let a: number;
    let b: number;
    if (m[1] === '*') { a = lo; b = hi; } else {
      const n = num(m[1]);
      if (n === null) return null;
      a = m[2] ? n : n;
      b = m[2] ? num(m[2]) ?? -1 : n;
      if (b === -1) return null;
    }
    const step = m[3] ? Number(m[3]) : 1;
    if (!step || step < 1 || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out.size ? out : null;
}

export interface CronFields {
  min: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

export function parseCron(expr: string): CronFields | null {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const min = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const mon = parseField(parts[3], 1, 12);
  const dowRaw = parseField(parts[4].replace(/\b7\b/g, '0'), 0, 6);
  if (!min || !hour || !dom || !mon || !dowRaw) return null;
  const dow = new Set(dowRaw.has(7) ? [...dowRaw].filter((d) => d !== 7) : [...dowRaw]);
  if (dowRaw.has(7)) dow.add(0);
  return { min, hour, dom, mon, dow, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

export interface WallTime {
  y: number; mo: number; d: number; h: number; mi: number; dow: number;
}

const DTF = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = DTF.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
    });
    DTF.set(tz, f);
  }
  return f;
}

const WDOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock fields of an instant in tz (throws on unknown tz — caller validates). */
export function wallTime(tz: string, ms: number): WallTime {
  const parts = dtf(tz).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value || '0';
  return {
    y: Number(get('year')), mo: Number(get('month')), d: Number(get('day')),
    h: Number(get('hour')) % 24, mi: Number(get('minute')),
    dow: WDOW[get('weekday')] ?? 0,
  };
}

/** Validate a timezone id (Intl throws on unknown zones). */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function cronMatch(f: CronFields, w: WallTime): boolean {
  if (!f.min.has(w.mi) || !f.hour.has(w.h) || !f.mon.has(w.mo)) return false;
  // why: standard cron OR-semantics — a star on either side defers to the other.
  const domOk = f.dom.has(w.d);
  const dowOk = f.dow.has(w.dow);
  if (!f.domStar && !f.dowStar) return domOk || dowOk;
  if (!f.domStar) return domOk;
  if (!f.dowStar) return dowOk;
  return true;
}

/**
 * Next fire strictly after fromMs. Interval is arithmetic; daily/weekdays
 * compute directly; cron scans minute steps (cap ~366 days). Returns null
 * when nothing matches inside the cap.
 */
type DailySpec = { kind: 'daily'; hh: number; mm: number } | { kind: 'weekdays'; days: number[]; hh: number; mm: number };

function nextDaily(spec: DailySpec, tz: string, fromMs: number): number | null {
  // minute scan over 8 days in wall time — obviously correct across DST
  // (gaps never match, folds match once), ~11k Intl calls worst case.
  let t = fromMs + 60_000 - (fromMs % 60_000);
  const end = fromMs + 8 * 86_400_000 + 3_600_000;
  while (t <= end) {
    const w = wallTime(tz, t);
    if (w.h === spec.hh && w.mi === spec.mm &&
      (spec.kind === 'daily' || spec.days.includes(w.dow))) return t;
    t += 60_000;
  }
  return null;
}

export function nextRunMs(spec: JobSpec, tz: string, fromMs: number): number | null {
  switch (spec.kind) {
    case 'interval': return fromMs + spec.everyMs;
    case 'cron': {
      const f = parseCron(spec.expr);
      if (!f) return null;
      let t = fromMs + 60_000 - (fromMs % 60_000);
      const end = fromMs + 366 * 86_400_000;
      while (t <= end) {
        if (cronMatch(f, wallTime(tz, t))) return t;
        t += 60_000;
      }
      return null;
    }
    case 'daily':
    case 'weekdays': return nextDaily(spec, tz, fromMs);
  }
}

/** Human one-liner for UI (never a cron string alone). */
export function describeSpec(spec: JobSpec, tz: string): string {
  const z = tz ? ` (${tz})` : '';
  switch (spec.kind) {
    case 'interval': return `every ${describeMs(spec.everyMs)}`;
    case 'daily': return `daily at ${hhmm(spec.hh, spec.mm)}${z}`;
    case 'weekdays': {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `${spec.days.map((d) => days[d]).join(', ')} at ${hhmm(spec.hh, spec.mm)}${z}`;
    }
    case 'cron': return `cron ${spec.expr}${z}`;
  }
}

function hhmm(hh: number, mm: number): string {
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function describeMs(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}
