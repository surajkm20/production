import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'

const ERROR_MESSAGES: Record<string, string> = {
  OTP_INVALID: 'Incorrect OTP. Please try again.',
  OTP_EXPIRED: 'OTP has expired. Please request a new one.',
  OTP_MAX_ATTEMPTS: 'Too many incorrect attempts. Please request a new OTP.',
  OTP_RATE_LIMITED: 'Please wait before requesting another OTP.',
}

interface LocationState {
  mobile_number: string
  otp_expires_at: string
}

interface ResendResponse {
  otp_sent: boolean
  otp_expires_at: string
  next_resend_at: string
}

export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as LocationState | null

  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendError, setResendError] = useState<string | null>(null)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (!state?.mobile_number) {
      navigate('/forgot-password', { replace: true })
      return
    }
    inputRefs.current[0]?.focus()
  }, [])

  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown(s => s - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  function handleDigitChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return
    const char = value.slice(-1)
    const next = [...digits]
    next[index] = char
    setDigits(next)
    if (char && index < 5) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (!pasted) return
    const next = [...digits]
    pasted.split('').forEach((ch, i) => { next[i] = ch })
    setDigits(next)
    inputRefs.current[Math.min(pasted.length, 5)]?.focus()
  }

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    const otp = digits.join('')

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setError(null)
    setLoading(true)

    try {
      await api.post('/auth/reset-password', {
        mobile_number: state!.mobile_number,
        otp,
        new_password: newPassword,
      })
      navigate('/login', { state: { passwordReset: true } })
    } catch (err) {
      if (err instanceof ApiError) {
        setError(ERROR_MESSAGES[err.code] ?? err.message)
      } else {
        setError('Something went wrong. Please try again.')
      }
      setDigits(['', '', '', '', '', ''])
      inputRefs.current[0]?.focus()
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setResendError(null)
    try {
      const data = await api.post<ResendResponse>('/auth/resend-otp', {
        mobile_number: state!.mobile_number,
        purpose: 'password_reset',
      })
      const next = new Date(data.next_resend_at)
      const secs = Math.max(0, Math.ceil((next.getTime() - Date.now()) / 1000))
      setResendCooldown(secs || 30)
    } catch (err) {
      if (err instanceof ApiError) {
        setResendError(ERROR_MESSAGES[err.code] ?? err.message)
        setResendCooldown(30)
      }
    }
  }

  const otp = digits.join('')
  const canSubmit = otp.length === 6 && newPassword.length >= 8 && confirmPassword.length > 0

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-maroon-600 mb-4">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Reset password</h1>
          <p className="text-sm text-gray-500 mt-1">
            Enter the OTP sent to{' '}
            <span className="font-medium text-gray-700">{state?.mobile_number}</span>
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8">

          {error && (
            <div className="mb-5 flex gap-2 items-start bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3 border border-red-200">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">OTP</label>
              <div className="flex gap-2 justify-center" onPaste={handlePaste}>
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={el => { inputRefs.current[i] = el }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={d}
                    onChange={e => handleDigitChange(i, e.target.value)}
                    onKeyDown={e => handleKeyDown(i, e)}
                    className="w-11 h-12 text-center text-lg font-semibold text-gray-900 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
                  />
                ))}
              </div>

              <div className="mt-3 text-center">
                {resendError && (
                  <p className="text-xs text-red-600 mb-1">{resendError}</p>
                )}
                {resendCooldown > 0 ? (
                  <p className="text-sm text-gray-400">
                    Resend OTP in <span className="font-medium text-gray-600">{resendCooldown}s</span>
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={handleResend}
                    className="text-sm text-maroon-600 hover:text-maroon-500 font-medium"
                  >
                    Resend OTP
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">New password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
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

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm new password</label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Repeat your new password"
                required
                autoComplete="new-password"
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
              {confirmPassword && newPassword !== confirmPassword && (
                <p className="mt-1.5 text-xs text-red-600">Passwords do not match.</p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading || !canSubmit}
              className="w-full bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-lg transition focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:ring-offset-2"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Resetting...
                </span>
              ) : 'Reset password'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Wrong number?{' '}
          <button
            type="button"
            onClick={() => navigate('/forgot-password')}
            className="text-maroon-600 font-medium hover:text-maroon-500"
          >
            Go back
          </button>
        </p>
      </div>
    </div>
  )
}
