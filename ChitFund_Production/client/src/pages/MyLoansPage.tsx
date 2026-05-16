import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'
import type { Loan } from '../types/api'
import GroupNavBar from '../components/GroupNavBar'

export default function MyLoansPage() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()

  const [groupName, setGroupName] = useState<string>('')
  const [role, setRole]           = useState<'Admin' | 'Member'>('Member')
  const [loans, setLoans]         = useState<Loan[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)

  useEffect(() => { load() }, [groupId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [g, rows] = await Promise.all([
        api.get<{ name: string; my_membership: { role: 'Admin' | 'Member' } }>(`/groups/${groupId}`),
        api.get<Loan[]>(`/groups/${groupId}/loans`),
      ])
      setGroupName(g.name)
      setRole(g.my_membership.role)
      setLoans(rows)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/login', { replace: true })
      else setError('Could not load loans.')
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

  const activeLoans = loans.filter(l => l.status === 'Active')
  const pastLoans   = loans.filter(l => l.status !== 'Active')

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
          <h1 className="text-base font-semibold text-gray-900">My Loans</h1>
          <p className="text-xs text-gray-400 truncate">{groupName}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 pt-4 space-y-4">

        {loans.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-8">
            <p className="text-sm text-gray-500 text-center">No loans in this group yet.</p>
          </div>
        )}

        {/* Active loans */}
        {activeLoans.length > 0 && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">ACTIVE</p>
            <div className="space-y-3">
              {activeLoans.map(loan => (
                <div key={loan.loan_id} className="bg-white rounded-2xl border border-red-100 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-base font-bold text-gray-900">{formatPaise(loan.principal)}</p>
                    <span className="text-[11px] font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full">Active</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-gray-50 rounded-lg p-2">
                      <p className="text-gray-400 mb-0.5">Outstanding interest</p>
                      <p className="font-semibold text-red-600">{formatPaise(loan.outstanding_interest)}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-2">
                      <p className="text-gray-400 mb-0.5">Interest paid</p>
                      <p className="font-semibold text-gray-800">{formatPaise(loan.total_interest_paid)}</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-2">
                      <p className="text-gray-400 mb-0.5">Rate</p>
                      <p className="font-semibold text-gray-800">{loan.monthly_interest_rate}% / month</p>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-2">
                      <p className="text-gray-400 mb-0.5">Next due</p>
                      <p className="font-semibold text-gray-800">
                        {loan.next_cycle_due_date
                          ? new Date(loan.next_cycle_due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                          : '—'}
                      </p>
                    </div>
                  </div>
                  {loan.expected_close_date && (
                    <p className="text-[11px] text-gray-400">
                      Expected closure — {new Date(loan.expected_close_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Past loans */}
        {pastLoans.length > 0 && (
          <div className="mx-3">
            <p className="text-xs font-semibold text-gray-400 tracking-widest mb-2 px-1">PAST LOANS</p>
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="divide-y divide-gray-50">
                {pastLoans.map(loan => (
                  <div key={loan.loan_id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{formatPaise(loan.principal)}</p>
                      <p className="text-xs text-gray-400">
                        Interest paid {formatPaise(loan.total_interest_paid)}
                      </p>
                    </div>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                      loan.status === 'Repaid'
                        ? 'text-green-600 bg-green-50'
                        : 'text-gray-500 bg-gray-100'
                    }`}>
                      {loan.status === 'WrittenOff' ? 'Written off' : loan.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>

      <GroupNavBar groupId={groupId!} role={role} />
    </div>
  )
}
