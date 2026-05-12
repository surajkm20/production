import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { GroupDetail } from '../types/api'

interface Overview {
  total_collected: number
  total_disbursed_to_winners: number
  current_basket_balance: number
  total_lent_out: number
  total_interest_earned: number
  active_loans_count: number
  defaulters_this_month: number
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
      const g = await api.get<GroupDetail>(`/groups/${groupId}`)
      setGroup(g)

      const isAdmin = g.my_membership.role === 'Admin'
      const myUserId = (await api.get<{ user_id: string }>('/me')).user_id

      const promises: Promise<unknown>[] = [
        api.get<WinnerRow[]>(`/groups/${groupId}/analytics/winners-ledger`),
        api.get<BidPoint[]>(`/groups/${groupId}/analytics/bid-trend`),
        api.get<BalanceSheet>(`/groups/${groupId}/analytics/member-balance-sheet/${myUserId}`),
      ]
      if (isAdmin) {
        promises.push(api.get<Overview>(`/groups/${groupId}/analytics/overview`))
      }

      const results = await Promise.all(promises)
      setWinners(results[0] as WinnerRow[])
      setBidTrend(results[1] as BidPoint[])
      setMySheet(results[2] as BalanceSheet)
      if (isAdmin) setOverview(results[3] as Overview)

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

  const isAdmin = group.my_membership.role === 'Admin'
  const completedBids = bidTrend.filter(b => b.bid_amount !== null && !b.is_skip_month)
  const maxBid = completedBids.length > 0 ? Math.max(...completedBids.map(b => b.bid_amount!)) : 0

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(`/groups/${groupId}`)} className="p-1 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-gray-900">Analytics</h1>
          <p className="text-xs text-gray-400 truncate">{group.name}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-8 space-y-4 pt-4">

        {/* Overview — admin only */}
        {isAdmin && overview && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">GROUP OVERVIEW</p>
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="Total collected" value={formatPaise(overview.total_collected)} highlight="green" />
              <StatTile label="Disbursed to winners" value={formatPaise(overview.total_disbursed_to_winners)} />
              <StatTile label="Basket balance" value={formatPaise(overview.current_basket_balance)} highlight="blue" />
              <StatTile label="Interest earned" value={formatPaise(overview.total_interest_earned)} highlight="green" />
              <StatTile label="Total lent out" value={formatPaise(overview.total_lent_out)} />
              <StatTile
                label="Active loans"
                value={String(overview.active_loans_count)}
                sub={overview.defaulters_this_month > 0 ? `${overview.defaulters_this_month} defaulter${overview.defaulters_this_month !== 1 ? 's' : ''} this month` : 'No defaulters'}
                highlight={overview.active_loans_count > 0 ? 'red' : undefined}
              />
            </div>
          </div>
        )}

        {/* My position */}
        {mySheet && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">MY POSITION</p>
            <div className="bg-white rounded-2xl border border-gray-100 p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{mySheet.name}</p>
                  <p className="text-xs text-gray-400">{mySheet.share_count} share{mySheet.share_count !== 1 ? 's' : ''} · {mySheet.wins_count} win{mySheet.wins_count !== 1 ? 's' : ''}</p>
                </div>
                <div className="text-right">
                  <p className={`text-base font-bold ${mySheet.net_position >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {mySheet.net_position >= 0 ? '+' : ''}{formatPaise(mySheet.net_position)}
                  </p>
                  <p className="text-[11px] text-gray-400">net position</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-gray-400 mb-0.5">Contributed</p>
                  <p className="font-semibold text-gray-800">{formatPaise(mySheet.total_contributed)}</p>
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

        {/* Bid trend */}
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

        {/* Winners ledger */}
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

        {/* Empty state */}
        {!overview && winners.length === 0 && completedBids.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-8">
            <p className="text-sm text-gray-500 text-center">No analytics yet. Data appears once the first cycle is closed.</p>
          </div>
        )}

      </div>
    </div>
  )
}
