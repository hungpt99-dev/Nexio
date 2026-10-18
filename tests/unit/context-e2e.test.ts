import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginSnapshot, __resetContextStoreForTests } from '../../src/main/context/store';
import { applyAutoAttach } from '../../src/main/context/manager';
import { logContextUse, resolveContextForSend } from '../../src/main/context/service';
import { runAgent } from '../../src/main/agent/loop';
import type { AgentEvent, Tool } from '../../src/main/agent/types';

const APP = { name: 'Notepad', windowTitle: 'n', isBrowser: false };
const settings = (over: Record<string, unknown> = {}) =>
  ({ provider: 'openai', model: 'm', hotkey: '', mode: 'chat', ...over }) as never;

function toolTurn(calls: Array<{ id: string; name: string; input: unknown }>, text = ''): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } }],
  }), { status: 200 });
}
function finalTurn(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}
function scriptFetch(script: Response[]): typeof fetch {
  let i = 0;
  return (async () => script[Math.min(i++, script.length - 1)]) as unknown as typeof fetch;
}
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-e2e-'));

beforeEach(() => __resetContextStoreForTests());

describe('E2E (fake collectors + fake provider, no keys)', () => {
  it('select text + "translate this" -> provider request carries the text in <user_context>', async () => {
    const snap = beginSnapshot(APP, null);
    snap.selection = { kind: 'text', text: 'Bonjour le monde', truncated: false, length: 16 };
    snap.states.selection = 'available';
    snap.sources.push('selection');
    const res = await resolveContextForSend(settings({}), 'translate this', {
      decideContext: async () => ({ needsContext: ['selection'], deictic: true }),
    });
    expect(res.action).toBe('proceed');
    expect(res.attached).toEqual(['selection']);
    expect(res.block).toContain('<user_context>');
    expect(res.block).toContain('Bonjour le monde');
    expect(res.block).toContain('untrusted data');
  });
  it('select 3 files + "move these to Invoices" -> block lists exact paths; approval shows them', async () => {
    const dir = tmpRoot();
    const snap = beginSnapshot(APP, null);
    snap.files = [0, 1, 2].map((i) => ({ id: `${dir}/a${i}.txt`, displayName: `a${i}.txt`, absolutePath: `${dir}/a${i}.txt`, kind: 'file' as const }));
    snap.filesTotal = 3;
    snap.states.files = 'available';
    snap.sources.push('files');
    const res = await resolveContextForSend(settings({}), 'move these to Invoices', {
      decideContext: async () => ({ needsContext: ['files'], deictic: true }),
    });
    expect(res.action).toBe('proceed');
    expect(res.block).toContain('a0.txt');
    expect(res.block).toContain(`${dir}/a2.txt`);
    // Do-mode run with attached files: write approval carries the source.
    const events: AgentEvent[] = [];
    let approved: unknown = null;
    const moveTool: Tool = {
      name: 'fs_move', description: 'x',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      risk: 'write', askSafe: false, describe: (i) => `Move ${(i as Record<string, string>).from}`,
      run: async () => ({ ok: true, output: 'moved' }),
    };
    await runAgent('move these to Invoices', {
      provider: 'openai', apiKey: 'k', model: 'm', cwd: dir, history: [],
      allowedRoots: [dir], mode: 'do', tools: [moveTool],
      contextAttached: ['files'],
      fetchFn: scriptFetch([
        toolTurn([{ id: 'c1', name: 'fs_move', input: { from: `${dir}/a0.txt`, to: `${dir}/Invoices/a0.txt` } }]),
        finalTurn('done'),
      ]),
      logDir: tmpRoot(), emit: (e) => events.push(e),
      waitForApproval: async (call) => { approved = call; return { decision: 'deny' }; },
    });
    expect(approved).toMatchObject({ afterUntrusted: 'files' });
  });
  it('selection + files both present -> one-tap choice, no guessing', async () => {
    const snap = beginSnapshot(APP, null);
    snap.selection = { kind: 'text', text: 'x', truncated: false, length: 1 };
    snap.states.selection = 'available';
    snap.sources.push('selection');
    snap.files = [{ id: '/t/f.txt', displayName: 'f.txt', absolutePath: '/t/f.txt', kind: 'file' }];
    snap.filesTotal = 1;
    snap.states.files = 'available';
    snap.sources.push('files');
    const res = await resolveContextForSend(settings({ contextAutoAttach: 'ask' }), 'summarize this', {
      decideContext: async () => ({ needsContext: ['selection', 'files'], deictic: true, ambiguity: ['selection', 'files'] }),
    });
    expect(res.action).toBe('choice');
    expect(res.choiceOptions).toEqual(['selection', 'files']);
    expect(res.block).toBeUndefined();
  });
  it('nothing selected + deictic -> honest message path (empty)', async () => {
    beginSnapshot(APP, null);
    const res = await resolveContextForSend(settings({}), "what is this file?", {
      decideContext: async () => ({ needsContext: ['selection'], deictic: true }),
    });
    expect(res.action).toBe('empty');
  });
  it('logs contain metadata only: no content, no full paths', async () => {
    const dir = tmpRoot();
    const snap = beginSnapshot(APP, null);
    snap.selection = { kind: 'text', text: 'SUPERSECRET selection body', truncated: false, length: 10 };
    snap.states.selection = 'available';
    snap.sources.push('selection');
    snap.attached.add('selection');
    snap.files = [{ id: `${dir}/secret.txt`, displayName: 'secret.txt', absolutePath: `${dir}/secret.txt`, kind: 'file' }];
    snap.filesTotal = 1;
    snap.states.files = 'available';
    snap.sources.push('files');
    snap.attached.add('files');
    logContextUse('run-1', snap, ['selection', 'files'], false, 'send', dir);
    const content = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(content).not.toContain('SUPERSECRET');
    expect(content).not.toContain(`${dir}/secret.txt`);
    expect(content).toContain('selection');
    expect(content).toContain('sources');
  });
});
