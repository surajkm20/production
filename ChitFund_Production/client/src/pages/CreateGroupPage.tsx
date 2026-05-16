import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { formatPaise } from '../lib/format'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Pure helper: given startMonth "2026-06" and 12 shares, returns "May 2027"
function getEndMonthLabel(startValue: string, totalShares: number): string {
  if (!startValue || totalShares < 1) return ''
  const [y, m] = startValue.split('-').map(Number)
  const end = new Date(y, m - 1 + totalShares - 1)
  return `${MONTHS[end.getMonth()]} ${end.getFullYear()}`
}

// Pure helper: "2026-06" → "Jun 2026"
function getStartMonthLabel(startValue: string): string {
  if (!startValue) return ''
  const [y, m] = startValue.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

// Returns "YYYY-MM" for the current month — used as the `min` on the month input
function minStartMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// Shape of the backend's response on successful group creation
interface CreateGroupResponse {
  group_id: string
  name: string
  invitation_code: string
  pool_amount: number
  monthly_contribution: number
  total_shares: number
  total_months: number
  payment_due_day: number
  admin_commission_rate: string
}

export default function CreateGroupPage() {
  const navigate = useNavigate()

  // contributionRupees is a string because it's what the text input holds ("10000", "10,000", etc.)
  // The actual paise value is derived below: contribution = Math.round(parseFloat(contributionRupees) * 100)
  const [name, setName] = useState('')
  const [contributionRupees, setContributionRupees] = useState('')
  const [totalShares, setTotalShares] = useState(10)
  const [startMonth, setStartMonth] = useState('')
  const [paymentDueDay, setPaymentDueDay] = useState(10)
  const [commissionRate, setCommissionRate] = useState('5')
  const [interestRate, setInterestRate] = useState('2')
  const [adminShareCount, setAdminShareCount] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // If admin reduces totalShares below their own share count, cap adminShareCount automatically
  useEffect(() => {
    setAdminShareCount(s => Math.min(s, totalShares))
  }, [totalShares])

  // Rupees → paise conversion: "10000" → 1000000 paise. || 0 guards against NaN when input is empty.
  // These are derived values — no useState needed, they recalculate on every render from the inputs above.
  const contribution = Math.round(parseFloat(contributionRupees) * 100) || 0
  const poolAmount   = contribution * totalShares    // total monthly pool in paise
  const startLabel   = getStartMonthLabel(startMonth)
  const endLabel     = getEndMonthLabel(startMonth, totalShares)

  // Stepper helper: increment/decrement totalShares, minimum 2 (a chit needs at least 2 people)
  function adjustShares(delta: number) {
    setTotalShares(s => Math.max(2, s + delta))
  }

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    if (contribution <= 0) { setError('Enter a valid contribution amount.'); return }
    if (paymentDueDay < 1 || paymentDueDay > 28) { setError('Payment due day must be between 1 and 28.'); return }
    setError(null)
    setLoading(true)

    try {
      const parsedCommission = parseFloat(commissionRate)
      const parsedInterest   = parseFloat(interestRate)
      // API call: POST /v1/groups  Body: group configuration
      const data = await api.post<CreateGroupResponse>('/groups', {
        name: name.trim(),
        monthly_contribution: contribution,         // in paise
        total_shares: totalShares,
        start_month: startMonth + '-01',            // browser month picker gives "YYYY-MM"; backend wants "YYYY-MM-DD"
        payment_due_day: paymentDueDay,
        admin_share_count: adminShareCount,
        // Spread operator with conditional: only include optional fields if the user entered a valid number
        ...(!isNaN(parsedCommission) ? { admin_commission_rate: parsedCommission } : {}),
        ...(!isNaN(parsedInterest)   ? { monthly_interest_rate: parsedInterest }   : {}),
      })
      // On success, navigate to the new group's admin dashboard
      navigate(`/groups/${data.group_id}`)
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">

      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate('/dashboard')} className="p-1 text-gray-500 hover:text-gray-700 transition">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <h1 className="text-base font-semibold text-gray-900">Create new group</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto pb-28">

        {error && (
          <div className="mx-4 mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
            {error}
          </div>
        )}

        <div className="space-y-5 p-4">

          {/* Group name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Group name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Sunrise Chits 2026"
              required
              maxLength={100}
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
            />
          </div>

          {/* Contribution — user types rupees, we store/send paise */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Contribution per share, per month
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-500 font-medium">₹</span>
              <input
                type="number"
                value={contributionRupees}
                onChange={e => setContributionRupees(e.target.value)}
                placeholder="10,000"
                required
                min="1"
                className="w-full pl-8 pr-4 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
            </div>
            {contribution > 0 && totalShares > 1 && (
              <p className="text-xs text-gray-400 mt-1.5">
                A person with 2 shares pays {formatPaise(contribution * 2)} every month.
              </p>
            )}
          </div>

          {/* Total shares stepper */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Total shares in the chit</label>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => adjustShares(-1)}
                disabled={totalShares <= 2}
                className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition text-lg font-medium"
              >
                −
              </button>
              <span className="text-2xl font-bold text-gray-900 w-8 text-center">{totalShares}</span>
              <button
                type="button"
                onClick={() => adjustShares(1)}
                className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 transition text-lg font-medium"
              >
                +
              </button>
              <p className="text-xs text-gray-400 flex-1">
                {totalShares} shares = {totalShares} monthly cycles
              </p>
            </div>
          </div>

          {/* Admin's own share count in the chit */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Your shares in this chit</label>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setAdminShareCount(s => Math.max(1, s - 1))}
                disabled={adminShareCount <= 1}
                className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition text-lg font-medium"
              >
                −
              </button>
              <span className="text-2xl font-bold text-gray-900 w-8 text-center">{adminShareCount}</span>
              <button
                type="button"
                onClick={() => setAdminShareCount(s => Math.min(totalShares, s + 1))}
                disabled={adminShareCount >= totalShares}
                className="w-10 h-10 rounded-lg border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition text-lg font-medium"
              >
                +
              </button>
              {contribution > 0 && (
                <p className="text-xs text-gray-400 flex-1">
                  You'll pay {adminShareCount === 1 ? formatPaise(contribution) : formatPaise(contribution * adminShareCount)} per month
                </p>
              )}
            </div>
          </div>

          {/* Start month — type="month" gives a "YYYY-MM" string, not a full date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Start month</label>
            <input
              type="month"
              value={startMonth}
              onChange={e => setStartMonth(e.target.value)}
              min={minStartMonth()}
              required
              className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
            />
            {startLabel && endLabel && (
              <p className="text-xs text-gray-400 mt-1.5">
                Chit will run {startLabel} — {endLabel}
              </p>
            )}
          </div>

          {/* Payment due day — capped at 28 to avoid month-end ambiguity (Feb has only 28 days) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Payment due day
            </label>
            <div className="flex items-center gap-3">
              <div className="relative w-28">
                <input
                  type="number"
                  value={paymentDueDay}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v)) setPaymentDueDay(Math.min(28, Math.max(1, v)))
                  }}
                  min={1}
                  max={28}
                  required
                  className="w-full px-3.5 pr-10 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">th</span>
              </div>
              <p className="text-xs text-gray-400 flex-1">of every month</p>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              Everyone pays on this date each cycle — contributions and loan interest. Days 29–31 not allowed.
            </p>
          </div>

          {/* Admin commission rate — optional field, blank = no commission */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Admin commission rate <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <div className="relative w-40">
              <input
                type="number"
                value={commissionRate}
                onChange={e => setCommissionRate(e.target.value)}
                placeholder="5"
                min="0"
                max="100"
                step="0.25"
                className="w-full px-3.5 pr-8 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              Your cut from each winning bid. e.g. 5% on a ₹16,000 bid = ₹800 to you. Visible to all members. Locked once cycle 1 starts.
            </p>
          </div>

          {/* Monthly loan interest rate */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Monthly loan interest rate <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <div className="relative w-40">
              <input
                type="number"
                value={interestRate}
                onChange={e => setInterestRate(e.target.value)}
                placeholder="2"
                min="0"
                max="99.99"
                step="0.25"
                className="w-full px-3.5 pr-8 py-2.5 rounded-lg border border-gray-300 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              Applied to loans disbursed from the basket.
            </p>
          </div>

          {/* Live preview panel — no API call, purely derived from form state above.
              Re-renders automatically whenever any input changes because React re-renders the whole component. */}
          {(contribution > 0 || totalShares > 0) && (
            <div className="bg-maroon-600 rounded-2xl p-4 text-white">
              <p className="text-xs font-semibold text-maroon-200 mb-3 tracking-widest">SUMMARY</p>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-maroon-200">Pool per month</span>
                  <span className="font-bold">{formatPaise(poolAmount)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-maroon-200">Total cycles</span>
                  <span className="font-bold">{totalShares} months</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-maroon-200">Your share ({adminShareCount} {adminShareCount === 1 ? 'share' : 'shares'})</span>
                  <span className="font-bold">{contribution > 0 ? formatPaise(contribution * adminShareCount) : '—'}/mo</span>
                </div>
                {startLabel && endLabel && (
                  <div className="flex justify-between text-sm">
                    <span className="text-maroon-200">Duration</span>
                    <span className="font-bold">{startLabel} → {endLabel}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-maroon-200">Due day</span>
                  <span className="font-bold">{paymentDueDay}th of each month</span>
                </div>
                {parseFloat(commissionRate) > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-maroon-200">Admin commission</span>
                    <span className="font-bold">{commissionRate}% of each winning bid</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Warning */}
          <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <p className="text-xs text-amber-700 leading-relaxed">
              After cycle 1 starts, contribution, total shares, and admin commission rate are locked. You can rename the group anytime.
            </p>
          </div>

        </div>
      </form>

      {/* Action bar — fixed at bottom, outside the scrollable form */}
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t border-gray-100 px-4 py-3 flex gap-3">
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="flex-1 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition"
        >
          Cancel
        </button>
        <button
          type="submit"
          form="create-group-form"
          disabled={loading}
          onClick={handleSubmit}
          className="flex-1 py-3 rounded-xl bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 text-sm font-semibold text-white transition"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Creating...
            </span>
          ) : 'Create group'}
        </button>
      </div>
    </div>
  )
}
