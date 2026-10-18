# Decision-model evaluation

Harness: `tests/decisions/golden.test.ts` over `tests/decisions/golden-*.jsonl`
(212 cases: 95 EN, 60 VI, 32 arg-resolution, 25 adversarial; VI total 69
including 9 no-diacritic date cases; adversarial expects never-`do`).

## Baseline: OLD code, offline behavior (run 2026-10-18, before deletion)

The old path was heuristic + up-to-3 sequential LLM text calls per send
(`classifyIntent` word-parse, `classifyMemoryIntent` JSON-extract,
`resolveContextIntent` NEEDS-regex). No provider key or budget was available
in this environment, so the live-LLM JSON path was **not executed** — the
baseline below is the old code's deterministic/offline behavior, which is
exactly what runs today when no provider key is set. LLM JSON accuracy,
latency and cost are therefore **not measured** (would need paid keys).

| Measure | Result | Notes |
|---|---|---|
| Heuristic route accuracy (`act`/`answer` vs 155 labeled) | 43/155 = 0.277 | Structural only (paths, `?` shape); everything else needed the model call |
| Memory fast-path recall (13 explicit remember/forget) | 4/13 | Phrased commands only; rest needed the model call |
| Arg resolution, fixed clock 2026-10-18 (32 EN+VI) | 32/32 | Deterministic code — no model needed, kept as-is |
| Tool retrieval recall@10 (68 tool-labeled) | 0.912 | BM25 + aliases; target 0.95 **missed** — lexical only, embeddings deferred |
| Adversarial routed to `act` by heuristic | 0/25 | Structural fast path never fires on injections |

Cost of the old path when keys ARE set (by code reading, not measured):
up to 3 sequential LLM RTTs per send (context + intent + memory) before the
real turn starts — this is what decision models collapse.

## Engines vs baseline

| Engine | Accuracy | False-act (adv) | Abstain | ECE | p50/p95 | Cost/decision | Status |
|---|---|---|---|---|---|---|---|
| Old LLM-writes-JSON | not measured | not measured (offline: 0/25) | n/a | n/a | not measured | not measured | live path needs keys; offline behavior above |
| TypeSafe Jev (cloud) | not measured | not measured | — | — | not measured | not measured | **not measured** — no key/endpoint in env |
| Laya English (`laya`) | not measured | not measured | — | — | not measured | — | **not measured** — no local server in env |
| Laya multilingual | not measured | not measured | — | — | not measured | — | **not measured** — no local server in env |
| laya-typed-decisions | not measured | not measured | — | — | not measured | — | **not measured** — checkpoint not obtainable here |
| Structured-LLM | not measured | 0 by construction (closed enum) | — | — | not measured | 1 small call | harness-ready, OFF by default |

No engine beats the baseline on a decision point with measured data, so per
the gate: **all decision-model engines ship OFF by default**, configured only
in Settings → Decisions. This is stated plainly, not as a roadmap euphemism.

Base-model honesty: an un-fine-tuned decision model may be near chance on
Nexio's tool set — thresholds MUST be fit per endpoint/model/version on this
golden set before any default is considered (`fitThresholds` + stored
`decision_calibrations` rows; `calibrationFresh` forces re-fit on change).

## What the engine path changes (verified in code, no endpoint needed)

- J1 (`agent/intent.ts` CLASSIFY_PROMPT + `parseIntentReply`) → `route_mode`
  point; prompt-and-parse deleted; no-engine → `clarify` (old offline path).
- J2 (`memory/classify.ts` CLASSIFY_PROMPT + `{…}` slice + `JSON.parse`) →
  `classify_intent` point; no-engine → null (old offline path).
- J3 (`context/prompt.ts` ROUTER_PROMPT + `parseRouterReply`) →
  `context_route` point; no-engine → empty (old offline path).
- J4 (`memory/extract.ts` suggestions) STAYS with the main model:
  open-ended generation, not a typed decision.
- Provider `JSON.parse(function.arguments)` is native tool calling with schema
  validation, not a decision — kept.

Fail-closed is unit-tested (`tests/decisions/engines.test.ts`): unknown
choice, HTTP error, schema violation, non-loopback local URL, engine throw,
abstention → `fallthrough`, and the turn proceeds exactly as if no engine
existed. Audit rows carry hashes/metadata only (`tests/decisions/safety.test.ts`).
