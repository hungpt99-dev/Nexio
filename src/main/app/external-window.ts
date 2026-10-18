import type { ActiveWindow } from '../platform/types';
export type { ActiveWindow };
import { platform } from '../platform/index';

/** The app window the user just left, recorded at hotkey press BEFORE Nexio
 * shows. Nexio never captures its own window (own pid/exe filtered). */

let last: ActiveWindow | null = null;
let lastAt = 0;
let inflight: Promise<ActiveWindow | null> | null = null;

export function getLastExternalWindow(): ActiveWindow | null {
  return last;
}

export function getLastExternalAt(): number {
  return lastAt;
}

/** Fast OS query only (no content). Never rejects; null when unknown. */
export function recordExternalWindow(): Promise<ActiveWindow | null> {
  if (inflight) return inflight;
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 1500);
  inflight = (async () => {
    try {
      const w = await platform().getActiveWindow(c.signal);
      if (w) {
        last = w;
        lastAt = Date.now();
      }
      return w;
    } catch {
      return last;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

/** Test seam. */
export function __setExternalWindowForTests(w: ActiveWindow | null): void {
  last = w;
  lastAt = w ? Date.now() : 0;
}
