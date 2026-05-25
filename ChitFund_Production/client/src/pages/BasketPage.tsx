import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise, initials } from '../lib/format'
import type {
  GroupDetail, BasketOverview, Loan, BasketTransaction,
  TransactionListResponse, Member, DisburseLoanResponse, CycleItem, BulkRepayResponse,
} from '../types/api'

type Tab = 'loans' | 'ledger' | 'closed'
type LedgerView = 'byLoan' | 'byCycle'
type BulkMode = 'interest_only' | 'principal_only' | 'full_settlement'

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function LoanStatusBadge({ status }: { status: string }) {
  if (status === 'Active') {
    return <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Active</span>
  }
  if (status === 'Repaid') {
    return <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Repaid</span>
  }
  return <span className="text-[11px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-600 font-medium">Written off</span>
}

function txnLabel(txn_type: string): string {
  const map: Record<string, string> = {
    LOAN_DISBURSED:          'Loan disbursed',
    LOAN_REPAID:             'Principal repaid',
    INTEREST_ACCRUED:        'Interest earned',
    CREDIT_DISCOUNT:         'Bid discount',
    BID_TO_BASKET:           'Bid → basket',
    DEBIT_SKIP_MONTH:        'Skip month payout',
    DEBIT_X_CHITI:           'X-Chiti payout',
    DEBIT_FINAL_CYCLE_OFFSET:'Final cycle offset',
    SKIP_MONTH_DEBIT:        'Skip month payout',
    ADJUSTMENT:              'Manual adjustment',
    CLOSURE_SPLIT:           'Closure split',
  }
  return map[txn_type] ?? txn_type
}

// ─── LedgerTimeline ────────────────────────────────────────────────────────────

type LoanGroup = {
  loan_id: string
  borrower_name: string | null
  disbursement_label: string | null
  disbursement_month: number | null
  transactions: BasketTransaction[]
}

function loanRepaidTxnLabel(txn: BasketTransaction): string {
  if (txn.txn_type === 'LOAN_DISBURSED') return 'Disbursed'
  if (txn.txn_type === 'INTEREST_ACCRUED') return 'Interest'
  if (txn.txn_type === 'LOAN_REPAID') return 'Principal'
  return txnLabel(txn.txn_type)
}

function loanTxnColors(txn: BasketTransaction): { bg: string; text: string; amount: string } {
  if (txn.txn_type === 'LOAN_DISBURSED')
    return { bg: 'bg-indigo-50', text: 'text-indigo-700', amount: 'text-indigo-600' }
  if (txn.txn_type === 'INTEREST_ACCRUED')
    return { bg: 'bg-amber-50', text: 'text-amber-700', amount: 'text-amber-600' }
  if (txn.txn_type === 'LOAN_REPAID')
    return { bg: 'bg-green-50', text: 'text-green-700', amount: 'text-green-600' }
  return { bg: 'bg-gray-50', text: 'text-gray-600', amount: 'text-gray-700' }
}

function otherTxnColors(txn_type: string): { icon: string; amount: string } {
  if (txn_type === 'CREDIT_DISCOUNT' || txn_type === 'BID_TO_BASKET')
    return { icon: 'text-green-600', amount: 'text-green-600' }
  if (txn_type === 'DEBIT_FINAL_CYCLE_OFFSET' || txn_type === 'DEBIT_SKIP_MONTH' || txn_type === 'DEBIT_X_CHITI')
    return { icon: 'text-red-500', amount: 'text-red-500' }
  if (txn_type === 'CLOSURE_SPLIT')
    return { icon: 'text-indigo-600', amount: 'text-indigo-600' }
  return { icon: 'text-gray-500', amount: 'text-gray-700' }
}

