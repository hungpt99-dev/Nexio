// Import-boundary lint for the layered pilot (src/main/decisions/).
// One-way dependencies: domain -> application -> infrastructure -> interface.
// - domain (types, points, args, rules, calibration, retrieval): no imports
//   from other main/* areas and no node: I/O except args (os/path) — pure.
// - decisions/* (all): never import the interface layer (ipc, main, popup,
//   preload, tray) — the turn path depends on decisions, not vice versa.
// Run: node scripts/check-boundaries.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dec = path.join(root, 'src', 'main', 'decisions');

const DOMAIN_PURE = new Set(['types.ts', 'points.ts', 'rules.ts', 'calibration.ts', 'retrieval.ts']);
const INTERFACE_FILES = ['ipc', 'main', 'popup', 'preload', 'tray'];

let hits = 0;
for (const f of fs.readdirSync(dec)) {
  if (!f.endsWith('.ts')) continue;
  const src = fs.readFileSync(path.join(dec, f), 'utf8');
  const imports = [...src.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const imp of imports) {
    if (!imp.startsWith('.')) continue;
    const target = imp.replace(/^\.\//, '').split('/')[0];
    if (DOMAIN_PURE.has(f) && target !== 'types' && target !== 'points' && target !== 'rules' && target !== 'calibration' && target !== 'retrieval') {
      // domain-pure files may only import sibling domain files, shared, or node:.
      if (!imp.startsWith('../shared/')) {
        console.error(`boundary: decisions/${f} (domain) imports ${imp} — domain must stay pure`);
        hits += 1;
      }
    }
    if (INTERFACE_FILES.includes(target)) {
      console.error(`boundary: decisions/${f} imports interface layer (${imp}) — dependency points the wrong way`);
      hits += 1;
    }
  }
}
if (hits) {
  console.error(`check-boundaries: ${hits} violation(s)`);
  process.exit(1);
}
console.log('check-boundaries: ok');
