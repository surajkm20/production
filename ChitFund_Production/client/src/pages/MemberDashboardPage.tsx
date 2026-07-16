import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { GroupDetail, Payment, PaymentListResponse, MemberPaymentHistoryItem, User, MemberWin } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

function StatusPill({ status }: { status: 'Paid' | 'Unpaid' | 'Waived' }) {
  const styles = {
    Paid:   'bg-green-100 text-green-700',
    Unpaid: 'bg-red-100 text-red-600',
    Waived: 'bg-gray-100 text-gray-500',
  }
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status]}`}>{status}</span>
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function MemberDashboardPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [group, setGroup] = useState<GroupDetail | null>(null)
  const [_myUser, setMyUser] = useState<User | null>(null)
  const [myPayment, setMyPayment] = useState<Payment | null>(null)

  const [paymentHistory, setPaymentHistory] = useState<MemberPaymentHistoryItem[]>([])
  const [myWins, setMyWins] = useState<MemberWin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // Step 1: fetch me + group in parallel
      const [me, g] = await Promise.all([
        api.get<User>('/me'),
        api.get<GroupDetail>(`/groups/${groupId}`),
      ])
      setMyUser(me)
      setGroup(g)

      // Step 2: payment history, wins, and (if a cycle exists) own payment row in parallel.
      const parallelFetches: Promise<unknown>[] = [
        api.get<MemberPaymentHistoryItem[]>(`/groups/${groupId}/members/${me.user_id}/payments?limit=3`),
        api.getMemberWins(groupId!, me.user_id),
      ]
      if (g.current_cycle) {
        parallelFetches.push(
          api.get<PaymentListResponse>(`/groups/${groupId}/cycles/${g.current_cycle.cycle_id}/payments`)
        )
      }

      const results = await Promise.all(parallelFetches)
      const history = results[0] as MemberPaymentHistoryItem[]
      const wins    = results[1] as MemberWin[]
      setPaymentHistory(history)
      setMyWins(wins)

      // The payments endpoint returns only the caller's own row for non-admins.
      if (g.current_cycle && results[2]) {
        const paymentsRes = results[2] as PaymentListResponse
        setMyPayment(paymentsRes.data[0] ?? null)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/login', { replace: true })
      } else {
        setError('Could not load group. Tap to retry.')
      }
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
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-gray-500">{error ?? 'Group not found.'}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  const cycle = group.current_cycle
  const myShareCount = group.my_membership.share_count
  // Projected basket split: member's proportional share of the current basket balance
  const myProjectedSplit = group.basket
    ? Math.round((group.basket.current_balance * myShareCount) / group.total_shares)
    : null

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-2 py-2 flex items-center gap-1">
        <button onClick={() => navigate('/dashboard')} className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <p className="flex-1 text-sm font-semibold text-gray-900 truncate px-1">{group.name}</p>
        <button className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-20">

        {/* Group header block */}
        <div className="bg-white px-4 pt-4 pb-5">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-lg font-bold text-gray-900">{group.name}</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">Member</span>
          </div>
          <p className="text-xs text-gray-400">
            {group.people_count} people · {group.total_shares} shares · {formatPaise(group.monthly_contribution)}/share
          </p>
          {group.admin_name && (
            <p className="text-xs text-gray-400 mt-0.5">Admin: {group.admin_name}</p>
          )}

          {/* Progress bar */}
          {cycle && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Month {cycle.month_number} of {group.total_months}</span>
                <span>{Math.round((cycle.month_number / group.total_months) * 100)}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-maroon-500 rounded-full"
                  style={{ width: `${(cycle.month_number / group.total_months) * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>


        {/* My Shares card */}
        <div className="bg-white rounded-2xl p-4 border border-gray-100 mx-3 mt-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">My Shares</p>
          <div className="flex divide-x divide-gray-100">
            <div className="flex-1 flex flex-col items-center pr-3">
              <span className="text-2xl font-bold text-gray-900">{group.my_membership.share_count}</span>
              <span className="text-xs text-gray-400 mt-0.5">shares</span>
            </div>
            <div className="flex-1 flex flex-col items-center px-3">
              <span className="text-2xl font-bold text-gray-900">{group.my_membership.wins_count}</span>
              <span className="text-xs text-gray-400 mt-0.5">won</span>
            </div>
            <div className="flex-1 flex flex-col items-center pl-3">
              <span className="text-2xl font-bold text-gray-900">{group.my_membership.share_count - group.my_membership.wins_count}</span>
              <span className="text-xs text-gray-400 mt-0.5">remaining</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Monthly payment: {formatPaise(group.monthly_contribution * group.my_membership.share_count)}
          </p>
        </div>

        {/* This member's payment status for the current cycle */}
        {cycle && (
          <div className="mx-3 mt-3 bg-white rounded-2xl p-4 border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700">Your status — {cycle.month_label}</p>
              {myPayment && <StatusPill status={myPayment.status} />}
            </div>

            {myPayment ? (
              <>
                <p className="text-2xl font-bold text-gray-900 mb-0.5">
                  {myPayment.status === 'Paid'
                    ? formatPaise(myPayment.paid_amount)
                    : myPayment.status === 'Waived'
                    ? '₹0'
                    : formatPaise(myPayment.expected_amount)}
                </p>
                <p className="text-xs text-gray-400 mb-3">
                  {myPayment.status === 'Paid' && myPayment.paid_at
                    ? `Paid on ${formatTimestamp(myPayment.paid_at)}`
                    : myPayment.status === 'Waived'
                    ? 'Waived this month'
                    : `${formatPaise(myPayment.expected_amount)} to pay`}
                </p>
                {/* Members pay the admin in cash; admin marks them as paid in the app */}
                {myPayment.status === 'Unpaid' && (
                  <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
                    <svg className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <p className="text-xs text-amber-700 leading-relaxed">
                      Pay {group.admin_name || 'your admin'} in cash by the{' '}
                      <span className="font-semibold">{parseInt(cycle.due_date.slice(8))}th</span>.
                      They'll mark you as paid.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-gray-400">Payment record not found.</p>
            )}
          </div>
        )}

        {/* This month's winner — anonymous view for members */}
        {cycle && (
          <div className="mx-3 mt-3 bg-purple-50 rounded-2xl p-4 border border-maroon-100">
            <p className="text-sm font-semibold text-gray-700 mb-2">This month's winner</p>
            {(cycle.winners?.length ?? 0) > 0 ? (
              <div>
                <p className="text-sm text-gray-700">A winner has been selected.</p>
                {cycle.winners[0].winner_takeaway > 0 && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {formatPaise(cycle.winners[0].winner_takeaway)} credited from the pool.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-gray-400">Winner not yet recorded — admin will update soon.</p>
            )}
          </div>
        )}

        {/* My Winning History */}
        <div className="bg-purple-50 border border-purple-100 rounded-2xl mx-3 mt-3 p-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">My Winning History</p>
          {myWins.length === 0 ? (
            <p className="text-xs text-gray-400">No wins yet — your turn will come!</p>
          ) : (
            <>
              <div className="divide-y divide-purple-100">
                {myWins.map((w, i) => (
                  <div key={i} className="py-2.5">
                    <p className="text-sm text-gray-800">
                      Month {w.month_label}
                      {w.winner_number > 1 && (
                        <span className="text-xs text-gray-500 ml-1">(winner #{w.winner_number})</span>
                      )}
                      {w.is_admin_withdrawal && (
                        <span className="text-xs text-gray-400 ml-1">(admin withdrawal)</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Bid {formatPaise(w.bid_amount)} · Took home {formatPaise(w.winner_takeaway)}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 font-medium mt-2 pt-2 border-t border-purple-100">
                Total received: {formatPaise(myWins.reduce((s, w) => s + w.winner_takeaway, 0))}
              </p>
            </>
          )}
        </div>

        {/* Group basket — shows member's projected share if the group closed today */}
        {group.basket && (
          <div className="mx-3 mt-3 bg-white rounded-2xl p-4 border border-gray-100">
            <p className="text-sm font-semibold text-gray-700 mb-3">Group basket</p>
            <p className="text-2xl font-bold text-gray-900 mb-0.5">
              {formatPaise(group.basket.current_balance)}
            </p>
            <div className="flex items-center justify-between mt-2">
              <p className="text-xs text-green-600 font-medium">
                +{formatPaise(group.basket.total_credited - group.basket.total_debited)} net
              </p>
              {myProjectedSplit !== null && (
                <p className="text-xs text-gray-400">
                  Your share if closed: {formatPaise(myProjectedSplit)}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Last 3 payments — "View all" navigates to full history */}
        <div className="mx-3 mt-3 bg-white rounded-2xl border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-700">Your payment history</p>
            <button onClick={() => navigate(`/groups/${groupId}/history`)} className="text-xs text-maroon-600 font-medium">View all</button>
          </div>
          {paymentHistory.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">No payment history yet.</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {paymentHistory.map(p => (
                <div key={p.payment_id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{p.cycle_month_label}</p>
                    <p className="text-xs text-gray-400">
                      {p.is_skip_month ? 'Skip month' : formatPaise(p.expected_amount)}
                    </p>
                  </div>
                  <StatusPill status={p.status} />
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      <GroupNavBar groupId={groupId!} role="Member" />

    </div>
  )
}
