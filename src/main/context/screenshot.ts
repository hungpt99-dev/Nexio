/** Screen capture collection (infrastructure).
 *
 * Explicit-action only: nothing is captured on refresh. The user captures via
 * /screen, the context panel Capture button, or the contextCapture channel.
 * Popup hides before capture and restores after. Deny-listed apps (password
 * managers etc.) are never captured. PNG bytes live in the snapshot (memory
 * only, 60 s expiry); logs carry size/sha only, never bytes.
 */
import type { ActiveWindow, CollectorOut, ContextSnapshot } from './types';
import { sha256, getSnapshot } from './store';

export type ShotRefusal =
  | 'denied'
  | 'no_permission'
  | 'not_configured'
  | 'unavailable'
  | 'empty';

export interface Shot {
  png: Buffer;
  width: number;
  height: number;
  /** 'window' | the display label captured. */
  source: string;
}

export type ShotResult = { ok: true; shot: Shot } | { ok: false; skip: ShotRefusal; detail?: string };

export interface SourceThumb {
  id: string;
  name: string;
  displayId: string;
  toPNG(): Buffer;
  width: number;
  height: number;
}

/** Seams: Electron APIs behind an interface so tests drive the real logic. */
export interface CapturerDeps {
  sources(): Promise<SourceThumb[]>;
  cursorDisplayId(): string | null;
  primaryDisplayId(): string | null;
  hidePopup(): void;
  showPopup(): void;
  sleep(ms: number): Promise<void>;
  /** 'granted' | anything else blocks capture with no_permission. */
  screenPermission(): 'granted' | 'denied' | 'unknown';
}

export function electronCapturer(): CapturerDeps {
  // why: required lazily — importing electron at module top breaks plain-node tests.
  const { desktopCapturer, screen } = require('electron') as typeof import('electron');
  const { getPopup } = require('../popup') as typeof import('../popup');
  return {
    async sources(): Promise<SourceThumb[]> {
      const raw = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      return raw.map((s) => {
        const size = s.thumbnail.getSize();
        return {
          id: s.id,
          name: s.name,
          displayId: String(s.display_id || ''),
          toPNG: () => s.thumbnail.toPNG(),
          width: size.width,
          height: size.height,
        };
      });
    },
    cursorDisplayId(): string | null {
      try {
        return String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
      } catch {
        return null;
      }
    },
    primaryDisplayId(): string | null {
      try {
        return String(screen.getPrimaryDisplay().id);
      } catch {
        return null;
      }
    },
    hidePopup(): void {
      try { getPopup()?.hide(); } catch { /* best-effort */ }
    },
    showPopup(): void {
      try { getPopup()?.show(); } catch { /* best-effort */ }
    },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    screenPermission(): 'granted' | 'denied' | 'unknown' {
      try {
        if (process.platform !== 'darwin') return 'granted';
        const { systemPreferences } = require('electron') as typeof import('electron');
        return systemPreferences.getMediaAccessStatus('screen') === 'granted' ? 'granted' : 'denied';
      } catch {
        return 'unknown';
      }
    },
  };
}

export function isDenyListedApp(
  external: ActiveWindow | null,
  denyList: string[],
  title: string,
): boolean {
  const hay = `${external?.id || ''} ${external?.name || ''} ${external?.windowTitle || ''} ${title}`.toLowerCase();
  return (denyList || []).some((p) => {
    const pat = String(p || '').toLowerCase().trim();
    return !!pat && hay.includes(pat);
  });
}

/**
 * Capture the recorded external window, or the display under the cursor.
 * Fail-closed: wrong target, denied app, missing permission, or empty pixels
 * all refuse with a reason — never a neighbouring window, never silence.
 */
