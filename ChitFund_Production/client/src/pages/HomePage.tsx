import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise, initials } from '../lib/format'
import type { User, GroupSummary, PaginatedResponse, NotificationListResponse } from '../types/api'
import NotificationsDrawer from '../components/NotificationsDrawer'

type FilterTab = 'All' | 'Admin' | 'Member'
type SortKey = 'name' | 'month'

// ─── Status pill ─────────────────────────────────────────────────────────────
// Small coloured badge shown on each group row.
// Logic differs for Admin (shows defaulter count) vs Member (shows own payment status).

function StatusPill({ group }: { group: GroupSummary }) {
  if (!group.current_cycle_status || group.current_cycle_status === 'PendingStart') {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Not yet started</span>
  }
  if (group.role === 'Admin') {
    if (group.defaulters_count > 0) {
      return <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">{group.defaulters_count} due</span>
    }
    return <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-600 font-medium">All paid</span>
  }
  if (group.user_payment_status_this_month === 'Paid') {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-600 font-medium">Paid</span>
  }
  if (group.user_payment_status_this_month === 'Waived') {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Waived</span>
  }
  return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-600 font-medium">Due soon</span>
}

// ─── Group row ───────────────────────────────────────────────────────────────
// Clicking a row navigates to the correct dashboard based on role:
// Admin → /groups/:groupId, Member → /groups/:groupId/member

function GroupRow({ group }: { group: GroupSummary }) {
  const navigate = useNavigate()
  const monthLabel = group.current_month_number
    ? `Month ${group.current_month_number} of ${group.total_shares}`
    : `${group.total_shares} months total`

  return (
    <div onClick={() => navigate(group.role === 'Admin' ? `/groups/${group.group_id}` : `/groups/${group.group_id}/member`)} className="flex items-center gap-3 py-3.5 px-4 hover:bg-gray-50 cursor-pointer transition">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900 truncate">{group.name}</span>
          {group.role === 'Admin'
            ? <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-maroon-100 text-maroon-700 font-medium shrink-0">Admin</span>
            : <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium shrink-0">Member</span>
          }
        </div>
        <p className="text-xs text-gray-400 mt-0.5">
          {monthLabel} · {formatPaise(group.monthly_contribution)}/share · {group.share_count} {group.share_count === 1 ? 'share' : 'shares'}
        </p>
      </div>
      <StatusPill group={group} />
    </div>
  )
}

// ─── Join modal ──────────────────────────────────────────────────────────────
// Modal for joining a group via invitation code.
// Self-contained with its own loading/error/success state — doesn't need to talk to parent.