function LoanLifecycleCard({ group }: { group: LoanGroup }) {
  const [expanded, setExpanded] = useState(false)

  const disburseRow   = group.transactions.find(t => t.txn_type === 'LOAN_DISBURSED')
  const repaidRows    = group.transactions.filter(t => t.txn_type === 'LOAN_REPAID')
  const principal     = disburseRow ? disburseRow.amount : 0
  const totalRepaid   = repaidRows.reduce((s, t) => s + t.amount, 0)
  const fullyRepaid   = principal > 0 && totalRepaid >= principal
  const partiallyRepaid = !fullyRepaid && totalRepaid > 0
  const progressPct   = principal > 0 ? Math.min(100, Math.round((totalRepaid / principal) * 100)) : 0

  const label = group.disbursement_label
    ?? (group.disbursement_month != null ? `Cycle ${group.disbursement_month}` : 'Unknown cycle')

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      {/* Card header */}
      <button
        className="w-full flex items-start gap-3 px-4 py-3.5 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-indigo-700 text-xs font-bold">L</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-800 truncate">
              {group.borrower_name ?? 'Unknown'} · Loan
            </p>
            <span className="text-[11px] text-gray-400 font-normal">{label}</span>
          </div>
          {principal > 0 && (
            <p className="text-xs text-gray-400 mt-0.5">{formatPaise(principal)}</p>
          )}
          {/* Status badge */}
          <div className="flex items-center gap-2 mt-1.5">
            {fullyRepaid ? (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">Fully Repaid</span>
            ) : partiallyRepaid ? (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Partially Repaid</span>
            ) : (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">Active</span>
            )}
            {principal > 0 && (
              <span className="text-[11px] text-gray-400">{progressPct}% repaid</span>
            )}
          </div>
          {/* Progress bar */}
          {principal > 0 && (
            <div className="mt-1.5 h-1 bg-gray-100 rounded-full overflow-hidden w-full">
              <div
                className={`h-full rounded-full ${fullyRepaid ? 'bg-emerald-400' : 'bg-indigo-400'}`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform shrink-0 mt-1 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded transaction rows */}
      {expanded && (
        <div className="border-t border-gray-50 divide-y divide-gray-50">
          {group.transactions.map(txn => {
            const colors = loanTxnColors(txn)
            const cycleLabel = txn.cycle_month_number != null
              ? `Cycle ${txn.cycle_month_number}`
              : txn.cycle_month_label ?? null
            return (
              <div key={txn.txn_id} className="flex items-center gap-3 px-4 py-2.5">
                <div className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${colors.bg} ${colors.text}`}>
                  {loanRepaidTxnLabel(txn)}
                </div>
                <div className="flex-1 min-w-0">
                  {cycleLabel && (
                    <p className="text-xs font-medium text-gray-700">{cycleLabel} repayment</p>
                  )}
                  <p className="text-[11px] text-gray-400">{fmtDate(txn.created_at)}</p>
                </div>
                <p className={`text-sm font-semibold shrink-0 ${colors.amount}`}>
                  {txn.direction === 'C' ? '+' : '−'}{formatPaise(txn.amount)}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function OtherActivityRow({ txn }: { txn: BasketTransaction }) {
  const colors = otherTxnColors(txn.txn_type)
  const cycleLabel = txn.cycle_month_number != null
    ? `Cycle ${txn.cycle_month_number}`
    : txn.cycle_month_label ?? null

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-sm ${txn.direction === 'C' ? 'bg-green-50' : 'bg-red-50'}`}>
        <span className={`text-sm font-bold ${colors.icon}`}>{txn.direction === 'C' ? '↑' : '↓'}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800">{txnLabel(txn.txn_type)}</p>
        <p className="text-xs text-gray-400 truncate">
          {cycleLabel ? `${cycleLabel} · ` : ''}
          {txn.counterparty_name ? `${txn.counterparty_name} · ` : ''}
          {fmtDate(txn.created_at)}
        </p>
        {txn.notes && <p className="text-xs text-gray-400 truncate">{txn.notes}</p>}
      </div>
      <p className={`text-sm font-semibold shrink-0 ${colors.amount}`}>
        {txn.direction === 'C' ? '+' : '−'}{formatPaise(txn.amount)}
      </p>
    </div>
  )
}

function LedgerTimeline({ transactions }: { transactions: BasketTransaction[] }) {
  if (transactions.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-10">No transactions yet.</p>
  }

  // Partition: loan-linked vs other
  const loanTxns:  BasketTransaction[] = []
  const otherTxns: BasketTransaction[] = []

  for (const txn of transactions) {
    if (txn.related_loan_id) loanTxns.push(txn)
    else otherTxns.push(txn)
  }

  // Group loan transactions by loan_id
  const loanGroupMap = new Map<string, LoanGroup>()
  for (const txn of loanTxns) {
    const lid = txn.related_loan_id!
    if (!loanGroupMap.has(lid)) {
      loanGroupMap.set(lid, {
        loan_id:             lid,
        borrower_name:       txn.loan_borrower_name ?? txn.counterparty_name,
        disbursement_label:  txn.loan_disbursement_label,
        disbursement_month:  txn.loan_disbursement_month_number,
        transactions:        [],
      })
    }
    loanGroupMap.get(lid)!.transactions.push(txn)
  }

  // Sort transactions within each group chronologically (disbursement → repayments)
  for (const group of loanGroupMap.values()) {
    group.transactions.sort((a, b) =>
      new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
    )
  }

  // Separate active/partial from fully repaid, sort each section by disbursement month
  const isGroupRepaid = (g: LoanGroup) => {
    const principal   = g.transactions.find(t => t.txn_type === 'LOAN_DISBURSED')?.amount ?? 0
    const totalRepaid = g.transactions.filter(t => t.txn_type === 'LOAN_REPAID').reduce((s, t) => s + t.amount, 0)
    return principal > 0 && totalRepaid >= principal
  }
  const byDisbursement = (a: LoanGroup, b: LoanGroup) =>
    (a.disbursement_month ?? 0) - (b.disbursement_month ?? 0)

  const allGroups   = [...loanGroupMap.values()]
  const activeGroups = allGroups.filter(g => !isGroupRepaid(g)).sort(byDisbursement)
  const repaidGroups = allGroups.filter(g =>  isGroupRepaid(g)).sort(byDisbursement)

  return (
    <div className="space-y-3">
      {/* Active / partially-repaid loans */}
      {activeGroups.length > 0 && (
        <div className="space-y-2">
          {activeGroups.map(group => (
            <LoanLifecycleCard key={group.loan_id} group={group} />
          ))}
        </div>
      )}

      {/* Fully repaid loans — shown under a section header */}
      {repaidGroups.length > 0 && (
        <div className="space-y-2">
          {activeGroups.length > 0 && (
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest px-1 pt-1">
              Repaid Loans
            </p>
          )}
          {repaidGroups.map(group => (
            <LoanLifecycleCard key={group.loan_id} group={group} />
          ))}
        </div>
      )}

      {/* Other basket activity */}
      {otherTxns.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest px-4 pt-3 pb-1">
            Other Basket Activity
          </p>
          <div className="divide-y divide-gray-50">
            {otherTxns.map(txn => (
              <OtherActivityRow key={txn.txn_id} txn={txn} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── CycleLedger ─────────────────────────────────────────────────────────────
//
// Groups basket_transactions by cycle month number and renders one card per
// cycle. Only transactions that are stamped with a cycle_id are shown here;
// loan disbursements / repayments that cross cycle boundaries are listed under
// the cycle they were tagged to when recorded.
//
// What IS shown per cycle:
//   CREDIT_DISCOUNT / BID_TO_BASKET → Bid discount credited to basket  (+)
//   DEBIT_X_CHITI                   → X-Chiti pool payout from basket  (-)
//   DEBIT_SKIP_MONTH                → Skip-month payout from basket     (-)
//   DEBIT_FINAL_CYCLE_OFFSET        → Final-cycle basket offset         (-)
//   LOAN_DISBURSED                  → Loan disbursed from basket        (-)
//   LOAN_REPAID                     → Principal repaid to basket        (+)
//   INTEREST_ACCRUED                → Interest recovered to basket      (+)
//   ADJUSTMENT                      → Manual basket adjustment          (+/-)
//
// The Pool Amount (winner takeaway) is NOT a basket transaction — it flows
// directly from member contributions to the winner and never touches the basket
// balance. It therefore does NOT appear here.

type CycleGroup = {
  month_number:    number
  month_label:     string | null
  transactions:    BasketTransaction[]
  openingBalance:  number
  closingBalance:  number
}

// ─── helpers shared by CycleLedger components ─────────────────────────────────

function simpleTxnLabel(txn_type: string): string {
  const map: Record<string, string> = {
    CREDIT_DISCOUNT:          'Bid Discount to Basket',
    BID_TO_BASKET:            'Bid Discount to Basket',
    DEBIT_X_CHITI:            'X-Chiti Payout',
    DEBIT_SKIP_MONTH:         'Skip-Month Payout',
    SKIP_MONTH_DEBIT:         'Skip-Month Payout',
    DEBIT_FINAL_CYCLE_OFFSET: 'Final-Cycle Basket Offset',
    ADJUSTMENT:               'Manual Adjustment',
    CLOSURE_SPLIT:            'Closure Split',
  }
  return map[txn_type] ?? txn_type
}

function simpleTxnColors(direction: 'C' | 'D'): { dot: string; amount: string } {
  return direction === 'C'
    ? { dot: 'bg-green-500', amount: 'text-green-600' }
    : { dot: 'bg-red-400',   amount: 'text-red-500'   }
}

// Simple single-row for non-loan transaction types
function CycleTxnRow({ txn }: { txn: BasketTransaction }) {
  const { dot, amount } = simpleTxnColors(txn.direction)
  const who = txn.counterparty_name ?? null

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-700">{simpleTxnLabel(txn.txn_type)}</p>
        {who && <p className="text-xs text-gray-400 truncate">{who}</p>}
        {txn.notes && !who && (
          <p className="text-xs text-gray-400 truncate">{txn.notes}</p>
        )}
      </div>
      <p className={`text-sm font-semibold shrink-0 tabular-nums ${amount}`}>
        {txn.direction === 'C' ? '+' : '−'}{formatPaise(txn.amount)}
      </p>
    </div>
  )
}

// Collapsible aggregate row for LOAN_DISBURSED transactions
function LoanDisbursedGroup({ txns }: { txns: BasketTransaction[] }) {
  const [open, setOpen] = useState(false)
  const total = txns.reduce((s, t) => s + t.amount, 0)

  return (
    <div>
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        <span className="w-2 h-2 rounded-full shrink-0 bg-red-400" />
        <p className="flex-1 text-sm text-gray-700">Loan Disbursed</p>
        <p className="text-sm font-semibold shrink-0 tabular-nums text-red-500 mr-1">
          −{formatPaise(total)}
        </p>
        <svg
          className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="pb-1">
          {txns.map(t => (
            <div key={t.txn_id} className="flex items-center gap-3 pl-10 pr-4 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-red-300 shrink-0" />
              <p className="flex-1 text-xs text-gray-500 truncate">
                {t.loan_borrower_name ?? t.counterparty_name ?? 'Unknown'}
              </p>
              <p className="text-xs font-medium tabular-nums text-red-400 shrink-0">
                −{formatPaise(t.amount)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Collapsible aggregate row for LOAN_REPAID + INTEREST_ACCRUED transactions
function LoanRecoveryGroup({ txns }: { txns: BasketTransaction[] }) {
  const [open, setOpen] = useState(false)
  const total = txns.reduce((s, t) => s + t.amount, 0)

  return (
    <div>
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        <span className="w-2 h-2 rounded-full shrink-0 bg-green-500" />
        <p className="flex-1 text-sm text-gray-700">Loan Recovery</p>
        <p className="text-sm font-semibold shrink-0 tabular-nums text-green-600 mr-1">
          +{formatPaise(total)}
        </p>
        <svg
          className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="pb-1">
          {txns.map(t => {
            const label = t.txn_type === 'INTEREST_ACCRUED' ? 'interest' : 'principal'
            const name  = t.loan_borrower_name ?? t.counterparty_name ?? 'Unknown'
            return (
              <div key={t.txn_id} className="flex items-center gap-3 pl-10 pr-4 py-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-300 shrink-0" />
                <p className="flex-1 text-xs text-gray-500 truncate">
                  {name} <span className="text-gray-400">({label})</span>
                </p>
                <p className="text-xs font-medium tabular-nums text-green-500 shrink-0">
                  +{formatPaise(t.amount)}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CycleGroupCard({ group }: { group: CycleGroup }) {
  const [expanded, setExpanded] = useState(false)

  const label = group.month_label ?? `Cycle ${group.month_number}`

  // Partition transactions into three buckets:
  //   disbursements → collapsible LOAN_DISBURSED group
  //   recoveries    → collapsible LOAN_REPAID + INTEREST_ACCRUED group
  //   simple        → all other types, each a plain row
  const disbursements = group.transactions.filter(t => t.txn_type === 'LOAN_DISBURSED')
  const recoveries    = group.transactions.filter(t => t.txn_type === 'LOAN_REPAID' || t.txn_type === 'INTEREST_ACCRUED')
  const simpleRows    = group.transactions.filter(t =>
    t.txn_type !== 'LOAN_DISBURSED' && t.txn_type !== 'LOAN_REPAID' && t.txn_type !== 'INTEREST_ACCRUED'
  )

  // Build an ordered list of display items to preserve rough chronological order:
  // simple rows first (bid discount etc.), then disbursements, then recoveries.
  // This gives the financial-flow feel described in the spec.
  const txnCount = group.transactions.length

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      {/* Collapsed header */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        {/* Cycle avatar */}
        <div className="w-9 h-9 rounded-full bg-maroon-50 flex items-center justify-center shrink-0">
          <span className="text-[11px] font-bold text-maroon-700">M{group.month_number}</span>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800">{label}</p>
          <p className="text-xs text-gray-400">
            {txnCount} transaction{txnCount !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Closing basket balance */}
        <p className="text-sm font-semibold shrink-0 tabular-nums mr-1 text-gray-800">
          {formatPaise(group.closingBalance)}
        </p>

        <svg
          className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-100">
          {/* Opening balance */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50">
            <p className="text-xs font-medium text-gray-500">Opening Balance</p>
            <p className="text-xs font-semibold tabular-nums text-gray-700">
              {formatPaise(group.openingBalance)}
            </p>
          </div>

          {/* Top dashed divider */}
          <div className="mx-4 border-t border-dashed border-gray-200" />

          {/* Line items — simple rows, then disbursements group, then recoveries group */}
          <div className="divide-y divide-gray-50">
            {simpleRows.map(txn => (
              <CycleTxnRow key={txn.txn_id} txn={txn} />
            ))}
            {disbursements.length > 0 && (
              <LoanDisbursedGroup txns={disbursements} />
            )}
            {recoveries.length > 0 && (
              <LoanRecoveryGroup txns={recoveries} />
            )}
          </div>

          {/* Bottom dashed divider */}
          <div className="mx-4 border-t border-dashed border-gray-200" />

          {/* Closing balance */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50">
            <p className="text-xs font-medium text-gray-500">Closing Balance</p>
            <p className="text-xs font-bold tabular-nums text-gray-800">
              {formatPaise(group.closingBalance)}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function CycleLedger({ transactions }: { transactions: BasketTransaction[] }) {
  if (transactions.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-10">No transactions yet.</p>
  }

  // The API returns transactions newest-first (desc created_at).
  // Reverse to chronological order so we can compute a running balance forward.
  const chronological = [...transactions].reverse()

  // Attach a running_balance to every transaction (cumulative, credits +, debits −).
  let runningBal = 0
  const withBalance: BasketTransaction[] = chronological.map(txn => {
    runningBal += txn.direction === 'C' ? txn.amount : -txn.amount
    return { ...txn, running_balance: runningBal }
  })

  // Resolve effective cycle for each transaction.
  // LOAN_DISBURSED falls back to loan_disbursement_month_number when cycle_month_number is absent.
  // All other types (LOAN_REPAID, INTEREST_ACCRUED, …) only use cycle_month_number — if it is
  // null the transaction is left untagged (honest gap).
  const cycleTagged: BasketTransaction[] = []
  const untagged:    BasketTransaction[] = []
  for (const txn of withBalance) {
    const effectiveMn = txn.cycle_month_number ??
      (txn.txn_type === 'LOAN_DISBURSED' ? txn.loan_disbursement_month_number : null)
    const effectiveLabel = txn.cycle_month_label ??
      (txn.txn_type === 'LOAN_DISBURSED' ? txn.loan_disbursement_label : null)

    if (effectiveMn != null) {
      cycleTagged.push({ ...txn, cycle_month_number: effectiveMn, cycle_month_label: effectiveLabel })
    } else {
      untagged.push(txn)
    }
  }

  // Group cycle-tagged transactions by effective month_number (already in chronological order)
  const groupMap = new Map<number, { month_number: number; month_label: string | null; transactions: BasketTransaction[] }>()
  for (const txn of cycleTagged) {
    const mn = txn.cycle_month_number!
    if (!groupMap.has(mn)) {
      groupMap.set(mn, { month_number: mn, month_label: txn.cycle_month_label, transactions: [] })
    }
    groupMap.get(mn)!.transactions.push(txn)
  }

  // Sort cycles ascending (earliest first) and compute opening/closing balances.
  // Opening balance of cycle N = running_balance of first txn minus its signed amount.
  // Closing balance of cycle N = running_balance of last txn.
  const cycleGroups: CycleGroup[] = [...groupMap.values()]
    .sort((a, b) => a.month_number - b.month_number)
    .map(g => {
      const first = g.transactions[0]
      const last  = g.transactions[g.transactions.length - 1]
      const firstSignedAmount = first.direction === 'C' ? first.amount : -first.amount
      const openingBalance    = (first.running_balance ?? 0) - firstSignedAmount
      const closingBalance    = last.running_balance ?? 0
      return { ...g, openingBalance, closingBalance }
    })

  return (
    <div className="space-y-3">
      {cycleGroups.map(group => (
        <CycleGroupCard key={group.month_number} group={group} />
      ))}

      {/* Transactions not tagged to any cycle */}
      {untagged.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest px-4 pt-3 pb-1">
            No Cycle
          </p>
          <div className="divide-y divide-gray-50">
            {untagged.map(txn => (
              <CycleTxnRow key={txn.txn_id} txn={txn} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── New loan modal ───────────────────────────────────────────────────────────

function NewLoanModal({ groupId, members, interestRate, monthlyContribution, totalMonths, basketBalance: _basketBalance, activeLoans, onClose, onSaved }: {
  groupId: string
  members: Member[]
  interestRate: string
  monthlyContribution: number
  totalMonths: number
  basketBalance: number
  activeLoans: Loan[]
  onClose: () => void
  onSaved: (warnings: string[]) => void
}) {
  const [borrowerId, setBorrowerId] = useState('')
  const [amountRupees, setAmountRupees] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const principal = Math.round(parseFloat(amountRupees) * 100) || 0

  const selectedMember = members.find(m => m.user_id === borrowerId)
  const remainingShares = selectedMember ? selectedMember.share_count - selectedMember.wins_count : 0
  const allSharesWithdrawn = !!selectedMember && remainingShares <= 0
  const perShareValue = monthlyContribution * totalMonths
  const eligibilityCap = selectedMember ? remainingShares * perShareValue : 0
  const exceedsEligibility = selectedMember && !allSharesWithdrawn && principal > 0 && principal > eligibilityCap
  const borrowerHasActiveLoan = activeLoans.some(l => l.borrower_user_id === borrowerId)

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    if (!borrowerId || principal <= 0) return
    setLoading(true)
    setError(null)
    try {
      const result = await api.post<DisburseLoanResponse>(`/groups/${groupId}/loans`, {
        borrower_user_id: borrowerId,
        principal,
        ...(dueDate ? { expected_close_date: dueDate } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      onSaved(result.warnings)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to disburse loan.')
    } finally {
      setLoading(false)
    }
  }

  const monthlyInterest = principal > 0 ? Math.round(principal * parseFloat(interestRate || '0') / 100) : 0

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-bold text-gray-900 mb-4">New loan</h2>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-4">

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Borrower</label>
            <select
              value={borrowerId}
              onChange={e => { setBorrowerId(e.target.value); setAmountRupees('') }}
              required
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent bg-white"
            >
              <option value="">Select member</option>
              {members.map(m => (
                <option key={m.user_id} value={m.user_id}>{m.name}</option>
              ))}
            </select>
            {allSharesWithdrawn && (
              <div className="mt-1 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                Caution: this member has already withdrawn all their shares. Proceeding on admin's discretion.
              </div>
            )}
            {borrowerHasActiveLoan && (
              <p className="text-xs text-amber-600 mt-1">This member already has an active loan. A second loan will be recorded with a warning.</p>
            )}
            {selectedMember && !allSharesWithdrawn && (
              <p className="text-xs text-gray-400 mt-1">
                {remainingShares} share{remainingShares !== 1 ? 's' : ''} · eligible for {formatPaise(eligibilityCap)} ({remainingShares} × {formatPaise(perShareValue)}/share)
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Principal amount (₹)</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">₹</span>
              <input
                type="number"
                value={amountRupees}
                onChange={e => setAmountRupees(e.target.value)}
                placeholder="15,000"
                min="1"
                step="1"
                required
                className="w-full pl-8 pr-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent"
              />
            </div>
            {principal > 0 && (
              <div className="mt-2 bg-maroon-50 rounded-lg px-3 py-2 text-xs text-maroon-700">
                <p>Rate: {interestRate}%/month · Monthly interest: {formatPaise(monthlyInterest)}</p>
              </div>
            )}
            {exceedsEligibility && (
              <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                Warning: {formatPaise(principal)} exceeds this member's eligibility of {formatPaise(eligibilityCap)}. You can still proceed — this is admin's discretion.
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Expected close date <span className="text-gray-400">(optional)</span></label>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              min={today()}
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Notes <span className="text-gray-400">(optional)</span></label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Emergency medical"
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={loading || !borrowerId || principal <= 0} className="flex-1 py-2.5 rounded-lg bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white">
              {loading ? 'Disbursing…' : 'Disburse'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Repay loan modal ─────────────────────────────────────────────────────────

function RepayLoanModal({ groupId, loans, cycles, currentCycleId, onClose, onSaved }: {
  groupId: string
  loans: Loan[]
  cycles: CycleItem[]
  currentCycleId: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const [loanId, setLoanId]               = useState(loans[0]?.loan_id ?? '')
  const [principalPaid, setPrincipalPaid] = useState(false)
  const [interestRupees, setInterestRupees] = useState('')
  const [cycleId, setCycleId]             = useState('')
  const [notes, setNotes]                 = useState('')
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState<string | null>(null)

  const selectedLoan      = loans.find(l => l.loan_id === loanId)
  const selectedCycle     = cycles.find(c => c.cycle_id === cycleId)
  const principalAmount   = selectedLoan ? Number(selectedLoan.principal) : 0
  const outstandingInterest = selectedLoan ? Number(selectedLoan.outstanding_interest) : 0
  const interestPaidPaise = Math.round(parseFloat(interestRupees) * 100) || 0
  const interestExceedsOutstanding = interestPaidPaise > outstandingInterest

  function handleLoanChange(id: string) {
    setLoanId(id)
    setPrincipalPaid(false)
    setInterestRupees('')
  }

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    if (!loanId || (!principalPaid && interestPaidPaise <= 0) || !selectedCycle) return
    setLoading(true)
    setError(null)
    try {
      await api.post(`/groups/${groupId}/loans/${loanId}/repay`, {
        ...(principalPaid         ? { principal_repaid: principalAmount }   : {}),
        ...(interestPaidPaise > 0 ? { interest_paid: interestPaidPaise }    : {}),
        txn_date: selectedCycle.due_date,
        cycle_id: cycleId,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to record repayment.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
        <h2 className="text-base font-bold text-gray-900 mb-4">Record repayment</h2>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-4">

          {/* Loan selector */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Loan</label>
            <select
              value={loanId}
              onChange={e => handleLoanChange(e.target.value)}
              required
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 bg-white"
            >
              {loans.map(l => (
                <option key={l.loan_id} value={l.loan_id}>
                  {l.borrower_name} — {formatPaise(l.principal)}
                </option>
              ))}
            </select>
          </div>

          {selectedLoan && (
            <div className="space-y-2">
              {/* Principal row */}
              <div className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
                <div>
                  <p className="text-xs text-gray-400 mb-0.5">Principal (full repayment only)</p>
                  <p className="text-sm font-bold text-gray-900">{formatPaise(principalAmount)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setPrincipalPaid(v => !v)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    principalPaid
                      ? 'bg-green-100 text-green-700 border border-green-200'
                      : 'bg-white text-maroon-600 border border-maroon-200 hover:bg-maroon-50'
                  }`}
                >
                  {principalPaid
                    ? <><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>Marked</>
                    : 'Pay in full'}
                </button>
              </div>

              {/* Interest row — cumulative outstanding amount */}
              <div className="bg-gray-50 rounded-xl px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">
                      Outstanding interest ({selectedLoan.monthly_interest_rate}%/mo, cumulative)
                    </p>
                    <p className={`text-sm font-bold ${outstandingInterest > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                      {outstandingInterest > 0 ? formatPaise(outstandingInterest) : 'None'}
                    </p>
                  </div>
                  {outstandingInterest > 0 && (
                    <button
                      type="button"
                      onClick={() => setInterestRupees(String(outstandingInterest / 100))}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-maroon-600 border border-maroon-200 hover:bg-maroon-50 transition"
                    >
                      Pay all
                    </button>
                  )}
                </div>
                {outstandingInterest > 0 && (
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">₹</span>
                    <input
                      type="number"
                      value={interestRupees}
                      onChange={e => setInterestRupees(e.target.value)}
                      placeholder="0"
                      min="0"
                      max={outstandingInterest / 100}
                      step="0.01"
                      className={`w-full pl-8 pr-4 py-2 rounded-lg border text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 bg-white ${
                        interestExceedsOutstanding ? 'border-red-400' : 'border-gray-300'
                      }`}
                    />
                  </div>
                )}
                {interestExceedsOutstanding && (
                  <p className="text-xs text-red-500">
                    Cannot exceed outstanding interest ({formatPaise(outstandingInterest)})
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Cycle month */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Month repayment was received <span className="text-red-500">*</span>
            </label>
            <select
              value={cycleId}
              onChange={e => setCycleId(e.target.value)}
              required
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 bg-white"
            >
              <option value="" disabled>Select the month repayment was made…</option>
              {cycles.map(c => (
                <option key={c.cycle_id} value={c.cycle_id}>
                  {c.month_label}{c.cycle_id === currentCycleId ? ' (current)' : ''}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-amber-600 mt-1">
              Select the actual month the repayment was received — not the current cycle.
            </p>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Notes <span className="text-gray-400">(optional)</span></label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
            <button
              type="submit"
              disabled={loading || !loanId || (!principalPaid && interestPaidPaise <= 0) || interestExceedsOutstanding}
              className="flex-1 py-2.5 rounded-lg bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white"
            >
              {loading ? 'Saving…' : 'Record'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Adjust basket modal ──────────────────────────────────────────────────────

function AdjustBasketModal({ groupId, onClose, onSaved }: { groupId: string; onClose: () => void; onSaved: () => void }) {
  const [direction, setDirection] = useState<'C' | 'D'>('C')
  const [amountRupees, setAmountRupees] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const amount = Math.round(parseFloat(amountRupees) * 100) || 0

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    if (amount <= 0 || !notes.trim()) return
    setLoading(true)
    setError(null)
    try {
      await api.post(`/groups/${groupId}/basket/adjustments`, { direction, amount, notes: notes.trim() })
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to adjust basket.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6">
        <h2 className="text-base font-bold text-gray-900 mb-4">Adjust basket</h2>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-4">

          <div className="flex gap-2">
            {(['C', 'D'] as const).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition ${direction === d
                  ? d === 'C' ? 'bg-green-600 text-white border-green-600' : 'bg-red-600 text-white border-red-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
              >
                {d === 'C' ? '↑ Credit (add)' : '↓ Debit (remove)'}
              </button>
            ))}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Amount (₹)</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">₹</span>
              <input
                type="number"
                value={amountRupees}
                onChange={e => setAmountRupees(e.target.value)}
                placeholder="0"
                min="1"
                step="1"
                required
                className="w-full pl-8 pr-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Reason <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Reason is required"
              required
              minLength={1}
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={loading || amount <= 0 || !notes.trim()} className="flex-1 py-2.5 rounded-lg bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white">
              {loading ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── ActiveLoanCard — purely informational, no action buttons ─────────────────

function ActiveLoanCard({ memberLoans }: { memberLoans: Loan[] }) {
  const [expanded, setExpanded] = useState(false)

  const representative   = memberLoans[0]
  const totalPrincipal   = memberLoans.reduce((s, l) => s + Number(l.principal), 0)
  const totalInterest    = memberLoans.reduce((s, l) => s + Number(l.outstanding_interest), 0)
  const totalOutstanding = totalPrincipal + totalInterest

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      {/* Header row */}
      <button
        className="w-full flex items-center gap-3 p-4 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="w-9 h-9 rounded-full bg-maroon-100 flex items-center justify-center text-xs font-bold text-maroon-700 shrink-0">
          {initials(representative.borrower_name)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800">{representative.borrower_name}</p>
          <p className="text-xs text-gray-400">
            {memberLoans.length} loan{memberLoans.length !== 1 ? 's' : ''} · total outstanding {formatPaise(totalOutstanding)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalInterest > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-600 font-medium">
              {formatPaise(totalInterest)} interest
            </span>
          )}
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expanded: loan details only, no action buttons */}
      {expanded && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {memberLoans.map(loan => (
            <div key={loan.loan_id} className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-700">{loan.cycle_label}</p>
                <LoanStatusBadge status={loan.status} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-50 rounded-lg px-2.5 py-2">
                  <p className="text-[10px] text-gray-400 mb-0.5">Loan amount</p>
                  <p className="text-xs font-bold text-gray-800">{formatPaise(loan.principal)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-2.5 py-2">
                  <p className="text-[10px] text-gray-400 mb-0.5">Taken in</p>
                  <p className="text-xs font-bold text-gray-800">{loan.cycle_label ?? '—'}</p>
                </div>
                <div className="bg-gray-50 rounded-lg px-2.5 py-2">
                  <p className="text-[10px] text-gray-400 mb-0.5">Remaining principal</p>
                  <p className="text-xs font-bold text-gray-800">{formatPaise(loan.principal)}</p>
                </div>
                <div className={`rounded-lg px-2.5 py-2 ${loan.outstanding_interest > 0 ? 'bg-amber-50' : 'bg-gray-50'}`}>
                  <p className={`text-[10px] mb-0.5 ${loan.outstanding_interest > 0 ? 'text-amber-500' : 'text-gray-400'}`}>
                    Pending interest
                  </p>
                  <p className={`text-xs font-bold ${loan.outstanding_interest > 0 ? 'text-amber-600' : 'text-gray-800'}`}>
                    {loan.outstanding_interest > 0 ? formatPaise(loan.outstanding_interest) : 'None'}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActiveLoanGroups({ loans: allLoans }: { loans: Loan[] }) {
  const groups = allLoans.reduce<Map<string, Loan[]>>((map, loan) => {
    const existing = map.get(loan.borrower_user_id)
    if (existing) existing.push(loan)
    else map.set(loan.borrower_user_id, [loan])
    return map
  }, new Map())

  return (
    <div className="space-y-2">
      {[...groups.values()].map(memberLoans => (
        <ActiveLoanCard
          key={memberLoans[0].borrower_user_id}
          memberLoans={memberLoans}
        />
      ))}
    </div>
  )
}

// ─── RepaymentCard — admin action workflow, grouped by member ─────────────────

function RepaymentCard({
  groupId, memberLoans, isClosed, cycles, currentCycleId, onRepaid,
}: {
  groupId: string
  memberLoans: Loan[]
  isClosed: boolean
  cycles: CycleItem[]
  currentCycleId: string | null
  onRepaid: (msg: string) => void
}) {
  const [expanded, setExpanded]             = useState(false)
  const [bulkLoading, setBulkLoading]       = useState<BulkMode | null>(null)
  const [bulkError, setBulkError]           = useState<string | null>(null)
  const [showRepayModal, setShowRepayModal] = useState(false)
  const [repayLoansList, setRepayLoansList] = useState<Loan[]>(memberLoans)

  const representative   = memberLoans[0]
  const totalPrincipal   = memberLoans.reduce((s, l) => s + Number(l.principal), 0)
  const totalInterest    = memberLoans.reduce((s, l) => s + Number(l.outstanding_interest), 0)
  const totalOutstanding = totalPrincipal + totalInterest

  async function handleBulk(mode: BulkMode) {
    setBulkLoading(mode)
    setBulkError(null)
    try {
      const res: BulkRepayResponse = await api.bulkRepayMember(groupId, {
        member_user_id: representative.borrower_user_id,
        mode,
      })
      const label = mode === 'interest_only'  ? 'Interest paid'
                  : mode === 'principal_only' ? 'Principal repaid'
                  : 'Fully settled'
      onRepaid(`${label} — ${formatPaise(res.total_amount)}`)
    } catch (err) {
      setBulkError(err instanceof ApiError ? err.message : 'Bulk repayment failed.')
    } finally {
      setBulkLoading(null)
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      {/* Header row */}
      <button
        className="w-full flex items-center gap-3 p-4 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="w-9 h-9 rounded-full bg-maroon-100 flex items-center justify-center text-xs font-bold text-maroon-700 shrink-0">
          {initials(representative.borrower_name)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800">{representative.borrower_name}</p>
          <p className="text-xs text-gray-400">
            {memberLoans.length} loan{memberLoans.length !== 1 ? 's' : ''} · {formatPaise(totalOutstanding)} outstanding
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalInterest > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-600 font-medium">
              {formatPaise(totalInterest)} interest
            </span>
          )}
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expanded: repayment options */}
      {expanded && (
        <div className="border-t border-gray-100">
          {/* Per-loan "Repay this loan" buttons */}
          <div className="divide-y divide-gray-50">
            {memberLoans.map(loan => (
              <div key={loan.loan_id} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-700">{loan.cycle_label}</p>
                  <p className="text-xs text-gray-400">
                    {formatPaise(loan.principal)}
                    {loan.outstanding_interest > 0 && ` · ${formatPaise(loan.outstanding_interest)} interest`}
                  </p>
                </div>
                <button
                  onClick={() => { setRepayLoansList([loan]); setShowRepayModal(true) }}
                  disabled={isClosed}
                  className="ml-3 shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border border-maroon-200 text-maroon-700 bg-maroon-50 hover:bg-maroon-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  Repay this loan
                </button>
              </div>
            ))}
          </div>

          {/* Bulk action buttons */}
          <div className="px-4 pb-4 pt-3 space-y-2">
            {bulkError && <p className="text-xs text-red-500">{bulkError}</p>}
            <div className="grid grid-cols-3 gap-2">
              {([
                { mode: 'interest_only'   as BulkMode, label: 'Repay Entire Interest',   amount: totalInterest,    disabled: totalInterest <= 0 },
                { mode: 'principal_only'  as BulkMode, label: 'Repay Entire Principal',  amount: totalPrincipal,   disabled: totalPrincipal <= 0 },
                { mode: 'full_settlement' as BulkMode, label: 'Full Settlement',          amount: totalOutstanding, disabled: totalOutstanding <= 0 },
              ]).map(({ mode, label, amount, disabled }) => (
                <button
                  key={mode}
                  onClick={() => handleBulk(mode)}
                  disabled={!!bulkLoading || disabled || isClosed}
                  className="py-2 px-1 rounded-lg border border-maroon-200 text-maroon-700 bg-maroon-50 hover:bg-maroon-100 disabled:opacity-40 disabled:cursor-not-allowed transition flex flex-col items-center gap-0.5"
                >
                  <span className="text-[11px] font-semibold text-center leading-tight">
                    {bulkLoading === mode ? 'Saving…' : label}
                  </span>
                  {bulkLoading !== mode && (
                    <span className="text-[11px] font-bold">{formatPaise(amount)}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Per-loan repay modal */}
      {showRepayModal && (
        <RepayLoanModal
          groupId={groupId}
          loans={repayLoansList}
          cycles={cycles}
          currentCycleId={currentCycleId}
          onClose={() => setShowRepayModal(false)}
          onSaved={() => { setShowRepayModal(false); onRepaid('Repayment recorded!') }}
        />
      )}
    </div>
  )
}

function RepaymentGroups({
  groupId, loans: allLoans, isClosed, cycles, currentCycleId, onRepaid,
}: {
  groupId: string
  loans: Loan[]
  isClosed: boolean
  cycles: CycleItem[]
  currentCycleId: string | null
  onRepaid: (msg: string) => void
}) {
  const groups = allLoans.reduce<Map<string, Loan[]>>((map, loan) => {
    const existing = map.get(loan.borrower_user_id)
    if (existing) existing.push(loan)
    else map.set(loan.borrower_user_id, [loan])
    return map
  }, new Map())

  return (
    <div className="space-y-2">
      {[...groups.values()].map(memberLoans => (
        <RepaymentCard
          key={memberLoans[0].borrower_user_id}
          groupId={groupId}
          memberLoans={memberLoans}
          isClosed={isClosed}
          cycles={cycles}
          currentCycleId={currentCycleId}
          onRepaid={onRepaid}
        />
      ))}
    </div>
  )
}

// ─── RepaymentSheet — bottom-sheet modal wrapping RepaymentGroups ────────────

function RepaymentSheet({
  groupId, loans, isClosed, cycles, currentCycleId, onClose, onRepaid,
}: {
  groupId: string
  loans: Loan[]
  isClosed: boolean
  cycles: CycleItem[]
  currentCycleId: string | null
  onClose: () => void
  onRepaid: (msg: string) => void
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h2 className="text-base font-bold text-gray-900">Repayment</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 transition">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-3 py-3">
          {loans.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-gray-400">No active loans to repay.</p>
            </div>
          ) : (
            <RepaymentGroups
              groupId={groupId}
              loans={loans}
              isClosed={isClosed}
              cycles={cycles}
              currentCycleId={currentCycleId}
              onRepaid={onRepaid}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── BasketPage ───────────────────────────────────────────────────────────────

export default function BasketPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [group, setGroup] = useState<GroupDetail | null>(null)
  const [basket, setBasket] = useState<BasketOverview | null>(null)
  const [activeLoans, setActiveLoans] = useState<Loan[]>([])
  const [closedLoans, setClosedLoans] = useState<Loan[]>([])
  const [transactions, setTransactions] = useState<BasketTransaction[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [cycles, setCycles] = useState<CycleItem[]>([])
  const [tab, setTab] = useState<Tab>('loans')
  const [ledgerView, setLedgerView] = useState<LedgerView>('byLoan')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showNewLoan, setShowNewLoan] = useState(false)
  const [showRepay, setShowRepay] = useState(false)
  const [showAdjust, setShowAdjust] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [g, basketRes, cycleList] = await Promise.all([
        api.get<GroupDetail>(`/groups/${groupId}`),
        api.get<BasketOverview>(`/groups/${groupId}/basket`),
        api.get<CycleItem[]>(`/groups/${groupId}/cycles`),
      ])
      setGroup(g)
      setBasket(basketRes)
      setCycles(cycleList.sort((a, b) => a.month_number - b.month_number))

      const isAdmin = g.my_membership.role === 'Admin'
      const parallel: Promise<unknown>[] = [
        api.get<Loan[]>(`/groups/${groupId}/loans?status=active`),
        api.get<TransactionListResponse>(`/groups/${groupId}/basket/transactions?limit=100`),
      ]
      if (isAdmin) {
        parallel.push(api.get<Member[]>(`/groups/${groupId}/members`))
        parallel.push(api.get<Loan[]>(`/groups/${groupId}/loans?status=repaid`))
      }

      const results = await Promise.all(parallel)
      setActiveLoans(results[0] as Loan[])
      setTransactions((results[1] as TransactionListResponse).data)
      if (isAdmin) {
        setMembers(results[2] as Member[])
        setClosedLoans(results[3] as Loan[])
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load basket. Tap to retry.')
    } finally {
      setLoading(false)
    }
  }

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = setTimeout(() => setToast(null), 3000)
  }

  async function afterAction() {
    const [basketRes, active, txns] = await Promise.all([
      api.get<BasketOverview>(`/groups/${groupId}/basket`),
      api.get<Loan[]>(`/groups/${groupId}/loans?status=active`),
      api.get<TransactionListResponse>(`/groups/${groupId}/basket/transactions?limit=100`),
    ])
    setBasket(basketRes)
    setActiveLoans(active)
    setTransactions(txns.data)
    if (group?.my_membership.role === 'Admin') {
      const closed = await api.get<Loan[]>(`/groups/${groupId}/loans?status=repaid`)
      setClosedLoans(closed)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <svg className="animate-spin w-6 h-6 text-maroon-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    )
  }

  if (error || !group || !basket) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-gray-500">{error ?? 'Could not load basket.'}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  const isAdmin = group.my_membership.role === 'Admin'
  const isClosed = group.status === 'Closed'
  const backPath = isAdmin ? `/groups/${groupId}` : `/groups/${groupId}/member`

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-2 py-2 flex items-center gap-1">
        <button onClick={() => navigate(backPath)} className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <p className="flex-1 text-sm font-semibold text-gray-900">Basket & loans</p>
        <p className="text-xs text-gray-400 pr-2 truncate max-w-[120px]">{group.name}</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-8">

        {/* Closed-group read-only banner */}
        {isClosed && (
          <div className="mx-3 mt-3 px-4 py-3 bg-gray-100 border border-gray-200 rounded-xl flex items-center gap-2">
            <span className="text-base">🔒</span>
            <p className="text-xs text-gray-500 font-medium">This group is closed — basket is read-only.</p>
          </div>
        )}

        {/* Balance card */}
        <div className="mx-3 mt-3 bg-maroon-600 rounded-2xl p-5 text-white">
          <p className="text-xs font-semibold text-maroon-200 mb-1 tracking-widest">AVAILABLE BALANCE</p>
          <p className="text-3xl font-bold mb-4">{formatPaise(basket.current_balance)}</p>
          {isAdmin ? (
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Total in', value: formatPaise(basket.total_credited) },
                { label: 'Total out', value: formatPaise(basket.total_debited) },
                { label: 'Lent out', value: formatPaise(basket.total_lent_out) },
              ].map(s => (
                <div key={s.label} className="bg-maroon-700/50 rounded-xl px-2.5 py-2">
                  <p className="text-[10px] text-maroon-300 mb-0.5">{s.label}</p>
                  <p className="text-sm font-bold">{s.value}</p>
                </div>
              ))}
            </div>
          ) : basket.my_share_if_closed_today !== undefined && (
            <p className="text-sm text-maroon-200">
              Your share if closed today: <span className="font-bold text-white">{formatPaise(basket.my_share_if_closed_today)}</span>
            </p>
          )}
        </div>

        {/* Quick actions — admin only */}
        {isAdmin && (
          <div className="mx-3 mt-3 grid grid-cols-3 gap-2">
            {[
              { icon: '💰', label: 'New loan',       onClick: () => setShowNewLoan(true) },
              { icon: '↩️', label: 'Repayment',      onClick: () => setShowRepay(true), disabled: activeLoans.length === 0 },
              { icon: '⚙️', label: 'Adjust basket',  onClick: () => setShowAdjust(true) },
            ].map(a => (
              <button
                key={a.label}
                onClick={a.onClick}
                disabled={a.disabled || isClosed}
                className="flex flex-col items-center justify-center gap-1 py-3 bg-white rounded-xl border border-gray-100 text-gray-700 hover:bg-maroon-50 hover:border-maroon-200 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <span className="text-lg">{a.icon}</span>
                <span className="text-[11px] font-medium text-center leading-tight">{a.label}</span>
              </button>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="mx-3 mt-3 flex bg-gray-100 rounded-xl p-1 gap-1">
          {([
            { key: 'loans',  label: `Active loans${activeLoans.length > 0 ? ` (${activeLoans.length})` : ''}` },
            { key: 'ledger', label: 'Ledger' },
            { key: 'closed', label: 'Closed loans' },
          ] as { key: Tab; label: string }[]).map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${tab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Active Loans tab — tracking/information only */}
        {tab === 'loans' && (
          <div className="mx-3 mt-3">
            {activeLoans.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 px-4 py-10 text-center">
                <p className="text-sm text-gray-400">No active loans.</p>
                {isAdmin && <p className="text-xs text-gray-400 mt-1">Use "New loan" above to disburse one.</p>}
              </div>
            ) : (
              <ActiveLoanGroups loans={activeLoans} />
            )}
          </div>
        )}


        {/* Ledger — By Loan / By Cycle toggle */}
        {tab === 'ledger' && (
          <div className="mx-3 mt-3 space-y-3">
            {/* Toggle */}
            <div className="flex bg-gray-100 rounded-xl p-1 gap-1">
              {([
                { key: 'byLoan'  as LedgerView, label: 'By Loan'  },
                { key: 'byCycle' as LedgerView, label: 'By Cycle' },
              ]).map(v => (
                <button
                  key={v.key}
                  onClick={() => setLedgerView(v.key)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${
                    ledgerView === v.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>

            {/* Content */}
            {ledgerView === 'byLoan'
              ? <LedgerTimeline transactions={transactions} />
              : <CycleLedger    transactions={transactions} />
            }
          </div>
        )}

        {/* Closed loans */}
        {tab === 'closed' && (
          <div className="mx-3 mt-3">
            {closedLoans.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 px-4 py-10 text-center">
                <p className="text-sm text-gray-400">No closed loans.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {closedLoans.map(loan => (
                  <div key={loan.loan_id} className="bg-white rounded-2xl border border-gray-100 p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 shrink-0">
                        {initials(loan.borrower_name)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-800">{loan.borrower_name}</p>
                        <p className="text-xs text-gray-400">
                          {formatPaise(loan.principal)} · {fmtDate(loan.disbursed_at)} → {loan.expected_close_date ? fmtDate(loan.expected_close_date) : 'no due date'}
                        </p>
                        <p className="text-xs text-gray-400">Total interest: {formatPaise(loan.total_interest_paid)}</p>
                      </div>
                      <LoanStatusBadge status={loan.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-4 py-2 rounded-full shadow-lg z-50 whitespace-nowrap">
          {toast}
        </div>
      )}

      {/* Modals */}
      {showNewLoan && (
        <NewLoanModal
          groupId={groupId!}
          members={members}
          interestRate={group.monthly_interest_rate}
          monthlyContribution={group.monthly_contribution}
          totalMonths={group.total_months}
          basketBalance={basket.current_balance}
          activeLoans={activeLoans}
          onClose={() => setShowNewLoan(false)}
          onSaved={(warnings) => {
            setShowNewLoan(false)
            afterAction()
            showToast(warnings.length > 0 ? `Loan disbursed — ${warnings[0]}` : 'Loan disbursed!')
          }}
        />
      )}
      {showRepay && (
        <RepaymentSheet
          groupId={groupId!}
          loans={activeLoans}
          isClosed={isClosed}
          cycles={cycles}
          currentCycleId={group.current_cycle?.cycle_id ?? null}
          onClose={() => setShowRepay(false)}
          onRepaid={(msg) => { afterAction(); showToast(msg) }}
        />
      )}
      {showAdjust && (
        <AdjustBasketModal
          groupId={groupId!}
          onClose={() => setShowAdjust(false)}
          onSaved={() => { setShowAdjust(false); afterAction(); showToast('Basket adjusted!') }}
        />
      )}
    </div>
  )
}
