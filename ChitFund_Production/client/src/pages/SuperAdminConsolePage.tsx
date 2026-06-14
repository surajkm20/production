import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { MoneyAnalytics } from '../types/api'

const RANGES = ['24h', '7d', '30d', '90d', 'all'] as const
type Range = typeof RANGES[number]

function Spinner() {
  return (
    <svg className="animate-spin w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 px-4 py-3.5">
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
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
      const res = await api.get<MoneyAnalytics>(`/admin/analytics/money?range=${range}`)
      setData(res)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        navigate('/dashboard', { replace: true })
      } else {
        setError('Failed to load analytics. Tap to retry.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-8">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => navigate('/profile')} className="text-gray-500 hover:text-gray-700">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-base font-semibold text-gray-900">Admin Console</h1>
          <p className="text-[11px] text-gray-400">Platform-wide overview</p>
        </div>
      </div>

      {/* Range tabs */}
      <div className="flex gap-1.5 px-4 py-3 bg-white border-b border-gray-100">
        {RANGES.map(r => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition ${
              range === r ? 'bg-teal-600 text-white' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            {r === 'all' ? 'All' : r}
          </button>
        ))}
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : error ? (
        <div className="flex flex-col items-center py-16 gap-2 px-4">
          <p className="text-sm text-gray-500 text-center">{error}</p>
          <button onClick={load} className="text-sm text-teal-600 font-medium">Retry</button>
        </div>
      ) : data && (
        <div className="max-w-md mx-auto px-4 py-4 space-y-5">

          {/* GMV */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-0.5">GMV</p>
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Lifetime" value={formatPaise(data.gmv_lifetime)} />
              <StatCard label={`In range (${range})`} value={formatPaise(data.gmv_in_range)} />
            </div>
          </div>

          {/* Platform health */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-0.5">Platform</p>
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Avg pool size" value={formatPaise(data.avg_pool_size)} />
              <StatCard label="Basket value" value={formatPaise(data.cumulative_basket_value)} />
              <StatCard
                label="Default rate"
                value={`${data.default_rate_pct}%`}
                sub="written-off / total loans"
              />
            </div>
          </div>

          {/* Loan portfolio */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-0.5">Loan Portfolio</p>
            <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">

              <div className="px-4 py-3.5">
                <p className="text-xs font-semibold text-gray-500 mb-2">Active</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <div>
                    <p className="text-[11px] text-gray-400">Loans</p>
                    <p className="font-semibold text-gray-900">{data.loan_portfolio.active.count}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400">Principal</p>
                    <p className="font-semibold text-gray-900">{formatPaise(data.loan_portfolio.active.total_principal)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400">Avg rate</p>
                    <p className="font-semibold text-gray-900">{data.loan_portfolio.active.avg_interest_rate}%/mo</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400">Interest accrued</p>
                    <p className="font-semibold text-gray-900">{formatPaise(data.loan_portfolio.active.accrued_interest)}</p>
                  </div>
                </div>
              </div>

              <div className="px-4 py-3.5">
                <p className="text-xs font-semibold text-gray-500 mb-2">Closed</p>
                <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
                  <div>
                    <p className="text-[11px] text-gray-400">Repaid</p>
                    <p className="font-semibold text-gray-900">{data.loan_portfolio.closed.repaid_count}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400">Written off</p>
                    <p className="font-semibold text-gray-900">{data.loan_portfolio.closed.written_off_count}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400">Default %</p>
                    <p className={`font-semibold ${data.loan_portfolio.closed.default_rate_pct > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                      {data.loan_portfolio.closed.default_rate_pct}%
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Pool size distribution */}
          {data.pool_size_distribution.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-0.5">Pool Size Distribution</p>
              <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
                {data.pool_size_distribution.map(bucket => (
                  <div key={bucket.bucket_label} className="flex items-center justify-between px-4 py-3">
                    <p className="text-sm font-medium text-gray-700">{bucket.bucket_label}</p>
                    <p className="text-sm font-semibold text-gray-900">{bucket.count} group{bucket.count !== 1 ? 's' : ''}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top groups */}
          {data.top_groups_by_gmv.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-0.5">Top Groups by GMV</p>
              <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
                {data.top_groups_by_gmv.map((g, i) => (
                  <div key={g.group_id} className="flex items-center gap-3 px-4 py-3">
                    <span className="text-xs font-bold text-gray-300 w-4 shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{g.name}</p>
                      <p className="text-xs text-gray-400">{g.admin_name} · {g.member_count} members</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-teal-700">{formatPaise(g.gmv)}</p>
                      <p className={`text-[10px] font-medium ${g.status === 'Active' ? 'text-green-600' : 'text-gray-400'}`}>{g.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.top_groups_by_gmv.length === 0 && (
            <div className="bg-white rounded-xl border border-gray-100 px-4 py-8 text-center">
              <p className="text-sm text-gray-400">No group data yet.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
