# Fine-tuning a local decision model on Nexio's tool set

Goal: lift a local model (e.g. Laya `typed-decisions` starting point,
Apache-2.0 — weights NOT bundled, see below) from zero-shot to reliable on
Nexio's four decision points. Nothing is trained in the Nexio repo run;
this is the runbook for doing it separately.

## Export training data

```
node scripts/export-training.mjs   # tests/decisions/golden-*.jsonl -> tests/decisions/training.jsonl
```

Each line: `{ "state": "<user text>", "questions": { …typed questions… },
"answers": { "<qid>": {"choice"|"noul"|"score"…} } }` using the same question
sets as `src/main/decisions/points.ts`. Labels come from the golden set's
`route`/`memory`/`context` fields (`none` options are real labels — abstention
is trained, not filtered out).

## Data size guidance

- Minimum viable: ~500–1,000 labeled decisions per point (golden 212 is the
  seed, not the training set). Grow by logging `decisions` audit rows
  (hashes only) + human-labeling the inputs users consent to share — raw text
  NEVER leaves the machine unless the user enables the debug option.
- Keep the mix: ≥30% Vietnamese (with/without diacritics, mixed VI/EN),
  ≥15% argument-resolution contexts, ≥10% adversarial/injection (all labeled
  abstain / never-`do`).
- Class balance per choice option within 2:1; the `__none__` option needs as
  many examples as the largest real option or the model never abstains.

## Loop (Laya example; adapt to your trainer)

1. Start from the `typed-decisions` checkpoint family (best zero-shot on
   choice/score/noul shapes), not from base BERT — see the Laya fine-tuning
   notebook (`notebooks/laya_finetune_typed_decisions_*`) for the RLCD +
   temperature-calibration loop.
2. Train with a strictly proper scoring rule (RLCD in Laya's recipe) so the
   emitted probabilities stay calibrated — accuracy without calibration fails
   the `fitThresholds` zero-false-act gate.
3. Evaluate on a HELD-OUT split of the golden set (never train on all 212),
   report accuracy / false-act / abstain / ECE / p50-p95 into
   `docs/architecture/decisions.md`, and store thresholds with model
   name + version via the `decision_calibrations` table.
4. Re-fit thresholds whenever the checkpoint or its version changes
   (`calibrationFresh` enforces this at runtime).

## Risks

- Overfitting to Nexio's current tool names: re-train or re-fit when tools
  change (retrieval shortlist changes the option set the model sees).
- Calibration drift across languages: fit per-language slices, not just
  global ECE — VI-no-diacritics is the known weak slice (see baseline).
- Adversarial regression: the 25 injection strings must stay zero-false-act
  on every release; add new ones from real attempts.
- License: Laya code + checkpoints are Apache-2.0 (compatible, keep notices);
  user-fine-tuned weights inherit the base checkpoint's license terms — show
  the license in the download UI and verify the checksum before loading.
  Download ONLY on explicit user action; never bundle weights with the app.

## What "good enough for default" means

The gate in `docs/architecture/decisions.md`: zero false-act on adversarial,
clearly beats the old baseline on its decision point, ECE low enough that the
act threshold holds on held-out data. Until then: OFF by default.
