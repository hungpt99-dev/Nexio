# Port plan — reference ideas into Nexio

Source: read of Nexio at `/tmp/Nexio` (branch `feat/decision-engine` base `d3133f0`)
and desktop-assistant fork + upstream at `/tmp/desktop-assistant`.
Nexio comparisons are against CURRENT code, not the README.

Conventions: **Adopt** = take as-is (re-implemented in Nexio style);
**Adapt** = take the idea, reshape to Nexio's safety/architecture;
**Skip** = deliberately not taking; **Already better** = Nexio ahead, no action.

## 1. Process architecture

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| Single TurnManager owning turn lifecycle, phase events, AbortSignal everywhere | `src/main/turns/TurnManager.ts`, `turnEvents.ts` | `runAgent` in `src/main/agent/loop.ts` owns the loop; cancellation via `AbortSignal` already threaded through providers/tools/MCP; parallel work in `src/main/tasks/taskHost.ts` | Adapt: introduce `TurnManager` facade over `runAgent` + idempotent approval resolution + kill-switch in one place; keep loop logic | Med: one owner for kill switch + approvals | M | M: touch hot path |
| Service layer per domain (ConfigService, ConversationService…) | `src/main/services/*.ts` | Logic split across `src/main/ipc.ts` (3045 lines), `db/`, `store/` | Adapt: extract thin services behind interfaces gradually; NOT a big-bang move | Med: testability | L per slice | Low if sliced |
| LangGraph graphs (assistant/research) | `src/main/ai/graphs/` | Plain `runAgent` loop, no graph runtime | Skip: LangChain/LangGraph are banned heavy deps; loop + explicit state machine is enough | — | — | High if adopted |
| React renderer + launcher menu polish | `src/renderer/chat-react/` | Plain JS/CSS popup (`src/renderer/app.js`) | Skip (this run): renderer rewrite out of scope; take launcher polish notes only | Low now | High | Med |

## 2. Security hardening

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| contextIsolation on, nodeIntegration off | yes | `src/main/popup.ts:50-52` already `contextIsolation: true, nodeIntegration: false` | Already better | — | — | — |
| sandbox | varies | `sandbox: false` (preload needs relative require) — documented reason | Adapt (later): bundle preload so sandbox can turn on | Med | M | Med: preload rework |
| CSP + navigation guards (`will-navigate`, permission handlers) | present in window mgmt | No CSP meta in `src/renderer/index.html`; no `will-navigate` guard found | Adopt: add CSP + `setWindowOpenHandler`/deny navigations | High | S | Low |
| IPC validation per channel | typed handlers | `src/main/ipc.ts:360` hand-rolled `IpcSchema` guards + `arity`/`needStr`; no shared zod module | Adapt: one shared contract module with validator functions (no new zod dep — zero-runtime-deps rule wins) | Med | M | Low |
| Central redaction + typed errors | audit.ts, AppError-ish | `src/main/secrets/redact.ts` + `src/main/errors/app-error.ts`, log redaction in `agent/log.ts` | Already better: keep; extend redaction to decision audit | — | S | — |

## 3. Tool system

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| Tool registry with risk classes + grants + approval flow | `tools/registry.ts`, `tools/policy.ts`, `tools/catalog.ts` | `ALL_TOOLS` in `src/main/agent/tools/registry.ts:21`, `risk: read|write|destructive` per tool (`types.ts`), `decidePolicy` in `permissions.ts`, approval cards idempotent-ish in `loop.ts:executeToolCall` | Already better on policy depth (askSafe, granted-root confinement, write locks); Adapt: single `TurnManager`-owned approval resolution (idempotent by callId) | Med | M | Med |
| Destructive-call serialization | runner queue | Write locks serialize same-path writers (`loop.ts:326-337`); destructive tools park for approval | Already better | — | — | — |
| Granted-root confinement + shell guardrails (scrubbed env, timeout, caps) | net-guard, policy | `normalizeAndResolve` + allowed/protected roots (`permissions.ts`); shell 30 s timeout, 8k output cap (`shell_run.ts:46-51`); env scrubbing — WEAK (verify) | Adapt: scrub env in platform runner | High | S | Low |
| Tool schema guard (strict JSON-schema check before exposing to model) | `tool-schema-guard.ts` | `validateInput` per call; no startup guard | Adopt: startup guard rejecting bad tool schemas | Med | S | Low |

