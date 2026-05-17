import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { GroupDetail } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

// Response types for analytics-specific endpoints
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
  winner_name: string | null
  bid_amount: number | null
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

// Reusable tile used in the overview grid
function StatTile({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: 'green' | 'red' | 'blue' }) {
  const valueColor = highlight === 'green' ? 'text-green-600' : highlight === 'red' ? 'text-red-600' : highlight === 'blue' ? 'text-maroon-600' : 'text-gray-900'
  return (
    <div className="bg-white rounded-xl p-3 border border-gray-100">
      <p className="text-[11px] text-gray-400 font-medium mb-1 uppercase tracking-wide">{label}</p>
      <p className={`text-base font-bold ${valueColor}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

export default function AnalyticsPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [group, setGroup]         = useState<GroupDetail | null>(null)
  const [overview, setOverview]   = useState<Overview | null>(null)
  const [winners, setWinners]     = useState<WinnerRow[]>([])
  const [bidTrend, setBidTrend]   = useState<BidPoint[]>([])
  const [mySheet, setMySheet]     = useState<BalanceSheet | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // Step 1: fetch group first — need isAdmin flag and the group data before building the second round
      const g = await api.get<GroupDetail>(`/groups/${groupId}`)
      setGroup(g)

      // Step 2: also need myUserId for the balance sheet URL — fetch /me inline, no state needed
      const myUserId = (await api.get<{ user_id: string }>('/me')).user_id

      // Step 3: fire all four analytics API calls in parallel
      const [winnersRes, bidTrendRes, balanceSheetRes, overviewRes] = await Promise.all([
        api.get<WinnerRow[]>(`/groups/${groupId}/analytics/winners-ledger`),
        api.get<BidPoint[]>(`/groups/${groupId}/analytics/bid-trend`),
        // My own balance sheet — uses my user ID as part of the URL
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

  // Completed bids: months where a bid was actually placed (not skip months, not pending)
  const completedBids = bidTrend.filter(b => b.bid_amount !== null && !b.is_skip_month)
  // maxBid is used to calculate bar widths in the bid trend chart (highest bid = 100% width)
  const maxBid = completedBids.length > 0 ? Math.max(...completedBids.map(b => b.bid_amount!)) : 0

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(group.my_membership.role === 'Admin' ? `/groups/${groupId}` : `/groups/${groupId}/member`)} className="p-1 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-gray-900">Analytics</h1>
          <p className="text-xs text-gray-400 truncate">{group.name}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 space-y-4 pt-4">

        {/* Group overview stats grid */}
        {overview && (() => {
          // IIFE (immediately-invoked function expression): used here to compute local variables
          // inside JSX without needing separate state or a wrapper function
          const perCycle = group.monthly_contribution * group.total_shares
          const cycleCount = completedBids.length
          const cycleSubLabel = cycleCount > 0
            ? `${cycleCount} cycle${cycleCount !== 1 ? 's' : ''} × ${formatPaise(perCycle)}`
            : undefined
          return (
            <div className="mx-3">
              <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">GROUP OVERVIEW</p>
              <div className="grid grid-cols-2 gap-2">
                <StatTile label="Total Contributions" value={formatPaise(overview.total_collected)} sub={cycleSubLabel} highlight="green" />
                <StatTile label="Disbursed to winners" value={formatPaise(overview.total_disbursed_to_winners)} />

                {/* Visual divider between contribution stats and bid-split stats */}
                <div className="col-span-2 flex items-center gap-2 py-0.5">
                  <div className="flex-1 h-px bg-gray-100" />
                  <span className="text-[10px] text-gray-400 uppercase tracking-wider">Auction bid split</span>
                  <div className="flex-1 h-px bg-gray-100" />
                </div>

                <StatTile label="Basket Balance" value={formatPaise(overview.current_basket_balance)} highlight="blue" />
                <StatTile label="Commission to Admin" value={formatPaise(overview.total_admin_commission)} />

                <StatTile label="Interest earned" value={formatPaise(overview.total_interest_earned)} highlight="green" />
                <StatTile label="Total lent out" value={formatPaise(overview.total_lent_out)} />
                <StatTile
                  label="Active loans"
                  value={String(overview.active_loans_count)}
                  sub={overview.defaulters_this_month > 0 ? `${overview.defaulters_this_month} defaulter${overview.defaulters_this_month !== 1 ? 's' : ''} this month` : 'No defaulters'}
                  highlight={overview.active_loans_count > 0 ? 'red' : undefined}
                />
              </div>

              {/* Basket value breakdown: realized (cash) vs unrealized (outstanding loans) */}
              {(() => {
                const realized   = overview.current_basket_balance
                const unrealized = overview.active_loans_principal + overview.total_outstanding_interest
                const total      = realized + unrealized
                return (
                  <div className="mt-3 bg-gray-50 rounded-xl p-3 space-y-2">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Basket Value</p>
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-gray-500">Realized <span className="text-[10px] text-gray-400">(liquid cash)</span></span>
                      <span className="text-xs font-semibold text-gray-800">{formatPaise(realized)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-gray-500">Unrealized <span className="text-[10px] text-gray-400">(loans + accrued interest)</span></span>
                      <span className="text-xs font-semibold text-gray-800">{formatPaise(unrealized)}</span>
                    </div>
                    <div className="border-t border-gray-200 pt-2 flex justify-between items-center">
                      <span className="text-xs font-semibold text-gray-700">Total Value</span>
                      <span className="text-sm font-bold text-maroon-600">{formatPaise(total)}</span>
                    </div>
                  </div>
                )
              })()}
            </div>
          )
        })()}

        {/* My personal position in this group */}
        {mySheet && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">MY POSITION</p>
            <div className="bg-white rounded-2xl border border-gray-100 p-4">
              <div className="mb-3">
                <p className="text-sm font-semibold text-gray-900">{mySheet.name}</p>
                <p className="text-xs text-gray-400">{mySheet.share_count} share{mySheet.share_count !== 1 ? 's' : ''} · {mySheet.wins_count} win{mySheet.wins_count !== 1 ? 's' : ''}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-gray-400 mb-0.5">Contributed</p>
                  <p className="font-semibold text-gray-800">{formatPaise(mySheet.total_contributed)}</p>
                  {completedBids.length > 0 && (
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {mySheet.share_count} share{mySheet.share_count !== 1 ? 's' : ''} × {completedBids.length} cycle{completedBids.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-gray-400 mb-0.5">Received as winner</p>
                  <p className="font-semibold text-gray-800">{formatPaise(mySheet.total_received_as_winner)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-gray-400 mb-0.5">Projected split</p>
                  <p className="font-semibold text-gray-800">{formatPaise(mySheet.projected_closure_split)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-gray-400 mb-0.5">Outstanding loan</p>
                  <p className={`font-semibold ${mySheet.active_loans_outstanding > 0 ? 'text-red-600' : 'text-gray-800'}`}>
                    {formatPaise(mySheet.active_loans_outstanding)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bid trend — CSS bar chart: each bar width = (bid / maxBid) × 100% */}
        {completedBids.length > 0 && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">BID TREND</p>
            <div className="bg-white rounded-2xl border border-gray-100 p-4">
              <div className="space-y-2">
                {bidTrend.filter(b => b.bid_amount !== null || b.is_skip_month).map(b => (
                  <div key={b.month_number} className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-400 w-8 shrink-0">M{b.month_number}</span>
                    {b.is_skip_month ? (
                      <span className="text-[11px] text-amber-500 italic flex-1">Skip month</span>
                    ) : (
                      <>
                        {/* Bar width: bid expressed as percentage of the highest bid */}
                        <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                          <div
                            className="h-full bg-maroon-500 rounded-full transition-all"
                            style={{ width: `${maxBid > 0 ? Math.round((b.bid_amount! / maxBid) * 100) : 0}%` }}
                          />
                        </div>
                        <span className="text-[11px] text-gray-600 font-medium w-20 text-right shrink-0">
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

        {/* Winners ledger — every month's outcome in one list */}
        {winners.length > 0 && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">WINNERS</p>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="divide-y divide-gray-50">
                {winners.map(w => (
                  <div key={w.month_number} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-8 h-8 rounded-full bg-maroon-100 flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-maroon-700">M{w.month_number}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {w.is_skip_month ? 'Skip month' : (w.winner_name ?? '—')}
                      </p>
                      <p className="text-xs text-gray-400">{w.month_label}</p>
                    </div>
                    {!w.is_skip_month && w.winner_takeaway && (
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-gray-900">{formatPaise(w.winner_takeaway)}</p>
                        {w.bid_amount && <p className="text-[11px] text-gray-400">bid {formatPaise(w.bid_amount)}</p>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Empty state — shown before the first cycle closes */}
        {!overview && winners.length === 0 && completedBids.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-8">
            <p className="text-sm text-gray-500 text-center">No analytics yet. Data appears once the first cycle is closed.</p>
          </div>
        )}

      </div>
      <GroupNavBar groupId={groupId!} role={group.my_membership.role} />
    </div>
  )
}
