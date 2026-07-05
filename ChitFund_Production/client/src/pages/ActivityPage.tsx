import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import type { ActivityItem, GroupDetail } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

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

export default function ActivityPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate    = useNavigate()

  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [group,    setGroup]    = useState<GroupDetail | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [acts, g] = await Promise.all([
        api.get<ActivityItem[]>(`/groups/${groupId}/activity?limit=200`),
        api.get<GroupDetail>(`/groups/${groupId}`),
      ])
      setActivity(acts)
      setGroup(g)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load activity. Tap to retry.')
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
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-gray-500">{error}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-2 py-2 flex items-center gap-1">
        <button onClick={() => navigate(-1)} className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <p className="flex-1 text-sm font-semibold text-gray-900 px-1">Activity</p>
        {group && <p className="text-xs text-gray-400 truncate pr-2">{group.name}</p>}
      </div>

      <div className="flex-1 overflow-y-auto pb-20">

        {activity.length === 0 ? (
          <div className="px-4 py-16 text-center">
            <p className="text-sm font-medium text-gray-500 mb-1">No activity yet</p>
            <p className="text-xs text-gray-400">Admin actions like marking payments and recording winners will appear here.</p>
          </div>
        ) : (
          <div className="bg-white mt-2 mx-3 rounded-2xl border border-gray-100 divide-y divide-gray-50 overflow-hidden">
            {activity.map(item => (
              <div key={item.id} className="flex items-start gap-3 px-4 py-3.5">
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

      {group && <GroupNavBar groupId={groupId!} role={group.my_membership.role} />}
    </div>
  )
}
