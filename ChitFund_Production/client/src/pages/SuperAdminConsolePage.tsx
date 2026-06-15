import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { GrowthAnalytics, MoneyAnalytics, EngagementAnalytics, EngagementGroupRow, ReliabilityAnalytics } from '../types/api'

// ─── Shared constants ─────────────────────────────────────────────────────────

const RANGES = ['24h', '7d', '30d', '90d', 'all'] as const
type Range = typeof RANGES[number]
const RANGE_LABEL: Record<Range, string> = { '24h': '24H', '7d': '7D', '30d': '30D', '90d': '90D', all: 'All' }
const RANGE_SUBLABEL: Record<Range, string> = {
  '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', all: 'all time',
}

type Tab = 'growth' | 'money' | 'engagement' | 'reliability'
const TABS: { id: Tab; label: string }[] = [
  { id: 'growth',      label: 'Growth' },
  { id: 'money',       label: 'Money' },
  { id: 'engagement',  label: 'Engage' },
  { id: 'reliability', label: 'Reliab.' },
]

// ─── Shared primitives ────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex justify-center py-24">
      <svg className="animate-spin w-6 h-6 text-teal-500" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center py-24 gap-3 px-4">
      <p className="text-sm text-gray-500 text-center">Failed to load analytics.</p>
      <button onClick={onRetry} className="text-sm font-semibold text-teal-600">Retry</button>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">{children}</p>
}

