import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise, initials } from '../lib/format'
import type { CycleDetail, GroupDetail, Member } from '../types/api'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function statusChipCls(cycle: CycleDetail) {
  if (cycle.is_skip_month)       return 'bg-blue-100 text-blue-700'
  if (cycle.status === 'Closed') return 'bg-green-100 text-green-700'
  return 'bg-amber-100 text-amber-700'
}

function statusLabel(cycle: CycleDetail) {
  if (cycle.is_skip_month)       return 'Skip'
  if (cycle.status === 'Closed') return 'Closed'
  return 'Open'
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'lg' ? 'w-12 h-12 text-base' : size === 'sm' ? 'w-7 h-7 text-[10px]' : 'w-9 h-9 text-xs'
  return (
    <div className={`${sz} rounded-full bg-maroon-100 text-maroon-700 font-bold flex items-center justify-center shrink-0`}>
      {initials(name || '?')}
    </div>
  )
}

// ─── CycleDetailPage ──────────────────────────────────────────────────────────

export default function CycleDetailPage() {
  // Both groupId and cycleId come from URL params: /groups/:groupId/history/:cycleId
  const { groupId, cycleId } = useParams<{ groupId: string; cycleId: string }>()
  const navigate              = useNavigate()
  // useLocation reads the state passed by HistoryPage when it called navigate():
  //   navigate(`/groups/${groupId}/history/${cycle.cycle_id}`, { state: { role: '...', groupName: '...' } })
  const location              = useLocation()

  // Extract role from navigation state — avoids an extra /me API call just to know the role
  const roleFromState: string = (location.state as { role?: string })?.role ?? 'Member'
  const isAdmin = roleFromState === 'Admin'

  const [cycle,         setCycle]         = useState<CycleDetail | null>(null)
  const [group,         setGroup]         = useState<GroupDetail | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  const [auditExpanded, setAuditExpanded] = useState(false)

  // Correct-cycle modal state
  const [showCorrect,       setShowCorrect]       = useState(false)
  const [members,           setMembers]           = useState<Member[]>([])
  const [correctWinner,     setCorrectWinner]     = useState('')
  const [correctBidRupees,  setCorrectBidRupees]  = useState('')
  const [correctNotes,      setCorrectNotes]      = useState('')
  const [correctLoading,    setCorrectLoading]    = useState(false)
  const [correctError,      setCorrectError]      = useState<string | null>(null)
  const [correctWinnerNumber, setCorrectWinnerNumber] = useState(1)

  // Reopen-cycle state
  const [reopenLoading, setReopenLoading] = useState(false)
  const [reopenError,   setReopenError]   = useState<string | null>(null)

  useEffect(() => { load() }, [groupId, cycleId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // Fetch cycle detail and group in parallel — neither depends on the other
      const [c, g] = await Promise.all([
        api.get<CycleDetail>(`/groups/${groupId}/cycles/${cycleId}`),
        api.get<GroupDetail>(`/groups/${groupId}`),
      ])
      setCycle(c)
      setGroup(g)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load cycle. Tap to retry.')
    } finally {
      setLoading(false)
    }
  }

  async function handleReopen() {
    if (!cycle) return
    setReopenLoading(true)
    setReopenError(null)
    try {
      await api.reopenCycle(groupId!, cycleId!)
      await load()
    } catch (err) {
      setReopenError(err instanceof ApiError ? err.message : 'Failed to reopen cycle.')
    } finally {
      setReopenLoading(false)
    }
  }

  async function openCorrectModal(winnerNumber: number = 1) {
    const slotIdx = winnerNumber - 1
    setCorrectWinnerNumber(winnerNumber)
    setCorrectError(null)
    setCorrectWinner(cycle?.winners?.[slotIdx]?.user_id ?? '')
    setCorrectBidRupees(cycle?.winners?.[slotIdx]?.bid_amount != null ? String(cycle.winners[slotIdx].bid_amount / 100) : '')
    setCorrectNotes(cycle?.notes ?? '')
    setShowCorrect(true)
    try {
      const list = await api.get<Member[]>(`/groups/${groupId}/members`)
      setMembers(list)
    } catch {
      setCorrectError('Could not load members list.')
    }
  }

  async function submitCorrection(e: React.FormEvent) {
    e.preventDefault()
    if (!cycle || !correctWinner) return
    setCorrectLoading(true)
    setCorrectError(null)
    const bid = Math.round(parseFloat(correctBidRupees) * 100) || 0
    try {
      await api.correctCycle(groupId!, cycleId!, {
        winner_user_id: correctWinner,
        ...(!cycle.is_skip_month ? { bid_amount: bid } : {}),
        ...(correctNotes.trim() ? { notes: correctNotes.trim() } : {}),
        winner_number: correctWinnerNumber,
      })
      setShowCorrect(false)
      await load()
    } catch (err) {
      setCorrectError(err instanceof ApiError ? err.message : 'Correction failed.')
    } finally {
      setCorrectLoading(false)
    }
  }

  // ── render ──────────────────────────────────────────────────────────────────

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

  if (error || !cycle) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-gray-500">{error ?? 'Cycle not found.'}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  const firstWinner    = cycle.winners?.[0] ?? null
  const winnerName     = firstWinner?.name ?? ''
  const hasWinner      = (cycle.winners?.length ?? 0) > 0
  const isDoubleChiti       = (cycle.winners?.length ?? 0) > 1
  const isCurrentCycle = group?.current_cycle?.cycle_id === cycleId
  const paidCount      = cycle.payments.filter(p => p.status === 'Paid').length
  const totalCount     = cycle.payments.length
  const canCorrect     = isAdmin && hasWinner
  const canReopen      = isAdmin && cycle.status === 'Closed'

  // For the correction modal: show eligible members + the winner of the slot being corrected
  const slotWinner = cycle.winners?.[correctWinnerNumber - 1] ?? null
  const correctableMembers = members.filter(
    m => m.is_eligible_to_win || m.user_id === slotWinner?.user_id,
  )
  const correctBid = Math.round(parseFloat(correctBidRupees) * 100) || 0
  const poolAmount = group?.pool_amount ?? 0
  const correctTakeaway = correctBid > 0 && correctBid < poolAmount ? poolAmount - correctBid : null

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-2 py-2 flex items-center gap-2">
        <button onClick={() => navigate(-1)} className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <p className="flex-1 text-sm font-semibold text-gray-900 px-1">{cycle.month_label}</p>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full mr-2 ${statusChipCls(cycle)}`}>
          {statusLabel(cycle)}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto pb-6 space-y-3 pt-3 px-3">

        {/* ── Outcome card — shows winner, bid, and takeaway ──────────────────── */}
        <div className={`rounded-2xl p-4 border ${
          hasWinner ? 'bg-maroon-50 border-maroon-100' : 'bg-gray-50 border-gray-200'
        }`}>
          {/* Regular month with winner — handles both single winner and Double Chiti (2 winners) */}
          {hasWinner && !cycle.is_skip_month && (
            <>
              {isDoubleChiti ? (
                /* Double Chiti: two winners */
                <>
                  <div className="flex items-center gap-2 mb-3">
                    <p className="text-[11px] font-semibold text-maroon-400 tracking-widest">WINNERS</p>
                    <span className="text-[9px] font-semibold text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-1.5 py-0.5">
                      Double Chiti
                    </span>
                  </div>
                  {cycle.winners.map((winner, idx) => (
                    <div key={winner.user_id + '-' + idx}>
                      {idx > 0 && <div className="border-t border-maroon-100 my-3" />}
                      <div className="flex items-center gap-3 mb-2">
                        <Avatar name={winner.name ?? ''} size="lg" />
                        <p className="text-base font-bold text-gray-900">{winner.name}</p>
                      </div>
                      <div className="flex gap-2">
                        <div className="flex-1 bg-white rounded-xl p-2.5 border border-maroon-100">
                          <p className="text-[10px] text-gray-400 mb-0.5">Won bid</p>
                          <p className="text-sm font-bold text-gray-900">{formatPaise(winner.bid_amount)}</p>
                        </div>
                        <div className="flex-1 bg-white rounded-xl p-2.5 border border-maroon-100">
                          <p className="text-[10px] text-gray-400 mb-0.5">Took home</p>
                          <p className="text-sm font-bold text-gray-900">{formatPaise(winner.winner_takeaway)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                  {firstWinner?.recorded_at && (
                    <p className="text-[11px] text-gray-400 mt-2.5">
                      Recorded on {formatDateTime(firstWinner.recorded_at)}
                    </p>
                  )}
                  {canCorrect && (
                    <div className="mt-3 flex flex-col gap-2">
                      {cycle.winners.map((w, i) => (
                        <button
                          key={w.user_id + '-' + i}
                          onClick={() => openCorrectModal(i + 1)}
                          className="w-full py-1.5 text-xs font-medium text-amber-700 border border-amber-200 bg-amber-50 rounded-xl hover:bg-amber-100 transition"
                        >
                          Correct Winner {i + 1} — {w.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                /* Single winner */
                <>
                  <p className="text-[11px] font-semibold text-maroon-400 tracking-widest mb-3">WINNER</p>
                  <div className="flex items-center gap-3 mb-3">
                    <Avatar name={winnerName} size="lg" />
                    <p className="text-lg font-bold text-gray-900">{winnerName}</p>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-white rounded-xl p-2.5 border border-maroon-100">
                      <p className="text-[10px] text-gray-400 mb-0.5">Won bid</p>
                      <p className="text-sm font-bold text-gray-900">{formatPaise(firstWinner?.bid_amount ?? 0)}</p>
                    </div>
                    <div className="flex-1 bg-white rounded-xl p-2.5 border border-maroon-100">
                      <p className="text-[10px] text-gray-400 mb-0.5">Took home</p>
                      <p className="text-sm font-bold text-gray-900">{formatPaise(firstWinner?.winner_takeaway ?? 0)}</p>
                    </div>
                  </div>
                  {firstWinner?.recorded_at && (
                    <p className="text-[11px] text-gray-400 mt-2.5">
                      Recorded on {formatDateTime(firstWinner.recorded_at)}
                    </p>
                  )}
                  {canCorrect && (
                    <button
                      onClick={() => openCorrectModal(1)}
                      className="mt-3 w-full py-1.5 text-xs font-medium text-amber-700 border border-amber-200 bg-amber-50 rounded-xl hover:bg-amber-100 transition"
                    >
                      Correct this entry
                    </button>
                  )}
                </>
              )}
            </>
          )}

          {/* Skip month — someone receives from basket instead of a bid */}
          {hasWinner && cycle.is_skip_month && (
            <>
              <p className="text-[11px] font-semibold text-blue-400 tracking-widest mb-3">SKIP MONTH</p>
              <div className="flex items-center gap-3 mb-1">
                <Avatar name={winnerName} size="lg" />
                <div>
                  <p className="text-base font-bold text-gray-900">{winnerName}</p>
                  <p className="text-xs text-gray-500">Took {formatPaise(firstWinner?.winner_takeaway ?? 0)} from basket</p>
                </div>
              </div>
              {firstWinner?.recorded_at && (
                <p className="text-[11px] text-gray-400 mt-2">
                  Declared on {formatDateTime(firstWinner.recorded_at)}
                </p>
              )}
              {canCorrect && (
                <button
                  onClick={() => openCorrectModal(1)}
                  className="mt-3 w-full py-1.5 text-xs font-medium text-amber-700 border border-amber-200 bg-amber-50 rounded-xl hover:bg-amber-100 transition"
                >
                  Correct this entry
                </button>
              )}
            </>
          )}

          {/* No winner yet — admin sees a "Tap to record" shortcut if this is the current cycle */}
          {!hasWinner && (
            <>
              <p className="text-sm text-gray-400 text-center py-2">Winner not yet recorded</p>
              {isAdmin && isCurrentCycle && (
                <button
                  onClick={() => navigate(`/groups/${groupId}/record-winner`)}
                  className="mt-2 w-full py-2 text-xs font-medium text-maroon-600 border border-maroon-200 rounded-xl hover:bg-maroon-50 transition"
                >
                  Tap to record →
                </button>
              )}
            </>
          )}
        </div>

        {/* ── Basket impact — how this cycle moved the basket balance ──────── */}
        {cycle.basket_impact && (
          <div className="bg-white rounded-2xl p-4 border border-gray-100">
            <p className="text-[11px] font-semibold text-gray-400 tracking-widest mb-2">BASKET IMPACT</p>
            <p className="text-sm text-gray-800">
              <span className="font-medium">{formatPaise(cycle.basket_impact.balance_before)}</span>
              <span className="mx-1.5 text-gray-400">→</span>
              <span className="font-medium">{formatPaise(cycle.basket_impact.balance_after)}</span>
              <span className={`ml-1.5 text-xs font-semibold ${cycle.basket_impact.delta >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                ({cycle.basket_impact.delta >= 0 ? '+' : ''}{formatPaise(cycle.basket_impact.delta)} this month)
              </span>
            </p>
            <button
              onClick={() => navigate(`/groups/${groupId}/basket`)}
              className="mt-2 text-xs text-maroon-600 font-medium hover:underline"
            >
              View ledger entry →
            </button>
          </div>
        )}

        {/* ── Final cycle basket offset banner ──────────────────────────────── */}
        {cycle.is_final_cycle && cycle.basket_contribution > 0 && (
          <div className="bg-teal-50 border border-teal-200 rounded-2xl p-4">
            <p className="text-[11px] font-semibold text-teal-600 tracking-widest mb-2">FINAL CYCLE — BASKET OFFSET</p>
            <p className="text-xs text-teal-800 leading-relaxed">
              The basket contributed <span className="font-semibold">{formatPaise(cycle.basket_contribution)}</span> toward
              this cycle's pool + admin maintenance fee.
              {cycle.waived_count === cycle.payments.length && cycle.payments.length > 0
                ? ' The full amount is covered — no member needs to pay.'
                : ` Members pay reduced contributions.`}
            </p>
          </div>
        )}
        {cycle.is_final_cycle && cycle.basket_contribution === 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
            <p className="text-[11px] font-semibold text-amber-600 tracking-widest mb-2">FINAL CYCLE</p>
            <p className="text-xs text-amber-800 leading-relaxed">
              This is the last cycle. The basket had no balance to offset contributions — members pay the full share including the admin maintenance fee portion.
            </p>
          </div>
        )}

        {/* ── Payments list for this cycle ──────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50">
            <p className="text-[11px] font-semibold text-gray-400 tracking-widest">
              {cycle.is_final_cycle
                ? `PAYMENTS (${paidCount}/${cycle.payments.filter(p => p.status !== 'Waived').length} paid, ${cycle.waived_count} waived)`
                : `PAYMENTS (${paidCount}/${totalCount} paid)`}
            </p>
          </div>

          {cycle.payments.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-6">No payment records yet.</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {cycle.payments.map(p => (
                <div key={p.payment_id} className="flex items-center gap-3 px-4 py-3">
                  <Avatar name={p.member_name} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium text-gray-900 truncate">{p.member_name}</p>
                      {p.share_count > 1 && (
                        <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1">{p.share_count} shares</span>
                      )}
                    </div>
                    {p.status === 'Paid' && p.paid_at && (
                      <p className="text-[10px] text-gray-400 mt-0.5">{formatDateTime(p.paid_at)}</p>
                    )}
                  </div>

                  <div className="shrink-0 flex items-center gap-1.5">
                    {p.status === 'Paid' ? (
                      <>
                        <p className="text-xs text-gray-700">{formatPaise(p.paid_amount)}</p>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">Paid</span>
                      </>
                    ) : p.status === 'Waived' ? (
                      <>
                        <p className="text-xs text-gray-400">—</p>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">Waived</span>
                      </>
                    ) : (
                      <>
                        <p className="text-xs text-gray-500">{formatPaise(p.expected_amount)} expected</p>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">Unpaid</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Admin notes for this cycle ─────────────────────────────────────── */}
        {cycle.notes && (
          <div className="bg-white rounded-2xl p-4 border border-gray-100">
            <p className="text-[11px] font-semibold text-gray-400 tracking-widest mb-2">NOTES</p>
            <p className="text-xs text-gray-600 italic leading-relaxed">{cycle.notes}</p>
          </div>
        )}

        {/* ── Audit log — collapsible section, toggles with auditExpanded ──── */}
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <button
            onClick={() => setAuditExpanded(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition"
          >
            <p className="text-[11px] font-semibold text-gray-400 tracking-widest">ACTIVITY</p>
            {/* Chevron rotates 180° when expanded */}
            <svg
              className={`w-4 h-4 text-gray-400 transition-transform ${auditExpanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {auditExpanded && (
            <div className="px-4 pb-4 border-t border-gray-50">
              <p className="text-xs text-gray-400 text-center py-4">Audit log coming in a future update.</p>
            </div>
          )}
        </div>

        {/* ── Reopen Cycle — admin only, shown on Closed cycles ────────────── */}
        {canReopen && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <p className="text-[11px] font-semibold text-gray-400 tracking-widest mb-3">ADMIN ACTIONS</p>
            {reopenError && (
              <p className="text-xs text-red-600 mb-2">{reopenError}</p>
            )}
            <button
              onClick={handleReopen}
              disabled={reopenLoading}
              className="w-full py-2.5 rounded-xl border border-amber-300 bg-amber-50 text-sm font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60 transition"
            >
              {reopenLoading ? 'Reopening…' : 'Reopen Cycle'}
            </button>
            <p className="text-[10px] text-gray-400 mt-2 text-center">
              Reopening sets this cycle back to Open. Payments and basket transactions are not reversed.
            </p>
          </div>
        )}

      </div>

      {/* ── Correct Cycle Modal ───────────────────────────────────────────────── */}
      {showCorrect && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-0">
          <div className="w-full max-w-md bg-white rounded-t-3xl p-5 pb-8 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-bold text-gray-900">
                {isDoubleChiti ? `Correct Winner ${correctWinnerNumber}` : 'Correct cycle entry'}
              </p>
              <button onClick={() => setShowCorrect(false)} className="text-gray-400 hover:text-gray-600 transition">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4">
              This will reverse the existing basket entry and apply the corrected values. The change is permanent and logged.
            </p>

            {correctError && <p className="text-sm text-red-600 mb-3">{correctError}</p>}

            <form onSubmit={submitCorrection} className="space-y-4">

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Winner</label>
                <select
                  value={correctWinner}
                  onChange={e => setCorrectWinner(e.target.value)}
                  required
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-maroon-500"
                >
                  <option value="">Select member</option>
                  {correctableMembers.map(m => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name} ({m.wins_count}/{m.share_count} wins){m.user_id === slotWinner?.user_id ? ' — current' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {!cycle.is_skip_month && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Corrected bid amount (₹)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-500">₹</span>
                    <input
                      type="number"
                      value={correctBidRupees}
                      onChange={e => setCorrectBidRupees(e.target.value)}
                      min="1"
                      step="1"
                      required
                      className="w-full pl-8 pr-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500"
                    />
                  </div>
                  {correctTakeaway !== null && (
                    <div className="mt-2 bg-maroon-50 rounded-lg px-3 py-2 text-xs text-maroon-700 space-y-0.5">
                      <p>Bid → basket: <span className="font-semibold">{formatPaise(correctBid)}</span></p>
                      <p>Winner receives: <span className="font-semibold">{formatPaise(correctTakeaway)}</span></p>
                    </div>
                  )}
                  {correctBid >= poolAmount && correctBid > 0 && (
                    <p className="text-xs text-red-600 mt-1">Bid cannot exceed pool ({formatPaise(poolAmount)}).</p>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Notes <span className="text-gray-400">(optional)</span></label>
                <input
                  type="text"
                  value={correctNotes}
                  onChange={e => setCorrectNotes(e.target.value)}
                  placeholder="Reason for correction"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500"
                />
              </div>

              <button
                type="submit"
                disabled={
                  correctLoading || !correctWinner ||
                  (!cycle.is_skip_month && (correctBid <= 0 || correctBid >= poolAmount))
                }
                className="w-full py-2.5 rounded-xl bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white transition"
              >
                {correctLoading ? 'Saving…' : 'Save correction'}
              </button>
            </form>
          </div>
        </div>
      )}

    </div>
  )
}
