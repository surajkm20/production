export interface User {
  user_id: string
  name: string
  mobile_number: string
  username: string | null
  mobile_verified: boolean
  created_at: string
}

export type GroupRole = 'Admin' | 'Member'
export type GroupStatus = 'Active' | 'Closed'
export type CycleStatus = 'Open' | 'Closed' | 'PendingStart' | null
export type PaymentStatus = 'Paid' | 'Unpaid' | 'Waived' | 'N/A'

export interface GroupSummary {
  group_id: string
  name: string
  status: GroupStatus
  role: GroupRole
  share_count: number
  wins_count: number
  monthly_contribution: number
  total_shares: number
  current_month_number: number | null
  current_cycle_status: CycleStatus
  user_payment_status_this_month: PaymentStatus
  defaulters_count: number
  closed_at?: string | null
}

export interface CycleWinner {
  winner_number: number
  user_id: string
  name: string | null
  bid_amount: number
  admin_commission: number
  basket_credit: number
  winner_takeaway: number
  is_admin_withdrawal: boolean
  notes?: string | null
  recorded_at?: string | null
}

export interface ChitiEligibility {
  realized: number
  unrealized: number
  total_basket: number
  pool_amount: number
  double_chiti: number
  label: string
  eligible: boolean
}

export interface GroupDetail {
  group_id: string
  name: string
  invitation_code: string
  invitation_code_expires_at: string | null
  pool_amount: number
  monthly_contribution: number
  total_shares: number
  total_months: number
  shares_filled: number
  people_count: number
  start_month: string
  payment_due_day: number
  admin_commission_rate: string
  monthly_interest_rate: string
  status: 'Active' | 'Closed'
  current_cycle: {
    cycle_id: string
    month_number: number
    month_label: string
    due_date: string
    status: 'Open' | 'Closed'
    is_skip_month: boolean
    winners: CycleWinner[]
  } | null
  basket: {
    current_balance: number
    total_credited: number
    total_debited: number
    total_lent_out: number
  } | null
  my_membership: {
    role: 'Admin' | 'Member'
    share_count: number
    wins_count: number
  }
  created_at: string
}

export interface CycleSummary {
  total_expected: number
  total_paid: number
  paid_count: number
  unpaid_count: number
  waived_count: number
  basket_contribution: number
  is_final_cycle: boolean
}

export interface PaginatedResponse<T> {
  items: T[]
  next_cursor: string | null
  has_more: boolean
}

export type NotificationType =
  | 'PAYMENT_DUE'
  | 'PAYMENT_RECEIVED'
  | 'WINNER_ANNOUNCED'
  | 'LOAN_DISBURSED'
  | 'SKIP_MONTH_DECLARED'
  | 'DEFAULTER_REMINDER'
  | 'BASKET_ADJUSTED'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  body: string
  group_id: string | null
  group_name: string | null
  data: Record<string, unknown> | null
  read_at: string | null
  created_at: string
}

export interface NotificationListResponse {
  items: Notification[]
  next_cursor: string | null
  has_more: boolean
  unread_count: number
}

export interface Member {
  membership_id: string
  user_id: string
  name: string
  mobile_number: string
  role: 'Admin' | 'Member'
  share_count: number
  wins_count: number
  admin_withdrawal_used: boolean
  status: string
  joined_at: string
  is_eligible_to_win: boolean
}

export interface Payment {
  payment_id: string
  member_user_id: string
  member_name: string
  share_count: number
  expected_amount: number
  paid_amount: number
  status: 'Paid' | 'Unpaid' | 'Waived'
  paid_at: string | null
  marked_by: string | null
  notes: string | null
}

export interface PaymentListResponse {
  data: Payment[]
  summary: CycleSummary
}

export interface MemberPaymentHistoryItem {
  payment_id: string
  cycle_month_label: string
  expected_amount: number
  paid_amount: number
  status: 'Paid' | 'Unpaid' | 'Waived'
  paid_at: string | null
  is_skip_month: boolean
}

