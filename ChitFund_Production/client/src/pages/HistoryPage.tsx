import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { CycleItem, GroupDetail } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns the display chip style for a given cycle
function statusChip(cycle: CycleItem) {
  if (cycle.status === 'Pending') return { label: 'Pending', cls: 'bg-gray-100 text-gray-500' }
  if (cycle.is_skip_month)        return { label: 'Skip',    cls: 'bg-blue-100 text-blue-700' }
  if (cycle.status === 'Closed')  return { label: 'Closed',  cls: 'bg-green-100 text-green-700' }
  return                                 { label: 'Open',    cls: 'bg-amber-100 text-amber-700' }
}

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// ─── CycleRow ─────────────────────────────────────────────────────────────────

// Each row is a button that navigates to CycleDetailPage.
// Pending cycles are disabled (not yet started, no detail to show).
// Payment-free cycles (saved by Double Chiti) are non-clickable and teal-tinted.
// The target cycle (the one accumulating extra winners toward becoming payment-free)
// shows a small amber "1/2" progress chip indicating banked extra winners.
function CycleRow({ cycle, isPaymentFree, bankedProgress, winnersPerCycle = 1, onClick }: {
  cycle: CycleItem
  isPaymentFree?: boolean
  /** Progress toward the next payment-free month, e.g. { current: 1, needed: 2 } */
  bankedProgress?: { current: number; needed: number }
  winnersPerCycle?: number
  onClick?: () => void
}) {
  const isPending  = cycle.status === 'Pending'
  const isDisabled = isPending || isPaymentFree
  const chip = isPaymentFree
    ? { label: 'Payment-Free', cls: 'bg-teal-100 text-teal-700' }
    : statusChip(cycle)
  const allPaid = cycle.paid_count > 0 && cycle.paid_count === cycle.total_count

  return (
    <button
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      className={`w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 last:border-0 text-left transition ${
        isPaymentFree
          ? 'bg-teal-50/60 cursor-default'
          : isPending
            ? 'opacity-50 cursor-default'
            : 'hover:bg-gray-50 active:bg-gray-100'
      }`}
    >
      {/* Left — month label + chip */}
      <div className="shrink-0 w-[72px]">
        <p className={`text-sm font-semibold leading-tight ${isPaymentFree ? 'text-teal-800' : 'text-gray-900'}`}>
          {cycle.month_label}
        </p>
        <span className={`inline-block mt-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${chip.cls}`}>
          {chip.label}
        </span>
      </div>

      {/* Center — winner info */}
      <div className="flex-1 min-w-0">
        {isPaymentFree ? (
          <>
            <p className="text-xs font-medium text-teal-700">Payment-Free Month</p>
            <p className="text-[11px] text-teal-500 mt-0.5">Saved by Double Chiti — no payment needed</p>
          </>
        ) : isPending ? (
          <p className="text-xs text-gray-400">Opens {formatShortDate(cycle.due_date)}</p>
        ) : (cycle.winners?.length ?? 0) > 0 ? (
          <div className="space-y-0.5">
            {cycle.winners.map((w, i) => {
              const isExtra = i >= winnersPerCycle
              return (
                <div key={i} className="flex items-center gap-1.5 min-w-0">
                  <p className="text-xs font-medium text-gray-700 truncate">{w.name}</p>
                  {isExtra && (
                    <span className="shrink-0 text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 leading-none">
                      Extra
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <>
            <p className="text-xs text-gray-400">No winner yet</p>
            {bankedProgress && (
              <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                {bankedProgress.current}/{bankedProgress.needed} toward Payment-Free
              </span>
            )}
          </>
        )}
      </div>

      {/* Right — winner takeaway (when present) + collection totals */}
      <div className="shrink-0 text-right">
        {isPaymentFree || isPending ? (
          <p className="text-sm text-gray-300">—</p>
        ) : (
          <>
            <p className={`text-xs font-semibold ${allPaid ? 'text-green-600' : 'text-red-500'}`}>
              {formatPaise(cycle.collected_amount)}
            </p>
            <p className={`text-[11px] mt-0.5 ${allPaid ? 'text-green-500' : 'text-red-400'}`}>
              {cycle.paid_count}/{cycle.total_count} paid
            </p>
          </>
        )}
      </div>

      {!isDisabled && (
        <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      )}
    </button>
  )
}

// ─── HistoryPage ──────────────────────────────────────────────────────────────

// The 4 filter pills: Regular/Skip = cycle type, Open/Closed = cycle status
const FILTER_PILLS = ['Regular', 'Skip', 'Open', 'Closed'] as const

export default function HistoryPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate    = useNavigate()

  const [cycles,        setCycles]        = useState<CycleItem[]>([])
  const [group,         setGroup]         = useState<GroupDetail | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  // activeFilters is a Set — multiple filters can be active at once (e.g., "Regular" + "Closed")
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [cycleList, g] = await Promise.all([
        api.get<CycleItem[]>(`/groups/${groupId}/cycles`),
        api.get<GroupDetail>(`/groups/${groupId}`),
      ])
      setCycles(cycleList)
      setGroup(g)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load history. Tap to retry.')
    } finally {
      setLoading(false)
    }
  }

  // Toggle a filter pill on/off — new Set() prevents mutating the existing state
  function toggleFilter(pill: string) {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(pill)) { next.delete(pill) } else { next.add(pill) }
      return next
    })
  }

  // useMemo: only re-runs this filter computation when cycles or activeFilters changes.
  // Without useMemo it would re-filter on every render (e.g., while user scrolls).
  //
  // Filter logic:
  //   - typeF = selected type filters (Regular, Skip)
  //   - statusF = selected status filters (Open, Closed)
  //   - Within each dimension it's OR: Regular OR Skip
  //   - Across dimensions it's AND: (Regular OR Skip) AND (Open OR Closed)
  //   - Empty dimension = no restriction on that dimension
  const filtered = useMemo(() => {
    const typeF   = FILTER_PILLS.slice(0, 2).filter(f => activeFilters.has(f))
    const statusF = FILTER_PILLS.slice(2).filter(f => activeFilters.has(f))
    const base = activeFilters.size === 0
      ? cycles
      : cycles.filter(c => {
          const typeOk   = typeF.length   === 0 || typeF.some(f   => f === 'Skip' ? c.is_skip_month : !c.is_skip_month)
          const statusOk = statusF.length === 0 || statusF.some(f => c.status === f)
          return typeOk && statusOk
        })
    // The API returns cycles newest-first (desc month_number); display them
    // chronologically (Month 1 at the top) for the history timeline.
    return [...base].sort((a, b) => a.month_number - b.month_number)
  }, [cycles, activeFilters])

  // Pill badge counts — pre-computed from the full list so pills show total counts, not filtered
  const counts: Record<string, number> = {
    All:     cycles.length,
    Regular: cycles.filter(c => !c.is_skip_month).length,
    Skip:    cycles.filter(c =>  c.is_skip_month).length,
    Open:    cycles.filter(c => c.status === 'Open').length,
    Closed:  cycles.filter(c => c.status === 'Closed').length,
  }

  // A cycle is "payment-free" if and only if is_skip_month === true (set by the backend
  // when the admin declares a skip month). No client-side heuristic needed.

  // Compute how many extra winners have been banked toward the NEXT payment-free month.
  // Extra winner = any winner slot beyond winners_per_cycle in a single cycle.
  // bankedExtra = totalExtraWinners % winnersPerCycle — resets to 0 each time a skip is freed.
  // targetCycleId = the last open cycle with no winners (the one the backend would free next).
  const winnersPerCycle = group?.winners_per_cycle ?? 1
  const { bankedExtra, targetCycleId } = useMemo(() => {
    const totalExtra = cycles.reduce((sum, c) => {
      return sum + Math.max(0, (c.winners?.length ?? 0) - winnersPerCycle)
    }, 0)
    const banked = winnersPerCycle > 1 ? totalExtra % winnersPerCycle : 0
    const target = banked > 0
      ? [...cycles]
          .filter(c => c.status === 'Open' && !c.is_skip_month && (c.winners?.length ?? 0) === 0)
          .sort((a, b) => b.month_number - a.month_number)[0]?.cycle_id ?? null
      : null
    return { bankedExtra: banked, targetCycleId: target }
  }, [cycles, winnersPerCycle])

  const cycle     = group?.current_cycle
  const monthNum  = cycle?.month_number ?? 0
  const totalMonths = group?.total_months ?? 0
  const progress  = totalMonths > 0 ? monthNum / totalMonths : 0

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

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-gray-500">{error}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col max-w-md mx-auto">

      {/* Header — navigate(-1) goes to the previous page in browser history */}
      <div className="bg-white border-b border-gray-100 px-2 py-2 flex items-center gap-1">
        <button onClick={() => navigate(-1)} className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <p className="flex-1 text-sm font-semibold text-gray-900 px-1">History</p>
        {group && <p className="text-xs text-gray-400 truncate pr-2">{group.name}</p>}
      </div>

      <div className="flex-1 overflow-y-auto pb-20">

        {/* Group context strip — shows current month progress */}
        {group && (
          <div className="bg-gray-50 border-b border-gray-100 px-4 py-3">
            <p className="text-xs text-gray-600 font-medium">
              {group.name} · Month {monthNum} of {totalMonths}
            </p>
            <div className="mt-1.5 h-1 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-maroon-500 rounded-full transition-all"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Filter pills — "All" clears all filters; individual pills toggle */}
        <div className="px-4 py-3 bg-white border-b border-gray-100">
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => setActiveFilters(new Set())}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition ${
                activeFilters.size === 0
                  ? 'bg-maroon-600 text-white border-maroon-600'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
              }`}
            >
              All <span className="opacity-70">({counts.All})</span>
            </button>

            {FILTER_PILLS.map(pill => {
              const active = activeFilters.has(pill)
              return (
                <button
                  key={pill}
                  onClick={() => toggleFilter(pill)}
                  className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition ${
                    active
                      ? 'bg-maroon-600 text-white border-maroon-600'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {pill} <span className="opacity-70">({counts[pill]})</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Cycle list — each row navigates to CycleDetailPage with role passed via state */}
        <div className="bg-white mt-2 rounded-2xl mx-3 overflow-hidden border border-gray-100">
          {filtered.length === 0 ? (
            <div className="px-4 py-12 text-center">
              {cycles.length === 0 ? (
                <>
                  <p className="text-sm font-medium text-gray-500 mb-1">No history yet</p>
                  <p className="text-xs text-gray-400">Once members start paying and a winner is recorded, history will appear here.</p>
                </>
              ) : (
                <p className="text-sm text-gray-400">No cycles match the selected filters.</p>
              )}
            </div>
          ) : (
            filtered.map(cycle => (
              <CycleRow
                key={cycle.cycle_id}
                cycle={cycle}
                isPaymentFree={cycle.is_skip_month}
                bankedProgress={cycle.cycle_id === targetCycleId ? { current: bankedExtra, needed: winnersPerCycle } : undefined}
                winnersPerCycle={winnersPerCycle}
                onClick={() => navigate(`/groups/${groupId}/history/${cycle.cycle_id}`, {
                  state: { role: group?.my_membership?.role ?? 'Member', groupName: group?.name }
                })}
              />
            ))
          )}
        </div>
      </div>
      {group && <GroupNavBar groupId={groupId!} role={group.my_membership.role} />}
    </div>
  )
}
