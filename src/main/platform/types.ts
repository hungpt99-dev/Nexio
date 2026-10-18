import type { ChildProcess } from 'node:child_process';

export type PlatformKey = 'win32' | 'darwin';

/** Key-cap glyphs rendered in footer hints, docs use the same helper. */
export interface KeyCaps {
  alt: string;
  ctrl: string;
  shift: string;
  cmd: string;
  esc: string;
  space: string;
}

export interface ShellRunOpts {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** stdin payload for hook-style commands; shell_run passes none. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  maxChars?: number;
}

export interface ShellRunResult {
  /** Process exit code, or null when killed/timed-out/aborted. */
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface AppInfo {
  name: string;
}

export interface ActiveWindow {
  pid: number;
  /** Win32 exe name (lowercase) or macOS bundle id. */
  id: string;
  name: string;
  windowTitle: string;
  isBrowser: boolean;
}

export type SelectionRead =
  | { ok: true; text: string }
  | { ok: false; skip: 'password_field' | 'elevated_window' | 'unsupported_app' | 'no_permission' | 'timeout' | 'empty' };

export interface SelectedFileItem {
  path: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
}

export type SelectedFilesRead =
  | { ok: true; files: SelectedFileItem[]; total: number; folder?: string }
  | { ok: false; skip: 'no_permission' | 'timeout' | 'empty' | 'unsupported_app' };

export type BrowserPageRead =
  | { ok: true; url: string; title: string; text?: string; isPrivate?: boolean }
  | { ok: false; skip: 'no_permission' | 'timeout' | 'empty' | 'unsupported_app' | 'private_window' | 'elevated_window' };

export interface RunShellOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Single OS adapter. All process.platform branches, shell construction,
 * process-tree kills, trash, open, protected roots, hotkeys, key labels,
 * secrets backend and login env live here — nowhere else.
 */
export interface PlatformAdapter {
  readonly key: PlatformKey;
  /** Human shell name shown on approval cards: 'PowerShell' | 'zsh'. */
  readonly shellName: string;
  /** Word for the OS recycle location: 'Recycle Bin' | 'Trash'. */
  readonly trashWord: string;
  /** True when the default FS is case-sensitive (linux); win32 + darwin default false. */
  readonly caseSensitiveFs: boolean;

  /** Spawn `command` in the platform shell with timeout + tree-kill on abort/timeout. */
  runShell(command: string, opts: ShellRunOpts): Promise<ShellRunResult>;
  /** Kill a spawned child AND its whole process tree. */
  killTree(child: ChildProcess): void;
  /** Shell used for hook/workflow commands: same binary/flags as runShell. */
  shellForCommand(command: string): { bin: string; args: string[] };
  /** Environment for child processes: login-shell env on macOS (cached), process.env on Windows. */
  loginEnv(): Promise<NodeJS.ProcessEnv>;
  /** Resolve the login shell binary for shell_run (zsh/bash, else /bin/zsh on macOS). */
  loginShellBin(): string;

  /** Running apps/windows, read-only, no special permission. */
  listApps(signal: AbortSignal): Promise<AppInfo[]>;

  /** Foreground window at call time. Fast, no permission prompt, null when unknown. */
  getActiveWindow(signal: AbortSignal): Promise<ActiveWindow | null>;
  /** Selected text in the given window. Skip reasons: password_field, deny handled by caller, elevated_window, unsupported_app, no_permission, timeout, empty. */
  readSelection(win: ActiveWindow, signal: AbortSignal): Promise<SelectionRead>;
  /** Selected files in Explorer/Finder/Desktop + the open folder. */
  readSelectedFiles(signal: AbortSignal): Promise<SelectedFilesRead>;
  /** Browser URL/title (+text when accessibility exposes it) for the given window. */
  readBrowserPage(win: ActiveWindow, signal: AbortSignal): Promise<BrowserPageRead>;
  /** Open a path/URL with the OS default handler. */
  openTarget(target: string): Promise<void>;
  /** Move to Recycle Bin / Trash. Never permanent delete. */
  trashItem(path: string): Promise<void>;

  /** Blocked roots unless the user explicitly adds the folder in Settings. */
  protectedPaths(homeDir?: string): string[];
  /** Refuse writes only (reads allowed), unless explicitly added. e.g. /Applications on macOS. */
  writeProtectedPaths(): string[];
  /** Friendly message for EPERM/EACCES (macOS TCC guidance), or null to use the raw error. */
  fsErrorHint(op: 'read' | 'write' | 'list' | 'search', err: unknown): string | null;
  /** OS path compare rule: NFC + case rules; original bytes still go to the FS. */
  normalizeForCompare(p: string): string;
  /** Expand a leading `~` to the home dir (macOS; no-op elsewhere). */
  expandUser(p: string): string;

  defaultHotkeys(): { toggle: string; stop: string };
  keyCaps(): KeyCaps;
  /** Render an Electron accelerator ('Ctrl+Alt+Esc') as key caps. */
  keyLabel(accel: string): string;
  /** Per-key caps for renderer/docs (same mapping, unjoined). */
  keyTokens(accel: string): string[];

  secrets: {
    available(): boolean;
    encrypt(s: string): Buffer;
    decrypt(b: Buffer): string;
  };

  /** Default user-data dir (app.getPath('userData') with plain-node fallback). */
  defaultDataDir(appName: string): string;
  /** Logs dir (app.getPath('logs') with fallback next to the DB). */
  defaultLogsDir(appName: string, dbFile: string): string;
}
