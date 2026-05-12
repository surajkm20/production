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
  purpose: 'signup' | 'login' | 'password_reset'
  otp_expires_at: string
}

interface VerifyResponse {
  user_id: string
  access_token: string
  refresh_token: string
  expires_in: number
}

interface ResendResponse {
  otp_sent: boolean
  otp_expires_at: string
  next_resend_at: string
}

export default function OtpPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as LocationState | null

  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendError, setResendError] = useState<string | null>(null)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (!state?.mobile_number) {
      navigate('/signup', { replace: true })
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
    if (otp.length < 6) return

    setError(null)
    setLoading(true)

    try {
      const data = await api.post<VerifyResponse>('/auth/verify-otp', {
        mobile_number: state!.mobile_number,
        otp,
        purpose: state!.purpose,
      })
      localStorage.setItem('access_token', data.access_token)
      localStorage.setItem('refresh_token', data.refresh_token)
      navigate('/login', { state: { verified: true } })
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
        purpose: state!.purpose,
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

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-maroon-600 mb-4">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Verify your number</h1>
          <p className="text-sm text-gray-500 mt-1">
            We sent a 6-digit OTP to{' '}
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

          <form onSubmit={handleSubmit}>
            <div className="flex gap-2 justify-center mb-6" onPaste={handlePaste}>
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

            <button
              type="submit"
              disabled={loading || otp.length < 6}
              className="w-full bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-lg transition focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:ring-offset-2"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Verifying...
                </span>
              ) : 'Verify OTP'}
            </button>
          </form>

          <div className="mt-5 text-center">
            {resendError && (
              <p className="text-xs text-red-600 mb-2">{resendError}</p>
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

        <p className="text-center text-sm text-gray-500 mt-6">
          Wrong number?{' '}
          <button
            type="button"
            onClick={() => navigate('/signup')}
            className="text-maroon-600 font-medium hover:text-maroon-500"
          >
            Go back
          </button>
        </p>
      </div>
    </div>
  )
}