## 4. MCP

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| Namespaced `mcp__server__tool`, default state-changing, per-server/per-tool switches, allowlists, health, reconnect | `tools/mcp*.ts`, `mcp-direct.ts` | `src/main/extensions/mcp.ts` (528 lines): bridging as `mcp__server__tool`, risk mapping, per-tool policy (`mcpToolPolicy`), restart/stop/info | Already better or equal; Adapt: add periodic health checks + auto-reconnect with backoff | Med | M | Low |
| MCP output marked untrusted | yes | `untrusted: true` results feed `lastUntrusted` (`loop.ts:444`) | Already better | — | — | — |

## 5. Data layer and audit tables

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| Prisma + libsql, migrations | `prisma/` | `node:sqlite` zero-dep, `SCHEMA_VERSION=2` in `src/main/db/migrations.ts`, reset-on-mismatch guard | Already better for this app (ban on Prisma stands); keep | — | — | — |
| Audit tables (model calls, tool calls, decisions — hashes/metadata only) | `ai/audit.ts`, run stats | JSONL run logs (`agent/log.ts`, `runs.ts`); no SQL audit tables | Adopt: `decisions` + `model_calls` tables (metadata + hashes only, never content) in new `SCHEMA_VERSION=3` | High (transparency requirement) | S | Low (reset guard, no migration) |
| Repositories behind interfaces, prepared statements, one tx helper | DatabaseService | Direct `db.prepare` call sites across `db/`, `store/`, `memory/` | Adapt: introduce `Repository` interfaces + `withTransaction` helper; migrate call sites gradually | Med | M | Low |

## 6. AI provider layer

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| LangChain provider wrappers | `@langchain/*` deps | Hand-written per-provider adapters (`src/main/ai/providers/*/adapter.ts`) with capabilities, retry, normalized errors | Already better (zero heavy deps); keep | — | — | — |
| Provider setup wizard (validate key, add models, auto-detect Ollama) | `ai/providers/setup.ts` | Settings Test button probes unsaved values (`testing.ts`) but no stepped wizard, no Ollama auto-detect | Adopt (quick win): 3-step wizard reusing `testing.ts` probes + `http://localhost:11434` probe | High UX | M | Low |
| Native structured output / tool-calling with in-scope enum | tool calling via LangChain | Tool calling used for ACTING (`tools-chat.ts`), but every small DECISION is an LLM text call parsed by hand (see §10) | Adapt: `StructuredModelEngine` (OFF by default) reusing existing adapters, strict enum, zod-style hand validation | High (kills JSON-parse class) | M | Med |

## 7. Code organization

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| Layered modules + path aliases (`@shared/…`) | `tsc-alias`, `@shared`, `@main` | Flat `src/main/*` by concern; 3045-line `ipc.ts`; relative imports | Adapt: enforce one-way `domain -> application -> infrastructure -> interface` for NEW code (`src/main/decisions/` is the pilot) + import-boundary lint; split `ipc.ts` per domain gradually | High long-term | M (pilot S) | Med if big-bang (so slice it) |
| Ports/adapters, composition root, no singletons | partial (services) | Module singletons (`getDb()`, `extService(db)`); OS differences isolated in `platform/` (good) | Adapt: ports for providers/storage/tools/clock/scheduler/secrets/decisions; fakes in tests; composition root in `main.ts`/`ipc.ts` wiring | High testability | M | Med |
| Strict TS, no `any`, ~300-line modules | mixed | Strict-ish; `unknown` preferred in hot paths but `any` present; several >500-line files (`ipc.ts`, `mcp.ts`, `taskHost.ts`, `loop.ts` 699) | Adapt: `no-explicit-any` for new code; split on touch | Med | ongoing | Low |

## 8. Testing and quality gates

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| `npm run verify` (lint+typecheck+test+build), CI, gitleaks, tag releases + checksums | `verify` script exists | `typecheck`, `test` (vitest), `lint` (= tsc + i18n-check), `check:no-fakes`, e2e scripts; NO single `verify`, no gitleaks config, no CI verify found | Adopt: `npm run verify` (typecheck+lint+test+build), gitleaks config, CI workflow, tag-release checksum step in `docs/release.md` | High | S | Low |
| Eval harness for decisions (golden set, calibration, recall@10) | decide probes/limiter | None | Adopt: `tests/decisions/` golden JSONL (≥200) + harness + `docs/architecture/decisions.md` report | High (gate for defaults) | M | Low |

