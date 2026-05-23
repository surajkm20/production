import type { WorkflowState } from '../graph/state';

// Builds the minimal user-turn prompt from workflow state.
// Each section is only appended if the data actually exists — no empty placeholders.
// This keeps token count proportional to what was actually retrieved, not a fixed max.
export function buildUserPrompt(state: WorkflowState): string {
  const parts: string[] = [`Query: ${state.query}`];

  if (state.context.group) {
    const g = state.context.group;
    parts.push(
      `Group: "${g.name}" | Pool: ${g.pool_amount}p | Contribution: ${g.monthly_contribution}p/mo | Months: ${g.total_months} | Status: ${g.status} | Commission: ${g.admin_commission_rate}% | Interest: ${g.monthly_interest_rate}%/mo`,
    );
  }

  if (state.context.cycle) {
    const c = state.context.cycle;
    parts.push(
      `Current cycle: Month ${c.month_number} (${c.month_label}) | Status: ${c.status} | Due: ${c.due_date}`,
    );
  }

  if (state.context.basket) {
    const b = state.context.basket;
    parts.push(
      `Basket: Balance=${b.current_balance}p | Lent=${b.total_lent_out}p | Interest earned=${b.total_interest_earned}p`,
    );
  }

  if (state.context.winners?.length) {
    const lines = state.context.winners.map(
      w => `  Slot ${w.winner_number}: bid=${w.bid_amount}p takeaway=${w.winner_takeaway}p basket_credit=${w.basket_credit}p`,
    );
    parts.push(`Cycle winners:\n${lines.join('\n')}`);
  }

  if (state.context.members?.length) {
    const summary = `${state.context.members.length} active members`;
    const roles = state.context.members.reduce(
      (acc, m) => { acc[m.role] = (acc[m.role] ?? 0) + 1; return acc; },
      {} as Record<string, number>,
    );
    parts.push(`Members: ${summary} (${Object.entries(roles).map(([r, c]) => `${c} ${r}`).join(', ')})`);
  }

  if (state.result.data && Object.keys(state.result.data).length > 0) {
    parts.push(`Computed data: ${JSON.stringify(state.result.data, null, 0)}`);
  }

  if (state.result.validationErrors?.length) {
    parts.push(`Validation errors: ${state.result.validationErrors.join('; ')}`);
  }

  return parts.join('\n');
}
