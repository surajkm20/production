import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { initials } from '../lib/format'

// ─── Types ───────────────────────────────────────────────────────────────────

interface UserProfile {
  user_id: string
  name: string
  mobile_number: string
  username: string | null
  mobile_verified: boolean
  created_at: string
}

interface Session {
  id: string
  device_info: string | null
  created_at: string
  last_used_at: string
  current: boolean
}

interface NotifPref {
  group_id: string | null
  muted: boolean
  updated_at: string
}

type View = 'main' | 'sessions' | 'notifications'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function memberSince(ts: string) {
  return new Date(ts).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

function friendlyDate(ts: string) {
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function ChevronRight() {
  return (
    <svg className="w-4 h-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}

function BackHeader({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="bg-white border-b border-gray-100 px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
      <button onClick={onBack} className="text-gray-500 hover:text-gray-700">
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <h1 className="text-base font-semibold text-gray-900">{title}</h1>
    </div>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

// ─── ProfilePage ─────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const navigate = useNavigate()

  const [user, setUser]       = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [view, setView]       = useState<View>('main')

  // Sessions
  const [sessions, setSessions]           = useState<Session[] | null>(null)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [revokingId, setRevokingId]       = useState<string | null>(null)

  // Notification preferences
  const [notifPrefs, setNotifPrefs]   = useState<NotifPref[] | null>(null)
  const [notifLoading, setNotifLoading] = useState(false)

  // Modal visibility
  const [showEdit, setShowEdit]         = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showSignOut, setShowSignOut]   = useState(false)

  // Edit form
  const [editName, setEditName]         = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [editLoading, setEditLoading]   = useState(false)
  const [editError, setEditError]       = useState<string | null>(null)

  // Password form
  const [currPw, setCurrPw]       = useState('')
  const [newPw, setNewPw]         = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError]     = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState(false)

  // Sign out
  const [signOutLoading, setSignOutLoading] = useState(false)

  useEffect(() => {
    api.get<UserProfile>('/me')
      .then(data => {
        setUser(data)
        setEditName(data.name)
        setEditUsername(data.username ?? '')
      })
      .catch(() => setError('Failed to load profile.'))
      .finally(() => setLoading(false))
  }, [])

  async function loadSessions() {
    setSessionsLoading(true)
    try {
      setSessions(await api.get<Session[]>('/me/sessions'))
    } catch {
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }

  async function loadNotifPrefs() {
    setNotifLoading(true)
    try {
      setNotifPrefs(await api.get<NotifPref[]>('/me/notification-preferences'))
    } catch {
      setNotifPrefs([])
    } finally {
      setNotifLoading(false)
    }
  }

  function openSessions() {
    setView('sessions')
    if (!sessions) loadSessions()
  }

  function openNotifications() {
    setView('notifications')
    if (!notifPrefs) loadNotifPrefs()
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    setEditError(null)
    setEditLoading(true)
    try {
      const payload: Record<string, string | undefined> = {}
      if (editName.trim() !== user?.name) payload.name = editName.trim()
      const usernameVal = editUsername.trim() || undefined
      if (usernameVal !== (user?.username ?? undefined)) payload.username = usernameVal
      const updated = await api.patch<UserProfile>('/me', payload)
      setUser(updated)
      setShowEdit(false)
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setEditLoading(false)
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault()
    if (newPw !== confirmPw) { setPwError('Passwords do not match.'); return }
    setPwError(null)
    setPwLoading(true)
    try {
      await api.post<void>('/me/change-password', { current_password: currPw, new_password: newPw })
      setPwSuccess(true)
      setCurrPw(''); setNewPw(''); setConfirmPw('')
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : 'Something went wrong.')
    } finally {
      setPwLoading(false)
    }
  }

  async function handleSignOut() {
    setSignOutLoading(true)
    const refreshToken = localStorage.getItem('refresh_token')
    try {
      if (refreshToken) await api.post<void>('/auth/logout', { refresh_token: refreshToken })
    } catch { /* still clear tokens */ } finally {
      localStorage.removeItem('access_token')
      localStorage.removeItem('refresh_token')
      navigate('/login', { replace: true })
    }
  }

  async function handleRevokeSession(id: string) {
    setRevokingId(id)
    try {
      await api.delete<void>(`/me/sessions/${id}`)
      setSessions(prev => prev?.filter(s => s.id !== id) ?? prev)
    } catch { /* session may already be gone */ } finally {
      setRevokingId(null)
    }
  }

  async function handleToggleGlobalMute(muted: boolean) {
    try {
      const updated = await api.put<NotifPref[]>('/me/notification-preferences', { group_id: null, muted })
      setNotifPrefs(updated)
    } catch { /* silently fail */ }
  }

  // ─── Loading / error states ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (error || !user) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <p className="text-sm text-red-600">{error ?? 'Failed to load profile.'}</p>
      </div>
    )
  }

  // ─── Sessions view ────────────────────────────────────────────────────────

  if (view === 'sessions') {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-md mx-auto">
          <BackHeader onBack={() => setView('main')} title="Active Sessions" />
          <div className="px-4 py-4 space-y-3">
            {sessionsLoading ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : sessions?.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">No active sessions.</p>
            ) : sessions?.map(session => (
              <div key={session.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {session.device_info ?? 'Unknown device'}
                      </p>
                      {session.current && (
                        <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
                          This device
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">Last active {friendlyDate(session.last_used_at)}</p>
                  </div>
                  {!session.current && (
                    <button
                      onClick={() => handleRevokeSession(session.id)}
                      disabled={revokingId === session.id}
                      className="shrink-0 text-xs text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
                    >
                      {revokingId === session.id ? 'Signing out…' : 'Sign out'}
                    </button>
                  )}
                </div>
              </div>
            ))}
            <p className="text-xs text-gray-400 text-center pt-1">
              To sign out of this device, use the Sign out button on the profile page.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ─── Notification preferences view ────────────────────────────────────────

  if (view === 'notifications') {
    const globalMuted = notifPrefs?.find(p => p.group_id === null)?.muted ?? false
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-md mx-auto">
          <BackHeader onBack={() => setView('main')} title="Notification Preferences" />
          <div className="px-4 py-4">
            {notifLoading ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-200">
                <div className="flex items-center justify-between px-4 py-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">All notifications</p>
                    <p className="text-xs text-gray-400 mt-0.5">Mute all groups at once</p>
                  </div>
                  <button
                    onClick={() => handleToggleGlobalMute(!globalMuted)}
                    className={`w-10 h-6 rounded-full transition-colors relative ${globalMuted ? 'bg-gray-300' : 'bg-teal-600'}`}
                  >
                    <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${globalMuted ? 'left-1' : 'left-5'}`} />
                  </button>
                </div>
              </div>
            )}
            <p className="text-xs text-gray-400 mt-3 text-center">Per-group preferences coming soon.</p>
          </div>
        </div>
      </div>
    )
  }

  // ─── Main profile view ────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <div className="max-w-md mx-auto">

        {/* Header */}
        <div className="bg-white border-b border-gray-100 px-4 py-4 sticky top-0 z-10">
          <h1 className="text-base font-semibold text-gray-900 text-center">Profile</h1>
        </div>

        <div className="px-4 py-5 space-y-4">

          {/* Identity card */}
          <div className="bg-white rounded-2xl border border-gray-200 px-5 py-5">
            <div className="flex items-start gap-4">
              <div className="w-16 h-16 rounded-full bg-teal-700 flex items-center justify-center shrink-0">
                <span className="text-white text-xl font-semibold">{initials(user.name)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[17px] font-medium text-gray-900 leading-tight">{user.name}</p>
                <p className="text-sm text-gray-500 mt-0.5">{user.mobile_number}</p>
                <p className="text-sm text-gray-400">
                  {user.username
                    ? `@${user.username}`
                    : <span className="text-teal-600 cursor-pointer" onClick={() => setShowEdit(true)}>Add username</span>
                  }
                </p>
                <p className="text-xs text-gray-400 mt-1.5">Member since {memberSince(user.created_at)}</p>
              </div>
              <button onClick={() => setShowEdit(true)} className="text-gray-400 hover:text-gray-600 shrink-0 mt-0.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Section: Account */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-1">Account</p>
            <div className="bg-white rounded-2xl border border-gray-200">
              <button
                onClick={() => { setPwSuccess(false); setPwError(null); setCurrPw(''); setNewPw(''); setConfirmPw(''); setShowPassword(true) }}
                className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-gray-50 transition rounded-2xl"
              >
                <div className="flex items-center gap-3">
                  <svg className="w-[18px] h-[18px] text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <span className="text-sm font-medium text-gray-900">Change password</span>
                </div>
                <ChevronRight />
              </button>
            </div>
          </div>

          {/* Section: Notifications */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-1">Notifications</p>
            <div className="bg-white rounded-2xl border border-gray-200">
              <button
                onClick={openNotifications}
                className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-gray-50 transition rounded-2xl"
              >
                <div className="flex items-center gap-3">
                  <svg className="w-[18px] h-[18px] text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                  </svg>
                  <span className="text-sm font-medium text-gray-900">Notification preferences</span>
                </div>
                <ChevronRight />
              </button>
            </div>
          </div>

          {/* Section: Security */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-1">Security</p>
            <div className="bg-white rounded-2xl border border-gray-200">
              <button
                onClick={openSessions}
                className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-gray-50 transition rounded-2xl"
              >
                <div className="flex items-center gap-3">
                  <svg className="w-[18px] h-[18px] text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Active sessions</p>
                    {sessions !== null && (
                      <p className="text-xs text-gray-400">{sessions.length} device{sessions.length !== 1 ? 's' : ''}</p>
                    )}
                  </div>
                </div>
                <ChevronRight />
              </button>
            </div>
          </div>

          {/* Sign out */}
          <div className="pt-2">
            <button
              onClick={() => setShowSignOut(true)}
              className="w-full py-3 rounded-2xl border border-red-200 bg-red-50 text-red-600 text-sm font-semibold hover:bg-red-100 transition"
            >
              Sign out
            </button>
          </div>

          <p className="text-center text-[11px] text-gray-300 pt-1">HornPay · v1.0.0</p>
        </div>
      </div>

      {/* Bottom nav */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t border-gray-100 flex">
        {[
          { label: 'Home',     active: false, path: '/dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
          { label: 'Activity', active: false, path: '',           icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2' },
          { label: 'Profile',  active: true,  path: '/profile',   icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z' },
        ].map(item => (
          <button
            key={item.label}
            onClick={() => item.path && navigate(item.path)}
            className="flex-1 flex flex-col items-center py-2.5 gap-0.5"
          >
            <svg className={`w-5 h-5 ${item.active ? 'text-teal-600' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={item.active ? 2.5 : 1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
            </svg>
            <span className={`text-[11px] font-medium ${item.active ? 'text-teal-600' : 'text-gray-400'}`}>{item.label}</span>
          </button>
        ))}
      </div>

      {/* Edit profile modal */}
      {showEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50" onClick={() => setShowEdit(false)}>
          <div className="bg-white rounded-t-2xl w-full max-w-md px-5 pt-5 pb-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-gray-900">Edit profile</h2>
              <button onClick={() => setShowEdit(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleEdit} className="space-y-4">
              {editError && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{editError}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Name</label>
                <input
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  required
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Username</label>
                <input
                  value={editUsername}
                  onChange={e => setEditUsername(e.target.value)}
                  placeholder="Leave blank to remove"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                />
              </div>
              <button
                type="submit"
                disabled={editLoading}
                className="w-full bg-teal-700 hover:bg-teal-800 disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-lg transition"
              >
                {editLoading ? 'Saving…' : 'Save changes'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Change password modal */}
      {showPassword && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50" onClick={() => setShowPassword(false)}>
          <div className="bg-white rounded-t-2xl w-full max-w-md px-5 pt-5 pb-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-gray-900">Change password</h2>
              <button onClick={() => setShowPassword(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {pwSuccess ? (
              <div className="text-center py-6">
                <svg className="w-12 h-12 text-teal-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm font-medium text-gray-900">Password changed successfully!</p>
                <button onClick={() => setShowPassword(false)} className="mt-4 text-sm text-teal-600 font-medium">Close</button>
              </div>
            ) : (
              <form onSubmit={handlePasswordChange} className="space-y-4">
                {pwError && (
                  <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{pwError}</div>
                )}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Current password</label>
                  <input
                    type="password"
                    value={currPw}
                    onChange={e => setCurrPw(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">New password</label>
                  <input
                    type="password"
                    value={newPw}
                    onChange={e => setNewPw(e.target.value)}
                    required
                    autoComplete="new-password"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm new password</label>
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    required
                    autoComplete="new-password"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>
                <button
                  type="submit"
                  disabled={pwLoading}
                  className="w-full bg-teal-700 hover:bg-teal-800 disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-lg transition"
                >
                  {pwLoading ? 'Changing…' : 'Change password'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Sign out confirmation modal */}
      {showSignOut && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl w-full max-w-sm px-5 py-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Sign out?</h2>
            <p className="text-sm text-gray-500 mb-6">You'll need your password to sign in again on this device.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowSignOut(false)}
                className="flex-1 py-2.5 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSignOut}
                disabled={signOutLoading}
                className="flex-1 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-sm font-semibold transition"
              >
                {signOutLoading ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
