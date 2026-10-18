# Reality check — every claimed feature vs what actually runs

Method: repo-wide grep for TODO/stub/placeholder/mock/skipped:/fake, per-key
Settings read-check, per-channel IPC handler+caller check, renderer→preload
wiring check (subagent audit 2026-10-18), plus direct reads of the slash
registry, context panel, and locale files. The app GUI was not driven for
every command (noted per row); main-process paths were read, not executed.

Legend: Working (real handler, exercised or read end-to-end) · Partial
(handler exists, gap noted) · Stub (UI/setting/doc claims work that doesn't
happen) · Missing (no code at all).

## The screenshot row (reported first, per brief)

| Feature | Claimed where | Status | Evidence | Action |
|---|---|---|---|---|
| Screenshot context source | Type union `shared/types.ts:195`, states `context/store.ts:24` | **Stub** | `store.ts:24` hardcodes `skipped:no_screen_context`; nothing ever writes another state; `service.ts:74` filters it out of `avail`; zero `desktopCapturer` hits in `src/main` | **Build** (Phase A) |

## Settings that don't act

| Feature | Claimed where | Status | Evidence | Action |
|---|---|---|---|---|
| `theme` (light/dark) | `Settings` type + defaults/validation | **Stub** | Zero reads outside `store/settings.ts`; renderer hardcodes `dataset.theme='dark'` (`app.js:1345,1552`) | **Remove** setting key from type/defaults/validation (dark-only is honest; no UI control exists to remove) |
| `modeHotkey` (Alt+M) | Settings | **Stub** | Zero reads anywhere; `app.js:1102` hardcodes Alt+M | **Build**: wire as configurable, or remove key. (Decided: wire — small, real) |
| `memorySemantic` toggle | Settings UI (`set-mem-semantic`, `app.js:1315,1371`) | **Stub** | No engine; retrieval is FTS-only, admitted in `types.ts:113` | **Remove** toggle from Settings UI; keep FTS; docs honest |
| `onboarded`, `*NoticeDismissed`, `compactSpacing`, `suggestions`, `taskConfirmOnSubmit`, `taskResume` | Settings UI flows | Working | Honored in renderer (onboarding, dismissals, `applySpaceScale`, submit dialog) | Keep |
| All other Settings keys | Settings UI | Working | ≥1 behavioral read in main (spot-checked) | Keep |

## Slash commands (registry `src/main/slash/registry.ts:10-31` + renderer handlers)

| Command | Status | Evidence | Action |
|---|---|---|---|
| /help /new /clear /model /history /settings /log /extensions /memory /remember /forget /incognito /spawn /queue /tasks /pin /search /context /clip /sel /cancel /clear-queue | Working | Renderer handlers read (`app.js:895-960`ff); registry entries resolve | Keep; no test drive in this env (GUI), marked not-run |
| Prompt templates (/translate…), workflows (/email-reply…), skill/MCP commands | Working | Registry + `db/templates.ts`, palette paths read | Keep |

## Context sources (`src/main/context/`)

| Source | Status | Evidence | Action |
|---|---|---|---|
| selection / files / folder / clipboard / page | Working | Collectors + manager + attach flows read; states machine real | Keep; add probes (Phase A) |
| screenshot | Stub | See top row | **Build** (Phase A) |
| Raw internal codes in UI | Partial | `ctxDescribeState` maps known reasons, but unknown `skipped:<x>` falls back to `t('context.stateSkipped',{reason})`; `/clip` failure path renders raw `states.clipboard` (`app.js:923`) | **Fix**: human-readable mapping for every SkipReason + never render raw codes |

## IPC surface (all channels have a main handler — `ipc-contract.test.ts` enforces)

Dead-but-harmless (handler exists, renderer never calls; not user-visible):
`chatCancel`, `decisions`, `setHotkey`, `webFetch`, `contextRoute`,
`defaultFolders`, `attachProcess`, `attachClassify`, `deleteConversation`,
`listTemplates`, `listWorkflows`, `agentRun`. By-design unbridged: `chat`,
`upsertTemplate` (`preload.ts:23-25`). No conversation-delete control exists
in History UI (`app.js:1517-1560`).
Action: keep handlers (public API surface, tested); wire `decisions` to the
new Decisions settings section instead of leaving it callee-less; do NOT
claim delete-conversation in UI.

## Deferred phases (reference has them, Nexio doesn't — no UI claims today)

| Feature | Status | Evidence | Action |
|---|---|---|---|
| Scheduled tasks | Missing | No scheduler, no jobs table, no /schedule | **Build** (Phase B) |
| Voice input | Missing | No mic capture, no STT | **Build** (Phase C) if run allows; else Not built, no claims |
| Resumable turns | Missing | No checkpoints; kill switch just aborts | **Build** (Phase D) or Not built |
| Local document search | Missing | No index, no /search-local | **Build** (Phase E) or Not built |
| Desktop window | Missing | Single popup only | **Build** (Phase F) or Not built |

(`docs/` makes no claims about the five above — verified by grep for
schedule/voice/resume/"document search"/"desktop window" claims; only
roadmap mentions in port-plan/target-architecture, which is honest.)

## Test hygiene

No test mocks `src/main/*` internals (all `vi.mock` targets are
electron/fetch/OS seams). `MockEngine` is a test collaborator, never
production. `web_search` tool's UNAVAILABLE return is a defensive guard
(the loop filters the tool first), not a user-facing fake. `tray.ts:34`
TODO is comment-only (fallback implemented).
