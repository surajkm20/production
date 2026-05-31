import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { Loan, LoanRepaymentHistoryItem } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

// ─── helpers ─────────────────────────────────────────────────────────────────

function cycleDisplay(cycleNumber: number | null, monthLabel: string | null): string {
  if (!cycleNumber) return '—'
  return monthLabel ? `Cycle ${cycleNumber} (${monthLabel})` : `Cycle ${cycleNumber}`
}

function disbursementDisplay(loan: Loan): string {
  return cycleDisplay(loan.disbursement_month_number, loan.disbursement_month_label)
}

// ─── RepaymentHistory ─────────────────────────────────────────────────────────

function RepaymentHistory({ history }: { history: LoanRepaymentHistoryItem[] }) {
  if (history.length === 0) return null

  const principalEntries = history.filter(h => h.txn_type === 'LOAN_REPAID')
  const interestEntries  = history.filter(h => h.txn_type === 'INTEREST_ACCRUED')

  return (
    <div className="space-y-1 text-xs">
      {interestEntries.map((h, i) => (
        <div key={`int-${i}`} className="flex items-center justify-between">
          <span className="text-gray-400">
            Interest paid{interestEntries.length > 1 ? ` #${i + 1}` : ''}
          </span>
          <span className="font-medium text-gray-700">
            {formatPaise(h.amount)}
            {h.cycle_label
              ? <span className="text-gray-400 font-normal ml-1">— {cycleDisplay(h.cycle_month_number, h.cycle_month_label)}</span>
              : null}
          </span>
        </div>
      ))}
      {principalEntries.map((h, i) => (
        <div key={`pri-${i}`} className="flex items-center justify-between">
          <span className="text-gray-400">
            Principal repaid{principalEntries.length > 1 ? ` #${i + 1}` : ''}
          </span>
          <span className="font-medium text-gray-700">
            {formatPaise(h.amount)}
            {h.cycle_label
              ? <span className="text-gray-400 font-normal ml-1">— {cycleDisplay(h.cycle_month_number, h.cycle_month_label)}</span>
              : null}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── ActiveLoanCard ───────────────────────────────────────────────────────────

function ActiveLoanCard({ loan }: { loan: Loan }) {
  return (
    <div className="bg-white rounded-2xl border border-red-100 p-4 space-y-3">
      {/* Amount + badge */}
      <div className="flex items-center justify-between">
        <p className="text-base font-bold text-gray-900">{formatPaise(loan.principal)}</p>
        <span className="text-[11px] font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full">Active</span>
      </div>

      {/* Taken in cycle */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-400">Taken in</span>
        <span className="font-semibold text-gray-800">{disbursementDisplay(loan)}</span>
      </div>

      {/* Interest / principal grid */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-50 rounded-lg p-2">
          <p className="text-gray-400 mb-0.5">Outstanding interest</p>
          <p className="font-semibold text-red-600">{formatPaise(loan.outstanding_interest)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-2">
          <p className="text-gray-400 mb-0.5">Interest paid</p>
          <p className="font-semibold text-gray-800">{formatPaise(loan.total_interest_paid)}</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-2">
          <p className="text-gray-400 mb-0.5">Rate</p>
          <p className="font-semibold text-gray-800">{loan.monthly_interest_rate}% / month</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-2">
          <p className="text-gray-400 mb-0.5">Next due</p>
          <p className="font-semibold text-gray-800">
            {loan.next_cycle_due_date
              ? new Date(loan.next_cycle_due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
              : '—'}
          </p>
        </div>
      </div>

      {/* Repayment history (partial repayments already made) */}
      {loan.repayment_history.length > 0 && (
        <div className="border-t border-gray-100 pt-2">
          <p className="text-[11px] font-semibold text-gray-400 mb-1.5">REPAYMENT HISTORY</p>
          <RepaymentHistory history={loan.repayment_history} />
        </div>
      )}

      {loan.expected_close_date && (
        <p className="text-[11px] text-gray-400">
          Expected closure — {new Date(loan.expected_close_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
        </p>
      )}
    </div>
  )
}

// ─── PastLoanCard ─────────────────────────────────────────────────────────────

function PastLoanCard({ loan }: { loan: Loan }) {
  const [expanded, setExpanded] = useState(false)
  const isRepaid = loan.status === 'Repaid'

  return (
    <div className="border-b border-gray-50 last:border-b-0">
      {/* Summary row */}
      <button
        onClick={() => setExpanded(p => !p)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">{formatPaise(loan.principal)}</p>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ml-2 ${
              isRepaid ? 'text-green-600 bg-green-50' : 'text-gray-500 bg-gray-100'
            }`}>
              {loan.status === 'WrittenOff' ? 'Written off' : loan.status}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Taken in {disbursementDisplay(loan)}
            {isRepaid && loan.settlement_cycle_number
              ? ` · Settled Cycle ${loan.settlement_cycle_number}${loan.settlement_cycle_label ? ` (${loan.settlement_cycle_label})` : ''}`
              : ''}
          </p>
        </div>
        {/* Chevron */}
        <svg
          className={`w-4 h-4 text-gray-400 mt-0.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {/* Key cycle facts */}
          <div className="bg-gray-50 rounded-lg p-3 space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Taken in</span>
              <span className="font-medium text-gray-700">{disbursementDisplay(loan)}</span>
            </div>
            {loan.settlement_cycle_number && (
              <div className="flex items-center justify-between">
                <span className="text-gray-400">Fully settled</span>
                <span className="font-medium text-green-700">
                  {cycleDisplay(loan.settlement_cycle_number, loan.settlement_cycle_label)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Total interest paid</span>
              <span className="font-medium text-gray-700">{formatPaise(loan.total_interest_paid)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Rate</span>
              <span className="font-medium text-gray-700">{loan.monthly_interest_rate}% / month</span>
            </div>
          </div>

          {/* Per-cycle repayment breakdown */}
          {loan.repayment_history.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-gray-400 mb-1">REPAYMENT BREAKDOWN</p>
              <div className="bg-gray-50 rounded-lg p-3">
                <RepaymentHistory history={loan.repayment_history} />
              </div>
            </div>
          )}

          {loan.notes && (
            <p className="text-xs text-gray-400 italic">{loan.notes}</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── MyLoansPage ──────────────────────────────────────────────────────────────

export default function MyLoansPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [groupName, setGroupName] = useState<string>('')
  const [role, setRole]           = useState<'Admin' | 'Member'>('Member')
  const [loans, setLoans]         = useState<Loan[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [g, rows] = await Promise.all([
        api.get<{ name: string; my_membership: { role: 'Admin' | 'Member' } }>(`/groups/${groupId}`),
        api.get<Loan[]>(`/groups/${groupId}/loans`),
      ])
      setGroupName(g.name)
      setRole(g.my_membership.role)
      setLoans(rows)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load loans.')
    } finally {
      setLoading(false)
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

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-gray-500">{error}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  const activeLoans = loans.filter(l => l.status === 'Active')
  const pastLoans   = loans.filter(l => l.status !== 'Active')

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-1 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-gray-900">My Loans</h1>
          <p className="text-xs text-gray-400 truncate">{groupName}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 pt-4 space-y-4">

        {loans.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-8">
            <p className="text-sm text-gray-500 text-center">No loans in this group yet.</p>
          </div>
        )}

        {/* Active loans */}
        {activeLoans.length > 0 && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">ACTIVE</p>
            <div className="space-y-3">
              {activeLoans.map(loan => (
                <ActiveLoanCard key={loan.loan_id} loan={loan} />
              ))}
            </div>
          </div>
        )}

        {/* Past loans */}
        {pastLoans.length > 0 && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">PAST LOANS</p>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="divide-y divide-gray-50">
                {pastLoans.map(loan => (
                  <PastLoanCard key={loan.loan_id} loan={loan} />
                ))}
              </div>
            </div>
          </div>
        )}

      </div>

      <GroupNavBar groupId={groupId!} role={role} />
    </div>
  )
}
