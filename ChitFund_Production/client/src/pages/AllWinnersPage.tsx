import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import GroupNavBar from '../components/GroupNavBar'

interface WinnerRow {
  month_number: number
  month_label: string
  winner_name: string | null
  bid_amount: number | null
  winner_takeaway: number | null
  is_skip_month: boolean
}

export default function AllWinnersPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [groupName, setGroupName] = useState<string>('')
  const [role, setRole]           = useState<'Admin' | 'Member'>('Member')
  const [winners, setWinners]     = useState<WinnerRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [g, rows] = await Promise.all([
        api.get<{ name: string; my_membership: { role: 'Admin' | 'Member' } }>(`/groups/${groupId}`),
        api.get<WinnerRow[]>(`/groups/${groupId}/analytics/winners-ledger`),
      ])
      setGroupName(g.name)
      setRole(g.my_membership.role)
      setWinners(rows)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load winners.')
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

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-gray-500">{error}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-1 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-gray-900">All Winners</h1>
          <p className="text-xs text-gray-400 truncate">{groupName}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 pt-4 mx-3">
        {winners.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-8">
            <p className="text-sm text-gray-500 text-center">No winners recorded yet.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="divide-y divide-gray-50">
              {winners.map(w => (
                <div key={w.month_number} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-full bg-maroon-100 flex items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-maroon-700">M{w.month_number}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {w.is_skip_month ? 'Skip month' : (w.winner_name ?? '—')}
                    </p>
                    <p className="text-xs text-gray-400">{w.month_label}</p>
                  </div>
                  {!w.is_skip_month && w.winner_takeaway != null && (
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-gray-900">{formatPaise(w.winner_takeaway)}</p>
                      {w.bid_amount != null && (
                        <p className="text-[11px] text-gray-400">bid {formatPaise(w.bid_amount)}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <GroupNavBar groupId={groupId!} role={role} />
    </div>
  )
}
