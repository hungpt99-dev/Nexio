/** DecisionPoint catalog (domain, pure).
 *
 * Every choice question carries an explicit abstain option so the model can
 * say "none of these" instead of guessing. Thresholds map onto verdicts:
 * above act -> act, between act and confirm -> confirm, below confirm (or
 * none wins) -> fallthrough.
 */
import type { DecisionPoint } from './types';

export const NONE_OPTION = '__none__';

export interface PointThresholds {
  act: number;
  confirm: number;
}

export const DEFAULT_THRESHOLDS: PointThresholds = { act: 0.85, confirm: 0.55 };

/** Ask vs Do routing. Replaces agent/intent.ts CLASSIFY_PROMPT. */
export function routeModePoint(): DecisionPoint {
  return {
    id: 'route_mode',
    timeoutMs: 8000,
    questions: [
      {
        type: 'choice',
        id: 'route',
        instructions: 'Does this request need computer interaction, or only an answer?',
        options: {
          do: 'needs computer interaction: find/open/move/create/organize files, run commands, change settings, use apps',
          answer: 'knowledge, writing, explanation or calculation with no computer action',
          clarify: 'ambiguous: acting on the computer could do the wrong thing',
          [NONE_OPTION]: 'chatting, or none of these fit',
        },
      },
    ],
  };
}

/** Utterance -> tool / slash command / workflow / none. */
export function dispatchCommandPoint(toolNames: string[]): DecisionPoint {
  const options: Record<string, string> = {
    [NONE_OPTION]: 'chatting, or no available command fits',
  };
  for (const name of toolNames.slice(0, 25)) options[name] = `run ${name}`;
  return {
    id: 'dispatch_command',
    timeoutMs: 8000,
    questions: [
      {
        type: 'choice',
        id: 'command',
        instructions: 'Which available command is the user asking to run?',
        options,
      },
    ],
  };
}

/** remember / forget / workflow / chat routing. Replaces memory/classify.ts. */
export function classifyIntentPoint(): DecisionPoint {
  return {
    id: 'classify_intent',
    timeoutMs: 8000,
    questions: [
      {
        type: 'choice',
        id: 'intent',
        instructions: 'What does the user want done with this message?',
        options: {
          remember: 'states a durable fact about themselves or asks to remember something',
          forget: 'asks to forget or delete a memory',
          workflow: 'asks to run a multi-step procedure or template',
          chat: 'questions, requests to act, chit-chat — nothing to store',
          [NONE_OPTION]: 'none of these fit',
        },
      },
      {
        type: 'boolean',
        id: 'identity',
        instructions: 'Is this an identity claim (name, who they are) that should survive expiry?',
      },
      {
        type: 'choice',
        id: 'kind',
        instructions: 'What kind of durable fact is this?',
        options: {
          fact: 'a plain fact about the user',
          preference: 'a liking, preference or taste',
          folder_rule: 'a rule about a folder or files',
          procedure: 'a repeated routine or procedure',
          [NONE_OPTION]: 'not a durable fact',
        },
      },
    ],
  };
}

/** Which on-screen context a request needs. Replaces context/prompt.ts router. */
export function contextRoutePoint(): DecisionPoint {
  const sources: Record<string, string> = {
    selection: 'the selected text',
    files: 'the selected files',
    folder: 'the open folder',
    clipboard: 'the clipboard content',
    page: 'the browser page',
    [NONE_OPTION]: 'no on-screen context needed (pasted inline or general question)',
  };
  return {
    id: 'context_route',
    timeoutMs: 8000,
    questions: [
      { type: 'choice', id: 'source', instructions: 'Which on-screen context does this request need?', options: sources },
      { type: 'boolean', id: 'deictic', instructions: 'Does the request use pointing words (this, these, here, that) for shown items?' },
    ],
  };
}

/** Map a winning choice + confidence onto act/confirm/fallthrough. */
export function toVerdict(
  pointId: string,
  choice: string | undefined,
  confidence: number,
  t: PointThresholds,
): { verdict: 'act' | 'confirm' | 'fallthrough'; choice?: string } {
  if (!choice || choice === NONE_OPTION || confidence < t.confirm) return { verdict: 'fallthrough' };
  if (confidence >= t.act) return { verdict: 'act', choice };
  // why: between thresholds the user confirms with one keystroke; the
  // choice still travels so the chip can name it ("Run /open Downloads?").
  if (pointId === 'route_mode' && choice === 'clarify') return { verdict: 'fallthrough' };
  return { verdict: 'confirm', choice };
}
