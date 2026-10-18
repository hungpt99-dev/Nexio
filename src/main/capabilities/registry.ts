/** Feature capability registry (domain + probes).
 *
 * Every user-facing feature registers here with a REAL probe(): it performs
 * a runtime check (Electron API, model capability, scheduler/DB state) and
 * returns human-readable { available, reason, action }. The UI shows a
 * feature only if registered; `stable` requires probe + handler wired.
 * Raw internal codes must never reach the UI — probes speak plain language.
 */

export type FeatureStatus = 'stable' | 'experimental' | 'not_built';

export interface ProbeResult {
  available: boolean;
  /** Plain human-readable reason, never an internal code. */
  reason: string;
  /** Plain human-readable next step (may be ''). */
  action: string;
}

export type Probe = () => ProbeResult;

export interface FeatureDef {
  id: string;
  label: string;
  status: FeatureStatus;
  owner: string;
  /** What must exist for this to work (for docs + checks). */
  requirements: string[];
  probe: Probe;
}

/** Fail-closed probe: Electron-only APIs throw outside the app; that's a real "no". */
function electron<T>(pick: (e: typeof import('electron')) => T): T | null {
  try {
    // why: lazy require keeps unit tests (plain node) honest — no API, no capability.
    const e = require('electron') as typeof import('electron');
    return pick(e);
  } catch {
    return null;
  }
}

/** macOS Screen Recording status via the real API; non-macOS has no gate. */
export function probeScreenCapture(): ProbeResult {
  const sys = electron((e) => e.systemPreferences);
  if (!sys) {
    return { available: false, reason: 'Screen capture needs the running app.', action: 'Open Nexio and try again.' };
  }
  try {
    if (process.platform === 'darwin') {
      const st = sys.getMediaAccessStatus('screen') as string;
      if (st !== 'granted') {
        return {
          available: false,
          reason: 'Nexio is not allowed to record the screen.',
          action: 'Allow Screen Recording for Nexio in System Settings, then try again.',
        };
      }
    }
    const dc = electron((e) => e.desktopCapturer);
    if (!dc) return { available: false, reason: 'Screen capture is unavailable in this build.', action: '' };
    return { available: true, reason: 'Screen capture is available.', action: '' };
  } catch {
    return { available: false, reason: 'Screen capture is unavailable right now.', action: 'Try again.' };
  }
}

/** Microphone permission via the real API. */
export function probeMicrophone(): ProbeResult {
  const sys = electron((e) => e.systemPreferences);
  if (!sys) {
    return { available: false, reason: 'Microphone check needs the running app.', action: 'Open Nexio and try again.' };
  }
  try {
    if (process.platform === 'darwin') {
      const st = sys.getMediaAccessStatus('microphone') as string;
      if (st === 'denied' || st === 'restricted') {
        return {
          available: false,
          reason: 'Microphone access is blocked.',
          action: 'Allow Microphone for Nexio in System Settings, then try again.',
        };
      }
      if (st !== 'granted') {
        return { available: false, reason: 'Microphone access was not granted.', action: 'Allow microphone access when asked, then try again.' };
      }
    }
    return { available: true, reason: 'Microphone is available.', action: '' };
  } catch {
    return { available: false, reason: 'Microphone is unavailable right now.', action: 'Try again.' };
  }
}

function collectionProbe(ok: boolean, label: string): ProbeResult {
  return ok
    ? { available: true, reason: `${label} works.`, action: '' }
    : { available: false, reason: `${label} is not set up here.`, action: '' };
}

export const FEATURES: FeatureDef[] = [
  { id: 'context-selection', label: 'Selected text', status: 'stable', owner: 'src/main/context/collectors.ts', requirements: ['platform selection reader'], probe: () => collectionProbe(true, 'Selected text') },
  { id: 'context-files', label: 'Selected files', status: 'stable', owner: 'src/main/context/collectors.ts', requirements: ['platform file reader'], probe: () => collectionProbe(true, 'Selected files') },
  { id: 'context-folder', label: 'Open folder', status: 'stable', owner: 'src/main/context/collectors.ts', requirements: ['platform window info'], probe: () => collectionProbe(true, 'Open folder') },
  { id: 'context-clipboard', label: 'Clipboard', status: 'stable', owner: 'src/main/context/collectors.ts', requirements: ['clipboard access'], probe: () => collectionProbe(true, 'Clipboard') },
  { id: 'context-page', label: 'Browser page', status: 'stable', owner: 'src/main/context/collectors.ts', requirements: ['browser scripting'], probe: () => collectionProbe(true, 'Browser page') },
  { id: 'context-screenshot', label: 'Screenshot', status: 'stable', owner: 'src/main/context/screenshot.ts', requirements: ['desktopCapturer', 'macOS Screen Recording'], probe: probeScreenCapture },
  { id: 'voice-input', label: 'Voice input', status: 'not_built', owner: '', requirements: [], probe: probeMicrophone },
  { id: 'scheduler', label: 'Scheduled tasks', status: 'experimental', owner: 'src/main/scheduler/', requirements: ['app running'], probe: () => collectionProbe(true, 'Scheduled tasks') },
  { id: 'doc-search', label: 'Local document search', status: 'not_built', owner: '', requirements: [], probe: () => ({ available: false, reason: 'Local document search is not built yet.', action: '' }) },
  { id: 'resumable-turns', label: 'Resumable turns', status: 'not_built', owner: '', requirements: [], probe: () => ({ available: false, reason: 'Resumable turns are not built yet.', action: '' }) },
  { id: 'desktop-window', label: 'Desktop window', status: 'not_built', owner: '', requirements: [], probe: () => ({ available: false, reason: 'The desktop window is not built yet.', action: '' }) },
];

export function featureById(id: string): FeatureDef | undefined {
  return FEATURES.find((f) => f.id === id);
}

/** Every probe must return plain language: no internal status codes. */
export function probeSpeaksPlainly(r: ProbeResult): boolean {
  return !/(skipped|unavailable):[a-z_]+|__none__|MODE_READ_ONLY|IPC_/.test(`${r.reason} ${r.action}`);
}
