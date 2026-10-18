# ADR 0009: One ContextSnapshot in memory (main process)

## Status

Accepted.

## Context

Short deictic requests ("summarize this", "move these to Invoices") need
what the user was pointing at. The alternatives — always-on monitoring, a
resident helper, or pasting content into every prompt — violate the privacy
model (capture only on the user's hotkey, visible, never in the background).

## Decision

- ONE `ContextSnapshot` object, main process, in memory only: 60 s expiry,
  deleted on hide/Incognito/quit, re-captured on every show by hotkey.
- Collectors live in `src/main/context/` behind new `PlatformAdapter`
  methods (`getActiveWindow`, `readSelection`, `readSelectedFiles`,
  `readBrowserPage`); OS differences stay in `platform/` per AGENTS.md.
  Scripting first (PowerShell/UIA/Shell-COM on Windows, osascript/AX/JXA on
  macOS); a `ContextProvider`-shaped adapter surface lets a native helper
  replace the scripts later.
- The popup shows inactive-first so the foreground query still sees the
  external app; collectors run async against the recorded handle/pid.
- Tasks copy the snapshot AT CREATION (frozen, capped); background tasks
  never capture; expired snapshots are never refreshed silently.

## Consequences

- Hotkey-to-show gains one fast OS query (record window, then show);
  collectors fill chips after. Measured per-source timings go to the run
  log (metadata only).
- Per-app reliability varies (Chromium/Electron/terminals/games, elevated
  windows, private windows) — recorded as typed skip reasons and in
  `docs/platforms.md` as UNVERIFIED, never as errors.
