/** Two-stage tool retrieval (application).
 *
 * Stage 1 shortlists 5–15 candidates with BM25 (+aliases) over tool names,
 * descriptions and argument names. Never user files or tool results.
 * The shortlist only NARROWS: it never enables a disabled tool or changes a
 * risk class. Empty or low confidence -> the full enabled tool set.
 */
export interface RetrievalDoc {
  name: string;
  description: string;
  argNames: string[];
  aliases?: string[];
}

function viFold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

function tokens(s: string): string[] {
  // why: fold diacritics so "tai xuong" matches alias "tải xuống".
  return viFold(s).toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
}

function bm25(query: string, doc: RetrievalDoc, avgLen: number, docFreq: Map<string, number>, total: number): number {
  const terms = tokens(query);
  if (!terms.length) return 0;
  const fields = [
    `${doc.name} ${doc.name}`.replace(/_/g, ' '),
    doc.description,
    doc.argNames.join(' '),
    (doc.aliases || []).join(' '),
  ].join('\n');
  const docTokens = tokens(fields);
  const len = docTokens.length || 1;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of new Set(terms)) {
    const f = tf.get(term) || 0;
    if (!f) continue;
    const df = docFreq.get(term) || 0;
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
  }
  // why: exact tool-name mentions are near-certain intent — keep them on top
  // even when the description vocabulary disagrees.
  if (docTokens.includes(terms[0]) && terms.length === 1) score += 5;
  return score;
}

/** Shortlist up to `limit` docs (default 12), excluding zero-score docs. */
export function shortlistTools(query: string, docs: RetrievalDoc[], limit = 12): RetrievalDoc[] {
  if (!docs.length) return [];
  const tokenized = docs.map((d) => tokens([d.name.replace(/_/g, ' '), d.description, d.argNames.join(' '), (d.aliases || []).join(' ')].join('\n')));
  const avgLen = tokenized.reduce((a, t) => a + t.length, 0) / Math.max(1, tokenized.length) || 1;
  const df = new Map<string, number>();
  for (const toks of tokenized) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  return docs
    .map((d) => ({ d, s: bm25(query, d, avgLen, df, docs.length) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.min(Math.max(5, limit), 15))
    .map((x) => x.d);
}

/** Recall@k over labeled cases: fraction where the gold tool is shortlisted. */
export function recallAtK(cases: Array<{ query: string; gold: string }>, docs: RetrievalDoc[], k = 10): number {
  if (!cases.length) return 1;
  let hits = 0;
  for (const c of cases) {
    const names = new Set(shortlistTools(c.query, docs, k).map((d) => d.name));
    if (names.has(c.gold)) hits += 1;
  }
  return hits / cases.length;
}

/** Alias vocabulary per built-in tool (EN+VI user words, not file content).
 * Kept here (not on the Tool) so retrieval tuning never touches tool semantics. */
const TOOL_ALIASES: Record<string, string[]> = {
  app_open: ['open', 'launch', 'start app', 'mở', 'khởi động', 'download folder', 'folder'],
  apps_list: ['apps', 'programs', 'processes', 'ứng dụng', 'tiến trình'],
  fs_search: ['find', 'search', 'look for', 'tìm', 'tìm kiếm', 'files changed', 'duplicates', 'invoices'],
  fs_read: ['read', 'show file', 'open file', 'đọc', 'xem file', 'meeting notes'],
  fs_list: ['list', 'contents', 'liệt kê', 'trong thư mục', 'what is in'],
  fs_write: ['write', 'create', 'save', 'new file', 'new folder', 'tạo', 'lưu', 'ghi', 'tạo thư mục'],
  fs_move: ['move', 'rename', 'organize', 'sort', 'di chuyển', 'đổi tên', 'sắp xếp', 'organize'],
  fs_copy: ['copy', 'duplicate', 'sao chép', 'chép'],
  fs_trash: ['delete', 'remove', 'trash', 'recycle', 'xóa', 'xoá', 'empty trash'],
  shell_run: ['run', 'command', 'terminal', 'disk', 'usage', 'processes', 'memory', 'chạy', 'ổ đĩa', 'disk space', 'zip', 'archive', 'back up', 'close windows'],
  clipboard_read: ['clipboard', 'copied', 'copy'],
  clipboard_write: ['clipboard', 'copy to', 'คัดลอก'],
  web_search: ['web', 'search web', 'latest', 'release', 'tin mới'],
  web_fetch: ['fetch', 'url', 'tải url', 'link'],
  context_get: ['context', 'selection', 'screen', 'this', 'these', 'these files'],
  attachment_list: ['attachment', 'attached', 'đính kèm'],
  attachment_read: ['attachment', 'read attachment', 'đính kèm'],
  memory_save: ['remember', 'nhớ', 'save memory'],
  memory_forget: ['forget', 'quên'],
  subtask_create: ['subtask', 'parallel', 'background'],
};

/** Build retrieval docs from live tools (disabled tools are never passed in). */
export function docsFromTools(tools: Array<{ name: string; description: string }>): RetrievalDoc[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    argNames: ['path', 'root', 'from', 'to', 'file', 'folder', 'directory', 'query', 'command'],
    aliases: TOOL_ALIASES[t.name] || [],
  }));
}
