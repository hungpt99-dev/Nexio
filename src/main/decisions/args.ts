/** Deterministic argument resolution (domain, pure).
 *
 * Decision models CHOOSE; they do not extract free-form values. Dates/times
 * come from the system clock + timezone, known folders from the OS, files and
 * tools matched against the real catalog and granted roots. Unresolvable ->
 * null (caller falls through or asks the user). Values are NEVER invented.
 */
import os from 'node:os';
import path from 'node:path';

export interface Clock {
  now(): number;
  timeZone(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

const DAY_MS = 86_400_000;

interface RelDay {
  re: RegExp;
  offset: number;
}

/** Fold Vietnamese diacritics to ASCII so "hom nay" matches "hôm nay". */
function viFold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

function normMatch(re: RegExp, text: string): boolean {
  if (re.test(text)) return true;
  // why: fold BOTH sides so "hom nay" matches "hôm nay" (NFD-strip is safe
  // on these literal alternations; flags preserved).
  const foldedSource = viFold(re.source);
  try {
    return new RegExp(foldedSource, re.flags).test(viFold(text));
  } catch {
    return false;
  }
}

const REL_DAYS: RelDay[] = [
  { re: /\b(day before yesterday|hôm kia)\b/iu, offset: -2 },
  { re: /\b(hôm nay|today)\b/iu, offset: 0 },
  { re: /\b(hôm qua|yesterday)\b/iu, offset: -1 },
  { re: /\b(ngày mai|tomorrow)\b/iu, offset: 1 },
  { re: /\b(tuần trước|last week)\b/iu, offset: -7 },
  { re: /\b(tuần này|this week)\b/iu, offset: 0 },
  { re: /\b(tuần sau|next week)\b/iu, offset: 7 },
  { re: /\b(tháng trước|last month)\b/iu, offset: -30 },
  { re: /\b(tháng này|this month)\b/iu, offset: 0 },
];

/** Resolve a relative day expression (EN+VI) to a YYYY-MM-DD date, or null. */
export function resolveRelativeDate(text: string, clock: Clock = systemClock): string | null {
  const t = text.normalize('NFC');
  for (const { re, offset } of REL_DAYS) {
    if (normMatch(re, t)) {
      const d = new Date(clock.now() + offset * DAY_MS);
      return d.toISOString().slice(0, 10);
    }
  }
  const m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) {
      const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : new Date(clock.now()).getFullYear();
      // why: dd/mm first (vi + most locales); invalid dates refuse, never roll over.
      const d = new Date(Date.UTC(year, b - 1, a));
      if (d.getUTCMonth() === b - 1 && d.getUTCDate() === a) return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

/** Known folders from the OS (no guessing, no registry reads). */
export function knownFolders(): Record<string, string> {
  const home = os.homedir();
  return {
    home,
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    pictures: path.join(home, 'Pictures'),
    music: path.join(home, 'Music'),
    videos: path.join(home, 'Movies'),
  };
}

const FOLDER_ALIASES: Array<{ re: RegExp; key: string }> = [
  { re: /\b(downloads?|thư mục tải xuống|tải xuống|tài xuống)\b/iu, key: 'downloads' },
  { re: /\b(documents?|tài liệu|văn bản)\b/iu, key: 'documents' },
  { re: /\b(desktop|màn hình (chính|nền)|bàn làm việc)\b/iu, key: 'desktop' },
  { re: /\b(pictures?|photos?|ảnh|hình ảnh|hình)\b/iu, key: 'pictures' },
  { re: /\b(music|nhạc|âm nhạc)\b/iu, key: 'music' },
];

/** Resolve a known-folder mention (EN+VI) to an absolute path, or null. */
export function resolveKnownFolder(text: string): string | null {
  const t = text.normalize('NFC');
  const folders = knownFolders();
  for (const { re, key } of FOLDER_ALIASES) {
    if (normMatch(re, t)) return folders[key];
  }
  return null;
}

function normName(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[_\-]+/g, ' ').trim();
}

/** Match tool/file names against the real catalog (substring + token overlap).
 * Returns catalog entries only — unknown names never resolve. */
export function matchCatalog(text: string, catalog: string[], limit = 5): string[] {
  const t = normName(text);
  if (!t) return [];
  const scored: Array<{ name: string; s: number }> = [];
  for (const name of catalog) {
    const n = normName(name);
    if (!n) continue;
    if (t.includes(n) || n.includes(t)) {
      scored.push({ name, s: 2 + n.length / Math.max(1, t.length) });
      continue;
    }
    const tq = new Set(t.split(/\s+/u));
    const nq = n.split(/\s+/u);
    const overlap = nq.filter((w) => tq.has(w)).length;
    if (overlap > 0) scored.push({ name, s: overlap / nq.length });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.name);
}

/** True when `p` stays inside one of the granted roots (prefix check). */
export function insideGrantedRoots(p: string, roots: string[]): boolean {
  const norm = path.normalize(p);
  return roots.some((r) => {
    const root = path.normalize(r);
    return norm === root || norm.startsWith(root + path.sep);
  });
}
