import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise, initials } from '../lib/format'
import type { GroupDetail, CycleItem, Member } from '../types/api'

export default function RecordWinnerPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate    = useNavigate()

  const [group,   setGroup]   = useState<GroupDetail | null>(null)
  const [cycles,  setCycles]  = useState<CycleItem[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const [winnerId,    setWinnerId]    = useState('')
  const [bidRupees,   setBidRupees]   = useState('')
  const [notes,       setNotes]       = useState('')
  const [submitting,  setSubmitting]  = useState(false)
  const [formError,   setFormError]   = useState<string | null>(null)
  const [successMsg,  setSuccessMsg]  = useState<string | null>(null)
  const [warnings,    setWarnings]    = useState<string[]>([])

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [g, cycleList, memberList] = await Promise.all([
        api.get<GroupDetail>(`/groups/${groupId}`),
        api.get<CycleItem[]>(`/groups/${groupId}/cycles`),
        api.get<Member[]>(`/groups/${groupId}/members`),
      ])
      setGroup(g)
      setCycles(cycleList)
      setMembers(memberList)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load data. Tap to retry.')
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    if (!group?.current_cycle || !winnerId || bid <= 0) return
    setSubmitting(true)
    setFormError(null)
    setSuccessMsg(null)
    setWarnings([])
    try {
      const result = await api.post<{ warnings?: string[] }>(
        `/groups/${groupId}/cycles/${group.current_cycle.cycle_id}/record-winner`,
        {
          winner_user_id: winnerId,
          bid_amount: bid,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      )
      setSuccessMsg('Winner recorded successfully.')
      if (result.warnings?.length) setWarnings(result.warnings)
      setWinnerId('')
      setBidRupees('')
      setNotes('')
      await load()
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to record winner.')
    } finally {
      setSubmitting(false)
    }
  }

  const bid             = Math.round(parseFloat(bidRupees) * 100) || 0
  const poolAmount      = group?.pool_amount ?? 0
  const winnerTakeaway  = bid > 0 && bid < poolAmount ? poolAmount - bid : null

  const currentCycle    = group?.current_cycle
  const canRecord       = !!currentCycle && currentCycle.status === 'Open' && !currentCycle.winner_user_id
  const eligibleMembers = members.filter(m => m.is_eligible_to_win)
  const pastWinners     = cycles
    .filter(c => c.winner !== null)
    .sort((a, b) => b.month_number - a.month_number)

  // ── loading / error ──────────────────────────────────────────────────────────

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
        <p className="text-sm text-gray-500">{error ?? 'Could not load data.'}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  // ── render ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-2 py-2 flex items-center gap-1">
        <button onClick={() => navigate(`/groups/${groupId}`)} className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <p className="flex-1 text-sm font-semibold text-gray-900">Record winner</p>
        <p className="text-xs text-gray-400 pr-2 truncate max-w-[120px]">{group.name}</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-8 space-y-3 pt-3 px-3">

        {/* Record form */}
        {canRecord ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <p className="text-sm font-semibold text-gray-900 mb-1">
              {currentCycle!.month_label}
            </p>
            <p className="text-xs text-gray-400 mb-4">
              Pool: {formatPaise(poolAmount)} · record the highest bidder
            </p>

            {formError  && <p className="text-sm text-red-600 mb-3">{formError}</p>}
            {successMsg && <p className="text-sm text-green-600 mb-3">{successMsg}</p>}
            {warnings.map((w, i) => (
              <div key={i} className="mb-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">{w}</div>
            ))}

            <form onSubmit={handleSubmit} className="space-y-4">

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Winner</label>
                <select
                  value={winnerId}
                  onChange={e => setWinnerId(e.target.value)}
                  required
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-maroon-500"
                >
                  <option value="">Select eligible member</option>
                  {eligibleMembers.map(m => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name} ({m.wins_count}/{m.share_count} wins)
                    </option>
                  ))}
                </select>
                {eligibleMembers.length === 0 && (
                  <p className="text-xs text-amber-600 mt-1">No eligible members — all shares have been won.</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Winning bid — amount left behind (₹)
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">₹</span>
                  <input
                    type="number"
                    value={bidRupees}
                    onChange={e => setBidRupees(e.target.value)}
                    placeholder="16,000"
                    min="1"
                    step="1"
                    required
                    className="w-full pl-8 pr-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500"
                  />
                </div>
                {winnerTakeaway !== null && (
                  <div className="mt-2 bg-maroon-50 rounded-lg px-3 py-2 text-xs text-maroon-700 space-y-0.5">
                    <p>Bid left behind → basket: <span className="font-semibold">{formatPaise(bid)}</span></p>
                    <p>Winner receives: <span className="font-semibold">{formatPaise(winnerTakeaway)}</span></p>
                  </div>
                )}
                {bid >= poolAmount && bid > 0 && (
                  <p className="text-xs text-red-600 mt-1">Bid cannot exceed the pool amount ({formatPaise(poolAmount)}).</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Notes <span className="text-gray-400">(optional)</span></label>
                <input
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="e.g. Unanimous bid"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || !winnerId || bid <= 0 || bid >= poolAmount}
                className="w-full py-2.5 rounded-xl bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white transition"
              >
                {submitting ? 'Recording…' : 'Confirm winner'}
              </button>
            </form>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4">
            {currentCycle?.winner_user_id ? (
              <p className="text-sm text-gray-500">
                Winner already recorded for <span className="font-medium text-gray-800">{currentCycle.month_label}</span>.
              </p>
            ) : (
              <p className="text-sm text-gray-400">No open cycle to record a winner for.</p>
            )}
          </div>
        )}

        {/* Past winners */}
        <div>
          <p className="text-xs font-semibold text-gray-400 tracking-widest px-1 mb-2">PAST WINNERS</p>

          {pastWinners.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 px-4 py-8 text-center">
              <p className="text-sm text-gray-400">No winners recorded yet.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {pastWinners.map(c => (
                <div key={c.cycle_id} className="bg-white rounded-2xl border border-gray-100 p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-maroon-100 flex items-center justify-center text-xs font-bold text-maroon-700 shrink-0">
                      {initials(c.winner!.name ?? '?')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-gray-800 truncate">{c.winner!.name ?? '—'}</p>
                        {c.is_skip_month && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium shrink-0">Skip</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400">{c.month_label}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-gray-400">Left behind</p>
                      <p className="text-sm font-bold text-gray-800">
                        {c.is_skip_month ? '—' : formatPaise(c.bid_amount ?? 0)}
                      </p>
                    </div>
                  </div>

                  {!c.is_skip_month && c.bid_amount !== null && c.winner_takeaway !== null && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="bg-gray-50 rounded-lg px-3 py-2">
                        <p className="text-[10px] text-gray-400 mb-0.5">Bid (to basket)</p>
                        <p className="text-xs font-bold text-gray-700">{formatPaise(c.bid_amount)}</p>
                      </div>
                      <div className="bg-maroon-50 rounded-lg px-3 py-2">
                        <p className="text-[10px] text-maroon-400 mb-0.5">Winner received</p>
                        <p className="text-xs font-bold text-maroon-700">{formatPaise(c.winner_takeaway)}</p>
                      </div>
                    </div>
                  )}

                  {c.is_skip_month && (
                    <div className="mt-3 bg-amber-50 rounded-lg px-3 py-2">
                      <p className="text-[10px] text-amber-500 mb-0.5">Basket payout (skip month)</p>
                      <p className="text-xs font-bold text-amber-700">{formatPaise(c.winner_takeaway ?? poolAmount)}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
