import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { MoneyAnalytics } from '../types/api'

const RANGES = ['24h', '7d', '30d', '90d', 'all'] as const
type Range = typeof RANGES[number]

const RANGE_LABEL: Record<Range, string> = { '24h': '24H', '7d': '7D', '30d': '30D', '90d': '90D', all: 'All' }
const RANGE_SUBLABEL: Record<Range, string> = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', all: 'all time' }

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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">{children}</p>
}

export default function SuperAdminConsolePage() {
  const navigate = useNavigate()
  const [range, setRange] = useState<Range>('30d')
  const [data, setData] = useState<MoneyAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { load() }, [range])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setData(await api.get<MoneyAnalytics>(`/admin/analytics/money?range=${range}`))
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) navigate('/dashboard', { replace: true })
      else setError('Failed to load analytics.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-10">

      {/* ── Header ── */}
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

          {/* ── Segmented range control ── */}
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

      {/* ── Body ── */}
      {loading ? <Spinner /> : error ? (
        <div className="max-w-md mx-auto flex flex-col items-center py-24 gap-3 px-4">
          <p className="text-sm text-gray-500 text-center">{error}</p>
          <button onClick={load} className="text-sm font-semibold text-teal-600">Retry</button>
        </div>
      ) : data && (
        <div className="max-w-md mx-auto px-4 py-5 space-y-6">

          {/* ── GMV hero ── */}
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

          {/* ── Platform snapshot ── */}
          <div>
            <SectionLabel>Platform</SectionLabel>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Avg pool', value: formatPaise(data.avg_pool_size) },
                { label: 'Basket', value: formatPaise(data.cumulative_basket_value) },
                { label: 'Default rate', value: `${data.default_rate_pct}%`, danger: data.default_rate_pct > 0 },
              ].map(({ label, value, danger }) => (
                <div key={label} className="bg-white rounded-2xl border border-gray-100 px-3 py-3.5 text-center">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{label}</p>
                  <p className={`text-sm font-bold ${danger ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* ── Loan portfolio ── */}
          <div>
            <SectionLabel>Loan Portfolio</SectionLabel>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">

              {/* Active */}
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
                    { label: 'Avg rate', value: `${data.loan_portfolio.active.avg_interest_rate}%/mo` },
                    { label: 'Interest', value: formatPaise(data.loan_portfolio.active.accrued_interest) },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-[10px] text-gray-400 mb-0.5">{label}</p>
                      <p className="text-xs font-semibold text-gray-800">{value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="h-px bg-gray-50" />

              {/* Closed */}
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

          {/* ── Pool size distribution ── */}
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
                        <div
                          className="h-full bg-teal-400 rounded-full transition-all duration-500"
                          style={{ width: `${max > 0 ? (bucket.count / max) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </div>
          )}

          {/* ── Top groups ── */}
          <div>
            <SectionLabel>Top Groups by GMV</SectionLabel>
            {data.top_groups_by_gmv.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-100 px-4 py-10 text-center">
                <p className="text-sm text-gray-400">No groups yet.</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                {data.top_groups_by_gmv.map((g, i) => (
                  <div
                    key={g.group_id}
                    className={`flex items-center gap-3 px-4 py-3.5 ${i < data.top_groups_by_gmv.length - 1 ? 'border-b border-gray-50' : ''}`}
                  >
                    <span className={`text-xs font-black w-5 text-center shrink-0 ${
                      i === 0 ? 'text-teal-500' : i === 1 ? 'text-gray-400' : i === 2 ? 'text-orange-400' : 'text-gray-200'
                    }`}>
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{g.name}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5 truncate">{g.admin_name} · {g.member_count} member{g.member_count !== 1 ? 's' : ''}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-gray-900">{formatPaise(g.gmv)}</p>
                      <p className={`text-[10px] font-semibold mt-0.5 ${g.status === 'Active' ? 'text-teal-500' : 'text-gray-300'}`}>
                        {g.status}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
