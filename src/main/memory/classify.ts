/** Language-agnostic memory intent: data-driven fast path + one model call.
 * The model decides in the user's own language. Both paths see ONLY user
 * messages — never tool results, files, attachments or web content.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryKind } from '../../shared/types';
import { scanSecretsText } from '../../shared/attachments';
import { graphemeLength, takeGraphemes } from '../../shared/text';
import { blockedMemoryText } from './types';

export type MemoryIntent = 'remember' | 'forget' | 'none';

export interface IntentPack {
  locale: string;
  remember: string[];
  forget: string[];
  strip?: string[];
  kinds?: Partial<Record<'folder_rule' | 'procedure' | 'preference', string[]>>;
}

export interface FastMatch {
  intent: 'remember' | 'forget';
  /** Command wrapper stripped, punctuation trimmed. */
  text: string;
  kind: MemoryKind;
  locale: string;
}

export interface ClassifiedMemory {
  intent: MemoryIntent;
  text: string;
  kind: 'preference' | 'fact' | 'folder_rule' | 'procedure';
  language: string;
  /** Pin identity claims so they survive expiry (model decides). */
  pin?: boolean;
  blocked?: string;
}

const packCache = new Map<string, IntentPack | null>();

function packsDir(): string {
  // src/main/memory -> src/main/i18n/intents (dist mirrors src).
  for (const d of [path.join(__dirname, '..', 'i18n', 'intents'), path.join(__dirname, 'intents')]) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch { /* try next */ }
  }
  return path.join(__dirname, '..', 'i18n', 'intents');
}

/** Load one pack; missing locales return null (never break). */
export function loadIntentPack(locale: string): IntentPack | null {
  const tag = String(locale || '').toLowerCase().replace(/_/g, '-').split('-')[0] || 'en';
  if (packCache.has(tag)) return packCache.get(tag) as IntentPack | null;
  let pack: IntentPack | null = null;
  try {
    const o = JSON.parse(fs.readFileSync(path.join(packsDir(), `${tag}.json`), 'utf8')) as IntentPack;
    if (o && Array.isArray(o.remember) && Array.isArray(o.forget)) pack = o;
  } catch { /* contributors add a language with one JSON file */ }
  packCache.set(tag, pack);
  return pack;
}

/** Test seam. */
export function __resetIntentPacksForTests(): void {
  packCache.clear();
}

function normForMatch(s: string, locale: string): string {
  try {
    return s.normalize('NFC').toLocaleLowerCase(locale);
  } catch {
    return s.normalize('NFC').toLowerCase();
  }
}

function applyStrip(text: string, pack: IntentPack): string {
  let out = text.trim();
  for (const pattern of pack.strip || []) {
    try {
      out = out.replace(new RegExp(pattern, 'iu'), '');
    } catch { /* bad contributor regex never breaks matching */ }
  }
  // why: strip ASCII + CJK fullwidth + Arabic/Greek question marks, not just ASCII.
  return out.trim().replace(/^[.,;:!?。、！？，；：·…\uFF01\uFF1F\uFF0C\uFF1B\u061F\u037E]+|[.,;:!?。、！？，；：·…\uFF01\uFF1F\uFF0C\uFF1B\u061F\u037E]+$/gu, '').trim();
}

function phraseHit(lowered: string, phrases: string[], locale: string): boolean {
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    const pl = normForMatch(p, locale);
    if (!pl) continue;
    // Single-word triggers only count at the start ("remember X" is a
    // command; "I can't remember Y" is not). Multi-word triggers match anywhere.
    if (lowered.startsWith(pl)) return true;
    if (pl.includes(' ') && lowered.includes(pl)) return true;
  }
  return false;
}

function kindFor(pack: IntentPack, text: string, locale: string): MemoryKind {
  const lowered = normForMatch(text, locale);
  const kinds = pack.kinds || {};
  for (const kind of ['folder_rule', 'procedure', 'preference'] as const) {
    for (const phrase of kinds[kind] || []) {
      if (phrase && lowered.includes(normForMatch(phrase, locale))) return kind;
    }
  }
  return 'fact';
}

/**
 * Confident data-driven match over [uiLocale, 'en'] packs. Questions never
 * match (they recall, they don't store). Null = run the model call.
 */
export function matchFastPath(text: string, locales: string[]): FastMatch | null {
  const t = text.trim();
  if (!t || t.startsWith('/') || /[?\uFF1F\u061F\u037E]\s*$/u.test(t)) return null;
  const seen = new Set<string>();
  for (const loc of [...locales, 'en']) {
    const tag = String(loc || '').toLowerCase().replace(/_/g, '-').split('-')[0] || 'en';
    if (seen.has(tag)) continue;
    seen.add(tag);
    const pack = loadIntentPack(tag);
    if (!pack) continue;
    const lowered = normForMatch(t, tag);
    if (phraseHit(lowered, pack.forget, tag)) {
      return { intent: 'forget', text: applyStrip(t, pack), kind: 'fact', locale: tag };
    }
    if (phraseHit(lowered, pack.remember, tag)) {
      const stripped = applyStrip(t, pack);
      if (!stripped) continue;
      return { intent: 'remember', text: stripped, kind: kindFor(pack, stripped, tag), locale: tag };
    }
  }
  return null;
}

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{4})?(-[A-Z]{2})?$/;

function validKind(k: unknown): ClassifiedMemory['kind'] {
  return k === 'preference' || k === 'fact' || k === 'folder_rule' || k === 'procedure' ? k : 'fact';
}

export interface MemoryDecision {
  intent: 'remember' | 'forget' | 'none';
  text: string;
  kind: ClassifiedMemory['kind'];
  language: string;
  pin?: boolean;
}

/** Typed memory decision callback (classify_intent point). Null = abstain. */
export type MemoryDecide = (text: string, context: string[]) => Promise<MemoryDecision | null>;

/**
 * Typed memory decision (classify_intent point) over the current + last 2
 * user messages. Schema-validated; secrets/PII in `text` force 'none'.
 * Returns null when no engine is configured (offline) — callers fall back to
 * slash commands and never guess from words. No JSON parsing: the engine
 * answers typed questions, it does not write text we parse.
 */
export async function classifyMemoryIntent(
  text: string,
  recentUserTexts: string[],
  decide: MemoryDecide | null,
): Promise<ClassifiedMemory | null> {
  if (!decide) return null;
  const context = [...recentUserTexts.slice(-2), text].map((s) => String(s).slice(0, 500));
  let o: MemoryDecision | null;
  try {
    o = await decide(text, context);
  } catch {
    return null;
  }
  if (!o) return null;
  const intent = o.intent === 'remember' || o.intent === 'forget' ? o.intent : 'none';
  // why: grapheme cap keeps emoji/combining marks whole (never UTF-16 slice).
  const outText = takeGraphemes(String(o.text || '').trim(), 300);
  const language = typeof o.language === 'string' && LANG_RE.test(o.language) ? o.language : 'und';
  if (intent === 'none' || !outText || graphemeLength(outText) === 0) return { intent: 'none', text: '', kind: 'fact', language };
  const blocked = blockedMemoryText(outText, scanSecretsText);
  if (blocked) return { intent: 'none', text: '', kind: 'fact', language, blocked };
  return { intent, text: outText, kind: validKind(o.kind), language, pin: o.pin === true };
}
