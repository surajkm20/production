import type { WorkflowState, IntentType } from './state';

// Keyword sets for intent classification — ordered by priority (most specific first)
const PATTERNS: Array<[IntentType, string[]]> = [
  ['report',      ['report', 'ledger', 'statement', 'summary', 'export', 'overview']],
  ['calculation', ['calculate', 'compute', 'how much', 'total', 'balance', 'interest', 'commission', 'takeaway']],
  ['validation',  ['can i', 'can he', 'eligible', 'allowed', 'valid', 'able to', 'permitted', 'qualify']],
  ['query',       ['who', 'what', 'show', 'list', 'get', 'find', 'when', 'how many', 'which', 'status']],
];

export function classifyIntent(query: string): IntentType {
  const q = query.toLowerCase();
  for (const [type, keywords] of PATTERNS) {
    if (keywords.some(k => q.includes(k))) return type;
  }
  return 'unknown';
}

// Routes after the context node — determines which processing node runs next
export function routeAfterContext(state: WorkflowState): string | null {
  switch (state.intentType) {
    case 'query':       return 'dbRead';
    case 'calculation': return 'calculate';
    case 'validation':  return 'validate';
    case 'report':      return 'dbRead';
    default:            return 'respond';
  }
}

// Routes after dbRead — reports need calculation; queries go straight to respond
export function routeAfterDbRead(state: WorkflowState): string | null {
  return state.intentType === 'report' ? 'calculate' : 'respond';
}
