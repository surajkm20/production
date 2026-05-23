import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { GroupDetail } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

// ─── Response types ───────────────────────────────────────────────────────────

interface Overview {
  total_collected: number
  total_disbursed_to_winners: number
  current_basket_balance: number
  total_lent_out: number
  total_interest_earned: number
  active_loans_count: number
  defaulters_this_month: number
  total_admin_commission: number
  total_outstanding_interest: number
  active_loans_principal: number
}

interface WinnerRow {
  month_number: number
  month_label: string
  winner_number: number
  winner_name: string | null
  bid_amount: number | null
  admin_commission: number | null
  basket_credit: number | null
  winner_takeaway: number | null
  is_skip_month: boolean
}

interface BalanceSheet {
  user_id: string
  name: string | null
  share_count: number
  wins_count: number
  total_contributed: number
  total_received_as_winner: number
  active_loans_outstanding: number
  projected_closure_split: number
  net_position: number
}

interface BidPoint {
  month_number: number
  bid_amount: number | null
  is_skip_month: boolean
}

// ─── Small reusable components ────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold text-gray-400 tracking-widest uppercase mb-3 px-1">
      {children}
    </p>
  )
}

interface MetricRowProps {
  label: string
  value: string
  sub?: string
  valueClass?: string
}
function MetricRow({ label, value, sub, valueClass = 'text-gray-900' }: MetricRowProps) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div>
        <p className="text-sm text-gray-600">{label}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
      <p className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  )
}

// ─── Bid money flow breakdown ─────────────────────────────────────────────────

interface BidFlowCardProps {
  totalBidMoney: number
  totalBasketCredit: number
  totalAdminCommission: number
  currentBasketBalance: number
  totalLentOut: number
  totalInterestEarned: number
  activeLoansPrincipal: number
  totalOutstandingInterest: number
}

