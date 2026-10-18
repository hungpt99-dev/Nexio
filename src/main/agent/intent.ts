/** Intent router: structural fast path, then the Decision Engine.
 *
 * Natural-language routing is a TYPED decision (route_mode point answered by
 * a decision model), never an LLM writing a word/sentence we regex-parse.
 * No engine configured -> 'clarify' (fail-closed); the turn falls through to
 * the normal chat/agent path exactly as before.
 */

export type Intent = 'act' | 'answer' | 'clarify';

const PATH_LIKE = /([A-Za-z]:\\|\/(Users|home|tmp|etc|var)\/|\.(txt|md|pdf|docx?|xlsx?|png|jpe?g|mp3|mp4|zip|json|ts|js|py)\b)/;

// Question shape across scripts: ? U+FF1F (CJK) U+061F (Arabic) U+037E (Greek).
const QUESTION_SHAPE = /[?\uFF1F\u061F\u037E]\s*$/u;

/**
 * Pure structural pass over syntax/shape only (paths, trailing question
 * marks, slash commands) — never keyword intent. Null = uncertain, the
 * Decision Engine decides. Slash commands never route here.
 */
export function heuristicIntent(text: string): Intent | null {
  const t = text.trim();
  if (!t || t.startsWith('/')) return null;
  if (PATH_LIKE.test(t) && !QUESTION_SHAPE.test(t)) return 'act';
  if (QUESTION_SHAPE.test(t)) return 'answer';
  return null;
}

export interface IntentDeps {
  /** Typed decision (route_mode point). Null = abstain/fallthrough. */
  decideRoute?: (text: string, signal?: AbortSignal) => Promise<Intent | null>;
  signal?: AbortSignal;
}

/** Heuristic first; Decision Engine on uncertainty; clarify on abstention. */
export async function classifyIntent(text: string, deps: IntentDeps = {}): Promise<Intent> {
  const h = heuristicIntent(text);
  if (h === 'act' || h === 'answer') return h;
  if (!deps.decideRoute) return 'clarify';
  try {
    const r = await deps.decideRoute(text.trim().slice(0, 2000), deps.signal);
    if (r === 'act' || r === 'answer' || r === 'clarify') return r;
    return 'clarify';
  } catch {
    return 'clarify';
  }
}

/** Clarifying question for uncertain intent involving potential machine changes. */
export function clarifyQuestion(text: string): string {
  const short = text.trim().slice(0, 120);
  return `Should I take action on your computer for "${short}", or just answer? Reply "do it" or "just answer".`;
}
