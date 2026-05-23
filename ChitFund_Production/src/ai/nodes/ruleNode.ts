import type { WorkflowState } from '../graph/state';
import { paiseToRupeeDisplay } from '../../utils/money';

// Validates business rules against loaded context.
// Errors are collected (not thrown) so the response node can explain them.
export async function ruleNode(state: WorkflowState): Promise<WorkflowState> {
  const errors: string[] = [];
  const { context, query } = state;
  const q = query.toLowerCase();

  if (context.group) {
    const { pool_amount, admin_commission_rate, status } = context.group;

    // Group must be active for any transactional operation
    if (status !== 'Active' && (q.includes('bid') || q.includes('loan') || q.includes('pay'))) {
      errors.push(`Group is ${status} — no transactions allowed.`);
    }

    // Bid constraints
    if (q.includes('bid')) {
      const minBid = Math.floor(pool_amount * 0.01); // floor 1% of pool
      const commission = parseFloat(admin_commission_rate);
      const maxUsefulBid = Math.floor(pool_amount * (1 - commission / 100));
      state.result.data = {
        ...state.result.data,
        bidConstraints: {
          minBid,
          maxBid: pool_amount,
          maxUsefulBid,
          note: `Bids above ${paiseToRupeeDisplay(maxUsefulBid)} leave nothing for basket credit`,
        },
      };
    }
  }

  // Loan eligibility check: basket must have balance
  if (q.includes('loan') && context.basket) {
    if (context.basket.current_balance <= 0) {
      errors.push(`Basket balance is ${paiseToRupeeDisplay(context.basket.current_balance)} — insufficient for a loan.`);
    }
  }

  // Cycle must be open for bids
  if (q.includes('bid') && context.cycle) {
    if (context.cycle.status !== 'Open') {
      errors.push(`Cycle ${context.cycle.month_label} is ${context.cycle.status} — bidding is closed.`);
    }
  }

  state.result.validationErrors = errors;
  return state;
}
