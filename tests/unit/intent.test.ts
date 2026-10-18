import { describe, it, expect } from 'vitest';
import { heuristicIntent, classifyIntent, clarifyQuestion } from '../../src/main/agent/intent';

describe('intent heuristic', () => {
  it('routes path-like mentions to act in any language', () => {
    expect(heuristicIntent('move report.pdf to Documents')).toBe('act');
    expect(heuristicIntent('mở file report.pdf giúp tôi')).toBe('act');
    expect(heuristicIntent('打开report.pdf文件')).toBe('act');
  });
  it('routes questions to answer in any script', () => {
    expect(heuristicIntent('What is the capital of Peru?')).toBe('answer');
    expect(heuristicIntent('Thủ đô của Pháp là gì?')).toBe('answer');
    expect(heuristicIntent('法国的首都是哪里？')).toBe('answer');
    expect(heuristicIntent('ما هي عاصمة فرنسا؟')).toBe('answer');
  });
  it('returns null when uncertain or for slash input', () => {
    expect(heuristicIntent('/summarize this')).toBeNull();
    expect(heuristicIntent('')).toBeNull();
    expect(heuristicIntent('hmm')).toBeNull();
    // English verbs alone never shortcut: the decision model decides by meaning.
    expect(heuristicIntent('find files I changed today')).toBeNull();
    expect(heuristicIntent('explain what a mutex is')).toBeNull();
    expect(heuristicIntent('calculate 18% tip on 64')).toBeNull();
  });
});

describe('intent decision-engine routing', () => {
  it('prefers heuristic, asks the engine only when uncertain', async () => {
    let calls = 0;
    const decideRoute = async (): Promise<'answer'> => { calls++; return 'answer'; };
    expect(await classifyIntent('What is the capital of Peru?', { decideRoute })).toBe('answer');
    expect(calls).toBe(0);
    expect(await classifyIntent('hmm', { decideRoute })).toBe('answer');
    expect(calls).toBe(1);
  });
  it('clarifies on abstention, unknown verdicts, or engine failure', async () => {
    expect(await classifyIntent('hmm', { decideRoute: async () => null })).toBe('clarify');
    expect(await classifyIntent('hmm', { decideRoute: async () => { throw new Error('down'); } })).toBe('clarify');
    expect(await classifyIntent('hmm')).toBe('clarify');
  });
  it('non-English requests reach the engine exactly once', async () => {
    const seen: string[] = [];
    const decideRoute = async (t: string): Promise<'act'> => { seen.push(t); return 'act'; };
    expect(await classifyIntent('abre mi archivo', { decideRoute })).toBe('act');
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('abre mi archivo');
  });
  it('asks one concise clarifying question', () => {
    const q = clarifyQuestion('do the thing with stuff');
    expect(q.length).toBeLessThan(220);
    expect(q).toMatch(/do it|just answer/i);
  });
});