export interface BasketOverview {
  basket_id: string
  current_balance: number
  total_credited: number
  total_debited: number
  total_lent_out: number
  total_interest_earned: number
  active_loans_count?: number
  last_recomputed_at?: string | null
  my_share_if_closed_today?: number
}

export interface LoanRepaymentHistoryItem {
  /** 'LOAN_REPAID' = principal repayment; 'INTEREST_ACCRUED' = interest payment */
  txn_type: 'LOAN_REPAID' | 'INTEREST_ACCRUED'
  amount: number
  cycle_month_number: number | null
  cycle_month_label: string | null
  /** e.g. "Cycle 5" */
  cycle_label: string | null
}

export interface Loan {
  loan_id: string
  borrower_user_id: string
  borrower_name: string
  principal: number
  monthly_interest_rate: string
  disbursement_month_number: number
  /** e.g. "Nov 2025" */
  disbursement_month_label: string | null
  cycle_label: string
  total_interest_paid: number
  outstanding_interest: number
  disbursed_at: string | null
  expected_close_date: string | null
  status: 'Active' | 'Repaid' | 'WrittenOff'
  next_cycle_due_date: string | null
  notes: string | null
  repayment_history: LoanRepaymentHistoryItem[]
  /** Cycle number in which the loan was fully settled (principal repaid) */
  settlement_cycle_number: number | null
  /** Month label of the settlement cycle, e.g. "Feb 2026" */
  settlement_cycle_label: string | null
}

export interface BulkRepayResponse {
  loans_repaid: number
  total_amount: number
}

export interface DisburseLoanResponse {
  loan_id: string
  borrower_user_id: string
  principal: number
  monthly_interest_rate: number
  disbursed_at: string | null
  status: 'Active'
  basket_balance_after: number
  warnings: string[]
}

export interface BasketTransaction {
  txn_id: string
  txn_type: string
  direction: 'C' | 'D'
  amount: number
  cycle_month_label: string | null
  cycle_month_number: number | null
  counterparty_name: string | null
  loan_borrower_name: string | null
  notes: string | null
  created_at: string
  related_loan_id: string | null
  loan_disbursement_month_number: number | null
  loan_disbursement_label: string | null
  /** Computed on the frontend — running basket balance after this transaction. */
  running_balance?: number
}

export interface TransactionListResponse {
  data: BasketTransaction[]
  next_cursor: string | null
  has_more: boolean
}

export interface ActivityItem {
  id: string
  event_type: string
  actor_id: string | null
  actor_name: string | null
  summary: string
  data: Record<string, unknown>
  created_at: string
}

export interface CycleItem {
  cycle_id: string
  month_number: number
  month_label: string
  due_date: string
  status: 'Open' | 'Closed' | 'Pending'
  is_skip_month: boolean
  winners: CycleWinner[]
  collected_amount: number
  expected_amount: number
  paid_count: number
  total_count: number
}

export interface CycleDetailPayment {
  payment_id: string
  member_user_id: string
  member_name: string
  share_count: number
  expected_amount: number
  paid_amount: number
  status: 'Paid' | 'Unpaid' | 'Waived'
  paid_at: string | null
  marked_by_name: string | null
  notes: string | null
}

export interface CycleDetail extends CycleItem {
  notes: string | null
  opened_at: string
  closed_at: string | null
  is_editable: boolean
  is_final_cycle: boolean
  basket_contribution: number
  waived_count: number
  basket_impact: {
    balance_before: number
    balance_after: number
    delta: number
    related_txn_id: string
  } | null
  payments: CycleDetailPayment[]
}

export interface MemberWin {
  month_number: number
  month_label: string
  winner_number: number
  bid_amount: number
  admin_commission: number
  basket_credit: number
  winner_takeaway: number
  is_admin_withdrawal: boolean
}
