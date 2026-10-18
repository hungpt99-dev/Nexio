# Target architecture

## Layering (one-way dependencies)

```
domain (pure logic, no I/O)
  └─ application (turn manager, tool policy, decision router, use cases)
       └─ infrastructure (providers, SQLite repos, OS tools, MCP clients, decision-model clients)
            └─ interface (Electron main wiring, preload, renderer)
```

Rules:

- Imports point inward only. `domain/` never imports `application/`, `infrastructure/`
  or `interface/`. Enforced by `scripts/check-boundaries.mjs` (runs in `npm run verify`).
- Ports (interfaces) live in `domain/` or `application/`; adapters live in
  `infrastructure/`. Composition root (`src/main/main.ts` + `registerIpc` wiring)
  constructs adapters and injects them. No hidden singletons in new code
  (legacy `getDb()` etc. migrate on touch).
- `src/main/decisions/` is the pilot of this layering and MUST stay clean.

## Decision records

### DR-1: Decision models for typed NL decisions, never LLM-writes-JSON

What: `route_mode`, `dispatch_command`, `classify_intent`, `context_route` are
`DecisionPoint`s answered by decision-model engines via `POST /v1/systemone`
(choice/score/noul questions, each with an explicit `none` option).
Why: collapses up to 3 sequential LLM RTTs per send into ~30 ms typed calls;
probabilities are calibrated and auditable; no text to parse.
Rejected: keep prompt-and-parse (brittle, slow, uncalibrated); regex/keyword
intent rules for NL (banned by principle — only exact slash syntax, aliases,
safety policy may be deterministic); LangChain-based routing (heavy dep).

### DR-2: One System One HTTP adapter, no vendor SDK

What: a single `fetch`-based adapter speaks `POST {base}/v1/systemone`
`{state, questions}` (verified against `pydantic.dev/docs/ai/models/system-one/`).
Jev (cloud), Laya `laya[serve]` (local 127.0.0.1), and any compatible endpoint
(incl. Ollama decision models, verified docs) are endpoint profiles, not code forks.
Why: Nexio has zero runtime deps; `@typesafe-ai/sdk` would add a dep + a second
wire client for the same API. Profiles differ only in URL/key/model/thresholds.
Rejected: per-vendor SDK clients; guessing field names (we read the spec first).

### DR-3: Decisions are proposals; safety policy is code, not model output

What: engine output maps to `act | confirm | fallthrough`. `act` still passes
tool validation, path confinement, risk policy, approval cards. Models may only
raise caution (e.g. force `confirm`), never lower it. Fail-closed everywhere.
Why: preserves Nexio's safety model verbatim; a wrong model can at worst add
friction, never cause a side effect.

### DR-4: Arguments resolved by code + catalog, never extracted by models

What: decision models pick closed choices only. Dates/times come from the
system clock + timezone (EN+VI relative expressions in code); folders from the
OS; files/tools matched against the live catalog + granted roots (BM25
shortlist → model chooses within it). Unresolvable → fall through with the
shortlist attached, or ask the user. Never invent values.
Why: models choose, they do not extract free-form values (verified against
Laya/SystemOne docs: typed choice/score/yes-no only).

### DR-5: Two-stage tool retrieval; shortlist narrows, never enables

What: BM25 (+aliases) over tool names/descriptions/arg names shortlists 5–15
candidates; the decision model chooses within. Empty/low-confidence → full
enabled set. Disabled tools and risk classes are invisible to the engine.
Why: keeps question sets within model option limits (e.g. Ollama ≤26) and cuts
tokens; recall@10 target ≥95% measured on the golden set.

### DR-6: Per-endpoint calibration, OFF by default

What: thresholds fit per (endpoint, model, version) on the golden set; stored
with model name+version; re-calibration required on change. All engines OFF
until configured in Settings (privacy: typed user text leaves the machine for
cloud endpoints; loopback-only for local). If none configured, NL goes to the
normal chat turn with the main model's own tool calling.
Why: probabilities are not trustworthy by default; base-model accuracy may be
near chance on our tool set — reported honestly in `decisions.md`.

### DR-7: No migrations, no new runtime deps, small modules

What: `SCHEMA_VERSION` 2→3 with the existing reset-when-different guard; zero
new `dependencies`; new modules ~≤300 lines; `any` banned in new code.
Why: hard rules + unreleased status make this the cheapest correct path.

## Later phases (deferred, not this run)

- P2: split `ipc.ts` per domain; `TurnManager` facade over `runAgent`;
  repository interfaces + `withTransaction`; preload bundling → `sandbox: true`;
  CSP + navigation guards; env scrubbing in shell runner; tool-schema startup guard.
- P3: provider setup wizard; command hotkeys as normal turns; history export;
  decisions audit surfaced in log view; MCP health/reconnect.
- P4 (large): desktop window, resumable turns, voice I/O, scheduling, screen
  capture, document search — only if a later audit shows one half-built.
