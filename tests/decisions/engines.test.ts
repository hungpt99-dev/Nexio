import { describe, it, expect } from 'vitest';
import { NONE_OPTION, routeModePoint, dispatchCommandPoint, classifyIntentPoint, contextRoutePoint, toVerdict } from '../../src/main/decisions/points';
import { createRegistry, decide } from '../../src/main/decisions/registry';
import { MockEngine, StructuredModelEngine, OnDeviceEngine } from '../../src/main/decisions/engines';
import { systemOneDecide, systemOneTest, isLoopbackUrl } from '../../src/main/decisions/systemone';
import { sanitizeConfidence } from '../../src/main/decisions/types';

const CTX = { text: 'open my downloads folder', mode: 'do' as const, tools: [{ name: 'app_open', description: 'open' }] };

function wireFetch(answer: unknown, ok = true) {
  return async () => ({ ok, json: async () => answer }) as unknown as Response;
}

describe('points: every choice carries an abstain option', () => {
  it('all points include the none option', () => {
    for (const p of [routeModePoint(), dispatchCommandPoint(['a']), classifyIntentPoint(), contextRoutePoint()]) {
      const q = p.questions[0];
      expect(q.type).toBe('choice');
      if (q.type === 'choice') expect(Object.keys(q.options)).toContain(NONE_OPTION);
    }
  });
});

describe('toVerdict: thresholds gate act/confirm/fallthrough', () => {
  it('maps confidence onto act/confirm/fallthrough with abstention', () => {
    const t = { act: 0.85, confirm: 0.55 };
    expect(toVerdict('route_mode', 'do', 0.9, t)).toEqual({ verdict: 'act', choice: 'do' });
    expect(toVerdict('route_mode', 'do', 0.7, t).verdict).toBe('confirm');
    expect(toVerdict('route_mode', 'do', 0.4, t).verdict).toBe('fallthrough');
    expect(toVerdict('route_mode', NONE_OPTION, 0.99, t).verdict).toBe('fallthrough');
    expect(toVerdict('route_mode', undefined, 0.99, t).verdict).toBe('fallthrough');
    expect(toVerdict('route_mode', 'clarify', 0.7, t).verdict).toBe('fallthrough');
  });
});

describe('systemOne adapter: fail-closed on every anomaly', () => {
  const profile = { baseUrl: 'http://127.0.0.1:8000', model: 'laya', timeoutMs: 1000, thresholds: { act: 0.85, confirm: 0.55 } };
  it('maps a choice answer onto act', async () => {
    const r = await systemOneDecide(profile, routeModePoint(), CTX, {
      fetchFn: wireFetch({ answers: { route: { type: 'choice', choice: 'do', probabilities: { do: 0.9 }, confidence: 0.9 } } }),
    });
    expect(r.verdict).toBe('act');
    expect(r.choice).toBe('do');
  });
  it('unknown choice, http error, bad schema, non-loopback local -> fallthrough', async () => {
    const unknown = await systemOneDecide(profile, routeModePoint(), CTX, {
      fetchFn: wireFetch({ answers: { route: { type: 'choice', choice: 'rm_rf', probabilities: {}, confidence: 0.9 } } }),
    });
    expect(unknown.verdict).toBe('fallthrough');
    const httpErr = await systemOneDecide(profile, routeModePoint(), CTX, { fetchFn: wireFetch({}, false) });
    expect(httpErr.verdict).toBe('fallthrough');
    const badSchema = await systemOneDecide(profile, routeModePoint(), CTX, { fetchFn: wireFetch({ nope: 1 }) });
    expect(badSchema.verdict).toBe('fallthrough');
    const nonLoop = await systemOneDecide({ ...profile, baseUrl: 'https://evil.example.com' }, routeModePoint(), CTX, {
      fetchFn: wireFetch({ answers: {} }),
      localOnly: true,
    });
    expect(nonLoop.verdict).toBe('fallthrough');
    expect(isLoopbackUrl('http://127.0.0.1:8000')).toBe(true);
    expect(isLoopbackUrl('https://api.typesafe.ai')).toBe(false);
  });
  it('posts state+questions to /v1/systemone with instructions', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    await systemOneDecide(profile, routeModePoint(), CTX, {
      fetchFn: (async (u: unknown, init: unknown) => {
        url = String(u);
        body = JSON.parse(String((init as { body: string }).body)) as Record<string, unknown>;
        return { ok: true, json: async () => ({ answers: { route: { type: 'choice', choice: '__none__', probabilities: {}, confidence: 0.9 } } }) };
      }) as unknown as typeof fetch,
    });
    expect(url).toContain('/v1/systemone');
    expect(body).toHaveProperty('state');
    expect(body).toHaveProperty('questions');
    const q = (body['questions'] as Record<string, { instructions: string }>)['route'];
    expect(q.instructions.length).toBeGreaterThan(0);
  });
  it('test connection reports ok/fail without executing anything', async () => {
    const ok = await systemOneTest(profile, {
      fetchFn: wireFetch({ answers: { q: { type: 'choice', choice: 'test', probabilities: { test: 0.9 }, confidence: 0.9 } } }),
    });
    expect(ok.ok).toBe(true);
    const bad = await systemOneTest(profile, { fetchFn: wireFetch({}, false) });
    expect(bad.ok).toBe(false);
  });
});

describe('registry: order, capability filter, deterministic fallback', () => {
  it('first non-fallthrough wins; empty registry falls through', async () => {
    const reg = createRegistry([new MockEngine('a', null), new MockEngine('b', { choice: 'do', confidence: 0.95 })]);
    const r = await decide(reg, routeModePoint(), CTX);
    expect(r.engineId).toBe('b');
    expect(r.verdict).toBe('act');
    const empty = await decide(createRegistry([]), routeModePoint(), CTX);
    expect(empty.verdict).toBe('fallthrough');
  });
  it('engines without the capability are skipped', async () => {
    const reg = createRegistry([new MockEngine('narrow', { choice: 'do', confidence: 0.95 }, ['route'])]);
    const r = await decide(reg, classifyIntentPoint(), CTX);
    expect(r.verdict).toBe('fallthrough');
  });
  it('structured engine never returns out-of-scope values', async () => {
    const evil = new StructuredModelEngine('s', async () => ({ choice: 'rm_rf', confidence: 0.99 }));
    const r = await evil.decide(routeModePoint(), CTX);
    expect(r.verdict).toBe('fallthrough');
    const off = new StructuredModelEngine('off', null);
    expect(off.isAvailable()).toBe(false);
    expect((await off.decide(routeModePoint(), CTX)).verdict).toBe('fallthrough');
  });
  it('on-device abstention (null) falls through', async () => {
    const e = new OnDeviceEngine('needle', { classify: async () => null });
    expect((await e.decide(routeModePoint(), CTX)).verdict).toBe('fallthrough');
    const off = new OnDeviceEngine('off', null);
    expect(off.isAvailable()).toBe(false);
  });
  it('confidence is always finite in [0,1]', () => {
    expect(sanitizeConfidence(Number.NaN)).toBe(0);
    expect(sanitizeConfidence(2)).toBe(1);
    expect(sanitizeConfidence(-1)).toBe(0);
  });
});