export async function captureScreenshot(
  mode: 'window' | 'screen',
  external: ActiveWindow | null,
  denyList: string[],
  deps: CapturerDeps,
): Promise<ShotResult> {
  const perm = deps.screenPermission();
  if (perm !== 'granted') return { ok: false, skip: 'no_permission' };
  let list: SourceThumb[];
  try {
    list = await deps.sources();
  } catch {
    return { ok: false, skip: 'unavailable' };
  }
  if (!list.length) return { ok: false, skip: 'unavailable' };
  let target: SourceThumb | undefined;
  if (mode === 'window' && external) {
    const title = (external.windowTitle || '').trim();
    const app = (external.name || '').trim();
    target = list.find((s) => s.id.startsWith('window:') && (
      (title && s.name.includes(title)) || (app && s.name.toLowerCase().includes(app.toLowerCase()))
    ));
    // why: a mismatched window would capture someone else's screen — refuse
    // instead of guessing.
    if (!target) return { ok: false, skip: 'empty', detail: 'active window not found among capturable windows' };
  } else {
    const want = deps.cursorDisplayId() || deps.primaryDisplayId();
    target = list.find((s) => s.id.startsWith('screen:') && (!want || s.displayId === want))
      || list.find((s) => s.id.startsWith('screen:'));
    if (!target) return { ok: false, skip: 'unavailable' };
  }
  if (isDenyListedApp(external, denyList, target.name)) return { ok: false, skip: 'denied' };
  deps.hidePopup();
  try {
    // why: the compositor needs a beat after hide, or the popup is in the shot.
    await deps.sleep(350);
    const fresh = await deps.sources().catch(() => list);
    const retake = fresh.find((s) => s.id === target!.id) || target;
    const png = retake.toPNG();
    if (!png || png.length < 1024) return { ok: false, skip: 'empty', detail: 'capture returned no pixels' };
    return { ok: true, shot: { png, width: retake.width, height: retake.height, source: target.name } };
  } finally {
    deps.showPopup();
  }
}

/** Record a capture on the snapshot: available + attached, metadata only in logs. */
export function storeShot(
  snap: ContextSnapshot,
  shot: Shot,
): { sha: string; size: number } {
  snap.screenshot = {
    png: shot.png,
    width: shot.width,
    height: shot.height,
    source: shot.source,
    sha: sha256(shot.png.toString('base64')).slice(0, 16),
  };
  if (!snap.sources.includes('screenshot')) snap.sources.push('screenshot');
  snap.states.screenshot = 'available';
  snap.attached.add('screenshot');
  return { sha: snap.screenshot.sha, size: shot.png.length };
}

/** Drop screenshot bytes (detach clears pixels; expiry clears the rest). */
export function clearShot(snap: ContextSnapshot): void {
  delete snap.screenshot;
  snap.attached.delete('screenshot');
  if (snap.states.screenshot === 'available') snap.states.screenshot = 'skipped:empty';
}

export type { CollectorOut };

/** Small JPEG preview for the chip (rendered back to the user only). */
export function shotPreview(snap: ContextSnapshot): string | undefined {
  const shot = snap.screenshot;
  if (!shot) return undefined;
  try {
    const { nativeImage } = require('electron') as typeof import('electron');
    const img = nativeImage.createFromBuffer(shot.png);
    const size = img.getSize();
    const scale = Math.min(1, 320 / Math.max(1, size.width));
    const small = scale < 1
      ? img.resize({ width: Math.max(1, Math.round(size.width * scale)) })
      : img;
    return small.toDataURL();
  } catch {
    return undefined;
  }
}

/** Staged attachment for an attached screenshot (existing image pipeline). */
export function stagedShot(snap: ContextSnapshot): { name: string; mime: string; dataBase64: string } | null {
  const shot = snap.screenshot;
  if (!shot || !snap.attached.has('screenshot') || snap.states.screenshot !== 'available') return null;
  return {
    name: `screenshot-${snap.id}.png`,
    mime: 'image/png',
    dataBase64: shot.png.toString('base64'),
  };
}

/** StagedAttachment forms for a live attached screenshot (send paths). */
export function screenshotStaged(): Array<{ name: string; mime: string; dataBase64: string }> {
  try {
    const snap = getSnapshot();
    if (!snap) return [];
    const st = stagedShot(snap);
    return st ? [{ name: st.name, mime: st.mime, dataBase64: st.dataBase64 }] : [];
  } catch {
    return [];
  }
}