## 9. Docs / process

| Item | Reference | Nexio today | Verdict | Value | Effort | Risk |
|---|---|---|---|---|---|---|
| contracts/, ADRs, THIRD-PARTY-NOTICES | `contracts/`, THIRD-PARTY-NOTICES.md | `docs/adr/`, no THIRD-PARTY-NOTICES, no contracts dir | Adopt: add THIRD-PARTY-NOTICES.md (records: nothing copied wholesale this run), keep ADRs for decision-layer choices | Med | S | — |
| Decision-model docs (finetune guide, calibration report) | decide docs | None | Adopt: `decision-model-finetune.md` + `decisions.md` | High | S | — |

## 10. LLM-returns-JSON audit (Nexio CURRENT code)

| # | Location | Decision made | Input | Output shape | Freq | Latency/cost | Replacement |
|---|---|---|---|---|---|---|---|
| J1 | `src/main/agent/intent.ts:29-64` `classifyIntent` + `CLASSIFY_PROMPT` | Ask vs Do routing (`act`/`answer`/`clarify`) | User text ≤500 chars; heuristic first, one cheap model call when uncertain | Single word `ACT\|ANSWER\|CLARIFY`, regex-parsed (`parseIntentReply`), fail→`clarify` | Every non-explicit, non-slash send | +1 model RTT on uncertain inputs | `route_mode` decision point (choice: `do\|answer\|clarify\|none`) |
| J2 | `src/main/memory/classify.ts:140-201` `classifyMemoryIntent` | remember / forget / none + kind + pin + language | Current + last 2 user msgs (≤500 chars each) | JSON object extracted via `indexOf('{')…lastIndexOf('}')` + `JSON.parse`, fail→null | Every send (one-tap path) when memory on | +1 model RTT per send | `classify_intent` decision point (choice + closed boolean/score questions) |
| J3 | `src/main/context/prompt.ts:13-70` `resolveContextIntent` | Which on-screen context the request needs (`NEEDS:… DEICTIC:… [AMBIGUOUS:…]`) | Request ≤300 chars + metadata counts only (never contents) | One line, regex-parsed (`parseRouterReply`), fail→empty | Every send with context enabled | +1 model RTT per send | `context_route` decision point (choice multi? → one choice per source + deictic noul) |
| J4 | `src/main/memory/extract.ts:19-59` `extractCandidates` | 0–3 memory suggestion lines | Last 10 USER msgs ≤1000 chars | Free text lines (`"none"` or `\n` list), length/secret filtered | After runs (gated, ≥2 user msgs) | 1 streaming call, capped 3 lines | STAYS with main model (open-ended generation, not a typed decision) — documented |
| — | providers `*/adapter.ts` `JSON.parse(c.function.arguments…)` | Tool-call argument decode | Model's own function-call args | `try/catch → {}` | Per tool call | zero extra call | Not a decision; keep (native tool calling, fail-closed to `{}` → schema validation rejects) |

Worst case today: one user send = up to 3 sequential LLM calls (J3 + J1 + J2) before the real turn starts.
Decision models collapse J1–J3 into cheap typed calls (~30 ms local) or eliminate them.

## 11. UX / product quick wins (Step 5 scoped)

| Item | Reference | Nexio today | Verdict |
|---|---|---|---|
| Provider setup wizard | setup flow | Test button only | Adopt (this run, minimal) — renderer cost; if renderer touch grows, defer to phase 2 |
| Command hotkeys (global key runs a command as NORMAL turn) | `commandHotkeyRunner.ts` | Not present | Adapt: hotkey → normal send pipeline (all approvals) — needs globalShortcut slot; design in plan, implement if small |
| History export | export (run/export.ts) | `runs` channel lists; no export file | Adopt: JSON export reusing `exportMemories` pattern |
| Escape ladder + launcher polish | dialogGuard, launcherLayout | Esc chain exists; polish notes | Skip this run (UI-only, no tests per rules) unless trivial |
| Usage + audit view | run stats | Run log view exists | Adopt: surface `decisions` audit in existing log view (read-only) |
| MCP health + per-tool switches | health in services | `mcpToolPolicy` exists; no periodic health | Adopt: health check + reconnect (main-only, no UI) |
| Large items (desktop window, resumable turns, voice, scheduling, screen capture, document search) | present | Absent or partial | Deferred to later phases (see target-architecture.md) |

