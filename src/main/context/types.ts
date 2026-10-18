import type { ContextSourceName as SharedSourceName, ContextSourceView } from '../../shared/types';

export type ContextSourceName = SharedSourceName;

/** Per-source state: available | unavailable:<reason> | denied | skipped:<reason>. */
export type ContextState = string;

export interface ActiveWindow {
  pid: number;
  /** Win32 exe name (lowercase) or macOS bundle id. */
  id: string;
  /** Human app name. */
  name: string;
  windowTitle: string;
  isBrowser: boolean;
}

export interface SelectionData {
  kind: 'text';
  text: string;
  truncated: boolean;
  length: number;
}

export interface ContextFileRef {
  id: string;
  displayName: string;
  absolutePath: string;
  kind: 'file' | 'folder';
  size?: number;
  mtime?: number;
  /** Outside allowed roots: referenced but needs one-time allow. */
  outsideRoots?: boolean;
}

export interface FolderData {
  absolutePath: string;
  displayName: string;
}

export interface ClipboardData {
  kind: 'text' | 'files' | 'image' | 'other';
  preview: string;
  length: number;
  concealed: boolean;
  fullText?: string;
  files?: ContextFileRef[];
  imageBytes?: Buffer;
  imageMime?: string;
}

export interface PageData {
  url: string;
  title: string;
  text?: string;
  truncated?: boolean;
  isPrivate?: boolean;
}

export interface ContextSnapshot {
  id: string;
  capturedAt: number;
  expiresAt: number;
  app: { name: string; windowTitle: string; isBrowser: boolean };
  external: ActiveWindow | null;
  selection?: SelectionData;
  files?: ContextFileRef[];
  filesTotal?: number;
  folder?: FolderData;
  clipboard?: ClipboardData;
  page?: PageData;
  sources: ContextSourceName[];
  states: Record<ContextSourceName, ContextState>;
  attached: Set<ContextSourceName>;
  /** Secrets-scanner hits per source (chip warning + confirm; never content). */
  secretFlags?: Partial<Record<ContextSourceName, boolean>>;
}

export type SkipReason =
  | 'no_permission' | 'password_field' | 'deny_listed_app' | 'private_window'
  | 'timeout' | 'unsupported_app' | 'empty' | 'elevated_window' | 'concealed'
  | 'disabled' | 'unavailable' | 'no_screen_context' | 'not_configured';

/** Typed skip: { ok:false, skip:<reason> }. Success: { ok:true, ...data }. */
export type CollectorOut<T> = { ok: true; data: T } | { ok: false; skip: SkipReason; detail?: string };

/**
 * Small provider surface the collectors use. The platform adapter implements
 * it; a native helper can replace the scripting implementations later.
 */
export interface ContextProvider {
  getActiveWindow(signal: AbortSignal): Promise<ActiveWindow | null>;
  readSelection(win: ActiveWindow, signal: AbortSignal): Promise<CollectorOut<{ text: string }>>;
  readSelectedFiles(signal: AbortSignal): Promise<CollectorOut<{ files: Array<{ path: string; isDir: boolean; size?: number; mtime?: number }>; total: number; folder?: string }>>;
  readBrowserPage(win: ActiveWindow, signal: AbortSignal): Promise<CollectorOut<{ url: string; title: string; text?: string; isPrivate?: boolean }>>;
}

export interface SnapshotMeta {
  sources: ContextSourceName[];
  counts: Record<string, number>;
  appName: string;
  isBrowser: boolean;
}

export function snapshotMeta(s: ContextSnapshot): SnapshotMeta {
  return {
    sources: [...s.sources],
    counts: {
      selectionChars: s.selection?.length || 0,
      files: s.filesTotal ?? s.files?.length ?? 0,
      clipboardChars: s.clipboard?.length || 0,
      pageChars: s.page?.text?.length || 0,
    },
    appName: s.app.name,
    isBrowser: s.app.isBrowser,
  };
}

export type { ContextSourceView };
