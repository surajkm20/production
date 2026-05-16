import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import type { Notification, NotificationListResponse, NotificationType } from '../types/api'

interface Props {
  onClose: () => void
  onUnreadChange: (count: number) => void
}

// ─── Type icon ────────────────────────────────────────────────────────────────

function NotifIcon({ type }: { type: NotificationType }) {
  const cls = 'w-4 h-4 shrink-0'
  switch (type) {
    case 'PAYMENT_DUE':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      )
    case 'PAYMENT_RECEIVED':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    case 'WINNER_ANNOUNCED':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
        </svg>
      )
    case 'LOAN_DISBURSED':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      )
    case 'DEFAULTER_REMINDER':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      )
    default:
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
      )
  }
}

function iconColor(type: NotificationType): string {
  switch (type) {
    case 'PAYMENT_DUE':        return 'text-amber-500'
    case 'PAYMENT_RECEIVED':   return 'text-green-500'
    case 'WINNER_ANNOUNCED':   return 'text-maroon-600'
    case 'LOAN_DISBURSED':     return 'text-blue-500'
    case 'DEFAULTER_REMINDER': return 'text-red-500'
    default:                   return 'text-gray-400'
  }
}

// ─── Relative time ────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins < 1)   return 'Just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

// ─── Notification row ─────────────────────────────────────────────────────────

function NotifRow({
  notif,
  onMarkRead,
}: {
  notif: Notification
  onMarkRead: (id: string) => void
}) {
  const unread = notif.read_at === null

  return (
    <button
      onClick={() => unread && onMarkRead(notif.id)}
      className={`w-full text-left flex items-start gap-3 px-4 py-3.5 transition ${
        unread ? 'bg-blue-50 hover:bg-blue-100' : 'bg-white hover:bg-gray-50'
      }`}
    >
      {/* Unread dot */}
      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${unread ? 'bg-blue-500' : 'bg-transparent'}`} />

      {/* Type icon */}
      <span className={`mt-0.5 ${iconColor(notif.type)}`}>
        <NotifIcon type={notif.type} />
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-snug ${unread ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
          {notif.title}
        </p>
        <p className="text-xs text-gray-500 mt-0.5 leading-snug">{notif.body}</p>
        <div className="flex items-center gap-1.5 mt-1">
          {notif.group_name && (
            <>
              <span className="text-[11px] text-gray-400 truncate">{notif.group_name}</span>
              <span className="text-[11px] text-gray-300">·</span>
            </>
          )}
          <span className="text-[11px] text-gray-400">{relativeTime(notif.created_at)}</span>
        </div>
      </div>
    </button>
  )
}

// ─── NotificationsDrawer ──────────────────────────────────────────────────────

export default function NotificationsDrawer({ onClose, onUnreadChange }: Props) {
  const [items, setItems]             = useState<Notification[]>([])
  const [loading, setLoading]         = useState(true)
  const [nextCursor, setNextCursor]   = useState<string | null>(null)
  const [hasMore, setHasMore]         = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const fetchPage = useCallback(async (cursor?: string) => {
    const qs  = cursor ? `&cursor=${cursor}` : ''
    const res = await api.get<NotificationListResponse>(`/me/notifications?limit=20${qs}`)
    return res
  }, [])

  useEffect(() => {
    fetchPage()
      .then(res => {
        setItems(res.items)
        setNextCursor(res.next_cursor)
        setHasMore(res.has_more)
        onUnreadChange(res.unread_count)
      })
      .finally(() => setLoading(false))
  }, [])

  async function markRead(id: string) {
    setItems(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    try {
      await api.post('/me/notifications/mark-read', { notification_ids: [id] })
      onUnreadChange(items.filter(n => n.read_at === null && n.id !== id).length)
    } catch {
      // revert optimistic update silently
      setItems(prev => prev.map(n => n.id === id ? { ...n, read_at: null } : n))
    }
  }

  async function markAllRead() {
    const now = new Date().toISOString()
    setItems(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? now })))
    onUnreadChange(0)
    try {
      await api.post('/me/notifications/mark-read', { all: true })
    } catch {
      // best-effort; badge will re-sync on next open
    }
  }

  async function clearAll() {
    setItems([])
    onUnreadChange(0)
    setConfirmClear(false)
    try {
      await api.delete('/me/notifications')
    } catch {
      // best-effort
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetchPage(nextCursor)
      setItems(prev => [...prev, ...res.items])
      setNextCursor(res.next_cursor)
      setHasMore(res.has_more)
    } finally {
      setLoadingMore(false)
    }
  }

  const unreadCount = items.filter(n => n.read_at === null).length

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-sm flex flex-col bg-white shadow-xl">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">Notifications</h2>
          <div className="flex items-center gap-2">
            {items.length > 0 && !confirmClear && (
              <>
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="text-xs font-medium text-maroon-600 hover:text-maroon-700 transition"
                  >
                    Mark all read
                  </button>
                )}
                <button
                  onClick={() => setConfirmClear(true)}
                  className="text-xs font-medium text-gray-400 hover:text-red-500 transition"
                >
                  Clear all
                </button>
              </>
            )}
            {confirmClear && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">Delete all?</span>
                <button
                  onClick={clearAll}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 transition"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmClear(false)}
                  className="text-xs font-medium text-gray-400 hover:text-gray-600 transition"
                >
                  No
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <svg className="animate-spin w-5 h-5 text-maroon-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <svg className="w-10 h-10 text-gray-200 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              <p className="text-sm text-gray-400">No notifications yet</p>
            </div>
          ) : (
            <>
              {items.map(n => (
                <NotifRow key={n.id} notif={n} onMarkRead={markRead} />
              ))}
              {hasMore && (
                <div className="px-4 py-3 flex justify-center">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="text-sm font-medium text-maroon-600 hover:text-maroon-700 disabled:opacity-50 transition"
                  >
                    {loadingMore ? 'Loading...' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