function BidFlowCard({
  totalBidMoney,
  totalBasketCredit,
  totalAdminCommission,
  currentBasketBalance,
  totalLentOut: _totalLentOut,
  totalInterestEarned,
  activeLoansPrincipal,
  totalOutstandingInterest,
}: BidFlowCardProps) {
  // Percentage bars (bid split — basket credit vs commission)
  const basketPct = totalBidMoney > 0 ? Math.round((totalBasketCredit   / totalBidMoney) * 100) : 0
  const commPct   = totalBidMoney > 0 ? Math.round((totalAdminCommission / totalBidMoney) * 100) : 0

  // Effective basket total = liquid cash + deployed principal + accrued (unrealized) interest
  // Interest already collected is embedded inside currentBasketBalance.
  const effectiveBasketTotal = currentBasketBalance + activeLoansPrincipal + totalOutstandingInterest
  const cashPct = effectiveBasketTotal > 0 ? Math.round((currentBasketBalance / effectiveBasketTotal) * 100) : 0
  const loanPct = effectiveBasketTotal > 0 ? Math.round((activeLoansPrincipal  / effectiveBasketTotal) * 100) : 0

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">

      {/* Level 1 — Total bid money */}
      <div className="px-4 pt-4 pb-3 bg-gray-50 border-b border-gray-100">
        <p className="text-xs text-gray-500 font-medium mb-0.5">Total money collected from bids</p>
        <p className="text-2xl font-bold text-gray-900 tabular-nums">{formatPaise(totalBidMoney)}</p>
        {totalBidMoney === 0 && (
          <p className="text-xs text-gray-400 mt-1">No bids recorded yet</p>
        )}
      </div>

      {/* Stacked bar showing basket vs commission split */}
      {totalBidMoney > 0 && (
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="flex h-3 rounded-full overflow-hidden gap-0.5 mb-2">
            <div
              className="bg-maroon-500 rounded-l-full transition-all"
              style={{ width: `${basketPct}%` }}
            />
            <div
              className="bg-amber-400 rounded-r-full transition-all"
              style={{ width: `${commPct}%` }}
            />
          </div>
          <div className="flex items-center gap-4 text-[11px] text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-maroon-500 inline-block" />
              Basket {basketPct}%
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
              Admin commission {commPct}%
            </span>
          </div>
        </div>
      )}

      {/* Level 2 — Basket vs Admin split */}
      <div className="px-4 divide-y divide-gray-50">

        {/* Basket credit block */}
        <div className="py-3">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-maroon-500 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-gray-800">Basket money</p>
                <p className="text-[11px] text-gray-400">Goes into the group pool</p>
              </div>
            </div>
            <p className="text-sm font-bold text-maroon-600 tabular-nums">{formatPaise(effectiveBasketTotal)}</p>
          </div>

          {/* Level 3 — Basket sub-split (cash + active loans + accrued interest) */}
          {effectiveBasketTotal > 0 && (
            <div className="ml-4 bg-gray-50 rounded-xl p-3 space-y-2.5">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Basket breakdown</p>

              {/* Mini bar: cash / loans principal / accrued interest */}
              <div className="flex h-2 rounded-full overflow-hidden gap-0.5 mb-1">
                <div className="bg-emerald-500 rounded-l-full" style={{ width: `${cashPct}%` }} />
                <div className="bg-blue-400" style={{ width: `${loanPct}%` }} />
                <div className="bg-amber-400 rounded-r-full" style={{ width: `${100 - cashPct - loanPct}%` }} />
              </div>

              <div className="space-y-2">
                {/* Available cash */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    <div>
                      <p className="text-xs text-gray-600">Available balance</p>
                      <p className="text-[10px] text-gray-400">Liquid cash in basket</p>
                    </div>
                  </div>
                  <p className="text-xs font-semibold text-emerald-600 tabular-nums">{formatPaise(currentBasketBalance)}</p>
                </div>

                {/* Active loans — principal outstanding */}
                {activeLoansPrincipal > 0 && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-blue-400" />
                      <div>
                        <p className="text-xs text-gray-600">Active loans (principal)</p>
                        <p className="text-[10px] text-gray-400">Deployed, will return to basket</p>
                      </div>
                    </div>
                    <p className="text-xs font-semibold text-blue-600 tabular-nums">{formatPaise(activeLoansPrincipal)}</p>
                  </div>
                )}

                {/* Accrued interest — unrealized, owed to basket */}
                {totalOutstandingInterest > 0 && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-amber-400" />
                      <div>
                        <p className="text-xs text-gray-600">Accrued interest (unrealized)</p>
                        <p className="text-[10px] text-gray-400">Owed to basket, not yet collected</p>
                      </div>
                    </div>
                    <p className="text-xs font-semibold text-amber-600 tabular-nums">+{formatPaise(totalOutstandingInterest)}</p>
                  </div>
                )}
              </div>

              {/* Source breakdown — where basket money came from */}
              <div className="border-t border-gray-200 pt-2.5 mt-0.5 space-y-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Where it came from</p>

                {/* Bid-origin money */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-purple-500" />
                    <div>
                      <p className="text-xs text-gray-600">Regular basket</p>
                      <p className="text-[10px] text-gray-400">From member bids</p>
                    </div>
                  </div>
                  <p className="text-xs font-semibold text-purple-700 tabular-nums">{formatPaise(totalBasketCredit)}</p>
                </div>

                {/* Interest-origin money (collected + accrued) */}
                {(totalInterestEarned + totalOutstandingInterest) > 0 && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-teal-500" />
                      <div>
                        <p className="text-xs text-gray-600">Interest earned</p>
                        <p className="text-[10px] text-gray-400">
                          {formatPaise(totalInterestEarned)} collected
                          {totalOutstandingInterest > 0 ? ` + ${formatPaise(totalOutstandingInterest)} accrued` : ''}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs font-semibold text-teal-600 tabular-nums">
                      {formatPaise(totalInterestEarned + totalOutstandingInterest)}
                    </p>
                  </div>
                )}

                {/* Total basket — sum of sources */}
                <div className="flex items-center justify-between border-t border-dashed border-gray-200 pt-2">
                  <p className="text-xs font-semibold text-gray-700">Total basket</p>
                  <p className="text-xs font-bold text-gray-900 tabular-nums">{formatPaise(effectiveBasketTotal)}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Admin commission block */}
        <div className="py-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-gray-800">Admin commission</p>
                <p className="text-[11px] text-gray-400">Collected offline in cash</p>
              </div>
            </div>
            <p className="text-sm font-bold text-amber-600 tabular-nums">{formatPaise(totalAdminCommission)}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate    = useNavigate()

  const [group,    setGroup]    = useState<GroupDetail | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [winners,  setWinners]  = useState<WinnerRow[]>([])
  const [bidTrend, setBidTrend] = useState<BidPoint[]>([])
  const [mySheet,  setMySheet]  = useState<BalanceSheet | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const g = await api.get<GroupDetail>(`/groups/${groupId}`)
      setGroup(g)

      const myUserId = (await api.get<{ user_id: string }>('/me')).user_id

      const [winnersRes, bidTrendRes, balanceSheetRes, overviewRes] = await Promise.all([
        api.get<WinnerRow[]>(`/groups/${groupId}/analytics/winners-ledger`),
        api.get<BidPoint[]>(`/groups/${groupId}/analytics/bid-trend`),
        api.get<BalanceSheet>(`/groups/${groupId}/analytics/member-balance-sheet/${myUserId}`),
        api.get<Overview>(`/groups/${groupId}/analytics/overview`),
      ])
      setWinners(winnersRes)
      setBidTrend(bidTrendRes)
      setMySheet(balanceSheetRes)
      setOverview(overviewRes)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load analytics.')
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

  if (error || !group) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-gray-500">{error ?? 'Not found.'}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  // ── Derived values from winners ledger ────────────────────────────────────
  // The winners-ledger already returns bid_amount, admin_commission, basket_credit
  // per winner row. Sum them to get group-level totals for the bid flow breakdown.
  const actualWinners = winners.filter(w => !w.is_skip_month && w.bid_amount !== null)
  const totalBidMoney        = actualWinners.reduce((s, w) => s + (w.bid_amount        ?? 0), 0)
  const totalBasketCredit    = actualWinners.reduce((s, w) => s + (w.basket_credit     ?? 0), 0)
  const totalAdminCommission = actualWinners.reduce((s, w) => s + (w.admin_commission  ?? 0), 0)

  // ── Bid trend chart data ──────────────────────────────────────────────────
  const completedBids = bidTrend.filter(b => b.bid_amount !== null && !b.is_skip_month)
  const maxBid = completedBids.length > 0 ? Math.max(...completedBids.map(b => b.bid_amount!)) : 0

  const hasAnyData = overview !== null || winners.length > 0 || completedBids.length > 0

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button
          onClick={() => navigate(group.my_membership.role === 'Admin' ? `/groups/${groupId}` : `/groups/${groupId}/member`)}
          className="p-1 text-gray-500 hover:text-gray-700 transition"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-gray-900">Analytics</h1>
          <p className="text-xs text-gray-400 truncate">{group.name}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-24 space-y-5 pt-5">

        {/* ── Bid money flow breakdown ─────────────────────────────────── */}
        <div className="mx-4">
          <SectionLabel>Bid money breakdown</SectionLabel>
          <BidFlowCard
            totalBidMoney={totalBidMoney}
            totalBasketCredit={totalBasketCredit}
            totalAdminCommission={totalAdminCommission}
            currentBasketBalance={overview?.current_basket_balance ?? 0}
            totalLentOut={overview?.total_lent_out ?? 0}
            totalInterestEarned={overview?.total_interest_earned ?? 0}
            activeLoansPrincipal={overview?.active_loans_principal ?? 0}
            totalOutstandingInterest={overview?.total_outstanding_interest ?? 0}
          />
        </div>

        {/* ── Group overview ───────────────────────────────────────────── */}
        {overview && (
          <div className="mx-4">
            <SectionLabel>Group overview</SectionLabel>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">

              {/* ── SUB-SECTION 1: CYCLE PROGRESS ── */}
              {(() => {
                const cyclesCompleted = completedBids.length
                const cyclesPlanned   = group.total_months
                const cyclesRemaining = cyclesPlanned - cyclesCompleted
                const totalSlotsWon   = actualWinners.length
                const savedCycles     = totalSlotsWon - cyclesCompleted
                const progressPct     = cyclesPlanned > 0
                  ? Math.min(100, Math.round((cyclesCompleted / cyclesPlanned) * 100))
                  : 0

                return (
                  <div className="px-4 pt-4 pb-3 border-b border-gray-100">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Cycle Progress</p>

                    {/* Progress bar */}
                    <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden mb-2">
                      <div
                        className="h-full bg-maroon-500 rounded-full transition-all"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>

                    {/* Progress text + X Chiti badge */}
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-gray-500">
                        <span className="font-semibold text-gray-900">{cyclesCompleted}</span>
                        {' of '}
                        <span className="font-semibold text-gray-900">{cyclesPlanned}</span>
                        {' cycles completed'}
                        {cyclesRemaining > 0 && (
                          <span className="text-gray-400"> · {cyclesRemaining} remaining</span>
                        )}
                      </p>
                      {savedCycles > 0 && (
                        <span className="shrink-0 text-[10px] font-semibold text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-2 py-0.5">
                          X Chiti saved {savedCycles} cycle{savedCycles !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* ── SUB-SECTION 2: MONEY FLOW ── */}
              {(() => {
                const totalSlotsWon   = actualWinners.length
                const slotsRemaining  = group.total_shares - totalSlotsWon
                const avgBid          = totalSlotsWon > 0
                  ? Math.round(totalBidMoney / totalSlotsWon)
                  : 0
                const poolAmount      = group.monthly_contribution * group.total_shares

                return (
                  <div className="px-4 pt-3 pb-1 border-b border-gray-100">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Money Flow</p>
                    <div className="divide-y divide-gray-50">
                      <MetricRow
                        label="Total contributions collected"
                        value={formatPaise(overview.total_collected)}
                        sub={completedBids.length > 0
                          ? `${completedBids.length} cycle${completedBids.length !== 1 ? 's' : ''} × ${formatPaise(poolAmount)}`
                          : undefined}
                        valueClass="text-emerald-600"
                      />
                      <MetricRow
                        label="Paid out to winners"
                        value={formatPaise(overview.total_disbursed_to_winners)}
                      />
                      {slotsRemaining > 0 && (
                        <MetricRow
                          label="Remaining payout estimate"
                          value={formatPaise(slotsRemaining * poolAmount)}
                          sub={`${slotsRemaining} slot${slotsRemaining !== 1 ? 's' : ''} remaining · pre-bid estimate`}
                          valueClass="text-gray-400"
                        />
                      )}
                      {totalSlotsWon > 0 && (
                        <MetricRow
                          label="Average bid amount"
                          value={formatPaise(avgBid)}
                          sub={`Avg across ${totalSlotsWon} completed bid${totalSlotsWon !== 1 ? 's' : ''}`}
                        />
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* ── SUB-SECTION 3: LOAN HEALTH ── */}
              {(() => {
                const loanExposurePct = (overview.active_loans_principal + overview.current_basket_balance) > 0
                  ? Math.round(
                      (overview.active_loans_principal /
                        (overview.current_basket_balance + overview.active_loans_principal)) * 100
                    )
                  : 0

                return (
                  <div className="px-4 pt-3 pb-1">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1">Loan Health</p>
                    <div className="divide-y divide-gray-50">
                      <MetricRow
                        label="Active loans"
                        value={String(overview.active_loans_count)}
                        sub={overview.defaulters_this_month > 0
                          ? `${overview.defaulters_this_month} defaulter${overview.defaulters_this_month !== 1 ? 's' : ''} this month`
                          : 'No defaulters this month'}
                        valueClass={overview.active_loans_count > 0 ? 'text-red-500' : 'text-gray-900'}
                      />

                      {overview.active_loans_count > 0 && (
                        <div className="py-2.5">
                          <div className="flex items-center justify-between mb-1.5">
                            <p className="text-sm text-gray-600">Loan exposure</p>
                            <p className="text-sm font-semibold text-red-500 tabular-nums">{loanExposurePct}%</p>
                          </div>
                          <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                            <div
                              className="h-full bg-red-400 rounded-full transition-all"
                              style={{ width: `${loanExposurePct}%` }}
                            />
                          </div>
                          <p className="text-xs text-gray-400 mt-1">{loanExposurePct}% of basket deployed as loans</p>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

            </div>
          </div>
        )}

        {/* ── My position ──────────────────────────────────────────────── */}
        {mySheet && (
          <div className="mx-4">
            <SectionLabel>My position</SectionLabel>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">

              {/* Name + share row */}
              <div className="px-4 pt-4 pb-3 border-b border-gray-50 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{mySheet.name}</p>
                  <p className="text-xs text-gray-400">
                    {mySheet.share_count} share{mySheet.share_count !== 1 ? 's' : ''}
                    {mySheet.wins_count > 0 && ` · ${mySheet.wins_count} win${mySheet.wins_count !== 1 ? 's' : ''}`}
                  </p>
                </div>
                {/* Net position badge */}
                <div className={`rounded-xl px-3 py-1.5 text-center ${mySheet.net_position >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                  <p className="text-[10px] text-gray-400 mb-0.5">Net position</p>
                  <p className={`text-sm font-bold tabular-nums ${mySheet.net_position >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {mySheet.net_position >= 0 ? '+' : ''}{formatPaise(mySheet.net_position)}
                  </p>
                </div>
              </div>

              {/* Metric rows */}
              <div className="px-4 divide-y divide-gray-50">
                <MetricRow
                  label="Total contributed"
                  value={formatPaise(mySheet.total_contributed)}
                  sub={completedBids.length > 0
                    ? `${mySheet.share_count} share${mySheet.share_count !== 1 ? 's' : ''} × ${completedBids.length} cycle${completedBids.length !== 1 ? 's' : ''}`
                    : undefined}
                />
                <MetricRow
                  label="Received as winner"
                  value={formatPaise(mySheet.total_received_as_winner)}
                  valueClass={mySheet.total_received_as_winner > 0 ? 'text-emerald-600' : 'text-gray-900'}
                />
                <MetricRow
                  label="Projected share at closure"
                  value={formatPaise(mySheet.projected_closure_split)}
                  sub="Based on current basket balance"
                />
                {mySheet.active_loans_outstanding > 0 && (
                  <MetricRow
                    label="Outstanding loan"
                    value={formatPaise(mySheet.active_loans_outstanding)}
                    valueClass="text-red-500"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Bid trend chart ──────────────────────────────────────────── */}
        {completedBids.length > 0 && (
          <div className="mx-4">
            <SectionLabel>Bid trend</SectionLabel>
            <div className="bg-white rounded-2xl border border-gray-100 p-4">
              <div className="space-y-2.5">
                {bidTrend
                  .filter(b => b.bid_amount !== null || b.is_skip_month)
                  .map(b => (
                    <div key={b.month_number} className="flex items-center gap-3">
                      <span className="text-[11px] text-gray-400 w-7 shrink-0 font-medium">M{b.month_number}</span>
                      {b.is_skip_month ? (
                        <span className="text-[11px] text-amber-500 italic flex-1">Skip month</span>
                      ) : (
                        <>
                          <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                            <div
                              className="h-full bg-maroon-500 rounded-full transition-all"
                              style={{ width: `${maxBid > 0 ? Math.round((b.bid_amount! / maxBid) * 100) : 0}%` }}
                            />
                          </div>
                          <span className="text-[11px] text-gray-600 font-medium w-20 text-right shrink-0 tabular-nums">
                            {formatPaise(b.bid_amount!)}
                          </span>
                        </>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Winners ledger ───────────────────────────────────────────── */}
        {winners.length > 0 && (
          <div className="mx-4">
            <SectionLabel>Winners</SectionLabel>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="divide-y divide-gray-50">
                {winners.map((w, idx) => (
                  <div key={`${w.month_number}-${idx}`} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-9 h-9 rounded-full bg-maroon-50 flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-maroon-600">M{w.month_number}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {w.is_skip_month ? 'Skip month' : (w.winner_name ?? '—')}
                      </p>
                      <p className="text-xs text-gray-400">{w.month_label}</p>
                    </div>
                    {!w.is_skip_month && w.winner_takeaway != null && (
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-gray-900 tabular-nums">
                          {formatPaise(w.winner_takeaway)}
                        </p>
                        {w.bid_amount != null && (
                          <p className="text-[11px] text-gray-400 tabular-nums">bid {formatPaise(w.bid_amount)}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Empty state ──────────────────────────────────────────────── */}
        {!hasAnyData && (
          <div className="flex flex-col items-center justify-center py-16 px-8 gap-2">
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-2">
              <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-700">No data yet</p>
            <p className="text-xs text-gray-400 text-center">Analytics appear once the first cycle is closed.</p>
          </div>
        )}

      </div>

      <GroupNavBar groupId={groupId!} role={group.my_membership.role} />
    </div>
  )
}
