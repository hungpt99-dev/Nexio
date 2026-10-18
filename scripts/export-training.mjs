// Export the golden set as JSONL training data for decision-model fine-tuning.
// Reads tests/decisions/golden-*.jsonl, writes tests/decisions/training.jsonl:
// { state, questions, answers } using the same shapes as src/main/decisions/points.ts.
// Abstain labels are kept (the __none__ option is trained, not filtered).
// Run: node scripts/export-training.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tests', 'decisions');

const ROUTE_Q = {
  route: {
    type: 'choice',
    instructions: 'Does this request need computer interaction, or only an answer?',
    options: {
      do: 'needs computer interaction', answer: 'knowledge/writing only',
      clarify: 'ambiguous', __none__: 'chatting, or none of these fit',
    },
  },
};
const MEM_Q = (intent) => ({
  intent: {
    type: 'choice',
    instructions: 'What does the user want done with this message?',
    options: {
      remember: 'states a durable fact or asks to remember', forget: 'asks to forget',
      workflow: 'multi-step procedure', chat: 'questions/acting/chit-chat', __none__: 'none of these fit',
    },
  },
  _label: intent,
});

const rows = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.startsWith('golden-') || !f.endsWith('.jsonl')) continue;
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    if (!c.text) continue;
    const entry = { state: c.text, questions: {}, answers: {} };
    if (c.route) {
      const label = c.route === 'do' ? 'do' : c.route === 'answer' ? 'answer' : c.route === 'clarify' ? 'clarify' : '__none__';
      entry.questions.route = ROUTE_Q.route;
      entry.answers.route = { choice: label };
    }
    if (c.memory) {
      const label = ['remember', 'forget', 'chat'].includes(c.memory) ? c.memory : c.memory === 'none' ? 'chat' : '__none__';
      entry.questions.intent = MEM_Q(c.memory).intent;
      entry.answers.intent = { choice: label };
    }
    if (c.context) {
      entry.questions.source = {
        type: 'choice',
        instructions: 'Which on-screen context does this request need?',
        options: { selection: 'selected text', files: 'selected files', folder: 'open folder', clipboard: 'clipboard', page: 'browser page', __none__: 'none needed' },
      };
      const src = (c.context[0] || '__none__');
      entry.questions.deictic = { type: 'noul', instructions: 'Does the request use pointing words for shown items?' };
      entry.answers.source = { choice: src };
      entry.answers.deictic = { noul: c.deictic ? 1 : 0 };
    }
    if (Object.keys(entry.answers).length) rows.push(JSON.stringify(entry));
  }
}
fs.writeFileSync(path.join(dir, 'training.jsonl'), rows.join('\n') + '\n');
console.log(`export-training: ${rows.length} rows -> tests/decisions/training.jsonl`);
