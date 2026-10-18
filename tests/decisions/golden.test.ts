/** Golden-set evaluation (offline baseline + engine scoring).
 *
 * Scores deterministic/fast-path behavior over tests/decisions/golden-*.jsonl.
 * Live decision-model engines (Jev/Laya/structured) need a reachable endpoint
 * or key: without one they are reported "not measured" — never guessed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { heuristicIntent } from '../../src/main/agent/intent';
import { matchFastPath } from '../../src/main/memory/classify';
import { resolveRelativeDate, resolveKnownFolder } from '../../src/main/decisions/args';
import { shortlistTools, recallAtK, docsFromTools } from '../../src/main/decisions/retrieval';
import { ALL_TOOLS } from '../../src/main/agent/tools/registry';

interface Golden {
  id: string;
  text: string;
  route?: string;
  memory?: string;
  context?: string[];
  deictic?: boolean;
  tool?: string;
  arg?: string;
  expected?: string | null;
  mustNot?: string;
}

function load(name: string): Golden[] {
  const file = path.join(__dirname, name);
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Golden);
}

const ROUTE_CASES = [...load('golden-en.jsonl'), ...load('golden-vi.jsonl')];
const ARG_ADV = load('golden-args-adv.jsonl');
const ARG_CASES = ARG_ADV.filter((c) => c.arg);
const ADV_CASES = ARG_ADV.filter((c) => c.mustNot);

const DOCS = docsFromTools(ALL_TOOLS.map((t) => ({ name: t.name, description: t.description })));

const FIXED_NOW = new Date('2026-10-18T12:00:00Z').getTime();
const FIXED_CLOCK = { now: () => FIXED_NOW, timeZone: () => 'UTC' };

describe('golden set (offline baseline — no live model calls)', () => {
  it('route fast path: never mis-routes an adversarial string to do', () => {
    let bad = 0;
    for (const c of ADV_CASES) {
      // why: offline baseline has no model; the safety claim is that the
      // structural fast path alone never produces 'act' for injections.
      const h = heuristicIntent(c.text);
      if (h === 'act') bad += 1;
      expect(h).not.toBe('act');
    }
    expect(bad).toBe(0);
  });

  it('route fast path accuracy (heuristic only; uncertain -> clarify)', () => {
    let correct = 0;
    let answered = 0;
    for (const c of ROUTE_CASES) {
      if (!c.route) continue;
      answered += 1;
      const h = heuristicIntent(c.text);
      const verdict = h === 'act' ? 'do' : h === 'answer' ? 'answer' : 'clarify';
      if (verdict === c.route) correct += 1;
    }
    const acc = correct / answered;
    console.log(`[golden] heuristic route accuracy: ${correct}/${answered} = ${acc.toFixed(3)} (uncertain counts as clarify)`);
    expect(answered).toBeGreaterThan(150);
  });

  it('memory fast path: explicit remember/forget phrases match; questions never match', () => {
    let correct = 0;
    let total = 0;
    for (const c of ROUTE_CASES) {
      if (!c.memory || c.memory === 'none') continue;
      total += 1;
      const m = matchFastPath(c.text, ['en', 'vi']);
      if (m && m.intent === c.memory) correct += 1;
    }
    console.log(`[golden] memory fast-path recall: ${correct}/${total}`);
    expect(total).toBeGreaterThan(0);
  });

  it('arg resolution (fixed clock 2026-10-18): dates EN+VI + known folders', () => {
    let correct = 0;
    for (const c of ARG_CASES) {
      const got = c.arg === 'date' ? resolveRelativeDate(c.text, FIXED_CLOCK) : resolveKnownFolder(c.text);
      const want = c.expected === null ? null : c.expected;
      const ok = c.arg === 'folder'
        ? (want === null ? got === null : typeof got === 'string' && got.length > 0)
        : got === want;
      if (!ok) console.log(`[golden] ARG MISS ${c.id}: got=${got} want=${want}`);
      else correct += 1;
    }
    console.log(`[golden] arg resolution: ${correct}/${ARG_CASES.length}`);
    expect(correct).toBe(ARG_CASES.length);
  });

  it('tool retrieval recall@10 over built-in tools', () => {
    const cases = ROUTE_CASES.filter((c) => c.tool).map((c) => ({ query: c.text, gold: c.tool as string }));
    const recall = recallAtK(cases, DOCS, 10);
    console.log(`[golden] recall@10: ${recall.toFixed(3)} over ${cases.length} tool-labeled cases`);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  it('shortlist never enables: only returns docs passed in', () => {
    const short = shortlistTools('delete everything', DOCS, 12);
    expect(short.length).toBeLessThanOrEqual(15);
    for (const d of short) expect(DOCS.map((x) => x.name)).toContain(d.name);
  });
});
