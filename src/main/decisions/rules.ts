/** Custom decision rules (domain, pure).
 *
 * User rules in Settings: "when decision X is chosen, then run / route /
 * notify / tag". `run` still goes through normal validation and approvals;
 * `route` hands the original input to a normal chat turn on a model the user
 * picks. No rule may auto-approve anything or bypass the kill switch.
 */
export type RuleAction =
  | { type: 'run'; command: string }
  | { type: 'route'; model: string }
  | { type: 'notify'; message: string }
  | { type: 'tag'; tag: string };

export interface DecisionRule {
  id: string;
  /** Decision choice this fires on, e.g. "classify_intent:remember". */
  on: string;
  action: RuleAction;
  enabled: boolean;
}

export function validateRule(r: unknown): string[] {
  const errors: string[] = [];
  if (typeof r !== 'object' || r === null) return ['rule must be an object'];
  const o = r as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) errors.push('rule id must be non-empty');
  if (typeof o.on !== 'string' || !/^[a-z_]+:.+$/.test(o.on)) errors.push('rule on must look like "point:choice"');
  if (typeof o.enabled !== 'boolean') errors.push('rule enabled must be boolean');
  const a = o.action as Record<string, unknown> | undefined;
  if (typeof a !== 'object' || a === null) {
    errors.push('rule action must be an object');
    return errors;
  }
  if (a.type === 'run' && (typeof a.command !== 'string' || !a.command.startsWith('/'))) {
    errors.push('run action needs a /command');
  } else if (a.type === 'route' && (typeof a.model !== 'string' || !a.model.trim())) {
    errors.push('route action needs a model');
  } else if (a.type === 'notify' && typeof a.message !== 'string') {
    errors.push('notify action needs a message');
  } else if (a.type === 'tag' && typeof a.tag !== 'string') {
    errors.push('tag action needs a tag');
  } else if (a.type !== 'run' && a.type !== 'route' && a.type !== 'notify' && a.type !== 'tag') {
    errors.push('unknown rule action type');
  }
  return errors;
}

/** Enabled rules matching a fired decision key. Never auto-approves. */
export function matchingRules(rules: DecisionRule[], key: string): DecisionRule[] {
  return rules.filter((r) => r.enabled && r.on === key);
}
