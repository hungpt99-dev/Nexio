// Claims check: the registry, IPC, settings and UI must agree.
// Fails when: a registered stable/experimental feature has no owner module,
// an IPC channel has no main handler, a Settings key is never read outside
// its definition, a SkipReason has no human-readable mapping, or a shipped
// feature is missing from docs/features.md.
// Run: node scripts/check-claims.mjs (part of npm run verify)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let hits = 0;
const fail = (m) => { console.error(`claims: ${m}`); hits += 1; };
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// --- 1. registry: owner modules exist; features.md lists shipped ones ---
const reg = read('src/main/capabilities/registry.ts');
const feats = [...reg.matchAll(/\{\s*id:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,\s*status:\s*'([^']+)'\s*,\s*owner:\s*'([^']*)'/g)]
  .map((m) => ({ id: m[1], status: m[3], owner: m[4] }));
if (!feats.length) fail('no features parsed from registry');
let featuresDoc = '';
try { featuresDoc = read('docs/features.md'); } catch { fail('docs/features.md missing'); }
for (const f of feats) {
  if ((f.status === 'stable' || f.status === 'experimental') && !f.owner) fail(`feature ${f.id} is ${f.status} without an owner module`);
  if (f.owner && !fs.existsSync(path.join(root, f.owner))) fail(`feature ${f.id} owner missing: ${f.owner}`);
  if (f.status !== 'not_built' && featuresDoc && !featuresDoc.includes(f.id)) fail(`feature ${f.id} not listed in docs/features.md`);
}

// --- 2. every IPC channel has a main handler ---
const channels = read('src/shared/ipc-channels.ts');
const keys = [...channels.matchAll(/^  (\w+):\s*'/gm)].map((m) => m[1]);
const ipc = read('src/main/ipc.ts');
// push channels (main->renderer) are sent, never handled; invoke channels must be handled.
const pushKeys = [...channels.matchAll(/IpcPushKeys = \[([^\]]+)\]/g)].flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
const pushChannels = new Set(pushKeys.map((k) => {
  const m = channels.match(new RegExp(`^  ${k}:\\s*'([^']+)'`, 'm'));
  return m ? m[1] : k;
}));
const channelVals = [...channels.matchAll(/^  (\w+):\s*'([^']+)'/gm)];
for (const m of channelVals) {
  if (pushChannels.has(m[2])) continue;
  if (!ipc.includes(`IpcChannels.${m[1]}`)) fail(`IPC channel without handler: ${m[1]}`);
}

// --- 3. every Settings key is read outside its definition ---
const types = read('src/shared/types.ts');
const settingsBlock = types.slice(types.indexOf('export interface Settings {'), types.indexOf('export interface Settings {') + 12000);
const settingsKeys = [...settingsBlock.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); continue; }
    if (/\.(ts|js)$/.test(p)) out.push(p);
  }
  return out;
};
const prodFiles = walk(path.join(root, 'src')).filter((p) =>
  !p.includes(`${path.sep}store${path.sep}settings.ts`) &&
  !p.endsWith(`${path.sep}types.ts`) &&
  !p.includes(`${path.sep}tests${path.sep}`));
const prodText = prodFiles.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
for (const k of settingsKeys) {
  const re = new RegExp(`[^\\w]${k}[^\\w]`);
  if (!re.test(prodText)) fail(`Settings key never read outside definition: ${k}`);
}

// --- 4. every SkipReason maps to human text in both UIs ---
const skipUnion = read('src/main/context/types.ts');
const reasons = [...skipUnion.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  .filter((r, i, a) => a.indexOf(r) === i && !['text', 'file', 'folder'].includes(r) && r.includes('_'));
const renderer = read('src/renderer/app.js');
const mainPrompt = read('src/main/context/prompt.ts');
for (const r of [...new Set(reasons)]) {
  if (!renderer.includes(`'${r}'`) && !renderer.includes(`"${r}"`)) fail(`SkipReason '${r}' has no renderer mapping`);
  if (!mainPrompt.includes(`'${r}'`) && !mainPrompt.includes(`"${r}"`)) fail(`SkipReason '${r}' has no main mapping`);
}

if (hits) { console.error(`check-claims: ${hits} violation(s)`); process.exit(1); }
console.log(`check-claims: ok (${feats.length} features, ${keys.length} channels, ${settingsKeys.length} settings, ${reasons.length} skip reasons)`);
