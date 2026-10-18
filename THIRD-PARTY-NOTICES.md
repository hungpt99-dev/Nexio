# Third-party notices

Nexio is MIT-licensed (see `LICENSE`). This file records third-party code,
models and ideas reused in the repo, as required by their licenses.

## This run (Decision Engine, `feat/decision-engine`)

No third-party code was copied wholesale. The Decision Engine subsystem
(`src/main/decisions/`) is a fresh implementation in Nexio's style, written
against public API specifications (linked below), not against any third
party's source. Ideas re-implemented (decision points, typed questions with
abstain options, registry + deterministic fallback, tool shortlists,
per-endpoint calibration) are concepts, and no Apache-2.0 notice is owed
for them.

Specifications and projects consulted (read-only; nothing vendored):

- System One API — `https://pydantic.dev/docs/ai/models/system-one/`
  (request/response shape for `POST /v1/systemone`).
- Laya (Apache-2.0) — `https://github.com/NandhaKishorM/laya`
  (local decision-model server, checkpoints; weights NOT bundled).
- TypeSafe Jev (closed cloud API) — key stays in safeStorage; no SDK vendored.
- Needle 3 by Cactus Compute (Apache-2.0) —
  `https://huggingface.co/Cactus-Compute/needle3` (adapter slot only,
  interface + mock; no weights, no runtime vendored).
- Reference project desktop-assistant (Apache-2.0, Ilias Chatzopoulos /
  fork): ideas re-implemented in Nexio's style (see
  `docs/product/port-plan.md`). No code copied; no notice required. If any
  non-trivial snippet is ever taken verbatim in the future, its Apache-2.0
  notice MUST be added here. Nexio's MIT license is compatible with
  incorporating Apache-2.0 code under these terms (Apache-2.0 §4 preserved
  notices + state changes).

Cloudflare CLEF as a "Jev-compatible" endpoint could NOT be verified to
exist — it is not referenced as an option anywhere in code or docs.
