import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { initials } from '../lib/format'
import type { GroupDetail } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

interface Member {
  membership_id: string
  user_id: string
  name: string
  mobile_number: string
  role: 'Admin' | 'Member'
  share_count: number
  wins_count: number
  status: string
  joined_at: string
}

interface JoinRequest {
  membership_id: string
  user_id: string
  name: string
  mobile_number: string
  requested_share_count: number
  joined_at: string
}

// ─── Add member modal ─────────────────────────────────────────────────────────

// Self-contained modal: its own local state for the form; calls onAdded with the new member on success.
// This avoids having to re-fetch the full member list after adding — parent just appends the new member.
function AddMemberModal({
  groupId,
  onClose,
  onAdded,
}: {
  groupId: string
  onClose: () => void
  onAdded: (m: Member) => void
}) {
  const [name, setName] = useState('')
  const [mobile, setMobile] = useState('')
  const [shareCount, setShareCount] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      // API call: POST /v1/groups/:groupId/members
      const result = await api.post<{ membership_id: string; user_id: string }>(
        `/groups/${groupId}/members`,
        { name: name.trim(), mobile_number: mobile.replace(/\s+/g, ''), share_count: shareCount },
      )
      // Build a local Member object from the response + the form values.
      // We don't re-fetch the list — the parent just appends this object to its state.
      onAdded({
        membership_id: result.membership_id,
        user_id: result.user_id,
        name: name.trim(),
        mobile_number: mobile.replace(/\s+/g, ''),
        role: 'Member',
        share_count: shareCount,
        wins_count: 0,
        status: 'Active',
        joined_at: new Date().toISOString(),
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 px-4 pb-6 sm:pb-0">
      <div className="bg-white rounded-2xl w-full max-w-sm p-6">
        <h2 className="text-base font-bold text-gray-900 mb-1">Add a member</h2>
        <p className="text-sm text-gray-500 mb-4">They'll be added immediately. If they don't have an account yet, they'll join when they sign up with this number.</p>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Full name"
            required
            autoFocus
            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
          />
          <input
            type="tel"
            value={mobile}
            onChange={e => setMobile(e.target.value)}
            placeholder="+919876543210"
            required
            className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
          />
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">Shares</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShareCount(s => Math.max(1, s - 1))} disabled={shareCount <= 1}
                className="w-8 h-8 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition">−</button>
              <span className="w-6 text-center text-sm font-semibold text-gray-900">{shareCount}</span>
              <button type="button" onClick={() => setShareCount(s => s + 1)}
                className="w-8 h-8 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 transition">+</button>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition">
              Cancel
            </button>
            <button type="submit" disabled={loading || !name.trim() || !mobile.trim()}
              className="flex-1 py-2.5 rounded-lg bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white transition">
              {loading ? 'Adding...' : 'Add member'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Member row ───────────────────────────────────────────────────────────────

// MemberRow handles its own busy state for the +/− share stepper.
// onShareChange is called by the parent; the row disables the buttons while waiting.
function MemberRow({
  member,
  currentUserId,
  groupLocked,
  isAdmin,
  onShareChange,
}: {
  member: Member
  currentUserId: string
  groupLocked: boolean
  isAdmin: boolean
  onShareChange: (membershipId: string, newCount: number) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  // Calls the parent's optimistic handler, shows busy while in-flight
  async function adjust(delta: number) {
    const next = member.share_count + delta
    if (next < 1) return
    setBusy(true)
    await onShareChange(member.membership_id, next)
    setBusy(false)
  }

  const isMe = member.user_id === currentUserId
  const joinedDate = new Date(member.joined_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="w-9 h-9 rounded-full bg-maroon-100 flex items-center justify-center shrink-0">
        <span className="text-xs font-bold text-maroon-700">{initials(member.name)}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-gray-900 truncate">{member.name}</span>
          {isMe && <span className="text-xs text-gray-400">(you)</span>}
          {member.role === 'Admin' && (
            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-maroon-100 text-maroon-700 font-medium shrink-0">Admin</span>
          )}
        </div>
        <p className="text-xs text-gray-400 truncate">
          {member.mobile_number} · joined {joinedDate}
        </p>
      </div>

      {/* Share stepper — admin only, hidden once cycle starts (groupLocked) */}
      {isAdmin && !groupLocked && (
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => adjust(-1)} disabled={busy || member.share_count <= 1}
            className="w-7 h-7 rounded-md border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition text-sm">
            −
          </button>
          <span className="w-5 text-center text-sm font-semibold text-gray-800">{member.share_count}</span>
          <button onClick={() => adjust(1)} disabled={busy}
            className="w-7 h-7 rounded-md border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition text-sm">
            +
          </button>
        </div>
      )}
      {groupLocked && (
        <span className="text-sm font-semibold text-gray-500 shrink-0 w-14 text-right">
          {member.share_count} {member.share_count === 1 ? 'share' : 'shares'}
        </span>
      )}
    </div>
  )
}

// ─── MembersPage ──────────────────────────────────────────────────────────────

function codeExpiry(iso: string | null): { label: string; cls: string } | null {
  if (!iso) return null
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return { label: 'Code expired — rotate to renew', cls: 'text-red-300' }
  const hours = Math.floor(diff / 3_600_000)
  const mins  = Math.floor((diff % 3_600_000) / 60_000)
  if (hours < 1) return { label: `Expires in ${mins}m`, cls: 'text-amber-300' }
  return { label: `Expires in ${hours}h ${mins}m`, cls: 'text-maroon-200' }
}

export default function MembersPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [group, setGroup] = useState<GroupDetail | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([])
  // expandedReqId + expandMode: which join request row is expanded and in which mode (approve/reject)
  const [expandedReqId, setExpandedReqId] = useState<string | null>(null)
  const [expandMode, setExpandMode] = useState<'approve' | 'reject' | null>(null)
  const [reqShareCount, setReqShareCount] = useState(1)
  const [reqBusy, setReqBusy] = useState(false)
  const [reqError, setReqError] = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // All four fetched in parallel — none depends on the others
      const [g, memberList, me, reqs] = await Promise.all([
        api.get<GroupDetail>(`/groups/${groupId}`),
        api.get<Member[]>(`/groups/${groupId}/members`),
        api.get<{ user_id: string }>('/me'),
        // .catch() makes this non-fatal: if join-requests fails, use empty array
        api.get<JoinRequest[]>(`/groups/${groupId}/join-requests`).catch((err) => {
          console.error('[join-requests] fetch failed:', err)
          return [] as JoinRequest[]
        }),
      ])
      setGroup(g)
      setMembers(memberList)
      setCurrentUserId(me.user_id)
      setJoinRequests(reqs)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load members.')
    } finally {
      setLoading(false)
    }
  }

  // Optimistic share count update:
  // 1. Update local state immediately (user sees the change at once, no spinner)
  // 2. Call the API in the background
  // 3. If the API fails, revert to the previous value
  async function handleShareChange(membershipId: string, newCount: number) {
    const prev = members.find(m => m.membership_id === membershipId)?.share_count
    // Immediately reflect the new count in the UI
    setMembers(ms => ms.map(m => m.membership_id === membershipId ? { ...m, share_count: newCount } : m))
    try {
      // API call: PATCH /v1/groups/:groupId/members/:membershipId  Body: { share_count }
      await api.patch(`/groups/${groupId}/members/${membershipId}`, { share_count: newCount })
    } catch (err) {
      // Revert to previous share count on failure
      setMembers(ms => ms.map(m => m.membership_id === membershipId ? { ...m, share_count: prev ?? m.share_count } : m))
    }
  }

  // Start the first cycle — only enabled when all shares are filled
  async function handleStartCycle() {
    setStartError(null)
    setStarting(true)
    try {
      // API call: POST /v1/groups/:groupId/start
      await api.post(`/groups/${groupId}/start`, {})
      navigate(`/groups/${groupId}`)
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : 'Failed to start cycle.')
    } finally {
      setStarting(false)
    }
  }

  // Copy invite code to clipboard, show "Copied!" for 2s then revert
  async function copyCode() {
    if (!group) return
    await navigator.clipboard.writeText(group.invitation_code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // navigator.share: native mobile share sheet (WhatsApp, SMS, etc.)
  // Falls back to clipboard copy on desktop where navigator.share is not available
  async function handleShare() {
    if (!group) return
    const text = `Join ${group.name} with code ${group.invitation_code}`
    if (navigator.share) {
      await navigator.share({ title: 'Join ChitFlow group', text })
    } else {
      await copyCode()
    }
  }

  // Approve a join request: confirm share count with admin, then call API
  async function handleApprove(membershipId: string) {
    const req = joinRequests.find(r => r.membership_id === membershipId)!
    setReqBusy(true)
    setReqError(null)
    try {
      // API call: POST /v1/groups/:groupId/join-requests/:membershipId/approve  Body: { share_count }
      await api.post(`/groups/${groupId}/join-requests/${membershipId}/approve`, { share_count: reqShareCount })
      // Build a Member from the request data, add to the members list
      const newMember: Member = {
        membership_id: membershipId,
        user_id: req.user_id,
        name: req.name,
        mobile_number: req.mobile_number,
        role: 'Member',
        share_count: reqShareCount,
        wins_count: 0,
        status: 'Active',
        joined_at: req.joined_at,
      }
      setJoinRequests(rs => rs.filter(r => r.membership_id !== membershipId))
      setMembers(ms => [...ms, newMember])
      setExpandedReqId(null)
      setExpandMode(null)
    } catch (err) {
      setReqError(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setReqBusy(false)
    }
  }

  // Reject a join request: remove from the pending list after API confirms
  async function handleReject(membershipId: string) {
    setReqBusy(true)
    setReqError(null)
    try {
      // API call: POST /v1/groups/:groupId/join-requests/:membershipId/reject
      await api.post(`/groups/${groupId}/join-requests/${membershipId}/reject`, {})
      setJoinRequests(rs => rs.filter(r => r.membership_id !== membershipId))
      setExpandedReqId(null)
      setExpandMode(null)
    } catch (err) {
      setReqError(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setReqBusy(false)
    }
  }

  // ── derived values — calculated from state, no extra useState needed ────────

  const sharesFilled      = members.reduce((s, m) => s + m.share_count, 0)
  // groupLocked: once a cycle has started, share counts are frozen
  const groupLocked       = !!group?.current_cycle
  const remainingCapacity = group ? group.total_shares - sharesFilled : 0
  // canStart: all shares must be filled and no cycle running yet
  const canStart          = group ? sharesFilled === group.total_shares && !groupLocked : false
  // Client-side filter — no API call, just array.filter on the already-loaded members
  const filtered     = search.trim()
    ? members.filter(m => m.name.toLowerCase().includes(search.toLowerCase()))
    : members

  // ── loading / error ────────────────────────────────────────────────────────

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
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-gray-500">{error ?? 'Not found.'}</p>
        <button onClick={load} className="text-sm text-maroon-600 font-medium">Retry</button>
      </div>
    )
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(`/groups/${groupId}`)} className="p-1 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="flex-1 text-sm font-semibold text-gray-900">Members</span>
        <span className="text-xs text-gray-400 truncate max-w-[120px]">{group.name}</span>
      </div>

      <div className="flex-1 overflow-y-auto pb-32">

        {/* Shares filled progress bar */}
        <div className="bg-maroon-600 mx-3 mt-3 rounded-2xl p-4 text-white">
          <p className="text-sm font-bold mb-0.5">
            Shares filled — {sharesFilled} of {group.total_shares}
          </p>
          <div className="h-1.5 bg-maroon-400 rounded-full overflow-hidden my-2">
            <div
              className="h-full bg-white rounded-full transition-all"
              style={{ width: `${Math.min(100, (sharesFilled / group.total_shares) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-maroon-200">
            {members.length} {members.length === 1 ? 'person' : 'people'} · {group.total_shares - sharesFilled} {group.total_shares - sharesFilled === 1 ? 'share' : 'shares'} left to fill
          </p>
        </div>

        {/* Client-side search — filters already-loaded members, no new API call */}
        <div className="px-3 mt-3">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search members..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 bg-white text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
            />
          </div>
        </div>

        {/* Member list */}
        <div className="mt-3 bg-white border-y border-gray-100 divide-y divide-gray-50">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No members found.</p>
          ) : filtered.map(m => (
            <MemberRow
              key={m.membership_id}
              member={m}
              currentUserId={currentUserId}
              groupLocked={groupLocked}
              isAdmin={group.my_membership.role === 'Admin'}
              onShareChange={handleShareChange}
            />
          ))}
        </div>

        {/* Pending join requests — inline expand pattern:
            clicking Approve expands a share-count picker inside the same row.
            expandedReqId + expandMode control which row is expanded and what variant to show. */}
        {joinRequests.length > 0 && (
          <div className="mt-3 bg-white border-y border-gray-100">
            <p className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-widest">
              Pending requests ({joinRequests.length})
            </p>
            <div className="divide-y divide-gray-50">
              {joinRequests.map(req => {
                const isExpanded = expandedReqId === req.membership_id
                const mode = isExpanded ? expandMode : null
                return (
                  <div key={req.membership_id}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                        <span className="text-xs font-bold text-amber-700">{initials(req.name)}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-gray-900 truncate block">{req.name}</span>
                        {mode === 'reject' ? (
                          <p className="text-xs text-gray-500">Reject this request?</p>
                        ) : (
                          <p className="text-xs text-gray-400 truncate">
                            {req.mobile_number} · {req.requested_share_count} {req.requested_share_count === 1 ? 'share' : 'shares'} requested
                          </p>
                        )}
                      </div>
                      {mode === null && (
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => { setExpandedReqId(req.membership_id); setExpandMode('reject') }}
                            className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50 transition">
                            Reject
                          </button>
                          <button
                            onClick={() => { setExpandedReqId(req.membership_id); setExpandMode('approve'); setReqShareCount(req.requested_share_count); setReqError(null) }}
                            className="px-3 py-1.5 rounded-lg bg-maroon-600 hover:bg-maroon-700 text-xs font-medium text-white transition">
                            Approve
                          </button>
                        </div>
                      )}
                      {mode === 'reject' && (
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => { setExpandedReqId(null); setExpandMode(null) }}
                            className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50 transition">
                            Keep
                          </button>
                          <button
                            onClick={() => handleReject(req.membership_id)}
                            disabled={reqBusy}
                            className="px-3 py-1.5 rounded-lg border border-red-200 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 transition">
                            {reqBusy ? '...' : 'Yes, reject'}
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Approve expand panel — shown below the row when mode = 'approve' */}
                    {mode === 'approve' && (
                      <div className="px-4 pb-4 pt-3 bg-amber-50 border-t border-amber-100">
                        {reqError && <p className="text-xs text-red-600 mb-2">{reqError}</p>}
                        <div className="flex items-center gap-3 mb-3">
                          <span className="text-sm text-gray-700 flex-1">Shares</span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setReqShareCount(s => Math.max(1, s - 1))}
                              disabled={reqShareCount <= 1}
                              className="w-8 h-8 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-white disabled:opacity-40 transition">
                              −
                            </button>
                            <span className="w-6 text-center text-sm font-semibold text-gray-900">{reqShareCount}</span>
                            <button
                              type="button"
                              onClick={() => setReqShareCount(s => s + 1)}
                              disabled={reqShareCount >= remainingCapacity}
                              className="w-8 h-8 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-white disabled:opacity-40 transition">
                              +
                            </button>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => { setExpandedReqId(null); setExpandMode(null); setReqError(null) }}
                            className="flex-1 py-2 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:bg-white transition">
                            Cancel
                          </button>
                          <button
                            onClick={() => handleApprove(req.membership_id)}
                            disabled={reqBusy}
                            className="flex-1 py-2 rounded-lg bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-xs font-semibold text-white transition">
                            {reqBusy ? 'Confirming...' : 'Confirm approve'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Add new person section — hidden once cycle starts */}
        {!groupLocked && (
          <div className="mx-3 mt-3 bg-white rounded-2xl border border-gray-100 p-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Add a new person</p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowAddModal(true)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                By mobile
              </button>
              <button
                onClick={handleShare}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
                Share invite
              </button>
            </div>
          </div>
        )}

        {/* Invite code — always visible so admin can copy and share manually */}
        <div className="mx-3 mt-3 bg-maroon-600 rounded-2xl p-4 text-white">
          <p className="text-xs text-maroon-200 mb-2 font-medium">INVITE CODE</p>
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-2xl font-bold tracking-widest">{group.invitation_code}</span>
            <button
              onClick={copyCode}
              className="px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded-lg text-sm font-medium transition shrink-0"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {(() => {
            const exp = codeExpiry(group.invitation_code_expires_at)
            return exp ? (
              <p className={`text-xs mt-2 font-medium ${exp.cls}`}>{exp.label}</p>
            ) : null
          })()}
        </div>

        {startError && (
          <p className="text-sm text-red-600 text-center mt-3 px-4">{startError}</p>
        )}
      </div>

      {/* Action bar — admin only; sits above the GroupNavBar */}
      {group.my_membership.role === 'Admin' && (
        <div className="fixed bottom-14 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t border-gray-100 px-4 py-3 flex gap-3 z-10">
          <button
            onClick={() => navigate(`/groups/${groupId}`)}
            className="flex-1 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition"
          >
            Save & close
          </button>
          <button
            onClick={handleStartCycle}
            disabled={!canStart || starting}
            className="flex-1 py-3 rounded-xl bg-maroon-600 hover:bg-maroon-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold text-white transition"
            title={!canStart && !groupLocked ? `Fill all ${group.total_shares} shares first` : undefined}
          >
            {starting ? 'Starting...' : groupLocked ? 'Cycle started' : 'Start cycle 1'}
          </button>
        </div>
      )}

      {/* Add member modal — mounts when showAddModal is true */}
      {showAddModal && (
        <AddMemberModal
          groupId={groupId!}
          onClose={() => setShowAddModal(false)}
          onAdded={m => { setMembers(ms => [...ms, m]); setShowAddModal(false) }}
        />
      )}

      <GroupNavBar groupId={groupId!} role={group.my_membership.role} />
    </div>
  )
}
