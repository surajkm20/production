import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { GroupDetail, CycleSummary, ActivityItem } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

// ─── Activity helpers ─────────────────────────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  PAYMENT_MARKED:       '💳',
  WINNER_RECORDED:      '🏆',
  SKIP_MONTH_DECLARED:  '⏭️',
  CYCLE_CLOSED:         '🔒',
  MEMBER_JOINED:        '👋',
  MEMBER_REMOVED:       '🚪',
  LOAN_DISBURSED:       '💸',
  LOAN_REPAID:          '✅',
  BASKET_ADJUSTED:      '⚖️',
  GROUP_STARTED:        '🚀',
  GROUP_CLOSED:         '🏁',
}

function formatActivityTime(iso: string): string {
  const date = new Date(iso)
  const now  = new Date()
  const time = date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
  if (date.toDateString() === now.toDateString()) return `Today ${time}`
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' ' + time
}

// ─── Three-dot menu ───────────────────────────────────────────────────────────

function ThreeDotMenu({ onRename, onRotateCode, onCloseGroup, onForceDelete }: { onRename: () => void; onRotateCode: () => void; onCloseGroup: () => void; onForceDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(v => !v)} className="p-2 text-gray-500 hover:text-gray-700 transition">
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-9 w-48 bg-white rounded-xl border border-gray-200 shadow-lg z-20 overflow-hidden">
          {[
            { label: 'Rename group',     action: () => { onRename();       setOpen(false) } },
            { label: 'Rotate invite code', action: () => { onRotateCode(); setOpen(false) } },
            { label: 'Close group',      action: () => { onCloseGroup();   setOpen(false) }, danger: true },
            { label: 'Force delete',     action: () => { onForceDelete();  setOpen(false) }, danger: true },
          ].map(item => (
            <button
              key={item.label}
              onClick={item.action}
              className={`w-full text-left px-4 py-2.5 text-sm transition hover:bg-gray-50 ${(item as { danger?: boolean }).danger ? 'text-red-600' : 'text-gray-700'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Close group confirmation modal ──────────────────────────────────────────

interface ClosureSplitRow { user_id: string; name: string; share_count: number; amount: number }

function CloseGroupModal({ groupId, groupName, onClose, onClosed }: {
  groupId: string; groupName: string; onClose: () => void; onClosed: () => void
}) {
  const [loading, setLoading]   = useState(false)
  const [error,   setError]     = useState<string | null>(null)
  const [split,   setSplit]     = useState<ClosureSplitRow[] | null>(null)

  async function handleClose() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.post<{ status: string; closure_split: ClosureSplitRow[]; total_distributed: number }>(
        `/groups/${groupId}/close`, {},
      )
      setSplit(res.closure_split)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to close group.')
    } finally {
      setLoading(false)
    }
  }

  // After showing the split summary, a second "Done" tap exits the modal and reloads the page
  if (split) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
        <div className="bg-white rounded-2xl w-full max-w-sm p-6">
          <p className="text-base font-bold text-gray-900 mb-1">Group closed</p>
          <p className="text-xs text-gray-500 mb-4">Basket balance distributed proportionally to shares.</p>
          <div className="space-y-2 mb-5 max-h-52 overflow-y-auto">
            {split.map(row => (
              <div key={row.user_id} className="flex items-center justify-between text-sm">
                <span className="text-gray-800">{row.name}</span>
                <span className="font-semibold text-gray-900">{formatPaise(row.amount)}</span>
              </div>
            ))}
          </div>
          <button onClick={onClosed} className="w-full py-2.5 rounded-xl bg-maroon-600 text-sm font-semibold text-white">Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6">
        <p className="text-base font-bold text-gray-900 mb-2">Close "{groupName}"?</p>
        <p className="text-xs text-gray-500 mb-1">Before closing, make sure:</p>
        <ul className="text-xs text-gray-500 list-disc list-inside space-y-0.5 mb-4">
          <li>All cycles are closed</li>
          <li>All loans are repaid</li>
        </ul>
        <p className="text-xs text-red-600 mb-4">This action is permanent and cannot be undone.</p>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition">Cancel</button>
          <button onClick={handleClose} disabled={loading} className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-60 text-sm font-semibold text-white transition">
            {loading ? 'Closing…' : 'Yes, close group'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Force delete confirmation modal ─────────────────────────────────────────

function ForceDeleteModal({ groupId, groupName, onClose, onDeleted }: {
  groupId: string; groupName: string; onClose: () => void; onDeleted: () => void
}) {
  const [confirm,  setConfirm]  = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  async function handleDelete() {
    setLoading(true)
    setError(null)
    try {
      await api.delete(`/groups/${groupId}`)
      onDeleted()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete group.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6">
        <p className="text-base font-bold text-gray-900 mb-1">Force delete "{groupName}"?</p>
        <p className="text-xs text-red-600 mb-4">
          This permanently deletes the group and ALL data — cycles, payments, winners, basket, loans. This cannot be undone.
        </p>
        <p className="text-xs text-gray-500 mb-1">Type the group name to confirm:</p>
        <input
          type="text"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder={groupName}
          className="w-full px-3.5 py-2.5 mb-4 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-500"
        />
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition">Cancel</button>
          <button
            onClick={handleDelete}
            disabled={loading || confirm !== groupName}
            className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 text-sm font-semibold text-white transition"
          >
            {loading ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Rename modal ─────────────────────────────────────────────────────────────

// RenameModal is a self-contained modal — its own state, form, and API call.
// Props: current group name (pre-fills the input); callbacks to close and notify parent.
function RenameModal({ groupId, current, onClose, onSaved }: { groupId: string; current: string; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(current)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    if (name.trim() === current) { onClose(); return }  // no change, nothing to save
    setLoading(true)
    try {
      // API call: PATCH /v1/groups/:groupId  Body: { name }
      await api.patch(`/groups/${groupId}`, { name: name.trim() })
      onSaved(name.trim())  // tell parent to update the group name in its own state
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6">
        <h2 className="text-base font-bold text-gray-900 mb-4">Rename group</h2>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            autoFocus
            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
          />
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition">Cancel</button>
            <button type="submit" disabled={loading || !name.trim()} className="flex-1 py-2.5 rounded-lg bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white transition">
              {loading ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Metric tile ──────────────────────────────────────────────────────────────

// Reusable tile for the 2x2 metrics grid. Optional onTap makes it a button (e.g., "Record winner ↗").
function MetricTile({ label, value, sub, danger, onTap }: { label: string; value: string; sub: string; danger?: boolean; onTap?: () => void }) {
  return (
    <button
      onClick={onTap}
      disabled={!onTap}
      className="bg-white rounded-xl p-3 text-left disabled:cursor-default hover:enabled:bg-gray-50 transition border border-gray-100"
    >
      <p className="text-[11px] text-gray-400 font-medium mb-1">{label}</p>
      <p className={`text-base font-bold ${danger ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
      <p className={`text-[11px] mt-0.5 ${danger ? 'text-red-400' : 'text-gray-400'}`}>{sub}</p>
    </button>
  )
}

// ─── Quick action button ──────────────────────────────────────────────────────

function ActionButton({ icon, label, onClick, loading: busy }: { icon: string; label: string; onClick: () => void; loading?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex flex-col items-center justify-center gap-1.5 py-4 bg-white rounded-xl border border-gray-100 text-gray-700 hover:bg-maroon-50 hover:border-maroon-200 disabled:opacity-60 transition"
    >
      <span className="text-xl">{icon}</span>
      <span className="text-[11px] font-medium text-center leading-tight">{busy ? 'Sending...' : label}</span>
    </button>
  )
}

// ─── AdminDashboardPage ───────────────────────────────────────────────────────

export default function AdminDashboardPage() {
  // useParams reads the :groupId segment from the URL (e.g., /groups/abc123 → groupId = "abc123")
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [group, setGroup] = useState<GroupDetail | null>(null)
  const [summary, setSummary] = useState<CycleSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reminding, setReminding] = useState(false)
  const [remindMsg, setRemindMsg] = useState<string | null>(null)
  const [showRename, setShowRename] = useState(false)
  const [newInviteCode, setNewInviteCode] = useState<string | null>(null)
  const [rotatingCode, setRotatingCode] = useState(false)
  const [closingCycle, setClosingCycle] = useState(false)
  const [closeCycleError, setCloseCycleError] = useState<string | null>(null)
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [showCloseGroup,   setShowCloseGroup]   = useState(false)
  const [showForceDelete,  setShowForceDelete]  = useState(false)

  // load() runs when the component mounts or when groupId changes (e.g., navigating between groups)
  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // Sequential then parallel:
      // Step 1 — fetch group first because we need g.current_cycle to know what payments to fetch
      const g = await api.get<GroupDetail>(`/groups/${groupId}`)
      setGroup(g)

      // Step 2 — now fire payments + activity in parallel (Promise.all)
      // Payments only fetched if a current cycle exists; otherwise resolves to null immediately
      const [paymentsRes, acts] = await Promise.all([
        g.current_cycle
          ? api.get<{ data: unknown[]; summary: CycleSummary }>(
              `/groups/${groupId}/cycles/${g.current_cycle.cycle_id}/payments`
            )
          : Promise.resolve(null),
        // .catch(() => []) — activity feed is non-critical; silently use empty array on failure
        api.get<ActivityItem[]>(`/groups/${groupId}/activity?limit=5`).catch(() => [] as ActivityItem[]),
      ])
      if (paymentsRes) setSummary(paymentsRes.summary)
      setActivity(acts)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/login', { replace: true })     // token expired
      } else if (err instanceof ApiError && err.status === 403) {
        navigate('/dashboard', { replace: true }) // not the admin of this group
      } else {
        setError('Could not load group. Tap to retry.')
      }
    } finally {
      setLoading(false)
    }
  }

  // POST /v1/groups/:groupId/cycles/:cycleId/remind-defaulters — sends WhatsApp/SMS to unpaid members
  async function handleRemindDefaulters() {
    if (!group?.current_cycle) return
    setReminding(true)
    setRemindMsg(null)
    try {
      await api.post(`/groups/${groupId}/cycles/${group.current_cycle.cycle_id}/remind-defaulters`, {})
      setRemindMsg('Reminders sent!')
    } catch (err) {
      setRemindMsg(err instanceof ApiError ? err.message : 'Failed to send reminders.')
    } finally {
      setReminding(false)
      setTimeout(() => setRemindMsg(null), 3000)  // auto-clear the feedback message after 3s
    }
  }

  // POST /v1/groups/:groupId/rotate-invitation-code — generates a new invite code, invalidates old one
  async function handleRotateCode() {
    setRotatingCode(true)
    setNewInviteCode(null)
    try {
      const res = await api.post<{ invitation_code: string; invitation_code_expires_at: string }>(`/groups/${groupId}/rotate-invitation-code`, {})
      setNewInviteCode(res.invitation_code)
      setGroup(g => g ? { ...g, invitation_code: res.invitation_code, invitation_code_expires_at: res.invitation_code_expires_at } : g)
    } catch (err) {
      setRemindMsg(err instanceof ApiError ? err.message : 'Failed to rotate invite code.')
      setTimeout(() => setRemindMsg(null), 3000)
    } finally {
      setRotatingCode(false)
    }
  }

  // POST /v1/groups/:groupId/cycles/:cycleId/close — marks the cycle closed, then reloads all data
  async function handleCloseCycle() {
    if (!group?.current_cycle) return
    setClosingCycle(true)
    setCloseCycleError(null)
    try {
      const result = await api.post<{ group_closed: boolean }>(`/groups/${groupId}/cycles/${group.current_cycle.cycle_id}/close`, {})
      if (result.group_closed) {
        navigate(`/groups/${groupId}`)
        return
      }
      await load()  // refresh everything — the cycle status and group state have changed
    } catch (err) {
      setCloseCycleError(err instanceof ApiError ? err.message : 'Failed to close cycle.')
    } finally {
      setClosingCycle(false)
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

  if (error || !group) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-gray-500">{error ?? 'Group not found.'}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  const cycle = group.current_cycle
  // pending = how much is still owed this month (null if no payments data yet)
  const pending = summary ? summary.total_expected - summary.total_paid : null

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
        <ThreeDotMenu onRename={() => setShowRename(true)} onRotateCode={handleRotateCode} onCloseGroup={() => setShowCloseGroup(true)} onForceDelete={() => setShowForceDelete(true)} />
      </div>

      <div className="flex-1 overflow-y-auto pb-20">

        {/* Rotate code banner */}
        {rotatingCode && (
          <div className="mx-3 mt-3 px-4 py-3 bg-maroon-50 border border-maroon-200 rounded-xl text-sm text-maroon-700">
            Generating new invite code…
          </div>
        )}
        {newInviteCode && (
          <div className="mx-3 mt-3 px-4 py-3 bg-green-50 border border-green-200 rounded-xl flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-green-700 font-medium mb-0.5">New invite code</p>
              <p className="text-lg font-mono font-bold text-green-800 tracking-widest">{newInviteCode}</p>
            </div>
            <button
              onClick={() => { navigator.clipboard.writeText(newInviteCode); setNewInviteCode(null) }}
              className="text-xs text-green-700 border border-green-300 rounded-lg px-3 py-1.5 hover:bg-green-100 transition"
            >
              Copy & dismiss
            </button>
          </div>
        )}

        {/* Group header block */}
        <div className="bg-white px-4 pt-4 pb-5">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-lg font-bold text-gray-900">{group.name}</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-maroon-100 text-maroon-700 font-medium">Admin</span>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            {group.people_count} people · {group.total_shares} shares · {formatPaise(group.monthly_contribution)}/share · Pool {formatPaise(group.pool_amount)}
          </p>

          {/* Progress bar — inline style drives width percentage */}
          {cycle && (
            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Month {cycle.month_number} of {group.total_months}</span>
                <span>{Math.round((cycle.month_number / group.total_months) * 100)}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-maroon-500 rounded-full transition-all"
                  style={{ width: `${(cycle.month_number / group.total_months) * 100}%` }}
                />
              </div>
            </div>
          )}
          {!cycle && (
            <div className="text-xs text-gray-400">Cycle not started yet</div>
          )}
        </div>

        {/* Current month panel */}
        {cycle && (
          <div className="mx-3 mt-3 bg-gray-50 rounded-2xl p-4 border border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700">Current month — {cycle.month_label}</p>
              {cycle.status === 'Open'
                ? <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Open · Due {parseInt(cycle.due_date.slice(8))}</span>
                : <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Closed</span>
              }
            </div>

            {/* 2×2 metric tiles */}
            <div className="grid grid-cols-2 gap-2">
              <MetricTile
                label="COLLECTED"
                value={summary ? formatPaise(summary.total_paid) : '—'}
                sub={summary ? `${summary.paid_count} of ${summary.paid_count + summary.unpaid_count + summary.waived_count} paid` : ''}
              />
              <MetricTile
                label="PENDING"
                value={pending !== null ? formatPaise(pending) : '—'}
                sub={summary ? `${summary.unpaid_count} defaulter${summary.unpaid_count !== 1 ? 's' : ''}` : ''}
                danger={!!summary && summary.unpaid_count > 0}
              />
              {/* onTap makes this tile clickable → navigate to record-winner page */}
              <MetricTile
                label="WINNER"
                value={(cycle.winners?.length ?? 0) > 0 ? 'Recorded' : 'Not recorded'}
                sub={cycle.winners?.[0]?.bid_amount ? `Bid ${formatPaise(cycle.winners[0].bid_amount)}` : 'Tap to add ↗'}
                onTap={(cycle.winners?.length ?? 0) === 0 ? () => navigate(`/groups/${groupId}/record-winner`) : undefined}
              />
              <MetricTile
                label="BASKET"
                value={group.basket ? formatPaise(group.basket.current_balance) : '—'}
                sub={group.basket ? `₹${((group.basket.total_credited - group.basket.total_debited) / 100).toLocaleString('en-IN')} net` : ''}
              />
            </div>

            {cycle.status === 'Open' && (
              <div className="mt-3">
                {closeCycleError && (
                  <p className="text-xs text-red-600 mb-2">{closeCycleError}</p>
                )}
                <button
                  onClick={handleCloseCycle}
                  disabled={closingCycle}
                  className="w-full py-2.5 rounded-xl bg-maroon-600 hover:bg-maroon-700 disabled:opacity-50 text-sm font-medium text-white transition"
                >
                  {closingCycle ? 'Closing cycle...' : `Close ${cycle.month_label} cycle`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Quick actions grid */}
        <div className="mx-3 mt-3">
          <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">QUICK ACTIONS</p>
          <div className="grid grid-cols-2 gap-2">
            <ActionButton icon="💳" label="Mark payments" onClick={() => navigate(`/groups/${groupId}/payments`)} />
            <ActionButton icon="🏆" label="Record winner" onClick={() => navigate(`/groups/${groupId}/record-winner`)} />
            <ActionButton icon="🔔" label="Remind defaulters" onClick={handleRemindDefaulters} loading={reminding} />
            <ActionButton icon="🧺" label="Basket & loans" onClick={() => navigate(`/groups/${groupId}/basket`)} />
          </div>
          {remindMsg && (
            <p className="text-xs text-center mt-2 text-maroon-600 font-medium">{remindMsg}</p>
          )}
        </div>

        {/* Recent activity feed */}
        <div className="mx-3 mt-3 bg-white rounded-2xl border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-700">Recent activity</p>
            <button onClick={() => navigate(`/groups/${groupId}/history`)} className="text-xs text-maroon-600 font-medium">View all</button>
          </div>
          {activity.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">No activity yet</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {activity.map(item => (
                <div key={item.id} className="flex items-start gap-3 py-2.5">
                  <span className="text-base mt-0.5 shrink-0">
                    {EVENT_ICONS[item.event_type] ?? '📋'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-800 leading-snug">{item.summary}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">{formatActivityTime(item.created_at)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      <GroupNavBar groupId={groupId!} role="Admin" />

      {showRename && (
        <RenameModal
          groupId={group.group_id}
          current={group.name}
          onClose={() => setShowRename(false)}
          onSaved={name => { setGroup(g => g ? { ...g, name } : g); setShowRename(false) }}
        />
      )}

      {showCloseGroup && (
        <CloseGroupModal
          groupId={group.group_id}
          groupName={group.name}
          onClose={() => setShowCloseGroup(false)}
          onClosed={() => navigate('/dashboard', { replace: true })}
        />
      )}

      {showForceDelete && (
        <ForceDeleteModal
          groupId={group.group_id}
          groupName={group.name}
          onClose={() => setShowForceDelete(false)}
          onDeleted={() => navigate('/dashboard', { replace: true })}
        />
      )}
    </div>
  )
}
