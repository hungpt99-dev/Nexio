/** Job scheduler wiring (interface glue).
 *
 * Owns the singleton JobScheduler bound to SQLite. Each fire is a NORMAL
 * turn: Do/Ask tasks through createUserTask (approvals, notifications, kill
 * switch all apply — parked approvals notify via the existing task path).
 * Run history lives in the run log (tasks) and job.lastStatus synced from
 * terminal task states.
 */
import type { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import { JobScheduler, realTimers, type SchedulerDeps } from './service';
import { listJobs, getJob, recordJobRun, updateJob, type Job } from './store';

export interface JobWire {
  db(): DatabaseSync;
  settings(): { agentCwd?: string; provider: string; model: string };
  createTask(input: {
    prompt: string; cwd: string; provider: string; model: string;
    conversationId: string; title: string; runMode: 'ask' | 'do';
  }): { taskId: string } | { error: string };
  createConversation(title: string): string;
  taskState(taskId: string): string | null;
  notify(title: string): void;
}

let scheduler: JobScheduler | null = null;

function deps(wire: JobWire): SchedulerDeps {
  const timers = realTimers();
  return {
    ...timers,
    jobs: () => {
      try {
        return listJobs(wire.db());
      } catch {
        return [];
      }
    },
    fire: async (job: Job) => fireJob(wire, job),
    notify: (title) => {
      try {
        wire.notify(title);
      } catch { /* notifications never break runs */ }
    },
    onError: (job: Job, e: unknown) => {
      try {
        recordJobRun(wire.db(), job.id, 'failed', (e as Error)?.message || 'unknown error');
      } catch { /* history best-effort */ }
    },
  };
}

async function fireJob(wire: JobWire, job: Job): Promise<string> {
  const d = wire.db();
  const s = wire.settings();
  let conv = job.conversationId;
  try {
    const existing = conv ? conversationExists(d, conv) : false;
    if (!existing) {
      conv = wire.createConversation(`Schedule — ${job.name}`);
      updateJob(d, job.id, { conversationId: conv });
    }
  } catch (e) {
    recordJobRun(d, job.id, 'failed', `no conversation: ${(e as Error)?.message || 'unknown'}`);
    throw e;
  }
  const r = wire.createTask({
    prompt: job.prompt,
    cwd: s.agentCwd || os.homedir(),
    provider: s.provider,
    model: s.model,
    conversationId: conv as string,
    title: job.name,
    runMode: job.scope,
  });
  if ('error' in r) {
    recordJobRun(d, job.id, 'failed', r.error);
    throw new Error(r.error);
  }
  try {
    updateJob(d, job.id, { lastTaskId: r.taskId });
    recordJobRun(d, job.id, 'started', `task ${r.taskId}`);
  } catch { /* history best-effort */ }
  return `task ${r.taskId}`;
}

function conversationExists(d: DatabaseSync, id: string): boolean {
  try {
    const r = d.prepare('SELECT id FROM conversations WHERE id = ?').get(id) as { id?: unknown } | undefined;
    return !!r;
  } catch {
    return false;
  }
}

/** Copy terminal task outcomes into job.lastStatus (run on list/get/arm). */
export function syncJobStatuses(d: DatabaseSync, taskState: (taskId: string) => string | null): void {
  try {
    for (const job of listJobs(d)) {
      const tid = job.lastTaskId;
      if (!tid) continue;
      const st = taskState(tid);
      if (st === 'done' || st === 'failed' || st === 'stopped' || st === 'interrupted') {
        if (job.lastStatus !== st) recordJobRun(d, job.id, st, `task ${tid} ${st}`);
      }
    }
  } catch { /* history best-effort */ }
}

export function startJobScheduler(wire: JobWire): JobScheduler {
  stopJobScheduler();
  scheduler = new JobScheduler(deps(wire));
  scheduler.start();
  return scheduler;
}

export function stopJobScheduler(): void {
  try {
    scheduler?.stop();
  } catch { /* noop */ }
  scheduler = null;
}

export function jobScheduler(): JobScheduler | null {
  return scheduler;
}

export function getJobFresh(d: DatabaseSync, id: string): Job | null {
  return getJob(d, id);
}
