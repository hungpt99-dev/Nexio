/** Job scheduler (application).
 *
 * Single timer to the nearest due job; on fire the job runs as a NORMAL turn
 * (Do → task pipeline with approvals + notifications + kill switch; Ask →
 * plain chat turn in the job's conversation). Missed runs while the app was
 * off follow the job's missPolicy. Clock + timer are injectable for tests.
 */
import type { Job } from './store';
import { parseSpec, nextRunMs, validTimeZone, type JobSpec } from './spec';

export interface SchedulerDeps {
  now(): number;
  setTimer(ms: number, cb: () => void): { cancel(): void };
  /** Enabled jobs from storage. */
  jobs(): Job[];
  /** Execute one due run; resolves with a short summary for history. */
  fire(job: Job): Promise<string>;
  /** System notification (title only, never prompt content). */
  notify(title: string): void;
  onError(job: Job, e: unknown): void;
}

export function realTimers(): Pick<SchedulerDeps, 'now' | 'setTimer'> {
  return {
    now: () => Date.now(),
    setTimer: (ms: number, cb: () => void) => {
      const t = setTimeout(cb, Math.min(ms, 2_147_483_647));
      (t as { unref?: () => void }).unref?.();
      return { cancel: () => clearTimeout(t) };
    },
  };
}

function dueMs(job: Job, fromMs: number): number | null {
  const p = parseSpec(JSON.parse(job.spec) as unknown);
  if (!p.ok) return null;
  const tz = job.tz && validTimeZone(job.tz) ? job.tz : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    return nextRunMs(p.spec, tz, fromMs);
  } catch {
    return null;
  }
}

export class JobScheduler {
  private timer: { cancel(): void } | null = null;
  private running = false;
  private firedAt = new Map<string, number>();

  constructor(private readonly deps: SchedulerDeps) {}

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.applyMissed();
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = null;
  }

  /** Recompute the next wake-up (call after any job change). */
  arm(): void {
    this.timer?.cancel();
    this.timer = null;
    if (!this.running) return;
    const now = this.deps.now();
    let best: { job: Job; at: number } | null = null;
    for (const job of this.deps.jobs()) {
      if (!job.enabled) continue;
      const at = dueMs(job, now);
      if (at === null) continue;
      if (!best || at < best.at) best = { job, at };
    }
    if (!best) return;
    const wait = Math.max(0, best.at - now);
    const target = best.job;
    this.timer = this.deps.setTimer(wait, () => {
      this.timer = null;
      void this.tick(target.id);
      this.arm();
    });
  }

  /** Fire one job now (run-now button); does not disturb its schedule. */
  async runNow(id: string): Promise<string> {
    const job = this.deps.jobs().find((j) => j.id === id);
    if (!job) throw new Error('Unknown job');
    return this.execute(job);
  }

  private applyMissed(): void {
    const now = this.deps.now();
    for (const job of this.deps.jobs()) {
      if (!job.enabled) continue;
      // why: a run is missed when the next due time computed from the last
      // run (or boot, if never run) is already past.
      const from = job.lastRunAt || now - 1;
      const next = dueMs(job, from);
      if (next !== null && next <= now) {
        if (job.missPolicy === 'run-once' && this.firedAt.get(job.id) !== next) {
          this.firedAt.set(job.id, next);
          void this.execute(job);
        }
      }
    }
  }

  private async tick(id: string): Promise<void> {
    const job = this.deps.jobs().find((j) => j.id === id);
    if (!job || !job.enabled) return;
    await this.execute(job);
  }

  private async execute(job: Job): Promise<string> {
    this.deps.notify(`Scheduled job started: ${job.name}`);
    try {
      const summary = await this.deps.fire(job);
      return summary;
    } catch (e) {
      this.deps.onError(job, e);
      return `failed: ${(e as Error)?.message || 'unknown'}`;
    }
  }
}

export type { JobSpec };
export function specDueMs(job: Job, fromMs: number): number | null {
  return dueMs(job, fromMs);
}
