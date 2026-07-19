import { useEffect, useMemo, useRef, useState } from 'react'
import { initials, titleCase } from '../lib/format'
import type { Member } from '../types/api'

interface Props {
  /** Members to choose from (already filtered to whoever is selectable). */
  members: Member[]
  /** user_id of the selected member, or '' when none is selected. */
  value: string
  /** Called with the member's user_id on selection, or '' when cleared. */
  onChange: (userId: string) => void
  /** Placeholder shown in the search input when nothing is selected. */
  placeholder?: string
}

/**
 * Searchable member picker — use instead of a native select when the member list is long enough that type-to-filter beats scrolling.
 *
 * @param props - See Props
 * @returns A combobox input with a filterable, keyboard-navigable dropdown of members
 * @example
 * <MemberSelect members={eligibleMembers} value={winnerId} onChange={setWinnerId} />
 */
export default function MemberSelect({ members, value, onChange, placeholder = 'Search member…' }: Props) {
  const [open,      setOpen]      = useState(false)
  const [query,     setQuery]     = useState('')
  const [highlight, setHighlight] = useState(0)

  const rootRef  = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef  = useRef<HTMLUListElement>(null)

  const selected = members.find(m => m.user_id === value) ?? null

  const filtered = useMemo(() => {
    const sorted = [...members].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
    const q = query.trim().toLowerCase()
    return q ? sorted.filter(m => m.name.toLowerCase().includes(q)) : sorted
  }, [members, query])

  // Close the dropdown when tapping/clicking anywhere outside the component
  useEffect(() => {
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [])

  useEffect(() => { setHighlight(0) }, [query, open])

  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  function select(m: Member) {
    onChange(m.user_id)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }

  function clear() {
    onChange('')
    setQuery('')
    inputRef.current?.focus()
    setOpen(true)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlight(h => Math.min(h + 1, filtered.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlight(h => Math.max(h - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (filtered[highlight]) select(filtered[highlight])
        break
      case 'Escape':
        setOpen(false)
        setQuery('')
        inputRef.current?.blur()
        break
      case 'Tab':
        setOpen(false)
        setQuery('')
        break
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="member-select-listbox"
          aria-autocomplete="list"
          value={open ? query : selected ? titleCase(selected.name) : ''}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => { setOpen(true); setQuery('') }}
          onKeyDown={handleKeyDown}
          placeholder={selected && !open ? undefined : placeholder}
          className="w-full pl-9 pr-9 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-maroon-500"
        />
        {selected && !open && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear selection"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <ul
          ref={listRef}
          id="member-select-listbox"
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto bg-white rounded-lg border border-gray-200 shadow-lg py-1"
        >
          {filtered.length === 0 ? (
            <li className="px-3.5 py-3 text-sm text-gray-400">No members match “{query.trim()}”</li>
          ) : (
            filtered.map((m, i) => (
              <li
                key={m.user_id}
                role="option"
                aria-selected={m.user_id === value}
                onMouseDown={e => { e.preventDefault(); select(m) }}
                onMouseEnter={() => setHighlight(i)}
                className={`flex items-center gap-3 px-3.5 py-2.5 cursor-pointer ${i === highlight ? 'bg-maroon-50' : ''}`}
              >
                <div className="w-8 h-8 rounded-full bg-maroon-100 flex items-center justify-center text-[10px] font-bold text-maroon-700 shrink-0">
                  {initials(m.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">
                    {titleCase(m.name)}
                    {m.role === 'Admin' && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-maroon-100 text-maroon-700 font-medium align-middle">Admin</span>
                    )}
                  </p>
                  <p className="text-[11px] text-gray-400">{m.wins_count}/{m.share_count} wins</p>
                </div>
                {m.user_id === value && (
                  <svg className="w-4 h-4 text-maroon-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
