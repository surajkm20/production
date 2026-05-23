import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise, initials } from '../lib/format'
import type { GroupDetail, CycleItem, Payment, CycleSummary } from '../types/api'

type FilterTab = 'All' | 'Unpaid' | 'Paid'

// Custom toggle switch component — shows green when checked (paid), gray when unchecked (unpaid)
function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-maroon-600' : 'bg-gray-200'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
    </button>
  )
}

function formatShortTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' +
    d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

export default function MarkPaymentsPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [group, setGroup] = useState<GroupDetail | null>(null)
  const [cycles, setCycles] = useState<CycleItem[]>([])
  // cycleIdx: which cycle is currently selected in the cycle nav (0 = oldest)
  const [cycleIdx, setCycleIdx] = useState(0)
  const [payments, setPayments] = useState<Payment[]>([])
  const [summary, setSummary] = useState<CycleSummary | null>(null)
  const [filter, setFilter] = useState<FilterTab>('All')
  const [loading, setLoading] = useState(true)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reminding, setReminding] = useState(false)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [showBulkConfirm, setShowBulkConfirm] = useState(false)
  // useRef stores the setTimeout ID so we can cancel it if a new toast fires before the old one expires
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { loadGroup() }, [groupId])

  // Initial load: group + all cycles in parallel, then load payments for the active/current cycle
  async function loadGroup() {
    setLoading(true)
    setError(null)
    try {
      const [g, cycleList] = await Promise.all([
        api.get<GroupDetail>(`/groups/${groupId}`),
        api.get<CycleItem[]>(`/groups/${groupId}/cycles`),
      ])
      setGroup(g)
      setCycles(cycleList)

      // Redirect away if group is closed — this page has no read-only value for closed groups
      if (g.status === 'Closed') {
        navigate(`/groups/${groupId}`, { replace: true })
        return
      }

      // Find the current open cycle to default-select it
      const currentCycleId = g.current_cycle?.cycle_id
      const defaultIdx = currentCycleId
        ? cycleList.findIndex(c => c.cycle_id === currentCycleId)
        : cycleList.findIndex(c => c.status === 'Open')
      const idx = defaultIdx >= 0 ? defaultIdx : cycleList.length - 1
      setCycleIdx(idx)

      // Sequential: load payments only after we know which cycle to load
      if (cycleList[idx]) {
        await loadPayments(cycleList[idx].cycle_id)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/login', { replace: true })
      } else if (err instanceof ApiError && err.status === 403) {
        navigate('/dashboard', { replace: true })
      } else {
        setError('Could not load payments. Tap to retry.')
      }
    } finally {
      setLoading(false)
    }
  }

  // Fetch payments for a specific cycle — also updates the summary bar
  async function loadPayments(cycle_id: string) {
    setPaymentsLoading(true)
    try {
      // Response shape: { data: Payment[], summary: CycleSummary }
      const res = await api.get<{ data: Payment[]; summary: CycleSummary }>(
        `/groups/${groupId}/cycles/${cycle_id}/payments`
      )
      setPayments(res.data)
      setSummary(res.summary)
    } finally {
      setPaymentsLoading(false)
    }
  }

  // Navigate between cycles via the ← → arrows at the top
  async function goToCycle(newIdx: number) {
    if (newIdx < 0 || newIdx >= cycles.length) return
    setCycleIdx(newIdx)
    setFilter('All')
    await loadPayments(cycles[newIdx].cycle_id)
  }

  // Toast: show a brief message, auto-dismiss after 3s.
  // Clears any running timer first to prevent stacking.
  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToastMsg(msg)
    toastTimer.current = setTimeout(() => setToastMsg(null), 3000)
  }

  // Optimistic payment toggle:
  // 1. Immediately flip the payment status in local state (instant UI feedback)
  // 2. Recalculate the summary bar from the updated local state
  // 3. Call the API in the background
  // 4. On failure: revert both payments and summary to the pre-toggle snapshot
  async function togglePayment(payment: Payment) {
    const newStatus = payment.status === 'Paid' ? 'Unpaid' : 'Paid'
    const prev = [...payments]  // snapshot for rollback

    // Compute the updated array first, then set both states from the same array.
    // Avoids calling setSummary inside a state updater (side effect anti-pattern).
    const updated = payments.map(p =>
      p.payment_id === payment.payment_id
        ? { ...p, status: newStatus, paid_at: newStatus === 'Paid' ? new Date().toISOString() : null, paid_amount: newStatus === 'Paid' ? p.expected_amount : 0 } as Payment
        : p
    )
    setPayments(updated)
    setSummary(recalcSummary(updated))

    try {
      // API call: PATCH /v1/groups/:groupId/payments/:paymentId  Body: { status }
      await api.patch(`/groups/${groupId}/payments/${payment.payment_id}`, { status: newStatus })
      showToast(newStatus === 'Paid' ? `${payment.member_name} marked paid` : `${payment.member_name} marked unpaid`)
    } catch {
      // Revert both states to the pre-toggle snapshot on failure
      setPayments(prev)
      setSummary(recalcSummary(prev))
      showToast('Failed to update — please retry.')
    }
  }

  // Pure function: derive a CycleSummary from the current payments array.
  // Called after every optimistic toggle so the totals in the summary bar stay in sync.
  function recalcSummary(ps: Payment[]): CycleSummary {
    return {
      total_expected: ps.reduce((s, p) => s + p.expected_amount, 0),
      total_paid:     ps.filter(p => p.status === 'Paid').reduce((s, p) => s + p.expected_amount, 0),
      paid_count:     ps.filter(p => p.status === 'Paid').length,
      unpaid_count:   ps.filter(p => p.status === 'Unpaid').length,
      waived_count:   ps.filter(p => p.status === 'Waived').length,
    }
  }

  // Bulk mark all unpaid as paid — uses a separate bulk endpoint, then re-fetches payments
  async function handleMarkAllPaid() {
    setShowBulkConfirm(false)
    setBulkLoading(true)
    const cycle = cycles[cycleIdx]
    if (!cycle) return
    try {
      // API call: POST /v1/groups/:groupId/cycles/:cycleId/payments/bulk
      await api.post(`/groups/${groupId}/cycles/${cycle.cycle_id}/payments/bulk`, {
        payment_ids: 'all_unpaid',
        status: 'Paid',
        paid_at: new Date().toISOString(),
      })
      // Re-fetch to get the authoritative state from the server
      await loadPayments(cycle.cycle_id)
      showToast('All unpaid members marked as paid.')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Bulk update failed.')
    } finally {
      setBulkLoading(false)
    }
  }

  // Send payment reminders to all unpaid members for the currently selected cycle
  async function handleRemind() {
    const cycle = cycles[cycleIdx]
    if (!cycle) return
    setReminding(true)
    try {
      await api.post(`/groups/${groupId}/cycles/${cycle.cycle_id}/remind-defaulters`, {})
      showToast('Reminders sent!')
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Failed to send reminders.')
    } finally {
      setReminding(false)
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
        <button onClick={loadGroup} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  const cycle = cycles[cycleIdx]
  const isCycleOpen = cycle?.status === 'Open'
  const unpaidCount = summary?.unpaid_count ?? 0

  // Client-side filter — no API call, just filters the already-loaded payments array
  const filtered = payments.filter(p => {
    if (filter === 'Paid')   return p.status === 'Paid'
    if (filter === 'Unpaid') return p.status === 'Unpaid'
    return true
  })

  // Progress bar width (0–100%)
  const collectionPct = summary && summary.total_expected > 0
    ? Math.round((summary.total_paid / summary.total_expected) * 100)
    : 0

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-2 py-2 flex items-center gap-1">
        <button onClick={() => navigate(`/groups/${groupId}`)} className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <p className="flex-1 text-sm font-semibold text-gray-900">Mark payments</p>
        <p className="text-xs text-gray-400 pr-2 truncate max-w-[120px]">{group.name}</p>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">

        {/* Cycle navigation — ← cycle month → arrows let admin browse past cycles */}
        {cycle && (
          <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between">
            <button
              onClick={() => goToCycle(cycleIdx - 1)}
              disabled={cycleIdx === 0}
              className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30 transition"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="text-center">
              <p className="text-sm font-bold text-gray-900">{cycle.month_label}</p>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isCycleOpen ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                {isCycleOpen ? `Open · Due ${cycle.due_date.slice(8)}` : 'Closed'}
              </span>
            </div>
            <button
              onClick={() => goToCycle(cycleIdx + 1)}
              disabled={cycleIdx >= cycles.length - 1}
              className="p-1 text-gray-400 hover:text-gray-600 disabled:opacity-30 transition"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}

        {/* Summary tiles — updated optimistically on every toggle */}
        {summary && (
          <div className="mx-3 mt-3">
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="bg-white rounded-xl p-3 border border-gray-100">
                <p className="text-[11px] text-gray-400 font-medium mb-1">COLLECTED</p>
                <p className="text-base font-bold text-gray-900">{formatPaise(summary.total_paid)}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {summary.paid_count} of {summary.paid_count + summary.unpaid_count + summary.waived_count} paid
                </p>
              </div>
              <div className={`bg-white rounded-xl p-3 border ${summary.unpaid_count > 0 ? 'border-red-100' : 'border-gray-100'}`}>
                <p className="text-[11px] text-gray-400 font-medium mb-1">PENDING</p>
                <p className={`text-base font-bold ${summary.unpaid_count > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                  {formatPaise(summary.total_expected - summary.total_paid)}
                </p>
                <p className={`text-[11px] mt-0.5 ${summary.unpaid_count > 0 ? 'text-red-400' : 'text-gray-400'}`}>
                  {summary.unpaid_count} defaulter{summary.unpaid_count !== 1 ? 's' : ''}
                </p>
              </div>
            </div>

            {/* Collection progress bar — width controlled by inline style */}
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-3">
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${collectionPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Filter pills */}
        <div className="mx-3 mb-2 flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
            {(['All', 'Unpaid', 'Paid'] as FilterTab[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${filter === f ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
              >
                {f}
                {f === 'Unpaid' && summary && summary.unpaid_count > 0 && (
                  <span className="ml-1 text-red-500">{summary.unpaid_count}</span>
                )}
                {f === 'Paid' && summary && (
                  <span className="ml-1 text-gray-400">{summary.paid_count}</span>
                )}
              </button>
            ))}
          </div>
          {isCycleOpen && unpaidCount > 0 && (
            <button
              onClick={() => setShowBulkConfirm(true)}
              disabled={bulkLoading}
              className="ml-auto text-xs text-maroon-600 font-medium disabled:opacity-60"
            >
              {bulkLoading ? 'Updating...' : 'Mark all paid ↗'}
            </button>
          )}
        </div>

        {/* Payment rows — each row has a Toggle that calls togglePayment() */}
        <div className="mx-3 bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {paymentsLoading ? (
            <div className="flex justify-center py-8">
              <svg className="animate-spin w-5 h-5 text-maroon-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8">No payments match this filter.</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {filtered.map(p => {
                const isPaid = p.status === 'Paid'
                return (
                  <div
                    key={p.payment_id}
                    className={`flex items-center gap-3 px-4 py-3 ${!isPaid && p.status === 'Unpaid' ? 'bg-red-50/40' : ''}`}
                  >
                    {/* Avatar color: green = paid, red = unpaid */}
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${isPaid ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                      {initials(p.member_name)}
                    </div>

                    {/* Name + subtitle */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{p.member_name}</p>
                      <p className="text-[11px] text-gray-400 truncate">
                        {isPaid && p.paid_at
                          ? formatShortTime(p.paid_at)
                          : p.status === 'Waived'
                          ? 'Waived'
                          : `Overdue · ${formatPaise(p.expected_amount)} due`}
                      </p>
                    </div>

                    {/* Amount + toggle switch — Toggle hidden for waived payments and closed cycles */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs font-medium ${isPaid ? 'text-green-600' : 'text-gray-400'}`}>
                        {formatPaise(p.expected_amount)}
                      </span>
                      {p.status !== 'Waived' && isCycleOpen && (
                        <Toggle
                          checked={isPaid}
                          onChange={() => togglePayment(p)}
                        />
                      )}
                      {p.status === 'Waived' && (
                        <span className="text-[11px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Waived</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

      </div>

      {/* Bottom action bar */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t border-gray-100 px-4 py-3 flex gap-2">
        <button
          onClick={handleRemind}
          disabled={reminding || unpaidCount === 0}
          className="flex-1 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition"
        >
          {reminding ? 'Sending...' : `Remind ${unpaidCount} unpaid`}
        </button>
        <button
          onClick={() => navigate(`/groups/${groupId}`)}
          className="flex-1 py-3 rounded-xl bg-maroon-600 hover:bg-maroon-700 text-sm font-semibold text-white transition"
        >
          Done
        </button>
      </div>

      {/* Toast notification — fixed above the action bar, auto-dismisses via timer */}
      {toastMsg && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-4 py-2 rounded-full shadow-lg z-50 whitespace-nowrap">
          {toastMsg}
        </div>
      )}

      {/* Bulk confirm dialog — shown before marking all unpaid as paid */}
      {showBulkConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6">
            <h2 className="text-base font-bold text-gray-900 mb-2">Mark all {unpaidCount} as paid?</h2>
            <p className="text-sm text-gray-500 mb-5">
              This will mark all currently unpaid members as paid for {cycle?.month_label}. This cannot be easily undone.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setShowBulkConfirm(false)} className="flex-1 py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition">
                Cancel
              </button>
              <button onClick={handleMarkAllPaid} className="flex-1 py-2.5 rounded-lg bg-maroon-600 hover:bg-maroon-700 text-sm font-semibold text-white transition">
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
