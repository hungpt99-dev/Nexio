# Features (checked against the capability registry)

Source of truth: `src/main/capabilities/registry.ts` (`scripts/check-claims.mjs`
fails if a shipped feature is missing here). Statuses: stable (probe +
handler wired) · experimental (works, rough edges) · not built (no code,
no UI, no claims).

## Context (hotkey snapshot, chips, explicit attach)

- `context-selection` — Selected text — stable. macOS reads the
  Accessibility tree via System Events/osascript; Windows reads
  UIAutomation text patterns. Both are read-only: no keystroke injection,
  no clipboard overwrite (the Ctrl/Cmd+C fallback stays opt-in off).
- `context-files` — Selected files — stable (Finder/Explorer readers).
- `context-folder` — Open folder — stable.
- `context-clipboard` — Clipboard — stable (attached only when you include
  it; concealed password-manager content is skipped).
- `context-page` — Browser page — stable.
- `context-screenshot` — Screenshot — stable. Explicit capture only
  (`/screen`, the Capture button, `context-capture`): active window or the
  display under the cursor; popup hides during capture; deny-listed apps
  refuse; thumbnail chip with preview + remove before sending; sent through
  the native image pipeline (EXIF strip, size cap) to vision models, with a
  switch-model notice otherwise. macOS needs Screen Recording permission
  (the UI links the exact Settings pane). Bytes live in the snapshot only.
  Per-conversation **auto-capture** (off by default, toggle in the context
  tray): when a turn would otherwise stall asking for context, the active
  window is captured and attached automatically. Probe/capture refusal keeps
  the ask-first flow. No capture in incognito; opt-in pruned on delete.

## Decisions

- Decision Engine (route/dispatch/memory/context typed decisions) —
  experimental, OFF by default. See `docs/architecture/decisions.md`.

## Tasks & scheduling

- Parallel tasks, queue, subtasks, approvals, Undo — stable.
- `scheduler` — Scheduled jobs — experimental. Interval/daily/weekdays/cron
  (5-field subset, no dependency), timezone/DST-safe wall-clock matching,
  `/schedule` + Settings UI (create, pause, resume, run-now, delete), Ask or
  Do scope per job, missed-run policy (run-once/skip). Each fire is a normal
  turn in its own conversation: Do approvals park + notify and wait (never
  auto-approved, kill switch applies). Jobs run only while Nexio is running;
  use start-at-login + tray residency to keep it alive.

## Memory, attachments, providers, web

- Long-term memory (off by default), incognito, attachments pipeline
  (native images/PDFs), BYOK providers incl. local Ollama, zero-config web
  search with per-backend consent — stable. See `docs/configuration.md`.

## Not built (no UI, no settings, no claims anywhere)

- `doc-search` — local document search.
- `resumable-turns` — checkpoint/resume across restarts (today a restart
  marks runs interrupted; destructive actions always need fresh approval).
- `desktop-window` — second window with history search + trace inspector.
- `voice-input` — microphone input (probe exists; no capture UI is shown).