## License check (blocking note)

- Nexio is **MIT** (`LICENSE`); reference is **Apache-2.0**. Re-implementing ideas in Nexio's style = no license conflict. Wholesale copying would require keeping Apache-2.0 notices + `THIRD-PARTY-NOTICES.md` entry. **This run copies nothing wholesale** (verified by working from closed specs + fresh implementation); `THIRD-PARTY-NOTICES.md` records that fact.
- Do NOT copy the reference name, logo, branding — respected.
- Model/checkpoint licenses before bundling: Laya **Apache-2.0** (verified `github.com/NandhaKishorM/laya` LICENSE) — compatible, but **weights are NOT bundled in this run** (download on user action w/ checksum). TypeSafe Jev = closed cloud API (no bundling, key in safeStorage). Needle 3 = **Apache-2.0** (verified `huggingface.co/Cactus-Compute/needle3`) — adapter slot only, nothing bundled. Cloudflare CLEF "Jev-compatible" **could NOT be verified** (no search/fetch hit) — NOT claimed, NOT referenced as an option beyond "any System-One-compatible endpoint".

## Status after this run (2026-10-18, `feat/decision-engine`)

Done: Decision Engine subsystem (all of §10 J1–J3 replaced, J4 documented as
staying); `decisions` + `decision_calibrations` + `model_calls` audit tables
(`SCHEMA_VERSION` 3, reset guard intact); `nexio:decisions` channel (test box,
audit, key, endpoint test, calibration); golden set (212) + harness + eval
report (`docs/architecture/decisions.md`); finetune runbook
(`decision-model-finetune.md`); training export (`scripts/export-training.mjs`);
`npm run verify` (typecheck + boundaries + vitest + build + no-fakes);
import-boundary lint (decisions pilot); gitleaks config + CI step;
`THIRD-PARTY-NOTICES.md`; decision threat model in `SECURITY.md`; README /
CHANGELOG updated. Zero new runtime dependencies. All engines OFF by default
— no endpoint was reachable in this environment, so nothing is measured yet.

Deferred to P2/P3 (see `docs/architecture/target-architecture.md`): TurnManager
facade, `ipc.ts` split, repository interfaces, sandbox preload, CSP +
navigation guards, env scrubbing, tool-schema guard, provider wizard, command
hotkeys, history export, audit-in-log-view, MCP health/reconnect, Settings →
Decisions renderer page (IPC supports it; no UI built — pure UI, no tests per
rules), full Vietnamese renderer strings for the Decisions page.

## Scope and limitations (honest)

- The old LLM-JSON baseline's LIVE path was never executed (no keys/budget);
  the recorded baseline is offline behavior. Engine accuracy/latency/cost are
  "not measured" — the harness is ready, the endpoints were not.
- recall@10 is 0.912 < 0.95 target (lexical BM25 only; no embeddings backend).
- `StructuredModelEngine` has no provider-native constrained-decoding call
  wired (adapters lack that capability flag) — it is interface-ready only.
- The Laya sidecar manager spawns a `laya-serve` binary that is not installed
  here; start/stop/health logic is implemented but untested against a real
  server. Weights are deliberately not bundled or downloaded.
- Cloudflare CLEF "Jev-compatibility" is unverified and not offered.

## Reality + build status (2026-10-18, `feat/reality`)

Done: reality-check (`docs/product/reality-check.md`); capability registry +
probes + `check-claims` in verify; stubs removed/wired (`theme`,
`memorySemantic` deleted with legacy cleanup, `modeHotkey` wired + Settings
field, SkipReason mappings complete, `/clip` raw-state fix); screenshot
built for real (desktopCapturer, explicit only, `/screen`, panel, probes,
audit); scheduler built for real (SQLite jobs, cron subset, TZ/DST-safe,
`/schedule` + Settings UI, Ask/Do scope, approvals + kill switch intact).
Not built (no UI/settings/docs claims anywhere — nothing to remove):
voice input, resumable turns, local document search, desktop window.
Zero new dependencies (cron subset and probes use Intl/Electron built-ins).
