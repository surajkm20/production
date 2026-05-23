export type IntentType = 'query' | 'report' | 'calculation' | 'validation' | 'unknown';

export interface GroupContext {
  id: string;
  name: string;
  status: string;
  pool_amount: number;
  monthly_contribution: number;
  total_months: number;
  admin_commission_rate: string;
  monthly_interest_rate: string;
}

export interface CycleContext {
  id: string;
  month_number: number;
  month_label: string;
  status: 'Open' | 'Closed';
  due_date: string;
}

export interface WinnerContext {
  winner_user_id: string;
  winner_number: number;
  bid_amount: number;
  winner_takeaway: number;
  basket_credit: number;
}

export interface BasketContext {
  id: string;
  current_balance: number;
  total_lent_out: number;
  total_interest_earned: number;
}

export interface MemberContext {
  user_id: string;
  name: string;
  role: string;
  share_count: number;
  wins_count: number;
  status: string;
}

export interface WorkflowState {
  query: string;
  intentType: IntentType;
  groupId?: string;
  userId?: string;
  cycleId?: string;

  // Lazily populated by contextNode only — never pre-loaded
  context: {
    group?: GroupContext;
    cycle?: CycleContext;
    winners?: WinnerContext[];
    basket?: BasketContext;
    members?: MemberContext[];
  };

  // Accumulated by nodes; later nodes read what earlier ones wrote
  result: {
    data?: Record<string, unknown>;
    validationErrors?: string[];
    calculatedAmount?: number;
    response?: string;
  };

  // Execution tracing — useful for debugging and token audit
  meta: {
    nodesExecuted: string[];
    durationMs: Record<string, number>;
    cacheHits: number;
    tokenUsage: { input: number; output: number };
    errors: string[];
  };
}

export function createState(
  query: string,
  params: { groupId?: string; userId?: string; cycleId?: string } = {},
): WorkflowState {
  return {
    query,
    intentType: 'unknown',
    ...params,
    context: {},
    result: {},
    meta: {
      nodesExecuted: [],
      durationMs: {},
      cacheHits: 0,
      tokenUsage: { input: 0, output: 0 },
      errors: [],
    },
  };
}
