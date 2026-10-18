/** Local decision sidecar manager (infrastructure, small + optional).
 *
 * Starts/stops a user-run `laya[serve]` HTTP server as a child process bound
 * to 127.0.0.1 with a random port and token: no network egress, health checks
 * and restart. Model weights are NEVER bundled: download happens only on user
 * action, with the license shown and a checksum verified (see
 * docs/architecture/decision-model-finetune.md). When the binary is absent,
 * every method fails closed with a plain message.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';

export interface SidecarStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  port?: number;
  detail?: string;
}

export interface SidecarManager {
  status(): SidecarStatus;
  start(): Promise<SidecarStatus>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function healthOk(port: number, token: string, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal manager over a `laya-serve`-compatible binary on PATH. */
export class LayaSidecar implements SidecarManager {
  private proc: ChildProcess | null = null;
  private state: SidecarStatus = { state: 'stopped' };
  private token = '';

  constructor(private readonly command = 'laya-serve') {}

  status(): SidecarStatus {
    return { ...this.state };
  }

  /** Token for the Authorization header (never logged; loopback only). */
  authToken(): string {
    return this.token;
  }

  async start(): Promise<SidecarStatus> {
    if (this.state.state === 'ready' || this.state.state === 'starting') return this.status();
    this.state = { state: 'starting' };
    let port = 0;
    try {
      port = await freePort();
    } catch {
      this.state = { state: 'failed', detail: 'no loopback port available' };
      return this.status();
    }
    this.token = randomBytes(16).toString('hex');
    const proc = spawn(this.command, ['--host', '127.0.0.1', '--port', String(port)], {
      stdio: 'ignore',
      env: { ...process.env, LAYA_AUTH_TOKEN: this.token },
    });
    proc.on('error', () => {
      this.state = { state: 'failed', detail: `'${this.command}' not found — install laya[serve] first` };
      this.proc = null;
    });
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null;
        this.state = { state: 'stopped' };
      }
    });
    this.proc = proc;
    // why: poll health instead of sleeping a fixed delay — ready fast on warm
    // machines, still bounded on slow ones.
    for (let i = 0; i < 30; i += 1) {
      if (this.proc !== proc) return this.status();
      if (await healthOk(port, this.token, 1000)) {
        this.state = { state: 'ready', port };
        return this.status();
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    this.state = { state: 'failed', detail: 'health check timed out' };
    return this.status();
  }

  async stop(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    this.state = { state: 'stopped' };
    if (p && !p.killed) {
      try {
        p.kill();
      } catch { /* already gone */ }
    }
  }
}