function JoinModal({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('')
  const [shareCount, setShareCount] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // sent: true means API call succeeded — switch to success screen
  const [sent, setSent] = useState(false)

  async function handleJoin(e: { preventDefault(): void }) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      // API call: POST /v1/groups/join  Body: { invitation_code, requested_share_count }
      // This sends a join request; admin must approve before the user is added
      await api.post('/groups/join', {
        invitation_code:       code.trim().toUpperCase(),
        requested_share_count: shareCount,
      })
      setSent(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6">

        {sent ? (
          /* ── Success state ── */
          <div className="text-center py-2">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-base font-bold text-gray-900 mb-1">Request sent!</h2>
            <p className="text-sm text-gray-500 mb-5">
              You requested <span className="font-semibold text-gray-700">{shareCount} {shareCount === 1 ? 'share' : 'shares'}</span>.
              The admin will review and notify you once approved.
            </p>
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-maroon-600 hover:bg-maroon-700 text-sm font-semibold text-white transition"
            >
              Done
            </button>
          </div>
        ) : (
          /* ── Form state ── */
          <>
            <h2 className="text-base font-bold text-gray-900 mb-1">Join with invite code</h2>
            <p className="text-sm text-gray-500 mb-4">
              Ask your group admin for the 8-character code. Your request will be sent to the admin for approval.
            </p>

            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

            <form onSubmit={handleJoin} className="space-y-4">
              {/* Invite code */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Invite code</label>
                <input
                  type="text"
                  value={code}
                  onChange={e => setCode(e.target.value.toUpperCase())}
                  placeholder="CF7K2X9P"
                  maxLength={8}
                  required
                  autoFocus
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm font-mono tracking-widest text-center placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
                />
              </div>

              {/* Share count stepper */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  Shares requested
                </label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setShareCount(s => Math.max(1, s - 1))}
                    disabled={shareCount <= 1}
                    className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition text-lg font-medium"
                  >
                    −
                  </button>
                  <span className="text-xl font-bold text-gray-900 w-6 text-center">{shareCount}</span>
                  <button
                    type="button"
                    onClick={() => setShareCount(s => s + 1)}
                    className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 transition text-lg font-medium"
                  >
                    +
                  </button>
                  <p className="text-xs text-gray-400 flex-1 leading-tight">
                    Admin can adjust this before approving.
                  </p>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition">
                  Cancel
                </button>
                <button type="submit" disabled={loading || code.length < 8} className="flex-1 py-2.5 rounded-lg bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white transition">
                  {loading ? 'Sending...' : 'Send request'}
                </button>
              </div>
            </form>
          </>
        )}

      </div>
    </div>
  )
}

// ─── HomePage ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const navigate = useNavigate()
  const [user, setUser] = useState<User | null>(null)
  const [groups, setGroups] = useState<GroupSummary[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterTab>('All')
  const [sort, setSort] = useState<SortKey>('name')
  const [showJoin, setShowJoin] = useState(false)
  const [showNotifs, setShowNotifs] = useState(false)

  // Fetch user profile, all groups, and unread notification count in parallel on mount.
  // Promise.all fires all three requests simultaneously — faster than sequential awaits.
  useEffect(() => {
    Promise.all([
      api.get<User>('/me'),
      api.get<PaginatedResponse<GroupSummary>>('/groups?status=all&limit=100'),
      api.get<NotificationListResponse>('/me/notifications?unread=true&limit=1'),
    ])
      .then(([me, groupsRes, notifs]) => {
        setUser(me)
        setGroups(groupsRes.items)
        setUnreadCount(notifs.unread_count)
      })
      .catch(err => {
        // 401 = token expired — redirect to login
        if (err instanceof ApiError && err.status === 401) {
          navigate('/login', { replace: true })
        } else {
          setError('Could not load your groups. Tap to retry.')
        }
      })
      .finally(() => setLoading(false))
  }, [])

  // ── Derived data ──────────────────────────────────────────────────────────
  // These are computed from `groups` state every render — no extra API calls needed.

  const activeGroups = groups.filter(g => g.status === 'Active')
  const closedGroups = groups.filter(g => g.status === 'Closed')

  // Total unpaid contribution for this month across all groups (as a member)
  const pendingDues = activeGroups
    .filter(g => g.user_payment_status_this_month === 'Unpaid')
    .reduce((sum, g) => sum + g.monthly_contribution * g.share_count, 0)

  function applyFiltersAndSort(list: GroupSummary[]) {
    let result = list
    if (filter !== 'All') result = result.filter(g => g.role === filter)
    if (search.trim()) result = result.filter(g => g.name.toLowerCase().includes(search.toLowerCase()))
    if (sort === 'name') result = [...result].sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'month') result = [...result].sort((a, b) => (b.current_month_number ?? 0) - (a.current_month_number ?? 0))
    return result
  }

  const filteredActive = applyFiltersAndSort(activeGroups)
  const filteredClosed = applyFiltersAndSort(closedGroups)

  const adminCount = activeGroups.filter(g => g.role === 'Admin').length
  const memberCount = activeGroups.filter(g => g.role === 'Member').length

  // ── render ────────────────────────────────────────────────────────────────

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

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-maroon-100 flex items-center justify-center shrink-0">
          <span className="text-sm font-bold text-maroon-700">{user ? initials(user.name) : '?'}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{user?.name}</p>
          <p className="text-xs text-gray-400">{user?.mobile_number}</p>
        </div>
        {/* Bell icon — opens notifications drawer */}
        <button onClick={() => setShowNotifs(true)} className="relative p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          {unreadCount > 0 && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500" />
          )}
        </button>
        <button className="p-2 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-32">

        {/* Error banner */}
        {error && (
          <div className="mx-4 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
            {error}
          </div>
        )}

        {/* Summary tiles — derived from groups state, no additional fetch */}
        <div className="grid grid-cols-2 gap-3 px-4 mt-4">
          <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 shadow-sm">
            <p className="text-xs text-gray-400 mb-1">Active groups</p>
            <p className="text-2xl font-bold text-gray-900">{activeGroups.length}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 shadow-sm">
            <p className="text-xs text-gray-400 mb-1">Pending dues</p>
            <p className={`text-2xl font-bold ${pendingDues > 0 ? 'text-red-600' : 'text-gray-900'}`}>
              {formatPaise(pendingDues)}
            </p>
          </div>
        </div>

        {/* Search — filters groups client-side, no new API call */}
        <div className="px-4 mt-4">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search groups..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
            />
          </div>
        </div>

        {/* Filter pills + sort — all client-side filtering of already-loaded groups */}
        <div className="flex items-center gap-2 px-4 mt-3">
          {(['All', 'Admin', 'Member'] as FilterTab[]).map(tab => {
            const count = tab === 'All' ? activeGroups.length : tab === 'Admin' ? adminCount : memberCount
            return (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium transition ${
                  filter === tab
                    ? 'bg-maroon-600 text-white'
                    : 'bg-white border border-gray-200 text-gray-600 hover:border-maroon-300'
                }`}
              >
                {tab}
                <span className={`text-[11px] ${filter === tab ? 'text-maroon-200' : 'text-gray-400'}`}>{count}</span>
              </button>
            )
          })}
          <div className="ml-auto">
            <button
              onClick={() => setSort(s => s === 'name' ? 'month' : 'name')}
              className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-600 hover:border-maroon-300 transition"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
              </svg>
              {sort === 'name' ? 'Name' : 'Month'}
            </button>
          </div>
        </div>

        {/* Active group list */}
        <div className="mt-3 bg-white border-y border-gray-100 divide-y divide-gray-50">
          {filteredActive.length === 0 && !loading && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-gray-400">
                {groups.length === 0
                  ? "You're not in any chit groups yet.\nCreate one or join with an invite code."
                  : 'No groups match your search.'}
              </p>
            </div>
          )}
          {filteredActive.map(group => (
            <GroupRow key={group.group_id} group={group} />
          ))}
        </div>

        {/* Closed groups — shown dimmed at the bottom */}
        {filteredClosed.length > 0 && (
          <div className="mt-4">
            <p className="px-4 text-[11px] font-semibold text-gray-400 tracking-widest mb-1">CLOSED</p>
            <div className="bg-white border-y border-gray-100 divide-y divide-gray-50 opacity-60">
              {filteredClosed.map(group => (
                <GroupRow key={group.group_id} group={group} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom action buttons — fixed above the nav bar */}
      <div className="fixed bottom-16 left-1/2 -translate-x-1/2 w-full max-w-md px-4">
        <div className="flex gap-2">
          <button
            onClick={() => navigate('/groups/new')}
            className="flex-1 flex items-center justify-center gap-2 py-3 bg-maroon-600 hover:bg-maroon-700 text-white text-sm font-semibold rounded-xl shadow-lg transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Create group
          </button>
          <button
            onClick={() => setShowJoin(true)}
            className="flex-1 flex items-center justify-center gap-2 py-3 bg-white hover:bg-gray-50 text-gray-700 text-sm font-semibold rounded-xl shadow-lg border border-gray-200 transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            Join with code
          </button>
        </div>
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t border-gray-100 flex">
        {[
          { label: 'Home',     active: true,  path: '',         icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
          { label: 'Activity', active: false, path: '',         icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
          { label: 'Profile',  active: false, path: '/profile', icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
        ].map(item => (
          <button key={item.label} onClick={() => item.path && navigate(item.path)} className="flex-1 flex flex-col items-center py-2.5 gap-0.5">
            <svg className={`w-5 h-5 ${item.active ? 'text-maroon-600' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={item.active ? 2.5 : 1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
            </svg>
            <span className={`text-[11px] font-medium ${item.active ? 'text-maroon-600' : 'text-gray-400'}`}>{item.label}</span>
          </button>
        ))}
      </div>

      {/* JoinModal — conditionally rendered; hidden by default, shown when showJoin is true */}
      {showJoin && <JoinModal onClose={() => setShowJoin(false)} />}

      {/* Notifications drawer */}
      {showNotifs && (
        <NotificationsDrawer
          onClose={() => setShowNotifs(false)}
          onUnreadChange={setUnreadCount}
        />
      )}
    </div>
  )
}
