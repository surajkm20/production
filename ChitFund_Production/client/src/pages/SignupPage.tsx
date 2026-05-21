import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import HornPayLogo from '../components/HornPayLogo'

// Maps backend error codes to user-friendly messages
const ERROR_MESSAGES: Record<string, string> = {
  MOBILE_TAKEN: 'This mobile number is already registered.',
  USERNAME_TAKEN: 'This username is already taken.',
  WEAK_PASSWORD: 'Password must be at least 8 characters.',
  INVALID_MOBILE: 'Enter a valid Indian mobile number.',
}

// Shape of the backend's response on successful signup.
// Backend triggers OTP send and returns when it expires.
interface SignupResponse {
  user_id: string
  otp_sent: boolean
  otp_expires_at: string
}

export default function SignupPage() {
  const navigate = useNavigate()

  // Single object for all form fields — cleaner than 4 separate useState calls.
  // set() helper updates one key at a time: set('name', 'Suraj') → { ...form, name: 'Suraj' }
  const [form, setForm] = useState({ name: '', mobile_number: '', password: '', username: '' })
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  function set(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    // Normalise mobile: strip spaces, then auto-prepend +91 for bare Indian numbers.
    // Accepts: 9876543210 | 919876543210 | +919876543210 | +91 98765 43210
    let rawMobile = form.mobile_number.replace(/\s+/g, '')
    if (!rawMobile.startsWith('+')) {
      if (/^91[6-9]\d{9}$/.test(rawMobile)) {
        rawMobile = '+' + rawMobile                          // 91XXXXXXXXXX → +91XXXXXXXXXX
      } else if (/^[6-9]\d{9}$/.test(rawMobile)) {
        rawMobile = '+91' + rawMobile                        // XXXXXXXXXX → +91XXXXXXXXXX
      }
      // anything else passed as-is and rejected by backend
    }
    const payload: Record<string, string> = {
      name: form.name,
      mobile_number: rawMobile,
      password: form.password,
    }
    // Username is optional — only include if the user filled it in
    if (form.username.trim()) payload.username = form.username.trim()

    try {
      // API call: POST /v1/auth/signup  Body: { name, mobile_number, password, username? }
      // On success, backend creates the user and sends an OTP SMS
      const data = await api.post<SignupResponse>('/auth/signup', payload)

      // OTP_BYPASS: when otp_sent is false (MSG91 not configured), account is already
      // verified — skip OTP and go straight to login.
      // TODO: remove this branch and always navigate('/otp', ...) when MSG91/DLT is live.
      if (!data.otp_sent) {
        navigate('/login', { state: { accountCreated: true } })
        return
      }

      // Navigate to OTP page, passing context via router state (not URL params).
      // OtpPage reads this state to know which number to verify and when the OTP expires.
      navigate('/otp', {
        state: {
          mobile_number: form.mobile_number,
          purpose: 'signup',
          otp_expires_at: data.otp_expires_at,
        },
      })
    } catch (err) {
      if (err instanceof ApiError) {
        setError(ERROR_MESSAGES[err.code] ?? err.message)
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <div className="mb-4">
            <HornPayLogo size={52} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">HornPay</h1>
          <p className="text-sm text-gray-500 mt-1">Create your account</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8">

          {/* Error banner */}
          {error && (
            <div className="mb-5 flex gap-2 items-start bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3 border border-red-200">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Full name</label>
              <input
                type="text"
                value={form.name}
                onChange={e => set('name', e.target.value)}
                placeholder="Suraj K"
                required
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Mobile number
              </label>
              <input
                type="tel"
                value={form.mobile_number}
                onChange={e => set('mobile_number', e.target.value)}
                placeholder="9876543210"
                required
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Username <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={form.username}
                onChange={e => set('username', e.target.value)}
                placeholder="suraj_k"
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
              <div className="relative">
                {/* type toggles between "password" (masked dots) and "text" (visible) */}
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  placeholder="Min 8 characters"
                  required
                  autoComplete="new-password"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-lg transition focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:ring-offset-2 mt-1"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Creating account...
                </span>
              ) : 'Create account'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Already have an account?{' '}
          <Link to="/login" className="text-maroon-600 font-medium hover:text-maroon-500">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
