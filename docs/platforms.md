# Supported platforms

Nexio runs on **Windows 10/11** and **macOS 13+** (Apple Silicon and Intel).
Same features, same design, same safety rules on both. Linux is out of scope:
nothing targets it, but nothing intentionally breaks it either.

## One adapter, two implementations

All OS differences live behind one interface: `src/main/platform/`
(`types.ts`, `win32.ts`, `darwin.ts`, chosen at startup). No other file
checks the OS directly. The adapter owns: shell spawn + process-tree kill,
app listing, open/trash, protected roots, hotkey defaults, key-cap labels,
the secrets backend, login-shell env, path normalization, and data/log dirs.

## Windows 10/11

- Shell: PowerShell (`-NoProfile -NonInteractive`), no admin, tree-kill via
  `taskkill /T /F`. `sudo`/`su`/`doas`/`runas` patterns are refused outright.
- Frameless transparent popup, no taskbar entry, tray icon + tooltip.
- Hotkeys: `Alt+Space` toggle, `Ctrl+Alt+Esc` stop (same Electron syntax as macOS).
- Secrets in DPAPI via Electron `safeStorage`.
- Data: `%APPDATA%\Nexio`; existing installs keep working (see below).

## macOS 13+ (arm64 + x64)

- Menu-bar app: no Dock icon, no Cmd+Tab entry (`LSUIElement`, `app.dock.hide()`).
- Panel window floats over fullscreen apps and every Space; positioned on the
  display with the cursor using the work area (menu bar + notch respected).
- Monochrome Template menu-bar icon + standard app menu (Edit items, `Cmd+,`).
- Shell: your login shell when it is zsh/bash, else `/bin/zsh`, non-interactive.
- Child env comes from the login shell so `node`, `npx`, `uvx`, `brew`, `git`
  resolve from Finder launches. `sudo`/`su`/`doas` are refused outright.
- Hotkeys: `Option+Space` toggle, `Ctrl+Option+Esc` stop. Never `Cmd+Space`
  (Spotlight) or `Cmd+Option+Esc` (Force Quit). `Option+Space` is also used by
  other launchers — conflicts are expected; Settings shows a warning with a
  Change-hotkey button when registration fails.
- Secrets in Keychain via Electron `safeStorage`.
- Data: `~/Library/Application Support/Nexio`; logs: the OS logs dir.

## Context capture: OS APIs relied upon

Verified against current official docs on 2026-10-18 (per-app reliability
varies — collectors treat failures as normal skip reasons, never errors):

- Windows clipboard exclusion formats (learn.microsoft.com, clipboard
  formats): `ExcludeClipboardContentFromMonitorProcessing` (any value
  excludes from history + cloud), `CanIncludeInClipboardHistory` (DWORD 0
  excludes from history), `CanUploadToCloudClipboard` (DWORD 0 excludes
  from sync). **UNVERIFIED**: whether Electron's `availableFormats()`
  surfaces these names on all builds — the check is defensive (try/catch;
  absence is not proof of safety, previews stay capped and scanned).
- Electron clipboard on 37.10.3 (installed `electron.d.ts`): sync
  `availableFormats/has/readBuffer/readText/readImage/readHTML` all present
  (the W3C-style async rearchitecture exists only on Electron main — a
  future upgrade removes these helpers; raw-format checks must be revisited
  then). `readFilePaths` is absent — clipboard files go through
  `text/uri-list` when present, else `other`.
- macOS concealed pasteboard types: `org.nspasteboard.ConcealedType` /
  `TransientType` (the 1Password/Bitwarden signal) — checked via
  `availableFormats()` before any content is read.
- UI Automation TextPattern/selection, Shell `Shell.Application` /
  `IShellWindows` / `IFolderView2` selected items (Windows); `AXSelectedText`,
  `AXFocusedUIElement`, `AXSecureTextField` role (macOS); JXA
  `Application('Finder').selection()` (macOS); per-browser AppleScript URLs
  for Chrome-likes/Safari (Firefox: no scriptable URL — unsupported).
  Verified 2026-10-18 on macOS: `osascript -s s` record parsing (quoted
  values, commas safe; bare `k:v` fallback), window title without
  Accessibility permission returns empty (not an error), empty Finder
  selection returns empty (not an error).
  **UNVERIFIED per app**: Chromium/Electron/terminal/game coverage,
  private-window title signals, address-bar element names — handled as
  `unsupported_app` skips. Elevated-window reads fail closed as
  `elevated_window`. See `docs/context-awareness.md`.

## Permissions (macOS TCC)

Desktop, Documents, Downloads, iCloud Drive and removable volumes trigger
system prompts. Denials surface as normal tool errors with the exact
System Settings pane to open (Settings has an Open Privacy Settings button).
Nexio never asks for Full Disk Access or Screen Recording. Accessibility
(on macOS, for text selection) and Automation for Finder/browsers (for file
selection and page URLs) are requested only when Context awareness needs
them: from an explicit user action or the first-use flow, per source, never
repeatedly, and every denial degrades to an explanatory chip state. Settings
> Context shows the status with [Open System Settings] links. See
`SECURITY.md` and `docs/context-awareness.md`.

## Existing installs

Stored settings, extensions and data keep working: the app reads an existing
data folder in place and never deletes or recreates directories to rename.
