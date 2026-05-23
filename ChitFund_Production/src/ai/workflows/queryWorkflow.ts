import { GraphExecutor } from '../graph/executor';
import { createState } from '../graph/state';
import { classifyIntent, routeAfterContext, routeAfterDbRead } from '../graph/router';
import { contextNode } from '../nodes/contextNode';
import { dbReadNode } from '../nodes/dbNode';
import { ruleNode } from '../nodes/ruleNode';
import { calcNode } from '../nodes/calcNode';
import { responseNode } from '../nodes/responseNode';

// Query workflow handles ad-hoc natural-language queries about group state.
// Graph: classify → context → [dbRead | calculate | validate] → respond
//
// Token profile: system(~120) + minimal context(~200-400) + structured data(~100-300)
// ≈ 420-820 input tokens per query — vs. a naive approach that dumps the full ledger.
function buildGraph(): GraphExecutor {
  const g = new GraphExecutor();

  g.node('classify', async state => {
    state.intentType = classifyIntent(state.query);
    return state;
  });

  g.node('context', contextNode);
  g.node('dbRead', dbReadNode);
  g.node('validate', ruleNode);
  g.node('calculate', calcNode);
  g.node('respond', responseNode);

  g.then('classify', 'context');
  g.edge('context', routeAfterContext);
  g.edge('dbRead', routeAfterDbRead);
  g.then('validate', 'respond');
  g.then('calculate', 'respond');

  return g;
}

export async function runQuery(
  query: string,
  params: { groupId?: string; userId?: string; cycleId?: string } = {},
) {
  const state = createState(query, params);
  return buildGraph().run('classify', state);
}
