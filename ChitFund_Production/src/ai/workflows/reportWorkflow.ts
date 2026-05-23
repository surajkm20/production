import { GraphExecutor } from '../graph/executor';
import { createState } from '../graph/state';
import { contextNode } from '../nodes/contextNode';
import { dbReadNode } from '../nodes/dbNode';
import { calcNode } from '../nodes/calcNode';
import { responseNode } from '../nodes/responseNode';

// Report workflow: loads full context for a group (+ optional cycle), computes
// financials, fetches DB aggregates, then generates a structured LLM summary.
// Graph: init → context → dbRead → calculate → respond (linear — all steps required)
function buildGraph(): GraphExecutor {
  const g = new GraphExecutor();

  g.node('init', async state => {
    state.intentType = 'report';
    return state;
  });

  g.node('context', contextNode);
  g.node('dbRead', dbReadNode);
  g.node('calculate', calcNode);
  g.node('respond', responseNode);

  g.then('init', 'context');
  g.then('context', 'dbRead');
  g.then('dbRead', 'calculate');
  g.then('calculate', 'respond');

  return g;
}

export async function runReport(
  groupId: string,
  options: { cycleId?: string; userId?: string } = {},
) {
  const state = createState('Generate a financial summary for this group.', {
    groupId,
    ...options,
  });
  return buildGraph().run('init', state);
}
