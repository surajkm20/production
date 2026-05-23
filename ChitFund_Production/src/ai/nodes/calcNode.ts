import type { WorkflowState } from '../graph/state';
import { paiseToRupeeDisplay } from '../../utils/money';

// Pure financial calculations — no DB calls, no LLM calls.
// Reads from state.context (populated by contextNode) and writes to state.result.data.
// All arithmetic stays in paise integers; display strings are added alongside.
export async function calcNode(state: WorkflowState): Promise<WorkflowState> {
  const { context } = state;
  if (!context.group) return state;

  const { pool_amount, monthly_contribution, admin_commission_rate, monthly_interest_rate, total_months } = context.group;
  const commissionRate = parseFloat(admin_commission_rate);
  const interestRate = parseFloat(monthly_interest_rate);

  const calcs: Record<string, number | string> = {
    pool_amount,
    pool_amount_display: paiseToRupeeDisplay(pool_amount),
    monthly_contribution,
    monthly_contribution_display: paiseToRupeeDisplay(monthly_contribution),
    total_months,
  };

  // Commission on pool (not on bid — per business rules in CLAUDE.md)
  const adminCommissionOnPool = Math.floor((pool_amount * commissionRate) / 100);
  calcs.admin_commission_on_pool = adminCommissionOnPool;
  calcs.admin_commission_display = paiseToRupeeDisplay(adminCommissionOnPool);

  // Per-winner calculations if we have winner data
  if (context.winners?.length) {
    const winnerCalcs = context.winners.map(w => ({
      slot: w.winner_number,
      bid_amount: w.bid_amount,
      bid_amount_display: paiseToRupeeDisplay(w.bid_amount),
      winner_takeaway: w.winner_takeaway,
      winner_takeaway_display: paiseToRupeeDisplay(w.winner_takeaway),
      basket_credit: w.basket_credit,
      basket_credit_display: paiseToRupeeDisplay(w.basket_credit),
      // Derived: pool_amount − bid_amount (winner gets back the discount)
      discount_saved: pool_amount - w.bid_amount,
      discount_saved_display: paiseToRupeeDisplay(pool_amount - w.bid_amount),
    }));
    calcs.winners = JSON.stringify(winnerCalcs);
  }

  // Basket snapshot
  if (context.basket) {
    calcs.basket_balance = context.basket.current_balance;
    calcs.basket_balance_display = paiseToRupeeDisplay(context.basket.current_balance);
    calcs.total_lent_out = context.basket.total_lent_out;
    calcs.total_interest_earned = context.basket.total_interest_earned;
  }

  // Monthly interest on a hypothetical loan of 1 lakh (informational)
  if (interestRate > 0) {
    const sampleLoan = 10_000_00; // ₹1,00,000 in paise
    calcs.interest_per_month_on_1lakh = Math.floor((sampleLoan * interestRate) / 100);
    calcs.interest_rate_pct = interestRate;
  }

  state.result.data = { ...state.result.data, calculations: calcs };
  return state;
}
