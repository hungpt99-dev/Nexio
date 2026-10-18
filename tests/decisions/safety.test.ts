import { describe, it, expect } from 'vitest';
import { reliabilityTable, expectedCalibrationError, fitThresholds, calibrationKey, calibrationFresh } from '../../src/main/decisions/calibration';
import { validateRule, matchingRules } from '../../src/main/decisions/rules';
import { hashInput, recordDecisionResult, decisionChip, ensureDecisionTables } from '../../src/main/decisions/audit';
import { guessLanguage, registryFor } from '../../src/main/decisions/wire';
import { registryFromSettings, decisionsEnabled } from '../../src/main/decisions/index';
import { openTestDb } from '../../src/main/db/db';

describe('calibration: ECE, thresholds, freshness', () => {
  const cases = [
    ...Array.from({ length: 80 }, () => ({ confidence: 0.95, correct: true })),
    ...Array.from({ length: 10 }, () => ({ confidence: 0.95, correct: false })),
    ...Array.from({ length: 10 }, () => ({ confidence: 0.6, correct: false })),
  ];
  it('reliability table has 10 bins; ECE in [0,1]', () => {
    expect(reliabilityTable(cases)).toHaveLength(10);
    const ece = expectedCalibrationError(cases);
    expect(ece).toBeGreaterThanOrEqual(0);
    expect(ece).toBeLessThanOrEqual(1);
  });
  it('fit keeps zero false-acts when possible', () => {
    const fit = fitThresholds(cases);
    expect(fit.falseActRate).toBe(0);
    expect(fit.thresholds.act).toBeGreaterThan(fit.thresholds.confirm);
  });
  it('model/version change invalidates stored thresholds', () => {
    const stored = { endpoint: 'e', model: 'm', version: 'v1', pointId: 'route_mode', thresholds: { act: 0.9, confirm: 0.5 }, falseActRate: 0, ece: 0.1, n: 10, fittedAt: 1 };
    expect(calibrationFresh(stored, 'e', 'm', 'v1')).toBe(true);
    expect(calibrationFresh(stored, 'e', 'm', 'v2')).toBe(false);
    expect(calibrationKey('e', 'm', 'v1', 'route_mode')).toContain('route_mode');
  });
});

describe('rules: validation never auto-approves', () => {
  it('rejects bad shapes; matches exact keys only', () => {
    expect(validateRule(null)).not.toHaveLength(0);
    expect(validateRule({ id: '', on: 'x', action: { type: 'run', command: 'x' }, enabled: true }).length).toBeGreaterThan(0);
    expect(validateRule({ id: 'r', on: 'classify_intent:remember', action: { type: 'run', command: '/memory' }, enabled: true })).toHaveLength(0);
    const rules = [{ id: 'r', on: 'classify_intent:remember', action: { type: 'run' as const, command: '/memory' }, enabled: true }];
    expect(matchingRules(rules, 'classify_intent:remember')).toHaveLength(1);
    expect(matchingRules(rules, 'classify_intent:forget')).toHaveLength(0);
  });
});

describe('audit: hashes only, chip has no text', () => {
  it('input hashed; round-trips through SQLite', () => {
    expect(hashInput('a')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashInput('a')).toBe(hashInput('a'));
    expect(hashInput('a')).not.toBe(hashInput('b'));
    const db = openTestDb();
    ensureDecisionTables(db);
    const id = recordDecisionResult(db, {
      point: 'route_mode',
      inputText: 'open my downloads folder',
      result: { verdict: 'act', choice: 'do', probabilities: { do: 0.9 }, confidence: 0.9, engineId: 'laya', model: 'laya', latencyMs: 33 },
    });
    const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row['inputHash']).not.toContain('downloads');
    expect(row['verdict']).toBe('act');
    expect(decisionChip({ verdict: 'act', probabilities: {}, confidence: 0.97, engineId: 'laya', model: 'laya', latencyMs: 33 }))
      .toMatch(/laya.*0\.97.*33ms/);
  });
});

describe('wire: settings gate + language guess', () => {
  it('disabled/empty config yields no registry (offline path)', () => {
    const db = openTestDb();
    expect(registryFor(db, { provider: 'openai', model: 'm', hotkey: 'h', mode: 'agent' })).toBeNull();
    expect(registryFromSettings({ order: [], endpoints: [], toolScope: [], rules: [] }, () => null)).toBeTruthy();
    expect(decisionsEnabled(undefined)).toBe(false);
    expect(decisionsEnabled({ order: [], endpoints: [], toolScope: [], rules: [] })).toBe(false);
  });
  it('language guess by script; und when unsure', () => {
    expect(guessLanguage('Mở thư mục')).toBe('vi');
    expect(guessLanguage('open folder')).toBe('en');
    expect(guessLanguage('打开文件')).toBe('zh');
    expect(guessLanguage('123 !!!')).toBe('und');
  });
});