/** Vertical bar chart built from divs — no charting library needed. */
function MiniBarChart({
  series,
  bars,
  height = 56,
}: {
  series: Record<string, number | string>[]
  bars: { key: string; color: string }[]
  height?: number
}) {
  if (series.length === 0) {
    return <div className="flex items-center justify-center h-14 text-xs text-gray-300">No data for this period</div>
  }
  const maxVal = Math.max(...series.flatMap(r => bars.map(b => Number(r[b.key] ?? 0))), 1)
  return (
    <div className="flex items-end gap-px overflow-hidden" style={{ height }}>
      {series.map((r, i) => (
        <div key={i} className="flex-1 flex items-end gap-px">
          {bars.map(b => {
            const val = Number(r[b.key] ?? 0)
            const pct = (val / maxVal) * 100
            return (
              <div
                key={b.key}
                className={`flex-1 rounded-t-sm ${b.color} min-h-[2px]`}
                style={{ height: `${Math.max(pct, 2)}%` }}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

// ─── Growth tab ───────────────────────────────────────────────────────────────

function GrowthTab({ range }: { range: Range }) {
  const navigate = useNavigate()
  const [data, setData] = useState<GrowthAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => { load() }, [range])

  async function load() {
    setLoading(true)
    setError(false)
    try {
      setData(await api.get<GrowthAnalytics>(`/admin/analytics/growth?range=${range}`))
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) navigate('/dashboard', { replace: true })
      else setError(true)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <Spinner />
  if (error)   return <ErrorState onRetry={load} />
  if (!data)   return null

  const totalGroupsForPct = data.group_status_breakdown.active + data.group_status_breakdown.closed + data.group_status_breakdown.pending || 1

  return (
    <div className="space-y-6">

      {/* ── KPI row (2+3 grid on mobile) ── */}
      <div>
        <SectionLabel>Users</SectionLabel>
        <div className="grid grid-cols-2 gap-2 mb-2">
          {/* Hero: total users */}
          <div className="bg-teal-600 rounded-2xl px-4 py-4 col-span-2">
            <p className="text-[10px] font-bold tracking-widest uppercase text-teal-200 mb-1">Total users</p>
            <p className="text-3xl font-bold text-white">{data.total_users.toLocaleString('en-IN')}</p>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-sm font-bold text-teal-100">+{data.new_signups_in_range.toLocaleString('en-IN')}</span>
              <span className="text-[11px] text-teal-300">{RANGE_SUBLABEL[range]}</span>
              {data.delta_pct > 0 && (
                <span className="ml-auto text-xs font-bold text-teal-100">+{data.delta_pct}%</span>
              )}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'MAU', value: data.mau, sub: 'last 30d' },
            { label: 'WAU', value: data.wau, sub: 'last 7d' },
            { label: 'DAU', value: data.dau, sub: 'last 24h' },
          ].map(({ label, value, sub }) => (
            <div key={label} className="bg-white rounded-2xl border border-gray-100 px-3 py-3 text-center">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</p>
              <p className="text-lg font-bold text-gray-900">{value.toLocaleString('en-IN')}</p>
              <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
            </div>
          ))}
        </div>
        {/* Stickiness */}
        <div className="mt-2 bg-white rounded-2xl border border-gray-100 px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Stickiness</p>
            <p className="text-xs text-gray-400 mt-0.5">DAU ÷ MAU</p>
          </div>
          <p className={`text-xl font-bold ${data.stickiness_pct >= 20 ? 'text-teal-600' : data.stickiness_pct >= 10 ? 'text-amber-500' : 'text-gray-700'}`}>
            {data.stickiness_pct}%
          </p>
        </div>
      </div>

      {/* ── Signup velocity chart ── */}
      <div>
        <SectionLabel>Signup Velocity</SectionLabel>
        <div className="bg-white rounded-2xl border border-gray-100 px-4 pt-4 pb-3">
          <p className="text-xs font-semibold text-gray-700 mb-3">
            New signups — {RANGE_SUBLABEL[range]}
          </p>
          <MiniBarChart series={data.signup_velocity_series} bars={[{ key: 'count', color: 'bg-teal-400' }]} height={64} />
          {data.signup_velocity_series.length > 0 && (
            <div className="flex justify-between mt-1.5">
              <p className="text-[9px] text-gray-300 truncate max-w-[40%]">
                {new Date(data.signup_velocity_series[0].date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
              </p>
              <p className="text-[9px] text-gray-300 truncate max-w-[40%] text-right">
                {new Date(data.signup_velocity_series[data.signup_velocity_series.length - 1].date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Groups ── */}
      <div>
        <SectionLabel>Groups</SectionLabel>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div className="bg-white rounded-2xl border border-gray-100 px-4 py-3.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Total</p>
            <p className="text-2xl font-bold text-gray-900">{data.total_groups}</p>
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 px-4 py-3.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Net growth</p>
            <p className={`text-2xl font-bold ${data.net_growth >= 0 ? 'text-teal-600' : 'text-red-600'}`}>
              {data.net_growth >= 0 ? '+' : ''}{data.net_growth}
            </p>
            <p className="text-[10px] text-gray-400 mt-0.5">
              {data.new_groups_in_range} created · {data.closed_groups_in_range} closed
            </p>
          </div>
        </div>

        {/* Group lifecycle chart */}
        {data.group_lifecycle_series.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 px-4 pt-4 pb-3 mb-2">
            <div className="flex items-center gap-3 mb-3">
              <p className="text-xs font-semibold text-gray-700 flex-1">Group lifecycle</p>
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <span className="w-2 h-2 rounded-sm bg-teal-400 inline-block" />Created
              </span>
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <span className="w-2 h-2 rounded-sm bg-gray-300 inline-block" />Closed
              </span>
            </div>
            <MiniBarChart
              series={data.group_lifecycle_series}
              bars={[
                { key: 'created', color: 'bg-teal-400' },
                { key: 'closed',  color: 'bg-gray-300' },
              ]}
              height={56}
            />
          </div>
        )}

        {/* Group status breakdown */}
        <div className="bg-white rounded-2xl border border-gray-100 px-4 py-3 space-y-2.5">
          {[
            { label: 'Active',  count: data.group_status_breakdown.active,  color: 'bg-teal-400' },
            { label: 'Closed',  count: data.group_status_breakdown.closed,  color: 'bg-gray-300' },
            { label: 'Pending', count: data.group_status_breakdown.pending, color: 'bg-amber-300' },
          ].map(({ label, count, color }) => {
            const pct = Math.round((count / totalGroupsForPct) * 100)
            return (
              <div key={label}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-semibold text-gray-700">{label}</p>
                  <p className="text-xs text-gray-500">{count} <span className="text-gray-300">· {pct}%</span></p>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>

    </div>
  )
}

// ─── Money tab ────────────────────────────────────────────────────────────────

function MoneyTab({ range }: { range: Range }) {
  const navigate = useNavigate()
  const [data, setData] = useState<MoneyAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => { load() }, [range])

  async function load() {
    setLoading(true)
    setError(false)
    try {
      setData(await api.get<MoneyAnalytics>(`/admin/analytics/money?range=${range}`))
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) navigate('/dashboard', { replace: true })
      else setError(true)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <Spinner />
  if (error)   return <ErrorState onRetry={load} />
  if (!data)   return null

  return (
    <div className="space-y-6">

      {/* GMV hero */}
      <div className="bg-teal-600 rounded-2xl px-5 py-5">
        <p className="text-[10px] font-bold tracking-widest uppercase text-teal-200 mb-1">Total GMV — all time</p>
        <p className="text-3xl font-bold text-white mb-4">{formatPaise(data.gmv_lifetime)}</p>
        <div className="h-px bg-teal-500 mb-4" />
        <div className="flex items-end justify-between">
          <div>
            <p className="text-[10px] font-semibold text-teal-200 uppercase tracking-wider mb-0.5">{RANGE_SUBLABEL[range]}</p>
            <p className="text-xl font-bold text-white">{formatPaise(data.gmv_in_range)}</p>
          </div>
          {data.gmv_lifetime > 0 && (
            <p className="text-sm font-semibold text-teal-200">
              {Math.round((data.gmv_in_range / data.gmv_lifetime) * 100)}%
            </p>
          )}
        </div>
      </div>

      {/* Platform snapshot */}
      <div>
        <SectionLabel>Platform</SectionLabel>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Avg pool',    value: formatPaise(data.avg_pool_size),           danger: false },
            { label: 'Basket',      value: formatPaise(data.cumulative_basket_value),  danger: false },
            { label: 'Default rate', value: `${data.default_rate_pct}%`,               danger: data.default_rate_pct > 0 },
          ].map(({ label, value, danger }) => (
            <div key={label} className="bg-white rounded-2xl border border-gray-100 px-3 py-3.5 text-center">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{label}</p>
              <p className={`text-sm font-bold ${danger ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Loan portfolio */}
      <div>
        <SectionLabel>Loan Portfolio</SectionLabel>
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-teal-500 shrink-0" />
                <p className="text-xs font-bold text-gray-700">Active</p>
              </div>
              <p className="text-xl font-bold text-gray-900">{data.loan_portfolio.active.count}</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Principal', value: formatPaise(data.loan_portfolio.active.total_principal) },
                { label: 'Avg rate',  value: `${data.loan_portfolio.active.avg_interest_rate}%/mo` },
                { label: 'Interest',  value: formatPaise(data.loan_portfolio.active.accrued_interest) },
              ].map(({ label, value }) => (
                <div key={label}>
                  <p className="text-[10px] text-gray-400 mb-0.5">{label}</p>
                  <p className="text-xs font-semibold text-gray-800">{value}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="h-px bg-gray-50" />
          <div className="px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-gray-300 shrink-0" />
                <p className="text-xs font-bold text-gray-700">Closed</p>
              </div>
              <p className="text-sm font-semibold text-gray-500">
                {data.loan_portfolio.closed.repaid_count + data.loan_portfolio.closed.written_off_count} total
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-[10px] text-gray-400 mb-0.5">Repaid</p>
                <p className="text-xs font-semibold text-teal-700">{data.loan_portfolio.closed.repaid_count}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 mb-0.5">Written off</p>
                <p className={`text-xs font-semibold ${data.loan_portfolio.closed.written_off_count > 0 ? 'text-red-600' : 'text-gray-800'}`}>
                  {data.loan_portfolio.closed.written_off_count}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 mb-0.5">Default %</p>
                <p className={`text-xs font-semibold ${data.loan_portfolio.closed.default_rate_pct > 0 ? 'text-red-600' : 'text-gray-800'}`}>
                  {data.loan_portfolio.closed.default_rate_pct}%
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Pool distribution */}
      {data.pool_size_distribution.length > 0 && (
        <div>
          <SectionLabel>Pool Distribution</SectionLabel>
          <div className="bg-white rounded-2xl border border-gray-100 px-4 py-3 space-y-3">
            {(() => {
              const max = Math.max(...data.pool_size_distribution.map(b => b.count))
              return data.pool_size_distribution.map(bucket => (
                <div key={bucket.bucket_label}>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-semibold text-gray-700">{bucket.bucket_label}</p>
                    <p className="text-xs font-bold text-gray-900">{bucket.count} group{bucket.count !== 1 ? 's' : ''}</p>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-teal-400 rounded-full transition-all duration-500" style={{ width: `${(bucket.count / max) * 100}%` }} />
                  </div>
                </div>
              ))
            })()}
          </div>
        </div>
      )}

      {/* Top groups */}
      <div>
        <SectionLabel>Top Groups by GMV</SectionLabel>
        {data.top_groups_by_gmv.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 px-4 py-10 text-center">
            <p className="text-sm text-gray-400">No groups yet.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {data.top_groups_by_gmv.map((g, i) => (
              <div key={g.group_id} className={`flex items-center gap-3 px-4 py-3.5 ${i < data.top_groups_by_gmv.length - 1 ? 'border-b border-gray-50' : ''}`}>
                <span className={`text-xs font-black w-5 text-center shrink-0 ${i === 0 ? 'text-teal-500' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-orange-400' : 'text-gray-200'}`}>
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{g.name}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5 truncate">{g.admin_name} · {g.member_count} member{g.member_count !== 1 ? 's' : ''}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-gray-900">{formatPaise(g.gmv)}</p>
                  <p className={`text-[10px] font-semibold mt-0.5 ${g.status === 'Active' ? 'text-teal-500' : 'text-gray-300'}`}>{g.status}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}

// ─── Engagement tab ───────────────────────────────────────────────────────────

function CompliancePill({ pct }: { pct: number }) {
  const color = pct >= 90 ? 'bg-teal-100 text-teal-700' : pct >= 70 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-600'
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${color}`}>{pct}%</span>
  )
}

function GroupComplianceList({ rows, label }: { rows: EngagementGroupRow[]; label: string }) {
  if (rows.length === 0) return null
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {rows.map((g, i) => (
          <div key={g.group_id} className={`flex items-center gap-3 px-4 py-3.5 ${i < rows.length - 1 ? 'border-b border-gray-50' : ''}`}>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">{g.name}</p>
              <p className="text-[11px] text-gray-400 mt-0.5 truncate">
                {g.admin_name} · {g.member_count} member{g.member_count !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="text-right shrink-0 space-y-1">
              <CompliancePill pct={g.compliance_pct} />
              <p className="text-[10px] text-gray-400">{g.collected}/{g.due} paid</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EngagementTab({ range }: { range: Range }) {
  const navigate = useNavigate()
  const [data, setData] = useState<EngagementAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => { load() }, [range])

  async function load() {
    setLoading(true)
    setError(false)
    try {
      setData(await api.get<EngagementAnalytics>(`/admin/analytics/engagement?range=${range}`))
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) navigate('/dashboard', { replace: true })
      else setError(true)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <Spinner />
  if (error)   return <ErrorState onRetry={load} />
  if (!data)   return null

  const amountPct = data.total_amount_expected > 0
    ? Math.round((data.total_amount_collected / data.total_amount_expected) * 100)
    : 0

  const heroColor = data.compliance_rate_pct >= 90
    ? 'bg-teal-600'
    : data.compliance_rate_pct >= 70
      ? 'bg-amber-500'
      : 'bg-red-500'

  return (
    <div className="space-y-6">

      {/* ── Hero compliance card ── */}
      <div className={`${heroColor} rounded-2xl px-5 py-5`}>
        <p className="text-[10px] font-bold tracking-widest uppercase text-white/70 mb-1">Payment Compliance</p>
        <p className="text-4xl font-black text-white mb-1">{data.compliance_rate_pct}%</p>
        <p className="text-sm text-white/80">
          {data.total_payments_collected.toLocaleString('en-IN')} of {data.total_payments_due.toLocaleString('en-IN')} payments collected
          <span className="text-white/50"> · {RANGE_SUBLABEL[range]}</span>
        </p>
      </div>

      {/* ── Quick stats ── */}
      <div>
        <SectionLabel>Platform snapshot</SectionLabel>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Defaulters', value: data.active_defaulters, danger: data.active_defaulters > 0, sub: 'open cycles' },
            { label: 'Open cycles', value: data.cycles_open_now, danger: false, sub: 'right now' },
            { label: 'Closed', value: data.cycles_closed_in_range, danger: false, sub: RANGE_SUBLABEL[range] },
          ].map(({ label, value, danger, sub }) => (
            <div key={label} className="bg-white rounded-2xl border border-gray-100 px-3 py-3.5 text-center">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">{label}</p>
              <p className={`text-lg font-bold ${danger ? 'text-red-600' : 'text-gray-900'}`}>{value.toLocaleString('en-IN')}</p>
              <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Amount compliance bar ── */}
      {data.total_amount_expected > 0 && (
        <div>
          <SectionLabel>Amount collected</SectionLabel>
          <div className="bg-white rounded-2xl border border-gray-100 px-4 py-4">
            <div className="flex items-end justify-between mb-2">
              <div>
                <p className="text-[10px] text-gray-400">Collected</p>
                <p className="text-base font-bold text-gray-900">{formatPaise(data.total_amount_collected)}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-gray-400">Expected</p>
                <p className="text-base font-bold text-gray-500">{formatPaise(data.total_amount_expected)}</p>
              </div>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${amountPct >= 90 ? 'bg-teal-400' : amountPct >= 70 ? 'bg-amber-400' : 'bg-red-400'}`}
                style={{ width: `${amountPct}%` }}
              />
            </div>
            <p className="text-[10px] text-gray-400 mt-1.5 text-right">{amountPct}% of expected amount</p>
          </div>
        </div>
      )}

      {/* ── Compliance trend chart ── */}
      {data.compliance_series.length > 0 && (
        <div>
          <SectionLabel>Compliance trend</SectionLabel>
          <div className="bg-white rounded-2xl border border-gray-100 px-4 pt-4 pb-3">
            <div className="flex items-center gap-3 mb-3">
              <p className="text-xs font-semibold text-gray-700 flex-1">Due vs collected per period</p>
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <span className="w-2 h-2 rounded-sm bg-teal-400 inline-block" />Collected
              </span>
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <span className="w-2 h-2 rounded-sm bg-gray-200 inline-block" />Due
              </span>
            </div>
            <MiniBarChart
              series={data.compliance_series}
              bars={[
                { key: 'due',       color: 'bg-gray-200' },
                { key: 'collected', color: 'bg-teal-400' },
              ]}
              height={64}
            />
            {data.compliance_series.length > 1 && (
              <div className="flex justify-between mt-1.5">
                <p className="text-[9px] text-gray-300 truncate max-w-[40%]">
                  {new Date(data.compliance_series[0].date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </p>
                <p className="text-[9px] text-gray-300 truncate max-w-[40%] text-right">
                  {new Date(data.compliance_series[data.compliance_series.length - 1].date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Group leaderboards ── */}
      {data.top_groups_by_compliance.length > 0 && (
        <GroupComplianceList rows={data.top_groups_by_compliance} label="Top groups by compliance" />
      )}
      {data.bottom_groups_by_compliance.length > 0 && data.bottom_groups_by_compliance.some(g => g.compliance_pct < 100) && (
        <GroupComplianceList rows={data.bottom_groups_by_compliance} label="Needs attention" />
      )}

      {data.total_payments_due === 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 px-4 py-12 text-center">
          <p className="text-sm text-gray-400">No payment data for this period.</p>
          <p className="text-xs text-gray-300 mt-1">Try selecting a wider range.</p>
        </div>
      )}

    </div>
  )
}

// ─── Reliability tab ──────────────────────────────────────────────────────────

function ReliabilityTab({ range }: { range: Range }) {
  const navigate = useNavigate()
  const [data, setData] = useState<ReliabilityAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => { load() }, [range])

  async function load() {
    setLoading(true)
    setError(false)
    try {
      setData(await api.get<ReliabilityAnalytics>(`/admin/analytics/reliability?range=${range}`))
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) navigate('/dashboard', { replace: true })
      else setError(true)
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <Spinner />
  if (error)   return <ErrorState onRetry={load} />
  if (!data)   return null

  const heroColor = data.on_time_closure_rate_pct >= 90
    ? 'bg-teal-600'
    : data.on_time_closure_rate_pct >= 70
      ? 'bg-amber-500'
      : data.cycles_closed_on_time + data.cycles_closed_late === 0
        ? 'bg-gray-400'
        : 'bg-red-500'

  const totalClosed = data.cycles_closed_on_time + data.cycles_closed_late

  return (
    <div className="space-y-6">

      {/* ── Hero: on-time closure rate ── */}
      <div className={`${heroColor} rounded-2xl px-5 py-5`}>
        <p className="text-[10px] font-bold tracking-widest uppercase text-white/70 mb-1">On-Time Cycle Closure</p>
        {totalClosed > 0 ? (
          <>
            <p className="text-4xl font-black text-white mb-1">{data.on_time_closure_rate_pct}%</p>
            <p className="text-sm text-white/80">
              {data.cycles_closed_on_time.toLocaleString('en-IN')} on time · {data.cycles_closed_late} late
              <span className="text-white/50"> · {RANGE_SUBLABEL[range]}</span>
            </p>
            {data.cycles_closed_late > 0 && (
              <p className="text-xs text-white/60 mt-1">avg {data.avg_closure_delay_days}d delay on late closures</p>
            )}
          </>
        ) : (
          <p className="text-xl font-bold text-white/70 mt-1">No closed cycles in this period</p>
        )}
      </div>

      {/* ── Overdue alert ── */}
      {data.overdue_open_cycles > 0 && (
        <div className="bg-red-50 border border-red-100 rounded-2xl px-4 py-3.5 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-bold text-red-700">
              {data.overdue_open_cycles} overdue cycle{data.overdue_open_cycles !== 1 ? 's' : ''}
            </p>
            <p className="text-xs text-red-400 mt-0.5">Past their due date but still open — admin action needed</p>
          </div>
        </div>
      )}

      {/* ── Cycle closure chart ── */}
      {data.cycle_closure_series.length > 0 && (
        <div>
          <SectionLabel>Cycle closure trend</SectionLabel>
          <div className="bg-white rounded-2xl border border-gray-100 px-4 pt-4 pb-3">
            <div className="flex items-center gap-3 mb-3">
              <p className="text-xs font-semibold text-gray-700 flex-1">On-time vs late closures</p>
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <span className="w-2 h-2 rounded-sm bg-teal-400 inline-block" />On time
              </span>
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <span className="w-2 h-2 rounded-sm bg-red-300 inline-block" />Late
              </span>
            </div>
            <MiniBarChart
              series={data.cycle_closure_series}
              bars={[
                { key: 'on_time', color: 'bg-teal-400' },
                { key: 'late',    color: 'bg-red-300' },
              ]}
              height={64}
            />
            {data.cycle_closure_series.length > 1 && (
              <div className="flex justify-between mt-1.5">
                <p className="text-[9px] text-gray-300 truncate max-w-[40%]">
                  {new Date(data.cycle_closure_series[0].date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </p>
                <p className="text-[9px] text-gray-300 truncate max-w-[40%] text-right">
                  {new Date(data.cycle_closure_series[data.cycle_closure_series.length - 1].date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Loan reliability ── */}
      <div>
        <SectionLabel>Loan reliability</SectionLabel>
        <div className="bg-white rounded-2xl border border-gray-100 px-4 py-4">
          <div className="flex items-end justify-between mb-3">
            <div>
              <p className="text-[10px] text-gray-400 mb-0.5">Repayment rate</p>
              <p className={`text-2xl font-bold ${
                data.loan_repayment_rate_pct >= 90 ? 'text-teal-600'
                : data.loan_repayment_rate_pct >= 70 ? 'text-amber-500'
                : data.loans_repaid + data.loans_written_off === 0 ? 'text-gray-400'
                : 'text-red-600'
              }`}>
                {data.loans_repaid + data.loans_written_off === 0 ? '—' : `${data.loan_repayment_rate_pct}%`}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-500">{data.loans_repaid} repaid</p>
              {data.loans_written_off > 0 && (
                <p className="text-xs text-red-500 mt-0.5">{data.loans_written_off} written off</p>
              )}
            </div>
          </div>
          {data.loans_repaid + data.loans_written_off > 0 && (
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${data.loan_repayment_rate_pct >= 90 ? 'bg-teal-400' : data.loan_repayment_rate_pct >= 70 ? 'bg-amber-400' : 'bg-red-400'}`}
                style={{ width: `${data.loan_repayment_rate_pct}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {/* ── Group completion ── */}
      <div>
        <SectionLabel>Group lifecycle</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-2xl border border-gray-100 px-4 py-3.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Active</p>
            <p className="text-2xl font-bold text-gray-900">{data.groups_active}</p>
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 px-4 py-3.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Completed</p>
            <p className="text-2xl font-bold text-teal-600">{data.groups_completed}</p>
            {data.groups_completed + data.groups_active > 0 && (
              <p className="text-[10px] text-gray-400 mt-0.5">{data.group_completion_rate_pct}% of all groups</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Overdue groups list ── */}
      {data.groups_with_overdue_cycles.length > 0 && (
        <div>
          <SectionLabel>Groups needing attention</SectionLabel>
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            {data.groups_with_overdue_cycles.map((g, i) => (
              <div
                key={g.group_id}
                className={`flex items-center gap-3 px-4 py-3.5 ${i < data.groups_with_overdue_cycles.length - 1 ? 'border-b border-gray-50' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{g.name}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5 truncate">{g.admin_name}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-bold text-red-600">
                    {g.overdue_count} overdue
                  </p>
                  <p className="text-[10px] text-gray-400 mt-0.5">oldest {g.oldest_overdue_days}d ago</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalClosed === 0 && data.overdue_open_cycles === 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 px-4 py-12 text-center">
          <p className="text-sm text-gray-400">No cycle data for this period.</p>
          <p className="text-xs text-gray-300 mt-1">Try selecting a wider range.</p>
        </div>
      )}

    </div>
  )
}

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function SuperAdminConsolePage() {
  const navigate = useNavigate()
  const [tab,   setTab]   = useState<Tab>('growth')
  const [range, setRange] = useState<Range>('30d')

  return (
    <div className="min-h-screen bg-gray-50 pb-10">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-md mx-auto px-4 pt-4 pb-3">
          <div className="flex items-center gap-2 mb-3">
            <button onClick={() => navigate('/profile')} className="p-1 -ml-1 text-gray-400 hover:text-gray-700 transition">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="flex-1 text-base font-bold text-gray-900">Admin Console</h1>
            <span className="text-[10px] font-bold tracking-widest uppercase bg-teal-50 text-teal-600 border border-teal-100 px-2 py-0.5 rounded-full">
              SuperAdmin
            </span>
          </div>

          {/* Tab switcher */}
          <div className="flex gap-1 mb-3">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition ${
                  tab === t.id ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Range segmented control */}
          <div className="flex bg-gray-100 rounded-xl p-0.5 gap-0.5">
            {RANGES.map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`flex-1 py-1.5 text-[11px] font-bold rounded-[10px] transition-all duration-150 ${
                  range === r ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-md mx-auto px-4 py-5">
        {tab === 'growth'       && <GrowthTab       range={range} />}
        {tab === 'money'        && <MoneyTab        range={range} />}
        {tab === 'engagement'   && <EngagementTab   range={range} />}
        {tab === 'reliability'  && <ReliabilityTab  range={range} />}
      </div>

    </div>
  )
}
